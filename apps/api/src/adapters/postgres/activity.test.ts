import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { AUDIT_ACTOR_TYPES as CONTRACT_ACTOR_TYPES } from '@tula/contract'
import { AUDIT_ACTOR_TYPES, auditLogs, events, withTenant } from '@tula/db'
import {
  createTestDatabase,
  createTestTenant,
  queryRows,
  type TestDatabase,
  type TestTenant,
} from '@tula/db/testing'
import { eq, sql } from 'drizzle-orm'
import { describeActivityLog } from '~/adapters/activity-log.suite'
import { PostgresActivityLog, recordActivity } from '~/adapters/postgres/activity'
import { PostgresApiKeyRepository } from '~/adapters/postgres/api-keys'
import { PostgresSessionStore } from '~/adapters/postgres/sessions'
import { PostgresSigningKeyStore } from '~/adapters/postgres/signing-keys'
import { PostgresUserRepository } from '~/adapters/postgres/users'
import { cleanOrigin } from '~/lib/actor'
import { sha256Hex } from '~/lib/crypto'
import type { Activity } from '~/ports/activity-log'

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

const scope = (tenant: TestTenant) => ({
  projectId: tenant.projectId,
  environmentId: tenant.environmentId,
})

describeActivityLog('Postgres stores', async () => ({
  log: new PostgresActivityLog(testDb.db),
  sessions: new PostgresSessionStore(testDb.db),
  users: new PostgresUserRepository(testDb.db),
  apiKeys: new PostgresApiKeyRepository(testDb.db),
  signingKeys: new PostgresSigningKeyStore(testDb.db),
  a: scope(a),
  b: scope(b),
  freshTenant: async () => scope(await createTestTenant(testDb.db)),
}))

function activity(tenant: TestTenant, overrides: Partial<Activity> = {}): Activity {
  return {
    id: Bun.randomUUIDv7(),
    ...scope(tenant),
    type: 'user.created',
    actor: { type: 'admin', id: '00000000-0000-7000-8000-0000000000ad' },
    target: { type: 'user', id: Bun.randomUUIDv7() },
    ipAddress: '203.0.113.7',
    userAgent: 'suite/1.0',
    data: { method: 'admin' },
    occurredAt: now,
    ...overrides,
  }
}

function newUser(tenant: TestTenant) {
  const id = Bun.randomUUIDv7()
  return {
    id,
    ...scope(tenant),
    email: `${id}@northline.app`,
    emailNormalized: `${id}@northline.app`,
    emailVerifiedAt: null,
    firstName: null,
    lastName: null,
    createdAt: now,
    identityId: Bun.randomUUIDv7(),
    credentialId: Bun.randomUUIDv7(),
    passwordHash: '$argon2id$hash',
  }
}

describe('the event outbox', () => {
  test('every activity is also an undelivered event with the same id, without the origin', async () => {
    const user = newUser(a)
    const entry = activity(a, { target: { type: 'user', id: user.id } })
    await new PostgresUserRepository(testDb.db).createWithPassword(user, entry)
    const [event] = await withTenant(testDb.db, a.environmentId, (tx) =>
      tx.select().from(events).where(eq(events.id, entry.id))
    )
    expect(event).toMatchObject({
      id: entry.id,
      type: 'user.created',
      environmentId: a.environmentId,
      occurredAt: now,
      deliveredAt: null,
      payload: { actor: entry.actor, target: entry.target, data: { method: 'admin' } },
    })
    // Webhook payloads must not carry the caller's IP address or user agent.
    expect(JSON.stringify(event?.payload)).not.toContain('203.0.113.7')
    expect(JSON.stringify(event?.payload)).not.toContain('suite/1.0')
  })

  test('records more entries than fit in one statement (one user with thousands of sessions)', async () => {
    const userId = Bun.randomUUIDv7()
    // 6,000 rows x 12 audit columns is past Postgres's 65,535 bind parameters per statement.
    const many = Array.from({ length: 6_000 }, () =>
      activity(a, { type: 'session.revoked', actor: { type: 'admin', id: userId } })
    )
    await withTenant(testDb.db, a.environmentId, (tx) => recordActivity(tx, many))
    const { totalCount } = await new PostgresActivityLog(testDb.db).listAudit(a.environmentId, {
      actorId: userId,
      page: 1,
      size: 1,
    })
    expect(totalCount).toBe(6_000)
    const outbox = await withTenant(testDb.db, a.environmentId, (tx) =>
      tx.select({ id: events.id }).from(events).where(eq(events.type, 'session.revoked'))
    )
    expect(outbox.length).toBeGreaterThanOrEqual(6_000)
  })

  test('recording nothing touches neither table', async () => {
    await withTenant(testDb.db, a.environmentId, (tx) => recordActivity(tx, []))
  })
})

