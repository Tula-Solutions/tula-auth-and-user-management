import { beforeAll, describe, expect, test } from 'bun:test'
import { NextRequest } from 'next/server'
import { authenticate } from './helpers'
import { tulaMiddleware } from './middleware'
import {
  API,
  APP,
  createFakeApi,
  createSigner,
  ENV,
  type FakeApi,
  KEY,
  SECRET,
  type Signer,
  unsignedToken,
} from './testing/keys'

let signer: Signer
let stranger: Signer

beforeAll(async () => {
  signer = await createSigner('key-1')
  stranger = await createSigner('key-1')
})

function get(path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`${APP}${path}`, { headers })
}

/** The request headers the middleware hands to the rest of the request. */
function overridden(response: Response): Headers {
  const headers = new Headers()
  for (const name of (response.headers.get('x-middleware-override-headers') ?? '').split(',')) {
    const value = response.headers.get(`x-middleware-request-${name}`)
    if (name && value !== null) {
      headers.set(name, value)
    }
  }
  return headers
}

function isNext(response: Response): boolean {
  return response.headers.get('x-middleware-next') === '1'
}

function protect(api: FakeApi, extra: Record<string, unknown> = {}) {
  return tulaMiddleware({ ...api.options, publicRoutes: ['/', '/sign-up'], ...extra })
}

/** What `auth()` would say for the request the middleware let through. */
async function authAfter(api: FakeApi, response: Response) {
  return authenticate(new Request(`${APP}/x`, { headers: overridden(response) }), api.options)
}

describe('a valid access token', () => {
  test('lets a protected route through without calling the API for anything but keys', async () => {
    const api = createFakeApi([signer])
    const response = await protect(api)(
      get('/dashboard', { cookie: `tula_at=${await signer.sign()}; other=1` })
    )
    expect(isNext(response)).toBe(true)
    expect(response.headers.getSetCookie()).toEqual([])
    expect(api.requests.map((request) => new URL(request.url).pathname)).toEqual([
      `/v1/environments/${ENV}/.well-known/jwks.json`,
    ])
    const auth = await authAfter(api, response)
    expect(auth.userId).toBe('user_1')
    expect(auth.sessionId).toBe('sess_1')
    expect(auth.claims?.amr).toEqual(['pwd'])
  })

  test('keys are fetched once for many requests', async () => {
    const api = createFakeApi([signer])
    const middleware = protect(api)
    for (let i = 0; i < 3; i += 1) {
      await middleware(get('/dashboard', { cookie: `tula_at=${await signer.sign()}` }))
    }
    expect(api.count(`/v1/environments/${ENV}/.well-known/jwks.json`)).toBe(1)
  })
})

