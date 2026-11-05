import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { MIGRATION_CONFIG, migrationUrl } from '../migrate'

// Migrations run as the schema owner (DATABASE_MIGRATION_URL), not the API's runtime role.
const chosen = migrationUrl(process.env)
if (!chosen) {
  process.stderr.write('db:migrate: set DATABASE_MIGRATION_URL (or DATABASE_URL)\n')
  process.exit(1)
}

if (chosen.fellBack) {
  process.stderr.write(
    'db:migrate: DATABASE_MIGRATION_URL is not set; using DATABASE_URL, the runtime role, which cannot change the schema. Set DATABASE_MIGRATION_URL to the schema owner.\n'
  )
}
const pool = new Pool({ connectionString: chosen.url, max: 1 })
try {
  await migrate(drizzle(pool), MIGRATION_CONFIG)
  process.stdout.write('db:migrate: up to date\n')
} catch (error) {
  if (chosen.fellBack) {
    process.stderr.write('db:migrate: failed after falling back to DATABASE_URL (see above)\n')
  }
  throw error
} finally {
  await pool.end()
}