describe('atomicity', () => {
  // An `inet` column rejects this, which makes the activity insert fail after the real write.
  const broken = (tenant: TestTenant, id: string) =>
    activity(tenant, { ipAddress: 'not-an-ip', target: { type: 'user', id } })

  test('a user is not created when its record cannot be written', async () => {
    const users = new PostgresUserRepository(testDb.db)
    const user = newUser(a)
    await expect(users.createWithPassword(user, broken(a, user.id))).rejects.toThrow()
    expect(await users.findById(a.environmentId, user.id)).toBeNull()
    // And the email is still free: the identity and credential rolled back too.
    expect(await users.createWithPassword(user)).toBe(true)
  })

  test('a user is not deleted, banned or re-passworded when the record cannot be written', async () => {
    const users = new PostgresUserRepository(testDb.db)
    const user = newUser(a)
    await users.createWithPassword(user)
    const env = a.environmentId
    await expect(users.delete(env, user.id, broken(a, user.id))).rejects.toThrow()
    await expect(users.setBanned(env, user.id, now, now, broken(a, user.id))).rejects.toThrow()
    await expect(
      users.setPasswordHash(env, user.id, '$argon2id$new', now, broken(a, user.id))
    ).rejects.toThrow()
    await expect(users.markEmailVerified(env, user.id, now, broken(a, user.id))).rejects.toThrow()
    const found = await users.findByEmailWithPassword(env, user.emailNormalized)
    expect(found?.user).toMatchObject({ id: user.id, bannedAt: null, emailVerifiedAt: null })
    expect(found?.passwordHash).toBe('$argon2id$hash')
  })

  test('a session is neither created nor revoked when the record cannot be written', async () => {
    const users = new PostgresUserRepository(testDb.db)
    const sessions = new PostgresSessionStore(testDb.db)
    const user = newUser(a)
    await users.createWithPassword(user)
    const session = (id: string) => ({
      id,
      ...scope(a),
      userId: user.id,
      profile: 'web',
      client: 'web' as const,
      userAgent: null,
      ipAddress: null,
      lastActiveAt: now,
      idleExpiresAt: new Date(now.getTime() + 60_000),
      absoluteExpiresAt: null,
      createdAt: now,
    })
    const token = (sessionId: string) => ({
      id: Bun.randomUUIDv7(),
      sessionId,
      tokenHash: sha256Hex(sessionId),
      parentId: null,
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
    })
    const lost = Bun.randomUUIDv7()
    await expect(sessions.create(session(lost), token(lost), broken(a, lost))).rejects.toThrow()
    expect(await sessions.findById(a.environmentId, lost)).toBeNull()

    const kept = Bun.randomUUIDv7()
    await sessions.create(session(kept), token(kept))
    await expect(
      sessions.revoke(a.environmentId, kept, 'sign_out', now, broken(a, kept))
    ).rejects.toThrow()
    await expect(
      sessions.revokeByUser(a.environmentId, user.id, 'user_banned', now, {
        activity: (id) => broken(a, id),
      })
    ).rejects.toThrow()
    expect((await sessions.findById(a.environmentId, kept))?.revokedAt).toBeNull()
  })

  test('an API key is neither created nor revoked when the record cannot be written', async () => {
    const keys = new PostgresApiKeyRepository(testDb.db)
    const key = (id: string) => ({
      id,
      kind: 'secret' as const,
      name: 'Server',
      ...scope(a),
      lastFour: 'abcd',
      createdAt: now,
      keyHash: sha256Hex(id),
    })
    const lost = Bun.randomUUIDv7()
    await expect(keys.insert(key(lost), broken(a, lost))).rejects.toThrow()
    expect(await keys.findByHash(sha256Hex(lost))).toBeNull()

    const kept = Bun.randomUUIDv7()
    await keys.insert(key(kept))
    await expect(keys.revoke(a.environmentId, kept, now, broken(a, kept))).rejects.toThrow()
    expect((await keys.findByHash(sha256Hex(kept)))?.revokedAt).toBeNull()
  })
})

