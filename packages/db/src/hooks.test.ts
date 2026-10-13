import { afterAll, beforeAll, expect, test } from 'bun:test'
import { eq, getTableColumns } from 'drizzle-orm'
import { hooks } from './schema'
import { withTenant } from './tenant'
import { createTestDatabase, createTestTenant, type TestDatabase, type TestTenant } from './testing'

let testDb: TestDatabase
let tenant: TestTenant
let other: TestTenant

beforeAll(async () => {
  testDb = await createTestDatabase()
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

function hook(scope: TestTenant, overrides: Partial<typeof hooks.$inferInsert> = {}) {
  return {
    id: Bun.randomUUIDv7(),
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    point: 'before_sign_up' as const,
    url: 'https://app.example.com/tula/before-sign-up',
    secret: 'sealed',
    ...overrides,
  }
}

const insert = (scope: TestTenant, overrides: Partial<typeof hooks.$inferInsert> = {}) =>
  refused(() =>
    withTenant(testDb.db, scope.environmentId, (tx) =>
      tx.insert(hooks).values(hook(scope, overrides))
    )
  )

const clear = (scope: TestTenant) =>
  withTenant(testDb.db, scope.environmentId, (tx) => tx.delete(hooks))

test('a hook waits two seconds and refuses on failure unless told otherwise', async () => {
  const row = hook(tenant)
  const [stored] = await withTenant(testDb.db, tenant.environmentId, async (tx) => {
    await tx.insert(hooks).values(row)
    return tx.select().from(hooks).where(eq(hooks.id, row.id))
  })
  expect(stored).toMatchObject({ enabled: true, deadlineMs: 2000, failureMode: 'deny' })
  expect(stored?.lastFailedAt).toBeNull()
  expect(stored?.lastFailureReason).toBeNull()
  await clear(tenant)
})

test.each([
  [100, true],
  [5000, true],
  [99, false],
  [5001, false],
  [60_000, false],
  [0, false],
  [-1, false],
])(
  'the database itself holds the deadline to its bounds: %p stored %p',
  async (deadlineMs, stored) => {
    const outcome = await insert(tenant, { deadlineMs })
    if (stored) {
      expect(outcome).toBeNull()
    } else {
      expect(outcome).toContain('hooks_deadline_bounds')
    }
    await clear(tenant)
  }
)

test('an update cannot take a deadline past five seconds either', async () => {
  expect(await insert(tenant)).toBeNull()
  const outcome = await refused(() =>
    withTenant(testDb.db, tenant.environmentId, (tx) => tx.update(hooks).set({ deadlineMs: 5001 }))
  )
  expect(outcome).toContain('hooks_deadline_bounds')
  await clear(tenant)
})

test('an environment has one hook per point, and another environment has its own', async () => {
  expect(await insert(tenant)).toBeNull()
  expect(await insert(tenant)).toContain('hooks_environment_point_key')
  expect(await insert(other)).toBeNull()
  await clear(tenant)
  await clear(other)
})

test('an environment has a hook for each point, and one of each at most', async () => {
  for (const point of ['before_sign_up', 'before_session', 'before_token'] as const) {
    expect(await insert(tenant, { point })).toBeNull()
  }
  for (const point of ['before_sign_up', 'before_session', 'before_token'] as const) {
    expect(await insert(tenant, { point })).toContain('hooks_environment_point_key')
  }
  await clear(tenant)
})

test('a failure mode the server does not know is refused', async () => {
  expect(await insert(tenant, { failureMode: 'ignore' as never })).toContain(
    'hooks_failure_mode_known'
  )
})

test('when a hook last failed and why are stored together or not at all', async () => {
  const at = new Date('2026-10-08T10:00:00.000Z')
  expect(await insert(tenant, { lastFailedAt: at })).toContain('hooks_last_failure_whole')
  expect(await insert(tenant, { lastFailureReason: 'timeout' })).toContain(
    'hooks_last_failure_whole'
  )
  expect(await insert(tenant, { lastFailedAt: at, lastFailureReason: 'timeout' })).toBeNull()
  await clear(tenant)
})

test('a hook is seen only inside its own environment, and not at all outside one', async () => {
  expect(await insert(tenant)).toBeNull()
  const theirs = await withTenant(testDb.db, other.environmentId, (tx) => tx.select().from(hooks))
  expect(theirs).toEqual([])
  expect(await testDb.db.select().from(hooks)).toEqual([])
  // A row of one environment cannot be written while another is set.
  expect(
    await refused(() =>
      withTenant(testDb.db, other.environmentId, (tx) => tx.insert(hooks).values(hook(tenant)))
    )
  ).toContain('row-level security')
  await clear(tenant)
})

test('there is no column for anything the endpoint answered', () => {
  expect(Object.keys(getTableColumns(hooks)).sort()).toEqual(
    [
      'id',
      'projectId',
      'environmentId',
      'point',
      'url',
      'secret',
      'enabled',
      'deadlineMs',
      'failureMode',
      'lastFailedAt',
      'lastFailureReason',
      'createdAt',
      'updatedAt',
    ].sort()
  )
})

test('the runtime role updates what the API changes, and cannot rewrite a secret, a point or who owns a hook', async () => {
  expect(await insert(tenant)).toBeNull()
  const update = (set: Partial<typeof hooks.$inferInsert>) =>
    refused(() => withTenant(testDb.db, tenant.environmentId, (tx) => tx.update(hooks).set(set)))
  expect(
    await update({
      url: 'https://new.example.com/hook',
      enabled: false,
      deadlineMs: 300,
      failureMode: 'allow',
      lastFailedAt: new Date('2026-10-08T10:00:00.000Z'),
      lastFailureReason: 'timeout',
      updatedAt: new Date('2026-10-08T10:00:00.000Z'),
    })
  ).toBeNull()
  for (const set of [
    { secret: 'sealed-by-someone-else' },
    { point: 'before_sign_up' as const },
    { id: Bun.randomUUIDv7() },
    { projectId: other.projectId },
    { environmentId: other.environmentId },
    { createdAt: new Date('2020-01-01T00:00:00.000Z') },
  ]) {
    expect(await update(set)).toContain('permission denied')
  }
  await clear(tenant)
})
