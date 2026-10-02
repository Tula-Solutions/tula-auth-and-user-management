import { beforeEach, describe, expect, test } from 'bun:test'
import type { Tenant } from '~/dependencies'
import { RateLimitError, ServiceException } from '~/exceptions'
import * as Passwords from '~/modules/password/service'
import * as Sessions from '~/modules/session/service'
import * as Users from '~/modules/user/service'
import { CREDENTIAL_LOCKOUT } from '~/ports/lockout'
import { createTestDeps, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'

const tenant: Tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}
const otherTenant: Tenant = { ...tenant, environmentId: TEST_TENANT.productionEnvironmentId }
const PASSWORD = 'correct horse battery staple'
const NEW_PASSWORD = 'an entirely new passphrase'
const MISSING = '00000000-0000-7000-8000-00000000dead'
let deps: TestDeps

beforeEach(() => {
  deps = createTestDeps()
  for (const [id, kind] of [
    [TEST_TENANT.environmentId, 'development'],
    [TEST_TENANT.productionEnvironmentId, 'production'],
  ] as const) {
    deps.environments.add({
      id,
      projectId: TEST_TENANT.projectId,
      kind,
      createdAt: deps.clock.now(),
    })
  }
})

async function rejection(promise: Promise<unknown>): Promise<ServiceException> {
  try {
    await promise
  } catch (err) {
    if (err instanceof ServiceException) {
      return err
    }
    throw err
  }
  throw new Error('expected a rejection')
}

const create = (overrides: Partial<Parameters<typeof Users.create>[2]> = {}) =>
  Users.create(
    deps,
    tenant,
    { email: 'Maya@Northline.app', password: PASSWORD, ...overrides },
    TEST_ACTOR
  )

const signIn = (userId: string) =>
  Sessions.create(deps, tenant, { userId, client: 'web', userAgent: null, ipAddress: null })

const session = (id: string) => deps.sessions.findById(tenant.environmentId, id)

async function storedPassword(email = 'maya@northline.app') {
  return (
    (await deps.users.findByEmailWithPassword(tenant.environmentId, email))?.passwordHash ?? null
  )
}

describe('create', () => {
  test('creates an unverified user with a hashed password and returns no credentials', async () => {
    const user = await create({ firstName: ' Maya ', lastName: 'Okafor' })
    expect(user).toEqual({
      id: expect.any(String),
      email: 'Maya@Northline.app',
      emailVerifiedAt: null,
      firstName: 'Maya',
      lastName: 'Okafor',
      bannedAt: null,
      lastSignInAt: null,
      createdAt: deps.clock.now().toISOString(),
    })
    const hash = await storedPassword()
    expect(hash?.startsWith('$argon2id$')).toBe(true)
    expect(await Passwords.verify(hash, PASSWORD)).toBe(true)
    expect(JSON.stringify(user)).not.toContain('argon2')
  })

  test('can mark the email as already verified', async () => {
    const user = await create({ emailVerified: true })
    expect(user.emailVerifiedAt).toBe(deps.clock.now().toISOString())
  })

  test('refuses an email that is already taken, in any letter case', async () => {
    await create()
    const err = await rejection(create({ email: ' maya@NORTHLINE.app ' }))
    expect(err.status).toBe(409)
    expect(err.code).toBe('resource.conflict')
  })

  test('the same email can be created in another environment', async () => {
    await create()
    const twin = await Users.create(
      deps,
      otherTenant,
      {
        email: 'maya@northline.app',
        password: PASSWORD,
      },
      TEST_ACTOR
    )
    expect(twin.id).toBeString()
  })

  test.each([
    ['an invalid email', { email: 'nope' }, 'email.invalid', 'email'],
    ['a weak password', { password: 'short' }, 'password.too_short', 'password'],
    [
      'a password containing their name',
      { password: 'okafor-is-my-surname', lastName: 'Okafor' },
      'password.contains_user_info',
      'password',
    ],
  ])('rejects %s with a field error and creates nothing', async (_name, input, code, field) => {
    const err = await rejection(create(input))
    expect(err.status).toBe(422)
    expect(err.code).toBe(code as never)
    expect(err.errors?.[0]).toMatchObject({ field, code })
    expect((await Users.list(deps, tenant, {})).meta.totalCount).toBe(0)
  })
})

