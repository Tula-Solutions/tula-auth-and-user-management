import type { EnvironmentSettings } from '@tula/contract'
import {
  type Database,
  environmentSettings,
  environments,
  TENANT_SETTING,
  withTenant,
} from '@tula/db'
import { and, eq, sql } from 'drizzle-orm'
import { recordActivity } from '~/adapters/postgres/activity'
import { readStoredRow, storedOrigins } from '~/adapters/stored-settings'
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
    return row ? readStoredRow(environmentId, row) : null
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
      return readStoredRow(environmentId, row)
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
        for (const origin of rows.flatMap((row) => storedOrigins(row.settings))) {
          origins.add(origin)
        }
      }
    })
    return [...origins]
  }
}
