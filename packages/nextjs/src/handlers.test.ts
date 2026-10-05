import { describe, expect, test } from 'bun:test'
import { createTulaHandlers } from './handlers'

const API = 'http://api.internal:3003'
const APP = 'http://localhost:3000'
const ENV = 'env_1'
const KEY = 'tula_pk_dev_0000'

interface Upstream {
  requests: Request[]
  bodies: string[]
}

function setup(
  respond: (request: Request) => Response | Promise<Response> = () => Response.json({ ok: true }),
  options: Record<string, unknown> = {}
) {
  const upstream: Upstream = { requests: [], bodies: [] }
  const handlers = createTulaHandlers({
    apiUrl: API,
    publishableKey: KEY,
    environmentId: ENV,
    fetch: async (request) => {
      upstream.requests.push(request)
      upstream.bodies.push(await request.clone().text())
      return respond(request)
    },
    ...options,
  })
  return { handlers, upstream }
}

function post(path: string, init: { headers?: Record<string, string>; body?: unknown } = {}) {
  return new Request(`${APP}/api/tula${path}`, {
    method: 'POST',
    headers: { origin: APP, 'content-type': 'application/json', ...init.headers },
    body: JSON.stringify(init.body ?? {}),
  })
}

function cookiesOf(response: Response): string[] {
  return response.headers.getSetCookie()
}

