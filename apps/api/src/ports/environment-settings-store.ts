import type { EnvironmentSettings } from '@tula/contract'
import type { Activity } from '~/ports/activity-log'

/**
 * The tool that manages an environment's settings from a config file, as it is stored: who,
 * which version of the file, when, and the revision that apply produced (ADR 0030).
 */
export interface StoredSettingsManager {
  /** The tool's name, e.g. `tula-apply`. */
  tool: string
  /** The fingerprint of the config it applied. */
  configHash: string
  /** When it applied, as an ISO timestamp. */
  at: string
  /** The settings revision its apply produced. A later revision means the settings drifted. */
  revision: number
}

/** The manager a replace names: its tool and the fingerprint of the config it applies. */
export type SettingsManagerInput = Pick<StoredSettingsManager, 'tool' | 'configHash'>

/** An environment's saved settings and how many times they have been replaced. */
export interface StoredEnvironmentSettings {
  /** 1 after the first save, one more after each replace. */
  revision: number
  settings: EnvironmentSettings
  /** The managing tool on record. Absent when the settings are not managed by one. */
  managedBy?: StoredSettingsManager
}

/**
 * Per-environment settings documents.
 *
 * An environment that never saved settings has no document: {@link EnvironmentSettingsStore.get}
 * answers `null`, which callers treat as revision 0 with the deployment's defaults (see
 * `~/modules/settings/service`).
 */
export interface EnvironmentSettingsStore {
  /**
   * @param environmentId - The environment.
   * @param fresh - `true` to read from the source, past any cache. A writer reads this way
   *   before it replaces, so what it compares with is what is really stored.
   * @returns Its saved settings, or `null` when it has never saved any.
   */
  get(environmentId: string, fresh?: boolean): Promise<StoredEnvironmentSettings | null>

  /**
   * Replace an environment's settings if nobody else has since they were read (compare-and-set).
   *
   * The replace happens only when the stored revision is still `expectedRevision` (0 meaning
   * "nothing saved yet"); the new revision is then `expectedRevision + 1`. Of two writers that
   * read the same revision exactly one succeeds.
   *
   * @param environmentId - The environment.
   * @param expectedRevision - The revision the caller read.
   * @param settings - The whole new document.
   * @param at - When the change is made.
   * @param activity - Recorded in the same transaction, only if the replace happened. Its
   *   `projectId` is the environment's project.
   * @param manager - The managing tool to record with this replace (stored with `at` and the
   *   new revision), `null` to remove the one on record, or left out to keep it as it is: its
   *   revision then stays behind, which is how a change made around the config file shows.
   * @returns The stored settings, or `null` when the revision no longer matched (nothing changed).
   */
  replace(
    environmentId: string,
    expectedRevision: number,
    settings: EnvironmentSettings,
    at: Date,
    activity: Activity,
    manager?: SettingsManagerInput | null
  ): Promise<StoredEnvironmentSettings | null>

  /**
   * Every web origin any environment's saved settings allow, for answering CORS preflights:
   * they carry no API key, so the environment they are for is not known yet.
   *
   * @returns The distinct origins across all environments, in no particular order.
   */
  allowedOrigins(): Promise<string[]>
}
