import { afterAll, beforeAll, expect, test } from 'bun:test'
import { SMS_COUNT_RETENTION_FLOOR_DAYS, smsCodeCounts, withTenant } from '@tula/db'
import { createTestDatabase, createTestTenant, type TestDatabase } from '@tula/db/testing'
import { sql } from 'drizzle-orm'
import { PostgresSmsUsageStore, SMS_DAY_LOCK_WAIT_MS } from '~/adapters/postgres/sms-usage'
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

test('counting at once loses nothing', async () => {
  const tenant = await createTestTenant(testDb.db)
  const store = new PostgresSmsUsageStore(testDb.db)
  const at = new Date('2026-10-08T12:00:00.000Z')
  await Promise.all(
    Array.from({ length: 8 }, () => store.takeFromDay(tenant, '2026-10-08', '+1', 1000, at))
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
  expect(await store.takeFromDay(a, '2026-10-08', '+1', 10, new Date())).toBe(true)
  const seen = await withTenant(testDb.db, b.environmentId, (tx) => tx.select().from(smsCodeCounts))
  expect(seen).toEqual([])
  expect(await testDb.db.select().from(smsCodeCounts)).toEqual([])
})

/** The UTC day `days` days before today, as `YYYY-MM-DD`. */
const daysAgo = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)

test('the database keeps the last week whatever day the delete is given: today’s count cannot be erased', async () => {
  const tenant = await createTestTenant(testDb.db)
  const store = new PostgresSmsUsageStore(testDb.db)
  const at = new Date()
  const today = daysAgo(0)
  for (const day of [today, daysAgo(SMS_COUNT_RETENTION_FLOOR_DAYS), daysAgo(40)]) {
    expect(await store.takeFromDay(tenant, day, '+1', 1, at)).toBe(true)
  }
  // A cutoff far in the future: everything, as far as the statement is concerned.
  expect(await store.deleteBefore(tenant.environmentId, '2999-01-01', 100)).toBe(1)
  expect(await store.sentOn(tenant.environmentId, daysAgo(40))).toBe(0)
  expect(await store.sentOn(tenant.environmentId, daysAgo(SMS_COUNT_RETENTION_FLOOR_DAYS))).toBe(1)
  // The day is still spent.
  expect(await store.sentOn(tenant.environmentId, today)).toBe(1)
  expect(await store.takeFromDay(tenant, today, '+1', 1, at)).toBe(false)
})

test('a take is one transaction: a count that cannot be written leaves nothing behind, and the next take has its turn', async () => {
  const tenant = await createTestTenant(testDb.db)
  const store = new PostgresSmsUsageStore(testDb.db)
  const at = new Date('2026-10-08T12:00:00.000Z')
  // A project that is not the environment's: the insert fails after the lock was taken.
  const wrong = { projectId: Bun.randomUUIDv7(), environmentId: tenant.environmentId }
  const failed = await store.takeFromDay(wrong, '2026-10-08', '+1', 5, at).then(
    () => 'taken',
    () => 'failed'
  )
  expect(failed).toBe('failed')
  expect(await store.sentOn(tenant.environmentId, '2026-10-08')).toBe(0)
  // The lock went with the rollback.
  expect(await store.takeFromDay(tenant, '2026-10-08', '+1', 5, at)).toBe(true)
})

test('the wait for a turn is this transaction’s only: the connection’s lock_timeout is as it was', async () => {
  const tenant = await createTestTenant(testDb.db)
  const store = new PostgresSmsUsageStore(testDb.db)
  expect(await store.takeFromDay(tenant, '2026-10-08', '+1', 5, new Date())).toBe(true)
  const { rows } = (await testDb.db.execute(
    sql`select current_setting('lock_timeout') as wait`
  )) as {
    rows: { wait: string }[]
  }
  expect(rows[0]?.wait).toBe('0')
  expect(SMS_DAY_LOCK_WAIT_MS).toBe(5000)
})
