import type { EnvironmentSettings } from '@tula/contract'
import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { readStoredManager } from '~/adapters/settings-manager'
import type { Activity } from '~/ports/activity-log'
import type {
  EnvironmentSettingsStore,
  SettingsManagerInput,
  StoredEnvironmentSettings,
  StoredSettingsManager,
} from '~/ports/environment-settings-store'

/** In-memory environment settings. */
export class MemoryEnvironmentSettingsStore implements EnvironmentSettingsStore {
  readonly #documents: Map<string, StoredEnvironmentSettings>
  readonly #activityLog: MemoryActivityLog

  // Assigned in the constructor for Bun coverage; see MemoryApiKeyRepository.
  /** @param activityLog - Where activity is recorded; shared with the other memory stores. */
  constructor(activityLog: MemoryActivityLog = new MemoryActivityLog()) {
    this.#documents = new Map()
    this.#activityLog = activityLog
  }

  /**
   * Store a document directly, without a revision check or an audit entry. Tests use it to put
   * an environment in a state the admin API refuses to create.
   *
   * @param environmentId - The environment.
   * @param stored - The document and its revision.
   */
  seed(environmentId: string, stored: StoredEnvironmentSettings): void {
    this.#documents.set(environmentId, structuredClone(stored))
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
      this.#documents.set(environmentId, {
        ...stored,
        managedBy: structuredClone(manager) as StoredSettingsManager,
      })
    }
  }

  /** @inheritdoc */
  async get(environmentId: string): Promise<StoredEnvironmentSettings | null> {
    const stored = this.#documents.get(environmentId)
    return stored ? this.#read(environmentId, stored) : null
  }

  /**
   * A stored document as the store answers it: a copy, with the managing tool only when its
   * record is one the API would answer (the same rule as the Postgres adapter's read).
   */
  #read(environmentId: string, stored: StoredEnvironmentSettings): StoredEnvironmentSettings {
    const managedBy = readStoredManager(environmentId, stored.managedBy)
    return {
      revision: stored.revision,
      settings: structuredClone(stored.settings),
      ...(managedBy && { managedBy }),
    }
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
    const stored: StoredEnvironmentSettings = {
      revision,
      settings: structuredClone(settings),
      ...(managedBy && { managedBy: { ...managedBy } }),
    }
    this.#documents.set(environmentId, stored)
    this.#activityLog.record([activity])
    return this.#read(environmentId, stored)
  }

  /** @inheritdoc */
  async allowedOrigins(): Promise<string[]> {
    const origins = new Set<string>()
    for (const { settings } of this.#documents.values()) {
      for (const origin of settings.urls.allowedOrigins) {
        origins.add(origin)
      }
    }
    return [...origins]
  }
}
