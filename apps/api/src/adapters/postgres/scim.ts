import {
  type Database,
  scimGroupMembers,
  scimGroups,
  scimTokens,
  scimUsers,
  type Transaction,
  withTenant,
} from '@tula-tech/db'
import { and, asc, count, desc, eq, inArray, isNull } from 'drizzle-orm'
import { recordActivity } from '~/adapters/postgres/activity'
import { isUniqueViolation } from '~/adapters/postgres/errors'
import { activityOf, type Recorded } from '~/ports/activity-log'
import type {
  ScimGroupRecord,
  ScimGroupRefusal,
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
    await withTenant(this.db, environmentId, async (tx) => {
      await tx.delete(scimGroupMembers).where(
        and(
          eq(scimGroupMembers.environmentId, environmentId),
          eq(scimGroupMembers.userId, userId),
          inArray(
            scimGroupMembers.groupId,
            tx
              .select({ id: scimGroups.id })
              .from(scimGroups)
              .where(
                and(
                  eq(scimGroups.environmentId, environmentId),
                  eq(scimGroups.organizationId, organizationId)
                )
              )
          )
        )
      )
      await tx
        .delete(scimUsers)
        .where(
          and(
            eq(scimUsers.environmentId, environmentId),
            eq(scimUsers.organizationId, organizationId),
            eq(scimUsers.userId, userId)
          )
        )
    })
  }

  /** The groups of these rows, each with its members. */
  async #withMembers(
    tx: Transaction,
    rows: (typeof scimGroups.$inferSelect)[]
  ): Promise<ScimGroupRecord[]> {
    if (rows.length === 0) {
      return []
    }
    const members = await tx
      .select({ groupId: scimGroupMembers.groupId, userId: scimGroupMembers.userId })
      .from(scimGroupMembers)
      .where(
        inArray(
          scimGroupMembers.groupId,
          rows.map((row) => row.id)
        )
      )
      .orderBy(asc(scimGroupMembers.createdAt), asc(scimGroupMembers.id))
    return rows.map((row) => ({
      ...row,
      memberIds: members.filter((m) => m.groupId === row.id).map((m) => m.userId),
    }))
  }

  /** @inheritdoc */
  async insertGroup(record: ScimGroupRecord, recorded: Recorded): Promise<ScimGroupRefusal | null> {
    const activity = activityOf(recorded)
    const { memberIds, ...row } = record
    try {
      await withTenant(this.db, record.environmentId, async (tx) => {
        await tx.insert(scimGroups).values(row)
        if (memberIds.length > 0) {
          await tx.insert(scimGroupMembers).values(
            [...new Set(memberIds)].map((userId) => ({
              id: Bun.randomUUIDv7(),
              projectId: record.projectId,
              environmentId: record.environmentId,
              groupId: record.id,
              userId,
              createdAt: record.createdAt,
              updatedAt: record.createdAt,
            }))
          )
        }
        await recordActivity(tx, activity ? [activity] : [])
      })
      return null
    } catch (error) {
      if (isUniqueViolation(error)) {
        return 'name_taken'
      }
      throw error
    }
  }

  /** @inheritdoc */
  async findGroup(environmentId: string, organizationId: string, id: string) {
    return withTenant(this.db, environmentId, async (tx) => {
      const rows = await tx
        .select()
        .from(scimGroups)
        .where(
          and(
            eq(scimGroups.environmentId, environmentId),
            eq(scimGroups.organizationId, organizationId),
            eq(scimGroups.id, id)
          )
        )
      return (await this.#withMembers(tx, rows))[0] ?? null
    })
  }

  /** @inheritdoc */
  async findGroupByName(environmentId: string, organizationId: string, displayName: string) {
    return withTenant(this.db, environmentId, async (tx) => {
      const rows = await tx
        .select()
        .from(scimGroups)
        .where(
          and(
            eq(scimGroups.environmentId, environmentId),
            eq(scimGroups.organizationId, organizationId),
            eq(scimGroups.displayName, displayName)
          )
        )
      return (await this.#withMembers(tx, rows))[0] ?? null
    })
  }

  /** @inheritdoc */
  async listGroups(environmentId: string, organizationId: string, offset: number, limit: number) {
    return withTenant(this.db, environmentId, async (tx) => {
      const where = and(
        eq(scimGroups.environmentId, environmentId),
        eq(scimGroups.organizationId, organizationId)
      )
      const rows = await tx
        .select()
        .from(scimGroups)
        .where(where)
        .orderBy(asc(scimGroups.createdAt), asc(scimGroups.id))
        .offset(offset)
        .limit(limit)
      const [totalRow] = await tx.select({ n: count() }).from(scimGroups).where(where)
      return { records: await this.#withMembers(tx, rows), total: totalRow?.n ?? 0 }
    })
  }

  /** @inheritdoc */
  async replaceGroup(
    environmentId: string,
    organizationId: string,
    id: string,
    next: { displayName: string; externalId: string | null; memberIds: string[] },
    at: Date,
    recorded: Recorded
  ): Promise<ScimGroupRefusal | null> {
    const activity = activityOf(recorded)
    try {
      return await withTenant(this.db, environmentId, async (tx) => {
        const rows = await tx
          .update(scimGroups)
          .set({ displayName: next.displayName, externalId: next.externalId, updatedAt: at })
          .where(
            and(
              eq(scimGroups.environmentId, environmentId),
              eq(scimGroups.organizationId, organizationId),
              eq(scimGroups.id, id)
            )
          )
          .returning({ projectId: scimGroups.projectId })
        const projectId = rows[0]?.projectId
        if (projectId === undefined) {
          return 'missing' as const
        }
        await tx.delete(scimGroupMembers).where(eq(scimGroupMembers.groupId, id))
        const wanted = [...new Set(next.memberIds)]
        if (wanted.length > 0) {
          await tx.insert(scimGroupMembers).values(
            wanted.map((userId) => ({
              id: Bun.randomUUIDv7(),
              projectId,
              environmentId,
              groupId: id,
              userId,
              createdAt: at,
              updatedAt: at,
            }))
          )
        }
        await recordActivity(tx, activity ? [activity] : [])
        return null
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        return 'name_taken'
      }
      throw error
    }
  }

  /** @inheritdoc */
  async deleteGroup(environmentId: string, organizationId: string, id: string, recorded: Recorded) {
    const activity = activityOf(recorded)
    return withTenant(this.db, environmentId, async (tx) => {
      const rows = await tx
        .delete(scimGroups)
        .where(
          and(
            eq(scimGroups.environmentId, environmentId),
            eq(scimGroups.organizationId, organizationId),
            eq(scimGroups.id, id)
          )
        )
        .returning({ id: scimGroups.id })
      if (rows.length === 0) {
        return false
      }
      await recordActivity(tx, activity ? [activity] : [])
      return true
    })
  }

  /** @inheritdoc */
  async groupNamesOfUser(environmentId: string, organizationId: string, userId: string) {
    const rows = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select({ name: scimGroups.displayName })
        .from(scimGroupMembers)
        .innerJoin(scimGroups, eq(scimGroups.id, scimGroupMembers.groupId))
        .where(
          and(
            eq(scimGroupMembers.environmentId, environmentId),
            eq(scimGroupMembers.userId, userId),
            eq(scimGroups.organizationId, organizationId)
          )
        )
    )
    return rows.map((row) => row.name)
  }
}
