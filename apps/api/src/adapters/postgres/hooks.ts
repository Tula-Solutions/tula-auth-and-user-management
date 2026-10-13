import type { HookFailureReason, HookOutcome, HookPoint } from '@tula/contract'
import { type Database, hookCallCounts, hooks, withTenant } from '@tula/db'
import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import { recordActivity } from '~/adapters/postgres/activity'
import { isUniqueViolation } from '~/adapters/postgres/errors'
import { activityOf, type Recorded } from '~/ports/activity-log'
import {
  type HookCallCount,
  type HookChanges,
  type HookExpectation,
  type HookRecord,
  type HookStore,
  hourOf,
} from '~/ports/hook-store'

const columns = {
  id: hooks.id,
  projectId: hooks.projectId,
  environmentId: hooks.environmentId,
  point: hooks.point,
  url: hooks.url,
  secret: hooks.secret,
  enabled: hooks.enabled,
  deadlineMs: hooks.deadlineMs,
  failureMode: hooks.failureMode,
  lastFailedAt: hooks.lastFailedAt,
  lastFailureReason: hooks.lastFailureReason,
  createdAt: hooks.createdAt,
  updatedAt: hooks.updatedAt,
}

/** A row as the port's record: the reason is one of the server's own words, written by it. */
function toRecord(row: typeof hooks.$inferSelect): HookRecord {
  return { ...row, lastFailureReason: row.lastFailureReason as HookFailureReason | null }
}

/** The hook of one environment that is still as on and as strict as the caller read it. */
function stillExpected(environmentId: string, id: string, expected: HookExpectation) {
  return and(
    eq(hooks.environmentId, environmentId),
    eq(hooks.id, id),
    // The compare of the compare-and-set: in the statement itself, so it is judged against
    // the row as it is when the write takes its lock.
    eq(hooks.enabled, expected.enabled),
    eq(hooks.failureMode, expected.failureMode)
  )
}

/** Hooks in Postgres, behind row-level security. */
export class PostgresHookStore implements HookStore {
  /** @param db - Database connected as the runtime role. */
  constructor(private readonly db: Database) {}

