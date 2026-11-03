import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { activityOf, type Recorded } from '~/ports/activity-log'
import type {
  SsoConnectionChanges,
  SsoConnectionRecord,
  SsoConnectionStore,
  SsoIdentityRecord,
  SsoWriteRefusal,
} from '~/ports/sso-connection-store'

/** In-memory SSO connections for tests. */
export class MemorySsoConnectionStore implements SsoConnectionStore {
  readonly #records: Map<string, SsoConnectionRecord>
  readonly #identities: Map<string, SsoIdentityRecord & { environmentId: string }>
  readonly #activityLog: MemoryActivityLog

  // Assigned in the constructor for Bun coverage; see MemoryApiKeyRepository.
  constructor(activityLog: MemoryActivityLog = new MemoryActivityLog()) {
    this.#records = new Map()
    this.#identities = new Map()
    this.#activityLog = activityLog
  }

  #own(environmentId: string, id: string): SsoConnectionRecord | null {
    const record = this.#records.get(id)
    return record && record.environmentId === environmentId ? record : null
  }

  /** Whether another active connection of the environment holds one of the candidate's domains. */
  #domainTaken(candidate: SsoConnectionRecord): boolean {
    if (candidate.status !== 'active') {
      return false
    }
    return [...this.#records.values()].some(
      (one) =>
        one.id !== candidate.id &&
        one.environmentId === candidate.environmentId &&
        one.status === 'active' &&
        one.domains.some((domain) => candidate.domains.includes(domain))
    )
  }

  /** @inheritdoc */
  async list(environmentId: string, organizationId?: string): Promise<SsoConnectionRecord[]> {
    return [...this.#records.values()]
      .filter(
        (one) =>
          one.environmentId === environmentId &&
          (organizationId === undefined || one.organizationId === organizationId)
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
      .map((one) => structuredClone(one))
  }

  /** @inheritdoc */
  async find(environmentId: string, id: string): Promise<SsoConnectionRecord | null> {
    const record = this.#own(environmentId, id)
    return record && structuredClone(record)
  }

  /** @inheritdoc */
  async findActiveByDomain(
    environmentId: string,
    domain: string
  ): Promise<SsoConnectionRecord | null> {
    const found = [...this.#records.values()].find(
      (one) =>
        one.environmentId === environmentId &&
        one.status === 'active' &&
        one.domains.includes(domain)
    )
    return found ? structuredClone(found) : null
  }

  /** @inheritdoc */
  async insert(
    record: SsoConnectionRecord,
    recorded: Recorded
  ): Promise<SsoConnectionRecord | 'name_taken' | 'domain_taken'> {
    const activity = activityOf(recorded)
    const nameTaken = [...this.#records.values()].some(
      (one) =>
        one.id === record.id ||
        (one.organizationId === record.organizationId && one.name === record.name)
    )
    if (nameTaken) {
      return 'name_taken'
    }
    if (this.#domainTaken(record)) {
      return 'domain_taken'
    }
    const stored = { ...structuredClone(record), domains: [...record.domains].sort() }
    this.#records.set(record.id, stored)
    this.#activityLog.record(activity ? [activity] : [])
    return structuredClone(stored)
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
    const record = this.#own(environmentId, id)
    if (!record) {
      return 'missing'
    }
    const next: SsoConnectionRecord = {
      ...record,
      name: changes.name ?? record.name,
      issuer: changes.issuer ?? record.issuer,
      clientId: changes.clientId ?? record.clientId,
      clientSecretSealed: changes.clientSecretSealed ?? record.clientSecretSealed,
      saml: changes.saml ?? record.saml,
      defaultRole: changes.defaultRole ?? record.defaultRole,
      enforced: changes.enforced ?? record.enforced,
      breakGlassRole:
        changes.breakGlassRole === undefined ? record.breakGlassRole : changes.breakGlassRole,
      trustIdpMfa: changes.trustIdpMfa ?? record.trustIdpMfa,
      domains: changes.domains ? [...changes.domains].sort() : record.domains,
      status: changes.status ?? record.status,
      updatedAt,
    }
    const renamed = next.name !== record.name
    if (
      renamed &&
      [...this.#records.values()].some(
        (one) =>
          one.id !== id && one.organizationId === next.organizationId && one.name === next.name
      )
    ) {
      return 'name_taken'
    }
    if (this.#domainTaken(next)) {
      return 'domain_taken'
    }
    this.#records.set(id, next)
    this.#activityLog.record(activity ? [activity] : [])
    return structuredClone(next)
  }

  /** @inheritdoc */
  async delete(
    environmentId: string,
    id: string,
    recorded: Recorded
  ): Promise<'deleted' | 'missing' | 'in_use'> {
    const activity = activityOf(recorded)
    if (!this.#own(environmentId, id)) {
      return 'missing'
    }
    if ([...this.#identities.values()].some((one) => one.connectionId === id)) {
      return 'in_use'
    }
    this.#records.delete(id)
    this.#activityLog.record(activity ? [activity] : [])
    return 'deleted'
  }

  /** @inheritdoc */
  async findIdentity(
    environmentId: string,
    connectionId: string,
    subject: string
  ): Promise<SsoIdentityRecord | null> {
    const found = [...this.#identities.values()].find(
      (one) =>
        one.environmentId === environmentId &&
        one.connectionId === connectionId &&
        one.subject === subject
    )
    return found ? { connectionId, userId: found.userId, subject } : null
  }

  /** @inheritdoc */
  async linkIdentity(
    environmentId: string,
    identity: SsoIdentityRecord,
    _at: Date,
    recorded: Recorded
  ): Promise<boolean> {
    const taken = [...this.#identities.values()].some(
      (one) =>
        one.connectionId === identity.connectionId &&
        (one.subject === identity.subject || one.userId === identity.userId)
    )
    if (taken || !this.#own(environmentId, identity.connectionId)) {
      return false
    }
    this.#identities.set(`${identity.connectionId}:${identity.subject}`, {
      ...identity,
      environmentId,
    })
    const activity = activityOf(recorded)
    this.#activityLog.record(activity ? [activity] : [])
    return true
  }
}
