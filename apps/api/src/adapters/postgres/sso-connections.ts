import {
  type Database,
  ssoConnectionDomains,
  ssoConnections,
  ssoIdentities,
  withTenant,
} from '@tula-tech/db'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { recordActivity } from '~/adapters/postgres/activity'
import { isUniqueViolation } from '~/adapters/postgres/errors'
import { activityOf, type Recorded } from '~/ports/activity-log'
import type {
  SsoConnectionChanges,
  SsoConnectionRecord,
  SsoConnectionStore,
  SsoIdentityRecord,
  SsoWriteRefusal,
} from '~/ports/sso-connection-store'

type Row = typeof ssoConnections.$inferSelect
type Tx = Parameters<Parameters<typeof withTenant>[2]>[0]

/** The name of the constraint a unique violation broke, from anywhere in the cause chain. */
function constraintOf(error: unknown): string | undefined {
  for (let current = error; current instanceof Object; current = (current as Error).cause) {
    const { constraint } = current as { constraint?: unknown }
    if (typeof constraint === 'string') {
      return constraint
    }
  }
  return undefined
}

/** Which race a unique violation lost: the active-domain index, or the organization's name key. */
function refusalOf(error: unknown): 'name_taken' | 'domain_taken' | null {
  if (!isUniqueViolation(error)) {
    return null
  }
  return constraintOf(error) === 'sso_connection_domains_active_domain_key'
    ? 'domain_taken'
    : 'name_taken'
}

/** SSO connections in Postgres, behind row-level security. */
export class PostgresSsoConnectionStore implements SsoConnectionStore {
  /** @param db - Database connected as the runtime role. */
  constructor(private readonly db: Database) {}

