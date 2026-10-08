import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  durationToMs,
  EnvironmentSettingsSchema,
  MAX_ACCESS_TOKEN_TTL,
  type SessionSettings,
} from '@tula/contract'
import type { Tenant } from '~/dependencies'
import { ServiceException } from '~/exceptions'
import { verifyAccessToken } from '~/middleware/session-auth'
import * as Audit from '~/modules/audit/service'
import * as Sessions from '~/modules/session/service'
import { createTestDeps, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'

const tenant: Tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}
const otherTenant: Tenant = { ...tenant, environmentId: TEST_TENANT.productionEnvironmentId }
const USER = '00000000-0000-7000-8000-0000000000a1'
const OTHER_USER = '00000000-0000-7000-8000-0000000000a2'
let deps: TestDeps
let revision = 0

beforeEach(() => {
  deps = createTestDeps()
  revision = 0
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

/** Save a `sessions` section for the test environment (validated like a real document). */
function configure(sessions: unknown, target: Tenant = tenant): SessionSettings {
  const settings = EnvironmentSettingsSchema.parse({ ...DEFAULT_ENVIRONMENT_SETTINGS, sessions })
  revision += 1
  deps.environmentSettings.seed(target.environmentId, { revision, settings })
  return settings.sessions
}

function create(overrides: Partial<Sessions.CreateInput> = {}): Promise<Sessions.IssuedSession> {
  return Sessions.create(deps, tenant, { userId: USER, client: 'web', ...overrides })
}

function rt(tokens: Sessions.IssuedSession): string {
  if (!tokens.refreshToken) {
    throw new Error('expected a refresh token')
  }
  return tokens.refreshToken
}

function at(tokens: Sessions.IssuedSession): string {
  if (!tokens.accessToken) {
    throw new Error('expected an access token')
  }
  return tokens.accessToken
}

function st(tokens: Sessions.IssuedSession): string {
  if (!tokens.sessionToken) {
    throw new Error('expected a session token')
  }
  return tokens.sessionToken
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ServiceException) {
      return error.code
    }
    throw error
  }
  throw new Error('expected a rejection')
}

const stored = (id: string) => deps.sessions.findById(tenant.environmentId, id)
const live = (userId = USER) =>
  deps.sessions.listActiveByUser(tenant.environmentId, userId, deps.clock.now())

describe('a session gets the profile of its client kind', () => {
  test('web for a browser, mobile for a native app, each with its own limits', async () => {
    configure({
      profiles: {
        web: { idleTimeout: '1h', absoluteTimeout: '8h', accessTokenTtl: '2m' },
        mobile: { idleTimeout: '30d', absoluteTimeout: null, accessTokenTtl: '5m' },
      },
    })
    const now = deps.clock.now().getTime()
    const web = await create()
    const ios = await create({ client: 'ios' })
    const [webRow, iosRow] = [await stored(web.sessionId), await stored(ios.sessionId)]
    expect(webRow).toMatchObject({ profile: 'web', type: 'hybrid' })
    expect(webRow?.idleExpiresAt.getTime()).toBe(now + durationToMs('1h'))
    expect(webRow?.absoluteExpiresAt?.getTime()).toBe(now + durationToMs('8h'))
    expect(iosRow).toMatchObject({ profile: 'mobile', type: 'hybrid', absoluteExpiresAt: null })
    expect(iosRow?.idleExpiresAt.getTime()).toBe(now + durationToMs('30d'))
    expect(new Date(web.accessTokenExpiresAt ?? 0).getTime()).toBe(now + durationToMs('2m'))
    expect(new Date(ios.accessTokenExpiresAt ?? 0).getTime()).toBe(now + durationToMs('5m'))
  })

  test('the access token names the profile and lives as long as the profile says', async () => {
    configure({ profiles: { web: { accessTokenTtl: '5m' } } })
    const tokens = await create()
    const claims = await verifyAccessToken(deps, at(tokens), tenant)
    expect(claims.sp).toBe('web')
    expect(claims.exp - claims.iat).toBe(300)
    deps.clock.advance('4m')
    expect((await verifyAccessToken(deps, at(tokens), tenant)).sid).toBe(tokens.sessionId)
    deps.clock.advance('61s')
    expect(await code(verifyAccessToken(deps, at(tokens), tenant))).toBe('session.expired')
  })

  test('an environment that saved nothing behaves as before profiles', async () => {
    const now = deps.clock.now().getTime()
    const tokens = await create({ client: 'android' })
    const row = await stored(tokens.sessionId)
    expect(row?.idleExpiresAt.getTime()).toBe(now + durationToMs('7d'))
    expect(row?.absoluteExpiresAt?.getTime()).toBe(now + durationToMs('30d'))
    expect(new Date(tokens.accessTokenExpiresAt ?? 0).getTime()).toBe(now + 60_000)
  })
})

