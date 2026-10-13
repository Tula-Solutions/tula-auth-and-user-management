import { type Database, SMS_DAY_LOCK_NAMESPACE, smsCodeCounts, withTenant } from '@tula/db'
import { and, asc, desc, eq, gt, gte, inArray, lt, sql } from 'drizzle-orm'
import {
  SMS_PREFIX_PATTERN,
  type SmsUsageScope,
  type SmsUsageStore,
  type SmsUsageSummary,
} from '~/ports/sms-usage-store'

/**
 * How long a take waits for the environment's turn before it gives up, in milliseconds. A
 * turn is three short statements, so a wait this long means the database is not answering:
 * the take fails and the message is not sent.
 */
export const SMS_DAY_LOCK_WAIT_MS = 5000

/**
 * Counts of texted codes in Postgres (`sms_code_counts`), behind row-level security.
 *
 * A take ({@link PostgresSmsUsageStore.takeFromDay}) is one transaction on one connection,
 * under a transaction-level advisory lock of the environment. Every other count is one
 * statement. The table's own check refuses a prefix longer than four digits, whatever is
 * passed here.
 */
export class PostgresSmsUsageStore implements SmsUsageStore {
  /** @param db - Database connected as the runtime role. */
  constructor(private readonly db: Database) {}

  /**
   * @inheritdoc
   *
   * One transaction on **one** connection: the environment's turn is a transaction-level
   * advisory lock (`pg_advisory_xact_lock`), taken and released by the connection that does
   * the counting, so a take holds nothing while it waits for a second connection and no
   * number of takes can exhaust the pool waiting on each other (unlike
   * `deps.environmentLock`, whose holder keeps one connection and works on another). The
   * lock goes with the commit or the rollback, and with the connection if the process dies.
   *
   * The key is `(SMS_DAY_LOCK_NAMESPACE, hashtext(environment id))`: its first integer is
   * never the one the session-level locks use, so it collides with none of them. The hash
   * is computed by the database, so every instance agrees on it by construction.
   *
   * Under the lock the statements are `READ COMMITTED`: the sum sees every take that
   * committed before this one's turn began. `recordNotSent` does not take the lock, and can
   * only lower the sum.
   */
  async takeFromDay(
    scope: SmsUsageScope,
    day: string,
    prefix: string,
    limit: number,
    at: Date
  ): Promise<boolean> {
    if (!SMS_PREFIX_PATTERN.test(prefix)) {
      // Before the day is looked at, so that a spent day does not hide it. The table's check
      // (`sms_code_counts_prefix_shape`) refuses it too.
      throw new Error('not a destination prefix')
    }
    return withTenant(this.db, scope.environmentId, async (tx) => {
      // SET LOCAL: this transaction's waits only. A turn that does not come fails the take.
      await tx.execute(
        sql`select set_config('lock_timeout', ${String(SMS_DAY_LOCK_WAIT_MS)}, true)`
      )
      await tx.execute(
        sql`select pg_advisory_xact_lock(${sql.raw(String(SMS_DAY_LOCK_NAMESPACE))}, hashtext(${scope.environmentId}::text))`
      )
      const [counted] = await tx
        .select({ sent: sql<number>`coalesce(sum(${smsCodeCounts.sent}), 0)::int` })
        .from(smsCodeCounts)
        .where(
          and(eq(smsCodeCounts.environmentId, scope.environmentId), eq(smsCodeCounts.day, day))
        )
      if ((counted?.sent ?? 0) >= limit) {
        return false
      }
      await tx
        .insert(smsCodeCounts)
        .values({
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          day,
          prefix,
          sent: 1,
          createdAt: at,
          updatedAt: at,
        })
        .onConflictDoUpdate({
          target: [smsCodeCounts.environmentId, smsCodeCounts.day, smsCodeCounts.prefix],
          set: { sent: sql`${smsCodeCounts.sent} + 1`, updatedAt: at },
        })
      return true
    })
  }

