import { beforeEach, describe, expect, test } from 'bun:test'
import {
  durationToMs,
  environmentIssuer,
  REFRESH_TOKEN_PREFIX,
  type SessionTokens,
} from '@tula/contract'
import type { Tenant } from '~/dependencies'
import { ServiceException } from '~/exceptions'
import { MAX_USER_AGENT_LENGTH } from '~/lib/actor'
import { sha256Hex } from '~/lib/crypto'
import { verifyAccessToken } from '~/middleware/session-auth'
import * as Sessions from '~/modules/session/service'
import { authenticatedAt, mergeAuthMethods } from '~/ports/session-store'
import { createTestDeps, TEST_ACTOR, TEST_CONFIG, TEST_TENANT, type TestDeps } from '~/testing'

const DAY = 86_400_000
const tenant: Tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}
const otherTenant: Tenant = { ...tenant, environmentId: TEST_TENANT.productionEnvironmentId }
const USER = '00000000-0000-7000-8000-0000000000a1'
const OTHER_USER = '00000000-0000-7000-8000-0000000000a2'
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

function create(overrides: Partial<Sessions.CreateInput> = {}): Promise<SessionTokens> {
  return Sessions.create(deps, tenant, {
    userId: USER,
    client: 'web',
    userAgent: 'Mozilla/5.0',
    ipAddress: '203.0.113.7',
    ...overrides,
  })
}

/** The refresh token of freshly issued tokens (always present from the service). */
function rt(tokens: SessionTokens): string {
  if (!tokens.refreshToken) {
    throw new Error('expected a refresh token')
  }
  return tokens.refreshToken
}

const refresh = (token: string, t: Tenant = tenant) => Sessions.refresh(deps, t, token)

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

const session = (id: string) => deps.sessions.findById(tenant.environmentId, id)

describe('create', () => {
  test('issues a 60-second EdDSA access token with the contract claims', async () => {
    const tokens = await create()
    const claims = await verifyAccessToken(deps, tokens.accessToken, tenant)
    const iat = Math.floor(deps.clock.now().getTime() / 1000)
    expect(claims).toEqual({
      iss: environmentIssuer(TEST_CONFIG.publicUrl, tenant.environmentId),
      sub: USER,
      aud: tenant.environmentId,
      sid: tokens.sessionId,
      pid: tenant.projectId,
      eid: tenant.environmentId,
      iat,
      exp: iat + 60,
      v: 1,
      auth_time: iat,
      amr: [],
    })
    expect(tokens.accessTokenExpiresAt).toBe(new Date((iat + 60) * 1000).toISOString())
  })

  test('stores the refresh token only as a SHA-256 hash', async () => {
    const tokens = await create()
    const token = rt(tokens)
    expect(token.startsWith(REFRESH_TOKEN_PREFIX)).toBe(true)
    expect(token.length).toBeGreaterThan(REFRESH_TOKEN_PREFIX.length + 40)
    const found = await deps.sessions.findToken(tenant.environmentId, sha256Hex(token))
    expect(found?.session.id).toBe(tokens.sessionId)
    expect(found?.token).toMatchObject({ parentId: null, usedAt: null, replacedById: null })
    expect(JSON.stringify(found)).not.toContain(token.slice(REFRESH_TOKEN_PREFIX.length))
  })

  test('records the device with idle and absolute expiry from the profile', async () => {
    const tokens = await create({ client: 'ios' })
    const now = deps.clock.now()
    expect(await session(tokens.sessionId)).toMatchObject({
      userId: USER,
      profile: 'web',
      client: 'ios',
      userAgent: 'Mozilla/5.0',
      ipAddress: '203.0.113.7',
      lastActiveAt: now,
      idleExpiresAt: new Date(now.getTime() + 7 * DAY),
      absoluteExpiresAt: new Date(now.getTime() + 30 * DAY),
      revokedAt: null,
    })
  })

  test('drops an unusable IP and truncates a huge user agent instead of failing', async () => {
    const tokens = await create({ ipAddress: 'unknown', userAgent: 'x'.repeat(5_000) })
    const stored = await session(tokens.sessionId)
    expect(stored?.ipAddress).toBeNull()
    expect(stored?.userAgent?.length).toBe(MAX_USER_AGENT_LENGTH)
    const v6 = await create({ ipAddress: '2001:db8::1' })
    expect((await session(v6.sessionId))?.ipAddress).toBe('2001:db8::1')
  })

  test('each session gets its own tokens', async () => {
    const [first, second] = [await create(), await create()]
    expect(first.sessionId).not.toBe(second.sessionId)
    expect(rt(first)).not.toBe(rt(second))
  })
})