describe('a client asking for a profile', () => {
  beforeEach(() => {
    configure({
      profiles: {
        admin: { idleTimeout: '15m', absoluteTimeout: '8h', clientSelectable: true },
        forever: { idleTimeout: '365d', absoluteTimeout: null },
        cookie: { type: 'stateful', clientSelectable: true },
      },
    })
  })

  test('gets it when the environment offers it', async () => {
    const tokens = await create({ profile: 'admin' })
    expect((await stored(tokens.sessionId))?.profile).toBe('admin')
    expect((await verifyAccessToken(deps, at(tokens), tenant)).sp).toBe('admin')
  })

  test.each([
    ['one the operator did not offer', 'forever'],
    ['one that does not exist', 'nope'],
    ['an inherited object key', 'constructor'],
    ['the other kind’s built-in', 'mobile'],
  ])('never gets %s: the session is an ordinary web one', async (_name, profile) => {
    const tokens = await create({ profile })
    const row = await stored(tokens.sessionId)
    expect(row?.profile).toBe('web')
    expect(row?.absoluteExpiresAt?.getTime()).toBe(deps.clock.now().getTime() + durationToMs('30d'))
  })

  test('a native client asking for a stateful profile gets a hybrid mobile session', async () => {
    const tokens = await create({ client: 'ios', profile: 'cookie' })
    expect(await stored(tokens.sessionId)).toMatchObject({ profile: 'mobile', type: 'hybrid' })
    expect(tokens.accessToken).toBeDefined()
    expect(tokens.refreshToken).toBeDefined()
    expect(tokens.sessionToken).toBeUndefined()
  })
})

describe('profile limits are read as configured now', () => {
  test('the idle timeout of the profile applies at each refresh', async () => {
    configure({ profiles: { web: { idleTimeout: '1h', absoluteTimeout: '8h' } } })
    const first = await create()
    deps.clock.advance('59m')
    const second = await Sessions.refresh(deps, tenant, rt(first))
    deps.clock.advance('1h')
    expect(await code(Sessions.refresh(deps, tenant, rt(second)))).toBe('session.expired')
  })

  test('the absolute timeout ends an active session', async () => {
    configure({ profiles: { web: { idleTimeout: '1h', absoluteTimeout: '2h' } } })
    let tokens = await create()
    for (let i = 0; i < 3; i++) {
      deps.clock.advance('30m')
      tokens = await Sessions.refresh(deps, tenant, rt(tokens))
    }
    deps.clock.advance('30m')
    expect(await code(Sessions.refresh(deps, tenant, rt(tokens)))).toBe('session.expired')
  })

  test('tightening the absolute timeout ends an over-age session at its next refresh', async () => {
    const tokens = await create()
    deps.clock.advance('2h')
    configure({ profiles: { web: { idleTimeout: '30m', absoluteTimeout: '1h' } } })
    expect(await code(Sessions.refresh(deps, tenant, rt(tokens)))).toBe('session.expired')
  })

  test('tightening the idle timeout ends a session that has been idle longer', async () => {
    const tokens = await create()
    deps.clock.advance('20m')
    configure({ profiles: { web: { idleTimeout: '10m' } } })
    expect(await code(Sessions.refresh(deps, tenant, rt(tokens)))).toBe('session.expired')
  })

  test('a session inside the tightened limits carries on, under the new ones', async () => {
    const tokens = await create()
    deps.clock.advance('5m')
    configure({ profiles: { web: { idleTimeout: '10m', absoluteTimeout: '1h' } } })
    const next = await Sessions.refresh(deps, tenant, rt(tokens))
    const row = await stored(tokens.sessionId)
    expect(row?.idleExpiresAt.getTime()).toBe(deps.clock.now().getTime() + durationToMs('10m'))
    deps.clock.advance('11m')
    expect(await code(Sessions.refresh(deps, tenant, rt(next)))).toBe('session.expired')
  })

  test('loosening never extends a session past the absolute limit it was created with', async () => {
    configure({ profiles: { web: { idleTimeout: '1h', absoluteTimeout: '1h' } } })
    const tokens = await create()
    configure({ profiles: { web: { idleTimeout: '7d', absoluteTimeout: '30d' } } })
    deps.clock.advance('30m')
    const next = await Sessions.refresh(deps, tenant, rt(tokens))
    deps.clock.advance('31m')
    expect(await code(Sessions.refresh(deps, tenant, rt(next)))).toBe('session.expired')
  })

  test('a session whose profile was deleted falls back to its kind’s built-in', async () => {
    configure({ profiles: { admin: { idleTimeout: '15m', clientSelectable: true } } })
    const tokens = await create({ profile: 'admin' })
    configure({ profiles: { web: { idleTimeout: '1h' } } })
    deps.clock.advance('10m')
    // From this refresh on the session lives by `web`: an hour idle, not admin's 15 minutes.
    const second = await Sessions.refresh(deps, tenant, rt(tokens))
    deps.clock.advance('50m')
    const third = await Sessions.refresh(deps, tenant, rt(second))
    deps.clock.advance('61m')
    expect(await code(Sessions.refresh(deps, tenant, rt(third)))).toBe('session.expired')
  })

  test('a new access token takes the lifetime the profile has now', async () => {
    const tokens = await create()
    configure({ profiles: { web: { accessTokenTtl: '10m' } } })
    const next = await Sessions.refresh(deps, tenant, rt(tokens))
    const claims = await verifyAccessToken(deps, at(next), tenant)
    expect(claims.exp - claims.iat).toBe(600)
  })
})