describe('forwarding', () => {
  test('a client call goes to the same path on the API with the app’s key', async () => {
    const { handlers, upstream } = setup()
    const response = await handlers.POST(
      post('/v1/client/sign-ins?x=1', {
        headers: {
          'x-tula-client': 'web',
          'x-tula-attempt': 'secret',
          'x-tula-session-profile': 'back-office',
          'x-tula-publishable-key': 'tula_pk_dev_other',
          'sec-fetch-site': 'same-origin',
          authorization: 'Bearer token',
          'user-agent': 'UA/1',
        },
        body: { identifier: 'a@example.com' },
      })
    )
    expect(response.status).toBe(200)
    const sent = upstream.requests[0] as Request
    expect(sent.url).toBe(`${API}/v1/client/sign-ins?x=1`)
    expect(sent.method).toBe('POST')
    expect(sent.headers.get('origin')).toBe(APP)
    expect(sent.headers.get('sec-fetch-site')).toBe('same-origin')
    expect(sent.headers.get('x-tula-client')).toBe('web')
    expect(sent.headers.get('x-tula-attempt')).toBe('secret')
    expect(sent.headers.get('x-tula-session-profile')).toBe('back-office')
    expect(sent.headers.get('authorization')).toBe('Bearer token')
    expect(sent.headers.get('user-agent')).toBe('UA/1')
    // The key is the app's, whatever the browser sent.
    expect(sent.headers.get('x-tula-publishable-key')).toBe(KEY)
    expect(upstream.bodies[0]).toBe('{"identifier":"a@example.com"}')
  })

  test('no Origin is invented for a request that has none', async () => {
    const { handlers, upstream } = setup()
    await handlers.GET(new Request(`${APP}/api/tula/v1/client/config`))
    expect((upstream.requests[0] as Request).headers.has('origin')).toBe(false)
  })

  test('headers outside the allow-list and the browser’s other cookies are not forwarded', async () => {
    const { handlers, upstream } = setup()
    await handlers.GET(
      new Request(`${APP}/api/tula/v1/client/config`, {
        headers: {
          cookie: 'app_session=private; tula_rt=refresh1',
          'x-internal': '1',
          connection: 'keep-alive',
          'x-forwarded-host': 'evil.example',
          host: 'localhost:3000',
        },
      })
    )
    const sent = upstream.requests[0] as Request
    expect(sent.headers.has('x-internal')).toBe(false)
    expect(sent.headers.has('x-forwarded-host')).toBe(false)
    expect(sent.headers.get('cookie')).toBe(
      `__Secure-tula_rt_${ENV}=refresh1; tula_rt_${ENV}=refresh1`
    )
  })

  async function forwardedFor(header: string | null, options: Record<string, unknown> = {}) {
    const { handlers, upstream } = setup(undefined, options)
    await handlers.GET(
      new Request(`${APP}/api/tula/v1/client/config`, {
        headers: header === null ? {} : { 'x-forwarded-for': header },
      })
    )
    return (upstream.requests[0] as Request).headers.get('x-forwarded-for')
  }

  test('by default no forwarding header is trusted: the visitor cannot choose the address the API sees', async () => {
    expect(await forwardedFor('1.2.3.4')).toBeNull()
    expect(await forwardedFor('6.6.6.6, 203.0.113.9')).toBeNull()
    expect(await forwardedFor('1.2.3.4', { trustedProxyHops: 0 })).toBeNull()
  })

  test.each([
    [1, '203.0.113.9', '203.0.113.9'],
    [1, '6.6.6.6, 203.0.113.9', '203.0.113.9'],
    [1, '6.6.6.6,7.7.7.7 ,  203.0.113.9', '203.0.113.9'],
    [2, '198.51.100.7, 10.0.0.1', '198.51.100.7'],
    // Whatever the visitor wrote comes first; the trusted proxies appended after it.
    [2, '6.6.6.6, 7.7.7.7, 198.51.100.7, 10.0.0.1', '198.51.100.7'],
    [1, '2001:db8::1', '2001:db8::1'],
  ])('with %i trusted hop(s), "%s" is forwarded as %s alone', async (hops, header, expected) => {
    expect(await forwardedFor(header, { trustedProxyHops: hops })).toBe(expected)
  })

  test.each([
    ['no header', 1, null],
    ['fewer entries than trusted hops', 2, '203.0.113.9'],
    ['an entry that is not an address', 1, 'not an address'],
    ['an entry with a port and a path', 1, '6.6.6.6, 203.0.113.9:80/x'],
    ['an empty last entry', 1, '203.0.113.9, '],
    ['an entry that could split a header', 1, '6.6.6.6, 203.0.113.9\tx'],
  ])('%s: no address is forwarded', async (_name, hops, header) => {
    expect(await forwardedFor(header, { trustedProxyHops: hops })).toBeNull()
  })

  test('a custom clientIp decides, whatever the hops say', async () => {
    const clientIp = (request: Request) => request.headers.get('cf-connecting-ip')
    const { handlers, upstream } = setup(undefined, { clientIp })
    await handlers.GET(
      new Request(`${APP}/api/tula/v1/client/config`, {
        headers: { 'x-forwarded-for': '6.6.6.6', 'cf-connecting-ip': '203.0.113.9' },
      })
    )
    expect((upstream.requests[0] as Request).headers.get('x-forwarded-for')).toBe('203.0.113.9')
  })

  test.each([[-1], [1.5], [Number.NaN], ['2']])('trustedProxyHops %p is refused', async (hops) => {
    const { handlers } = setup(undefined, { trustedProxyHops: hops })
    await expect(handlers.GET(new Request(`${APP}/api/tula/v1/client/config`))).rejects.toThrow(
      TypeError
    )
  })

  test('the API’s CORS and hop-by-hop headers do not reach the browser', async () => {
    const { handlers } = setup(
      () =>
        new Response('{"ok":true}', {
          headers: {
            'content-type': 'application/json',
            'access-control-allow-origin': APP,
            'access-control-allow-credentials': 'true',
            'retry-after': '7',
            'x-tula-can-still-sign-in': 'true',
            'x-powered-by': 'x',
          },
        })
    )
    const response = await handlers.GET(new Request(`${APP}/api/tula/v1/client/config`))
    expect(response.headers.has('access-control-allow-origin')).toBe(false)
    expect(response.headers.has('x-powered-by')).toBe(false)
    expect(response.headers.get('retry-after')).toBe('7')
    expect(response.headers.get('x-tula-can-still-sign-in')).toBe('true')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ ok: true })
  })

  test('an error from the API passes through with its status and body', async () => {
    const body = { status: 401, code: 'auth.invalid_credentials', detail: 'no' }
    const { handlers } = setup(() => Response.json(body, { status: 401 }))
    const response = await handlers.POST(post('/v1/client/sign-ins/a/password'))
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual(body)
  })

  test('a body that is not JSON is passed on untouched', async () => {
    const { handlers } = setup(() => new Response(null, { status: 204 }))
    const response = await handlers.POST(post('/v1/client/me/password'))
    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
  })
})

