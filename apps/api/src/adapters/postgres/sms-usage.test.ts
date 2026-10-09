import { afterAll, beforeAll, expect, test } from 'bun:test'
import { smsCodeCounts, withTenant } from '@tula/db'
import { createTestDatabase, createTestTenant, type TestDatabase } from '@tula/db/testing'
import { PostgresSmsUsageStore } from '~/adapters/postgres/sms-usage'
import { describeSmsUsageStore } from '~/adapters/sms-usage-store.suite'

// PGlite: real Postgres with every migration, connected as the runtime role (RLS applies).
let testDb: TestDatabase

beforeAll(async () => {
  testDb = await createTestDatabase()
})

afterAll(() => testDb.close())

describeSmsUsageStore('Postgres', async () => {
  const a = await createTestTenant(testDb.db)
  const b = await createTestTenant(testDb.db, 'production')
  return {
    store: new PostgresSmsUsageStore(testDb.db),
    a: { projectId: a.projectId, environmentId: a.environmentId },
    b: { projectId: b.projectId, environmentId: b.environmentId },
  }
})

test('counting at once loses nothing: each count is one statement', async () => {
  const tenant = await createTestTenant(testDb.db)
  const store = new PostgresSmsUsageStore(testDb.db)
  const at = new Date('2026-10-08T12:00:00.000Z')
  await Promise.all(
    Array.from({ length: 8 }, () => store.recordSent(tenant, '2026-10-08', '+1', at))
  )
  await Promise.all(
    Array.from({ length: 12 }, () => store.recordUsed(tenant.environmentId, '2026-10-08', '+1', at))
  )
  expect(await store.summary(tenant.environmentId, '2026-10-08', 5)).toEqual({
    sent: 8,
    used: 8,
    prefixes: [{ prefix: '+1', sent: 8, used: 8 }],
    truncated: false,
  })
})

test('row-level security hides another environment’s counts even from a direct query', async () => {
  const a = await createTestTenant(testDb.db)
  const b = await createTestTenant(testDb.db)
  const store = new PostgresSmsUsageStore(testDb.db)
  await store.recordSent(a, '2026-10-08', '+1', new Date())
  const seen = await withTenant(testDb.db, b.environmentId, (tx) => tx.select().from(smsCodeCounts))
  expect(seen).toEqual([])
  expect(await testDb.db.select().from(smsCodeCounts)).toEqual([])
})
