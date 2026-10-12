import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { activityOf, type Recorded } from '~/ports/activity-log'
import type {
  ProposalApproval,
  ProposalOutcome,
  ProposalRecord,
  ProposalStore,
} from '~/ports/proposal-store'

/** Newest first; the id breaks ties between proposals of the same instant. */
function newestFirst(a: ProposalRecord, b: ProposalRecord): number {
  return b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1)
}

/** In-memory proposals for tests. */
export class MemoryProposalStore implements ProposalStore {
  readonly #records: Map<string, ProposalRecord>
  readonly #activityLog: MemoryActivityLog

  // Assigned in the constructor for Bun coverage; see MemoryApiKeyRepository.
  constructor(activityLog: MemoryActivityLog = new MemoryActivityLog()) {
    this.#records = new Map()
    this.#activityLog = activityLog
  }

  /** The stored proposal, when it is this environment's. */
  #own(environmentId: string, id: string): ProposalRecord | null {
    const record = this.#records.get(id)
    return record && record.environmentId === environmentId ? record : null
  }

  /** @inheritdoc */
  async list(environmentId: string, limit: number): Promise<ProposalRecord[]> {
    return [...this.#records.values()]
      .filter((record) => record.environmentId === environmentId)
      .sort(newestFirst)
      .slice(0, limit)
      .map((record) => structuredClone(record))
  }

  /** @inheritdoc */
  async find(environmentId: string, id: string): Promise<ProposalRecord | null> {
    const record = this.#own(environmentId, id)
    return record && structuredClone(record)
  }

  /** @inheritdoc */
  async findPending(
    environmentId: string,
    like: Pick<ProposalRecord, 'operation' | 'targetType' | 'targetId' | 'proposedBy'>,
    at: Date
  ): Promise<ProposalRecord | null> {
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
    return record ? structuredClone(record) : null
  }

  /** @inheritdoc */
  async insert(record: ProposalRecord, recorded: Recorded): Promise<ProposalRecord> {
    const activity = activityOf(recorded)
    if (this.#records.has(record.id)) {
      throw new Error('duplicate proposal id')
    }
    this.#records.set(record.id, structuredClone(record))
    this.#activityLog.record(activity ? [activity] : [])
    return structuredClone(record)
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
    const record = this.#own(environmentId, id)
    // The compare of the compare-and-set, as the Postgres statement makes it.
    if (!record || record.status !== 'pending' || record.expiresAt.getTime() <= at.getTime()) {
      return null
    }
    const next: ProposalRecord = {
      ...record,
      status: 'approved',
      approvedByType: approval.type,
      approvedById: approval.id,
      approvedAt: new Date(at),
      updatedAt: new Date(at),
    }
    this.#records.set(id, next)
    this.#activityLog.record(activity ? [activity] : [])
    return structuredClone(next)
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
    const record = this.#own(environmentId, id)
    if (!record || record.status !== 'approved') {
      return null
    }
    const next: ProposalRecord = {
      ...record,
      status: outcome.status,
      failureReason: outcome.status === 'failed' ? outcome.reason : null,
      updatedAt: new Date(at),
    }
    this.#records.set(id, next)
    this.#activityLog.record(activity ? [activity] : [])
    return structuredClone(next)
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
