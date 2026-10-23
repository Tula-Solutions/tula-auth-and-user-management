import { beforeAll, describe, expect, test } from 'bun:test'
import { NextRequest } from 'next/server'
import { authenticate } from './helpers'
import { tulaMiddleware } from './middleware'
import { AUTH_HEADER, openClaims, sealClaims } from './session'
import {
  API,
  APP,
  createFakeApi,
  createSigner,
  ENV,
  type FakeApi,
  SECRET,
  type Signer,
} from './testing/keys'

// The active organization (ADR 0065): `auth()` hands out `orgId`, `orgRole`, `orgPermissions`
// and `has()` only from claims that are all three well formed. Each table runs for the
// middleware followed by `auth()` and for `auth()` alone, for both session types.

let signer: Signer

beforeAll(async () => {
  signer = await createSigner('key-1')
})

const ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
const ORG = {
  org_id: ID,
  org_role: 'billing_manager',
  org_perms: ['org:billing:read', 'org:billing:write'],
}

function get(path: string, init: { headers?: Record<string, string>; method?: string } = {}) {
  return new NextRequest(`${APP}${path}`, init)
}

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

const protect = (api: FakeApi, extra: Record<string, unknown> = {}) =>
  tulaMiddleware({ ...api.options, publicRoutes: ['/'], ...extra })

async function auth(api: FakeApi, cookie: string, through: 'middleware' | 'alone') {
  if (through === 'alone') {
    return authenticate(new Request(`${APP}/x`, { headers: { cookie } }), api.options)
  }
  const response = await protect(api)(get('/dashboard', { headers: { cookie } }))
  return authenticate(new Request(`${APP}/x`, { headers: overridden(response) }), api.options)
}

const statefulClaims = (extra: Record<string, unknown> = {}) => ({
  iss: `${API}/v1/environments/${ENV}`,
  sub: 'user_7',
  aud: ENV,
  sid: 'sess_7',
  exp: Math.floor(Date.now() / 1000) + 60,
  iat: Math.floor(Date.now() / 1000),
  amr: ['pwd'],
  ...extra,
})

function stateful(extra: Record<string, unknown>): FakeApi {
  const api = createFakeApi([signer], { secretKey: SECRET })
  api.on('POST /v1/admin/sessions/verify', () => Response.json(statefulClaims(extra)))
  return api
}

/** Organization claims no Tula server issues. Each must mean no organization, whole. */
const MALFORMED: [string, Record<string, unknown>][] = [
  ['only the id', { org_id: ID }],
  ['only the role', { org_role: 'admin' }],
  ['only the permissions', { org_perms: ['org:billing:read'] }],
  ['no permissions', { org_id: ID, org_role: 'admin' }],
  ['permissions that are a string', { ...ORG, org_perms: 'org:billing:read' }],
  ['a permission that is not a string', { ...ORG, org_perms: ['org:billing:read', 7] }],
  ['a permission with a dot', { ...ORG, org_perms: ['billing.read'] }],
  ['a wildcard permission', { ...ORG, org_perms: ['org:billing:*'] }],
  ['one malformed among good ones', { ...ORG, org_perms: ['org:billing:read', 'Admin'] }],
  ['33 permissions', { ...ORG, org_perms: Array.from({ length: 33 }, (_, i) => `org:a:b${i}`) }],
  ['a role outside its grammar', { ...ORG, org_role: 'Billing Manager' }],
  ['an id that is not URL-safe', { ...ORG, org_id: 'org 1' }],
  ['an empty id', { ...ORG, org_id: '' }],
  [
    'claims over the byte cap',
    {
      ...ORG,
      org_perms: ['org:a:b'.padEnd(100, 'x')].concat(
        Array.from({ length: 31 }, () => `org:${'f'.repeat(32)}:${'a'.repeat(32)}`)
      ),
      org_id: 'o'.repeat(64),
    },
  ],
]

function expectNoOrganization(result: Awaited<ReturnType<typeof auth>>) {
  expect(result.isSignedIn).toBe(true)
  expect(result.orgId).toBeNull()
  expect(result.orgRole).toBeNull()
  expect(result.orgPermissions).toEqual([])
  expect(result.has({ permission: 'org:billing:read' })).toBe(false)
  expect(result.has({ role: 'admin' })).toBe(false)
  for (const claim of ['org_id', 'org_role', 'org_perms']) {
    expect(result.claims && claim in result.claims).toBe(false)
  }
}