describe('refresh', () => {
  test('rotates: a new refresh token, a new access token, the old one marked used', async () => {
    const first = await create()
    deps.clock.advance('30s')
    const second = await refresh(rt(first))

    expect(second.sessionId).toBe(first.sessionId)
    expect(rt(second)).not.toBe(rt(first))
    expect(second.accessToken).not.toBe(first.accessToken)
    const claims = await verifyAccessToken(deps, second.accessToken, tenant)
    expect(claims).toMatchObject({ sub: USER, sid: first.sessionId })

    const parent = await deps.sessions.findToken(tenant.environmentId, sha256Hex(rt(first)))
    const child = await deps.sessions.findToken(tenant.environmentId, sha256Hex(rt(second)))
    expect(parent?.token.usedAt).toEqual(deps.clock.now())
    expect(parent?.token.replacedById).toBe(child?.token.id ?? '')
    expect(child?.token).toMatchObject({ parentId: parent?.token.id, usedAt: null })
  })

  test('extends the idle expiry and keeps working down a long chain', async () => {
    let tokens = await create()
    for (let i = 0; i < 4; i++) {
      deps.clock.advance('6d')
      tokens = await refresh(rt(tokens))
    }
    const stored = await session(tokens.sessionId)
    expect(stored?.lastActiveAt).toEqual(deps.clock.now())
    // 24 days in: the idle window would reach day 31, but the absolute limit is day 30.
    expect(stored?.idleExpiresAt).toEqual(stored?.absoluteExpiresAt ?? new Date(0))
  })

  test('idle timeout: unused for 7 days means signed out, one millisecond less does not', async () => {
    const live = await create()
    deps.clock.advance(7 * DAY - 1)
    const rotated = await refresh(rt(live))

    deps.clock.advance(7 * DAY)
    const err = await rejection(refresh(rt(rotated)))
    expect(err.status).toBe(401)
    expect(err.code).toBe('session.expired')
  })

  test('absolute timeout ends even an active session at 30 days', async () => {
    let tokens = await create()
    for (let i = 0; i < 4; i++) {
      deps.clock.advance('6d')
      tokens = await refresh(rt(tokens))
    }
    deps.clock.advance(6 * DAY - 1)
    tokens = await refresh(rt(tokens))
    deps.clock.advance(1)
    expect((await rejection(refresh(rt(tokens)))).code).toBe('session.expired')
  })

  test('reusing a rotated token after the grace window revokes the whole session', async () => {
    const first = await create()
    const second = await refresh(rt(first))
    deps.clock.advance(Sessions.profile().refresh.reuseGracePeriod)

    const err = await rejection(refresh(rt(first)))
    expect(err.status).toBe(401)
    expect(err.code).toBe('session.reuse_detected')
    expect(await session(first.sessionId)).toMatchObject({
      revokedAt: deps.clock.now(),
      revokeReason: 'reuse_detected',
    })
    // The legitimate holder of the newest token is signed out too, and told why.
    expect((await rejection(refresh(rt(second)))).code).toBe('session.reuse_detected')
    expect(await deps.revokedSessions.has(first.sessionId, deps.clock.now())).toBe(true)
  })

  test('replaying a rotated token is reuse even after that token’s own expiry date', async () => {
    // The stolen root token "expires" on day 7, but the session is kept alive by its owner.
    const first = await create()
    let live = first
    for (let i = 0; i < 2; i++) {
      deps.clock.advance('6d')
      live = await refresh(rt(live))
    }
    const err = await rejection(refresh(rt(first)))
    expect(err.code).toBe('session.reuse_detected')
    expect((await session(first.sessionId))?.revokeReason).toBe('reuse_detected')
    expect((await rejection(refresh(rt(live)))).code).toBe('session.reuse_detected')
  })

  test('within the grace window a retry gets the same child token, never a new one', async () => {
    const first = await create()
    const second = await refresh(rt(first))
    deps.clock.advance(durationToMs(Sessions.profile().refresh.reuseGracePeriod) - 1)

    const retry = await refresh(rt(first))
    expect(rt(retry)).toBe(rt(second))
    expect(retry.sessionId).toBe(first.sessionId)
    await verifyAccessToken(deps, retry.accessToken, tenant)
    // Nothing new was minted and the session is intact.
    const child = await deps.sessions.findToken(tenant.environmentId, sha256Hex(rt(second)))
    expect(child?.token).toMatchObject({ usedAt: null, replacedById: null })
    expect((await session(first.sessionId))?.revokedAt).toBeNull()
    // The child still rotates normally afterwards.
    expect(rt(await refresh(rt(second)))).not.toBe(rt(second))
  })

  test('a grace retry is refused once the child itself was rotated', async () => {
    const first = await create()
    const second = await refresh(rt(first))
    await refresh(rt(second))
    // Still inside the grace window of the first rotation, but the chain has moved on.
    const err = await rejection(refresh(rt(first)))
    expect(err.code).toBe('session.reuse_detected')
    expect((await session(first.sessionId))?.revokeReason).toBe('reuse_detected')
  })

  test('concurrent refreshes with one token all get the same child and mint it once', async () => {
    const first = await create()
    const results = await Promise.all(Array.from({ length: 6 }, () => refresh(rt(first))))
    expect(new Set(results.map(rt)).size).toBe(1)
    const child = await deps.sessions.findToken(tenant.environmentId, sha256Hex(rt(results[0]!)))
    expect(child?.token.parentId).not.toBeNull()
    expect((await session(first.sessionId))?.revokedAt).toBeNull()
  })

  test.each([
    ['garbage', 'not-a-token'],
    ['an unknown token', `${REFRESH_TOKEN_PREFIX}${'0'.repeat(64)}`],
    ['an empty string', ''],
  ])('rejects %s as session.invalid_token', async (_name, token) => {
    await create()
    const err = await rejection(refresh(token))
    expect(err.status).toBe(401)
    expect(err.code).toBe('session.invalid_token')
  })

  test('a refresh token does not work in another environment', async () => {
    const first = await create()
    expect((await rejection(refresh(rt(first), otherTenant))).code).toBe('session.invalid_token')
    // The foreign attempt neither rotated nor revoked it.
    expect((await refresh(rt(first))).sessionId).toBe(first.sessionId)
  })

  test('a banned user cannot refresh, and the attempt ends their session', async () => {
    await deps.users.create({
      id: USER,
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      email: 'maya@northline.app',
      emailNormalized: 'maya@northline.app',
      emailVerifiedAt: deps.clock.now(),
      firstName: null,
      lastName: null,
      createdAt: deps.clock.now(),
      identityId: 'i1',
      credentialId: 'c1',
      passwordHash: 'hash',
    })
    const first = await create()
    expect((await refresh(rt(first))).sessionId).toBe(first.sessionId)

    const second = await create()
    await deps.users.setBanned(tenant.environmentId, USER, deps.clock.now(), deps.clock.now())
    const err = await rejection(refresh(rt(second)))
    expect(err.status).toBe(403)
    expect(err.code).toBe('auth.user_banned')
    expect(await session(second.sessionId)).toMatchObject({ revokeReason: 'user_banned' })
    expect(await deps.revokedSessions.has(second.sessionId, deps.clock.now())).toBe(true)
  })

  test('a revoked session cannot be refreshed', async () => {
    const first = await create()
    await Sessions.revoke(deps, tenant, {
      userId: USER,
      sessionId: first.sessionId,
      actor: TEST_ACTOR,
    })
    const err = await rejection(refresh(rt(first)))
    expect(err.status).toBe(401)
    expect(err.code).toBe('session.revoked')
  })
})

