import { afterAll, expect, test } from 'bun:test'
import { createDatabase } from '@tula-tech/db'
import { assertRuntimeRole } from './runtime-role'

// Uses the runtime login of `docker compose up -d`; the owner login must be refused.
const url = process.env.DATABASE_URL
const migrationUrl = process.env.DATABASE_MIGRATION_URL
if (!url || !migrationUrl) {
  throw new Error(
    'Integration tests need DATABASE_URL and DATABASE_MIGRATION_URL (see .env.example)'
  )
}
const runtime = createDatabase(url, { max: 1 })
const owner = createDatabase(migrationUrl, { max: 1 })
afterAll(async () => {
  await runtime.close()
  await owner.close()
})

test('the runtime login passes the check', async () => {
  await expect(assertRuntimeRole(runtime.db)).resolves.toBeUndefined()
})

test('the schema owner is refused', async () => {
  await expect(assertRuntimeRole(owner.db)).rejects.toThrow('bypasses row-level security')
})
