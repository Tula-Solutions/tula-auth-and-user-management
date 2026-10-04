import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { passkeyChallenges, passkeys, users, withTenant } from '@tula/db'
import {
  createTestDatabase,
  createTestTenant,
  type TestDatabase,
  type TestTenant,
} from '@tula/db/testing'
import { eq } from 'drizzle-orm'
import { describePasskeyStore, type PasskeySuiteTenant } from '~/adapters/passkey-store.suite'
import { PostgresActivityLog } from '~/adapters/postgres/activity'
import { PostgresPasskeyStore } from '~/adapters/postgres/passkeys'
import { PostgresUserRepository } from '~/adapters/postgres/users'
import type { Activity } from '~/ports/activity-log'
import type { PasskeyRecord } from '~/ports/passkey-store'

// PGlite: real Postgres with every migration, connected as the runtime role (RLS applies).
let testDb: TestDatabase
let a: TestTenant
let b: TestTenant
const now = new Date('2026-01-01T00:00:00.000Z')

beforeAll(async () => {
  testDb = await createTestDatabase()
  a = await createTestTenant(testDb.db)
  b = await createTestTenant(testDb.db, 'production')
})

afterAll(() => testDb.close())

function suiteTenant(tenant: TestTenant): PasskeySuiteTenant {
  const scope = { projectId: tenant.projectId, environmentId: tenant.environmentId }
  return {
    ...scope,
    user: () =>
      withTenant(testDb.db, tenant.environmentId, async (tx) => {
        const id = Bun.randomUUIDv7()
        await tx.insert(users).values({
          id,
          ...scope,
          email: `${id}@northline.app`,
          emailNormalized: `${id}@northline.app`,
        })
        return id
      }),
  }
}

describePasskeyStore('PostgresPasskeyStore', async () => ({
  store: new PostgresPasskeyStore(testDb.db),
  log: new PostgresActivityLog(testDb.db),
  a: suiteTenant(a),
  b: suiteTenant(b),
}))

describe('PostgresPasskeyStore', () => {
  const store = () => new PostgresPasskeyStore(testDb.db)

  function passkey(userId: string, overrides: Partial<PasskeyRecord> = {}): PasskeyRecord {
    const id = Bun.randomUUIDv7()
    return {
      id,
      projectId: a.projectId,
      environmentId: a.environmentId,
      userId,
      credentialId: `credential-${id}`,
      publicKey: new Uint8Array([0xa5, 0x00, 0xff]),
      signCount: 0,
      transports: ['internal'],
      aaguid: '00000000-0000-0000-0000-000000000000',
      backupEligible: false,
      backedUp: false,
      userHandle: 'handle',
      name: 'Passkey',
      lastUsedAt: null,
      createdAt: now,
      ...overrides,
    }
  }

  // An `inet` column rejects this, which makes the activity insert fail after the real write.
  const broken = (userId: string, type: Activity['type']): Activity => ({
    id: Bun.randomUUIDv7(),
    projectId: a.projectId,
    environmentId: a.environmentId,
    type,
    actor: { type: 'user', id: userId },
    target: { type: 'user', id: userId },
    ipAddress: 'not-an-ip',
    userAgent: 'suite/1.0',
    data: {},
    occurredAt: now,
  })

  test('a passkey whose audit entry cannot be written is not stored', async () => {
    const userId = await suiteTenant(a).user()
    await expect(
      store().create(passkey(userId), 10, broken(userId, 'user.passkey_added'))
    ).rejects.toThrow()
    expect(await store().listForUser(a.environmentId, userId)).toEqual([])
  })

  test('a rename or a removal whose audit entry cannot be written changes nothing', async () => {
    const userId = await suiteTenant(a).user()
    const record = passkey(userId)
    await store().create(record, 10)
    await expect(
      store().rename(
        a.environmentId,
        userId,
        record.id,
        'renamed',
        now,
        broken(userId, 'user.passkey_renamed')
      )
    ).rejects.toThrow()
    await expect(
      store().remove(
        a.environmentId,
        userId,
        record.id,
        () => true,
        broken(userId, 'user.passkey_removed')
      )
    ).rejects.toThrow()
    await expect(
      store().removeForUser(a.environmentId, userId, broken(userId, 'user.passkey_removed'))
    ).rejects.toThrow()
    expect(await store().listForUser(a.environmentId, userId)).toEqual([record])
  })

  test('a passkey for a user who does not exist is refused as over the limit, not stored', async () => {
    expect(await store().create(passkey(Bun.randomUUIDv7()), 10)).toBe('limit')
  })

  test('deleting a user removes their passkeys and challenges', async () => {
    const userId = await suiteTenant(a).user()
    await store().create(passkey(userId), 10)
    await store().putChallenge({
      id: Bun.randomUUIDv7(),
      projectId: a.projectId,
      environmentId: a.environmentId,
      userId,
      sessionId: Bun.randomUUIDv7(),
      purpose: 'step_up',
      challenge: 'challenge',
      expiresAt: new Date(now.getTime() + 300_000),
      createdAt: now,
    })
    await withTenant(testDb.db, a.environmentId, (tx) =>
      tx.delete(users).where(eq(users.id, userId))
    )
    expect(await store().listForUser(a.environmentId, userId)).toEqual([])
    expect(
      await withTenant(testDb.db, a.environmentId, (tx) =>
        tx.select().from(passkeyChallenges).where(eq(passkeyChallenges.userId, userId))
      )
    ).toEqual([])
  })

  test('without a tenant scope the runtime role sees no passkey and no challenge', async () => {
    const userId = await suiteTenant(a).user()
    await store().create(passkey(userId), 10)
    expect(await testDb.db.select().from(passkeys).where(eq(passkeys.userId, userId))).toEqual([])
    expect(await testDb.db.select().from(passkeyChallenges)).toEqual([])
    expect(
      await withTenant(testDb.db, b.environmentId, (tx) =>
        tx.select().from(passkeys).where(eq(passkeys.userId, userId))
      )
    ).toEqual([])
  })

  test('unlinking an identity counts the user’s passkeys among what remains', async () => {
    const userId = await suiteTenant(a).user()
    await store().create(passkey(userId), 10)
    await store().create(passkey(userId), 10)
    const repository = new PostgresUserRepository(testDb.db)
    const identity = {
      id: Bun.randomUUIDv7(),
      projectId: a.projectId,
      environmentId: a.environmentId,
      userId,
      provider: 'google' as const,
      subject: `subject-${userId}`,
      createdAt: now,
    }
    expect(await repository.linkIdentity(identity)).toBe('linked')
    let seen: unknown
    await repository.unlinkIdentity(a.environmentId, userId, identity.id, (remaining) => {
      seen = remaining
      return false
    })
    expect(seen).toEqual({ hasPassword: false, emailVerified: false, providers: [], passkeys: 2 })
  })
})
