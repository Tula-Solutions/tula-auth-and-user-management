import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { MIGRATION_CONFIG } from '../migrate'

// Migrations run as the schema owner (DATABASE_MIGRATION_URL), not the API's runtime role.
const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL
if (!url) {
  process.stderr.write('db:migrate: set DATABASE_MIGRATION_URL (or DATABASE_URL)\n')
  process.exit(1)
}

const pool = new Pool({ connectionString: url, max: 1 })
try {
  await migrate(drizzle(pool), MIGRATION_CONFIG)
  process.stdout.write('db:migrate: up to date\n')
} finally {
  await pool.end()
}