describe('the audit log is append-only and tenant-scoped', () => {
  test('the runtime role can neither change nor delete an entry', async () => {
    const user = newUser(a)
    const entry = activity(a, { target: { type: 'user', id: user.id } })
    await new PostgresUserRepository(testDb.db).createWithPassword(user, entry)
    await expect(
      withTenant(testDb.db, a.environmentId, (tx) =>
        tx.update(auditLogs).set({ action: 'forged' }).where(eq(auditLogs.id, entry.id))
      )
    ).rejects.toThrow()
    await expect(
      withTenant(testDb.db, a.environmentId, (tx) =>
        tx.delete(auditLogs).where(eq(auditLogs.id, entry.id))
      )
    ).rejects.toThrow()
    const { entries } = await new PostgresActivityLog(testDb.db).listAudit(a.environmentId, {
      targetId: user.id,
      page: 1,
      size: 10,
    })
    expect(entries.map((found) => found.type)).toEqual(['user.created'])
  })

  test('an activity for another environment cannot be written from this one', async () => {
    await expect(
      withTenant(testDb.db, a.environmentId, (tx) => recordActivity(tx, [activity(b)]))
    ).rejects.toThrow()
  })

  test('an entry without a target (written by other tooling) reads back with a null target', async () => {
    const id = Bun.randomUUIDv7()
    await withTenant(testDb.db, a.environmentId, (tx) =>
      tx.insert(auditLogs).values({ id, ...scope(a), actorType: 'system', action: 'custom.thing' })
    )
    const { entries } = await new PostgresActivityLog(testDb.db).listAudit(a.environmentId, {
      page: 1,
      size: 100,
    })
    expect(entries.find((entry) => entry.id === id)).toMatchObject({
      type: 'custom.thing',
      target: null,
      actor: { type: 'system', id: null },
      ipAddress: null,
      data: {},
    })
  })
})

test('an origin the service accepts is always one the audit column accepts', async () => {
  // Everything `cleanOrigin` lets through must insert; anything else would undo a real change.
  const candidates = ['203.0.113.7', '2001:db8::1', '::ffff:203.0.113.7', 'fe80::1%eth0', '::1']
  const entries = candidates.map((ipAddress) => activity(a, cleanOrigin({ ipAddress })))
  await withTenant(testDb.db, a.environmentId, (tx) => recordActivity(tx, entries))
  expect(entries.map((entry) => entry.ipAddress)).toEqual([
    '203.0.113.7',
    '2001:db8::1',
    '::ffff:203.0.113.7',
    null,
    '::1',
  ])
})

test('the audit log has an index for each filter', async () => {
  await testDb.setRole('postgres')
  const rows = await queryRows<{ indexname: string }>(
    testDb.db,
    sql`select indexname from pg_indexes where schemaname = 'tula' and tablename = 'audit_logs'`
  )
  await testDb.setRole('tula_app')
  expect(rows.map((row) => row.indexname)).toEqual(
    expect.arrayContaining([
      'audit_logs_environment_target_idx',
      'audit_logs_environment_actor_idx',
    ])
  )
})

test('the contract and the schema agree on who can act', () => {
  expect([...CONTRACT_ACTOR_TYPES]).toEqual([...AUDIT_ACTOR_TYPES])
})
