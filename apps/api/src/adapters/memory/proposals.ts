import type { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { activityOf, type Recorded } from '~/ports/activity-log'
import type { ApiKeyRepository } from '~/ports/api-key-repository'
import type {
  NewProposalRecord,
  ProposalApproval,
  ProposalOutcome,
  ProposalRecord,
  ProposalStore,
} from '~/ports/proposal-store'

/** Newest first; the id breaks ties between proposals of the same instant. */
function newestFirst(a: NewProposalRecord, b: NewProposalRecord): number {
  return b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1)
}

/** In-memory proposals for tests. */
export class MemoryProposalStore implements ProposalStore {
  readonly #records: Map<string, NewProposalRecord>
  readonly #activityLog: MemoryActivityLog
  readonly #keys: Pick<ApiKeyRepository, 'listByEnvironment'>

  /**
   * @param activityLog - Where the activities of its writes go.
   * @param keys - The API keys: whether a proposal's agent key is still one is read from
   *   them at every read and inside every approval, as the Postgres statement reads it.
   */
  // Assigned in the constructor for Bun coverage; see MemoryApiKeyRepository.
  constructor(activityLog: MemoryActivityLog, keys: Pick<ApiKeyRepository, 'listByEnvironment'>) {
    this.#records = new Map()
    this.#activityLog = activityLog
    this.#keys = keys
  }

  /** The stored proposal, when it is this environment's. */
  #own(environmentId: string, id: string): NewProposalRecord | null {
    const record = this.#records.get(id)
    return record && record.environmentId === environmentId ? record : null
  }

  /** The ids of the environment's unrevoked agent keys. */
  async #agents(environmentId: string): Promise<Set<string>> {
    const keys = await this.#keys.listByEnvironment(environmentId)
    return new Set(
      keys.filter((key) => key.kind === 'agent' && key.revokedAt === null).map((key) => key.id)
    )
  }

  /** A stored row as the port's record: a copy, with what its key is now. */
  #seen(record: NewProposalRecord, agents: Set<string>): ProposalRecord {
    return { ...structuredClone(record), proposerActive: agents.has(record.proposedBy) }
  }

  /** @inheritdoc */
  async list(environmentId: string, limit: number): Promise<ProposalRecord[]> {
    const agents = await this.#agents(environmentId)
    return [...this.#records.values()]
      .filter((record) => record.environmentId === environmentId)
      .sort(newestFirst)
      .slice(0, limit)
      .map((record) => this.#seen(record, agents))
  }

  /** @inheritdoc */
  async find(environmentId: string, id: string): Promise<ProposalRecord | null> {
    const agents = await this.#agents(environmentId)
    const record = this.#own(environmentId, id)
    return record && this.#seen(record, agents)
  }

  /** @inheritdoc */
  async findPending(
    environmentId: string,
    like: Pick<ProposalRecord, 'operation' | 'targetType' | 'targetId' | 'proposedBy'>,
    at: Date
  ): Promise<ProposalRecord | null> {
    const agents = await this.#agents(environmentId)
    const [record] = [...this.#records.values()]
      .filter(
        (one) =>
          one.environmentId === environmentId &&
          one.status === 'pending' &&
          one.expiresAt.getTime() > at.getTime() &&
          one.operation === like.operation &&
          one.targetType === like.targetType &&
          one.targetId === like.targetId &&
          one.proposedBy === like.proposedBy
      )
      .sort(newestFirst)
    return record ? this.#seen(record, agents) : null
  }

  /** @inheritdoc */
  async insert(record: NewProposalRecord, recorded: Recorded): Promise<ProposalRecord> {
    const activity = activityOf(recorded)
    const agents = await this.#agents(record.environmentId)
    if (this.#records.has(record.id)) {
      throw new Error('duplicate proposal id')
    }
    this.#records.set(record.id, structuredClone(record))
    this.#activityLog.record(activity ? [activity] : [])
    return this.#seen(record, agents)
  }

  /** @inheritdoc */
  async approve(
    environmentId: string,
    id: string,
    approval: ProposalApproval,
    at: Date,
    recorded: Recorded
  ): Promise<ProposalRecord | null> {
    const activity = activityOf(recorded)
    // The keys are read first and nothing is awaited after it: the compare and the write
    // below are one step, as the Postgres statement is.
    const agents = await this.#agents(environmentId)
    const record = this.#own(environmentId, id)
    // The compare of the compare-and-set, as the Postgres statement makes it.
    if (
      record?.status !== 'pending' ||
      record.expiresAt.getTime() <= at.getTime() ||
      !agents.has(record.proposedBy)
    ) {
      return null
    }
    const next: NewProposalRecord = {
      ...record,
      status: 'approved',
      approvedByType: approval.type,
      approvedById: approval.id,
      approvedAt: new Date(at),
      updatedAt: new Date(at),
    }
    this.#records.set(id, next)
    this.#activityLog.record(activity ? [activity] : [])
    return this.#seen(next, agents)
  }

  /** @inheritdoc */
  async finish(
    environmentId: string,
    id: string,
    outcome: ProposalOutcome,
    at: Date,
    recorded: Recorded
  ): Promise<ProposalRecord | null> {
    const activity = activityOf(recorded)
    const agents = await this.#agents(environmentId)
    const record = this.#own(environmentId, id)
    if (record?.status !== 'approved') {
      return null
    }
    const next: NewProposalRecord = {
      ...record,
      status: outcome.status,
      failureReason: outcome.status === 'failed' ? outcome.reason : null,
      updatedAt: new Date(at),
    }
    this.#records.set(id, next)
    this.#activityLog.record(activity ? [activity] : [])
    return this.#seen(next, agents)
  }

  /** @inheritdoc */
  async deleteExpiredBefore(environmentId: string, cutoff: Date, limit: number): Promise<number> {
    const gone = [...this.#records.values()]
      .filter(
        (record) =>
          record.environmentId === environmentId && record.expiresAt.getTime() < cutoff.getTime()
      )
      .slice(0, limit)
    for (const record of gone) {
      this.#records.delete(record.id)
    }
    return gone.length
  }
}
