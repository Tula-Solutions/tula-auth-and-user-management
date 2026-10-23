import type { OrganizationDomainMode } from '@tula-tech/contract'
import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import type { MemoryOrganizationStore } from '~/adapters/memory/organizations'
import { activityOf, type Recorded } from '~/ports/activity-log'
import type {
  ClaimOutcome,
  DomainClaim,
  OrganizationDomainRecord,
  OrganizationDomainStore,
  SetDomainModeOutcome,
  VerifyDomainOutcome,
} from '~/ports/organization-domain-store'

/** In-memory organization domains for tests. */
export class MemoryOrganizationDomainStore implements OrganizationDomainStore {
  readonly #rows: Map<string, OrganizationDomainRecord>
  readonly #activityLog: MemoryActivityLog
  readonly #organizations: MemoryOrganizationStore | null

  /**
   * @param activityLog - Where activity is recorded; shared with the other memory stores.
   * @param organizations - The organizations these domains belong to. Given, a claim for one
   *   it does not hold is `gone` (as the foreign key says) and a deleted organization's
   *   domains go with it (as the cascade does). Left out, any organization id is accepted.
   */
  // Assigned in the constructor for Bun coverage; see MemoryApiKeyRepository.
  constructor(
    activityLog: MemoryActivityLog = new MemoryActivityLog(),
    organizations: MemoryOrganizationStore | null = null
  ) {
    this.#rows = new Map()
    this.#activityLog = activityLog
    this.#organizations = organizations
    organizations?.onDelete((environmentId, organizationId) => {
      for (const [key, row] of this.#rows) {
        if (row.environmentId === environmentId && row.organizationId === organizationId) {
          this.#rows.delete(key)
        }
      }
    })
  }

  /** The row, when it is this organization's in this environment. */
  #own(environmentId: string, organizationId: string, id: string): OrganizationDomainRecord | null {
    const row = this.#rows.get(id)
    return row && row.environmentId === environmentId && row.organizationId === organizationId
      ? row
      : null
  }

  /** The environment's verified row for a domain, as the partial unique index sees it. */
  #verified(environmentId: string, domain: string): OrganizationDomainRecord | null {
    return (
      [...this.#rows.values()].find(
        (row) =>
          row.environmentId === environmentId && row.domain === domain && row.verifiedAt !== null
      ) ?? null
    )
  }

  /** @inheritdoc */
  async list(environmentId: string, organizationId: string): Promise<OrganizationDomainRecord[]> {
    return [...this.#rows.values()]
      .filter((row) => row.environmentId === environmentId && row.organizationId === organizationId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
      .map((row) => structuredClone(row))
  }

  /** @inheritdoc */
  async find(
    environmentId: string,
    organizationId: string,
    id: string
  ): Promise<OrganizationDomainRecord | null> {
    const row = this.#own(environmentId, organizationId, id)
    return row && structuredClone(row)
  }

  /** @inheritdoc */
  async findVerified(
    environmentId: string,
    domain: string
  ): Promise<OrganizationDomainRecord | null> {
    const row = this.#verified(environmentId, domain)
    return row && structuredClone(row)
  }

  /** @inheritdoc */
  async claim(claim: DomainClaim, recorded: Recorded): Promise<ClaimOutcome> {
    const activity = activityOf(recorded)
    if (
      this.#organizations &&
      !this.#organizations.has(claim.environmentId, claim.organizationId)
    ) {
      return { outcome: 'gone' }
    }
    if (this.#verified(claim.environmentId, claim.domain)) {
      return { outcome: 'taken' }
    }
    const own = [...this.#rows.values()].filter(
      (row) =>
        row.environmentId === claim.environmentId && row.organizationId === claim.organizationId
    )
    const existing = own.find((row) => row.domain === claim.domain)
    if (!existing && own.length >= claim.limit) {
      return { outcome: 'limit_reached' }
    }
    const record: OrganizationDomainRecord = existing
      ? {
          ...existing,
          mode: claim.mode,
          codeHash: claim.codeHash,
          codeExpiresAt: claim.codeExpiresAt,
          codeAttempts: 0,
          updatedAt: claim.at,
        }
      : {
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
        }
    this.#rows.set(record.id, structuredClone(record))
    this.#activityLog.record(activity ? [activity] : [])
    return { outcome: 'claimed', record: structuredClone(record) }
  }

  /** @inheritdoc */
  async recordAttempt(
    environmentId: string,
    organizationId: string,
    id: string,
    now: Date,
    maxAttempts: number
  ): Promise<OrganizationDomainRecord | null> {
    const row = this.#own(environmentId, organizationId, id)
    if (
      !row ||
      row.verifiedAt !== null ||
      row.codeHash === null ||
      row.codeExpiresAt === null ||
      row.codeExpiresAt.getTime() <= now.getTime() ||
      row.codeAttempts >= maxAttempts
    ) {
      return null
    }
    row.codeAttempts += 1
    return structuredClone(row)
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
    const row = this.#own(environmentId, organizationId, id)
    if (!row || row.verifiedAt !== null || row.codeHash !== expectedCodeHash) {
      return { outcome: 'stale' }
    }
    if (this.#verified(environmentId, row.domain)) {
      return { outcome: 'taken' }
    }
    row.verifiedAt = at
    row.codeHash = null
    row.codeExpiresAt = null
    row.codeAttempts = 0
    row.updatedAt = at
    this.#activityLog.record(activity ? [activity] : [])
    return { outcome: 'verified', record: structuredClone(row) }
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
    const row = this.#own(environmentId, organizationId, id)
    if (!row) {
      return { outcome: 'not_found' }
    }
    const previousMode = row.mode
    row.mode = mode
    row.updatedAt = at
    this.#activityLog.record(activity ? [activity] : [])
    return { outcome: 'updated', record: structuredClone(row), previousMode }
  }

  /** @inheritdoc */
  async remove(
    environmentId: string,
    organizationId: string,
    id: string,
    recorded: Recorded
  ): Promise<boolean> {
    const activity = activityOf(recorded)
    if (!this.#own(environmentId, organizationId, id)) {
      return false
    }
    this.#rows.delete(id)
    this.#activityLog.record(activity ? [activity] : [])
    return true
  }

  /** @inheritdoc */
  async purgeExpiredPending(environmentId: string, cutoff: Date, limit: number): Promise<number> {
    let deleted = 0
    for (const [key, row] of this.#rows) {
      if (deleted >= limit) {
        break
      }
      if (
        row.environmentId === environmentId &&
        row.verifiedAt === null &&
        row.codeExpiresAt !== null &&
        row.codeExpiresAt.getTime() < cutoff.getTime()
      ) {
        this.#rows.delete(key)
        deleted += 1
      }
    }
    return deleted
  }
}