describe('list', () => {
  test("returns the user's active sessions, newest activity first, marking the current one", async () => {
    const first = await create({ client: 'web' })
    deps.clock.advance('1h')
    const second = await create({ client: 'ios', userAgent: null, ipAddress: null })
    const revoked = await create()
    await Sessions.revoke(deps, tenant, {
      userId: USER,
      sessionId: revoked.sessionId,
      actor: TEST_ACTOR,
    })
    await create({ userId: OTHER_USER })

    const list = await Sessions.list(deps, tenant, {
      userId: USER,
      currentSessionId: first.sessionId,
    })
    expect(list.map((s) => [s.id, s.current, s.client])).toEqual([
      [second.sessionId, false, 'ios'],
      [first.sessionId, true, 'web'],
    ])
    expect(list[1]).toEqual({
      id: first.sessionId,
      client: 'web',
      userAgent: 'Mozilla/5.0',
      ipAddress: '203.0.113.7',
      createdAt: new Date(deps.clock.now().getTime() - 3_600_000).toISOString(),
      lastActiveAt: new Date(deps.clock.now().getTime() - 3_600_000).toISOString(),
      expiresAt: new Date(deps.clock.now().getTime() - 3_600_000 + 7 * DAY).toISOString(),
      current: true,
    })
    expect(JSON.stringify(list)).not.toContain(REFRESH_TOKEN_PREFIX)
  })
})

