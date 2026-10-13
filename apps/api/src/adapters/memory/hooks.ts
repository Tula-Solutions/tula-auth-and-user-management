import type { HookFailureReason, HookOutcome, HookPoint } from '@tula-tech/contract'
import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { activityOf, type Recorded } from '~/ports/activity-log'
import {
  type HookCallCount,
  type HookChanges,
  type HookExpectation,
  type HookRecord,
  type HookStore,
  hourOf,
} from '~/ports/hook-store'

/** In-memory hooks for tests. */
export class MemoryHookStore implements HookStore {
  readonly #records: Map<string, HookRecord>
  /** Keyed by hook, hour and outcome, as the table's unique key is. */
  readonly #counts: Map<string, HookCallCount & { environmentId: string }>
  readonly #activityLog: MemoryActivityLog

  // Assigned in the constructor for Bun coverage; see MemoryApiKeyRepository.
  constructor(activityLog: MemoryActivityLog = new MemoryActivityLog()) {
    this.#records = new Map()
    this.#counts = new Map()
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
    if (deleted) {
      // The counts go with their hook, as the foreign key's cascade does it.
      for (const [key, count] of this.#counts) {
        if (count.hookId === id) {
          this.#counts.delete(key)
        }
      }
    }
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

  /** @inheritdoc */
  async countCall(
    environmentId: string,
    id: string,
    at: Date,
    outcome: HookOutcome
  ): Promise<void> {
    if (!this.#expected(environmentId, id)) {
      return
    }
    const hour = hourOf(at)
    const key = `${id}|${hour.getTime()}|${outcome}`
    const count = this.#counts.get(key)
    if (count) {
      count.calls += 1
      count.lastAt = new Date(Math.max(count.lastAt.getTime(), at.getTime()))
      return
    }
    this.#counts.set(key, {
      environmentId,
      hookId: id,
      hour,
      outcome,
      calls: 1,
      lastAt: new Date(at),
    })
  }

  /** @inheritdoc */
  async callCounts(environmentId: string, since: Date): Promise<HookCallCount[]> {
    return [...this.#counts.values()]
      .filter((count) => count.environmentId === environmentId && count.hour >= since)
      .sort(
        (a, b) =>
          (a.hookId < b.hookId ? -1 : a.hookId > b.hookId ? 1 : 0) ||
          a.hour.getTime() - b.hour.getTime() ||
          (a.outcome < b.outcome ? -1 : 1)
      )
      .map(({ environmentId: _environment, ...count }) => structuredClone(count))
  }

  /** @inheritdoc */
  async deleteCallCountsBefore(
    environmentId: string,
    before: Date,
    limit: number
  ): Promise<number> {
    let deleted = 0
    for (const [key, count] of this.#counts) {
      if (deleted >= limit) {
        break
      }
      if (count.environmentId === environmentId && count.hour < before) {
        this.#counts.delete(key)
        deleted += 1
      }
    }
    return deleted
  }
}