describe('the refresh grace window of a profile', () => {
  test('a longer window replays the same child for that long', async () => {
    configure({ profiles: { web: { refresh: { reuseGracePeriod: '30s' } } } })
    const first = await create()
    const second = await Sessions.refresh(deps, tenant, rt(first))
    deps.clock.advance('29s')
    const replay = await Sessions.refresh(deps, tenant, rt(first))
    expect(replay.refreshToken).toBe(second.refreshToken)
    deps.clock.advance('2s')
    expect(await code(Sessions.refresh(deps, tenant, rt(first)))).toBe('session.reuse_detected')
  })

  test('no window at all: any replay ends the session, even at once', async () => {
    configure({ profiles: { web: { refresh: { reuseGracePeriod: null } } } })
    const first = await create()
    const second = await Sessions.refresh(deps, tenant, rt(first))
    expect(await code(Sessions.refresh(deps, tenant, rt(first)))).toBe('session.reuse_detected')
    expect(await code(Sessions.refresh(deps, tenant, rt(second)))).toBe('session.reuse_detected')
    expect((await stored(first.sessionId))?.revokeReason).toBe('reuse_detected')
  })
})

describe('revocation outlives any access token', () => {
  test('a revoked session stays on the denylist for the longest lifetime a profile may set', async () => {
    configure({ profiles: { web: { accessTokenTtl: '15m' } } })
    const tokens = await create()
    // The profile is shortened after the token was signed: the token still lives 15 minutes.
    configure({ profiles: { web: { accessTokenTtl: '30s' } } })
    await Sessions.revoke(deps, tenant, {
      userId: USER,
      sessionId: tokens.sessionId,
      actor: TEST_ACTOR,
    })
    deps.clock.advance(durationToMs(MAX_ACCESS_TOKEN_TTL) - 1000)
    expect(await deps.revokedSessions.has(tokens.sessionId, deps.clock.now())).toBe(true)
  })
})

