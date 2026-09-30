import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as schema from './schema'
import { withTenant } from './tenant'
import { createTestDatabase, createTestTenant, type TestDatabase, type TestTenant } from './testing'

let testDb: TestDatabase
let tenant: TestTenant

beforeAll(async () => {
  testDb = await createTestDatabase()
  tenant = await createTestTenant(testDb.db)
})

afterAll(() => testDb.close())

describe('withTenant', () => {
  test.each(['', 'not-a-uuid', "x'; drop table tula.users; --"])('rejects %p', async (id) => {
    await expect(withTenant(testDb.db, id, async () => 1)).rejects.toThrow(
      'environmentId must be a UUID'
    )
  })

  test('returns the callback result', async () => {
    expect(await withTenant(testDb.db, tenant.environmentId, async () => 42)).toBe(42)
  })

  test('rolls back everything when the callback throws', async () => {
    const attempt = withTenant(testDb.db, tenant.environmentId, async (tx) => {
      await tx
        .insert(schema.users)
        .values({ ...tenant, email: 'gone@t.test', emailNormalized: 'gone@t.test' })
      throw new Error('boom')
    })
    await expect(attempt).rejects.toThrow('boom')
    const rows = await withTenant(testDb.db, tenant.environmentId, (tx) =>
      tx.select().from(schema.users)
    )
    expect(rows).toEqual([])
  })
})