  /** @inheritdoc */
  async recordNotSent(environmentId: string, day: string, prefix: string, at: Date): Promise<void> {
    await withTenant(this.db, environmentId, (tx) =>
      tx
        .update(smsCodeCounts)
        .set({ sent: sql`${smsCodeCounts.sent} - 1`, updatedAt: at })
        .where(
          and(
            eq(smsCodeCounts.environmentId, environmentId),
            eq(smsCodeCounts.day, day),
            eq(smsCodeCounts.prefix, prefix),
            // In the statement itself: `sent` never goes below `used`.
            gt(smsCodeCounts.sent, smsCodeCounts.used)
          )
        )
    )
  }

  /** @inheritdoc */
  async sentOn(environmentId: string, day: string): Promise<number> {
    const [row] = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select({ sent: sql<number>`coalesce(sum(${smsCodeCounts.sent}), 0)::int` })
        .from(smsCodeCounts)
        .where(and(eq(smsCodeCounts.environmentId, environmentId), eq(smsCodeCounts.day, day)))
    )
    return row?.sent ?? 0
  }

  /** @inheritdoc */
  async recordUsed(environmentId: string, day: string, prefix: string, at: Date): Promise<void> {
    await withTenant(this.db, environmentId, (tx) =>
      tx
        .update(smsCodeCounts)
        .set({ used: sql`${smsCodeCounts.used} + 1`, updatedAt: at })
        .where(
          and(
            eq(smsCodeCounts.environmentId, environmentId),
            eq(smsCodeCounts.day, day),
            eq(smsCodeCounts.prefix, prefix),
            // In the statement itself, so two confirmations at once cannot pass `sent`.
            lt(smsCodeCounts.used, smsCodeCounts.sent)
          )
        )
    )
  }

  /** @inheritdoc */
  async summary(environmentId: string, since: string, limit: number): Promise<SmsUsageSummary> {
    const inSpan = and(
      eq(smsCodeCounts.environmentId, environmentId),
      gte(smsCodeCounts.day, since)
    )
    const sent = sql<number>`sum(${smsCodeCounts.sent})::int`
    const used = sql<number>`sum(${smsCodeCounts.used})::int`
    return withTenant(this.db, environmentId, async (tx) => {
      const [totals] = await tx
        .select({
          sent: sql<number>`coalesce(sum(${smsCodeCounts.sent}), 0)::int`,
          used: sql<number>`coalesce(sum(${smsCodeCounts.used}), 0)::int`,
        })
        .from(smsCodeCounts)
        .where(inSpan)
      const rows = await tx
        .select({ prefix: smsCodeCounts.prefix, sent, used })
        .from(smsCodeCounts)
        .where(inSpan)
        .groupBy(smsCodeCounts.prefix)
        .orderBy(
          desc(sql`sum(${smsCodeCounts.sent}) - sum(${smsCodeCounts.used})`),
          desc(sql`sum(${smsCodeCounts.sent})`),
          asc(smsCodeCounts.prefix)
        )
        // One more than asked for: whether the list was cut.
        .limit(limit + 1)
      return {
        sent: totals?.sent ?? 0,
        used: totals?.used ?? 0,
        prefixes: rows.slice(0, limit),
        truncated: rows.length > limit,
      }
    })
  }

  /** @inheritdoc */
  async deleteBefore(environmentId: string, day: string, limit: number): Promise<number> {
    const old = and(eq(smsCodeCounts.environmentId, environmentId), lt(smsCodeCounts.day, day))
    const rows = await withTenant(this.db, environmentId, (tx) =>
      tx
        .delete(smsCodeCounts)
        .where(
          and(
            old,
            // DELETE has no LIMIT in Postgres: pick the batch in a subquery.
            inArray(
              smsCodeCounts.id,
              tx.select({ id: smsCodeCounts.id }).from(smsCodeCounts).where(old).limit(limit)
            )
          )
        )
        .returning({ id: smsCodeCounts.id })
    )
    return rows.length
  }
}