describe('what is never forwarded', () => {
  test.each([
    '/v1/admin/users',
    '/v1/status',
    '/v1/client',
    '/v1/clientx/config',
    '/v1/client/../admin/users',
    '/v1/client/%2e%2e/admin/users',
    '/v1/client/..%2fadmin/users',
    '/v1/client/a%5c..%5cadmin',
    '/v1/client//admin',
    '/v2/client/config',
    '/',
  ])('%s is not a client route', async (path) => {
    const { handlers, upstream } = setup()
    const response = await handlers.GET(new Request(`${APP}/api/tula${path}`))
    expect(response.status).toBe(404)
    expect(((await response.json()) as { code: string }).code).toBe('resource.not_found')
    expect(upstream.requests).toHaveLength(0)
  })

  test('a redirect from the API is not followed and not passed on', async () => {
    const { handlers, upstream } = setup(
      () => new Response(null, { status: 302, headers: { location: 'http://evil.example/' } })
    )
    const response = await handlers.GET(new Request(`${APP}/api/tula/v1/client/config`))
    expect(response.status).toBe(502)
    expect(response.headers.has('location')).toBe(false)
    expect((upstream.requests[0] as Request).redirect).toBe('manual')
  })

  test('an API that does not answer is a 503 in the contract’s envelope', async () => {
    const { handlers } = setup(() => {
      throw new Error('connect ECONNREFUSED secret-host')
    })
    const response = await handlers.GET(new Request(`${APP}/api/tula/v1/client/config`))
    expect(response.status).toBe(503)
    const body = (await response.json()) as { code: string; detail: string }
    expect(body.code).toBe('service.unavailable')
    expect(JSON.stringify(body)).not.toContain('secret-host')
  })

  test('a declared body over the limit is refused before the API is called', async () => {
    const { handlers, upstream } = setup()
    const response = await handlers.POST(
      post('/v1/client/sign-ins', { headers: { 'content-length': String(2 * 1024 * 1024) } })
    )
    expect(response.status).toBe(413)
    expect(upstream.requests).toHaveLength(0)
  })
})

describe('size limits', () => {
  const chunk = new Uint8Array(256 * 1024).fill(0x61)

  function streamed(chunks: number): Request {
    let sent = 0
    return new Request(`${APP}/api/tula/v1/client/sign-ins`, {
      method: 'POST',
      headers: { origin: APP, 'content-type': 'application/json' },
      // No Content-Length: a chunked upload.
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent === chunks) {
            controller.close()
            return
          }
          sent += 1
          controller.enqueue(chunk)
        },
      }),
      duplex: 'half',
    } as RequestInit)
  }

  test('a streamed body with no declared length is cut off at the limit and answered 413', async () => {
    let received = 0
    const handlers = createTulaHandlers({
      apiUrl: API,
      publishableKey: KEY,
      environmentId: ENV,
      fetch: async (request) => {
        const reader = (request.body as ReadableStream<Uint8Array>).getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) {
            break
          }
          received += value.byteLength
        }
        return Response.json({ ok: true })
      },
    })
    // 3 MiB against a limit of 1 MiB.
    const response = await handlers.POST(streamed(12))
    expect(response.status).toBe(413)
    expect(((await response.json()) as { code: string }).code).toBe('request.too_large')
    // The API was never handed more than the limit.
    expect(received).toBeLessThanOrEqual(1024 * 1024)
  })

  test('an answer the API gave to a body that was cut off is not passed on', async () => {
    const handlers = createTulaHandlers({
      apiUrl: API,
      publishableKey: KEY,
      environmentId: ENV,
      // An API that answers whatever became of the body.
      fetch: async (request) => {
        await request.text().catch(() => '')
        return Response.json(
          { sessionId: 's1', accessToken: 'aaa.bbb.ccc' },
          { headers: { 'set-cookie': `tula_rt_${ENV}=refresh1; Max-Age=600` } }
        )
      },
    })
    const response = await handlers.POST(streamed(12))
    expect(response.status).toBe(413)
    expect(cookiesOf(response)).toEqual([])
  })

  test('a streamed body under the limit goes through whole', async () => {
    const { handlers, upstream } = setup()
    const response = await handlers.POST(streamed(2))
    expect(response.status).toBe(200)
    expect(upstream.bodies[0]).toHaveLength(2 * chunk.byteLength)
  })

  test('a JSON answer larger than the limit is not buffered: 502, and nothing of it is used', async () => {
    let pulled = 0
    const { handlers } = setup(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              // 16 MiB against a limit of 1 MiB.
              if (pulled === 64) {
                controller.close()
                return
              }
              pulled += 1
              controller.enqueue(chunk)
            },
          }),
          {
            headers: {
              'content-type': 'application/json',
              'set-cookie': `tula_rt_${ENV}=refresh1; Max-Age=600`,
            },
          }
        )
    )
    const response = await handlers.POST(post('/v1/client/sign-ins'))
    expect(response.status).toBe(502)
    expect(((await response.json()) as { code: string }).code).toBe('service.unavailable')
    expect(cookiesOf(response)).toEqual([])
    expect(pulled).toBeLessThan(16)
  })
})

