import { readStoredEnvironmentSettings, WebOriginSchema } from '@tula/contract'
import { readStoredManager } from '~/adapters/settings-manager'
import * as logger from '~/lib/logger'
import type { StoredEnvironmentSettings } from '~/ports/environment-settings-store'

/** A settings row as a store holds it: free-form JSON in two of its three columns. */
export interface StoredSettingsRow {
  revision: number
  /** The document, as stored: possibly another version's, or changed by hand. */
  settings: unknown
  /** The managing tool's record, as stored. */
  managedBy: unknown
}

/**
 * A stored settings row as a store answers it. **Every adapter reads a row through this
 * function**, the memory one included, so that a unit test is handed what a deployment's
 * store would hand on: never a document the real read would have altered or refused.
 *
 * The document goes through the contract's tolerant read (`readStoredEnvironmentSettings`):
 * it may predate a field this version added, or hold a list entry or a wording this version
 * would not accept. Settings are read on the request path, so such an entry is left out
 * rather than allowed to fail every request of the environment, and what was left out is
 * said in the log by count or by kind, never by its text. The managing tool's record goes
 * through `readStoredManager`.
 *
 * @param environmentId - The environment the row belongs to, for the log.
 * @param row - The row.
 * @returns The settings this version reads from it.
 * @throws ZodError when a known field other than a list entry or a wording holds a value
 *   that is not valid (a scalar changed by hand). Nothing the API stores can do that; what
 *   reads the settings has to stand it all the same.
 */
export function readStoredRow(
  environmentId: string,
  row: StoredSettingsRow
): StoredEnvironmentSettings {
  const {
    settings,
    dropped,
    droppedEmailTemplates,
    unknownEmailTemplates,
    droppedSmsTemplates,
    unknownSmsTemplates,
  } = readStoredEnvironmentSettings(row.settings)
  if (droppedSmsTemplates.length > 0 || unknownSmsTemplates > 0) {
    // By kind, as for an email's: never a template's text, never an unknown kind's key.
    logger.warn(
      'stored text message template this version cannot use was ignored; the built-in text is sent in its place',
      { environmentId, kinds: droppedSmsTemplates, unknownKinds: unknownSmsTemplates }
    )
  }
  if (droppedEmailTemplates.length > 0 || unknownEmailTemplates > 0) {
    // By kind, which is one of the contract's fixed names: never a template's text, and
    // never the key of a kind this version does not know (a count instead). A kind is named
    // when either of its parts was left out; the other part is still used.
    logger.warn(
      'stored email template text this version cannot use was ignored; the built-in copy is sent in its place',
      { environmentId, kinds: droppedEmailTemplates, unknownKinds: unknownEmailTemplates }
    )
  }
  if (dropped > 0) {
    // The count only: an origin or URL is the tenant's data, not something for the log.
    logger.warn(
      'stored environment settings held list entries that are not valid; they were ignored',
      { environmentId, dropped }
    )
  }
  // The column is free-form JSON: only a record the answer's own schema accepts is passed on.
  const managedBy = readStoredManager(environmentId, row.managedBy)
  return { revision: row.revision, settings, ...(managedBy && { managedBy }) }
}

/**
 * The usable origins of one stored document, whatever shape another version left it in.
 *
 * Read apart from {@link readStoredRow}, on purpose: the union of every environment's origins
 * answers preflights, and one document that cannot be read must not take it down.
 *
 * @param settings - The stored document.
 * @returns Its `urls.allowedOrigins` entries that are valid origins.
 */
export function storedOrigins(settings: unknown): string[] {
  const urls = (settings as { urls?: { allowedOrigins?: unknown } } | null)?.urls
  const origins: unknown[] = Array.isArray(urls?.allowedOrigins) ? urls.allowedOrigins : []
  return origins.filter((origin): origin is string => WebOriginSchema.safeParse(origin).success)
}
