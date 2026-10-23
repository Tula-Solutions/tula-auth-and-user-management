import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { users, withTenant } from '@tula-tech/db'
import {
  createTestDatabase,
  createTestTenant,
  type TestDatabase,
  type TestTenant,
} from '@tula-tech/db/testing'
import { eq } from 'drizzle-orm'
import { PostgresUserRepository } from '~/adapters/postgres/users'
import * as Audit from '~/modules/audit/service'
import type { NewUser } from '~/ports/user-repository'

// What an import keeps with a user (ADR 0066): the external id and the metadata, in the
// columns migration 0036 added, held to 4 KiB by the database itself.

let testDb: TestDatabase
let tenant: TestTenant

beforeAll(async () => {
  testDb = await createTestDatabase()
  tenant = await createTestTenant(testDb.db)
})

afterAll(() => testDb.close())

function newUser(email: string, extra: Partial<NewUser> = {}): NewUser {
  return {
    id: Bun.randomUUIDv7(),
    projectId: tenant.projectId,
    environmentId: tenant.environmentId,
    email,
    emailNormalized: email,
    emailVerifiedAt: null,
    firstName: null,
    lastName: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    identityId: Bun.randomUUIDv7(),
    credentialId: Bun.randomUUIDv7(),
    passwordHash: null,
    ...extra,
  }
}

const row = (id: string) =>
  withTenant(testDb.db, tenant.environmentId, (tx) =>
    tx.select().from(users).where(eq(users.id, id))
  ).then(([found]) => found)

describe('a user created with an external id and metadata', () => {
  test('keeps both', async () => {
    const repo = new PostgresUserRepository(testDb.db)
    const user = newUser('a@northline.app', {
      externalId: 'auth0|abc',
      metadata: { plan: 'team', seats: 4 },
    })
    expect(await repo.create(user, Audit.none('fixture'))).toBe(true)
    expect(await row(user.id)).toMatchObject({
      externalId: 'auth0|abc',
      metadata: { plan: 'team', seats: 4 },
    })
  })

  test('a user created without them has no external id and empty metadata', async () => {
    const repo = new PostgresUserRepository(testDb.db)
    const user = newUser('b@northline.app')
    await repo.create(user, Audit.none('fixture'))
    expect(await row(user.id)).toMatchObject({ externalId: null, metadata: {} })
  })

  test('two users may share an external id', async () => {
    const repo = new PostgresUserRepository(testDb.db)
    expect(
      await repo.create(newUser('c@northline.app', { externalId: 'same' }), Audit.none('fixture'))
    ).toBe(true)
    expect(
      await repo.create(newUser('d@northline.app', { externalId: 'same' }), Audit.none('fixture'))
    ).toBe(true)
  })

  test('the database refuses metadata over 4 KiB and metadata that is not an object', async () => {
    const repo = new PostgresUserRepository(testDb.db)
    await expect(
      repo.create(
        newUser('e@northline.app', { metadata: { blob: 'x'.repeat(5000) } }),
        Audit.none('fixture')
      )
    ).rejects.toThrow()
    await expect(
      repo.create(
        newUser('f@northline.app', { metadata: [1] as unknown as Record<string, unknown> }),
        Audit.none('fixture')
      )
    ).rejects.toThrow()
  })
})
