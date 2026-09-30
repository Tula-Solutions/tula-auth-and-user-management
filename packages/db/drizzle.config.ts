import { defineConfig } from 'drizzle-kit'

/** Migration settings shared by drizzle-kit and the runtime migrator (see `src/migrate.ts`). */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  schemaFilter: ['tula'],
  dbCredentials: {
    url: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
})
