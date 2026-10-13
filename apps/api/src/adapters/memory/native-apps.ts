import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { activityOf, type Recorded } from '~/ports/activity-log'
import type {
  NativeAppChanges,
  NativeAppExpectation,
  NativeAppRecord,
  NativeAppStore,
} from '~/ports/native-app-store'

/** Whether two lists hold the same strings in the same order. */
function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/** In-memory native apps for tests. */
export class MemoryNativeAppStore implements NativeAppStore {
  readonly #records: Map<string, NativeAppRecord>
  readonly #activityLog: MemoryActivityLog

  // Assigned in the constructor for Bun coverage; see MemoryApiKeyRepository.
  constructor(activityLog: MemoryActivityLog = new MemoryActivityLog()) {
    this.#records = new Map()
    this.#activityLog = activityLog
  }

  /** The stored app, when it is this environment's. */
  #own(environmentId: string, id: string): NativeAppRecord | null {
    const record = this.#records.get(id)
    return record && record.environmentId === environmentId ? record : null
  }

  /** @inheritdoc */
  async list(environmentId: string): Promise<NativeAppRecord[]> {
    return [...this.#records.values()]
      .filter((record) => record.environmentId === environmentId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
      .map((record) => structuredClone(record))
  }

  /** @inheritdoc */
  async find(environmentId: string, id: string): Promise<NativeAppRecord | null> {
    const record = this.#own(environmentId, id)
    return record && structuredClone(record)
  }

  /** @inheritdoc */
  async insert(record: NativeAppRecord, recorded: Recorded): Promise<NativeAppRecord | null> {
    const activity = activityOf(recorded)
    // The primary key and the one-per-platform-and-identifier key, as Postgres would decide them.
    const taken = [...this.#records.values()].some(
      (one) =>
        one.id === record.id ||
        (one.environmentId === record.environmentId &&
          one.platform === record.platform &&
          one.identifier === record.identifier)
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
    expected: NativeAppExpectation,
    changes: NativeAppChanges,
    updatedAt: Date,
    recorded: Recorded
  ): Promise<NativeAppRecord | null> {
    const activity = activityOf(recorded)
    const record = this.#own(environmentId, id)
    if (
      !record ||
      record.teamId !== expected.teamId ||
      !sameList(record.sha256CertFingerprints, expected.sha256CertFingerprints) ||
      !sameList(record.appLinkPaths, expected.appLinkPaths)
    ) {
      return null
    }
    const next: NativeAppRecord = {
      ...record,
      teamId: changes.teamId ?? record.teamId,
      sha256CertFingerprints: changes.sha256CertFingerprints
        ? [...changes.sha256CertFingerprints]
        : record.sha256CertFingerprints,
      appLinkPaths: changes.appLinkPaths ? [...changes.appLinkPaths] : record.appLinkPaths,
      updatedAt,
    }
    this.#records.set(id, next)
    this.#activityLog.record(activity ? [activity] : [])
    return structuredClone(next)
  }

  /** @inheritdoc */
  async delete(environmentId: string, id: string, recorded: Recorded): Promise<boolean> {
    const activity = activityOf(recorded)
    const deleted = this.#own(environmentId, id) !== null && this.#records.delete(id)
    this.#activityLog.record(deleted && activity ? [activity] : [])
    return deleted
  }
}
