import { SettingsManagedBySchema } from '@tula/contract'
import * as logger from '~/lib/logger'
import type { StoredSettingsManager } from '~/ports/environment-settings-store'

// The rules of the answer (`managedBy` in `EnvironmentSettingsStateSchema`), minus `drifted`,
// which the service computes. One definition: a record that passes here cannot fail the
// response schema, and one that fails here is never answered.
const StoredManagerSchema = SettingsManagedBySchema.omit({ drifted: true })

/** Environments already warned about, so a record that stays wrong is said once, not per read. */
const warned = new Set<string>()
/** Enough for any real deployment; past it the warning repeats rather than the set growing. */
const MAX_WARNED = 10_000

/**
 * The managing tool on a stored settings row, if it is a record this version would answer.
 *
 * The column is free-form JSON another version, or a hand, may have written. The marker is
 * advice for a dashboard and `tula diff`, and it is read wherever settings are read, so a
 * record that does not pass the answer's own rules counts as "not managed" instead of failing
 * the read, or the answer of a replace that has already been committed. Every adapter reads
 * the column through this function.
 *
 * @param environmentId - The environment the row belongs to, for the warning.
 * @param value - The stored record: an object, `null`, or anything else.
 * @returns The record, or `undefined` when there is none or it is not valid.
 */
export function readStoredManager(
  environmentId: string,
  value: unknown
): StoredSettingsManager | undefined {
  if (value === null || value === undefined) {
    return undefined
  }
  const parsed = StoredManagerSchema.safeParse(value)
  if (parsed.success) {
    return parsed.data
  }
  if (!warned.has(environmentId)) {
    if (warned.size >= MAX_WARNED) {
      warned.clear()
    }
    warned.add(environmentId)
    // The environment only: the record's content is whatever someone wrote there.
    logger.warn(
      'the stored record of which tool manages the settings is not valid; the settings are treated as unmanaged',
      { environmentId }
    )
  }
  return undefined
}

/** Forget which environments were warned about. For tests. */
export function resetStoredManagerWarnings(): void {
  warned.clear()
}
