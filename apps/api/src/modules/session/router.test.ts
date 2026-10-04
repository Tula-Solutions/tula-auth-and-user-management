import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  type AccessTokenClaims,
  DEFAULT_ENVIRONMENT_SETTINGS,
  type SessionTokens,
} from '@tula/contract'
import { decodeJwt } from 'jose'
import { createApp } from '~/index'
import { sha256Hex } from '~/lib/crypto'
import { base32Decode, totp } from '~/lib/totp'
import { CLIENT_RATE_LIMIT } from '~/middleware/rate-limit'
import * as Mfa from '~/modules/mfa/service'
import * as Notices from '~/modules/notice/service'
import * as Passwords from '~/modules/password/service'
import { refreshCookieName } from '~/modules/session/cookies'
import { STEP_UP_RATE_LIMIT } from '~/modules/session/router'
import * as Sessions from '~/modules/session/service'
import { createTestDeps, seedApiKey, TEST_CONFIG, TEST_TENANT, type TestDeps } from '~/testing'

const PK = 'tula_pk_dev_publishable0000000000000000000'
const PROD_PK = 'tula_pk_prod_publishable000000000000000000'
const USER = '00000000-0000-7000-8000-0000000000a1'
const OTHER_USER = '00000000-0000-7000-8000-0000000000a2'
const tenant = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }
const COOKIE = refreshCookieName(TEST_CONFIG, tenant.environmentId)
let deps: TestDeps
let app: ReturnType<typeof createApp>

async function build(config = TEST_CONFIG) {
  deps = createTestDeps({ config })
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
  await seedApiKey(deps, PK)
  await seedApiKey(deps, PROD_PK, { environmentId: TEST_TENANT.productionEnvironmentId })
  app = createApp(deps)
}

beforeEach(() => build())

const signIn = (userId = USER, client: 'web' | 'ios' = 'web') =>
  Sessions.create(deps, tenant, { userId, client, userAgent: 'Mozilla/5.0', ipAddress: null })

function rt(tokens: SessionTokens): string {
  if (!tokens.refreshToken) {
    throw new Error('expected a refresh token')
  }
  return tokens.refreshToken
}

interface CallOptions {
  body?: unknown
  cookie?: string
  origin?: string
  accessToken?: string
  key?: string | null
}

