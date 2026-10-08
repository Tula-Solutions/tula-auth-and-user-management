import { beforeAll, describe, expect, test } from 'bun:test'
import { NextRequest } from 'next/server'
import { authenticate } from './helpers'
import { tulaMiddleware } from './middleware'
import { AUTH_HEADER, sealClaims } from './session'
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

// Custom claims (ADR 0036): `auth()` hands an application the namespace claim only in the
// shape a Tula server issues. Every test here runs for the middleware followed by `auth()`
// and for `auth()` alone, and for both session types.

let signer: Signer

beforeAll(async () => {
  signer = await createSigner('key-1')
})

function get(path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`${APP}${path}`, { headers })
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

const protect = (api: FakeApi) => tulaMiddleware({ ...api.options, publicRoutes: ['/'] })

/** `auth()` for a request with these cookies, behind the middleware or without it. */
async function auth(api: FakeApi, cookie: string, through: 'middleware' | 'alone') {
  if (through === 'alone') {
    return authenticate(new Request(`${APP}/x`, { headers: { cookie } }), api.options)
  }
  const response = await protect(api)(get('/dashboard', { cookie }))
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

/** Namespace claims no Tula server issues. Each must be absent, never passed through. */
const MALFORMED: [string, unknown][] = [
  ['a string', 'admin'],
  ['a number', 7],
  ['null', null],
  ['an array', ['admin']],
  ['an empty object', {}],
  ['a nested object', { role: { name: 'admin' } }],
  ['a list value', { roles: ['admin'] }],
  ['a null value', { role: null }],
  ['a reserved key', { sub: 'someone-else' }],
  ['a key outside the grammar', { 'my-role': 'admin' }],
  ['a `__proto__` key', JSON.parse('{"__proto__":{"isAdmin":true}}')],
  ['a `constructor` key', JSON.parse('{"constructor":"x"}')],
  ['a claim over the size cap', { role: 'x'.repeat(2000) }],
]

describe.each(['middleware', 'alone'] as const)(
  'custom claims of a token session (%s)',
  (through) => {
    test('are returned as a frozen record, and in `claims` under the namespace claim', async () => {
      const api = createFakeApi([signer])
      const token = await signer.sign({ ext: { role: 'admin', seats: 3, beta: false } })
      const result = await auth(api, `tula_at=${token}`, through)
      expect(result.isSignedIn).toBe(true)
      expect(result.customClaims).toEqual({ role: 'admin', seats: 3, beta: false })
      expect(Object.isFrozen(result.customClaims)).toBe(true)
      expect(result.claims?.ext).toEqual({ role: 'admin', seats: 3, beta: false })
      expect(Object.isFrozen(result.claims?.ext)).toBe(true)
    })

    test('a token without the namespace claim has an empty record and no `ext`', async () => {
      const api = createFakeApi([signer])
      const result = await auth(api, `tula_at=${await signer.sign()}`, through)
      expect(result.isSignedIn).toBe(true)
      expect(result.customClaims).toEqual({})
      expect(Object.isFrozen(result.customClaims)).toBe(true)
      expect(result.claims && 'ext' in result.claims).toBe(false)
    })

    test.each(MALFORMED)(
      'a namespace claim that is %s is absent: the session stands, the claim does not',
      async (_label, ext) => {
        const api = createFakeApi([signer])
        const result = await auth(api, `tula_at=${await signer.sign({ ext })}`, through)
        // The token is the server's and verifies: the user is signed in.
        expect(result.isSignedIn).toBe(true)
        expect(result.userId).toBe('user_1')
        expect(result.customClaims).toEqual({})
        expect(result.claims && 'ext' in result.claims).toBe(false)
        expect(({} as Record<string, unknown>).isAdmin).toBeUndefined()
      }
    )

    test('a token that does not verify gives no custom claims at all', async () => {
      const api = createFakeApi([signer])
      const stranger = await createSigner('key-1')
      const forged = await stranger.sign({ ext: { role: 'admin' } })
      const result = await auth(api, `tula_at=${forged}`, through)
      expect(result.isSignedIn).toBe(false)
      expect(result.customClaims).toBeNull()
    })
  }
)

describe.each(['middleware', 'alone'] as const)(
  'custom claims of a stateful session (%s)',
  (through) => {
    test('are what the API answered, as a frozen record', async () => {
      const api = stateful({ ext: { role: 'admin', seats: 3 } })
      const result = await auth(api, 'tula_session=sess-token', through)
      expect(result.isSignedIn).toBe(true)
      expect(result.customClaims).toEqual({ role: 'admin', seats: 3 })
      expect(Object.isFrozen(result.customClaims)).toBe(true)
      expect(result.claims?.ext).toEqual({ role: 'admin', seats: 3 })
    })

    test('none in the answer is an empty record', async () => {
      const result = await auth(stateful({}), 'tula_session=sess-token', through)
      expect(result.isSignedIn).toBe(true)
      expect(result.customClaims).toEqual({})
    })

    test.each(MALFORMED)('an answer whose namespace claim is %s: absent', async (_label, ext) => {
      const result = await auth(stateful({ ext }), 'tula_session=sess-token', through)
      expect(result.isSignedIn).toBe(true)
      expect(result.customClaims).toEqual({})
      expect(result.claims && 'ext' in result.claims).toBe(false)
    })
  }
)

describe('custom claims in the sealed header', () => {
  test('a forged header cannot add a custom claim', async () => {
    const api = stateful({})
    const forged = btoa(JSON.stringify({ claims: statefulClaims({ ext: { role: 'admin' } }) }))
    const result = await authenticate(
      new Request(`${APP}/x`, {
        headers: { cookie: 'tula_session=sess-token', [AUTH_HEADER]: `${forged}.AAAA` },
      }),
      api.options
    )
    // The API's own answer is used instead: it has no custom claim.
    expect(result.isSignedIn).toBe(true)
    expect(result.customClaims).toEqual({})
  })

  test('claims sealed by this app with a malformed namespace claim open without it', async () => {
    const api = stateful({})
    const sealed = await sealClaims(
      SECRET,
      statefulClaims({ ext: ['admin'] }) as never,
      'sess-token'
    )
    const result = await authenticate(
      new Request(`${APP}/x`, {
        headers: { cookie: 'tula_session=sess-token', [AUTH_HEADER]: sealed },
      }),
      api.options
    )
    expect(result.isSignedIn).toBe(true)
    expect(result.customClaims).toEqual({})
    expect(result.claims && 'ext' in result.claims).toBe(false)
  })
})

describe('signed out', () => {
  test('there are no custom claims', async () => {
    const api = createFakeApi([signer])
    const result = await authenticate(new Request(`${APP}/x`), api.options)
    expect(result.isSignedIn).toBe(false)
    expect(result.customClaims).toBeNull()
  })
})
