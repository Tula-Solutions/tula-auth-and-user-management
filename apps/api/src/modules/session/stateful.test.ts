import { beforeEach, describe, expect, test } from 'bun:test'
import {
  type AccessTokenClaims,
  DEFAULT_ENVIRONMENT_SETTINGS,
  EnvironmentSettingsSchema,
  type FlowAttempt,
  SESSION_PROFILE_HEADER,
  type User,
} from '@tula/contract'
import { decodeJwt } from 'jose'
import { createApp } from '~/index'
import { refreshCookieName, sessionCookieName } from '~/modules/session/cookies'
import * as Sessions from '~/modules/session/service'
import {
  createTestDeps,
  seedApiKey,
  TEST_ACTOR,
  TEST_CONFIG,
  TEST_TENANT,
  type TestDeps,
} from '~/testing'

const PK = 'tula_pk_dev_publishable0000000000000000000'
const SK = 'tula_sk_dev_secret000000000000000000000000'
const PROD_PK = 'tula_pk_prod_publishable000000000000000000'
const PROD_SK = 'tula_sk_prod_secret00000000000000000000000'
const APP = 'https://app.northline.app'
const OTHER = 'https://evil.example'
const EMAIL = 'maya@northline.app'
const PASSWORD = 'correct horse battery staple 42'
const tenant = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }
const CONFIG = { ...TEST_CONFIG, tier: 'prod' as const, publicUrl: 'https://auth.northline.app' }
let deps: TestDeps
let app: ReturnType<typeof createApp>
let revision = 0

/** Save a `sessions` section; the app's origin is always allowed. */
function configure(sessions: unknown): void {
  revision += 1
  deps.environmentSettings.seed(tenant.environmentId, {
    revision,
    settings: EnvironmentSettingsSchema.parse({
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      urls: { allowedOrigins: [APP], allowedRedirectUrls: [] },
      sessions,
    }),
  })
}

beforeEach(async () => {
  deps = createTestDeps({ config: CONFIG })
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
  await seedApiKey(deps, PK)
  await seedApiKey(deps, SK)
  await seedApiKey(deps, PROD_PK, { environmentId: TEST_TENANT.productionEnvironmentId })
  await seedApiKey(deps, PROD_SK, { environmentId: TEST_TENANT.productionEnvironmentId })
  app = createApp(deps)
  configure({ profiles: { web: { type: 'stateful', idleTimeout: '1h', absoluteTimeout: '8h' } } })
})

interface Options {
  body?: unknown
  cookie?: string
  origin?: string | null
  bearer?: string
  key?: string
  headers?: Record<string, string>
}

