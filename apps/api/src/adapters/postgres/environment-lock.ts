import { ADVISORY_LOCK_NAMESPACE, type AdvisoryLockKey, type DatabaseHandle } from '@tula/db'
import { ServiceUnavailableError } from '~/exceptions'
import type { EnvironmentLock, EnvironmentLockScope } from '~/ports/environment-lock'

/**
 * Advisory-lock ids below this are reserved for fixed ids (`JOB_LOCK_IDS`); an environment
 * lock's id is always at or above it, so the two can never be the same key.
 */
export const ENVIRONMENT_LOCK_FIRST_ID = 0x10000

/** How the adapter waits for a taken lock. */
export interface EnvironmentLockOptions {
  /** How long to keep trying before giving up, in milliseconds (default 5000). */
  waitMs?: number
  /** The pause between two tries, in milliseconds (default 25). */
  retryMs?: number
  /** Pause for that long (default: a timer). Tests pass their own. */
  sleep?: (ms: number) => Promise<void>
}

/**
 * The advisory-lock key of an environment and scope: Tula's namespace, and a 31-bit FNV-1a hash
 * of both, moved past the reserved ids.
 *
 * Two environments may share a key (one in two billion): they would then take turns with each
 * other too, which costs a moment and breaks nothing. The mapping is fixed forever: instances
 * of different versions must agree on it during a rolling upgrade.
 *
 * @param environmentId - The environment.
 * @param scope - Which invariant.
 * @returns The key.
 */
export function environmentLockKey(
  environmentId: string,
  scope: EnvironmentLockScope
): AdvisoryLockKey {
  let hash = 0x811c9dc5
  for (const byte of new TextEncoder().encode(`${scope}:${environmentId}`)) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0
  }
  const span = 0x7fffffff - ENVIRONMENT_LOCK_FIRST_ID
  return [ADVISORY_LOCK_NAMESPACE, ENVIRONMENT_LOCK_FIRST_ID + (hash % span)]
}

/**
 * An environment lock on a Postgres session-level advisory lock, so it serialises every API
 * instance connected to the same database.
 *
 * It waits by **trying again**, not by blocking in `pg_advisory_lock`: a blocked waiter would
 * sit on a pool connection, and enough of them would leave the holder without a connection for
 * its own write (a deadlock inside one process). Between tries a waiter holds nothing. A holder
 * that crashes loses the lock with its connection.
 */
export class PostgresEnvironmentLock implements EnvironmentLock {
  readonly #withAdvisoryLock: DatabaseHandle['withAdvisoryLock']
  readonly #waitMs: number
  readonly #retryMs: number
  readonly #sleep: (ms: number) => Promise<void>

  /**
   * @param withAdvisoryLock - The database handle's lock function (its own pool connection).
   * @param options - The wait.
   */
  constructor(
    withAdvisoryLock: DatabaseHandle['withAdvisoryLock'],
    options: EnvironmentLockOptions = {}
  ) {
    this.#withAdvisoryLock = withAdvisoryLock
    this.#waitMs = options.waitMs ?? 5000
    this.#retryMs = options.retryMs ?? 25
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /** @inheritdoc */
  async runExclusive<T>(
    environmentId: string,
    scope: EnvironmentLockScope,
    fn: () => Promise<T>
  ): Promise<T> {
    const key = environmentLockKey(environmentId, scope)
    for (let waited = 0; ; waited += this.#retryMs) {
      const result = await this.#withAdvisoryLock(key, fn)
      if (result.acquired) {
        return result.value
      }
      if (waited >= this.#waitMs) {
        // Fail closed: the write is not made on an unchecked invariant.
        throw new ServiceUnavailableError({
          internalMessage: `environment lock ${scope} still taken after ${this.#waitMs} ms`,
        })
      }
      await this.#sleep(this.#retryMs)
    }
  }
}
