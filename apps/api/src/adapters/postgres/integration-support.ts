import {
  createDatabase,
  type DatabaseHandle,
  type Transaction,
  users,
  withTenant,
  workspaces,
} from '@tula/db'
import { createTestTenant, type TestTenant } from '@tula/db/testing'
import { inArray, sql } from 'drizzle-orm'

/** A tenant of an integration run: its ids and a way to add a user to it. */
export interface IntegrationTenant {
  projectId: string
  environmentId: string
  /** Insert a user with no password and an unverified address. */
  user: () => Promise<string>
}

/**
 * A transaction of the owner's login, on a connection of neither pool, that holds locks while
 * a test starts the calls that must wait on them.
 */
export interface Hold {
  /** The transaction: take the lock the calls contend on through it. */
  tx: Transaction
  /**
   * Wait until exactly `count` sessions are waiting on a lock this transaction holds, directly
   * or queued behind one that is.
   *
   * @param count - How many sessions must be waiting.
   * @throws Error when that is not so within {@link WAIT_FOR_WAITERS_MS}, saying how many were.
   */
  waiting: (count: number) => Promise<void>
}

/** How long {@link Hold.waiting} looks for the waiters before it gives up. */
export const WAIT_FOR_WAITERS_MS = 5_000

/** Rolls a {@link Hold}'s transaction back: it only ever held locks. */
class Release extends Error {}

/**
 * Run every step, one after another, whether or not an earlier one failed.
 *
 * For cleanup: a pool that will not close must not leave the other pool open or the run's
 * tenants in the database.
 *
 * @param steps - The steps, in order.
 * @throws The first failure, after every step has run.
 */
export async function runEvery(steps: readonly (() => Promise<unknown>)[]): Promise<void> {
  const failures: unknown[] = []
  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    throw failures[0]
  }
}

/** Real Postgres for the `*.integration.ts` files of the stores. */
export interface IntegrationDatabase {
  /** The first API instance's pool, as the runtime login. */
  first: DatabaseHandle
  /** A second instance's pool: its connections are never the first one's. */
  second: DatabaseHandle
  /**
   * Create a workspace, project and environment, remembered for {@link close}.
   *
   * @param kind - The environment's kind (default `development`).
   * @returns The tenant.
   */
  tenant: (kind?: 'development' | 'production') => Promise<IntegrationTenant>
  /**
   * Run `fn` inside a transaction of the owner's login that is rolled back when `fn` settles,
   * which releases every lock it took.
   *
   * It is how a test makes two calls overlap for certain: take the lock both need, start
   * them, see both waiting ({@link Hold.waiting}), return.
   *
   * @param fn - Takes the locks and starts the calls.
   * @returns What `fn` returned.
   */
  holding: <T>(fn: (hold: Hold) => Promise<T>) => Promise<T>
  /**
   * Delete every tenant created here and close the pools. Every step runs even when an
   * earlier one failed; the first failure is rethrown.
   */
  close: () => Promise<void>
}

/**
 * Open two pools on the Postgres of `docker compose up -d`, standing in for two API instances.
 *
 * Both connect as the runtime login (`DATABASE_URL`), so row-level security applies as it does
 * in the API. What a run creates is removed through the owner's login
 * (`DATABASE_MIGRATION_URL`): the runtime role has no `DELETE` on the control plane. The same
 * login holds the locks of {@link IntegrationDatabase.holding}: it is not subject to row-level
 * security and is a third session, of neither pool.
 *
 * @param poolSize - Connections per pool. More than one, so that calls a test starts together
 *   really run on separate sessions.
 * @returns The pools, a tenant factory, the lock holder and the cleanup.
 * @throws Error when either URL is missing: a silently skipped suite would look green.
 */
export function openIntegrationDatabase(poolSize = 4): IntegrationDatabase {
  const runtimeUrl = process.env.DATABASE_URL
  const migrationUrl = process.env.DATABASE_MIGRATION_URL
  if (!runtimeUrl || !migrationUrl) {
    throw new Error(
      'Integration tests need DATABASE_URL and DATABASE_MIGRATION_URL (see .env.example)'
    )
  }
  const first = createDatabase(runtimeUrl, { max: poolSize })
  const second = createDatabase(runtimeUrl, { max: poolSize })
  const created: TestTenant[] = []

  async function tenant(
    kind: 'development' | 'production' = 'development'
  ): Promise<IntegrationTenant> {
    const made = await createTestTenant(first.db, kind)
    created.push(made)
    const scope = { projectId: made.projectId, environmentId: made.environmentId }
    return {
      ...scope,
      user: () =>
        withTenant(first.db, made.environmentId, async (tx) => {
          const id = Bun.randomUUIDv7()
          await tx.insert(users).values({
            id,
            ...scope,
            email: `${id}@northline.app`,
            emailNormalized: `${id}@northline.app`,
          })
          return id
        }),
    }
  }

  // The owner's pool: one connection for a hold, one for the cleanup.
  const owner = createDatabase(migrationUrl, { max: 2 })

  async function holding<T>(fn: (hold: Hold) => Promise<T>): Promise<T> {
    let result: { value: T } | undefined
    try {
      await owner.db.transaction(async (tx) => {
        const waiting = async (count: number): Promise<void> => {
          const deadline = Date.now() + WAIT_FOR_WAITERS_MS
          let seen = -1
          for (;;) {
            // `pg_locks`, not `pg_stat_activity`: the latter is read once per transaction and
            // would show this one the same answer every time. A session is counted when this
            // transaction blocks it, or blocks the one that blocks it (a row's second waiter
            // queues behind the first, not behind the holder).
            // `Database` is driver-neutral, so `execute` is untyped; node-postgres answers rows.
            const { rows } = (await tx.execute(sql`
              with recursive blocked(pid) as (
                select l.pid from pg_locks l
                  where not l.granted and pg_backend_pid() = any(pg_blocking_pids(l.pid))
                union
                select l.pid from pg_locks l join blocked b
                  on not l.granted and b.pid = any(pg_blocking_pids(l.pid))
              )
              select count(distinct pid)::int as waiting from blocked
            `)) as { rows: { waiting: number }[] }
            seen = rows[0]?.waiting ?? 0
            if (seen === count) {
              return
            }
            if (Date.now() >= deadline) {
              throw new Error(
                `expected ${count} session(s) waiting on the held lock, saw ${seen} after ${WAIT_FOR_WAITERS_MS} ms`
              )
            }
            await Bun.sleep(2)
          }
        }
        result = { value: await fn({ tx, waiting }) }
        throw new Release()
      })
    } catch (error) {
      if (!(error instanceof Release)) {
        throw error
      }
    }
    return (result as { value: T }).value
  }

  function close(): Promise<void> {
    return runEvery([
      // First, while nothing has been closed: a pool that fails to close must not leave the
      // run's tenants behind. Deleting a workspace cascades to everything created under it.
      async () => {
        if (created.length > 0) {
          await owner.db.delete(workspaces).where(
            inArray(
              workspaces.id,
              created.map((made) => made.workspaceId)
            )
          )
        }
      },
      () => first.close(),
      () => second.close(),
      () => owner.close(),
    ])
  }

  return { first, second, tenant, holding, close }
}