describe('revoke', () => {
  test('ends the session and denylists it until its access token would expire', async () => {
    const tokens = await create()
    await Sessions.revoke(deps, tenant, {
      userId: USER,
      sessionId: tokens.sessionId,
      actor: TEST_ACTOR,
    })
    expect(await session(tokens.sessionId)).toMatchObject({
      revokedAt: deps.clock.now(),
      revokeReason: 'revoked_by_user',
    })
    expect(await deps.revokedSessions.has(tokens.sessionId, deps.clock.now())).toBe(true)
    deps.clock.advance('60s')
    expect(await deps.revokedSessions.has(tokens.sessionId, deps.clock.now())).toBe(false)
  })

  test.each([
    [
      'revoke',
      (id: string) =>
        Sessions.revoke(deps, tenant, { userId: USER, sessionId: id, actor: TEST_ACTOR }),
    ],
    [
      'revokeOthers',
      () =>
        Sessions.revokeOthers(deps, tenant, {
          userId: USER,
          currentSessionId: 'none',
          actor: TEST_ACTOR,
        }),
    ],
    [
      'revokeAllForUser',
      () => Sessions.revokeAllForUser(deps, tenant, USER, 'user_banned', TEST_ACTOR),
    ],
  ])('%s: a denylist failure never leaves a revoked session un-denylisted', async (_name, run) => {
    const tokens = await create()
    const add = deps.revokedSessions.add.bind(deps.revokedSessions)
    let failures = 1
    deps.revokedSessions.add = async (id, until) => {
      if (failures > 0) {
        failures -= 1
        throw new Error('denylist unavailable')
      }
      await add(id, until)
    }
    await expect(run(tokens.sessionId)).rejects.toThrow('denylist unavailable')
    // Whatever state the failure left behind, the retry ends with both halves done.
    await run(tokens.sessionId)
    expect((await session(tokens.sessionId))?.revokedAt).not.toBeNull()
    expect(await deps.revokedSessions.has(tokens.sessionId, deps.clock.now())).toBe(true)
  })

  test('signOut: a denylist failure never leaves a revoked session un-denylisted', async () => {
    const tokens = await create()
    const add = deps.revokedSessions.add.bind(deps.revokedSessions)
    let failures = 1
    deps.revokedSessions.add = async (id, until) => {
      if (failures > 0) {
        failures -= 1
        throw new Error('denylist unavailable')
      }
      await add(id, until)
    }
    await expect(Sessions.signOut(deps, tenant, rt(tokens))).rejects.toThrow('denylist unavailable')
    await Sessions.signOut(deps, tenant, rt(tokens))
    expect((await session(tokens.sessionId))?.revokeReason).toBe('sign_out')
    expect(await deps.revokedSessions.has(tokens.sessionId, deps.clock.now())).toBe(true)
  })

  test('is idempotent and records the given reason', async () => {
    const tokens = await create()
    const input = {
      userId: USER,
      sessionId: tokens.sessionId,
      reason: 'sign_out' as const,
      actor: TEST_ACTOR,
    }
    await Sessions.revoke(deps, tenant, input)
    await Sessions.revoke(deps, tenant, {
      ...input,
      reason: 'revoked_by_user',
    })
    expect((await session(tokens.sessionId))?.revokeReason).toBe('sign_out')
  })

  test.each([
    ['another user’s session', () => ({ userId: OTHER_USER })],
    ['a session in another environment', () => ({ tenant: otherTenant })],
    ['an unknown session', () => ({ sessionId: '00000000-0000-7000-8000-00000000dead' })],
  ])('refuses %s with resource.not_found', async (_name, change) => {
    const tokens = await create()
    const { tenant: t = tenant, ...input } = {
      userId: USER,
      sessionId: tokens.sessionId,
      actor: TEST_ACTOR,
      ...(change() as { userId?: string; sessionId?: string; tenant?: Tenant }),
    }
    const err = await rejection(Sessions.revoke(deps, t, input))
    expect(err.status).toBe(404)
    expect((await session(tokens.sessionId))?.revokedAt).toBeNull()
  })
})

