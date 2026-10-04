import { describe, expect, test } from 'bun:test'
import { ServiceUnavailableError } from '~/exceptions'
import { createApp } from '~/index'
import { sha256Hex } from '~/lib/crypto'
import { createKeyedHash } from '~/lib/keyed-hash'
import { INSTANCE_RATE_LIMIT } from '~/middleware/instance-admin'
import {
  createInstanceTestDeps,
  createTestDeps,
  dashboardHeaders,
  dashboardSignIn,
  TEST_ADMIN_TOKEN,
  TEST_CONFIG,
  type TestDeps,
} from '~/testing'

const PATH = '/v1/instance/session'
const EIGHT_HOURS_S = 8 * 60 * 60

function signIn(app: ReturnType<typeof createApp>, body: unknown, headers = dashboardHeaders()) {
  return app.request(PATH, { method: 'POST', headers, body: JSON.stringify(body) })
}

function check(app: ReturnType<typeof createApp>, cookie?: string) {
  return app.request(PATH, { headers: dashboardHeaders(cookie) })
}

async function code(res: Response): Promise<string> {
  return ((await res.json()) as { code: string }).code
}

/** `name=value` → the parts of the signed value. */
function parts(cookie: string): [string, string, string] {
  const [version = '', payload = '', mac = ''] = cookie.slice(cookie.indexOf('=') + 1).split('.')
  return [version, payload, mac]
}

function name(cookie: string): string {
  return cookie.slice(0, cookie.indexOf('='))
}

