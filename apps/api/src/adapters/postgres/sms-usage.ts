import { type Database, smsCodeCounts, withTenant } from '@tula/db'
import { and, asc, desc, eq, gt, gte, inArray, lt, sql } from 'drizzle-orm'
import type { SmsUsageScope, SmsUsageStore, SmsUsageSummary } from '~/ports/sms-usage-store'

/**
 * Counts of texted codes in Postgres (`sms_code_counts`), behind row-level security.
 *
 * Each count is one statement: an insert that becomes an increment when the day's row for the
 * prefix exists, so two instances counting at once lose nothing. The table's own check
 * refuses a prefix longer than four digits, whatever is passed here.
 */
export class PostgresSmsUsageStore implements SmsUsageStore {
  /** @param db - Database connected as the runtime role. */
  constructor(private readonly db: Database) {}

  /** @inheritdoc */
  async recordSent(scope: SmsUsageScope, day: string, prefix: string, at: Date): Promise<void> {
    await withTenant(this.db, scope.environmentId, (tx) =>
      tx
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
    )
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
