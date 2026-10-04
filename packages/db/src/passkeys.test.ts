import { afterAll, beforeAll, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { passkeys, users } from './schema'
import { withTenant } from './tenant'
import { createTestDatabase, createTestTenant, type TestDatabase, type TestTenant } from './testing'

let testDb: TestDatabase
let tenant: TestTenant

beforeAll(async () => {
  testDb = await createTestDatabase()
  tenant = await createTestTenant(testDb.db)
})

afterAll(() => testDb.close())

test('a passkey’s public key is stored as bytes and read back byte for byte', async () => {
  const scope = { projectId: tenant.projectId, environmentId: tenant.environmentId }
  const userId = Bun.randomUUIDv7()
  const id = Bun.randomUUIDv7()
  // Every byte value, so nothing is lost to an encoding on the way in or out.
  const publicKey = Uint8Array.from({ length: 256 }, (_, index) => index)
  const [row] = await withTenant(testDb.db, tenant.environmentId, async (tx) => {
    await tx.insert(users).values({
      id: userId,
      ...scope,
      email: `${userId}@northline.app`,
      emailNormalized: `${userId}@northline.app`,
    })
    await tx.insert(passkeys).values({
      id,
      ...scope,
      userId,
      credentialId: `credential-${id}`,
      publicKey,
      aaguid: '00000000-0000-0000-0000-000000000000',
      userHandle: 'handle',
      name: 'Passkey',
    })
    return tx.select().from(passkeys).where(eq(passkeys.id, id))
  })
  expect(row?.publicKey).toBeInstanceOf(Uint8Array)
  expect(row?.publicKey).toEqual(publicKey)
  expect(row).toMatchObject({
    signCount: 0,
    transports: [],
    backupEligible: false,
    backedUp: false,
    lastUsedAt: null,
  })
})
