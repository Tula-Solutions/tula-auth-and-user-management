import { beforeAll, describe, expect, test } from 'bun:test'
import { NextRequest } from 'next/server'
import {
  ACCESS_CHUNK_LENGTH,
  accessCookieChanges,
  isAccessToken,
  MAX_ACCESS_TOKEN_LENGTH,
  readAccessToken,
} from './cookies'
import { createTulaHandlers } from './handlers'
import { authenticate } from './helpers'
import { tulaMiddleware } from './middleware'
import { APP, createFakeApi, createSigner, type Signer } from './testing/keys'

// The access token is the biggest cookie the app keeps. A browser drops a cookie whose name
// and value pass about 4,096 bytes, silently, so a token past that (a maximal organization
// role, ADR 0065, with the largest custom claims) is spread over two cookies.

let signer: Signer
beforeAll(async () => {
  signer = await createSigner('key-1')
})

/** The role the roles API accepts at most, and the largest custom claims a template allows. */
const MAXIMAL = {
  org_id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  org_role: 'r'.repeat(32),
  org_perms: Array.from(
    { length: 32 },
    (_, i) =>
      `org:${'f'.repeat(30)}${String(i).padStart(2, '0')}:${'a'.repeat(30)}${String(i).padStart(2, '0')}`
  ),
  ext: { a: 'x'.repeat(256), b: 'y'.repeat(256), c: 'z'.repeat(256), d: 'w'.repeat(220) },
}

describe('the pieces of an access token', () => {
  test('a short token is one cookie and clears a stale second part', () => {
    expect(accessCookieChanges('tula_at', 'abc', ['tula_at', 'tula_at_1'])).toEqual(
      new Map([
        ['tula_at', 'abc'],
        ['tula_at_1', null],
      ])
    )
    // Nothing is cleared that the request did not carry.
    expect(accessCookieChanges('tula_at', 'abc', ['tula_at'])).toEqual(
      new Map([['tula_at', 'abc']])
    )
  })

  test('a long token is two cookies, each within the chunk length', () => {
    const token = 'a'.repeat(5300)
    const changes = accessCookieChanges('__Host-tula_at', token, [])
    expect([...changes.keys()]).toEqual(['__Host-tula_at', '__Host-tula_at_1'])
    for (const [name, value] of changes) {
      expect(name.length + (value?.length ?? 0)).toBeLessThanOrEqual(4096 - 900)
    }
    expect([...changes.values()].join('')).toBe(token)
  })

  test('a token that does not fit, or is not a cookie value, is not kept and the old one goes', () => {
    for (const token of ['a'.repeat(MAX_ACCESS_TOKEN_LENGTH + 1), 'a b"c', '']) {
      expect(isAccessToken(token)).toBe(false)
      expect(accessCookieChanges('tula_at', token, ['tula_at', 'tula_at_1'])).toEqual(
        new Map([
          ['tula_at', null],
          ['tula_at_1', null],
        ])
      )
    }
    expect(MAX_ACCESS_TOKEN_LENGTH).toBe(2 * ACCESS_CHUNK_LENGTH)
  })

  test('the parts are joined in order, stopping at the first one missing', () => {
    const jar = (entries: [string, string][]) => new Map(entries)
    expect(
      readAccessToken(
        jar([
          ['t', 'aa'],
          ['t_1', 'bb'],
        ]),
        't'
      )
    ).toBe('aabb')
    expect(readAccessToken(jar([['t_1', 'bb']]), 't')).toBeUndefined()
    expect(
      readAccessToken(
        jar([
          ['t', 'aa'],
          ['t_2', 'cc'],
        ]),
        't'
      )
    ).toBe('aa')
    expect(readAccessToken(jar([['t', '']]), 't')).toBeUndefined()
  })
})

