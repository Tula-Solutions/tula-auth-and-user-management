import { type Database, setupLinks, withTenant } from '@tula-tech/db'
import { and, desc, eq, inArray, isNull, lt } from 'drizzle-orm'
import { recordActivity } from '~/adapters/postgres/activity'
import { activityOf, type Recorded } from '~/ports/activity-log'
import type { SetupLinkRecord, SetupLinkStore } from '~/ports/setup-link-store'

/** Setup links in Postgres, behind row-level security. */
export class PostgresSetupLinkStore implements SetupLinkStore {
  /** @param db - Database connected as the runtime role. */
  constructor(private readonly db: Database) {}

  /** @inheritdoc */
  async insert(record: SetupLinkRecord, recorded: Recorded): Promise<void> {
    const activity = activityOf(recorded)
    await withTenant(this.db, record.environmentId, async (tx) => {
      await tx.insert(setupLinks).values(record)
      await recordActivity(tx, activity ? [activity] : [])
    })
  }

  /** @inheritdoc */
  async list(environmentId: string, organizationId: string): Promise<SetupLinkRecord[]> {
    return withTenant(this.db, environmentId, (tx) =>
      tx
        .select()
        .from(setupLinks)
        .where(
          and(
            eq(setupLinks.environmentId, environmentId),
            eq(setupLinks.organizationId, organizationId)
          )
        )
        .orderBy(desc(setupLinks.createdAt), desc(setupLinks.id))
    )
  }

  /** @inheritdoc */
  async findByHash(environmentId: string, tokenHash: string): Promise<SetupLinkRecord | null> {
    const rows = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select()
        .from(setupLinks)
        .where(
          and(eq(setupLinks.environmentId, environmentId), eq(setupLinks.tokenHash, tokenHash))
        )
    )
    return rows[0] ?? null
  }

  /** @inheritdoc */
  async revoke(
    environmentId: string,
    organizationId: string,
    id: string,
    at: Date,
    recorded: Recorded
  ): Promise<SetupLinkRecord | null> {
    const activity = activityOf(recorded)
    return withTenant(this.db, environmentId, async (tx) => {
      const rows = await tx
        .update(setupLinks)
        .set({ revokedAt: at, updatedAt: at })
        .where(
          and(
            eq(setupLinks.environmentId, environmentId),
            eq(setupLinks.organizationId, organizationId),
            eq(setupLinks.id, id),
            isNull(setupLinks.revokedAt)
          )
        )
        .returning()
      if (rows[0]) {
        await recordActivity(tx, activity ? [activity] : [])
      }
      return rows[0] ?? null
    })
  }

  /** @inheritdoc */
  async touch(environmentId: string, id: string, at: Date): Promise<void> {
    await withTenant(this.db, environmentId, (tx) =>
      tx
        .update(setupLinks)
        .set({ lastUsedAt: at })
        .where(and(eq(setupLinks.environmentId, environmentId), eq(setupLinks.id, id)))
    )
  }

  /** @inheritdoc */
  async deleteExpiredBefore(environmentId: string, cutoff: Date, limit: number): Promise<number> {
    const rows = await withTenant(this.db, environmentId, (tx) =>
      tx
        .delete(setupLinks)
        .where(
          and(
            eq(setupLinks.environmentId, environmentId),
            // DELETE has no LIMIT in Postgres: pick the batch in a subquery.
            inArray(
              setupLinks.id,
              tx
                .select({ id: setupLinks.id })
                .from(setupLinks)
                .where(
                  and(eq(setupLinks.environmentId, environmentId), lt(setupLinks.expiresAt, cutoff))
                )
                .limit(limit)
            )
          )
        )
        .returning({ id: setupLinks.id })
    )
    return rows.length
  }
}
