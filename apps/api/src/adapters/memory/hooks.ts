import type { HookFailureReason, HookPoint } from '@tula/contract'
import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { activityOf, type Recorded } from '~/ports/activity-log'
import type { HookChanges, HookExpectation, HookRecord, HookStore } from '~/ports/hook-store'

/** In-memory hooks for tests. */
export class MemoryHookStore implements HookStore {
  readonly #records: Map<string, HookRecord>
  readonly #activityLog: MemoryActivityLog

  // Assigned in the constructor for Bun coverage; see MemoryApiKeyRepository.
  constructor(activityLog: MemoryActivityLog = new MemoryActivityLog()) {
    this.#records = new Map()
    this.#activityLog = activityLog
  }

  /** The stored hook, when it is this environment's and still what the caller read. */
  #expected(environmentId: string, id: string, expected?: HookExpectation): HookRecord | null {
    const record = this.#records.get(id)
    if (!record || record.environmentId !== environmentId) {
      return null
    }
    const same =
      !expected ||
      (record.enabled === expected.enabled && record.failureMode === expected.failureMode)
    return same ? record : null
  }

  /** @inheritdoc */
  async list(environmentId: string): Promise<HookRecord[]> {
    return [...this.#records.values()]
      .filter((record) => record.environmentId === environmentId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
      .map((record) => structuredClone(record))
  }

  /** @inheritdoc */
  async find(environmentId: string, id: string): Promise<HookRecord | null> {
    const record = this.#expected(environmentId, id)
    return record && structuredClone(record)
  }

  /** @inheritdoc */
  async findByPoint(environmentId: string, point: HookPoint): Promise<HookRecord | null> {
    const record = [...this.#records.values()].find(
      (one) => one.environmentId === environmentId && one.point === point
    )
    return record ? structuredClone(record) : null
  }

  /** @inheritdoc */
  async insert(record: HookRecord, recorded: Recorded): Promise<HookRecord | null> {
    const activity = activityOf(recorded)
    // The primary key and the one-per-point key, as Postgres would decide them.
    const taken = [...this.#records.values()].some(
      (one) =>
        one.id === record.id ||
        (one.environmentId === record.environmentId && one.point === record.point)
    )
    if (taken) {
      return null
    }
    this.#records.set(record.id, structuredClone(record))
    this.#activityLog.record(activity ? [activity] : [])
    return structuredClone(record)
  }

  /** @inheritdoc */
  async update(
    environmentId: string,
    id: string,
    expected: HookExpectation,
    changes: HookChanges,
    updatedAt: Date,
    recorded: Recorded
  ): Promise<HookRecord | null> {
    const activity = activityOf(recorded)
    const record = this.#expected(environmentId, id, expected)
    if (!record) {
      return null
    }
    const next: HookRecord = {
      ...record,
      url: changes.url ?? record.url,
      enabled: changes.enabled ?? record.enabled,
      deadlineMs: changes.deadlineMs ?? record.deadlineMs,
      failureMode: changes.failureMode ?? record.failureMode,
      updatedAt,
    }
    this.#records.set(id, next)
    this.#activityLog.record(activity ? [activity] : [])
    return structuredClone(next)
  }

  /** @inheritdoc */
  async delete(
    environmentId: string,
    id: string,
    expected: HookExpectation,
    recorded: Recorded
  ): Promise<boolean> {
    const activity = activityOf(recorded)
    const deleted = this.#expected(environmentId, id, expected) !== null && this.#records.delete(id)
    this.#activityLog.record(deleted && activity ? [activity] : [])
    return deleted
  }

  /** @inheritdoc */
  async noteFailure(
    environmentId: string,
    id: string,
    at: Date,
    reason: HookFailureReason
  ): Promise<void> {
    const record = this.#expected(environmentId, id)
    if (record) {
      record.lastFailedAt = new Date(at)
      record.lastFailureReason = reason
    }
  }
}