describe('a maximal session through the route handler', () => {
  async function issue(extra: Record<string, unknown> = {}) {
    const token = await signer.sign({ ...MAXIMAL, ...extra })
    const api = createFakeApi([signer])
    const handlers = createTulaHandlers({
      ...api.options,
      fetch: async (request) => {
        if (new URL(request.url).pathname === '/v1/client/sessions/refresh') {
          return Response.json({ sessionId: 'sess_1', accessToken: token })
        }
        return api.options.fetch?.(request) ?? new Response(null, { status: 404 })
      },
    })
    return { token, api, handlers }
  }
  const refresh = (cookie = '') =>
    new Request(`${APP}/api/tula/v1/client/sessions/refresh`, {
      method: 'POST',
      headers: { origin: APP, 'content-type': 'application/json', ...(cookie && { cookie }) },
      body: '{}',
    })

  test('the token is more than a cookie holds, and is written as two that each fit', async () => {
    const { token, handlers } = await issue()
    // The need: whole, `tula_at=` plus this passes the 4,096 a browser keeps.
    expect('tula_at='.length + token.length).toBeGreaterThan(4096)
    const lines = (await handlers.POST(refresh())).headers.getSetCookie()
    const written = lines.filter((line) => line.startsWith('tula_at'))
    expect(written.map((line) => line.split('=')[0])).toEqual(['tula_at', 'tula_at_1'])
    for (const line of written) {
      const [pair = ''] = line.split(';')
      expect(pair.length).toBeLessThanOrEqual(4096)
      expect(line).toContain('HttpOnly')
      expect(line).toContain('SameSite=Lax')
      expect(line).toContain('Path=/')
    }
  })

  test('the session works end to end: the middleware and auth() read the two cookies', async () => {
    const { token, api, handlers } = await issue()
    const jar = new Map<string, string>()
    for (const line of (await handlers.POST(refresh())).headers.getSetCookie()) {
      const [pair = ''] = line.split(';')
      const at = pair.indexOf('=')
      jar.set(pair.slice(0, at), pair.slice(at + 1))
    }
    expect([...jar.values()].join('')).toBe(token)
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
    const response = await tulaMiddleware({
      ...api.options,
      publicRoutes: ['/'],
      access: [{ routes: '/billing(.*)', permission: MAXIMAL.org_perms[31] as string }],
    })(new NextRequest(`${APP}/billing`, { headers: { cookie } }))
    expect(response.headers.get('x-middleware-next')).toBe('1')
    expect(response.headers.getSetCookie()).toEqual([])
    const headers = new Headers()
    for (const name of (response.headers.get('x-middleware-override-headers') ?? '').split(',')) {
      const value = response.headers.get(`x-middleware-request-${name}`)
      if (name && value !== null) {
        headers.set(name, value)
      }
    }
    const auth = await authenticate(new Request(`${APP}/x`, { headers }), api.options)
    expect(auth.orgPermissions).toHaveLength(32)
    expect(auth.orgRole).toBe('r'.repeat(32))
    expect(auth.customClaims).toMatchObject({ a: 'x'.repeat(256) })
    expect(auth.has({ permission: MAXIMAL.org_perms[0] as string })).toBe(true)
  })

  test('a shorter token replaces a longer one and removes its second part', async () => {
    const { handlers } = await issue({ org_perms: [], ext: undefined })
    const lines = (
      await handlers.POST(refresh('tula_at=old; tula_at_1=oldtail'))
    ).headers.getSetCookie()
    const byName = new Map(lines.map((line) => [line.split('=')[0], line]))
    expect(byName.get('tula_at')).not.toContain('Max-Age=0')
    expect(byName.get('tula_at_1')).toContain('Max-Age=0')
  })

  test('signing out removes both parts', async () => {
    const api = createFakeApi([signer])
    const handlers = createTulaHandlers({
      ...api.options,
      fetch: async () => new Response(null, { status: 204 }),
    })
    const response = await handlers.POST(
      new Request(`${APP}/api/tula/v1/client/sessions/sign-out`, {
        method: 'POST',
        headers: {
          origin: APP,
          'content-type': 'application/json',
          cookie: 'tula_at=a; tula_at_1=b; tula_rt=c',
        },
        body: '{}',
      })
    )
    const cleared = response.headers
      .getSetCookie()
      .filter((line) => line.includes('Max-Age=0'))
      .map((line) => line.split('=')[0])
    expect(cleared.sort()).toEqual(['tula_at', 'tula_at_1', 'tula_rt', 'tula_session'])
  })
})