describe('the concurrent-session rule: end_oldest', () => {
  beforeEach(() => {
    configure({ maxPerUser: 2, onLimit: 'end_oldest' })
  })

  test('a sign-in at the limit ends the oldest session, through the denylist and the audit log', async () => {
    const oldest = await create()
    deps.clock.advance('1m')
    const middle = await create()
    deps.clock.advance('1m')
    // The oldest was used most recently: "oldest" is by sign-in time, not by activity.
    await Sessions.refresh(deps, tenant, rt(oldest))
    const newest = await create({ ipAddress: '203.0.113.9' })

    expect((await live()).map((row) => row.id).sort()).toEqual(
      [middle.sessionId, newest.sessionId].sort()
    )
    const ended = await stored(oldest.sessionId)
    expect(ended?.revokeReason).toBe('session_limit')
    expect(await deps.revokedSessions.has(oldest.sessionId, deps.clock.now())).toBe(true)
    const { entries } = await deps.activityLog.listAudit(tenant.environmentId, {
      targetId: oldest.sessionId,
      page: 1,
      size: 10,
    })
    const entry = entries.find((candidate) => candidate.type === 'session.revoked')
    expect(entry?.data).toEqual({ userId: USER, reason: 'session_limit' })
    expect(entry?.actor.type).toBe('system')
  })

  test('the ended session can no longer refresh', async () => {
    const oldest = await create()
    await create()
    await create()
    expect(await code(Sessions.refresh(deps, tenant, rt(oldest)))).toBe('session.revoked')
  })

  test('sessions that have already ended do not count', async () => {
    const first = await create()
    await Sessions.revoke(deps, tenant, {
      userId: USER,
      sessionId: first.sessionId,
      actor: TEST_ACTOR,
    })
    const second = await create()
    deps.clock.advance('8d')
    const third = await create()
    const fourth = await create()
    expect((await stored(second.sessionId))?.revokedAt).toBeNull()
    expect((await live()).map((row) => row.id).sort()).toEqual(
      [third.sessionId, fourth.sessionId].sort()
    )
  })

  test('another user’s sessions, and another environment’s, are untouched', async () => {
    const theirs = await create({ userId: OTHER_USER })
    const foreign = await Sessions.create(deps, otherTenant, { userId: USER, client: 'web' })
    await create()
    await create()
    await create()
    expect((await stored(theirs.sessionId))?.revokedAt).toBeNull()
    expect(
      (await deps.sessions.findById(otherTenant.environmentId, foreign.sessionId))?.revokedAt
    ).toBeNull()
    expect(await live()).toHaveLength(2)
  })

  test('simultaneous sign-ins never leave the user over the limit', async () => {
    await create()
    await create()
    const results = await Promise.allSettled([create(), create(), create(), create()])
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true)
    expect(await live()).toHaveLength(2)
  })

  test('a sign-in that keeps losing the race ends the sessions it put on the denylist before it gives up', async () => {
    const oldest = await create()
    deps.clock.advance('1m')
    const kept = await create()
    // Every pass loses: another sign-in of the same user always got in first.
    const racing = spyOn(deps.sessions, 'create').mockResolvedValue({ created: false })
    try {
      expect(await code(create({ ipAddress: '203.0.113.9' }))).toBe('service.unavailable')
      expect(racing).toHaveBeenCalledTimes(4)
    } finally {
      racing.mockRestore()
    }

    // Denylisted and still usable would be refused for 15 minutes and then alive again.
    expect(await deps.revokedSessions.has(oldest.sessionId, deps.clock.now())).toBe(true)
    expect(await stored(oldest.sessionId)).toMatchObject({ revokeReason: 'session_limit' })
    expect(await code(Sessions.refresh(deps, tenant, rt(oldest)))).toBe('session.revoked')
    const { entries } = await deps.activityLog.listAudit(tenant.environmentId, {
      targetId: oldest.sessionId,
      page: 1,
      size: 10,
    })
    const ended = entries.filter((candidate) => candidate.type === 'session.revoked')
    expect(ended).toHaveLength(1)
    expect(ended[0]?.data).toEqual({ userId: USER, reason: 'session_limit' })
    expect(ended[0]?.actor.type).toBe('system')
    // Only what this sign-in named: the newer session is neither denylisted nor ended.
    expect(await deps.revokedSessions.has(kept.sessionId, deps.clock.now())).toBe(false)
    expect((await stored(kept.sessionId))?.revokedAt).toBeNull()
  })

  test('a sign-in refused at the limit denylists and ends nothing', async () => {
    configure({ maxPerUser: 2, onLimit: 'refuse_newest' })
    const first = await create()
    const racing = spyOn(deps.sessions, 'create').mockResolvedValue({ created: false })
    try {
      expect(await code(create())).toBe('session.limit_reached')
    } finally {
      racing.mockRestore()
    }
    expect(await deps.revokedSessions.has(first.sessionId, deps.clock.now())).toBe(false)
    expect((await stored(first.sessionId))?.revokedAt).toBeNull()
  })

  test('lowering the limit takes effect at the next sign-in', async () => {
    const first = await create()
    const second = await create()
    configure({ maxPerUser: 1, onLimit: 'end_oldest' })
    const third = await create()
    expect((await live()).map((row) => row.id)).toEqual([third.sessionId])
    expect((await stored(first.sessionId))?.revokeReason).toBe('session_limit')
    expect((await stored(second.sessionId))?.revokeReason).toBe('session_limit')
  })
})

