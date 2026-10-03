import type { EnvironmentSettings } from '@tula/contract'
import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import type { Activity } from '~/ports/activity-log'
import type {
  EnvironmentSettingsStore,
  StoredEnvironmentSettings,
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

  /** @inheritdoc */
  async get(environmentId: string): Promise<StoredEnvironmentSettings | null> {
    const stored = this.#documents.get(environmentId)
    return stored ? structuredClone(stored) : null
  }

  /** @inheritdoc */
  async replace(
    environmentId: string,
    expectedRevision: number,
    settings: EnvironmentSettings,
    _at: Date,
    activity: Activity
  ): Promise<StoredEnvironmentSettings | null> {
    if ((this.#documents.get(environmentId)?.revision ?? 0) !== expectedRevision) {
      return null
    }
    const stored = { revision: expectedRevision + 1, settings: structuredClone(settings) }
    this.#documents.set(environmentId, stored)
    this.#activityLog.record([activity])
    return structuredClone(stored)
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