describe('a split token that cannot be trusted', () => {
  test('a stale tail makes the token fail verification, never be believed', async () => {
    const token = await signer.sign(MAXIMAL)
    const api = createFakeApi([signer])
    const head = token.slice(0, ACCESS_CHUNK_LENGTH)
    const auth = await authenticate(
      new Request(`${APP}/x`, { headers: { cookie: `tula_at=${head}; tula_at_1=zzzz` } }),
      api.options
    )
    expect(auth.isSignedIn).toBe(false)
  })

  test('the middleware refreshes through a token it cannot join and rewrites both parts', async () => {
    const fresh = await signer.sign(MAXIMAL)
    const api = createFakeApi([signer])
    api.on('POST /v1/client/sessions/refresh', () =>
      Response.json({ sessionId: 'sess_1', accessToken: fresh })
    )
    const response = await tulaMiddleware({ ...api.options, publicRoutes: ['/'] })(
      new NextRequest(`${APP}/dashboard`, {
        headers: { cookie: 'tula_at=garbage; tula_at_1=tail; tula_rt=r1' },
      })
    )
    const names = response.headers.getSetCookie().map((line) => line.split('=')[0])
    expect(names).toContain('tula_at')
    expect(names).toContain('tula_at_1')
  })
})

describe('a token longer than two cookies can hold', () => {
  // Not reachable within the documented limits; this holds what happens when it is anyway: the
  // session is not signed out, the token is not stored, and no earlier token outlives it.
  const huge = () => signer.sign({ ...MAXIMAL, pad: 'p'.repeat(MAX_ACCESS_TOKEN_LENGTH) })

  test('the middleware answers the request with it, stores none of it and clears the old parts', async () => {
    const token = await huge()
    expect(token.length).toBeGreaterThan(MAX_ACCESS_TOKEN_LENGTH)
    const api = createFakeApi([signer])
    api.on('POST /v1/client/sessions/refresh', () =>
      Response.json({ sessionId: 'sess_1', accessToken: token })
    )
    const warnings: string[] = []
    const response = await tulaMiddleware({
      ...api.options,
      onWarning: (message) => warnings.push(message),
      publicRoutes: [],
    })(
      new NextRequest(`${APP}/dashboard`, {
        headers: { cookie: 'tula_at=stale; tula_at_1=stale; tula_rt=r1' },
      })
    )
    expect(response.headers.get('x-middleware-next')).toBe('1')
    const lines = response.headers.getSetCookie()
    const cleared = lines.filter((line) => line.includes('Max-Age=0')).map((l) => l.split('=')[0])
    expect(cleared.sort()).toEqual(['tula_at', 'tula_at_1'])
    expect(warnings).toHaveLength(1)
  })

  test('the route handler stores none of it and removes the earlier token', async () => {
    const token = await huge()
    const api = createFakeApi([signer])
    const warnings: string[] = []
    const handlers = createTulaHandlers({
      ...api.options,
      onWarning: (message) => warnings.push(message),
      fetch: async (request) =>
        new URL(request.url).pathname === '/v1/client/sessions/refresh'
          ? Response.json({ sessionId: 'sess_1', accessToken: token })
          : (api.options.fetch?.(request) ?? new Response(null, { status: 404 })),
    })
    const response = await handlers.POST(
      new Request(`${APP}/api/tula/v1/client/sessions/refresh`, {
        method: 'POST',
        headers: {
          origin: APP,
          'content-type': 'application/json',
          cookie: 'tula_at=stale; tula_at_1=stale',
        },
        body: '{}',
      })
    )
    const lines = response.headers.getSetCookie().filter((line) => line.startsWith('tula_at'))
    expect(lines.every((line) => line.includes('Max-Age=0'))).toBe(true)
    expect(lines.map((line) => line.split('=')[0]).sort()).toEqual(['tula_at', 'tula_at_1'])
    expect(warnings).toHaveLength(1)
  })
})