describe.each(['middleware', 'alone'] as const)(
  'organization claims of a token (%s)',
  (through) => {
    test('are returned, frozen, with has() checking them exactly', async () => {
      const api = createFakeApi([signer])
      const result = await auth(api, `tula_at=${await signer.sign(ORG)}`, through)
      expect(result.isSignedIn).toBe(true)
      expect(result.orgId).toBe(ID)
      expect(result.orgRole).toBe('billing_manager')
      expect(result.orgPermissions).toEqual(['org:billing:read', 'org:billing:write'])
      expect(Object.isFrozen(result.orgPermissions)).toBe(true)
      expect(result.claims?.org_id).toBe(ID)
      expect(result.has({ permission: 'org:billing:read' })).toBe(true)
      expect(result.has({ role: 'billing_manager' })).toBe(true)
      // Exact: no wildcard, no prefix, no implication, no other role.
      for (const permission of ['org:billing:*', 'org:billing', 'org:billing:delete', '*', '']) {
        expect(result.has({ permission })).toBe(false)
      }
      expect(result.has({ role: 'admin' })).toBe(false)
      expect(result.has({} as never)).toBe(false)
      expect(result.has({ permission: 'org:billing:read', role: 'billing_manager' } as never)).toBe(
        false
      )
    })

    test('a session with no organization has nothing, and has() is false', async () => {
      const api = createFakeApi([signer])
      expectNoOrganization(await auth(api, `tula_at=${await signer.sign()}`, through))
    })

    test.each(MALFORMED)(
      '%s is no organization: the session stands, all three are absent',
      async (_name, claims) => {
        const api = createFakeApi([signer])
        const result = await auth(api, `tula_at=${await signer.sign(claims)}`, through)
        expect(result.userId).toBe('user_1')
        expectNoOrganization(result)
      }
    )

    test('a forged token gives no organization at all', async () => {
      const api = createFakeApi([signer])
      const stranger = await createSigner('key-1')
      const result = await auth(api, `tula_at=${await stranger.sign(ORG)}`, through)
      expect(result.isSignedIn).toBe(false)
      expect(result.orgId).toBeNull()
      expect(result.has({ role: 'billing_manager' })).toBe(false)
    })
  }
)

describe.each(['middleware', 'alone'] as const)(
  'organization claims of a stateful session (%s)',
  (through) => {
    test('are what the API answered', async () => {
      const result = await auth(stateful(ORG), 'tula_session=sess-token', through)
      expect(result.orgId).toBe(ID)
      expect(result.has({ permission: 'org:billing:write' })).toBe(true)
    })

    test.each(MALFORMED)('an answer with %s: no organization', async (_name, claims) => {
      expectNoOrganization(await auth(stateful(claims), 'tula_session=sess-token', through))
    })
  }
)

describe('organization claims in the sealed header', () => {
  const config = { issuer: `${API}/v1/environments/${ENV}`, environmentId: ENV }

  test('round-trip, the largest accepted role and custom claims included', async () => {
    const perms = Array.from(
      { length: 32 },
      (_, i) =>
        `org:${'f'.repeat(30)}${String(i).padStart(2, '0')}:${'a'.repeat(30)}${String(i).padStart(2, '0')}`
    )
    const claims = statefulClaims({
      org_id: ID,
      org_role: 'r'.repeat(32),
      org_perms: perms,
      ext: { a: 'x'.repeat(256), b: 'y'.repeat(256), c: 'z'.repeat(256), d: 'w'.repeat(220) },
    })
    const sealed = await sealClaims(SECRET, claims as never, 'sess-token')
    const opened = await openClaims(SECRET, sealed, 'sess-token', config)
    expect(opened?.org_perms).toEqual(perms)
    expect(opened?.org_role).toBe('r'.repeat(32))
    expect(Object.keys(opened?.ext ?? {})).toEqual(['a', 'b', 'c', 'd'])
  })

  test('a forged header cannot add an organization', async () => {
    const api = stateful({})
    const forged = btoa(JSON.stringify({ claims: statefulClaims(ORG) }))
    const result = await authenticate(
      new Request(`${APP}/x`, {
        headers: { cookie: 'tula_session=sess-token', [AUTH_HEADER]: `${forged}.AAAA` },
      }),
      api.options
    )
    expect(result.isSignedIn).toBe(true)
    expectNoOrganization(result)
  })

  test('claims sealed by this app with a wildcard permission open without an organization', async () => {
    const api = stateful({})
    const sealed = await sealClaims(
      SECRET,
      statefulClaims({ ...ORG, org_perms: ['org:*:*'] }) as never,
      'sess-token'
    )
    const result = await authenticate(
      new Request(`${APP}/x`, {
        headers: { cookie: 'tula_session=sess-token', [AUTH_HEADER]: sealed },
      }),
      api.options
    )
    expect(result.isSignedIn).toBe(true)
    expectNoOrganization(result)
  })
})

describe('signed out', () => {
  test('no organization and nothing granted', async () => {
    const api = createFakeApi([signer])
    const result = await authenticate(new Request(`${APP}/x`), api.options)
    expect(result.isSignedIn).toBe(false)
    expect(result.orgId).toBeNull()
    expect(result.orgPermissions).toEqual([])
    expect(result.has({ permission: 'org:billing:read' })).toBe(false)
  })
})

