import { afterAll, beforeAll, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { sessions, users } from './schema'
import { withTenant } from './tenant'
import { createTestDatabase, createTestTenant, type TestDatabase, type TestTenant } from './testing'

// `sessions.hook_claims` (ADR 0035, "Hooks before a session and before a token"): what the
// environment's `before_token` hook last answered for a session, kept so that a refresh
// issues it again without asking. Run as the runtime role, with every migration applied.

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

async function session(scope: TestTenant, hookClaims?: Record<string, unknown> | null) {
  const tenantColumns = { projectId: scope.projectId, environmentId: scope.environmentId }
  const userId = Bun.randomUUIDv7()
  const id = Bun.randomUUIDv7()
  const at = new Date('2026-10-08T09:30:00.000Z')
  await withTenant(testDb.db, scope.environmentId, async (tx) => {
    await tx.insert(users).values({
      id: userId,
      ...tenantColumns,
      email: `${userId}@northline.app`,
      emailNormalized: `${userId}@northline.app`,
    })
    await tx.insert(sessions).values({
      id,
      ...tenantColumns,
      userId,
      profile: 'web',
      client: 'web',
      lastActiveAt: at,
      idleExpiresAt: new Date('2026-10-09T09:30:00.000Z'),
      ...(hookClaims !== undefined && { hookClaims }),
    })
  })
  return id
}

const read = async (scope: TestTenant, id: string) => {
  const [row] = await withTenant(testDb.db, scope.environmentId, (tx) =>
    tx.select().from(sessions).where(eq(sessions.id, id))
  )
  return row
}

const set = (scope: TestTenant, id: string, hookClaims: unknown) =>
  refused(() =>
    withTenant(testDb.db, scope.environmentId, (tx) =>
      tx
        .update(sessions)
        .set({ hookClaims: hookClaims as Record<string, unknown> | null })
        .where(eq(sessions.id, id))
    )
  )

test('a session has no hook claims unless a hook gave it some', async () => {
  const id = await session(tenant)
  expect((await read(tenant, id))?.hookClaims).toBeNull()
})

test('claims are stored as they were given and read back the same', async () => {
  const claims = { role: 'admin', seats: 3, staff: false }
  const id = await session(tenant, claims)
  expect((await read(tenant, id))?.hookClaims).toEqual(claims)
})

test('the runtime role replaces them and takes them away again', async () => {
  const id = await session(tenant, { role: 'member' })
  expect(await set(tenant, id, { role: 'admin' })).toBeNull()
  expect((await read(tenant, id))?.hookClaims).toEqual({ role: 'admin' })
  expect(await set(tenant, id, null)).toBeNull()
  expect((await read(tenant, id))?.hookClaims).toBeNull()
})

test.each([
  ['a list', ['admin']],
  ['a string', 'role=admin'],
  ['a number', 7],
  ['a boolean', true],
])('the database itself refuses %s for the claims: an object or nothing', async (_name, value) => {
  const id = await session(tenant)
  expect(await set(tenant, id, value)).toContain('sessions_hook_claims_bounds')
  expect((await read(tenant, id))?.hookClaims).toBeNull()
})

test('the database itself refuses claims far past the size cap', async () => {
  const id = await session(tenant)
  // The cap on the namespace claim is 1,024 bytes of JSON, held by the service. The table's
  // own bound is looser (the stored text has spaces the compact form has not) and exists so
  // that no write of any kind makes a session row an unbounded document.
  expect(await set(tenant, id, { a: 'x'.repeat(1016) })).toBeNull()
  expect(await set(tenant, id, { a: 'x'.repeat(4096) })).toContain('sessions_hook_claims_bounds')
  expect((await read(tenant, id))?.hookClaims).toEqual({ a: 'x'.repeat(1016) })
})

test('a session’s claims are seen and written only inside its own environment', async () => {
  const id = await session(tenant, { role: 'admin' })
  expect(await read(other, id)).toBeUndefined()
  // Another environment's statement matches no row: nothing changes.
  expect(await set(other, id, { role: 'owner' })).toBeNull()
  expect((await read(tenant, id))?.hookClaims).toEqual({ role: 'admin' })
})
