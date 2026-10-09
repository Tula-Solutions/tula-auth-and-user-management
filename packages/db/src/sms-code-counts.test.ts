import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { eq, getTableColumns } from 'drizzle-orm'
import { SMS_COUNT_RETENTION_FLOOR_DAYS, smsCodeCounts } from './schema'
import { withTenant } from './tenant'
import { createTestDatabase, createTestTenant, type TestDatabase, type TestTenant } from './testing'

// `sms_code_counts` (ADR 0037): codes texted and used, by destination prefix and day. What
// the table itself refuses, whatever the API asks of it.

let testDb: TestDatabase
let tenant: TestTenant
let other: TestTenant

beforeAll(async () => {
  testDb = await createTestDatabase()
})

// Fresh tenants for every test: a test cannot clear up after itself, because the runtime
// role cannot delete a recent day's rows (`sms_code_counts_retention_floor`).
beforeEach(async () => {
  tenant = await createTestTenant(testDb.db)
  other = await createTestTenant(testDb.db)
})

afterAll(() => testDb.close())

/** A statement's outcome: Drizzle builders are thenables, not promises. */
async function refused(work: () => Promise<unknown>): Promise<string | null> {
  try {
    await work()
    return null
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause
    return String((cause as { message?: string } | undefined)?.message ?? error)
  }
}

function row(scope: TestTenant, overrides: Partial<typeof smsCodeCounts.$inferInsert> = {}) {
  return {
    id: Bun.randomUUIDv7(),
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    day: '2026-10-08',
    prefix: '+1',
    sent: 1,
    ...overrides,
  }
}

const insert = (scope: TestTenant, overrides: Partial<typeof smsCodeCounts.$inferInsert> = {}) =>
  refused(() =>
    withTenant(testDb.db, scope.environmentId, (tx) =>
      tx.insert(smsCodeCounts).values(row(scope, overrides))
    )
  )

/** The UTC day `days` days before the database's today, as `YYYY-MM-DD`. */
const daysAgo = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)

/** The days the environment has rows for, oldest first. */
const daysOf = async (scope: TestTenant) =>
  (
    await withTenant(testDb.db, scope.environmentId, (tx) =>
      tx.select({ day: smsCodeCounts.day }).from(smsCodeCounts).orderBy(smsCodeCounts.day)
    )
  ).map((found) => found.day)

test.each([
  ['+1', true],
  ['+1242', true],
  // Five digits and more: on the way to being a number.
  ['+14155', false],
  ['+14155550100', false],
  ['141555', false],
  ['+', false],
  ['', false],
  ['+1415a', false],
  ['+1415 5', false],
])('a prefix of %p is stored: %p', async (prefix, accepted) => {
  const outcome = await insert(tenant, { prefix })
  if (accepted) {
    expect(outcome).toBeNull()
  } else {
    expect(outcome).toContain('sms_code_counts_prefix_shape')
  }
})

test('more codes cannot be used than were sent, and neither count goes below zero', async () => {
  expect(await insert(tenant, { sent: 2, used: 2 })).toBeNull()
  for (const counts of [
    { sent: 1, used: 2 },
    { sent: -1, used: 0 },
    { sent: 0, used: -1 },
  ]) {
    expect(await insert(tenant, counts)).toContain('sms_code_counts_bounds')
  }
})

test('one row per environment, day and prefix', async () => {
  expect(await insert(tenant)).toBeNull()
  expect(await insert(tenant)).toContain('sms_code_counts_environment_day_prefix_key')
  expect(await insert(tenant, { day: '2026-10-09' })).toBeNull()
  expect(await insert(tenant, { prefix: '+1242' })).toBeNull()
  // Another environment's counts are its own.
  expect(await insert(other)).toBeNull()
})

test('row-level security keeps one environment’s counts from another', async () => {
  expect(await insert(tenant)).toBeNull()
  const theirs = await withTenant(testDb.db, other.environmentId, (tx) =>
    tx.select().from(smsCodeCounts)
  )
  expect(theirs).toEqual([])
  expect(await testDb.db.select().from(smsCodeCounts)).toEqual([])
  expect(
    await refused(() =>
      withTenant(testDb.db, other.environmentId, (tx) =>
        tx.insert(smsCodeCounts).values(row(tenant))
      )
    )
  ).toContain('row-level security')
})

test('there is no column for a number, or for who asked', () => {
  expect(Object.keys(getTableColumns(smsCodeCounts)).sort()).toEqual(
    [
      'id',
      'projectId',
      'environmentId',
      'day',
      'prefix',
      'sent',
      'used',
      'createdAt',
      'updatedAt',
    ].sort()
  )
})

test('the runtime role counts, and cannot move a count to another day, prefix or environment', async () => {
  expect(await insert(tenant, { sent: 3 })).toBeNull()
  const update = (set: Partial<typeof smsCodeCounts.$inferInsert>) =>
    refused(() =>
      withTenant(testDb.db, tenant.environmentId, (tx) => tx.update(smsCodeCounts).set(set))
    )
  expect(
    await update({ sent: 4, used: 1, updatedAt: new Date('2026-10-08T10:00:00.000Z') })
  ).toBeNull()
  for (const set of [
    { day: '2020-01-01' },
    { prefix: '+44' },
    { id: Bun.randomUUIDv7() },
    { projectId: other.projectId },
    { environmentId: other.environmentId },
    { createdAt: new Date('2020-01-01T00:00:00.000Z') },
  ]) {
    expect(await update(set)).toContain('permission denied')
  }
})

test('a delete that asks for today’s rows, or the last week’s, deletes none of them', async () => {
  const floor = SMS_COUNT_RETENTION_FLOOR_DAYS
  // Yesterday and tomorrow too: whichever side of midnight UTC the database is on.
  const recent = [floor, floor - 1, 1, 0, -1].map(daysAgo)
  const old = [floor + 2, floor + 30].map(daysAgo)
  for (const day of [...old, ...recent]) {
    expect(await insert(tenant, { day, sent: 5 })).toBeNull()
  }
  // Everything, with no condition at all: what a bug or an injected statement would run.
  const deleted = await withTenant(testDb.db, tenant.environmentId, (tx) =>
    tx.delete(smsCodeCounts).returning({ day: smsCodeCounts.day })
  )
  expect(deleted.map((gone) => gone.day).sort()).toEqual([...old].sort())
  expect(await daysOf(tenant)).toEqual([...recent].sort())
  // Asked for by name, and by id: refused the same way, silently and whole.
  const today = daysAgo(0)
  expect(
    await withTenant(testDb.db, tenant.environmentId, (tx) =>
      tx.delete(smsCodeCounts).where(eq(smsCodeCounts.day, today)).returning()
    )
  ).toEqual([])
  expect(await daysOf(tenant)).toContain(today)
})

test('a row cannot be made old to get past the floor: the day is not the runtime role’s to change', async () => {
  expect(await insert(tenant, { day: daysAgo(0) })).toBeNull()
  expect(
    await refused(() =>
      withTenant(testDb.db, tenant.environmentId, (tx) =>
        tx.update(smsCodeCounts).set({ day: daysAgo(400) })
      )
    )
  ).toContain('permission denied')
  expect(await daysOf(tenant)).toEqual([daysAgo(0)])
})

test('the floor is one environment’s too: an old row of another environment stays', async () => {
  expect(await insert(other, { day: daysAgo(400) })).toBeNull()
  expect(
    await withTenant(testDb.db, tenant.environmentId, (tx) => tx.delete(smsCodeCounts).returning())
  ).toEqual([])
  expect(await daysOf(other)).toEqual([daysAgo(400)])
})
