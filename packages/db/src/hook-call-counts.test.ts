import { afterAll, beforeAll, expect, test } from 'bun:test'
import { eq, getTableColumns, sql } from 'drizzle-orm'
import { hookCallCounts, hooks } from './schema'
import { withTenant } from './tenant'
import { createTestDatabase, createTestTenant, type TestDatabase, type TestTenant } from './testing'

let testDb: TestDatabase
let tenant: TestTenant
let other: TestTenant
let hookId: string
let theirHookId: string

const HOUR = new Date('2026-10-12T09:00:00.000Z')

async function addHook(scope: TestTenant): Promise<string> {
  const id = Bun.randomUUIDv7()
  await withTenant(testDb.db, scope.environmentId, (tx) =>
    tx.insert(hooks).values({
      id,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      point: 'before_sign_up',
      url: 'https://app.example.com/tula/before-sign-up',
      secret: 'sealed',
    })
  )
  return id
}

beforeAll(async () => {
  testDb = await createTestDatabase()
  tenant = await createTestTenant(testDb.db)
  other = await createTestTenant(testDb.db)
  hookId = await addHook(tenant)
  theirHookId = await addHook(other)
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

function count(scope: TestTenant, overrides: Partial<typeof hookCallCounts.$inferInsert> = {}) {
  return {
    id: Bun.randomUUIDv7(),
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    hookId: scope === tenant ? hookId : theirHookId,
    hour: HOUR,
    outcome: 'allowed' as const,
    calls: 1,
    lastAt: new Date(HOUR.getTime() + 60_000),
    ...overrides,
  }
}

const insert = (scope: TestTenant, overrides: Partial<typeof hookCallCounts.$inferInsert> = {}) =>
  refused(() =>
    withTenant(testDb.db, scope.environmentId, (tx) =>
      tx.insert(hookCallCounts).values(count(scope, overrides))
    )
  )

const clear = (scope: TestTenant) =>
  withTenant(testDb.db, scope.environmentId, (tx) => tx.delete(hookCallCounts))

test('the table holds a count and nothing of a call: no column for a question, an answer, a code or a reason', () => {
  expect(Object.keys(getTableColumns(hookCallCounts)).sort()).toEqual(
    [
      'id',
      'projectId',
      'environmentId',
      'hookId',
      'hour',
      'outcome',
      'calls',
      'lastAt',
      'createdAt',
      'updatedAt',
    ].sort()
  )
})

test('a hook has one row for an hour and an outcome, and one for each of the four', async () => {
  for (const outcome of ['allowed', 'denied', 'failed', 'timed_out'] as const) {
    expect(await insert(tenant, { outcome })).toBeNull()
  }
  expect(await insert(tenant)).toContain('hook_call_counts_hook_hour_outcome_key')
  await clear(tenant)
})

test('an outcome the server does not know is refused', async () => {
  for (const outcome of ['deny', 'timeout', 'blocked_by_policy', '']) {
    expect(await insert(tenant, { outcome: outcome as never })).toContain(
      'hook_call_counts_outcome_known'
    )
  }
})

test('an hour is the beginning of one, and the latest call lies inside it', async () => {
  expect(await insert(tenant, { hour: new Date(HOUR.getTime() + 1) })).toContain(
    'hook_call_counts_hour_whole'
  )
  expect(await insert(tenant, { lastAt: new Date(HOUR.getTime() - 1) })).toContain(
    'hook_call_counts_last_at_in_hour'
  )
  expect(await insert(tenant, { lastAt: new Date(HOUR.getTime() + 3_600_000) })).toContain(
    'hook_call_counts_last_at_in_hour'
  )
  expect(await insert(tenant, { lastAt: HOUR })).toBeNull()
  await clear(tenant)
  expect(await insert(tenant, { lastAt: new Date(HOUR.getTime() + 3_599_999) })).toBeNull()
  await clear(tenant)
})

test('a count is never negative', async () => {
  expect(await insert(tenant, { calls: -1 })).toContain('hook_call_counts_calls_bounds')
})

test('a count is seen only inside its own environment, and cannot be of another environment\u2019s hook', async () => {
  expect(await insert(tenant)).toBeNull()
  expect(
    await withTenant(testDb.db, other.environmentId, (tx) => tx.select().from(hookCallCounts))
  ).toEqual([])
  expect(await testDb.db.select().from(hookCallCounts)).toEqual([])
  // A row of one environment cannot be written while another is set.
  expect(
    await refused(() =>
      withTenant(testDb.db, other.environmentId, (tx) =>
        tx.insert(hookCallCounts).values(count(tenant))
      )
    )
  ).toContain('row-level security')
  // And a row of this environment cannot name a hook of the other one.
  expect(await insert(tenant, { hookId: theirHookId, outcome: 'denied' })).toContain(
    'hook_call_counts_hook_fk'
  )
  await clear(tenant)
})

test('the counts go with their hook', async () => {
  const scope = await createTestTenant(testDb.db)
  const id = await addHook(scope)
  await withTenant(testDb.db, scope.environmentId, async (tx) => {
    await tx.insert(hookCallCounts).values({ ...count(scope), hookId: id })
    await tx.delete(hooks).where(eq(hooks.id, id))
  })
  expect(
    await withTenant(testDb.db, scope.environmentId, (tx) => tx.select().from(hookCallCounts))
  ).toEqual([])
})

test('the runtime role counts up and moves the latest call, and cannot move a row to another hook, hour or outcome', async () => {
  expect(await insert(tenant)).toBeNull()
  const update = (set: Record<string, unknown>) =>
    refused(() =>
      withTenant(testDb.db, tenant.environmentId, (tx) => tx.update(hookCallCounts).set(set))
    )
  expect(
    await update({
      calls: sql`${hookCallCounts.calls} + 1`,
      lastAt: new Date(HOUR.getTime() + 120_000),
      updatedAt: new Date(HOUR.getTime() + 120_000),
    })
  ).toBeNull()
  for (const set of [
    { hookId: theirHookId },
    { hour: new Date(HOUR.getTime() - 3_600_000) },
    { outcome: 'denied' },
    { id: Bun.randomUUIDv7() },
    { projectId: other.projectId },
    { environmentId: other.environmentId },
    { createdAt: new Date('2020-01-01T00:00:00.000Z') },
  ]) {
    expect(await update(set)).toContain('permission denied')
  }
  await clear(tenant)
})
