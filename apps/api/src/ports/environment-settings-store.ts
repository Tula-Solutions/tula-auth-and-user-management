import type { EnvironmentSettings } from '@tula/contract'
import type { Activity } from '~/ports/activity-log'

/** An environment's saved settings and how many times they have been replaced. */
export interface StoredEnvironmentSettings {
  /** 1 after the first save, one more after each replace. */
  revision: number
  settings: EnvironmentSettings
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
   * @returns The stored settings, or `null` when the revision no longer matched (nothing changed).
   */
  replace(
    environmentId: string,
    expectedRevision: number,
    settings: EnvironmentSettings,
    at: Date,
    activity: Activity
  ): Promise<StoredEnvironmentSettings | null>

  /**
   * Every web origin any environment's saved settings allow, for answering CORS preflights:
   * they carry no API key, so the environment they are for is not known yet.
   *
   * @returns The distinct origins across all environments, in no particular order.
   */
  allowedOrigins(): Promise<string[]>
}
