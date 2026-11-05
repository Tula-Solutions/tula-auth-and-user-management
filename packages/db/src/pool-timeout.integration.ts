import { expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { ADVISORY_LOCK_NAMESPACE } from './advisory-lock'
import { createDatabase } from './client'

const runtimeUrl = process.env.DATABASE_URL
if (!runtimeUrl) {
  throw new Error('Integration tests need DATABASE_URL (see .env.example)')
}

test('a lock holder whose work needs a second connection from an exhausted pool fails, not hangs (H-230)', async () => {
  const handle = createDatabase(runtimeUrl, { max: 1, connectionTimeoutMillis: 300 })
  try {
    const key: [number, number] = [ADVISORY_LOCK_NAMESPACE, 2_000_000 + (Date.now() % 1_000_000)]
    await expect(
      handle.withAdvisoryLock(key, () => handle.db.execute(sql`select 1`))
    ).rejects.toThrow(/timeout/i)
  } finally {
    await handle.close()
  }
})