describe('revokeOthers / revokeAllForUser', () => {
  test('revokeOthers signs out every other device and keeps the current one', async () => {
    const current = await create()
    const others = [await create(), await create()]
    const bystander = await create({ userId: OTHER_USER })

    const count = await Sessions.revokeOthers(deps, tenant, {
      userId: USER,
      currentSessionId: current.sessionId,
      actor: TEST_ACTOR,
    })
    expect(count).toBe(2)
    expect((await session(current.sessionId))?.revokedAt).toBeNull()
    expect((await session(bystander.sessionId))?.revokedAt).toBeNull()
    for (const other of others) {
      expect((await session(other.sessionId))?.revokeReason).toBe('revoked_by_user')
      expect(await deps.revokedSessions.has(other.sessionId, deps.clock.now())).toBe(true)
      expect((await rejection(refresh(rt(other)))).code).toBe('session.revoked')
    }
  })

  test('revokeOthers never denylists the session that asked', async () => {
    const current = await create()
    await create()
    await Sessions.revokeOthers(deps, tenant, {
      userId: USER,
      currentSessionId: current.sessionId,
      actor: TEST_ACTOR,
    })
    expect(await deps.revokedSessions.has(current.sessionId, deps.clock.now())).toBe(false)
    await verifyAccessToken(deps, current.accessToken, tenant)
  })

  test('if the store fails after the denylist write, the error surfaces and a retry completes', async () => {
    // Fail-safe direction: the session is briefly denied, never left revoked-but-usable.
    const tokens = await create()
    const revokeByUser = deps.sessions.revokeByUser.bind(deps.sessions)
    let failures = 1
    deps.sessions.revokeByUser = async (...args) => {
      if (failures > 0) {
        failures -= 1
        throw new Error('database unavailable')
      }
      return revokeByUser(...args)
    }
    await expect(
      Sessions.revokeAllForUser(deps, tenant, USER, 'user_banned', TEST_ACTOR)
    ).rejects.toThrow('database unavailable')
    expect((await session(tokens.sessionId))?.revokedAt).toBeNull()
    expect(await deps.revokedSessions.has(tokens.sessionId, deps.clock.now())).toBe(true)

    expect(await Sessions.revokeAllForUser(deps, tenant, USER, 'user_banned', TEST_ACTOR)).toBe(1)
    expect((await session(tokens.sessionId))?.revokeReason).toBe('user_banned')
  })

  test('revokeAllForUser ends every session with the given reason', async () => {
    const all = [await create(), await create()]
    expect(
      await Sessions.revokeAllForUser(deps, tenant, USER, 'password_changed', TEST_ACTOR)
    ).toBe(2)
    for (const tokens of all) {
      expect((await session(tokens.sessionId))?.revokeReason).toBe('password_changed')
      expect(await deps.revokedSessions.has(tokens.sessionId, deps.clock.now())).toBe(true)
    }
    expect(
      await Sessions.revokeAllForUser(deps, tenant, USER, 'password_changed', TEST_ACTOR)
    ).toBe(0)
  })
})

describe('signOut', () => {
  test('ends the session the refresh token belongs to', async () => {
    const tokens = await create()
    await Sessions.signOut(deps, tenant, rt(tokens))
    expect((await session(tokens.sessionId))?.revokeReason).toBe('sign_out')
    expect(await deps.revokedSessions.has(tokens.sessionId, deps.clock.now())).toBe(true)
    expect((await rejection(refresh(rt(tokens)))).code).toBe('session.revoked')
  })

  test('an already-rotated token still signs its session out', async () => {
    const first = await create()
    await refresh(rt(first))
    await Sessions.signOut(deps, tenant, rt(first))
    expect((await session(first.sessionId))?.revokeReason).toBe('sign_out')
  })

  test.each([
    ['no token', undefined],
    ['an unknown token', `${REFRESH_TOKEN_PREFIX}nope`],
  ])('is a silent no-op with %s', async (_name, token) => {
    const tokens = await create()
    await Sessions.signOut(deps, tenant, token)
    expect((await session(tokens.sessionId))?.revokedAt).toBeNull()
  })

  test('does not sign out a session from another environment', async () => {
    const tokens = await create()
    await Sessions.signOut(deps, otherTenant, rt(tokens))
    expect((await session(tokens.sessionId))?.revokedAt).toBeNull()
  })
})