describe('get', () => {
  test('returns the user', async () => {
    const user = await create()
    expect(await Users.get(deps, tenant, user.id)).toEqual(user)
  })

  test.each([
    ['an unknown id', () => Users.get(deps, tenant, MISSING)],
    ['another environment', async () => Users.get(deps, otherTenant, (await create()).id)],
  ])('answers 404 for %s', async (_name, call) => {
    const err = await rejection(call())
    expect(err.status).toBe(404)
    expect(err.code).toBe('resource.not_found')
  })
})

describe('list', () => {
  test('pages through users with payhub-style meta', async () => {
    for (let i = 0; i < 5; i++) {
      deps.clock.advance(1_000)
      await create({ email: `user-${i}@northline.app` })
    }
    const first = await Users.list(deps, tenant, { size: 2 })
    expect(first.meta).toEqual({ totalCount: 5, totalPages: 3, page: 1, perPage: 2 })
    expect(first.data.map((u) => u.email)).toEqual(['user-4@northline.app', 'user-3@northline.app'])
    const last = await Users.list(deps, tenant, { size: 2, page: 3 })
    expect(last.data.map((u) => u.email)).toEqual(['user-0@northline.app'])
    expect(last.meta.page).toBe(3)
  })

  test('defaults to 20 per page, newest first, and reports an empty list correctly', async () => {
    expect(await Users.list(deps, tenant, {})).toEqual({
      meta: { totalCount: 0, totalPages: 0, page: 1, perPage: 20 },
      data: [],
    })
  })

  test('searches and sorts', async () => {
    await create({ email: 'zoe@northline.app', firstName: 'Zoe' })
    await create({ email: 'adam@northline.app', firstName: 'Adam' })
    await create({ email: 'other@elsewhere.test' })
    const found = await Users.list(deps, tenant, { q: 'NORTHLINE', sort: 'email' })
    expect(found.data.map((u) => u.email)).toEqual(['adam@northline.app', 'zoe@northline.app'])
    expect(found.meta.totalCount).toBe(2)
    expect((await Users.list(deps, otherTenant, {})).meta.totalCount).toBe(0)
  })
})

describe('ban / unban', () => {
  test('banning ends every session and blocks refresh', async () => {
    const user = await create()
    const tokens = [await signIn(user.id), await signIn(user.id)]
    const banned = await Users.ban(deps, tenant, user.id, TEST_ACTOR)
    expect(banned.bannedAt).toBe(deps.clock.now().toISOString())
    for (const { sessionId, refreshToken } of tokens) {
      expect(await session(sessionId)).toMatchObject({ revokeReason: 'user_banned' })
      expect(await deps.revokedSessions.has(sessionId, deps.clock.now())).toBe(true)
      expect((await rejection(Sessions.refresh(deps, tenant, refreshToken ?? ''))).status).toBe(401)
    }
  })

  test('banning twice keeps the first ban time', async () => {
    const user = await create()
    const first = await Users.ban(deps, tenant, user.id, TEST_ACTOR)
    deps.clock.advance('1h')
    expect((await Users.ban(deps, tenant, user.id, TEST_ACTOR)).bannedAt).toBe(first.bannedAt)
  })

  test('unbanning lets the user have sessions again', async () => {
    const user = await create()
    await Users.ban(deps, tenant, user.id, TEST_ACTOR)
    const unbanned = await Users.unban(deps, tenant, user.id, TEST_ACTOR)
    expect(unbanned.bannedAt).toBeNull()
    const tokens = await signIn(user.id)
    expect((await Sessions.refresh(deps, tenant, tokens.refreshToken ?? '')).sessionId).toBe(
      tokens.sessionId
    )
  })

  test('unbanning a user who is not banned leaves their sessions alone', async () => {
    const user = await create()
    const tokens = await signIn(user.id)
    expect((await Users.unban(deps, tenant, user.id, TEST_ACTOR)).bannedAt).toBeNull()
    expect((await session(tokens.sessionId))?.revokedAt).toBeNull()
    expect(await deps.revokedSessions.has(tokens.sessionId, deps.clock.now())).toBe(false)
  })

  test('a session that slipped in during the ban does not survive an unban', async () => {
    const user = await create()
    await Users.ban(deps, tenant, user.id, TEST_ACTOR)
    // A sign-in that passed its ban check just before the ban landed creates its session now.
    const stray = await signIn(user.id)
    await Users.unban(deps, tenant, user.id, TEST_ACTOR)
    const err = await rejection(Sessions.refresh(deps, tenant, stray.refreshToken ?? ''))
    expect(err.code).toBe('session.revoked')
    expect(await deps.revokedSessions.has(stray.sessionId, deps.clock.now())).toBe(true)
  })

  test.each([
    ['ban', (id: string, t: Tenant) => Users.ban(deps, t, id, TEST_ACTOR)],
    ['unban', (id: string, t: Tenant) => Users.unban(deps, t, id, TEST_ACTOR)],
  ])('%s answers 404 for unknown users and other environments', async (_name, call) => {
    const user = await create()
    expect((await rejection(call(MISSING, tenant))).status).toBe(404)
    expect((await rejection(call(user.id, otherTenant))).status).toBe(404)
    expect((await Users.get(deps, tenant, user.id)).bannedAt).toBeNull()
  })
})