describe('requests from another site', () => {
  test.each([
    ['another origin', { origin: 'https://evil.example' }],
    ['the same host on another port', { origin: 'http://localhost:9999' }],
    ['a sibling subdomain', { origin: 'http://evil.localhost:3000' }],
    ['an opaque origin', { origin: 'null' }],
    ['no Origin at all', {}],
    ['a cross-site fetch', { origin: APP, 'sec-fetch-site': 'cross-site' }],
  ])('a POST from %s is refused before the API is called', async (_name, headers) => {
    const { handlers, upstream } = setup()
    const response = await handlers.POST(
      new Request(`${APP}/api/tula/v1/client/sessions/sign-out`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'tula_rt=r1', ...headers },
        body: '{}',
      })
    )
    expect(response.status).toBe(403)
    expect(((await response.json()) as { code: string }).code).toBe('request.origin_not_allowed')
    expect(upstream.requests).toHaveLength(0)
    expect(cookiesOf(response)).toEqual([])
  })

  test('a GET with a foreign Origin is refused too', async () => {
    const { handlers, upstream } = setup()
    const response = await handlers.GET(
      new Request(`${APP}/api/tula/v1/client/me`, { headers: { origin: 'https://evil.example' } })
    )
    expect(response.status).toBe(403)
    expect(upstream.requests).toHaveLength(0)
  })

  test('the app’s origin is the Host the browser addressed, not a header a page can pick', async () => {
    const { handlers, upstream } = setup()
    const response = await handlers.POST(
      new Request('http://127.0.0.1:3000/api/tula/v1/client/sign-ins', {
        method: 'POST',
        headers: {
          origin: 'https://app.example.com',
          host: 'app.example.com',
          'x-forwarded-proto': 'https',
          'content-type': 'application/json',
        },
        body: '{}',
      })
    )
    expect(response.status).toBe(200)
    expect((upstream.requests[0] as Request).headers.get('origin')).toBe('https://app.example.com')
  })

  test('a configured appUrl is the only origin accepted', async () => {
    const { handlers, upstream } = setup(undefined, { appUrl: 'https://app.example.com' })
    const refused = await handlers.POST(post('/v1/client/sign-ins'))
    expect(refused.status).toBe(403)
    const accepted = await handlers.POST(
      post('/v1/client/sign-ins', { headers: { origin: 'https://app.example.com' } })
    )
    expect(accepted.status).toBe(200)
    expect(upstream.requests).toHaveLength(1)
  })
})

