import { integer, jsonb, unique } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import { tenantColumns, tenantConstraints } from '../tenant-columns'
import { tula } from './pg-schema'

/**
 * An environment's settings document (`EnvironmentSettings` in `@tula/contract`): app name,
 * password policy, sign-in methods, allowed origins and redirect URLs, audit retention.
 *
 * At most one row per environment. An environment without a row uses the deployment's
 * defaults, and counts as revision 0.
 */
export const environmentSettings = tula.table(
  'environment_settings',
  {
    id: primaryKey(),
    ...tenantColumns(),
    /** The whole document. Validated by the API on the way in and again on the way out. */
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull(),
    /**
     * Increases by one on every replace. Writers name the revision they read (`If-Match`), so
     * two of them cannot silently overwrite each other.
     */
    revision: integer('revision').notNull().default(1),
    /**
     * The tool that manages these settings from a config file, when one does (ADR 0030):
     * `{ tool, configHash, at, revision }`, written by a replace that names it. Its `revision`
     * is the one that apply produced, so a later `revision` on the row means the settings were
     * changed around the file. `null`: nobody manages them.
     */
    managedBy: jsonb('managed_by').$type<Record<string, unknown>>(),
    ...timestamps(),
  },
  (t) => [
    unique('environment_settings_environment_id_key').on(t.environmentId),
    ...tenantConstraints('environment_settings', t),
  ]
)

/** An environment settings row. */
export type EnvironmentSettingsRow = typeof environmentSettings.$inferSelect
/** Insert shape for an environment settings row. */
export type NewEnvironmentSettingsRow = typeof environmentSettings.$inferInsert
