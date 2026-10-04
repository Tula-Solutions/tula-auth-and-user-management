import { fileURLToPath } from 'node:url'
import journal from '../migrations/meta/_journal.json'

/** Absolute path of the committed SQL migrations. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url))

/**
 * Migrator options shared by every driver. History stays in Drizzle's default
 * `drizzle.__drizzle_migrations`: outside the `tula` schema (which migration 0000 creates) and
 * unreachable by the `tula_app` role, which has no USAGE on the `drizzle` schema. The one thing
 * the API may learn from it is when each applied migration was generated, through the
 * `tula.applied_migrations()` function (migration 0014): that is how its diagnostics tell
 * whether the database is migrated to what the image ships.
 */
export const MIGRATION_CONFIG = { migrationsFolder: MIGRATIONS_FOLDER } as const

/**
 * One committed migration, as the journal lists it.
 *
 * @example
 * ```ts
 * const last: ShippedMigration | undefined = SHIPPED_MIGRATIONS.at(-1)
 * ```
 */
export interface ShippedMigration {
  /** The file's name without `.sql`, e.g. `0013_settings_managed_by`. */
  tag: string
  /** When it was generated (ms). Drizzle stores this as the applied row's `created_at`. */
  when: number
}

/**
 * The migrations this build ships, oldest first. Compared with the rows of
 * `drizzle.__drizzle_migrations` to tell whether a database is behind (or ahead of) the code.
 *
 * @example
 * ```ts
 * const behind = applied.length < SHIPPED_MIGRATIONS.length
 * ```
 */
export const SHIPPED_MIGRATIONS: readonly ShippedMigration[] = journal.entries.map((entry) => ({
  tag: entry.tag,
  when: entry.when,
}))