describe('activity', () => {
  const user = (origin = {}) => ({
    type: 'user' as const,
    id: USER,
    ipAddress: '198.51.100.4',
    userAgent: 'Mozilla/5.0',
    ...origin,
  })
  const recorded = () => deps.activityLog.entries.map((entry) => entry.type)

  test('a new session is recorded with the user as actor and a cleaned origin', async () => {
    const tokens = await create({ ipAddress: 'unknown', userAgent: 'x'.repeat(5_000) })
    expect(deps.activityLog.entries).toEqual([
      {
        id: expect.any(String),
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        type: 'session.created',
        actor: { type: 'user', id: USER },
        target: { type: 'session', id: tokens.sessionId },
        ipAddress: null,
        userAgent: 'x'.repeat(MAX_USER_AGENT_LENGTH),
        data: { userId: USER, client: 'web' },
        occurredAt: deps.clock.now(),
      },
    ])
  })

  test('refreshing, and a retry inside the grace window, record nothing', async () => {
    const tokens = await create()
    await refresh(rt(tokens))
    await refresh(rt(tokens))
    expect(recorded()).toEqual(['session.created'])
  })

  test('a replayed token is recorded as session.reuse_detected by the system, from the replay’s origin', async () => {
    const tokens = await create()
    await refresh(rt(tokens))
    deps.clock.advance('11s')
    const replay = Sessions.refresh(deps, tenant, rt(tokens), {
      ipAddress: '198.51.100.66',
      userAgent: 'curl/8',
    })
    expect((await rejection(replay)).code).toBe('session.reuse_detected')
    expect(deps.activityLog.ofType('session.reuse_detected')).toEqual([
      {
        id: expect.any(String),
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        type: 'session.reuse_detected',
        actor: { type: 'system', id: null },
        target: { type: 'session', id: tokens.sessionId },
        ipAddress: '198.51.100.66',
        userAgent: 'curl/8',
        data: { userId: USER, reason: 'reuse_detected' },
        occurredAt: deps.clock.now(),
      },
    ])
    // Presenting it yet again finds the session already revoked: nothing more is recorded.
    await rejection(refresh(rt(tokens)))
    expect(recorded()).toEqual(['session.created', 'session.reuse_detected'])
  })

  test('a banned user’s refresh records the revocation as the system’s', async () => {
    await deps.users.create({
      id: USER,
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      email: 'maya@northline.app',
      emailNormalized: 'maya@northline.app',
      emailVerifiedAt: null,
      firstName: null,
      lastName: null,
      createdAt: deps.clock.now(),
      identityId: deps.ids.next(),
      credentialId: deps.ids.next(),
      passwordHash: 'hash',
    })
    const tokens = await create()
    await deps.users.setBanned(tenant.environmentId, USER, deps.clock.now(), deps.clock.now())
    expect((await rejection(refresh(rt(tokens)))).code).toBe('auth.user_banned')
    expect(deps.activityLog.ofType('session.revoked')).toMatchObject([
      {
        actor: { type: 'system', id: null },
        target: { type: 'session', id: tokens.sessionId },
        data: { userId: USER, reason: 'user_banned' },
      },
    ])
  })

  test('revoking records who ended the session and why, once', async () => {
    const tokens = await create()
    const input = { userId: USER, sessionId: tokens.sessionId, actor: user() }
    await Sessions.revoke(deps, tenant, input)
    await Sessions.revoke(deps, tenant, input)
    expect(deps.activityLog.ofType('session.revoked')).toMatchObject([
      {
        actor: { type: 'user', id: USER },
        target: { type: 'session', id: tokens.sessionId },
        ipAddress: '198.51.100.4',
        userAgent: 'Mozilla/5.0',
        data: { userId: USER, reason: 'revoked_by_user' },
      },
    ])
    // Someone else's session is not found, and trying leaves no record.
    const theirs = await create({ userId: OTHER_USER })
    await rejection(Sessions.revoke(deps, tenant, { ...input, sessionId: theirs.sessionId }))
    expect(deps.activityLog.ofType('session.revoked')).toHaveLength(1)
  })

  test('ending a user’s sessions records one entry per session that ended', async () => {
    const current = await create()
    const others = [await create(), await create()]
    const bystander = await create({ userId: OTHER_USER })
    await Sessions.revokeOthers(deps, tenant, {
      userId: USER,
      currentSessionId: current.sessionId,
      actor: user(),
    })
    const ended = deps.activityLog.ofType('session.revoked')
    expect(ended.map((entry) => entry.target.id).sort()).toEqual(
      others.map((tokens) => tokens.sessionId).sort()
    )
    expect(new Set(ended.map((entry) => entry.id)).size).toBe(2)

    await Sessions.revokeAllForUser(deps, tenant, USER, 'password_changed', TEST_ACTOR)
    const last = deps.activityLog.ofType('session.revoked').at(-1)
    expect(last).toMatchObject({
      actor: { type: 'admin', id: TEST_ACTOR.id },
      target: { type: 'session', id: current.sessionId },
      ipAddress: TEST_ACTOR.ipAddress,
      data: { userId: USER, reason: 'password_changed' },
    })
    expect(
      deps.activityLog.entries.some(
        (entry) => entry.type !== 'session.created' && entry.target.id === bystander.sessionId
      )
    ).toBe(false)
  })

  test('signing out records the session’s user; an unknown token records nothing', async () => {
    const tokens = await create()
    await Sessions.signOut(deps, tenant, 'tula_rt_unknown', { ipAddress: '198.51.100.4' })
    await Sessions.signOut(deps, tenant, undefined)
    expect(recorded()).toEqual(['session.created'])
    await Sessions.signOut(deps, tenant, rt(tokens), {
      ipAddress: '198.51.100.4',
      userAgent: 'Mozilla/5.0',
    })
    expect(deps.activityLog.ofType('session.revoked')).toMatchObject([
      {
        actor: { type: 'user', id: USER },
        ipAddress: '198.51.100.4',
        userAgent: 'Mozilla/5.0',
        data: { userId: USER, reason: 'sign_out' },
      },
    ])
  })

  test('no token ever reaches the record', async () => {
    const tokens = await create()
    const next = await refresh(rt(tokens))
    await Sessions.signOut(deps, tenant, rt(next))
    const written = JSON.stringify(deps.activityLog.entries)
    for (const secret of [rt(tokens), rt(next), tokens.accessToken, sha256Hex(rt(tokens))]) {
      expect(written).not.toContain(secret)
    }
  })
})