function call(method: string, path: string, options: CallOptions = {}) {
  const headers: Record<string, string> = {}
  if (options.key !== null) {
    headers['x-tula-publishable-key'] = options.key ?? PK
  }
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
  }
  if (options.cookie) {
    headers.cookie = options.cookie
  }
  if (options.origin) {
    headers.origin = options.origin
  }
  if (options.accessToken) {
    headers.authorization = `Bearer ${options.accessToken}`
  }
  return app.request(`/v1/client/sessions${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
}

const code = async (res: Response) => ((await res.json()) as { code: string }).code
const setCookie = (res: Response) => res.headers.get('set-cookie') ?? ''

describe('POST /v1/client/sessions/refresh', () => {
  test('native clients send the token in the body and get the next one back in the body', async () => {
    const first = await signIn(USER, 'ios')
    const res = await call('POST', '/refresh', { body: { refreshToken: rt(first) } })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(setCookie(res)).toBe('')
    const body = (await res.json()) as SessionTokens
    expect(body.sessionId).toBe(first.sessionId)
    expect(body.refreshToken).toBeString()
    expect(body.refreshToken).not.toBe(rt(first))
    expect(body.accessToken.split('.')).toHaveLength(3)
  })

  test('browsers send a cookie and get the next token only as an httpOnly cookie', async () => {
    const first = await signIn()
    const res = await call('POST', '/refresh', { cookie: `${COOKIE}=${rt(first)}` })
    expect(res.status).toBe(200)
    const body = (await res.json()) as SessionTokens
    expect(body).not.toHaveProperty('refreshToken')
    expect(body.accessToken.split('.')).toHaveLength(3)

    const cookie = setCookie(res)
    const next = new RegExp(`^${COOKIE}=([^;]+)`).exec(cookie)?.[1]
    expect(next).toBeString()
    expect(next).not.toBe(rt(first))
    expect(JSON.stringify(body)).not.toContain(next ?? 'missing')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Path=/v1/client/sessions')
    expect(cookie).toContain(`Max-Age=${7 * 86_400}`)
    // The rotated cookie works for the next refresh.
    expect((await call('POST', '/refresh', { cookie: `${COOKIE}=${next}` })).status).toBe(200)
  })

  test('over https the cookie is Secure and carries the __Secure- prefix', async () => {
    const https = { ...TEST_CONFIG, publicUrl: 'https://auth.example.com' }
    await build(https)
    const name = refreshCookieName(https, tenant.environmentId)
    expect(name.startsWith('__Secure-')).toBe(true)
    const first = await signIn()
    const res = await call('POST', '/refresh', { cookie: `${name}=${rt(first)}` })
    expect(res.status).toBe(200)
    expect(setCookie(res)).toContain('Secure')
    expect(setCookie(res).startsWith(`${name}=`)).toBe(true)
  })

  test('without a token it answers auth.unauthenticated', async () => {
    const res = await call('POST', '/refresh', { body: {} })
    expect(res.status).toBe(401)
    expect(await code(res)).toBe('auth.unauthenticated')
  })

  test('a bad cookie is rejected and cleared', async () => {
    const res = await call('POST', '/refresh', { cookie: `${COOKIE}=tula_rt_nope` })
    expect(res.status).toBe(401)
    expect(await code(res)).toBe('session.invalid_token')
    expect(setCookie(res)).toContain(`${COOKIE}=;`)
    expect(setCookie(res)).toContain('Max-Age=0')
  })

  test('reuse after the grace window signs the session out and clears the cookie', async () => {
    const first = await signIn()
    await call('POST', '/refresh', { cookie: `${COOKIE}=${rt(first)}` })
    deps.clock.advance('11s')
    const res = await call('POST', '/refresh', { cookie: `${COOKIE}=${rt(first)}` })
    expect(res.status).toBe(401)
    expect(await code(res)).toBe('session.reuse_detected')
    expect(setCookie(res)).toContain('Max-Age=0')
  })

  test('a cookie for one environment is not used for another', async () => {
    const first = await signIn()
    const res = await call('POST', '/refresh', {
      key: PROD_PK,
      cookie: `${COOKIE}=${rt(first)}`,
    })
    expect(res.status).toBe(401)
    expect(await code(res)).toBe('auth.unauthenticated')
    // Even presented explicitly, another environment's token is unknown there.
    const explicit = await call('POST', '/refresh', {
      key: PROD_PK,
      body: { refreshToken: rt(first) },
    })
    expect(await code(explicit)).toBe('session.invalid_token')
  })

  test('requires a publishable key', async () => {
    const first = await signIn()
    const res = await call('POST', '/refresh', { key: null, body: { refreshToken: rt(first) } })
    expect(res.status).toBe(401)
    expect(await code(res)).toBe('auth.invalid_key')
  })

  test('rejects an over-long token as a validation error', async () => {
    const res = await call('POST', '/refresh', { body: { refreshToken: 'x'.repeat(600) } })
    expect(res.status).toBe(422)
  })

  test('is rate limited per IP', async () => {
    for (let i = 0; i < Sessions.REFRESH_RATE_LIMIT; i++) {
      await call('POST', '/refresh', { body: { refreshToken: 'tula_rt_nope' } })
    }
    const res = await call('POST', '/refresh', { body: { refreshToken: 'tula_rt_nope' } })
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).not.toBeNull()
  })
})

describe('POST /v1/client/sessions/sign-out', () => {
  test('ends the cookie’s session and clears the cookie', async () => {
    const tokens = await signIn()
    const res = await call('POST', '/sign-out', { cookie: `${COOKIE}=${rt(tokens)}` })
    expect(res.status).toBe(204)
    expect(setCookie(res)).toContain('Max-Age=0')
    expect(
      (await deps.sessions.findById(tenant.environmentId, tokens.sessionId))?.revokeReason
    ).toBe('sign_out')
    // Its access token stops working at once.
    const list = await call('GET', '', { accessToken: tokens.accessToken })
    expect(await code(list)).toBe('session.revoked')
  })

  test('works with a token in the body and always succeeds, even for unknown tokens', async () => {
    const tokens = await signIn(USER, 'ios')
    expect((await call('POST', '/sign-out', { body: { refreshToken: rt(tokens) } })).status).toBe(
      204
    )
    expect(
      (await call('POST', '/sign-out', { body: { refreshToken: 'tula_rt_nope' } })).status
    ).toBe(204)
    expect((await call('POST', '/sign-out')).status).toBe(204)
  })
})

describe('GET /v1/client/sessions', () => {
  test("lists the signed-in user's devices and marks the current one", async () => {
    const current = await signIn()
    const other = await signIn(USER, 'ios')
    await signIn(OTHER_USER)
    const res = await call('GET', '', { accessToken: current.accessToken })
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: { id: string; current: boolean }[] }
    expect(data.map((s) => [s.id, s.current]).sort()).toEqual(
      [
        [current.sessionId, true],
        [other.sessionId, false],
      ].sort()
    )
    expect(JSON.stringify(data)).not.toContain('tula_rt_')
  })

  test('requires an access token', async () => {
    const res = await call('GET', '')
    expect(res.status).toBe(401)
    expect(await code(res)).toBe('auth.unauthenticated')
  })
})

describe('DELETE /v1/client/sessions/:sessionId', () => {
  test('signs another of the user’s devices out', async () => {
    const current = await signIn()
    const other = await signIn(USER, 'ios')
    const res = await call('DELETE', `/${other.sessionId}`, { accessToken: current.accessToken })
    expect(res.status).toBe(204)
    expect(setCookie(res)).toBe('')
    expect(
      (await deps.sessions.findById(tenant.environmentId, other.sessionId))?.revokeReason
    ).toBe('revoked_by_user')
    expect(await code(await call('GET', '', { accessToken: other.accessToken }))).toBe(
      'session.revoked'
    )
  })

  test('revoking the current session also clears the cookie', async () => {
    const current = await signIn()
    const res = await call('DELETE', `/${current.sessionId}`, { accessToken: current.accessToken })
    expect(res.status).toBe(204)
    expect(setCookie(res)).toContain('Max-Age=0')
  })

  test('cannot revoke another user’s session', async () => {
    const mine = await signIn()
    const theirs = await signIn(OTHER_USER)
    const res = await call('DELETE', `/${theirs.sessionId}`, { accessToken: mine.accessToken })
    expect(res.status).toBe(404)
    expect(
      (await deps.sessions.findById(tenant.environmentId, theirs.sessionId))?.revokedAt
    ).toBeNull()
  })

  test('rejects a malformed id', async () => {
    const mine = await signIn()
    const res = await call('DELETE', '/not-a-uuid', { accessToken: mine.accessToken })
    expect(res.status).toBe(422)
  })
})

describe('POST /v1/client/sessions/revoke-others', () => {
  test('signs out every other device and reports how many', async () => {
    const current = await signIn()
    await signIn()
    await signIn(USER, 'ios')
    const res = await call('POST', '/revoke-others', { accessToken: current.accessToken })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ revoked: 2 })
    expect((await call('GET', '', { accessToken: current.accessToken })).status).toBe(200)
  })
})

describe('client route group', () => {
  test('every /v1/client route shares the per-IP limit ahead of key resolution', async () => {
    for (let i = 0; i < CLIENT_RATE_LIMIT; i++) {
      await call('GET', '', { key: 'tula_pk_dev_wrong00000000000000000000000000' })
    }
    const tokens = await signIn()
    expect((await call('GET', '', { accessToken: tokens.accessToken })).status).toBe(429)
    expect((await call('POST', '/sign-out')).status).toBe(429)
  })
})

describe('the refresh cookie and the origin of the request', () => {
  const APP = 'https://app.northline.app'
  const OTHER = 'https://blog.northline.app'

  beforeEach(async () => {
    await build({ ...TEST_CONFIG, tier: 'prod', publicUrl: 'https://auth.northline.app' })
    deps.environmentSettings.seed(tenant.environmentId, {
      revision: 1,
      settings: {
        ...DEFAULT_ENVIRONMENT_SETTINGS,
        urls: { allowedOrigins: [APP], allowedRedirectUrls: [] },
      },
    })
  })

  const cookieName = () => refreshCookieName(deps.config, tenant.environmentId)
  const cookieFor = (tokens: SessionTokens) => `${cookieName()}=${rt(tokens)}`

  test('refresh by cookie works from an origin the environment allows, with CORS headers', async () => {
    const first = await signIn()
    const res = await call('POST', '/refresh', { cookie: cookieFor(first), origin: APP })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe(APP)
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    expect(setCookie(res)).toContain(`${cookieName()}=tula_rt_`)
  })

  test.each<[string, string]>([
    ['another origin of the same site', OTHER],
    ['an unrelated origin', 'https://evil.test'],
    ['the literal null origin', 'null'],
  ])(
    'refresh by cookie from %s is refused, and the session and cookie are left alone',
    async (_, origin) => {
      const first = await signIn()
      const res = await call('POST', '/refresh', { cookie: cookieFor(first), origin })
      expect(res.status).toBe(401)
      expect(await code(res)).toBe('auth.unauthenticated')
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
      // Neither rotated nor cleared: the page that asked gets nothing and changes nothing.
      expect(setCookie(res)).toBe('')
      const allowed = await call('POST', '/refresh', { cookie: cookieFor(first), origin: APP })
      expect(allowed.status).toBe(200)
    }
  )

  test('a request with no Origin (not a cross-origin browser request) may use the cookie', async () => {
    const first = await signIn()
    expect((await call('POST', '/refresh', { cookie: cookieFor(first) })).status).toBe(200)
  })

  test('the API’s own origin may use the cookie', async () => {
    const first = await signIn()
    const res = await call('POST', '/refresh', {
      cookie: cookieFor(first),
      origin: 'https://auth.northline.app',
    })
    expect(res.status).toBe(200)
  })

  test('a token in the body is not affected by the origin: JavaScript had to hold it', async () => {
    const first = await signIn(USER, 'ios')
    const res = await call('POST', '/refresh', { body: { refreshToken: rt(first) }, origin: OTHER })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  test('sign-out by cookie from a disallowed origin ends nothing and clears nothing', async () => {
    const tokens = await signIn()
    const res = await call('POST', '/sign-out', { cookie: cookieFor(tokens), origin: OTHER })
    expect(res.status).toBe(204)
    expect(setCookie(res)).toBe('')
    expect(
      (await deps.sessions.findById(tenant.environmentId, tokens.sessionId))?.revokedAt
    ).toBeNull()

    const allowed = await call('POST', '/sign-out', { cookie: cookieFor(tokens), origin: APP })
    expect(allowed.status).toBe(204)
    expect(setCookie(allowed)).toContain('Max-Age=0')
    expect(
      (await deps.sessions.findById(tenant.environmentId, tokens.sessionId))?.revokeReason
    ).toBe('sign_out')
  })

  test('an origin allowed by another environment only cannot use this one’s cookie', async () => {
    deps.environmentSettings.seed(TEST_TENANT.productionEnvironmentId, {
      revision: 1,
      settings: {
        ...DEFAULT_ENVIRONMENT_SETTINGS,
        urls: { allowedOrigins: [OTHER], allowedRedirectUrls: [] },
      },
    })
    const first = await signIn()
    const res = await call('POST', '/refresh', { cookie: cookieFor(first), origin: OTHER })
    expect(res.status).toBe(401)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('POST /v1/client/sessions/step-up', () => {
  const PASSWORD = 'correct horse battery staple'
  const scope = { ...tenant, apiKeyId: 'key_1' }
  let userId: string

  beforeEach(async () => {
    userId = deps.ids.next()
    await deps.users.create({
      id: userId,
      ...tenant,
      email: 'maya@northline.app',
      emailNormalized: 'maya@northline.app',
      emailVerifiedAt: deps.clock.now(),
      firstName: null,
      lastName: null,
      createdAt: deps.clock.now(),
      identityId: deps.ids.next(),
      credentialId: deps.ids.next(),
      passwordHash: await Passwords.hash(PASSWORD),
    })
  })
  afterEach(() => Notices.settled())

  const stepUp = (body: unknown, options: CallOptions = {}) =>
    call('POST', '/step-up', { body, ...options })
  const claimsOf = (token: string) => decodeJwt(token) as unknown as AccessTokenClaims
  const session = (client: 'web' | 'ios' = 'web', authMethods = ['pwd']) =>
    Sessions.create(deps, tenant, { userId, client, userAgent: 'Mozilla/5.0', authMethods })

  /** Turn two-step verification on for the user; returns the authenticator's secret. */
  async function enrol() {
    const { secret } = await Mfa.startTotp(deps, scope, userId)
    await Mfa.confirmTotp(deps, scope, { userId }, totp(base32Decode(secret), deps.clock.now()), {
      type: 'user',
      id: userId,
      ipAddress: null,
      userAgent: null,
    })
    deps.clock.advance('30s')
    return secret
  }

  test('returns a fresh access token and nothing else: no refresh token, no cookie, not cacheable', async () => {
    const tokens = await session('web')
    deps.clock.advance('30s')
    const res = await stepUp(
      { method: 'password', password: PASSWORD },
      // A browser sends its refresh cookie along; the step-up must not touch it.
      { accessToken: tokens.accessToken, cookie: `${COOKIE}=${rt(tokens)}` }
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(setCookie(res)).toBe('')
    const body = (await res.json()) as SessionTokens
    expect(Object.keys(body).sort()).toEqual(['accessToken', 'accessTokenExpiresAt', 'sessionId'])
    expect(body.sessionId).toBe(tokens.sessionId)
    expect(claimsOf(body.accessToken)).toMatchObject({
      sub: userId,
      sid: tokens.sessionId,
      auth_time: Math.floor(deps.clock.now().getTime() / 1000),
      amr: ['pwd'],
    })
    // The refresh token was not rotated: it is unused and still refreshes.
    const stored = await deps.sessions.findToken(tenant.environmentId, sha256Hex(rt(tokens)))
    expect(stored?.token).toMatchObject({ usedAt: null, replacedById: null })
    const refreshed = await call('POST', '/refresh', { cookie: `${COOKIE}=${rt(tokens)}` })
    expect(refreshed.status).toBe(200)
    expect(deps.activityLog.ofType('session.stepped_up')).toHaveLength(1)
  })

  test('without an access token, or with a bad one, it answers 401 and checks nothing', async () => {
    const proof = { method: 'password', password: PASSWORD }
    expect(await code(await stepUp(proof))).toBe('auth.unauthenticated')
    const garbage = await stepUp(proof, { accessToken: 'not.a.token' })
    expect(garbage.status).toBe(401)
    expect(await code(garbage)).toBe('session.invalid_token')
    // The refresh cookie alone is not a session for this route.
    const tokens = await session('web')
    const cookieOnly = await stepUp(proof, { cookie: `${COOKIE}=${rt(tokens)}` })
    expect(await code(cookieOnly)).toBe('auth.unauthenticated')
    expect((await stepUp(proof, { accessToken: tokens.accessToken, key: null })).status).toBe(401)
    expect(deps.activityLog.ofType('session.stepped_up')).toEqual([])
  })

  test('a signed-out session cannot step up, even with a token that has not expired', async () => {
    const tokens = await session('ios')
    await call('POST', '/sign-out', { body: { refreshToken: rt(tokens) } })
    const res = await stepUp(
      { method: 'password', password: PASSWORD },
      { accessToken: tokens.accessToken }
    )
    expect(res.status).toBe(401)
    expect(await code(res)).toBe('session.revoked')
  })

  test.each<[string, unknown]>([
    ['an empty body', {}],
    ['no proof for the password', { method: 'password' }],
    ['an over-long password', { method: 'password', password: 'x'.repeat(1025) }],
    ['a five-digit code', { method: 'totp', code: '12345' }],
    ['letters as a code', { method: 'totp', code: 'abcdef' }],
    ['a password where a code belongs', { method: 'totp', password: PASSWORD }],
    ['an empty backup code', { method: 'backup_code', code: '' }],
    ['an over-long backup code', { method: 'backup_code', code: 'a'.repeat(65) }],
    ['a method that is not a step-up method', { method: 'passkey', code: '123456' }],
  ])('refuses %s as a validation error, counting nothing', async (_, body) => {
    const tokens = await session('ios')
    const res = await stepUp(body, { accessToken: tokens.accessToken })
    expect(res.status).toBe(422)
    expect(await code(res)).toBe('validation.failed')
    expect(setCookie(res)).toBe('')
    // The password lockout was not touched: a right proof still works at once.
    expect(
      (
        await stepUp(
          { method: 'password', password: PASSWORD },
          { accessToken: tokens.accessToken }
        )
      ).status
    ).toBe(200)
  })

  test('a wrong password is 401 auth.invalid_credentials and returns no token', async () => {
    const tokens = await session('ios')
    const res = await stepUp(
      { method: 'password', password: 'not the password' },
      { accessToken: tokens.accessToken }
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({
      status: 401,
      code: 'auth.invalid_credentials',
      detail: expect.any(String),
    })
    expect(setCookie(res)).toBe('')
  })

  test('a user with a second factor is refused the password and accepted with a code', async () => {
    const secret = await enrol()
    const tokens = await session('ios')
    const refused = await stepUp(
      { method: 'password', password: PASSWORD },
      { accessToken: tokens.accessToken }
    )
    expect(await refused.json()).toEqual({
      status: 403,
      code: 'auth.step_up_required',
      detail: 'Confirm it is you to continue.',
      params: { methods: 'totp,backup_code' },
    })
    const wrong = await stepUp(
      { method: 'totp', code: '000000' },
      { accessToken: tokens.accessToken }
    )
    expect(await wrong.json()).toMatchObject({ status: 422, code: 'mfa.invalid_code' })

    const res = await stepUp(
      { method: 'totp', code: totp(base32Decode(secret), deps.clock.now()) },
      { accessToken: tokens.accessToken }
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as SessionTokens
    expect(body).not.toHaveProperty('refreshToken')
    expect(claimsOf(body.accessToken).amr).toEqual(['pwd', 'otp', 'mfa'])
  })

  test('is rate limited per IP, ahead of the token check', async () => {
    const tokens = await session('ios')
    for (let i = 0; i < STEP_UP_RATE_LIMIT; i++) {
      expect((await stepUp({ method: 'password', password: PASSWORD })).status).toBe(401)
    }
    const res = await stepUp(
      { method: 'password', password: PASSWORD },
      { accessToken: tokens.accessToken }
    )
    expect(res.status).toBe(429)
    expect(await code(res)).toBe('rate_limited')
    expect(res.headers.get('retry-after')).not.toBeNull()
    expect(deps.activityLog.ofType('session.stepped_up')).toEqual([])
    deps.clock.advance('1m')
    const fresh = await call('POST', '/refresh', { body: { refreshToken: rt(tokens) } })
    const { accessToken } = (await fresh.json()) as SessionTokens
    expect((await stepUp({ method: 'password', password: PASSWORD }, { accessToken })).status).toBe(
      200
    )
  })

  test('the audit entry carries where the request came from', async () => {
    const tokens = await session('ios')
    await app.request('/v1/client/sessions/step-up', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tula-publishable-key': PK,
        'user-agent': 'TulaSDK/1 iOS',
        authorization: `Bearer ${tokens.accessToken}`,
      },
      body: JSON.stringify({ method: 'password', password: PASSWORD }),
    })
    expect(deps.activityLog.ofType('session.stepped_up')).toEqual([
      expect.objectContaining({
        actor: { type: 'user', id: userId },
        target: { type: 'session', id: tokens.sessionId },
        userAgent: 'TulaSDK/1 iOS',
        data: { userId, methods: ['pwd'] },
      }),
    ])
  })
})
