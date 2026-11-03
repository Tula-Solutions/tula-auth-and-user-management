import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { users, withTenant } from '@tula-tech/db'
import {
  createTestDatabase,
  createTestTenant,
  type TestDatabase,
  type TestTenant,
} from '@tula-tech/db/testing'
import { eq } from 'drizzle-orm'
import { dataRefusal } from '~/adapters/postgres/errors'
import { PostgresUserRepository } from '~/adapters/postgres/users'
import * as logger from '~/lib/logger'
import * as Audit from '~/modules/audit/service'
import { InvalidUserDataError, type NewUser } from '~/ports/user-repository'

// What an import keeps with a user (ADR 0066): the external id and the metadata, in the
// columns migration 0037 added, held to 4 KiB by the database itself.

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
    ).rejects.toBeInstanceOf(InvalidUserDataError)
    await expect(
      repo.create(
        newUser('f@northline.app', { metadata: [1] as unknown as Record<string, unknown> }),
        Audit.none('fixture')
      )
    ).rejects.toBeInstanceOf(InvalidUserDataError)
  })

  // jsonb prints a space after every ':' and ',', so ~4000 compact bytes over 100 keys is over
  // 4096 as stored; and jsonb refuses U+0000 outright (SQLSTATE 22P05). Both must surface as
  // the port's own error, which the import turns into one refused row, never a failed call.
  test('metadata that is small compact and over 4 KiB as jsonb prints it is refused', async () => {
    const repo = new PostgresUserRepository(testDb.db)
    const metadata = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`k${String(i).padStart(2, '0')}`, 'v'.repeat(31)])
    )
    expect(JSON.stringify(metadata).length).toBeLessThanOrEqual(4096)
    await expect(
      repo.create(newUser('g@northline.app', { metadata }), Audit.none('fixture'))
    ).rejects.toBeInstanceOf(InvalidUserDataError)
  })

  test('metadata holding a NUL is refused', async () => {
    const repo = new PostgresUserRepository(testDb.db)
    await expect(
      repo.create(newUser('h@northline.app', { metadata: { a: '\u0000' } }), Audit.none('fixture'))
    ).rejects.toBeInstanceOf(InvalidUserDataError)
  })

  test('a mapped refusal is logged by SQLSTATE and constraint, never by its data', async () => {
    const repo = new PostgresUserRepository(testDb.db)
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined)
    try {
      await expect(
        repo.create(
          newUser('secret-address@northline.app', { metadata: { hidden: 'x'.repeat(5000) } }),
          Audit.none('fixture')
        )
      ).rejects.toBeInstanceOf(InvalidUserDataError)
      expect(warn).toHaveBeenCalledTimes(1)
      const [, context] = warn.mock.calls[0] ?? []
      expect(context).toEqual({
        environmentId: tenant.environmentId,
        sqlstate: '23514',
        constraint: 'users_metadata_bounds',
      })
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret-address|hidden|xxxx/)
    } finally {
      warn.mockRestore()
    }
  })

  test('any other check violation stays a raw error, even for an import', async () => {
    for (const constraint of ['users_something_else', undefined]) {
      const raw = Object.assign(new Error('check failed'), { code: '23514', constraint })
      const failing = {
        transaction: async () => {
          throw raw
        },
      }
      const repo = new PostgresUserRepository(failing as never)
      await expect(
        repo.create(newUser('k@northline.app', { metadata: { a: 1 } }), Audit.none('fixture'))
      ).rejects.toBe(raw)
    }
  })

  test('dataRefusal names what it maps and nothing else', () => {
    const wrapped = (inner: object) => Object.assign(new Error('wrapped'), { cause: inner })
    expect(dataRefusal(wrapped({ code: '23514', constraint: 'users_metadata_bounds' }))).toEqual({
      code: '23514',
      constraint: 'users_metadata_bounds',
    })
    expect(dataRefusal({ code: '22P05' })).toEqual({ code: '22P05', constraint: undefined })
    expect(dataRefusal({ code: '23514', constraint: 'other' })).toBeNull()
    expect(dataRefusal({ code: '23514' })).toBeNull()
    expect(dataRefusal({ code: '23505', constraint: 'users_metadata_bounds' })).toBeNull()
    expect(dataRefusal(new Error('plain'))).toBeNull()
  })

  test('a refused row leaves no user, and the next row is created', async () => {
    const repo = new PostgresUserRepository(testDb.db)
    const refused = newUser('i@northline.app', { metadata: { a: '\u0000' } })
    await expect(repo.create(refused, Audit.none('fixture'))).rejects.toBeInstanceOf(
      InvalidUserDataError
    )
    expect(await row(refused.id)).toBeUndefined()
    expect(await repo.create(newUser('j@northline.app'), Audit.none('fixture'))).toBe(true)
  })
})
