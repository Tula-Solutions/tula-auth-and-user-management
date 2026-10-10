import { afterAll, beforeAll, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { sessions, users } from './schema'
import { withTenant } from './tenant'
import { createTestDatabase, createTestTenant, type TestDatabase, type TestTenant } from './testing'

// `sessions.device_thumbprint` (ADR 0043): the thumbprint of the key a session was bound to
// when its sign-in started. Run as the runtime role, with every migration applied.

let testDb: TestDatabase
let tenant: TestTenant

beforeAll(async () => {
  testDb = await createTestDatabase()
  tenant = await createTestTenant(testDb.db)
})

afterAll(() => testDb.close())

const THUMBPRINT = 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs'
const OTHER = '0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I'

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

async function insert(values: { deviceThumbprint?: string | null; type?: 'hybrid' | 'stateful' }) {
  const tenantColumns = { projectId: tenant.projectId, environmentId: tenant.environmentId }
  const userId = Bun.randomUUIDv7()
  const id = Bun.randomUUIDv7()
  const outcome = await refused(() =>
    withTenant(testDb.db, tenant.environmentId, async (tx) => {
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
        profile: 'mobile',
        client: 'ios',
        lastActiveAt: new Date('2026-10-08T09:30:00.000Z'),
        idleExpiresAt: new Date('2026-10-09T09:30:00.000Z'),
        ...values,
      })
    })
  )
  return { id, outcome }
}

const read = async (id: string) => {
  const [row] = await withTenant(testDb.db, tenant.environmentId, (tx) =>
    tx.select().from(sessions).where(eq(sessions.id, id))
  )
  return row
}

const set = (id: string, values: Partial<typeof sessions.$inferInsert>) =>
  refused(() =>
    withTenant(testDb.db, tenant.environmentId, (tx) =>
      tx.update(sessions).set(values).where(eq(sessions.id, id))
    )
  )

test('a session is not bound unless it was created bound', async () => {
  const { id, outcome } = await insert({})
  expect(outcome).toBeNull()
  expect((await read(id))?.deviceThumbprint).toBeNull()
})

test('a thumbprint is stored as it was given', async () => {
  const { id, outcome } = await insert({ deviceThumbprint: THUMBPRINT })
  expect(outcome).toBeNull()
  expect((await read(id))?.deviceThumbprint).toBe(THUMBPRINT)
})

test.each([
  ['an empty string', ''],
  ['one character short', THUMBPRINT.slice(1)],
  ['one character long', `${THUMBPRINT}A`],
  ['padded base64', `${THUMBPRINT.slice(0, 42)}=`],
  ['standard base64', `${THUMBPRINT.slice(0, 42)}+`],
  ['a hex digest', 'a'.repeat(64)],
])('the database itself refuses %s for a thumbprint', async (_name, value) => {
  const { outcome } = await insert({ deviceThumbprint: value })
  expect(outcome).toContain('sessions_device_thumbprint_shape')
})

test('a stateful session is never bound', async () => {
  const { outcome } = await insert({ type: 'stateful', deviceThumbprint: THUMBPRINT })
  expect(outcome).toContain('sessions_device_thumbprint_shape')
})

test('a bound session cannot be moved to another key, or unbound', async () => {
  const { id } = await insert({ deviceThumbprint: THUMBPRINT })
  expect(await set(id, { deviceThumbprint: OTHER })).toContain('fixed when the session is created')
  expect(await set(id, { deviceThumbprint: null })).toContain('fixed when the session is created')
  expect((await read(id))?.deviceThumbprint).toBe(THUMBPRINT)
})

test('a session that was not bound cannot be bound later', async () => {
  const { id } = await insert({})
  expect(await set(id, { deviceThumbprint: THUMBPRINT })).toContain(
    'fixed when the session is created'
  )
  expect((await read(id))?.deviceThumbprint).toBeNull()
})

test('everything else about a bound session still changes', async () => {
  const { id } = await insert({ deviceThumbprint: THUMBPRINT })
  const at = new Date('2026-10-08T10:00:00.000Z')
  // The same value written back is no change, and no refusal.
  expect(await set(id, { lastActiveAt: at, deviceThumbprint: THUMBPRINT })).toBeNull()
  expect(await set(id, { revokedAt: at, revokeReason: 'sign_out' })).toBeNull()
  const row = await read(id)
  expect(row?.lastActiveAt).toEqual(at)
  expect(row?.revokedAt).toEqual(at)
  expect(row?.deviceThumbprint).toBe(THUMBPRINT)
})
