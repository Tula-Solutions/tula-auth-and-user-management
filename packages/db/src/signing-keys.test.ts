import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { signingKeys } from './schema'
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

function insert(target: TestTenant, status: 'next' | 'active' | 'retired') {
  return withTenant(testDb.db, target.environmentId, (tx) =>
    tx.insert(signingKeys).values({
      projectId: target.projectId,
      environmentId: target.environmentId,
      publicJwk: { kty: 'OKP' },
      privateKeyCiphertext: 'x',
      status,
    })
  )
}

describe('signing key lifecycle constraints', () => {
  test.each(['active', 'next'] as const)(
    'allows only one %s key per environment',
    async (status) => {
      await insert(tenant, status)
      await expect(insert(tenant, status)).rejects.toThrow()
      // Other environments are independent.
      await expect(insert(other, status)).resolves.toBeDefined()
    }
  )

  test('allows any number of retired keys', async () => {
    await insert(tenant, 'retired')
    await expect(insert(tenant, 'retired')).resolves.toBeDefined()
  })
})