describe('permission matchers of the middleware', () => {
  const rules = {
    access: [
      { routes: '/billing(.*)', permission: 'org:billing:read' },
      { routes: '/admin(.*)', role: 'admin' },
    ],
  }
  const run = async (
    path: string,
    claims: Record<string, unknown> | null,
    extra = {},
    init = {}
  ) => {
    const api = createFakeApi([signer])
    const cookie = claims === null ? '' : `tula_at=${await signer.sign(claims)}`
    return protect(api, { ...rules, ...extra })(
      get(path, { headers: cookie ? { cookie } : {}, ...init })
    )
  }

  test('a member who holds the permission is let through', async () => {
    const response = await run('/billing/invoices', ORG)
    expect(response.headers.get('x-middleware-next')).toBe('1')
  })

  test('a member without it gets a 403 page, JSON for an API route and for a POST', async () => {
    const other = { ...ORG, org_perms: ['org:docs:read'] }
    const page = await run('/billing', other)
    expect(page.status).toBe(403)
    expect(page.headers.get('cache-control')).toBe('no-store')
    const api = await run('/api/x', other, {
      access: [{ routes: '/api(.*)', permission: 'org:billing:read' }],
    })
    expect(api.status).toBe(403)
    expect(((await api.json()) as { code: string }).code).toBe('auth.forbidden')
    const post = await run('/billing', other, {}, { method: 'POST' })
    expect(post.status).toBe(403)
  })

  test.each([
    '/%62illing',
    '/billing%2Finvoices',
    '//billing',
    '/billing/',
    '/%62illing/%69nvoices',
    '/a/../billing',
  ])('a rule covers %s, however the path is spelled', async (path) => {
    // The member lacks the permission: every spelling that reaches /billing must be refused.
    const response = await run(path, { ...ORG, org_perms: [] })
    expect(response.headers.get('x-middleware-next')).not.toBe('1')
  })

  test('no active organization is refused, not let through', async () => {
    const response = await run('/billing', {})
    expect(response.status).toBe(403)
  })

  test('a permission is exact: a wildcard held in a token grants nothing', async () => {
    const response = await run('/billing', { ...ORG, org_perms: ['org:billing:*'] })
    expect(response.status).toBe(403)
  })

  test('a signed-out visitor is sent to sign in, not refused', async () => {
    const response = await run('/billing', null)
    expect(response.status).toBe(307)
    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/sign-in')
  })

  test('a rule protects a route the public list would leave open', async () => {
    const response = await run('/billing', null, { publicRoutes: ['/billing(.*)'] })
    expect(response.status).toBe(307)
  })

  test('forbiddenUrl redirects a page, and is never itself ruled', async () => {
    const other = { ...ORG, org_perms: [] }
    const response = await run('/billing', other, { forbiddenUrl: '/no-access' })
    expect(response.status).toBe(307)
    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/no-access')
    const there = await run('/no-access', other, {
      forbiddenUrl: '/no-access',
      access: [{ routes: '(.*)', permission: 'org:billing:read' }],
    })
    expect(there.headers.get('x-middleware-next')).toBe('1')
  })

  test('the role rule, and every matching rule must grant', async () => {
    expect(
      (await run('/admin', { ...ORG, org_role: 'admin' })).headers.get('x-middleware-next')
    ).toBe('1')
    expect((await run('/admin', ORG)).status).toBe(403)
    const both = {
      access: [
        { routes: '/x', permission: 'org:billing:read' },
        { routes: '/x', permission: 'org:billing:delete' },
      ],
    }
    expect((await run('/x', ORG, both)).status).toBe(403)
  })

  test('the sign-in page is never ruled', async () => {
    const response = await run('/sign-in', ORG, { access: [{ routes: '(.*)', role: 'admin' }] })
    expect(response.headers.get('x-middleware-next')).toBe('1')
  })

  test('a stateful session is judged on the API’s claims', async () => {
    const response = await protect(
      stateful(ORG),
      rules
    )(get('/billing', { headers: { cookie: 'tula_session=sess-token' } }))
    expect(response.headers.get('x-middleware-next')).toBe('1')
    const denied = await protect(
      stateful({}),
      rules
    )(get('/billing', { headers: { cookie: 'tula_session=sess-token' } }))
    expect(denied.status).toBe(403)
  })

  test.each([
    ['a wildcard permission', { routes: '/x', permission: 'org:billing:*' }],
    ['a permission without the prefix', { routes: '/x', permission: 'billing:read' }],
    ['both', { routes: '/x', permission: 'org:a:b', role: 'admin' }],
    ['neither', { routes: '/x' }],
    ['a role in upper case', { routes: '/x', role: 'Admin' }],
    ['no routes', { permission: 'org:a:b' }],
  ])('%s is refused when the middleware is created', (_name, rule) => {
    expect(() => tulaMiddleware({ access: [rule as never] })).toThrow(TypeError)
  })
})
