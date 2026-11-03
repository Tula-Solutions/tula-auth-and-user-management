import { type Database, scimTokens, scimUsers, withTenant } from '@tula-tech/db'
import { and, asc, count, desc, eq, isNull } from 'drizzle-orm'
import { recordActivity } from '~/adapters/postgres/activity'
import { isUniqueViolation } from '~/adapters/postgres/errors'
import { activityOf, type Recorded } from '~/ports/activity-log'
import type {
  ScimStore,
  ScimTokenRecord,
  ScimUserRecord,
  ScimUserRefusal,
} from '~/ports/scim-store'

/** SCIM tokens and directory users in Postgres, behind row-level security. */
export class PostgresScimStore implements ScimStore {
  /** @param db - Database connected as the runtime role. */
  constructor(private readonly db: Database) {}

  /** @inheritdoc */
  async insertToken(record: ScimTokenRecord, recorded: Recorded): Promise<void> {
    const activity = activityOf(recorded)
    await withTenant(this.db, record.environmentId, async (tx) => {
      await tx.insert(scimTokens).values(record)
      await recordActivity(tx, activity ? [activity] : [])
    })
  }

  /** @inheritdoc */
  async listTokens(environmentId: string, organizationId: string): Promise<ScimTokenRecord[]> {
    return withTenant(this.db, environmentId, (tx) =>
      tx
        .select()
        .from(scimTokens)
        .where(
          and(
            eq(scimTokens.environmentId, environmentId),
            eq(scimTokens.organizationId, organizationId)
          )
        )
        .orderBy(desc(scimTokens.createdAt), desc(scimTokens.id))
    )
  }

  /** @inheritdoc */
  async findTokenByHash(environmentId: string, tokenHash: string): Promise<ScimTokenRecord | null> {
    const rows = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select()
        .from(scimTokens)
        .where(
          and(eq(scimTokens.environmentId, environmentId), eq(scimTokens.tokenHash, tokenHash))
        )
    )
    return rows[0] ?? null
  }

  /** @inheritdoc */
  async revokeToken(
    environmentId: string,
    organizationId: string,
    id: string,
    at: Date,
    recorded: Recorded
  ): Promise<ScimTokenRecord | null> {
    const activity = activityOf(recorded)
    return withTenant(this.db, environmentId, async (tx) => {
      const rows = await tx
        .update(scimTokens)
        .set({ revokedAt: at, updatedAt: at })
        .where(
          and(
            eq(scimTokens.environmentId, environmentId),
            eq(scimTokens.organizationId, organizationId),
            eq(scimTokens.id, id),
            isNull(scimTokens.revokedAt)
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
  async touchToken(environmentId: string, id: string, at: Date): Promise<void> {
    await withTenant(this.db, environmentId, (tx) =>
      tx
        .update(scimTokens)
        .set({ lastUsedAt: at })
        .where(and(eq(scimTokens.environmentId, environmentId), eq(scimTokens.id, id)))
    )
  }

  /** @inheritdoc */
  async findUser(
    environmentId: string,
    organizationId: string,
    userId: string
  ): Promise<ScimUserRecord | null> {
    const rows = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select()
        .from(scimUsers)
        .where(
          and(
            eq(scimUsers.environmentId, environmentId),
            eq(scimUsers.organizationId, organizationId),
            eq(scimUsers.userId, userId)
          )
        )
    )
    return rows[0] ?? null
  }

  /** @inheritdoc */
  async findUserByExternalId(
    environmentId: string,
    organizationId: string,
    externalId: string
  ): Promise<ScimUserRecord | null> {
    const rows = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select()
        .from(scimUsers)
        .where(
          and(
            eq(scimUsers.environmentId, environmentId),
            eq(scimUsers.organizationId, organizationId),
            eq(scimUsers.externalId, externalId)
          )
        )
    )
    return rows[0] ?? null
  }

  /** @inheritdoc */
  async listUsers(
    environmentId: string,
    organizationId: string,
    offset: number,
    limit: number
  ): Promise<{ records: ScimUserRecord[]; total: number }> {
    return withTenant(this.db, environmentId, async (tx) => {
      const where = and(
        eq(scimUsers.environmentId, environmentId),
        eq(scimUsers.organizationId, organizationId)
      )
      const records = await tx
        .select()
        .from(scimUsers)
        .where(where)
        .orderBy(asc(scimUsers.createdAt), asc(scimUsers.id))
        .offset(offset)
        .limit(limit)
      const [totalRow] = await tx.select({ n: count() }).from(scimUsers).where(where)
      return { records, total: totalRow?.n ?? 0 }
    })
  }

  /** @inheritdoc */
  async insertUser(record: ScimUserRecord, recorded: Recorded): Promise<ScimUserRefusal | null> {
    const activity = activityOf(recorded)
    try {
      await withTenant(this.db, record.environmentId, async (tx) => {
        await tx.insert(scimUsers).values(record)
        await recordActivity(tx, activity ? [activity] : [])
      })
      return null
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error
      }
      for (
        let current: unknown = error;
        current instanceof Object;
        current = (current as Error).cause
      ) {
        const { constraint } = current as { constraint?: unknown }
        if (constraint === 'scim_users_organization_external_key') {
          return 'external_id_taken'
        }
      }
      return 'exists'
    }
  }

  /** @inheritdoc */
  async updateUser(
    environmentId: string,
    organizationId: string,
    userId: string,
    changes: { externalId?: string | null; active?: boolean },
    at: Date
  ): Promise<ScimUserRefusal | null> {
    try {
      const rows = await withTenant(this.db, environmentId, (tx) =>
        tx
          .update(scimUsers)
          .set({ ...changes, updatedAt: at })
          .where(
            and(
              eq(scimUsers.environmentId, environmentId),
              eq(scimUsers.organizationId, organizationId),
              eq(scimUsers.userId, userId)
            )
          )
          .returning({ id: scimUsers.id })
      )
      return rows.length === 0 ? 'missing' : null
    } catch (error) {
      if (isUniqueViolation(error)) {
        return 'external_id_taken'
      }
      throw error
    }
  }

  /** @inheritdoc */
  async deleteUser(environmentId: string, organizationId: string, userId: string): Promise<void> {
    await withTenant(this.db, environmentId, (tx) =>
      tx
        .delete(scimUsers)
        .where(
          and(
            eq(scimUsers.environmentId, environmentId),
            eq(scimUsers.organizationId, organizationId),
            eq(scimUsers.userId, userId)
          )
        )
    )
  }
}