describe('remove', () => {
  test('ends the user’s sessions, then deletes them', async () => {
    const user = await create()
    const tokens = await signIn(user.id)
    await Users.remove(deps, tenant, user.id, TEST_ACTOR)
    expect(await deps.revokedSessions.has(tokens.sessionId, deps.clock.now())).toBe(true)
    expect((await session(tokens.sessionId))?.revokedAt).not.toBeNull()
    expect((await rejection(Users.get(deps, tenant, user.id))).status).toBe(404)
    // The address is free again.
    expect((await create()).id).not.toBe(user.id)
  })

  test('answers 404 for unknown users and other environments', async () => {
    const user = await create()
    expect((await rejection(Users.remove(deps, tenant, MISSING, TEST_ACTOR))).status).toBe(404)
    expect((await rejection(Users.remove(deps, otherTenant, user.id, TEST_ACTOR))).status).toBe(404)
    expect((await Users.get(deps, tenant, user.id)).id).toBe(user.id)
  })
})

describe('setPassword (admin)', () => {
  test('replaces the password and ends every session', async () => {
    const user = await create()
    const tokens = [await signIn(user.id), await signIn(user.id)]
    await Users.setPassword(deps, tenant, user.id, NEW_PASSWORD, TEST_ACTOR)

    const hash = await storedPassword()
    expect(await Passwords.verify(hash, NEW_PASSWORD)).toBe(true)
    expect(await Passwords.verify(hash, PASSWORD)).toBe(false)
    for (const { sessionId } of tokens) {
      expect(await session(sessionId)).toMatchObject({ revokeReason: 'password_changed' })
      expect(await deps.revokedSessions.has(sessionId, deps.clock.now())).toBe(true)
    }
  })

  test('enforces the password policy against the user’s details and changes nothing on failure', async () => {
    const user = await create({ firstName: 'Maya', lastName: 'Okafor' })
    const tokens = await signIn(user.id)
    const err = await rejection(
      Users.setPassword(deps, tenant, user.id, 'okafor-okafor-okafor', TEST_ACTOR)
    )
    expect(err.code).toBe('password.contains_user_info')
    expect(await Passwords.verify(await storedPassword(), PASSWORD)).toBe(true)
    expect((await session(tokens.sessionId))?.revokedAt).toBeNull()
  })

  test('does not report success, or end sessions, when no password was stored', async () => {
    const user = await create()
    const tokens = await signIn(user.id)
    deps.users.setPasswordHash = async () => false
    const err = await rejection(Users.setPassword(deps, tenant, user.id, NEW_PASSWORD, TEST_ACTOR))
    expect(err.status).toBe(409)
    expect((await session(tokens.sessionId))?.revokedAt).toBeNull()
  })

  test('answers 404 for unknown users and other environments', async () => {
    const user = await create()
    expect(
      (await rejection(Users.setPassword(deps, tenant, MISSING, NEW_PASSWORD, TEST_ACTOR))).status
    ).toBe(404)
    expect(
      (await rejection(Users.setPassword(deps, otherTenant, user.id, NEW_PASSWORD, TEST_ACTOR)))
        .status
    ).toBe(404)
  })
})

