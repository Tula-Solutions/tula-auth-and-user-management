import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { eq, getTableColumns, sql } from 'drizzle-orm'
import { passwordHistory, users } from './schema'
import { withTenant } from './tenant'
import { createTestDatabase, createTestTenant, type TestDatabase, type TestTenant } from './testing'

// `password_history` (ADR 0038): the passwords a user had before their current one. What the
// table itself refuses or does, whatever the API asks of it.

let testDb: TestDatabase
let tenant: TestTenant
let other: TestTenant

beforeAll(async () => {
  testDb = await createTestDatabase()
})

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

async function createUser(scope: TestTenant): Promise<string> {
  const id = Bun.randomUUIDv7()
  await withTenant(testDb.db, scope.environmentId, (tx) =>
    tx.insert(users).values({
      id,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      email: `${id}@northline.app`,
      emailNormalized: `${id}@northline.app`,
    })
  )
  return id
}

function row(
  scope: TestTenant,
  userId: string,
  overrides: Partial<typeof passwordHistory.$inferInsert> = {}
) {
  return {
    id: Bun.randomUUIDv7(),
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    userId,
    secret: '$argon2id$v=19$m=65536,t=2,p=1$c2FsdA$aGFzaA',
    position: 1,
    ...overrides,
  }
}

const insert = (
  scope: TestTenant,
  userId: string,
  overrides: Partial<typeof passwordHistory.$inferInsert> = {}
) =>
  refused(() =>
    withTenant(testDb.db, scope.environmentId, (tx) =>
      tx.insert(passwordHistory).values(row(scope, userId, overrides))
    )
  )

const positionsOf = async (scope: TestTenant) =>
  (
    await withTenant(testDb.db, scope.environmentId, (tx) =>
      tx
        .select({ position: passwordHistory.position })
        .from(passwordHistory)
        .orderBy(passwordHistory.position)
    )
  ).map((found) => found.position)

test('a row holds a hash and how far back it is, and nothing else of the password', () => {
  expect(Object.keys(getTableColumns(passwordHistory)).sort()).toEqual(
    [
      'id',
      'projectId',
      'environmentId',
      'userId',
      'secret',
      'position',
      'createdAt',
      'updatedAt',
    ].sort()
  )
})

test('a position starts at 1', async () => {
  const userId = await createUser(tenant)
  expect(await insert(tenant, userId, { position: 1 })).toBeNull()
  expect(await insert(tenant, userId, { position: 24 })).toBeNull()
  for (const position of [0, -1]) {
    expect(await insert(tenant, userId, { position })).toContain(
      'password_history_position_positive'
    )
  }
})

test('a user has one row at a position, and a shift of several rows still passes', async () => {
  const userId = await createUser(tenant)
  const another = await createUser(tenant)
  for (const position of [1, 2, 3]) {
    expect(await insert(tenant, userId, { position })).toBeNull()
  }
  // The backstop: whatever a writer does, two of one user's passwords are never equally old.
  expect(await insert(tenant, userId, { position: 2 })).toContain(
    'password_history_user_position_unique'
  )
  // Another user's row at the same position is theirs.
  expect(await insert(tenant, another, { position: 2 })).toBeNull()

  // What a password change does: every row one place further back, in one statement. Row by
  // row, 1 would land on 2 before 2 has moved; the constraint is judged when the statement
  // ends (it is deferrable), so the shift passes.
  const shifted = await refused(() =>
    withTenant(testDb.db, tenant.environmentId, (tx) =>
      tx
        .update(passwordHistory)
        .set({ position: sql`${passwordHistory.position} + 1` })
        .where(eq(passwordHistory.userId, userId))
    )
  )
  expect(shifted).toBeNull()
  expect(await positionsOf(tenant)).toEqual([2, 2, 3, 4])
  // And a statement that would leave two rows at one position is still refused when it ends,
  // not at the transaction's commit: nothing has deferred it.
  const collided = await refused(() =>
    withTenant(testDb.db, tenant.environmentId, async (tx) => {
      await tx
        .update(passwordHistory)
        .set({ position: 3 })
        .where(eq(passwordHistory.userId, userId))
      throw new Error('the statement was not refused where it ended')
    })
  )
  expect(collided).toContain('password_history_user_position_unique')
})

test('the rows go with their user', async () => {
  const userId = await createUser(tenant)
  const kept = await createUser(tenant)
  expect(await insert(tenant, userId, { position: 1 })).toBeNull()
  expect(await insert(tenant, userId, { position: 2 })).toBeNull()
  expect(await insert(tenant, kept, { position: 5 })).toBeNull()
  await withTenant(testDb.db, tenant.environmentId, (tx) =>
    tx.delete(users).where(eq(users.id, userId))
  )
  expect(await positionsOf(tenant)).toEqual([5])
})

test('a row cannot point at a user of another environment, or at nobody', async () => {
  const theirs = await createUser(other)
  expect(await insert(tenant, theirs)).toContain('password_history_user_fk')
  expect(await insert(tenant, Bun.randomUUIDv7())).toContain('password_history_user_fk')
})

test('row-level security keeps one environment’s previous passwords from another', async () => {
  const userId = await createUser(tenant)
  expect(await insert(tenant, userId)).toBeNull()
  const seen = await withTenant(testDb.db, other.environmentId, (tx) =>
    tx.select().from(passwordHistory)
  )
  expect(seen).toEqual([])
  // No environment in scope: nothing, not everything.
  expect(await testDb.db.select().from(passwordHistory)).toEqual([])
  expect(
    await refused(() =>
      withTenant(testDb.db, other.environmentId, (tx) =>
        tx.insert(passwordHistory).values(row(tenant, userId))
      )
    )
  ).toContain('row-level security')
  // Another environment's delete and update reach nothing.
  await withTenant(testDb.db, other.environmentId, async (tx) => {
    await tx.delete(passwordHistory)
    await tx.update(passwordHistory).set({ position: 9 })
  })
  expect(await positionsOf(tenant)).toEqual([1])
})

test('the runtime role moves a row back, and cannot rewrite its hash, its user or its environment', async () => {
  const userId = await createUser(tenant)
  const another = await createUser(tenant)
  expect(await insert(tenant, userId)).toBeNull()
  const update = (set: Partial<typeof passwordHistory.$inferInsert>) =>
    refused(() =>
      withTenant(testDb.db, tenant.environmentId, (tx) => tx.update(passwordHistory).set(set))
    )
  expect(await update({ position: 2, updatedAt: new Date('2026-10-08T10:00:00.000Z') })).toBeNull()
  expect(await positionsOf(tenant)).toEqual([2])
  for (const set of [
    { secret: '$argon2id$another' },
    { userId: another },
    { id: Bun.randomUUIDv7() },
    { projectId: other.projectId },
    { environmentId: other.environmentId },
    { createdAt: new Date('2020-01-01T00:00:00.000Z') },
  ]) {
    expect(await update(set)).toContain('permission denied')
  }
})

test('the runtime role cannot empty the table', async () => {
  expect(
    await refused(() => testDb.db.execute('truncate tula.password_history') as Promise<unknown>)
  ).toContain('permission denied')
})