describe('a token that must not be accepted', () => {
  const past = () => Math.floor(Date.now() / 1000) - 120
  const cases: Array<[string, () => Promise<string>]> = [
    ['expired', () => signer.sign({ exp: past(), iat: past() - 60 })],
    [
      'from another issuer',
      () => signer.sign({ iss: 'http://evil.example/v1/environments/env_1' }),
    ],
    [
      'for another environment of the same API',
      () => signer.sign({ iss: `${API}/v1/environments/env_2`, aud: 'env_2' }),
    ],
    ['for another audience', () => signer.sign({ aud: 'env_2' })],
    [
      'with alg none',
      async () =>
        unsignedToken({
          iss: `${API}/v1/environments/${ENV}`,
          sub: 'user_1',
          aud: ENV,
          sid: 's',
          exp: past() + 600,
        }),
    ],
    [
      'signed with HS256 using the public key as the secret',
      async () => {
        const { SignJWT } = await import('jose')
        return new SignJWT({
          iss: `${API}/v1/environments/${ENV}`,
          sub: 'user_1',
          aud: ENV,
          sid: 's',
        })
          .setProtectedHeader({ alg: 'HS256', kid: 'key-1' })
          .setExpirationTime('1m')
          .sign(new TextEncoder().encode(signer.jwk.x as string))
      },
    ],
    ['with an unknown kid', () => signer.sign({}, { kid: 'key-9' })],
    ['with no kid', () => signer.sign({}, { kid: undefined })],
    ['signed by another key under the same kid', () => stranger.sign()],
    [
      'with a tampered payload',
      async () => {
        const [header, , signature] = (await signer.sign()).split('.')
        const payload = btoa(
          JSON.stringify({ sub: 'admin', aud: ENV, sid: 's', exp: past() + 600 })
        ).replace(/=+$/, '')
        return `${header}.${payload}.${signature}`
      },
    ],
    ['with no subject', () => signer.sign({ sub: undefined })],
    ['with no session id', () => signer.sign({ sid: undefined })],
    ['that is not a token', async () => 'garbage'],
  ]

  test.each(cases)('%s: a protected route redirects to sign-in', async (_name, make) => {
    const api = createFakeApi([signer])
    const response = await protect(api)(
      get('/dashboard?tab=1', { cookie: `tula_at=${await make()}` })
    )
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(
      `${APP}/sign-in?redirect_url=%2Fdashboard%3Ftab%3D1`
    )
    expect(api.count('/v1/client/sessions/refresh')).toBe(0)
  })

  test.each(cases)('%s: auth() says signed out', async (_name, make) => {
    const api = createFakeApi([signer])
    const auth = await authenticate(
      new Request(`${APP}/x`, { headers: { cookie: `tula_at=${await make()}` } }),
      api.options
    )
    expect(auth).toMatchObject({ isSignedIn: false, userId: null, sessionId: null, claims: null })
    expect(await auth.getToken()).toBeNull()
  })

  test('a token about to expire is treated as expired and refreshed', async () => {
    const api = createFakeApi([signer])
    const fresh = await signer.sign({ sid: 'sess_1' })
    api.on('POST /v1/client/sessions/refresh', () =>
      Response.json({
        sessionId: 'sess_1',
        accessToken: fresh,
        accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
    )
    const soon = Math.floor(Date.now() / 1000) + 3
    const response = await protect(api)(
      get('/dashboard', { cookie: `tula_at=${await signer.sign({ exp: soon })}; tula_rt=r1` })
    )
    expect(isNext(response)).toBe(true)
    expect(api.count('/v1/client/sessions/refresh')).toBe(1)
  })
})

describe('refreshing', () => {
  function refreshing(
    api: FakeApi,
    token: string,
    cookie = `tula_rt_${ENV}=r2; Max-Age=600; Path=/v1/client/sessions; HttpOnly`
  ) {
    api.on('POST /v1/client/sessions/refresh', () =>
      Response.json(
        {
          sessionId: 'sess_1',
          accessToken: token,
          accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        { headers: { 'set-cookie': cookie } }
      )
    )
  }

  test('no access token and a refresh cookie: one refresh, rotated cookies, and the same request sees the new token', async () => {
    const api = createFakeApi([signer])
    const fresh = await signer.sign()
    refreshing(api, fresh)
    const response = await protect(api, { trustedProxyHops: 1 })(
      get('/dashboard', {
        cookie: 'theme=dark; tula_rt=r1',
        'x-forwarded-for': '203.0.113.9',
        'user-agent': 'UA/1',
      })
    )
    expect(isNext(response)).toBe(true)
    const cookies = response.headers.getSetCookie()
    expect(cookies).toContain('tula_rt=r2; Path=/; HttpOnly; SameSite=Lax; Max-Age=600')
    expect(
      cookies.some((line) =>
        line.startsWith(`tula_at=${fresh}; Path=/; HttpOnly; SameSite=Lax; Max-Age=`)
      )
    ).toBe(true)

    const sent = api.requests.find((request) => request.method === 'POST') as Request
    expect(sent.headers.get('origin')).toBe(APP)
    expect(sent.headers.get('x-tula-publishable-key')).toBe(KEY)
    expect(sent.headers.get('x-tula-client')).toBe('web')
    expect(sent.headers.get('x-forwarded-for')).toBe('203.0.113.9')
    expect(sent.headers.get('user-agent')).toBe('UA/1')
    expect(sent.headers.get('cookie')).toBe(`__Secure-tula_rt_${ENV}=r1; tula_rt_${ENV}=r1`)
    expect(sent.redirect).toBe('manual')

    // The rest of the request reads the new cookies, and the app's own cookies are kept.
    const cookie = overridden(response).get('cookie') as string
    expect(cookie).toContain('theme=dark')
    expect(cookie).toContain(`tula_at=${fresh}`)
    expect(cookie).toContain('tula_rt=r2')
    expect((await authAfter(api, response)).userId).toBe('user_1')
  })

  test('a refused refresh clears the cookies and the request is signed out', async () => {
    const api = createFakeApi([signer])
    api.on('POST /v1/client/sessions/refresh', () =>
      Response.json({ status: 401, code: 'session.revoked', detail: 'x' }, { status: 401 })
    )
    const response = await protect(api)(get('/dashboard', { cookie: 'tula_rt=r1; tula_at=stale' }))
    expect(response.status).toBe(307)
    expect(response.headers.getSetCookie().sort()).toEqual([
      'tula_at=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
      'tula_rt=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    ])
  })

  test('a refused refresh on a public page clears the cookies and hides them from the page', async () => {
    const api = createFakeApi([signer])
    api.on('POST /v1/client/sessions/refresh', () =>
      Response.json({ status: 401, code: 'session.expired', detail: 'x' }, { status: 401 })
    )
    const response = await protect(api)(get('/', { cookie: 'theme=dark; tula_rt=r1' }))
    expect(isNext(response)).toBe(true)
    expect(overridden(response).get('cookie')).toBe('theme=dark')
    expect((await authAfter(api, response)).isSignedIn).toBe(false)
  })

  test.each([
    [401, 'session.revoked'],
    [401, 'session.expired'],
    [401, 'session.invalid_token'],
    [401, 'session.reuse_detected'],
    [403, 'auth.user_banned'],
  ])('a refresh answered %i %s ends the session: the cookies go', async (status, code) => {
    const api = createFakeApi([signer])
    api.on('POST /v1/client/sessions/refresh', () =>
      Response.json({ status, code, detail: 'x' }, { status })
    )
    const response = await protect(api)(get('/dashboard', { cookie: 'tula_rt=r1; tula_at=stale' }))
    expect(response.status).toBe(307)
    expect(response.headers.getSetCookie().sort()).toEqual([
      'tula_at=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
      'tula_rt=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    ])
  })

  // None of these says the session is over: the API did not get as far as looking at it. A
  // wrong app URL or key must not sign every visitor out for good.
  test.each([
    [
      'the cookie was not honoured (the origin is not allowed)',
      401,
      'auth.unauthenticated',
      /allowed origins/,
    ],
    ['the publishable key is wrong', 401, 'auth.invalid_key', /publishable key/],
    ['the origin is refused outright', 403, 'request.origin_not_allowed', /allowed origins/],
    ['a 401 has no body', 401, null, /401/],
    ['a 403 names a code this version does not know', 403, 'something.new', /something\.new/],
    ['a code is not a code', 401, 'x'.repeat(200), /401/],
  ])(
    'a refresh refused because %s keeps the cookies, and says what is likely wrong',
    async (_name, status, code, hint) => {
      const warnings: string[] = []
      const api = createFakeApi([signer], { onWarning: (message) => warnings.push(message) })
      api.on('POST /v1/client/sessions/refresh', () =>
        code === null
          ? new Response(null, { status })
          : Response.json({ status, code, detail: 'x' }, { status })
      )
      const middleware = protect(api)
      const response = await middleware(
        get('/dashboard', { cookie: 'theme=dark; tula_rt=refresh-secret; tula_at=stale' })
      )
      // This request is signed out…
      expect(response.status).toBe(307)
      // …and nothing is taken from the browser.
      expect(response.headers.getSetCookie()).toEqual([])
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toMatch(hint)
      expect(warnings[0]).not.toContain('refresh-secret')
      expect(warnings[0]).not.toContain(KEY)
      expect(warnings[0]?.length).toBeLessThan(600)

      // Said once, not on every request.
      await middleware(get('/dashboard', { cookie: 'tula_rt=refresh-secret' }))
      expect(warnings).toHaveLength(1)
    }
  )

  test('on a public page such a refusal leaves the page its cookies', async () => {
    const api = createFakeApi([signer], { onWarning: () => undefined })
    api.on('POST /v1/client/sessions/refresh', () =>
      Response.json({ status: 401, code: 'auth.unauthenticated', detail: 'x' }, { status: 401 })
    )
    const response = await protect(api)(get('/', { cookie: 'theme=dark; tula_rt=r1' }))
    expect(isNext(response)).toBe(true)
    expect(response.headers.getSetCookie()).toEqual([])
    expect(overridden(response).get('cookie')).toBe('theme=dark; tula_rt=r1')
    expect((await authAfter(api, response)).isSignedIn).toBe(false)
  })

  test('a refresh cookie that could never be sent is dropped without asking the API', async () => {
    const api = createFakeApi([signer])
    const response = await protect(api)(get('/dashboard', { cookie: 'tula_rt="quoted value"' }))
    expect(response.status).toBe(307)
    expect(api.count('/v1/client/sessions/refresh')).toBe(0)
    expect(response.headers.getSetCookie()).toEqual([
      'tula_rt=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    ])
  })

  test.each([
    [
      'is down',
      () => {
        throw new Error('ECONNREFUSED')
      },
    ],
    ['is rate limiting', () => new Response(null, { status: 429 })],
    ['fails', () => new Response(null, { status: 500 })],
    ['answers nonsense', () => new Response('<html>', { status: 200 })],
    ['answers without a token', () => Response.json({ sessionId: 's1' })],
  ])(
    'an API that %s leaves the cookies alone and the request signed out',
    async (_name, respond) => {
      const api = createFakeApi([signer])
      api.on('POST /v1/client/sessions/refresh', respond as () => Response)
      const response = await protect(api)(get('/dashboard', { cookie: 'tula_rt=r1' }))
      expect(response.status).toBe(307)
      expect(response.headers.getSetCookie()).toEqual([])
    }
  )

  test('a token with seconds left is still used when the refresh could not be made', async () => {
    const api = createFakeApi([signer])
    api.on('POST /v1/client/sessions/refresh', () => new Response(null, { status: 503 }))
    const soon = Math.floor(Date.now() / 1000) + 4
    const response = await protect(api)(
      get('/dashboard', { cookie: `tula_at=${await signer.sign({ exp: soon })}; tula_rt=r1` })
    )
    expect(isNext(response)).toBe(true)
    expect(response.headers.getSetCookie()).toEqual([])
  })

  test('a refreshed token that does not verify is not installed', async () => {
    const api = createFakeApi([signer])
    refreshing(api, await stranger.sign())
    const response = await protect(api)(get('/dashboard', { cookie: 'tula_rt=r1' }))
    expect(response.status).toBe(307)
    expect(response.headers.getSetCookie().join('\n')).not.toContain('tula_at=ey')
  })

  test('requests arriving together with one refresh token share one refresh', async () => {
    const api = createFakeApi([signer])
    const fresh = await signer.sign()
    api.on('POST /v1/client/sessions/refresh', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return Response.json({ sessionId: 'sess_1', accessToken: fresh })
    })
    const middleware = protect(api)
    const responses = await Promise.all(
      [1, 2, 3].map(() => middleware(get('/dashboard', { cookie: 'tula_rt=shared' })))
    )
    expect(responses.every(isNext)).toBe(true)
    expect(api.count('/v1/client/sessions/refresh')).toBe(1)
  })

  test('no refresh cookie, no refresh', async () => {
    const api = createFakeApi([signer])
    const response = await protect(api)(get('/dashboard'))
    expect(response.status).toBe(307)
    expect(api.requests).toHaveLength(0)
  })
})

describe('which routes are protected', () => {
  test('a public route is served signed out, and nothing is asked of the API', async () => {
    const api = createFakeApi([signer])
    const response = await protect(api)(get('/'))
    expect(isNext(response)).toBe(true)
    expect(api.requests).toHaveLength(0)
  })

  test('the sign-in page is never protected: no redirect loop', async () => {
    const api = createFakeApi([signer])
    const middleware = tulaMiddleware({ ...api.options, publicRoutes: [] })
    expect(isNext(await middleware(get('/sign-in?redirect_url=%2Fdashboard')))).toBe(true)
    expect((await middleware(get('/other'))).status).toBe(307)
  })

  test('with protectedRoutes only those are protected', async () => {
    const api = createFakeApi([signer])
    const middleware = tulaMiddleware({
      ...api.options,
      protectedRoutes: ['/dashboard(.*)', /^\/account$/, (path: string) => path === '/fn'],
    })
    expect((await middleware(get('/dashboard'))).status).toBe(307)
    expect((await middleware(get('/dashboard/settings'))).status).toBe(307)
    expect((await middleware(get('/account'))).status).toBe(307)
    expect((await middleware(get('/fn'))).status).toBe(307)
    expect(isNext(await middleware(get('/dashboardx/../pricing')))).toBe(true)
    expect(isNext(await middleware(get('/accounts')))).toBe(true)
  })

  test('with neither list nothing is protected, but sessions are still refreshed', async () => {
    const api = createFakeApi([signer])
    const fresh = await signer.sign()
    api.on('POST /v1/client/sessions/refresh', () =>
      Response.json({ sessionId: 's', accessToken: fresh })
    )
    const response = await tulaMiddleware(api.options)(get('/anything', { cookie: 'tula_rt=r1' }))
    expect(isNext(response)).toBe(true)
    expect(response.headers.getSetCookie().some((line) => line.startsWith('tula_at='))).toBe(true)
  })

  test('a protected API route answers 401 in the contract’s envelope instead of redirecting', async () => {
    const api = createFakeApi([signer])
    const response = await protect(api)(get('/api/whoami'))
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ status: 401, code: 'auth.unauthenticated' })
    expect(response.headers.has('location')).toBe(false)
  })

  test('a protected POST answers 401: a redirect would replay the body at the sign-in page', async () => {
    const api = createFakeApi([signer])
    const response = await protect(api)(
      new NextRequest(`${APP}/dashboard`, { method: 'POST', body: 'x' })
    )
    expect(response.status).toBe(401)
  })

  test('the route handler’s own path is left alone', async () => {
    const api = createFakeApi([signer])
    const response = await protect(api)(
      get('/api/tula/v1/client/sessions/refresh', { cookie: 'tula_rt=r1' })
    )
    expect(isNext(response)).toBe(true)
    expect(api.requests).toHaveLength(0)
  })

  test('the redirect names only a path on this origin', async () => {
    const api = createFakeApi([signer])
    const response = await protect(api)(get('//evil.example/%2F..?a=//b'))
    const location = new URL(response.headers.get('location') as string)
    expect(location.origin).toBe(APP)
    const target = location.searchParams.get('redirect_url') as string
    expect(target.startsWith('/')).toBe(true)
    expect(target.startsWith('//')).toBe(false)
  })

  test('a sign-in URL on another origin is refused when the middleware is created', () => {
    expect(() => tulaMiddleware({ signInUrl: 'https://evil.example/sign-in' })).toThrow(TypeError)
    expect(() => tulaMiddleware({ signInUrl: '//evil.example' })).toThrow(TypeError)
  })
})

describe('stateful sessions', () => {
  const claims = () => ({
    iss: `${API}/v1/environments/${ENV}`,
    sub: 'user_7',
    aud: ENV,
    sid: 'sess_7',
    exp: Math.floor(Date.now() / 1000) + 60,
    iat: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
  })

  test('with a secret key the session cookie is verified by the API and the claims travel signed', async () => {
    const api = createFakeApi([signer], { secretKey: SECRET })
    api.on('POST /v1/admin/sessions/verify', () => Response.json(claims()))
    const response = await protect(api)(get('/dashboard', { cookie: 'tula_session=sess-token' }))
    expect(isNext(response)).toBe(true)
    const sent = api.requests[0] as Request
    expect(sent.headers.get('authorization')).toBe(`Bearer ${SECRET}`)
    expect(await sent.json()).toEqual({ token: 'sess-token' })

    const auth = await authAfter(api, response)
    expect(auth.userId).toBe('user_7')
    expect(await auth.getToken()).toBeNull()
    // The helper relied on the middleware's answer: the API was asked once.
    expect(api.count('/v1/admin/sessions/verify')).toBe(1)
  })

  test('without the middleware the helper asks the API itself', async () => {
    const api = createFakeApi([signer], { secretKey: SECRET })
    api.on('POST /v1/admin/sessions/verify', () => Response.json(claims()))
    const auth = await authenticate(
      new Request(`${APP}/x`, { headers: { cookie: 'tula_session=sess-token' } }),
      api.options
    )
    expect(auth.sessionId).toBe('sess_7')
    expect(api.count('/v1/admin/sessions/verify')).toBe(1)
  })

  test('a session the API does not know is signed out and its cookie cleared', async () => {
    const api = createFakeApi([signer], { secretKey: SECRET })
    api.on('POST /v1/admin/sessions/verify', () => new Response(null, { status: 401 }))
    const response = await protect(api)(get('/dashboard', { cookie: 'tula_session=old' }))
    expect(response.status).toBe(307)
    expect(response.headers.getSetCookie()).toEqual([
      'tula_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    ])
  })

  test('claims for another environment are not accepted', async () => {
    const api = createFakeApi([signer], { secretKey: SECRET })
    api.on('POST /v1/admin/sessions/verify', () => Response.json({ ...claims(), aud: 'env_2' }))
    const response = await protect(api)(get('/dashboard', { cookie: 'tula_session=t' }))
    expect(response.status).toBe(307)
  })

  test('without a secret key a stateful session is signed out on the server, and the API is not asked', async () => {
    const api = createFakeApi([signer])
    const response = await protect(api)(get('/dashboard', { cookie: 'tula_session=sess-token' }))
    expect(response.status).toBe(307)
    expect(api.requests).toHaveLength(0)
    // Its cookie is kept: the browser's client still uses it through the route handler.
    expect(response.headers.getSetCookie()).toEqual([])
  })
})

describe('a forged header from the browser', () => {
  test('the middleware removes it before the request goes on', async () => {
    const api = createFakeApi([signer], { secretKey: SECRET })
    const forged = btoa(
      JSON.stringify({ claims: { sub: 'admin', sid: 's', aud: ENV, exp: 9999999999 } })
    )
    const response = await protect(api)(get('/', { 'x-tula-auth': `${forged}.AAAA` }))
    expect(isNext(response)).toBe(true)
    expect(overridden(response).has('x-tula-auth')).toBe(false)
    expect(response.headers.get('x-middleware-override-headers')).not.toContain('x-tula-auth')
  })

  test('it is removed from a request to the route handler’s path too', async () => {
    const api = createFakeApi([signer], { secretKey: SECRET })
    const response = await protect(api)(
      get('/api/tula/v1/client/me', {
        cookie: 'tula_session=sess-token',
        'x-tula-auth': 'forged.AAAA',
        'x-other': '1',
      })
    )
    expect(isNext(response)).toBe(true)
    // The handler does its own checks: nothing is asked of the API here.
    expect(api.requests).toHaveLength(0)
    const names = (response.headers.get('x-middleware-override-headers') ?? '').split(',')
    expect(names).toContain('x-other')
    expect(names).toContain('cookie')
    expect(names).not.toContain('x-tula-auth')
    expect(response.headers.has('x-middleware-request-x-tula-auth')).toBe(false)
    expect(overridden(response).get('cookie')).toBe('tula_session=sess-token')
  })

  test('a route the middleware does not cover ignores it: the signature is checked, not the presence', async () => {
    const api = createFakeApi([signer], { secretKey: SECRET })
    api.on('POST /v1/admin/sessions/verify', () => new Response(null, { status: 401 }))
    const body = btoa(
      JSON.stringify({
        claims: {
          iss: `${API}/v1/environments/${ENV}`,
          sub: 'admin',
          sid: 's',
          aud: ENV,
          exp: 9999999999,
        },
      })
    )
    for (const header of [`${body}.AAAA`, body, `${body}.`, 'x.y.z', '']) {
      const auth = await authenticate(
        new Request(`${APP}/x`, { headers: { 'x-tula-auth': header, cookie: 'tula_session=t' } }),
        api.options
      )
      expect(auth.isSignedIn).toBe(false)
    }
  })

  test('claims forged for the visitor’s own cookie fail on the signature alone', async () => {
    const api = createFakeApi([signer], { secretKey: SECRET })
    api.on('POST /v1/admin/sessions/verify', () => new Response(null, { status: 401 }))
    const encode = (bytes: Uint8Array) =>
      btoa(String.fromCharCode(...bytes))
        .replace(/=+$/, '')
        .replaceAll('+', '-')
        .replaceAll('/', '_')
    // Everything an attacker can compute: the digest of a cookie they hold, and any claims.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('mine'))
    const body = encode(
      new TextEncoder().encode(
        JSON.stringify({
          claims: {
            iss: `${API}/v1/environments/${ENV}`,
            sub: 'admin',
            aud: ENV,
            sid: 's',
            exp: 9999999999,
          },
          cookie: encode(new Uint8Array(digest)),
        })
      )
    )
    const wrongKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('tula-nextjs-auth-v1:tula_sk_dev_guess'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )
    const signature = await crypto.subtle.sign('HMAC', wrongKey, new TextEncoder().encode(body))
    for (const header of [`${body}.${encode(new Uint8Array(signature))}`, `${body}.AAAA`]) {
      const auth = await authenticate(
        new Request(`${APP}/x`, {
          headers: { 'x-tula-auth': header, cookie: 'tula_session=mine' },
        }),
        api.options
      )
      expect(auth.isSignedIn).toBe(false)
    }
  })

  test('claims sealed for one session cookie are not accepted with another', async () => {
    const api = createFakeApi([signer], { secretKey: SECRET })
    let known = true
    api.on('POST /v1/admin/sessions/verify', () =>
      known
        ? Response.json({
            iss: `${API}/v1/environments/${ENV}`,
            sub: 'user_7',
            aud: ENV,
            sid: 'sess_7',
            exp: Math.floor(Date.now() / 1000) + 60,
          })
        : new Response(null, { status: 401 })
    )
    const response = await protect(api)(get('/dashboard', { cookie: 'tula_session=mine' }))
    const sealed = overridden(response).get('x-tula-auth') as string
    expect(sealed).toBeTruthy()
    known = false
    const auth = await authenticate(
      new Request(`${APP}/x`, {
        headers: { 'x-tula-auth': sealed, cookie: 'tula_session=theirs' },
      }),
      api.options
    )
    expect(auth.isSignedIn).toBe(false)
  })

  test('with no secret key the header means nothing', async () => {
    const api = createFakeApi([signer])
    const auth = await authenticate(
      new Request(`${APP}/x`, { headers: { 'x-tula-auth': 'a.b', cookie: 'tula_session=t' } }),
      api.options
    )
    expect(auth.isSignedIn).toBe(false)
  })
})
