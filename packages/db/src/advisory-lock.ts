/**
 * A Postgres advisory lock key: two 32-bit integers, `(namespace, job)`.
 *
 * Advisory locks share one number space per database, so Tula's keys all use
 * {@link ADVISORY_LOCK_NAMESPACE} as the first integer.
 */
export type AdvisoryLockKey = readonly [namespace: number, id: number]

/** First integer of every Tula advisory lock: the bytes of `tula` as an int4. */
export const ADVISORY_LOCK_NAMESPACE = 0x74756c61

/**
 * First integer of the lock a day's count of text messages is taken under
 * (`pg_advisory_xact_lock` in the API's SMS usage store; ADR 0037): the bytes of `smsd` as
 * an int4. The second integer is `hashtext` of the environment's id.
 *
 * Session-level and transaction-level advisory locks are one number space, so a key here
 * must not be one {@link withAdvisoryLock} is ever given. Those all begin with
 * {@link ADVISORY_LOCK_NAMESPACE}; this one never does, whatever the second integer is. Two
 * environments whose ids hash alike take turns with each other, which costs a wait and
 * changes no count.
 */
export const SMS_DAY_LOCK_NAMESPACE = 0x736d7364

/** What {@link withAdvisoryLock} reports: the function's result, or that the lock was taken. */
export type AdvisoryLockResult<T> = { acquired: true; value: T } | { acquired: false }

/** The one method of a `pg` client the lock needs. */
interface LockClient {
  query(text: string, values: number[]): Promise<{ rows: Record<string, unknown>[] }>
  /** Return the connection to the pool; `true` (or an error) destroys it instead. */
  release(destroy?: boolean): void
}

/** The one method of a `pg` pool the lock needs. */
export interface LockPool {
  connect(): Promise<LockClient>
}

/**
 * Run `fn` only if nobody else holds the lock, across every process connected to the database.
 *
 * The lock is session-level (`pg_try_advisory_lock`), held on a connection checked out for the
 * purpose and released when `fn` settles. Session-level rather than transaction-level so that
 * `fn` is not wrapped in one long transaction; it runs its own short ones on other connections.
 * If the process dies, Postgres releases the lock when the connection drops, so a crashed holder
 * can never block the next one. It never waits: a taken lock is reported at once.
 *
 * @param pool - The pool to take a dedicated connection from.
 * @param key - The lock to take.
 * @param fn - Work to do while holding it.
 * @returns `fn`'s result, or `{ acquired: false }` when another session holds the lock.
 * @throws Whatever `fn` throws, after the lock is released.
 *
 * @example
 * ```ts
 * const result = await withAdvisoryLock(pool, [ADVISORY_LOCK_NAMESPACE, 1], () => purge())
 * if (!result.acquired) return // another instance is doing it
 * ```
 */
export async function withAdvisoryLock<T>(
  pool: LockPool,
  key: AdvisoryLockKey,
  fn: () => Promise<T>
): Promise<AdvisoryLockResult<T>> {
  const client = await pool.connect()
  // A connection that may still hold the lock must not go back into the pool: the next request
  // to check it out would hold the lock without knowing. Destroying it releases the lock.
  let destroy = true
  try {
    const taken = await client.query('select pg_try_advisory_lock($1, $2) as acquired', [...key])
    if (taken.rows[0]?.acquired !== true) {
      destroy = false
      return { acquired: false }
    }
    try {
      return { acquired: true, value: await fn() }
    } finally {
      const released = await client.query('select pg_advisory_unlock($1, $2) as released', [...key])
      destroy = released.rows[0]?.released !== true
    }
  } finally {
    client.release(destroy)
  }
}
