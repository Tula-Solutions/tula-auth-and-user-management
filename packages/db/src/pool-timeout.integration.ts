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
    const started = performance.now()
    const failure = await handle
      .withAdvisoryLock(key, () => handle.db.execute(sql`select 1`))
      .then(
        () => null,
        (error: unknown) => error
      )
    // Drizzle wraps the driver's error ("Failed query: …"); the pool's timeout is its cause.
    const cause = failure instanceof Error ? failure.cause : undefined
    expect(cause instanceof Error ? cause.message : String(failure)).toMatch(/timeout/i)
    expect(performance.now() - started).toBeLessThan(5000)
  } finally {
    await handle.close()
  }
})