describe('POST /v1/instance/session', () => {
  test('without TULA_ADMIN_TOKEN the route does not exist', async () => {
    const app = createApp(createTestDeps())
    const unknown = await app.request('/v1/instance/nothing-here')
    for (const res of [await signIn(app, { token: TEST_ADMIN_TOKEN }), await check(app)]) {
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual(await unknown.clone().json())
    }
  })

  test('the right token sets two HttpOnly, SameSite=Strict cookies, one per route group', async () => {
    const deps = createInstanceTestDeps()
    const res = await signIn(createApp(deps), { token: TEST_ADMIN_TOKEN })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const expiresAt = new Date(deps.clock.now().getTime() + EIGHT_HOURS_S * 1000).toISOString()
    expect(await res.json()).toEqual({ expiresAt })

    const cookies = res.headers.getSetCookie()
    expect(cookies).toHaveLength(2)
    const paths = cookies.map((cookie) => /; Path=([^;]+)/.exec(cookie)?.[1]).sort()
    // Never `/` or `/v1`: the browser does not send it to `/v1/client/*`, `/v1/docs` or the
    // dashboard's own files.
    expect(paths).toEqual(['/v1/admin', '/v1/instance'])
    for (const cookie of cookies) {
      expect(cookie.startsWith('tula_dashboard=v1.')).toBe(true)
      expect(cookie).toContain('; HttpOnly')
      expect(cookie).toContain('; SameSite=Strict')
      expect(cookie).toContain(`; Max-Age=${EIGHT_HOURS_S}`)
      // Plain http (local development): no Secure, no prefix, no Domain.
      expect(cookie).not.toContain('Secure')
      expect(cookie).not.toContain('Domain')
    }
    // The same value under both paths.
    expect(new Set(cookies.map((cookie) => cookie.split(';')[0])).size).toBe(1)
  })

  test('over https the cookies are Secure and carry the __Secure- prefix', async () => {
    const config = { ...TEST_CONFIG, publicUrl: 'https://auth.example.com' }
    const res = await signIn(
      createApp(createInstanceTestDeps({ config })),
      { token: TEST_ADMIN_TOKEN },
      { ...dashboardHeaders(), origin: 'https://auth.example.com' }
    )
    expect(res.status).toBe(200)
    for (const cookie of res.headers.getSetCookie()) {
      expect(cookie.startsWith('__Secure-tula_dashboard=v1.')).toBe(true)
      expect(cookie).toContain('; Secure')
      expect(cookie).toContain('; HttpOnly')
      expect(cookie).toContain('; SameSite=Strict')
    }
  })

  test('a wrong token, a missing one and a malformed body field get the same 401 and no cookie', async () => {
    const deps = createInstanceTestDeps()
    const app = createApp(deps)
    const answers: string[] = []
    for (const body of [
      { token: 'wrong-token-wrong-token-wrong-token' },
      { token: TEST_ADMIN_TOKEN.slice(0, -1) },
      { token: `${TEST_ADMIN_TOKEN}x` },
      { token: '' },
      { token: 'x'.repeat(10_000) },
      { token: 42 },
      { token: null },
      {},
      { password: TEST_ADMIN_TOKEN },
    ]) {
      const res = await signIn(app, body)
      expect(res.status).toBe(401)
      expect(res.headers.getSetCookie()).toEqual([])
      const answer = (await res.json()) as Record<string, unknown>
      expect(answer.code).toBe('auth.invalid_key')
      // The request id differs per request; everything else must not.
      answers.push(JSON.stringify({ ...answer, requestId: undefined }))
    }
    expect(new Set(answers).size).toBe(1)
    // Each failure is recorded, with nothing of what was presented.
    const failures = deps.controlPlane.ofType('instance.sign_in_failed')
    expect(failures).toHaveLength(9)
    expect(JSON.stringify(failures)).not.toContain('wrong-token')
    expect(JSON.stringify(failures)).not.toContain(TEST_ADMIN_TOKEN.slice(0, 8))
    expect(failures[0]).toMatchObject({ actor: { type: 'instance_admin', id: null }, target: null })
  })

  test('the token is never accepted from the Authorization header or the query', async () => {
    const app = createApp(createInstanceTestDeps())
    const viaHeader = await app.request(PATH, {
      method: 'POST',
      headers: { ...dashboardHeaders(), authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      body: '{}',
    })
    expect(viaHeader.status).toBe(400)
    expect(viaHeader.headers.getSetCookie()).toEqual([])
    const viaQuery = await app.request(`${PATH}?token=${TEST_ADMIN_TOKEN}`, {
      method: 'POST',
      headers: dashboardHeaders(),
      body: '{}',
    })
    expect(viaQuery.status).toBe(401)
  })

  test('guesses are counted: past the limit the right token is refused too', async () => {
    const app = createApp(createInstanceTestDeps())
    for (let i = 0; i < INSTANCE_RATE_LIMIT; i += 1) {
      expect((await signIn(app, { token: 'wrong-token-wrong-token-wrong-token' })).status).toBe(401)
    }
    const res = await signIn(app, { token: TEST_ADMIN_TOKEN })
    expect(res.status).toBe(429)
    expect(res.headers.getSetCookie()).toEqual([])
  })

  test('when the limiter cannot count, the sign-in is refused, not allowed uncounted', async () => {
    const deps = createInstanceTestDeps()
    deps.rateLimiter.hit = async () => {
      throw new ServiceUnavailableError()
    }
    const res = await signIn(createApp(deps), { token: TEST_ADMIN_TOKEN })
    expect(res.status).toBe(503)
    expect(res.headers.getSetCookie()).toEqual([])
  })

  test('a sign-in is recorded with the session id as the actor and no token material', async () => {
    const deps = createInstanceTestDeps()
    const app = createApp(deps)
    const cookie = await dashboardSignIn(app)
    const [entry] = deps.controlPlane.ofType('instance.signed_in')
    expect(entry?.actor.type).toBe('instance_admin')
    expect(entry?.actor.id).toMatch(/^[0-9a-f-]{36}$/)
    const text = JSON.stringify(deps.controlPlane.entries)
    expect(text).not.toContain(TEST_ADMIN_TOKEN)
    expect(text).not.toContain(sha256Hex(TEST_ADMIN_TOKEN))
    for (const part of parts(cookie).slice(1)) {
      expect(text).not.toContain(part)
    }
  })
})

describe('GET /v1/instance/session', () => {
  test('a valid session answers its expiry; none answers 401', async () => {
    const deps = createInstanceTestDeps()
    const app = createApp(deps)
    expect((await check(app)).status).toBe(401)
    const cookie = await dashboardSignIn(app)
    const res = await check(app, cookie)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({
      expiresAt: new Date(deps.clock.now().getTime() + EIGHT_HOURS_S * 1000).toISOString(),
    })
  })

  test('the session ends eight hours after sign-in, whatever was done with it', async () => {
    const deps = createInstanceTestDeps()
    const app = createApp(deps)
    const cookie = await dashboardSignIn(app)
    deps.clock.advance(EIGHT_HOURS_S * 1000 - 1000)
    // Using it does not extend it: no new cookie is set.
    const late = await check(app, cookie)
    expect(late.status).toBe(200)
    expect(late.headers.getSetCookie()).toEqual([])
    deps.clock.advance(1000)
    const expired = await check(app, cookie)
    expect(expired.status).toBe(401)
    expect(await code(expired)).toBe('auth.unauthenticated')
  })

  test('a tampered payload or signature is refused', async () => {
    const deps = createInstanceTestDeps()
    const app = createApp(deps)
    const cookie = await dashboardSignIn(app)
    const [version, payload, mac] = parts(cookie)
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { exp: number }
    const longer = Buffer.from(JSON.stringify({ ...decoded, exp: decoded.exp + 86_400 })).toString(
      'base64url'
    )
    const flipped = `${mac.slice(0, -1)}${mac.endsWith('0') ? '1' : '0'}`
    for (const value of [
      `${version}.${longer}.${mac}`,
      `${version}.${payload}.${flipped}`,
      `${version}.${payload}.`,
      `${version}.${payload}`,
      `v2.${payload}.${mac}`,
      `${version}.${payload}.${mac}.extra`,
      `${version}.not-json.${mac}`,
      '',
      'x'.repeat(5000),
    ]) {
      const res = await check(app, `${name(cookie)}=${value}`)
      expect(res.status).toBe(401)
      expect(await code(res)).toBe('auth.unauthenticated')
    }
    // The untouched one still works.
    expect((await check(app, cookie)).status).toBe(200)
  })

  test('a payload that is correctly signed but not a session is refused', async () => {
    // Defence in depth: even with the key, a session past the absolute lifetime is not honoured.
    const deps = createInstanceTestDeps()
    const now = Math.floor(deps.clock.now().getTime() / 1000)
    for (const body of [
      { sid: 'a', iat: now, exp: now + EIGHT_HOURS_S + 1 },
      { sid: 'a', iat: now + 3600, exp: now + 7200 },
      { sid: '', iat: now, exp: now + 60 },
      { iat: now, exp: now + 60 },
      { sid: 'a', iat: 'x', exp: now + 60 },
      [],
    ]) {
      const payload = Buffer.from(JSON.stringify(body)).toString('base64url')
      const mac = await deps.keyedHash.hmac(
        'dashboard-sessions',
        `v1.${payload}.${deps.config.instanceAdminTokenHash}`
      )
      const res = await check(createApp(deps), `tula_dashboard=v1.${payload}.${mac}`)
      expect(res.status).toBe(401)
    }
  })

  test('rotating the admin token ends every session made before it', async () => {
    const before = createInstanceTestDeps()
    const cookie = await dashboardSignIn(createApp(before))
    const rotated: TestDeps = createInstanceTestDeps()
    rotated.config = {
      ...rotated.config,
      instanceAdminTokenHash: sha256Hex('n3wT0kenValu3-Zq8vR1pX5wB7tM2yC9'),
    }
    expect((await check(createApp(rotated), cookie)).status).toBe(401)
    // Another instance with the same token and master key honours it: nothing is stored.
    expect((await check(createApp(createInstanceTestDeps()), cookie)).status).toBe(200)
  })

  test('changing the master key ends every session', async () => {
    const cookie = await dashboardSignIn(createApp(createInstanceTestDeps()))
    const rekeyed = createInstanceTestDeps({ keyedHash: createKeyedHash('cd'.repeat(32)) })
    expect((await check(createApp(rekeyed), cookie)).status).toBe(401)
  })

  test('removing the admin token ends every session and the routes', async () => {
    const cookie = await dashboardSignIn(createApp(createInstanceTestDeps()))
    expect((await check(createApp(createTestDeps()), cookie)).status).toBe(404)
  })
})

describe('DELETE /v1/instance/session', () => {
  test('clears both cookies and records the sign-out', async () => {
    const deps = createInstanceTestDeps()
    const app = createApp(deps)
    const cookie = await dashboardSignIn(app)
    const res = await app.request(PATH, { method: 'DELETE', headers: dashboardHeaders(cookie) })
    expect(res.status).toBe(204)
    const cleared = res.headers.getSetCookie()
    expect(cleared.map((value) => /; Path=([^;]+)/.exec(value)?.[1]).sort()).toEqual([
      '/v1/admin',
      '/v1/instance',
    ])
    for (const value of cleared) {
      expect(value.startsWith('tula_dashboard=;')).toBe(true)
      expect(value).toContain('Max-Age=0')
    }
    const [signedIn] = deps.controlPlane.ofType('instance.signed_in')
    const [signedOut] = deps.controlPlane.ofType('instance.signed_out')
    expect(signedOut?.actor).toEqual(signedIn?.actor as NonNullable<typeof signedOut>['actor'])
  })

  test('without a session it still clears the cookies and records nothing', async () => {
    const deps = createInstanceTestDeps()
    const res = await createApp(deps).request(PATH, {
      method: 'DELETE',
      headers: dashboardHeaders(),
    })
    expect(res.status).toBe(204)
    expect(res.headers.getSetCookie()).toHaveLength(2)
    expect(deps.controlPlane.ofType('instance.signed_out')).toEqual([])
  })
})

describe('cross-site request forgery', () => {
  const FOREIGN = 'https://evil.example'

  async function setup() {
    const deps = createInstanceTestDeps()
    const app = createApp(deps)
    const cookie = await dashboardSignIn(app)
    return { deps, app, cookie }
  }

  test('a state-changing request from a foreign origin is refused before anything happens', async () => {
    const { deps, app, cookie } = await setup()
    const res = await app.request(PATH, {
      method: 'DELETE',
      headers: { ...dashboardHeaders(cookie), origin: FOREIGN },
    })
    expect(res.status).toBe(403)
    expect(await code(res)).toBe('request.origin_not_allowed')
    expect(res.headers.getSetCookie()).toEqual([])
    expect(deps.controlPlane.ofType('instance.signed_out')).toEqual([])
  })

  test('a request the browser marks cross-site is refused, even with an allowed origin', async () => {
    const { deps, app, cookie } = await setup()
    for (const method of ['DELETE', 'GET']) {
      const res = await app.request(PATH, {
        method,
        headers: { ...dashboardHeaders(cookie), 'sec-fetch-site': 'cross-site' },
      })
      expect(res.status).toBe(403)
      expect(await code(res)).toBe('request.origin_not_allowed')
    }
    expect(deps.controlPlane.ofType('instance.signed_out')).toEqual([])
  })

  test('same-origin and same-site fetch metadata are accepted', async () => {
    const { app, cookie } = await setup()
    for (const site of ['same-origin', 'same-site', 'none']) {
      const res = await app.request(PATH, {
        headers: { ...dashboardHeaders(cookie), 'sec-fetch-site': site },
      })
      expect(res.status).toBe(200)
    }
  })

  test('without the custom header the cookie is ignored', async () => {
    const { deps, app, cookie } = await setup()
    const { 'x-tula-dashboard': _dropped, ...headers } = dashboardHeaders(cookie)
    for (const init of [
      { method: 'GET', headers },
      { method: 'DELETE', headers },
      { method: 'GET', headers: { ...headers, 'x-tula-dashboard': '0' } },
      { method: 'GET', headers: { ...headers, 'x-tula-dashboard': 'true' } },
    ]) {
      const res = await app.request(PATH, init)
      expect(res.status).toBe(401)
      expect(res.headers.getSetCookie()).toEqual([])
    }
    expect(deps.controlPlane.ofType('instance.signed_out')).toEqual([])
  })

  test('a state-changing request with no Origin is refused; a read with none is served', async () => {
    const { deps, app, cookie } = await setup()
    const { origin: _dropped, ...headers } = dashboardHeaders(cookie)
    const unsafe = await app.request(PATH, { method: 'DELETE', headers })
    expect(unsafe.status).toBe(403)
    expect(await code(unsafe)).toBe('request.origin_not_allowed')
    expect(deps.controlPlane.ofType('instance.signed_out')).toEqual([])
    expect((await app.request(PATH, { headers })).status).toBe(200)
  })

  test('a read from a foreign origin is refused too', async () => {
    const { app, cookie } = await setup()
    const res = await app.request(PATH, {
      headers: { ...dashboardHeaders(cookie), origin: FOREIGN },
    })
    expect(res.status).toBe(403)
  })

  test('signing in is held to the same rules, before the token is looked at', async () => {
    const deps = createInstanceTestDeps()
    const app = createApp(deps)
    const { origin: _origin, ...noOrigin } = dashboardHeaders()
    const { 'x-tula-dashboard': _header, ...noHeader } = dashboardHeaders()
    for (const headers of [
      { ...dashboardHeaders(), origin: FOREIGN },
      { ...dashboardHeaders(), 'sec-fetch-site': 'cross-site' },
      noOrigin,
      noHeader,
    ]) {
      const res = await signIn(app, { token: TEST_ADMIN_TOKEN }, headers)
      expect(res.status).toBe(403)
      expect(await code(res)).toBe('request.origin_not_allowed')
      expect(res.headers.getSetCookie()).toEqual([])
    }
    expect(deps.controlPlane.entries).toEqual([])
  })

  test('an origin on the deployment’s CORS_ORIGINS list is allowed (vite dev), a tenant’s is not', async () => {
    const config = {
      ...TEST_CONFIG,
      tier: 'prod' as const,
      publicUrl: 'https://auth.example.com',
      corsOrigins: ['https://dashboard.example.com'],
    }
    const deps = createInstanceTestDeps({ config })
    const app = createApp(deps)
    const from = (origin: string) =>
      signIn(app, { token: TEST_ADMIN_TOKEN }, { ...dashboardHeaders(), origin })
    expect((await from('https://dashboard.example.com')).status).toBe(200)
    expect((await from('https://auth.example.com')).status).toBe(200)
    // Not a prefix, not a subdomain, not another scheme, and loopback only in the local tier.
    for (const origin of [
      'https://dashboard.example.com.evil.example',
      'https://x.dashboard.example.com',
      'http://dashboard.example.com',
      'http://localhost:5173',
      'null',
    ]) {
      expect((await from(origin)).status).toBe(403)
    }
  })

  test('the preflight allows the dashboard headers for deployment origins only', async () => {
    const config = { ...TEST_CONFIG, tier: 'prod' as const, corsOrigins: ['https://dash.example'] }
    const app = createApp(createInstanceTestDeps({ config }))
    const preflight = (origin: string) =>
      app.request('/v1/admin/users', {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'GET' },
      })
    const allowed = await preflight('https://dash.example')
    const headers = allowed.headers.get('access-control-allow-headers')?.toLowerCase() ?? ''
    expect(headers).toContain('x-tula-dashboard')
    expect(headers).toContain('x-tula-environment')
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true')
    expect((await preflight(FOREIGN)).headers.get('access-control-allow-origin')).toBeNull()
  })
})
