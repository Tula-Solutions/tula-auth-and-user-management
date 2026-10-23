import type { OrganizationDomainMode } from '@tula-tech/contract'
import {
  type Database,
  organizationDomains,
  organizations,
  type Transaction,
  withTenant,
} from '@tula-tech/db'
import { and, asc, count, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import { recordActivity } from '~/adapters/postgres/activity'
import { isUniqueViolation } from '~/adapters/postgres/errors'
import { activityOf, type Recorded } from '~/ports/activity-log'
import type {
  ClaimOutcome,
  DomainClaim,
  OrganizationDomainRecord,
  OrganizationDomainStore,
  SetDomainModeOutcome,
  VerifyDomainOutcome,
} from '~/ports/organization-domain-store'

const columns = {
  id: organizationDomains.id,
  projectId: organizationDomains.projectId,
  environmentId: organizationDomains.environmentId,
  organizationId: organizationDomains.organizationId,
  domain: organizationDomains.domain,
  mode: organizationDomains.mode,
  verifiedAt: organizationDomains.verifiedAt,
  codeHash: organizationDomains.codeHash,
  codeExpiresAt: organizationDomains.codeExpiresAt,
  codeAttempts: organizationDomains.codeAttempts,
  createdAt: organizationDomains.createdAt,
  updatedAt: organizationDomains.updatedAt,
}

/** The row of one organization's domain, in the one environment. */
function owned(environmentId: string, organizationId: string, id: string) {
  return and(
    eq(organizationDomains.environmentId, environmentId),
    eq(organizationDomains.organizationId, organizationId),
    eq(organizationDomains.id, id)
  )
}

/** Postgres organization domains (`organization_domains`, migration 0041). */
export class PostgresOrganizationDomainStore implements OrganizationDomainStore {
  /** @param db - The runtime database; every statement runs in `withTenant`. */
  constructor(private readonly db: Database) {}

  /** @inheritdoc */
  async list(environmentId: string, organizationId: string): Promise<OrganizationDomainRecord[]> {
    return withTenant(this.db, environmentId, (tx) =>
      tx
        .select(columns)
        .from(organizationDomains)
        .where(
          and(
            eq(organizationDomains.environmentId, environmentId),
            eq(organizationDomains.organizationId, organizationId)
          )
        )
        .orderBy(asc(organizationDomains.createdAt), asc(organizationDomains.id))
    )
  }

  /** @inheritdoc */
  async find(
    environmentId: string,
    organizationId: string,
    id: string
  ): Promise<OrganizationDomainRecord | null> {
    const [row] = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select(columns)
        .from(organizationDomains)
        .where(owned(environmentId, organizationId, id))
    )
    return row ?? null
  }

  /** @inheritdoc */
  async findVerified(
    environmentId: string,
    domain: string
  ): Promise<OrganizationDomainRecord | null> {
    const [row] = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select(columns)
        .from(organizationDomains)
        .where(
          and(
            eq(organizationDomains.environmentId, environmentId),
            eq(organizationDomains.domain, domain),
            isNotNull(organizationDomains.verifiedAt)
          )
        )
    )
    return row ?? null
  }

  /** @inheritdoc */
  async claim(claim: DomainClaim, recorded: Recorded): Promise<ClaimOutcome> {
    const activity = activityOf(recorded)
    try {
      return await withTenant(this.db, claim.environmentId, async (tx) => {
        // Holding the organization's row makes the count and the write take turns with another
        // claim of the same organization.
        const locked = await tx
          .select({ id: organizations.id })
          .from(organizations)
          .where(
            and(
              eq(organizations.environmentId, claim.environmentId),
              eq(organizations.id, claim.organizationId)
            )
          )
          .for('update')
        if (locked.length !== 1) {
          return { outcome: 'gone' } as const
        }
        const [verified] = await tx
          .select({ id: organizationDomains.id })
          .from(organizationDomains)
          .where(
            and(
              eq(organizationDomains.environmentId, claim.environmentId),
              eq(organizationDomains.domain, claim.domain),
              isNotNull(organizationDomains.verifiedAt)
            )
          )
        if (verified) {
          return { outcome: 'taken' } as const
        }
        const [existing] = await tx
          .select({ id: organizationDomains.id })
          .from(organizationDomains)
          .where(
            and(
              eq(organizationDomains.environmentId, claim.environmentId),
              eq(organizationDomains.organizationId, claim.organizationId),
              eq(organizationDomains.domain, claim.domain)
            )
          )
        if (existing) {
          const [row] = await tx
            .update(organizationDomains)
            .set({
              mode: claim.mode,
              codeHash: claim.codeHash,
              codeExpiresAt: claim.codeExpiresAt,
              codeAttempts: 0,
              updatedAt: claim.at,
            })
            .where(owned(claim.environmentId, claim.organizationId, existing.id))
            .returning(columns)
          await recordActivity(tx, activity ? [activity] : [])
          return { outcome: 'claimed', record: row as OrganizationDomainRecord } as const
        }
        const [held] = await tx
          .select({ n: count() })
          .from(organizationDomains)
          .where(
            and(
              eq(organizationDomains.environmentId, claim.environmentId),
              eq(organizationDomains.organizationId, claim.organizationId)
            )
          )
        if ((held?.n ?? 0) >= claim.limit) {
          return { outcome: 'limit_reached' } as const
        }
        const [row] = await tx
          .insert(organizationDomains)
          .values({
            id: claim.id,
            projectId: claim.projectId,
            environmentId: claim.environmentId,
            organizationId: claim.organizationId,
            domain: claim.domain,
            mode: claim.mode,
            verifiedAt: null,
            codeHash: claim.codeHash,
            codeExpiresAt: claim.codeExpiresAt,
            codeAttempts: 0,
            createdAt: claim.at,
            updatedAt: claim.at,
          })
          .returning(columns)
        await recordActivity(tx, activity ? [activity] : [])
        return { outcome: 'claimed', record: row as OrganizationDomainRecord } as const
      })
    } catch (error) {
      // A verified row appeared between the check and the write: the unique key decided.
      if (isUniqueViolation(error)) {
        return { outcome: 'taken' }
      }
      throw error
    }
  }

  /** @inheritdoc */
  async recordAttempt(
    environmentId: string,
    organizationId: string,
    id: string,
    now: Date,
    maxAttempts: number
  ): Promise<OrganizationDomainRecord | null> {
    // One guarded UPDATE: the row lock serializes concurrent guesses, so the counter can never
    // pass `maxAttempts` however many requests race.
    const [row] = await withTenant(this.db, environmentId, (tx) =>
      tx
        .update(organizationDomains)
        .set({ codeAttempts: sql`${organizationDomains.codeAttempts} + 1` })
        .where(
          and(
            owned(environmentId, organizationId, id),
            isNull(organizationDomains.verifiedAt),
            isNotNull(organizationDomains.codeHash),
            sql`${organizationDomains.codeExpiresAt} > ${now}`,
            lt(organizationDomains.codeAttempts, maxAttempts)
          )
        )
        .returning(columns)
    )
    return row ?? null
  }

  /** @inheritdoc */
  async verify(
    environmentId: string,
    organizationId: string,
    id: string,
    expectedCodeHash: string,
    at: Date,
    recorded: Recorded
  ): Promise<VerifyDomainOutcome> {
    const activity = activityOf(recorded)
    try {
      return await withTenant(this.db, environmentId, async (tx) => {
        const [row] = await tx
          .update(organizationDomains)
          .set({
            verifiedAt: at,
            codeHash: null,
            codeExpiresAt: null,
            codeAttempts: 0,
            updatedAt: at,
          })
          .where(
            and(
              owned(environmentId, organizationId, id),
              isNull(organizationDomains.verifiedAt),
              eq(organizationDomains.codeHash, expectedCodeHash)
            )
          )
          .returning(columns)
        if (!row) {
          return { outcome: 'stale' } as const
        }
        await recordActivity(tx, activity ? [activity] : [])
        return { outcome: 'verified', record: row as OrganizationDomainRecord } as const
      })
    } catch (error) {
      // Another organization verified the domain first: the partial unique index decided and
      // the transaction, with its audit entry, is rolled back.
      if (isUniqueViolation(error)) {
        return { outcome: 'taken' }
      }
      throw error
    }
  }

  /** @inheritdoc */
  async setMode(
    environmentId: string,
    organizationId: string,
    id: string,
    mode: OrganizationDomainMode,
    at: Date,
    recorded: Recorded
  ): Promise<SetDomainModeOutcome> {
    const activity = activityOf(recorded)
    return withTenant(this.db, environmentId, async (tx) => {
      const [before] = await tx
        .select({ mode: organizationDomains.mode })
        .from(organizationDomains)
        .where(owned(environmentId, organizationId, id))
        .for('update')
      if (!before) {
        return { outcome: 'not_found' } as const
      }
      const [row] = await tx
        .update(organizationDomains)
        .set({ mode, updatedAt: at })
        .where(owned(environmentId, organizationId, id))
        .returning(columns)
      await recordActivity(tx, activity ? [activity] : [])
      return {
        outcome: 'updated',
        record: row as OrganizationDomainRecord,
        previousMode: before.mode,
      } as const
    })
  }

  /** @inheritdoc */
  async remove(
    environmentId: string,
    organizationId: string,
    id: string,
    recorded: Recorded
  ): Promise<boolean> {
    const activity = activityOf(recorded)
    return withTenant(this.db, environmentId, async (tx: Transaction) => {
      const rows = await tx
        .delete(organizationDomains)
        .where(owned(environmentId, organizationId, id))
        .returning({ id: organizationDomains.id })
      if (rows.length === 0) {
        return false
      }
      await recordActivity(tx, activity ? [activity] : [])
      return true
    })
  }

  /** @inheritdoc */
  async purgeExpiredPending(environmentId: string, cutoff: Date, limit: number): Promise<number> {
    const rows = await withTenant(this.db, environmentId, (tx) =>
      tx
        .delete(organizationDomains)
        .where(
          and(
            eq(organizationDomains.environmentId, environmentId),
            // DELETE has no LIMIT in Postgres: pick the batch in a subquery.
            inArray(
              organizationDomains.id,
              tx
                .select({ id: organizationDomains.id })
                .from(organizationDomains)
                .where(
                  and(
                    eq(organizationDomains.environmentId, environmentId),
                    isNull(organizationDomains.verifiedAt),
                    lt(organizationDomains.codeExpiresAt, cutoff)
                  )
                )
                .limit(limit)
            )
          )
        )
        .returning({ id: organizationDomains.id })
    )
    return rows.length
  }
}
