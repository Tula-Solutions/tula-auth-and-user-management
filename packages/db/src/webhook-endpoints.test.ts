import { afterAll, beforeAll, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { webhookEndpoints } from './schema'
import { withTenant } from './tenant'
import { createTestDatabase, createTestTenant, type TestDatabase, type TestTenant } from './testing'

let testDb: TestDatabase
let tenant: TestTenant

beforeAll(async () => {
  testDb = await createTestDatabase()
  tenant = await createTestTenant(testDb.db)
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

function endpoint(overrides: Partial<typeof webhookEndpoints.$inferInsert> = {}) {
  return {
    id: Bun.randomUUIDv7(),
    projectId: tenant.projectId,
    environmentId: tenant.environmentId,
    url: 'https://hooks.example.com/tula',
    eventTypes: ['user.created'],
    secret: 'sealed-current',
    ...overrides,
  }
}

test('an endpoint has no previous secret unless a rotation gave it one', async () => {
  const row = endpoint()
  const [stored] = await withTenant(testDb.db, tenant.environmentId, async (tx) => {
    await tx.insert(webhookEndpoints).values(row)
    return tx.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, row.id))
  })
  expect(stored?.previousSecret).toBeNull()
  expect(stored?.previousSecretExpiresAt).toBeNull()
})

test('a previous secret and the time it stops signing are stored together or not at all', async () => {
  const expiresAt = new Date('2026-10-09T09:30:00.000Z')
  const insert = (overrides: Partial<typeof webhookEndpoints.$inferInsert>) =>
    refused(() =>
      withTenant(testDb.db, tenant.environmentId, (tx) =>
        tx.insert(webhookEndpoints).values(endpoint(overrides))
      )
    )
  // A previous secret with no end would sign for ever; an end with no secret says a rotation
  // is under way when nothing can sign for it.
  expect(await insert({ previousSecret: 'sealed-previous' })).toContain(
    'webhook_endpoints_previous_secret_whole'
  )
  expect(await insert({ previousSecretExpiresAt: expiresAt })).toContain(
    'webhook_endpoints_previous_secret_whole'
  )
  expect(
    await insert({ previousSecret: 'sealed-previous', previousSecretExpiresAt: expiresAt })
  ).toBeNull()

  // The same holds for a row that is changed: one half cannot be cleared alone.
  const row = endpoint({ previousSecret: 'sealed-previous', previousSecretExpiresAt: expiresAt })
  await withTenant(testDb.db, tenant.environmentId, (tx) => tx.insert(webhookEndpoints).values(row))
  const clear = (changes: Partial<typeof webhookEndpoints.$inferInsert>) =>
    refused(() =>
      withTenant(testDb.db, tenant.environmentId, (tx) =>
        tx.update(webhookEndpoints).set(changes).where(eq(webhookEndpoints.id, row.id))
      )
    )
  expect(await clear({ previousSecret: null })).toContain('webhook_endpoints_previous_secret_whole')
  expect(await clear({ previousSecretExpiresAt: null })).toContain(
    'webhook_endpoints_previous_secret_whole'
  )
  expect(await clear({ previousSecret: null, previousSecretExpiresAt: null })).toBeNull()
})