describe('changePassword (own)', () => {
  async function setup() {
    const user = await create()
    const current = await signIn(user.id)
    const other = await signIn(user.id)
    const change = (currentPassword: string, newPassword: string) =>
      Users.changePassword(
        deps,
        tenant,
        { userId: user.id, sessionId: current.sessionId },
        { currentPassword, newPassword }
      )
    return { user, current, other, change }
  }

  test('changes the password, keeps this device and signs the others out', async () => {
    const { current, other, change } = await setup()
    await change(PASSWORD, NEW_PASSWORD)

    expect(await Passwords.verify(await storedPassword(), NEW_PASSWORD)).toBe(true)
    expect((await session(current.sessionId))?.revokedAt).toBeNull()
    expect(await deps.revokedSessions.has(current.sessionId, deps.clock.now())).toBe(false)
    expect(await session(other.sessionId)).toMatchObject({ revokeReason: 'password_changed' })
    expect(await deps.revokedSessions.has(other.sessionId, deps.clock.now())).toBe(true)
  })

  test('a wrong current password is a generic failure and changes nothing', async () => {
    const { other, change } = await setup()
    const err = await rejection(change('not my password', NEW_PASSWORD))
    expect(err.status).toBe(401)
    expect(err.code).toBe('auth.invalid_credentials')
    expect(await Passwords.verify(await storedPassword(), PASSWORD)).toBe(true)
    expect((await session(other.sessionId))?.revokedAt).toBeNull()
  })

  test('a weak new password is explained and changes nothing', async () => {
    const { other, change } = await setup()
    const err = await rejection(change(PASSWORD, 'short'))
    expect(err.code).toBe('password.too_short')
    expect(await Passwords.verify(await storedPassword(), PASSWORD)).toBe(true)
    expect((await session(other.sessionId))?.revokedAt).toBeNull()
  })

  test('wrong guesses at the current password back off, per user', async () => {
    const { change } = await setup()
    for (let i = 0; i <= CREDENTIAL_LOCKOUT.freeAttempts; i++) {
      expect((await rejection(change('not my password', NEW_PASSWORD))).code).toBe(
        'auth.invalid_credentials'
      )
    }
    const locked = await rejection(change(PASSWORD, NEW_PASSWORD))
    expect(locked).toBeInstanceOf(RateLimitError)
    expect(locked.params).toEqual({ retryAfter: 30 })
    deps.clock.advance('30s')
    await change(PASSWORD, NEW_PASSWORD)
    expect(await Passwords.verify(await storedPassword(), NEW_PASSWORD)).toBe(true)
  })

  test('successful changes do not use up the tries', async () => {
    const { change } = await setup()
    let current = PASSWORD
    for (let i = 0; i < CREDENTIAL_LOCKOUT.freeAttempts + 3; i++) {
      const next = `a brand new passphrase number ${i}`
      await change(current, next)
      current = next
    }
    expect(await Passwords.verify(await storedPassword(), current)).toBe(true)
  })

  test('a weak new password does not count as a wrong guess', async () => {
    const { change } = await setup()
    for (let i = 0; i < CREDENTIAL_LOCKOUT.freeAttempts + 3; i++) {
      expect((await rejection(change(PASSWORD, 'short'))).code).toBe('password.too_short')
    }
  })

  test('a user who no longer exists gets the generic failure', async () => {
    const err = await rejection(
      Users.changePassword(
        deps,
        tenant,
        { userId: MISSING, sessionId: MISSING },
        { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }
      )
    )
    expect(err.code).toBe('auth.invalid_credentials')
  })
})

describe('me', () => {
  test('returns the signed-in user, or 404 if they were deleted', async () => {
    const user = await create()
    expect(await Users.me(deps, tenant, user.id)).toEqual(user)
    await Users.remove(deps, tenant, user.id, TEST_ACTOR)
    expect((await rejection(Users.me(deps, tenant, user.id))).status).toBe(404)
  })
})