  /** The connections with their bound domains attached. */
  async #withDomains(tx: Tx, rows: Row[]): Promise<SsoConnectionRecord[]> {
    if (rows.length === 0) {
      return []
    }
    const domains = await tx
      .select({
        connectionId: ssoConnectionDomains.connectionId,
        domain: ssoConnectionDomains.domain,
      })
      .from(ssoConnectionDomains)
      .where(
        inArray(
          ssoConnectionDomains.connectionId,
          rows.map((row) => row.id)
        )
      )
    return rows.map((row) => ({
      ...row,
      domains: domains
        .filter((one) => one.connectionId === row.id)
        .map((one) => one.domain)
        .sort(),
    }))
  }

  /** @inheritdoc */
  async list(environmentId: string, organizationId?: string): Promise<SsoConnectionRecord[]> {
    return withTenant(this.db, environmentId, async (tx) =>
      this.#withDomains(
        tx,
        await tx
          .select()
          .from(ssoConnections)
          .where(
            and(
              eq(ssoConnections.environmentId, environmentId),
              organizationId === undefined
                ? undefined
                : eq(ssoConnections.organizationId, organizationId)
            )
          )
          .orderBy(asc(ssoConnections.createdAt), asc(ssoConnections.id))
      )
    )
  }

  /** @inheritdoc */
  async find(environmentId: string, id: string): Promise<SsoConnectionRecord | null> {
    return withTenant(this.db, environmentId, async (tx) => {
      const rows = await tx
        .select()
        .from(ssoConnections)
        .where(and(eq(ssoConnections.environmentId, environmentId), eq(ssoConnections.id, id)))
      return (await this.#withDomains(tx, rows))[0] ?? null
    })
  }

  /** @inheritdoc */
  async findActiveByDomain(
    environmentId: string,
    domain: string
  ): Promise<SsoConnectionRecord | null> {
    return withTenant(this.db, environmentId, async (tx) => {
      const [bound] = await tx
        .select({ connectionId: ssoConnectionDomains.connectionId })
        .from(ssoConnectionDomains)
        .where(
          and(
            eq(ssoConnectionDomains.environmentId, environmentId),
            eq(ssoConnectionDomains.domain, domain),
            eq(ssoConnectionDomains.active, true)
          )
        )
      if (!bound) {
        return null
      }
      const rows = await tx
        .select()
        .from(ssoConnections)
        .where(eq(ssoConnections.id, bound.connectionId))
      return (await this.#withDomains(tx, rows))[0] ?? null
    })
  }

  /** @inheritdoc */
  async insert(
    record: SsoConnectionRecord,
    recorded: Recorded
  ): Promise<SsoConnectionRecord | 'name_taken' | 'domain_taken'> {
    const activity = activityOf(recorded)
    const { domains, ...row } = record
    try {
      await withTenant(this.db, record.environmentId, async (tx) => {
        await tx.insert(ssoConnections).values(row)
        if (domains.length > 0) {
          await tx.insert(ssoConnectionDomains).values(
            domains.map((domain) => ({
              id: Bun.randomUUIDv7(),
              projectId: record.projectId,
              environmentId: record.environmentId,
              connectionId: record.id,
              domain,
              active: record.status === 'active',
              createdAt: record.createdAt,
              updatedAt: record.createdAt,
            }))
          )
        }
        await recordActivity(tx, activity ? [activity] : [])
      })
      return { ...record, domains: [...domains].sort() }
    } catch (error) {
      const refused = refusalOf(error)
      if (refused) {
        return refused
      }
      throw error
    }
  }

  /** @inheritdoc */
  async update(
    environmentId: string,
    id: string,
    changes: SsoConnectionChanges,
    updatedAt: Date,
    recorded: Recorded
  ): Promise<SsoConnectionRecord | SsoWriteRefusal> {
    const activity = activityOf(recorded)
    try {
      return await withTenant(this.db, environmentId, async (tx) => {
        const { domains, ...columns } = changes
        const [row] = await tx
          .update(ssoConnections)
          .set({ ...columns, updatedAt })
          .where(and(eq(ssoConnections.environmentId, environmentId), eq(ssoConnections.id, id)))
          .returning()
        if (!row) {
          return 'missing' as const
        }
        if (domains) {
          await tx.delete(ssoConnectionDomains).where(eq(ssoConnectionDomains.connectionId, id))
          if (domains.length > 0) {
            await tx.insert(ssoConnectionDomains).values(
              domains.map((domain) => ({
                id: Bun.randomUUIDv7(),
                projectId: row.projectId,
                environmentId,
                connectionId: id,
                domain,
                active: row.status === 'active',
                createdAt: updatedAt,
                updatedAt,
              }))
            )
          }
        } else if (changes.status) {
          // The copy the one-active-connection-per-domain index reads, kept in the same transaction.
          await tx
            .update(ssoConnectionDomains)
            .set({ active: row.status === 'active', updatedAt })
            .where(eq(ssoConnectionDomains.connectionId, id))
        }
        await recordActivity(tx, activity ? [activity] : [])
        return (await this.#withDomains(tx, [row]))[0] as SsoConnectionRecord
      })
    } catch (error) {
      const refused = refusalOf(error)
      if (refused) {
        return refused
      }
      throw error
    }
  }

  /** @inheritdoc */
  async delete(
    environmentId: string,
    id: string,
    recorded: Recorded
  ): Promise<'deleted' | 'missing' | 'in_use'> {
    const activity = activityOf(recorded)
    return withTenant(this.db, environmentId, async (tx) => {
      const [identity] = await tx
        .select({ id: ssoIdentities.id })
        .from(ssoIdentities)
        .where(eq(ssoIdentities.connectionId, id))
        .limit(1)
      if (identity) {
        return 'in_use' as const
      }
      await tx.delete(ssoConnectionDomains).where(eq(ssoConnectionDomains.connectionId, id))
      const rows = await tx
        .delete(ssoConnections)
        .where(and(eq(ssoConnections.environmentId, environmentId), eq(ssoConnections.id, id)))
        .returning({ id: ssoConnections.id })
      const deleted = rows.length === 1
      await recordActivity(tx, deleted && activity ? [activity] : [])
      return deleted ? ('deleted' as const) : ('missing' as const)
    })
  }

  /** @inheritdoc */
  async findIdentity(
    environmentId: string,
    connectionId: string,
    subject: string
  ): Promise<SsoIdentityRecord | null> {
    const [row] = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select({ userId: ssoIdentities.userId })
        .from(ssoIdentities)
        .where(
          and(
            eq(ssoIdentities.environmentId, environmentId),
            eq(ssoIdentities.connectionId, connectionId),
            eq(ssoIdentities.subject, subject)
          )
        )
    )
    return row ? { connectionId, userId: row.userId, subject } : null
  }

  /** @inheritdoc */
  async linkIdentity(
    environmentId: string,
    identity: SsoIdentityRecord,
    at: Date,
    recorded: Recorded
  ): Promise<boolean> {
    try {
      return await withTenant(this.db, environmentId, async (tx) => {
        const [connection] = await tx
          .select({ projectId: ssoConnections.projectId })
          .from(ssoConnections)
          .where(eq(ssoConnections.id, identity.connectionId))
        if (!connection) {
          return false
        }
        await tx.insert(ssoIdentities).values({
          id: Bun.randomUUIDv7(),
          projectId: connection.projectId,
          environmentId,
          ...identity,
          lastSignInAt: at,
          createdAt: at,
          updatedAt: at,
        })
        const activity = activityOf(recorded)
        await recordActivity(tx, activity ? [activity] : [])
        return true
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        return false
      }
      throw error
    }
  }
}