describe('when the signing key cannot be loaded', () => {
  /** Make the key store fail until the returned function is called. */
  function breakKeyStore() {
    const list = deps.signingKeys.list.bind(deps.signingKeys)
    deps.signingKeys.list = async () => {
      throw new Error('key store unavailable')
    }
    return () => {
      deps.signingKeys.list = list
    }
  }

  test('no session is created, so nothing is left that nobody holds a token for', async () => {
    const restore = breakKeyStore()
    await expect(create()).rejects.toThrow('key store unavailable')
    restore()
    expect(
      await deps.sessions.listActiveByUser(tenant.environmentId, USER, deps.clock.now())
    ).toEqual([])
    expect(deps.activityLog.entries).toEqual([])
  })

  test('a refresh fails before rotating, so the same token still works afterwards', async () => {
    const tokens = await create()
    const restore = breakKeyStore()
    await expect(refresh(rt(tokens))).rejects.toThrow('key store unavailable')
    restore()
    // Well past the grace period: had the token been rotated, this retry would be "reuse" and
    // would sign the user out.
    deps.clock.advance('5m')
    const next = await refresh(rt(tokens))
    expect(next.sessionId).toBe(tokens.sessionId)
    expect(rt(next)).not.toBe(rt(tokens))
    expect(deps.activityLog.ofType('session.reuse_detected')).toEqual([])
    expect((await session(tokens.sessionId))?.revokedAt).toBeNull()
  })
})