  /** @inheritdoc */
  async list(environmentId: string): Promise<HookRecord[]> {
    const rows = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select(columns)
        .from(hooks)
        .where(eq(hooks.environmentId, environmentId))
        // The id breaks ties between hooks of the same instant, so the order is stable.
        .orderBy(asc(hooks.createdAt), asc(hooks.id))
    )
    return rows.map(toRecord)
  }

  /** @inheritdoc */
  async find(environmentId: string, id: string): Promise<HookRecord | null> {
    const [row] = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select(columns)
        .from(hooks)
        .where(and(eq(hooks.environmentId, environmentId), eq(hooks.id, id)))
        .limit(1)
    )
    return row ? toRecord(row) : null
  }

  /** @inheritdoc */
  async findByPoint(environmentId: string, point: HookPoint): Promise<HookRecord | null> {
    const [row] = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select(columns)
        .from(hooks)
        .where(and(eq(hooks.environmentId, environmentId), eq(hooks.point, point)))
        .limit(1)
    )
    return row ? toRecord(row) : null
  }

  /** @inheritdoc */
  async insert(record: HookRecord, recorded: Recorded): Promise<HookRecord | null> {
    const activity = activityOf(recorded)
    try {
      return await withTenant(this.db, record.environmentId, async (tx) => {
        const [row] = await tx.insert(hooks).values(record).returning(columns)
        await recordActivity(tx, activity ? [activity] : [])
        // An insert that did not throw returns its row.
        return toRecord(row as typeof hooks.$inferSelect)
      })
    } catch (error) {
      // The environment already has a hook for the point (or this very id): the unique key
      // decided, and the transaction, with its audit entry, is rolled back.
      if (isUniqueViolation(error)) {
        return null
      }
      throw error
    }
  }

  /** @inheritdoc */
  async update(
    environmentId: string,
    id: string,
    expected: HookExpectation,
    changes: HookChanges,
    updatedAt: Date,
    recorded: Recorded
  ): Promise<HookRecord | null> {
    const activity = activityOf(recorded)
    return withTenant(this.db, environmentId, async (tx) => {
      const [row] = await tx
        .update(hooks)
        .set({
          // A field left out is `undefined`, which Drizzle leaves out of the statement.
          url: changes.url,
          enabled: changes.enabled,
          deadlineMs: changes.deadlineMs,
          failureMode: changes.failureMode,
          updatedAt,
        })
        .where(stillExpected(environmentId, id, expected))
        .returning(columns)
      await recordActivity(tx, row && activity ? [activity] : [])
      return row ? toRecord(row) : null
    })
  }

  /** @inheritdoc */
  async delete(
    environmentId: string,
    id: string,
    expected: HookExpectation,
    recorded: Recorded
  ): Promise<boolean> {
    const activity = activityOf(recorded)
    return withTenant(this.db, environmentId, async (tx) => {
      const rows = await tx
        .delete(hooks)
        .where(stillExpected(environmentId, id, expected))
        .returning({ id: hooks.id })
      const deleted = rows.length === 1
      await recordActivity(tx, deleted && activity ? [activity] : [])
      return deleted
    })
  }

  /** @inheritdoc */
  async noteFailure(
    environmentId: string,
    id: string,
    at: Date,
    reason: HookFailureReason
  ): Promise<void> {
    await withTenant(this.db, environmentId, (tx) =>
      tx
        .update(hooks)
        // `updated_at` is set to itself: the column updates itself on every write otherwise,
        // and no administrator changed the hook.
        .set({ lastFailedAt: at, lastFailureReason: reason, updatedAt: sql`${hooks.updatedAt}` })
        .where(and(eq(hooks.environmentId, environmentId), eq(hooks.id, id)))
    )
  }

  /**
   * @inheritdoc
   *
   * One statement: the row is made from the hook's own row (so a hook that is gone, or
   * another environment's, counts nothing, and the tenant columns are the hook's), and a
   * count that exists is added to under its row lock. No read before the write, and no
   * lock but that row's.
   */
  async countCall(
    environmentId: string,
    id: string,
    at: Date,
    outcome: HookOutcome
  ): Promise<void> {
    const hour = hourOf(at).toISOString()
    const moment = at.toISOString()
    await withTenant(this.db, environmentId, (tx) =>
      tx.execute(sql`
        insert into ${hookCallCounts}
          ("id", "project_id", "environment_id", "hook_id", "hour", "outcome", "calls", "last_at", "created_at", "updated_at")
        select ${Bun.randomUUIDv7()}::uuid, ${hooks.projectId}, ${hooks.environmentId}, ${hooks.id},
          ${hour}::timestamptz, ${outcome}, 1, ${moment}::timestamptz, ${moment}::timestamptz, ${moment}::timestamptz
        from ${hooks}
        where ${hooks.environmentId} = ${environmentId}::uuid and ${hooks.id} = ${id}::uuid
        on conflict ("hook_id", "hour", "outcome") do update set
          "calls" = ${hookCallCounts.calls} + 1,
          "last_at" = greatest(${hookCallCounts.lastAt}, excluded."last_at"),
          "updated_at" = excluded."updated_at"
      `)
    )
  }

  /** @inheritdoc */
  async callCounts(environmentId: string, since: Date): Promise<HookCallCount[]> {
    const rows = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select({
          hookId: hookCallCounts.hookId,
          hour: hookCallCounts.hour,
          outcome: hookCallCounts.outcome,
          calls: hookCallCounts.calls,
          lastAt: hookCallCounts.lastAt,
        })
        .from(hookCallCounts)
        .where(
          and(eq(hookCallCounts.environmentId, environmentId), gte(hookCallCounts.hour, since))
        )
        .orderBy(asc(hookCallCounts.hookId), asc(hookCallCounts.hour), asc(hookCallCounts.outcome))
    )
    return rows
  }

  /** @inheritdoc */
  async deleteCallCountsBefore(
    environmentId: string,
    before: Date,
    limit: number
  ): Promise<number> {
    const old = and(
      eq(hookCallCounts.environmentId, environmentId),
      lt(hookCallCounts.hour, before)
    )
    const rows = await withTenant(this.db, environmentId, (tx) =>
      tx
        .delete(hookCallCounts)
        .where(
          and(
            old,
            // DELETE has no LIMIT in Postgres: pick the batch in a subquery.
            inArray(
              hookCallCounts.id,
              tx.select({ id: hookCallCounts.id }).from(hookCallCounts).where(old).limit(limit)
            )
          )
        )
        .returning({ id: hookCallCounts.id })
    )
    return rows.length
  }
}