function client(method: string, path: string, options: Options = {}) {
  const headers: Record<string, string> = {
    'x-tula-publishable-key': options.key ?? PK,
    ...options.headers,
  }
  // A browser always says where a cross-origin or state-changing request comes from.
  if (options.origin !== null) {
    headers.origin = options.origin ?? APP
  }
  if (options.cookie) {
    headers.cookie = options.cookie
  }
  if (options.bearer) {
    headers.authorization = `Bearer ${options.bearer}`
  }
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
  }
  return app.request(`/v1/client${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
}

function admin(method: string, path: string, body?: unknown, key: string | null = SK) {
  return app.request(`/v1/admin${path}`, {
    method,
    headers: {
      ...(key && { authorization: `Bearer ${key}` }),
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const json = async <T>(res: Response) => (await res.json()) as T
const code = async (res: Response) => (await json<{ code: string }>(res)).code
const setCookies = (res: Response) => res.headers.getSetCookie()
const SESSION_COOKIE = () => sessionCookieName(deps.config, tenant.environmentId)
const REFRESH_COOKIE = () => refreshCookieName(deps.config, tenant.environmentId)

async function createUser(email = EMAIL): Promise<User> {
  const res = await admin('POST', '/users', { email, password: PASSWORD, emailVerified: true })
  expect(res.status).toBe(201)
  return json<User>(res)
}

/** Sign in over HTTP with the password, as a browser on the app's origin unless told otherwise. */
async function signIn(headers: Record<string, string> = {}, email = EMAIL): Promise<Response> {
  const started = await json<FlowAttempt>(
    await client('POST', '/sign-ins', { body: { identifier: email }, headers })
  )
  return client('POST', `/sign-ins/${started.id}/password`, {
    body: { password: PASSWORD },
    headers: { ...headers, 'x-tula-attempt': started.attemptSecret ?? '' },
  })
}

/** The `name=value` pair of the session cookie a response set. */
function sessionCookie(res: Response): string {
  const cookie = setCookies(res).find((value) => value.startsWith(`${SESSION_COOKIE()}=`))
  if (!cookie) {
    throw new Error('expected a session cookie')
  }
  return cookie.split(';')[0] as string
}

async function signedIn(): Promise<{ cookie: string; sessionId: string; user: User }> {
  const user = await createUser()
  const res = await signIn()
  const { session } = (await res.clone().json()) as FlowAttempt
  return { cookie: sessionCookie(res), sessionId: session?.sessionId ?? '', user }
}

describe('signing in on a stateful profile', () => {
  test('sets only the session cookie: no access token, no refresh token, nothing in the body', async () => {
    await createUser()
    const res = await signIn()
    expect(res.status).toBe(200)
    const text = await res.clone().text()
    const attempt = await json<FlowAttempt>(res)
    expect(attempt.step.status).toBe('complete')
    expect(attempt.session).toEqual({ sessionId: expect.any(String) })
    expect(text).not.toContain('tula_st_')
    expect(text).not.toContain('tula_rt_')

    const cookies = setCookies(res)
    expect(cookies).toHaveLength(1)
    const [cookie] = cookies as [string]
    expect(cookie).toStartWith(`${SESSION_COOKIE()}=tula_st_`)
    expect(SESSION_COOKIE()).toStartWith('__Host-')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Path=/')
    expect(cookie).not.toContain('Domain=')
    expect(cookie).toContain(`Max-Age=${8 * 3600}`)
    expect(cookie).not.toContain(REFRESH_COOKIE())
  })

  test('over plain http (local development) the cookie has no prefix and is not Secure', async () => {
    deps = createTestDeps({ config: TEST_CONFIG })
    deps.environments.add({
      id: tenant.environmentId,
      projectId: tenant.projectId,
      kind: 'development',
      createdAt: deps.clock.now(),
    })
    await seedApiKey(deps, PK)
    await seedApiKey(deps, SK)
    app = createApp(deps)
    configure({ profiles: { web: { type: 'stateful' } } })
    await createUser()
    const [cookie] = setCookies(await signIn()) as [string]
    expect(cookie).toStartWith(`tula_session_${tenant.environmentId}=`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).not.toContain('Secure')
  })

  test('a native client on the same environment still gets tokens in the body', async () => {
    await createUser()
    const res = await signIn({ 'x-tula-client': 'ios' })
    const attempt = await json<FlowAttempt>(res)
    expect(attempt.session?.accessToken).toBeDefined()
    expect(attempt.session?.refreshToken).toBeDefined()
    expect(setCookies(res)).toEqual([])
  })

  test('a sign-in from an origin the environment does not allow sets no cookie', async () => {
    await createUser()
    const started = await client('POST', '/sign-ins', {
      body: { identifier: EMAIL },
      origin: OTHER,
    })
    expect(await code(started)).toBe('request.origin_not_allowed')
    expect(setCookies(started)).toEqual([])
  })
})

describe('a request authenticated by the session cookie', () => {
  test('reads the signed-in user', async () => {
    const { cookie, user } = await signedIn()
    const res = await client('GET', '/me', { cookie })
    expect(res.status).toBe(200)
    expect((await json<User>(res)).id).toBe(user.id)
  })

  test('without the cookie there is no session', async () => {
    await signedIn()
    expect(await code(await client('GET', '/me'))).toBe('auth.unauthenticated')
  })

  test.each([
    [
      'an unknown token',
      () => `${SESSION_COOKIE()}=tula_st_${'0'.repeat(64)}`,
      'session.invalid_token',
    ],
    ['an empty cookie', () => `${SESSION_COOKIE()}=`, 'auth.unauthenticated'],
  ])('%s is refused and the cookie is dropped', async (_name, cookie, expected) => {
    await signedIn()
    const res = await client('GET', '/me', { cookie: cookie() })
    expect(res.status).toBe(401)
    expect(await code(res)).toBe(expected)
  })

  test('a dead cookie is cleared so the browser stops sending it', async () => {
    await signedIn()
    const res = await client('GET', '/me', { cookie: `${SESSION_COOKIE()}=tula_st_nope` })
    expect(setCookies(res).join()).toContain(`${SESSION_COOKIE()}=;`)
    expect(setCookies(res).join()).toContain('Max-Age=0')
  })

  test('a hybrid session’s refresh token is not accepted as a session cookie', async () => {
    configure({ profiles: {} })
    const user = await createUser()
    const hybrid = await Sessions.create(deps, tenant, { userId: user.id, client: 'web' })
    const res = await client('GET', '/me', {
      cookie: `${SESSION_COOKIE()}=${hybrid.refreshToken}`,
    })
    expect(await code(res)).toBe('session.invalid_token')
  })

  test('another environment’s key does not accept the cookie', async () => {
    const { cookie } = await signedIn()
    const value = cookie.split('=')[1]
    const foreign = sessionCookieName(deps.config, TEST_TENANT.productionEnvironmentId)
    expect((await client('GET', '/me', { cookie, key: PROD_PK, origin: null })).status).toBe(401)
    const res = await client('GET', '/me', {
      cookie: `${foreign}=${value}`,
      key: PROD_PK,
      origin: null,
    })
    expect(await code(res)).toBe('session.invalid_token')
  })

  test('a Bearer token, when sent, is what counts: the cookie is not a fallback for a bad one', async () => {
    const { cookie } = await signedIn()
    const res = await client('GET', '/me', { cookie, bearer: 'not-a-token' })
    expect(await code(res)).toBe('session.invalid_token')
  })

  test('revoking the session takes effect on the very next request', async () => {
    const { cookie, sessionId, user } = await signedIn()
    expect((await client('GET', '/me', { cookie })).status).toBe(200)
    await Sessions.revoke(deps, tenant, { userId: user.id, sessionId, actor: TEST_ACTOR })
    const res = await client('GET', '/me', { cookie })
    expect(await code(res)).toBe('session.revoked')
  })

  test('the idle timeout ends it, and the absolute timeout whatever the activity', async () => {
    const { cookie } = await signedIn()
    deps.clock.advance('50m')
    expect((await client('GET', '/me', { cookie })).status).toBe(200)
    deps.clock.advance('61m')
    expect(await code(await client('GET', '/me', { cookie }))).toBe('session.expired')
  })

  test('lists the device, marks it current, and can sign the others out', async () => {
    const { cookie, sessionId, user } = await signedIn()
    const other = await Sessions.create(deps, tenant, { userId: user.id, client: 'web' })
    const list = await json<{ data: { id: string; current: boolean }[] }>(
      await client('GET', '/sessions', { cookie })
    )
    expect(list.data.find((row) => row.current)?.id).toBe(sessionId)
    const res = await client('POST', '/sessions/revoke-others', { cookie })
    expect(await json<{ revoked: number }>(res)).toEqual({ revoked: 1 })
    expect(
      (await deps.sessions.findById(tenant.environmentId, other.sessionId))?.revokedAt
    ).not.toBeNull()
  })

  test('the session check answers with the session id and no token, and rotates nothing', async () => {
    const { cookie, sessionId } = await signedIn()
    const res = await client('POST', '/sessions/refresh', { cookie, body: {} })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await json<unknown>(res)).toEqual({ sessionId })
    expect(setCookies(res)).toEqual([])
    expect((await client('GET', '/me', { cookie })).status).toBe(200)
  })

  test('signing out ends the session and clears the cookie', async () => {
    const { cookie } = await signedIn()
    const res = await client('POST', '/sessions/sign-out', { cookie, body: {} })
    expect(res.status).toBe(204)
    expect(setCookies(res).join()).toContain(`${SESSION_COOKIE()}=;`)
    expect(await code(await client('GET', '/me', { cookie }))).toBe('session.revoked')
  })

  test('revoking the current device from the list clears the cookie', async () => {
    const { cookie, sessionId } = await signedIn()
    const res = await client('DELETE', `/sessions/${sessionId}`, { cookie })
    expect(res.status).toBe(204)
    expect(setCookies(res).join()).toContain(`${SESSION_COOKIE()}=;`)
    expect(await code(await client('GET', '/me', { cookie }))).toBe('session.revoked')
  })
})

describe('the session cookie and other sites (CSRF)', () => {
  test.each([
    ['GET', '/me', undefined],
    ['POST', '/sessions/revoke-others', undefined],
    ['POST', '/sessions/refresh', {}],
    ['DELETE', '/sessions/00000000-0000-7000-8000-000000000001', undefined],
  ] as const)(
    '%s %s from an origin the environment does not allow ignores the cookie',
    async (method, path, body) => {
      const { cookie, sessionId, user } = await signedIn()
      const other = await Sessions.create(deps, tenant, { userId: user.id, client: 'web' })
      const res = await client(method, path, { cookie, origin: OTHER, body })
      expect(res.status).toBe(401)
      expect(await code(res)).toBe('auth.unauthenticated')
      // Nothing happened, and the foreign page could not make the browser drop the cookie.
      expect(setCookies(res)).toEqual([])
      for (const id of [sessionId, other.sessionId]) {
        expect((await deps.sessions.findById(tenant.environmentId, id))?.revokedAt).toBeNull()
      }
    }
  )

  test('a foreign page cannot sign the user out either', async () => {
    const { cookie, sessionId } = await signedIn()
    const res = await client('POST', '/sessions/sign-out', { cookie, origin: OTHER, body: {} })
    expect(res.status).toBe(204)
    expect(setCookies(res)).toEqual([])
    expect((await deps.sessions.findById(tenant.environmentId, sessionId))?.revokedAt).toBeNull()
  })

  test.each(['cross-site'])(
    'a request the browser marks %s ignores the cookie, whatever Origin says',
    async (site) => {
      const { cookie } = await signedIn()
      for (const origin of [APP, null]) {
        const res = await client('POST', '/sessions/revoke-others', {
          cookie,
          origin,
          headers: { 'sec-fetch-site': site },
        })
        expect(await code(res)).toBe('auth.unauthenticated')
      }
    }
  )

  test.each(['same-origin', 'same-site', 'none'])(
    'a %s request from the app is served',
    async (site) => {
      const { cookie } = await signedIn()
      const res = await client('GET', '/me', { cookie, headers: { 'sec-fetch-site': site } })
      expect(res.status).toBe(200)
    }
  )

  test('a state-changing request with the cookie must say where it comes from', async () => {
    const { cookie, sessionId } = await signedIn()
    // No Origin on an unsafe method: not something a browser's fetch from the app would send.
    const res = await client('POST', '/sessions/revoke-others', { cookie, origin: null })
    expect(await code(res)).toBe('auth.unauthenticated')
    expect((await deps.sessions.findById(tenant.environmentId, sessionId))?.revokedAt).toBeNull()
    // A read without Origin (a same-origin GET carries none) is served.
    expect((await client('GET', '/me', { cookie, origin: null })).status).toBe(200)
  })

  test('without the publishable key header the cookie reaches nothing', async () => {
    const { cookie } = await signedIn()
    const res = await app.request('/v1/client/sessions/revoke-others', {
      method: 'POST',
      headers: { cookie, origin: APP },
    })
    expect(await code(res)).toBe('auth.invalid_key')
  })

  test('a preflight from a foreign origin is not granted the profile header or credentials', async () => {
    const preflight = (origin: string) =>
      app.request('/v1/client/me', {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'x-tula-publishable-key',
        },
      })
    const foreign = await preflight(OTHER)
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull()
    const allowed = await preflight(APP)
    expect(allowed.headers.get('access-control-allow-origin')).toBe(APP)
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true')
    expect(allowed.headers.get('access-control-allow-headers')).toContain(SESSION_PROFILE_HEADER)
  })
})

describe('POST /v1/admin/sessions/verify', () => {
  const verify = (token: unknown, key: string | null = SK) =>
    admin('POST', '/sessions/verify', { token }, key)
  const tokenIn = (cookie: string) => cookie.slice(cookie.indexOf('=') + 1)

  test('answers a stateful session’s token with the claims an access token would carry', async () => {
    const { cookie, sessionId, user } = await signedIn()
    const res = await verify(tokenIn(cookie))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const claims = await json<AccessTokenClaims>(res)
    const now = Math.floor(deps.clock.now().getTime() / 1000)
    expect(claims).toMatchObject({
      sub: user.id,
      sid: sessionId,
      eid: tenant.environmentId,
      pid: tenant.projectId,
      aud: tenant.environmentId,
      auth_time: now,
      amr: ['pwd'],
      sp: 'web',
      v: 1,
    })
    expect(claims.exp).toBeGreaterThan(now)
  })

  test('answers a hybrid session’s access token too, and refuses it once revoked', async () => {
    configure({ profiles: {} })
    const user = await createUser()
    const hybrid = await Sessions.create(deps, tenant, { userId: user.id, client: 'ios' })
    const claims = await json<AccessTokenClaims>(await verify(hybrid.accessToken))
    expect(claims).toMatchObject({ sub: user.id, sid: hybrid.sessionId, sp: 'mobile' })
    await Sessions.revoke(deps, tenant, {
      userId: user.id,
      sessionId: hybrid.sessionId,
      actor: TEST_ACTOR,
    })
    expect(await code(await verify(hybrid.accessToken))).toBe('session.revoked')
  })

  test('a revoked session is refused on the very next call', async () => {
    const { cookie, sessionId, user } = await signedIn()
    await Sessions.revoke(deps, tenant, { userId: user.id, sessionId, actor: TEST_ACTOR })
    const res = await verify(tokenIn(cookie))
    expect(res.status).toBe(401)
    expect(await code(res)).toBe('session.revoked')
  })

  test.each([
    ['an unknown token', 'tula_st_nope', 401, 'session.invalid_token'],
    ['a refresh token', 'tula_rt_nope', 401, 'session.invalid_token'],
    ['a malformed JWT', 'a.b.c', 401, 'session.invalid_token'],
    ['an empty token', '', 422, 'validation.failed'],
    ['no token', undefined, 422, 'validation.failed'],
    ['an oversized token', 'x'.repeat(5000), 422, 'validation.failed'],
  ])('%s is refused', async (_name, token, status, expected) => {
    await signedIn()
    const res = await verify(token)
    expect(res.status).toBe(status)
    expect(await code(res)).toBe(expected)
  })

  test('a hybrid refresh token is never answered with claims', async () => {
    configure({ profiles: {} })
    const user = await createUser()
    const hybrid = await Sessions.create(deps, tenant, { userId: user.id, client: 'web' })
    expect(await code(await verify(hybrid.refreshToken))).toBe('session.invalid_token')
  })

  test('needs a secret key, of the session’s own environment', async () => {
    const { cookie } = await signedIn()
    expect(await code(await verify(tokenIn(cookie), null))).toBe('auth.invalid_key')
    expect(await code(await verify(tokenIn(cookie), PK))).toBe('auth.invalid_key')
    expect(await code(await verify(tokenIn(cookie), PROD_SK))).toBe('session.invalid_token')
  })

  test('the token never reaches the audit log', async () => {
    const { cookie } = await signedIn()
    await verify(tokenIn(cookie))
    const { entries } = await deps.activityLog.listAudit(tenant.environmentId, {
      page: 1,
      size: 50,
    })
    expect(JSON.stringify(entries)).not.toContain('tula_st_')
  })
})

describe('asking for a profile over HTTP', () => {
  beforeEach(() => {
    configure({
      profiles: {
        admin: { accessTokenTtl: '2m', clientSelectable: true },
        forever: { idleTimeout: '365d', absoluteTimeout: null },
      },
    })
  })

  async function profileOf(res: Response): Promise<string | undefined> {
    const { session } = await json<FlowAttempt>(res)
    return decodeJwt<AccessTokenClaims>(session?.accessToken ?? '').sp
  }

  test('the header picks a profile the environment offers', async () => {
    await createUser()
    expect(await profileOf(await signIn({ [SESSION_PROFILE_HEADER]: 'admin' }))).toBe('admin')
  })

  test('the header is read when the attempt starts, not when it completes', async () => {
    await createUser()
    const started = await json<FlowAttempt>(
      await client('POST', '/sign-ins', { body: { identifier: EMAIL } })
    )
    const res = await client('POST', `/sign-ins/${started.id}/password`, {
      body: { password: PASSWORD },
      headers: { 'x-tula-attempt': started.attemptSecret ?? '', [SESSION_PROFILE_HEADER]: 'admin' },
    })
    expect(await profileOf(res)).toBe('web')
  })

  test.each(['forever', 'nope', 'mobile'])(
    'asking for %p gives an ordinary web session, not an error',
    async (name) => {
      await createUser()
      const res = await signIn({ [SESSION_PROFILE_HEADER]: name })
      expect(res.status).toBe(200)
      expect(await profileOf(res)).toBe('web')
    }
  )

  test.each(['x'.repeat(65), 'Not A Name'])(
    'a malformed profile header (%p) is a validation error at the start',
    async (name) => {
      await createUser()
      const res = await client('POST', '/sign-ins', {
        body: { identifier: EMAIL },
        headers: { [SESSION_PROFILE_HEADER]: name },
      })
      expect(res.status).toBe(422)
    }
  )
})

describe('the session limit over HTTP', () => {
  test('refuse_newest answers session.limit_reached with no session and no cookie', async () => {
    configure({ maxPerUser: 1, onLimit: 'refuse_newest' })
    const user = await createUser()
    expect((await signIn()).status).toBe(200)
    const res = await signIn()
    expect(res.status).toBe(403)
    expect(((await res.clone().json()) as { code: string }).code).toBe('session.limit_reached')
    expect(setCookies(res)).toEqual([])
    expect(await res.text()).not.toContain('accessToken')
    expect(
      await deps.sessions.listActiveByUser(tenant.environmentId, user.id, deps.clock.now())
    ).toHaveLength(1)
  })

  test('a wrong password at the limit is still just a wrong password', async () => {
    configure({ maxPerUser: 1, onLimit: 'refuse_newest' })
    await createUser()
    await signIn()
    const started = await json<FlowAttempt>(
      await client('POST', '/sign-ins', { body: { identifier: EMAIL } })
    )
    const res = await client('POST', `/sign-ins/${started.id}/password`, {
      body: { password: 'not the password at all 1' },
      headers: { 'x-tula-attempt': started.attemptSecret ?? '' },
    })
    expect(await code(res)).toBe('auth.invalid_credentials')
  })

  test('end_oldest signs the new device in and the oldest out', async () => {
    configure({ maxPerUser: 1, onLimit: 'end_oldest' })
    const user = await createUser()
    const first = await json<FlowAttempt>(await signIn())
    const second = await json<FlowAttempt>(await signIn())
    const active = await deps.sessions.listActiveByUser(
      tenant.environmentId,
      user.id,
      deps.clock.now()
    )
    expect(active.map((row) => row.id)).toEqual([second.session?.sessionId ?? ''])
    const res = await client('GET', '/me', { bearer: first.session?.accessToken })
    expect(await code(res)).toBe('session.revoked')
  })
})

describe('the step-up window of a profile', () => {
  const sensitive = (options: Options) =>
    client('POST', '/me/factors/totp', { ...options, body: {} })

  test('past the profile’s window a sensitive route asks for a step-up', async () => {
    configure({
      profiles: {
        web: { accessTokenTtl: '15m' },
        strict: { accessTokenTtl: '15m', stepUpAfter: '2m', clientSelectable: true },
        relaxed: { accessTokenTtl: '15m', stepUpAfter: '1h', clientSelectable: true },
      },
    })
    await createUser()
    const token = async (profile?: string) =>
      (await json<FlowAttempt>(await signIn(profile ? { [SESSION_PROFILE_HEADER]: profile } : {})))
        .session?.accessToken
    const [strict, normal, relaxed] = [await token('strict'), await token(), await token('relaxed')]

    deps.clock.advance('3m')
    expect(await code(await sensitive({ bearer: strict }))).toBe('auth.step_up_required')
    expect((await sensitive({ bearer: normal })).status).toBe(200)

    deps.clock.advance('8m')
    expect(await code(await sensitive({ bearer: normal }))).toBe('auth.step_up_required')
    expect((await sensitive({ bearer: relaxed })).status).toBe(200)
  })

  test('a stateful session is held to its profile’s window, and a step-up reopens it', async () => {
    configure({ profiles: { web: { type: 'stateful', stepUpAfter: '2m' } } })
    const { cookie, sessionId } = await signedIn()
    deps.clock.advance('3m')
    expect(await code(await sensitive({ cookie }))).toBe('auth.step_up_required')

    const stepped = await client('POST', '/sessions/step-up', {
      cookie,
      body: { method: 'password', password: PASSWORD },
    })
    expect(stepped.status).toBe(200)
    expect(await json<unknown>(stepped)).toEqual({ sessionId })
    expect((await sensitive({ cookie })).status).toBe(200)
  })

  test('a step-up from a foreign origin with the cookie proves nothing', async () => {
    configure({ profiles: { web: { type: 'stateful', stepUpAfter: '2m' } } })
    const { cookie } = await signedIn()
    const res = await client('POST', '/sessions/step-up', {
      cookie,
      origin: OTHER,
      body: { method: 'password', password: PASSWORD },
    })
    expect(await code(res)).toBe('auth.unauthenticated')
  })
})

describe('DELETE /v1/admin/users/:userId/sessions', () => {
  test('ends every session of the user, at once for a stateful one, and records who did it', async () => {
    const { cookie, sessionId, user } = await signedIn()
    const hybrid = await Sessions.create(deps, tenant, { userId: user.id, client: 'ios' })
    const res = await admin('DELETE', `/users/${user.id}/sessions`)
    expect(res.status).toBe(200)
    expect(await json<unknown>(res)).toEqual({ revoked: 2 })
    expect(await code(await client('GET', '/me', { cookie }))).toBe('session.revoked')
    expect(await code(await client('GET', '/me', { bearer: hybrid.accessToken }))).toBe(
      'session.revoked'
    )
    const row = await deps.sessions.findById(tenant.environmentId, sessionId)
    expect(row?.revokeReason).toBe('revoked_by_admin')
    const { entries } = await deps.activityLog.listAudit(tenant.environmentId, {
      targetId: sessionId,
      page: 1,
      size: 10,
    })
    expect(entries.find((entry) => entry.type === 'session.revoked')?.actor.type).toBe('admin')
  })

  test('is idempotent, and frees a user kept out by refuse_newest', async () => {
    configure({ maxPerUser: 1, onLimit: 'refuse_newest' })
    const user = await createUser()
    await signIn()
    expect((await signIn()).status).toBe(403)
    expect(await json<unknown>(await admin('DELETE', `/users/${user.id}/sessions`))).toEqual({
      revoked: 1,
    })
    expect(await json<unknown>(await admin('DELETE', `/users/${user.id}/sessions`))).toEqual({
      revoked: 0,
    })
    expect((await signIn()).status).toBe(200)
  })

  test('an unknown user, another environment’s user and a malformed id end nothing', async () => {
    const { sessionId, user } = await signedIn()
    const unknown = '00000000-0000-7000-8000-00000000dead'
    expect((await admin('DELETE', `/users/${unknown}/sessions`)).status).toBe(404)
    expect((await admin('DELETE', `/users/${user.id}/sessions`, undefined, PROD_SK)).status).toBe(
      404
    )
    expect((await admin('DELETE', '/users/not-a-uuid/sessions')).status).toBe(422)
    expect(await code(await admin('DELETE', `/users/${user.id}/sessions`, undefined, PK))).toBe(
      'auth.invalid_key'
    )
    expect((await deps.sessions.findById(tenant.environmentId, sessionId))?.revokedAt).toBeNull()
  })
})
