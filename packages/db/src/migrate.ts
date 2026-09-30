import { fileURLToPath } from 'node:url'

/** Absolute path of the committed SQL migrations. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url))

/**
 * Migrator options shared by every driver. History stays in Drizzle's default
 * `drizzle.__drizzle_migrations`: outside the `tula` schema (which migration 0000 creates) and
 * unreachable by the `tula_app` role, which has no USAGE on the `drizzle` schema.
 */
export const MIGRATION_CONFIG = { migrationsFolder: MIGRATIONS_FOLDER } as const
