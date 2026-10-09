import {
  type EnvironmentSettings,
  readStoredEnvironmentSettings,
  WebOriginSchema,
} from '@tula/contract'
import {
  type Database,
  environmentSettings,
  environments,
  TENANT_SETTING,
  withTenant,
} from '@tula/db'
import { and, eq, sql } from 'drizzle-orm'
import { recordActivity } from '~/adapters/postgres/activity'
import { readStoredManager } from '~/adapters/settings-manager'
import * as logger from '~/lib/logger'
import type { Activity } from '~/ports/activity-log'
import type {
  EnvironmentSettingsStore,
  SettingsManagerInput,
  StoredEnvironmentSettings,
} from '~/ports/environment-settings-store'

const columns = {
  revision: environmentSettings.revision,
  settings: environmentSettings.settings,
  managedBy: environmentSettings.managedBy,
}

function toStored(
  environmentId: string,
  row: { revision: number; settings: unknown; managedBy: unknown }
): StoredEnvironmentSettings {
  // Parsed on the way out as well: the document may predate a field this version added, or
  // hold a list entry this version would not accept. Settings are read on the request path,
  // so such an entry is left out rather than allowed to fail every request of the environment.
  const { settings, dropped, droppedEmailTemplates, unknownEmailTemplates } =
    readStoredEnvironmentSettings(row.settings)
  if (droppedEmailTemplates.length > 0 || unknownEmailTemplates > 0) {
    // By kind, which is one of the contract's fixed names: never a template's text, and
    // never the key of a kind this version does not know (a count instead).
    logger.warn(
      'stored email templates this version cannot use were ignored; the built-in copy is sent',
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

/** The usable origins of one stored document, whatever shape another version left it in. */
function originsOf(settings: unknown): string[] {
  const urls = (settings as { urls?: { allowedOrigins?: unknown } } | null)?.urls
  const origins: unknown[] = Array.isArray(urls?.allowedOrigins) ? urls.allowedOrigins : []
  return origins.filter((origin): origin is string => WebOriginSchema.safeParse(origin).success)
}

/**
 * Environment settings in `tula.environment_settings`, read and written inside the
 * environment's RLS scope.
 */
export class PostgresEnvironmentSettingsStore implements EnvironmentSettingsStore {
  /** @param db - Database connected as the runtime role. */
  constructor(private readonly db: Database) {}

  /** @inheritdoc */
  async get(environmentId: string): Promise<StoredEnvironmentSettings | null> {
    const [row] = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select(columns)
        .from(environmentSettings)
        .where(eq(environmentSettings.environmentId, environmentId))
        .limit(1)
    )
    return row ? toStored(environmentId, row) : null
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
    // `undefined` leaves the column out of the update (the manager on record is kept), `null`
    // clears it, and a named manager is stored with this write's time and revision.
    const managedBy =
      manager === undefined
        ? undefined
        : manager === null
          ? null
          : { ...manager, at: at.toISOString(), revision: expectedRevision + 1 }
    return withTenant(this.db, environmentId, async (tx) => {
      // Revision 0 means "no row yet": the unique key on environment_id decides which of two
      // first writers wins. Afterwards the guarded update does.
      const [row] =
        expectedRevision === 0
          ? await tx
              .insert(environmentSettings)
              .values({
                projectId: activity.projectId,
                environmentId,
                settings,
                revision: 1,
                managedBy: managedBy ?? null,
                createdAt: at,
                updatedAt: at,
              })
              .onConflictDoNothing({ target: environmentSettings.environmentId })
              .returning(columns)
          : await tx
              .update(environmentSettings)
              .set({
                settings,
                revision: expectedRevision + 1,
                updatedAt: at,
                ...(managedBy !== undefined && { managedBy }),
              })
              .where(
                and(
                  eq(environmentSettings.environmentId, environmentId),
                  eq(environmentSettings.revision, expectedRevision)
                )
              )
              .returning(columns)
      if (!row) {
        return null
      }
      await recordActivity(tx, [activity])
      return toStored(environmentId, row)
    })
  }

  /** @inheritdoc */
  async allowedOrigins(): Promise<string[]> {
    // Row-level security shows one environment's row at a time, so the union is read by
    // visiting each environment in turn inside one transaction. `environments` itself is a
    // control-plane table without RLS. The caller caches the result (`cacheEnvironmentSettings`).
    const ids = await this.db.select({ id: environments.id }).from(environments)
    const origins = new Set<string>()
    await this.db.transaction(async (tx) => {
      for (const { id } of ids) {
        await tx.execute(sql`select set_config(${TENANT_SETTING}, ${id}, true)`)
        const rows = await tx
          .select({ settings: environmentSettings.settings })
          .from(environmentSettings)
        for (const origin of rows.flatMap((row) => originsOf(row.settings))) {
          origins.add(origin)
        }
      }
    })
    return [...origins]
  }
}