describe('cookies', () => {
  const expiresAt = () => new Date(Date.now() + 60_000).toISOString()

  test('a completed sign-in sets the refresh cookie and an access-token cookie on the app', async () => {
    const { handlers } = setup(() =>
      Response.json(
        {
          id: 'a1',
          step: { status: 'complete' },
          session: {
            sessionId: 's1',
            accessToken: 'aaa.bbb.ccc',
            accessTokenExpiresAt: expiresAt(),
          },
        },
        {
          headers: {
            'set-cookie': `tula_rt_${ENV}=refresh1; Max-Age=604800; Path=/v1/client/sessions; Domain=api.internal; HttpOnly; SameSite=Lax`,
          },
        }
      )
    )
    const response = await handlers.POST(post('/v1/client/sign-ins/a1/password'))
    const cookies = cookiesOf(response)
    expect(cookies).toContain('tula_rt=refresh1; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800')
    const access = cookies.find((line) => line.startsWith('tula_at=')) as string
    expect(access).toMatch(
      /^tula_at=aaa\.bbb\.ccc; Path=\/; HttpOnly; SameSite=Lax; Max-Age=(59|60)$/
    )
    expect(cookies.join('\n')).not.toContain('Domain')
    // The browser still gets the body: `@tula/core` keeps the access token in memory.
    expect(
      ((await response.json()) as { session: { accessToken: string } }).session.accessToken
    ).toBe('aaa.bbb.ccc')
  })

  test('over https the cookies are Secure and carry the __Host- prefix', async () => {
    const { handlers } = setup(
      () =>
        Response.json(
          { sessionId: 's1', accessToken: 'aaa.bbb.ccc', accessTokenExpiresAt: expiresAt() },
          { headers: { 'set-cookie': `__Secure-tula_rt_${ENV}=refresh2; Max-Age=600; Secure` } }
        ),
      { appUrl: 'https://app.example.com' }
    )
    const response = await handlers.POST(
      post('/v1/client/sessions/refresh', {
        headers: {
          origin: 'https://app.example.com',
          cookie: '__Host-tula_rt=refresh1; tula_rt=planted',
        },
      })
    )
    const cookies = cookiesOf(response)
    expect(cookies).toContain(
      '__Host-tula_rt=refresh2; Path=/; HttpOnly; SameSite=Lax; Max-Age=600; Secure'
    )
    expect(cookies.some((line) => line.startsWith('__Host-tula_at=aaa.bbb.ccc; '))).toBe(true)
  })

  test('over https an unprefixed cookie is never read: a sibling subdomain could have set it', async () => {
    const { handlers, upstream } = setup(undefined, { appUrl: 'https://app.example.com' })
    await handlers.POST(
      post('/v1/client/sessions/refresh', {
        headers: { origin: 'https://app.example.com', cookie: 'tula_rt=planted' },
      })
    )
    expect((upstream.requests[0] as Request).headers.has('cookie')).toBe(false)
  })

  test('a stateful session’s cookie is re-scoped and sent back under the API’s name', async () => {
    const { handlers, upstream } = setup(() =>
      Response.json(
        { id: 'a1', step: { status: 'complete' }, session: { sessionId: 's1' } },
        { headers: { 'set-cookie': `tula_session_${ENV}=sess1; Max-Age=3600; Path=/; HttpOnly` } }
      )
    )
    const response = await handlers.POST(post('/v1/client/sign-ins/a1/password'))
    expect(cookiesOf(response)).toContain(
      'tula_session=sess1; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600'
    )
    await handlers.GET(
      new Request(`${APP}/api/tula/v1/client/me`, { headers: { cookie: 'tula_session=sess1' } })
    )
    expect((upstream.requests[1] as Request).headers.get('cookie')).toBe(
      `__Host-tula_session_${ENV}=sess1; tula_session_${ENV}=sess1`
    )
  })

  test('a sign-in on a stateful profile removes the access and refresh cookies of an older session', async () => {
    // The browser was user A on a hybrid profile; user B now signs in on a stateful one. Left
    // in place, A's token cookies would keep answering for the server side.
    const { handlers } = setup(() =>
      Response.json(
        { id: 'a1', step: { status: 'complete' }, session: { sessionId: 'sB' } },
        { headers: { 'set-cookie': `tula_session_${ENV}=sessB; Max-Age=3600; Path=/; HttpOnly` } }
      )
    )
    const response = await handlers.POST(
      post('/v1/client/sign-ins/a1/password', {
        headers: { cookie: 'tula_rt=refreshA; tula_at=aaa.bbb.ccc' },
      })
    )
    expect(cookiesOf(response).sort()).toEqual([
      'tula_at=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
      'tula_rt=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
      'tula_session=sessB; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600',
    ])
  })

  test('a sign-in that issues a refresh cookie removes the session cookie of an older stateful session', async () => {
    const { handlers } = setup(() =>
      Response.json(
        {
          id: 'a1',
          step: { status: 'complete' },
          session: {
            sessionId: 'sB',
            accessToken: 'aaa.bbb.ccc',
            accessTokenExpiresAt: expiresAt(),
          },
        },
        {
          headers: {
            'set-cookie': `tula_rt_${ENV}=refreshB; Max-Age=600; Path=/v1/client/sessions`,
          },
        }
      )
    )
    const response = await handlers.POST(
      post('/v1/client/sign-ins/a1/password', { headers: { cookie: 'tula_session=sessA' } })
    )
    const cookies = cookiesOf(response)
    expect(cookies).toContain('tula_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0')
    expect(cookies).toContain('tula_rt=refreshB; Path=/; HttpOnly; SameSite=Lax; Max-Age=600')
    expect(cookies.some((line) => line.startsWith('tula_at=aaa.bbb.ccc; '))).toBe(true)
    expect(cookies).toHaveLength(3)
  })

  test('an answer that carries an access token alone removes an older session cookie too', async () => {
    const { handlers } = setup(() =>
      Response.json({
        sessionId: 'sB',
        accessToken: 'aaa.bbb.ccc',
        accessTokenExpiresAt: expiresAt(),
      })
    )
    const response = await handlers.POST(
      post('/v1/client/sessions/refresh', { headers: { cookie: 'tula_session=sessA' } })
    )
    const cookies = cookiesOf(response)
    expect(cookies).toContain('tula_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0')
    expect(cookies).toHaveLength(2)
  })

  test('sign-out clears the refresh, session and access-token cookies', async () => {
    const { handlers } = setup(
      () =>
        new Response(null, {
          status: 204,
          headers: { 'set-cookie': `tula_rt_${ENV}=; Max-Age=0; Path=/v1/client/sessions` },
        })
    )
    const response = await handlers.POST(
      post('/v1/client/sessions/sign-out', { headers: { cookie: 'tula_rt=r1; tula_at=a.b.c' } })
    )
    expect(response.status).toBe(204)
    expect(cookiesOf(response).sort()).toEqual([
      'tula_at=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
      'tula_rt=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
      'tula_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    ])
  })

  test.each([
    [
      'answers 503',
      () => Response.json({ status: 503, code: 'service.unavailable' }, { status: 503 }),
    ],
    ['answers 429', () => Response.json({ status: 429, code: 'rate_limited' }, { status: 429 })],
    ['cannot be reached', () => Promise.reject(new TypeError('connection refused'))],
  ])(
    'a sign-out the API %s leaves every cookie: the session may still be alive',
    async (_name, respond) => {
      const { handlers } = setup(respond)
      const response = await handlers.POST(
        post('/v1/client/sessions/sign-out', {
          headers: { cookie: 'tula_rt=r1; tula_at=a.b.c; tula_session=s1' },
        })
      )
      // The browser's client throws on this answer, and the components then say that the
      // session may still be active instead of going to the after-sign-out page.
      expect(response.ok).toBe(false)
      expect(cookiesOf(response)).toEqual([])
    }
  )

  test('a refused refresh that drops the API’s cookie drops the access token too', async () => {
    const { handlers } = setup(() =>
      Response.json(
        { status: 401, code: 'session.revoked', detail: 'ended' },
        {
          status: 401,
          headers: {
            'set-cookie': `tula_rt_${ENV}=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/v1/client/sessions`,
          },
        }
      )
    )
    const response = await handlers.POST(
      post('/v1/client/sessions/refresh', { headers: { cookie: 'tula_rt=r1' } })
    )
    expect(response.status).toBe(401)
    expect(cookiesOf(response).sort()).toEqual([
      'tula_at=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
      'tula_rt=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    ])
  })

  test('cookies of other names and other environments from the API are dropped', async () => {
    const { handlers } = setup(() => {
      const headers = new Headers({ 'content-type': 'application/json' })
      headers.append('set-cookie', 'tracking=1; Path=/')
      headers.append('set-cookie', 'tula_rt_other=zzz; Max-Age=600')
      return new Response('{}', { headers })
    })
    const response = await handlers.POST(post('/v1/client/sessions/refresh'))
    expect(cookiesOf(response)).toEqual([])
  })

  test('a cookie value that could carry an attribute is not written', async () => {
    const { handlers } = setup(() =>
      Response.json({ sessionId: 's1', accessToken: 'a b"c', accessTokenExpiresAt: expiresAt() })
    )
    const response = await handlers.POST(post('/v1/client/sessions/refresh'))
    expect(cookiesOf(response)).toEqual([])
  })

  test('an error response never sets an access-token cookie, whatever its body says', async () => {
    const { handlers } = setup(() =>
      Response.json({ sessionId: 's1', accessToken: 'aaa.bbb.ccc' }, { status: 400 })
    )
    const response = await handlers.POST(post('/v1/client/sessions/refresh'))
    expect(cookiesOf(response)).toEqual([])
  })
})

describe('configuration', () => {
  test('a secret key in place of the publishable key is refused', async () => {
    const handlers = createTulaHandlers({
      apiUrl: API,
      publishableKey: 'tula_sk_dev_x',
      environmentId: ENV,
    })
    await expect(
      handlers.GET(new Request(`${APP}/api/tula/v1/client/config`))
    ).rejects.toBeInstanceOf(TypeError)
  })

  test('a handler mounted elsewhere strips its own path', async () => {
    const { handlers, upstream } = setup(undefined, { path: '/auth/' })
    await handlers.GET(new Request(`${APP}/auth/v1/client/config`))
    expect((upstream.requests[0] as Request).url).toBe(`${API}/v1/client/config`)
    const outside = await handlers.GET(new Request(`${APP}/api/tula/v1/client/config`))
    expect(outside.status).toBe(404)
  })
})
