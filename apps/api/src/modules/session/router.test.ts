import { beforeEach, describe, expect, test } from 'bun:test'
import { DEFAULT_ENVIRONMENT_SETTINGS, type SessionTokens } from '@tula/contract'
import { createApp } from '~/index'
import { CLIENT_RATE_LIMIT } from '~/middleware/rate-limit'
import { refreshCookieName } from '~/modules/session/cookies'
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
