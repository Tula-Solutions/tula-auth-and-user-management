import type { EnvironmentSettings } from '@tula/contract'
import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { readStoredManager } from '~/adapters/settings-manager'
import { readStoredRow, type StoredSettingsRow, storedOrigins } from '~/adapters/stored-settings'
import type { Activity } from '~/ports/activity-log'
import type {
  EnvironmentSettingsStore,
  SettingsManagerInput,
  StoredEnvironmentSettings,
} from '~/ports/environment-settings-store'

/**
 * A document as a JSON column would hold it: `undefined` keys gone, `NaN` and the infinities
 * `null`. What a test seeds is then what a database would have kept of it.
 */
function asJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null))
}

/** A row as the memory store keeps it. */
interface MemorySettingsRow extends StoredSettingsRow {
  /** Seeded through `seedUnread`: handed on as it is, past the tolerant read. */
  unread: boolean
}

/**
 * In-memory environment settings.
 *
 * It keeps a row as a database would (free-form JSON) and **reads it as the Postgres adapter
 * does**, through `readStoredRow`: fields added since take their defaults, a list entry or a
 * wording this version would not accept is left out and said in the log, and a scalar that is
 * not valid makes the read throw. The shared suite holds the two adapters to the same answer
 * for the same stored document. The one exception is
 * {@link MemoryEnvironmentSettingsStore.seedUnread}.
 */
export class MemoryEnvironmentSettingsStore implements EnvironmentSettingsStore {
  readonly #documents: Map<string, MemorySettingsRow>
  readonly #activityLog: MemoryActivityLog

  // Assigned in the constructor for Bun coverage; see MemoryApiKeyRepository.
  /** @param activityLog - Where activity is recorded; shared with the other memory stores. */
  constructor(activityLog: MemoryActivityLog = new MemoryActivityLog()) {
    this.#documents = new Map()
    this.#activityLog = activityLog
  }

  /**
   * Put a row in the store directly, without a revision check or an audit entry: an
   * environment in a state the admin API refuses to create, or a document another version, or
   * a hand, left behind. The document is kept as a JSON column would keep it, and **read as
   * a real store reads it**: what the tolerant read leaves out or defaults is left out or
   * defaulted, and a document it cannot read makes {@link get} throw.
   *
   * @param environmentId - The environment.
   * @param stored - The row: its revision, the document as it would sit in the column
   *   (anything JSON holds) and, optionally, the managing tool's record.
   */
  seed(
    environmentId: string,
    stored: { revision: number; settings: unknown; managedBy?: unknown }
  ): void {
    this.#documents.set(environmentId, {
      revision: stored.revision,
      settings: asJson(stored.settings),
      managedBy: asJson(stored.managedBy),
      unread: false,
    })
  }

  /**
   * Put a document in the store that {@link get} hands on **as it is, past the tolerant
   * read**. No real store can do this: Postgres passes every row through `readStoredRow`,
   * which would have left out, defaulted or refused what this hands on.
   *
   * It exists for one kind of test: one whose subject is a service's **own** defence against
   * a document the store's read should already have cleaned (the renderer replacing a
   * wording that no longer passes with the built-in copy, say), which only a raw document can
   * reach. A test of what a deployment does with a stored document uses {@link seed}.
   *
   * @param environmentId - The environment.
   * @param stored - The document and its revision, handed on unjudged.
   */
  seedUnread(environmentId: string, stored: StoredEnvironmentSettings): void {
    this.#documents.set(environmentId, {
      revision: stored.revision,
      settings: structuredClone(stored.settings),
      managedBy: structuredClone(stored.managedBy),
      unread: true,
    })
  }

  /**
   * Put a managing-tool record on a stored document directly, whatever its shape. Tests use it
   * to stand in for a record another version, or a hand, left in the database.
   *
   * @param environmentId - The environment; it must have a stored document.
   * @param manager - The record, as it would sit in the column.
   */
  seedManager(environmentId: string, manager: unknown): void {
    const stored = this.#documents.get(environmentId)
    if (stored) {
      this.#documents.set(environmentId, { ...stored, managedBy: structuredClone(manager) })
    }
  }

  /** @inheritdoc */
  async get(environmentId: string): Promise<StoredEnvironmentSettings | null> {
    const stored = this.#documents.get(environmentId)
    return stored ? this.#read(environmentId, stored) : null
  }

  /**
   * A stored row as the store answers it: read as the Postgres adapter reads one, and a copy,
   * so that a caller cannot change what is stored through what it was given.
   */
  #read(environmentId: string, stored: MemorySettingsRow): StoredEnvironmentSettings {
    if (stored.unread) {
      const managedBy = readStoredManager(environmentId, stored.managedBy)
      return {
        revision: stored.revision,
        settings: structuredClone(stored.settings) as EnvironmentSettings,
        ...(managedBy && { managedBy }),
      }
    }
    return structuredClone(readStoredRow(environmentId, stored))
  }

  /** @inheritdoc */
  async replace(
    environmentId: string,
    expectedRevision: number,
    settings: EnvironmentSettings,
    at: Date,
    activity: Activity,
    manager?: SettingsManagerInput | null
  ): Promise<StoredEnvironmentSettings | null> {
    const current = this.#documents.get(environmentId)
    if ((current?.revision ?? 0) !== expectedRevision) {
      return null
    }
    const revision = expectedRevision + 1
    const managedBy =
      manager === undefined
        ? current?.managedBy
        : manager === null
          ? undefined
          : { ...manager, at: at.toISOString(), revision }
    const stored: MemorySettingsRow = {
      revision,
      settings: asJson(settings),
      managedBy: managedBy === undefined ? null : structuredClone(managedBy),
      unread: false,
    }
    this.#documents.set(environmentId, stored)
    this.#activityLog.record([activity])
    return this.#read(environmentId, stored)
  }

  /** @inheritdoc */
  async allowedOrigins(): Promise<string[]> {
    const origins = new Set<string>()
    for (const { settings } of this.#documents.values()) {
      for (const origin of storedOrigins(settings)) {
        origins.add(origin)
      }
    }
    return [...origins]
  }
}