describe('what a session has proven (auth_time and amr)', () => {
  const seconds = (date: Date) => Math.floor(date.getTime() / 1000)
  const claimsOf = (tokens: SessionTokens) => verifyAccessToken(deps, tokens.accessToken, tenant)

  test('a session records the methods it was created with, once each, and when', async () => {
    const tokens = await create({ authMethods: ['pwd', 'otp', 'mfa', 'otp'] })
    expect(await session(tokens.sessionId)).toMatchObject({
      factorVerifiedAt: deps.clock.now(),
      authMethods: ['pwd', 'otp', 'mfa'],
    })
    expect(await claimsOf(tokens)).toMatchObject({
      auth_time: seconds(deps.clock.now()),
      amr: ['pwd', 'otp', 'mfa'],
    })
  })

  test('a session created without methods has proven none', async () => {
    const tokens = await create()
    expect((await session(tokens.sessionId))?.authMethods).toEqual([])
    expect((await claimsOf(tokens)).amr).toEqual([])
  })

  test('a refresh, and a replay inside the grace window, repeat the session’s claims', async () => {
    const tokens = await create({ authMethods: ['pwd'] })
    const issued = seconds(deps.clock.now())
    deps.clock.advance('2h')
    const refreshed = await refresh(rt(tokens))
    expect(await claimsOf(refreshed)).toMatchObject({ auth_time: issued, amr: ['pwd'] })
    deps.clock.advance('5s')
    const replayed = await refresh(rt(tokens))
    expect(await claimsOf(replayed)).toMatchObject({ auth_time: issued, amr: ['pwd'] })
  })

  test('recordAuthentication moves auth_time, adds the methods and returns no refresh token', async () => {
    const tokens = await create({ authMethods: ['pwd'] })
    deps.clock.advance('20m')
    const actor = { type: 'user', id: USER, ipAddress: '203.0.113.9', userAgent: 'app/1' } as const
    const stepped = await Sessions.recordAuthentication(
      deps,
      tenant,
      { userId: USER, sessionId: tokens.sessionId },
      ['otp', 'mfa'],
      actor
    )
    expect(Object.keys(stepped).sort()).toEqual([
      'accessToken',
      'accessTokenExpiresAt',
      'sessionId',
    ])
    expect(await claimsOf(stepped as SessionTokens)).toMatchObject({
      sid: tokens.sessionId,
      auth_time: seconds(deps.clock.now()),
      amr: ['pwd', 'otp', 'mfa'],
    })
    expect(deps.activityLog.ofType('session.stepped_up')).toEqual([
      expect.objectContaining({
        actor: { type: 'user', id: USER },
        target: { type: 'session', id: tokens.sessionId },
        ipAddress: '203.0.113.9',
        userAgent: 'app/1',
        data: { userId: USER, methods: ['otp', 'mfa'] },
      }),
    ])
    // Not a rotation: the session's refresh token still works, and carries the new claims.
    const refreshed = await refresh(rt(tokens))
    expect((await claimsOf(refreshed)).amr).toEqual(['pwd', 'otp', 'mfa'])
  })

  test('recordAuthentication refuses a session that is not this user’s, not this environment’s, or has ended', async () => {
    const mine = await create({ authMethods: ['pwd'] })
    const theirs = await create({ userId: OTHER_USER, authMethods: ['pwd'] })
    const ended = await create({ authMethods: ['pwd'] })
    await Sessions.revoke(deps, tenant, {
      userId: USER,
      sessionId: ended.sessionId,
      actor: TEST_ACTOR,
    })
    const record = (sessionId: string, scope: Tenant = tenant) =>
      Sessions.recordAuthentication(deps, scope, { userId: USER, sessionId }, ['otp', 'mfa'], {
        ...TEST_ACTOR,
        type: 'user',
        id: USER,
      })
    for (const refused of [
      () => record(theirs.sessionId),
      () => record(ended.sessionId),
      () => record(mine.sessionId, otherTenant),
      () => record('00000000-0000-7000-8000-00000000dead'),
    ]) {
      const err = await rejection(refused())
      expect(err.toJSON()).toMatchObject({ status: 401, code: 'session.revoked' })
    }
    for (const untouched of [mine, theirs, ended]) {
      expect((await session(untouched.sessionId))?.authMethods).toEqual(['pwd'])
    }
    expect(deps.activityLog.ofType('session.stepped_up')).toEqual([])
  })

  test('a session stored before proofs were recorded counts as authenticated when it was created', () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z')
    const stepUp = new Date('2026-01-02T00:00:00.000Z')
    expect(authenticatedAt({ factorVerifiedAt: null, createdAt })).toEqual(createdAt)
    expect(authenticatedAt({ factorVerifiedAt: stepUp, createdAt })).toEqual(stepUp)
  })

  test('methods merge without duplicates, the earlier ones first', () => {
    expect(mergeAuthMethods([], [])).toEqual([])
    expect(mergeAuthMethods(['pwd'], ['otp', 'mfa'])).toEqual(['pwd', 'otp', 'mfa'])
    expect(mergeAuthMethods(['pwd', 'otp', 'mfa'], ['backup_code', 'mfa', 'pwd'])).toEqual([
      'pwd',
      'otp',
      'mfa',
      'backup_code',
    ])
    const current = ['pwd']
    mergeAuthMethods(current, ['otp'])
    expect(current).toEqual(['pwd'])
  })
})