describe('activity', () => {
  const recorded = () => deps.activityLog.entries.map((entry) => entry.type)
  const about = (userId: string) =>
    deps.activityLog.entries
      .filter((entry) => entry.target.id === userId)
      .map((entry) => entry.type)

  test('creating a user records who did it; a taken email records nothing', async () => {
    const user = await create({ emailVerified: true })
    expect(deps.activityLog.entries).toEqual([
      {
        id: expect.any(String),
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        type: 'user.created',
        actor: { type: 'admin', id: TEST_ACTOR.id },
        target: { type: 'user', id: user.id },
        ipAddress: TEST_ACTOR.ipAddress,
        userAgent: TEST_ACTOR.userAgent,
        data: { method: 'admin', emailVerified: true },
        occurredAt: deps.clock.now(),
      },
    ])
    await rejection(create())
    await rejection(create({ email: 'other@northline.app', password: 'short' }))
    expect(recorded()).toEqual(['user.created'])
  })

  test('a ban records the ban and each session it ended; repeating it records nothing', async () => {
    const user = await create()
    const tokens = await signIn(user.id)
    await Users.ban(deps, tenant, user.id, TEST_ACTOR)
    await Users.ban(deps, tenant, user.id, TEST_ACTOR)
    expect(about(user.id)).toEqual(['user.created', 'user.banned'])
    expect(deps.activityLog.ofType('session.revoked')).toMatchObject([
      {
        actor: { type: 'admin', id: TEST_ACTOR.id },
        target: { type: 'session', id: tokens.sessionId },
        data: { userId: user.id, reason: 'user_banned' },
      },
    ])
  })

  test('lifting a ban is recorded; unbanning someone who is not banned is not', async () => {
    const user = await create()
    await Users.unban(deps, tenant, user.id, TEST_ACTOR)
    expect(about(user.id)).toEqual(['user.created'])
    await Users.ban(deps, tenant, user.id, TEST_ACTOR)
    await Users.unban(deps, tenant, user.id, TEST_ACTOR)
    await Users.unban(deps, tenant, user.id, TEST_ACTOR)
    expect(about(user.id)).toEqual(['user.created', 'user.banned', 'user.unbanned'])
  })

  test('deleting a user is recorded, and their history stays readable', async () => {
    const user = await create()
    await signIn(user.id)
    await Users.remove(deps, tenant, user.id, TEST_ACTOR)
    await rejection(Users.remove(deps, tenant, user.id, TEST_ACTOR))
    await rejection(Users.remove(deps, tenant, MISSING, TEST_ACTOR))
    expect(recorded()).toEqual([
      'user.created',
      'session.created',
      'session.revoked',
      'user.deleted',
    ])
    expect(deps.activityLog.ofType('user.deleted')).toMatchObject([
      { actor: { type: 'admin', id: TEST_ACTOR.id }, target: { type: 'user', id: user.id } },
    ])
  })

  test('an admin reset is recorded as such; a rejected password is not', async () => {
    const user = await create()
    await rejection(Users.setPassword(deps, tenant, user.id, 'short', TEST_ACTOR))
    await rejection(Users.setPassword(deps, tenant, MISSING, NEW_PASSWORD, TEST_ACTOR))
    expect(recorded()).toEqual(['user.created'])
    await Users.setPassword(deps, tenant, user.id, NEW_PASSWORD, TEST_ACTOR)
    expect(deps.activityLog.ofType('user.password_changed')).toMatchObject([
      {
        actor: { type: 'admin', id: TEST_ACTOR.id },
        target: { type: 'user', id: user.id },
        data: { method: 'admin_reset' },
      },
    ])
  })

  test('a user changing their own password is the actor, from their own address', async () => {
    const user = await create()
    const current = await signIn(user.id)
    const other = await signIn(user.id)
    const self = { userId: user.id, sessionId: current.sessionId }
    const origin = { ipAddress: '198.51.100.4', userAgent: 'Mozilla/5.0' }
    await rejection(
      Users.changePassword(
        deps,
        tenant,
        self,
        { currentPassword: 'not the password', newPassword: NEW_PASSWORD },
        origin
      )
    )
    expect(deps.activityLog.ofType('user.password_changed')).toEqual([])

    await Users.changePassword(
      deps,
      tenant,
      self,
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      origin
    )
    expect(deps.activityLog.ofType('user.password_changed')).toMatchObject([
      { actor: { type: 'user', id: user.id }, ...origin, data: { method: 'self' } },
    ])
    expect(deps.activityLog.ofType('session.revoked')).toMatchObject([
      {
        actor: { type: 'user', id: user.id },
        target: { type: 'session', id: other.sessionId },
        ...origin,
        data: { userId: user.id, reason: 'password_changed' },
      },
    ])
  })

  test('no password, hash or email address ever reaches the record', async () => {
    const user = await create({ firstName: 'Maya' })
    await Users.setPassword(deps, tenant, user.id, NEW_PASSWORD, TEST_ACTOR)
    const written = JSON.stringify(deps.activityLog.entries).toLowerCase()
    for (const secret of [PASSWORD, NEW_PASSWORD, 'northline', 'maya', '$argon2']) {
      expect(written).not.toContain(secret.toLowerCase())
    }
  })
})