describe('the concurrent-session rule: refuse_newest', () => {
  beforeEach(() => {
    configure({ maxPerUser: 2, onLimit: 'refuse_newest' })
  })

  test('a sign-in at the limit is refused and creates nothing', async () => {
    const first = await create()
    const second = await create()
    expect(await code(create())).toBe('session.limit_reached')
    expect((await live()).map((row) => row.id).sort()).toEqual(
      [first.sessionId, second.sessionId].sort()
    )
    const { entries } = await deps.activityLog.listAudit(tenant.environmentId, {
      page: 1,
      size: 50,
    })
    expect(entries.filter((entry) => entry.type === 'session.created')).toHaveLength(2)
    expect(entries.filter((entry) => entry.type === 'session.revoked')).toHaveLength(0)
  })

  test('signing out elsewhere frees a place', async () => {
    const first = await create()
    await create()
    await Sessions.signOut(deps, tenant, rt(first))
    expect((await create()).sessionId).toBeDefined()
  })

  test('a session that timed out frees a place', async () => {
    await create()
    await create()
    deps.clock.advance('8d')
    expect((await create()).sessionId).toBeDefined()
  })

  test('of simultaneous sign-ins at the limit only as many succeed as there is room for', async () => {
    await create()
    const results = await Promise.allSettled([create(), create(), create()])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(await live()).toHaveLength(2)
  })

  test('no limit means no limit', async () => {
    configure({ maxPerUser: null })
    for (let i = 0; i < 5; i++) {
      await create()
    }
    expect(await live()).toHaveLength(5)
  })
})

describe('a stateful session', () => {
  beforeEach(() => {
    configure({
      profiles: { web: { type: 'stateful', idleTimeout: '1h', absoluteTimeout: '8h' } },
    })
  })

  test('is issued as a session token only: no access token, no refresh token', async () => {
    const tokens = await create()
    expect(tokens.sessionToken).toStartWith('tula_st_')
    expect(tokens.accessToken).toBeUndefined()
    expect(tokens.accessTokenExpiresAt).toBeUndefined()
    expect(tokens.refreshToken).toBeUndefined()
    expect(await stored(tokens.sessionId)).toMatchObject({ type: 'stateful', profile: 'web' })
  })

  test('its token authenticates, with the claims an access token would carry', async () => {
    const tokens = await create({ authMethods: ['pwd'] })
    const claims = await Sessions.authenticate(deps, tenant, st(tokens))
    const now = Math.floor(deps.clock.now().getTime() / 1000)
    expect(claims).toMatchObject({
      sub: USER,
      sid: tokens.sessionId,
      aud: tenant.environmentId,
      eid: tenant.environmentId,
      pid: tenant.projectId,
      auth_time: now,
      amr: ['pwd'],
      sp: 'web',
      iat: now,
    })
    expect(claims.exp).toBeGreaterThan(now)
  })

  test('is stored only as a hash', async () => {
    const tokens = await create()
    const found = await deps.sessions.findToken(tenant.environmentId, st(tokens))
    expect(found).toBeNull()
  })

  test.each([
    ['an unknown token', () => 'tula_st_nope'],
    ['an empty token', () => ''],
  ])('%s is refused', async (_name, token) => {
    await create()
    expect(await code(Sessions.authenticate(deps, tenant, token()))).toBe('session.invalid_token')
  })

  test('another environment’s token is refused', async () => {
    const tokens = await create()
    expect(await code(Sessions.authenticate(deps, otherTenant, st(tokens)))).toBe(
      'session.invalid_token'
    )
  })

  test('a hybrid session’s refresh token is not a session token', async () => {
    configure({ profiles: {} })
    const hybrid = await create()
    expect(await code(Sessions.authenticate(deps, tenant, rt(hybrid)))).toBe(
      'session.invalid_token'
    )
    // And it still refreshes: the failed check did not burn it.
    expect((await Sessions.refresh(deps, tenant, rt(hybrid))).sessionId).toBe(hybrid.sessionId)
  })

  test('a session token is not a refresh token', async () => {
    const tokens = await create()
    expect(await code(Sessions.refresh(deps, tenant, st(tokens)))).toBe('session.invalid_token')
    expect((await Sessions.authenticate(deps, tenant, st(tokens))).sid).toBe(tokens.sessionId)
  })

  test('revoking it takes effect on the very next check', async () => {
    const tokens = await create()
    await Sessions.authenticate(deps, tenant, st(tokens))
    await Sessions.revoke(deps, tenant, {
      userId: USER,
      sessionId: tokens.sessionId,
      actor: TEST_ACTOR,
    })
    expect(await code(Sessions.authenticate(deps, tenant, st(tokens)))).toBe('session.revoked')
  })

  test('activity keeps it alive, to the precision of accessTokenTtl', async () => {
    const tokens = await create()
    deps.clock.advance('30s')
    await Sessions.authenticate(deps, tenant, st(tokens))
    // Under a minute since the last write: nothing is written.
    expect((await stored(tokens.sessionId))?.lastActiveAt.getTime()).toBe(
      deps.clock.now().getTime() - 30_000
    )
    for (let i = 0; i < 5; i++) {
      deps.clock.advance('50m')
      await Sessions.authenticate(deps, tenant, st(tokens))
    }
    const row = await stored(tokens.sessionId)
    expect(row?.lastActiveAt).toEqual(deps.clock.now())
    expect(row?.idleExpiresAt.getTime()).toBe(deps.clock.now().getTime() + durationToMs('1h'))
  })

  test('it ends after the idle timeout without activity', async () => {
    const tokens = await create()
    deps.clock.advance('61m')
    expect(await code(Sessions.authenticate(deps, tenant, st(tokens)))).toBe('session.expired')
  })

  test('it ends at the absolute timeout whatever the activity', async () => {
    const tokens = await create()
    for (let i = 0; i < 9; i++) {
      deps.clock.advance('50m')
      await Sessions.authenticate(deps, tenant, st(tokens))
    }
    deps.clock.advance('50m')
    expect(await code(Sessions.authenticate(deps, tenant, st(tokens)))).toBe('session.expired')
    expect((await stored(tokens.sessionId))?.idleExpiresAt.getTime()).toBeLessThanOrEqual(
      (await stored(tokens.sessionId))?.absoluteExpiresAt?.getTime() ?? 0
    )
  })

  test('tightening the profile ends an over-age session on its next request', async () => {
    const tokens = await create()
    deps.clock.advance('20m')
    configure({ profiles: { web: { type: 'stateful', idleTimeout: '10m' } } })
    expect(await code(Sessions.authenticate(deps, tenant, st(tokens)))).toBe('session.expired')
  })

  test('a banned user’s session ends when its activity is next written', async () => {
    await deps.users.create(
      {
        id: USER,
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        email: 'ada@northline.app',
        emailNormalized: 'ada@northline.app',
        emailVerifiedAt: deps.clock.now(),
        firstName: null,
        lastName: null,
        createdAt: deps.clock.now(),
        identityId: 'i1',
        credentialId: 'c1',
        passwordHash: 'hash',
      },
      Audit.none('fixture')
    )
    const tokens = await create()
    await deps.users.setBanned(
      tenant.environmentId,
      USER,
      deps.clock.now(),
      deps.clock.now(),
      Audit.none('fixture')
    )
    deps.clock.advance('2m')
    expect(await code(Sessions.authenticate(deps, tenant, st(tokens)))).toBe('auth.user_banned')
    expect((await stored(tokens.sessionId))?.revokeReason).toBe('user_banned')
  })

  test('signing out with the session token ends it', async () => {
    const tokens = await create()
    await Sessions.signOut(deps, tenant, st(tokens))
    expect(await code(Sessions.authenticate(deps, tenant, st(tokens)))).toBe('session.revoked')
  })

  test('a step-up is recorded on the row and answers with no token', async () => {
    const tokens = await create({ authMethods: ['pwd'] })
    deps.clock.advance('20m')
    const stepped = await Sessions.recordAuthentication(
      deps,
      tenant,
      { userId: USER, sessionId: tokens.sessionId },
      ['otp', 'mfa'],
      TEST_ACTOR
    )
    expect(stepped).toEqual({ sessionId: tokens.sessionId })
    const claims = await Sessions.authenticate(deps, tenant, st(tokens))
    expect(claims.auth_time).toBe(Math.floor(deps.clock.now().getTime() / 1000))
    expect(new Set(claims.amr)).toEqual(new Set(['pwd', 'otp', 'mfa']))
  })

  test('a session stays stateful when its profile later becomes hybrid', async () => {
    const tokens = await create()
    configure({ profiles: { web: { type: 'hybrid' } } })
    expect((await Sessions.authenticate(deps, tenant, st(tokens))).sid).toBe(tokens.sessionId)
    expect(await code(Sessions.refresh(deps, tenant, st(tokens)))).toBe('session.invalid_token')
  })
})
