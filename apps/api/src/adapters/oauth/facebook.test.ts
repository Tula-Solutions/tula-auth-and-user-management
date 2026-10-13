import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import * as logger from '~/lib/logger'
import { type OAuthFailure, OAuthProviderError } from '~/ports/oauth-provider'
import {
  appSecretProof,
  createFacebookProvider,
  FACEBOOK_GRAPH_VERSION,
  FACEBOOK_MAX_PROFILE_BYTES,
  FACEBOOK_SCOPES,
  isFacebookUserId,
} from './facebook'

const REDIRECT_URI = 'https://auth.northline.app/v1/oauth/callback/facebook'
const CLIENT_ID = '1234567890123456'
const SECRET = 'facebook-app-secret'
const ACCESS_TOKEN = 'facebook-access-token-canary'
/** Where `arctic`'s client exchanges the code: the version in it is the library's. */
const TOKEN_URL = 'https://graph.facebook.com/v16.0/oauth/access_token'
const PROOF = createHmac('sha256', SECRET).update(ACCESS_TOKEN).digest('hex')
const USER_URL = `https://graph.facebook.com/v25.0/me?fields=id%2Cname&appsecret_proof=${PROOF}`
const credentials = { clientId: CLIENT_ID, clientSecret: SECRET }
const exchangeInput = {
  code: 'the-code',
  codeVerifier: 'the-verifier',
  nonce: 'nonce-of-this-attempt',
  redirectUri: REDIRECT_URI,
}
const USER = { id: '10158712345678901', name: 'Nelly Okafor' }

type Answer = () => Response | Promise<Response>
interface Call {
  url: string
  body: string
  headers: Headers
  signal: AbortSignal | undefined
}

const spies: ReturnType<typeof spyOn>[] = []
afterEach(() => {
  for (const spy of spies.splice(0)) {
    spy.mockRestore()
  }
})

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/**
 * Stand in for Facebook: its token endpoint and the Graph API's current user, by exact
 * address (the query included). A request to any other address fails the test.
 */
function facebook(overrides: Record<string, Answer> = {}): Call[] {
  const calls: Call[] = []
  const routes: Record<string, Answer> = {
    [TOKEN_URL]: () =>
      jsonResponse({ access_token: ACCESS_TOKEN, token_type: 'bearer', expires_in: 5183944 }),
    [USER_URL]: () => jsonResponse(USER),
    ...overrides,
  }
  spies.push(
    spyOn(globalThis, 'fetch').mockImplementation((async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = input instanceof Request ? input.url : String(input)
      calls.push({
        url,
        body: input instanceof Request ? await input.clone().text() : '',
        headers: input instanceof Request ? input.headers : new Headers(init?.headers),
        signal: init?.signal ?? undefined,
      })
      const route = routes[url]
      if (!route) {
        throw new Error(`unexpected request to ${url}`)
      }
      const answer = await route()
      // What `fetch` does with a redirect, which a stub does not do by itself: refuse it
      // when the request said `redirect: 'error'`, and otherwise request the target with the
      // same headers. A read that follows one is seen asking the target.
      const location = answer.headers.get('location')
      if (answer.status >= 300 && answer.status < 400 && location !== null) {
        const mode = input instanceof Request ? input.redirect : init?.redirect
        if (mode === 'error') {
          throw new TypeError('fetch failed: unexpected redirect')
        }
        return globalThis.fetch(location, init)
      }
      return answer
    }) as typeof fetch)
  )
  return calls
}

const user = (fields: Record<string, unknown>) => ({
  [USER_URL]: () => jsonResponse({ ...USER, ...fields }),
})

async function failureOf(promise: Promise<unknown>): Promise<OAuthFailure | string> {
  try {
    await promise
    return 'resolved'
  } catch (error) {
    return error instanceof OAuthProviderError ? error.failure : `threw ${String(error)}`
  }
}

describe('the authorization URL', () => {
  test('carries state and the one scope, never the secret; no challenge and no nonce, which Facebook’s manual flow does not take', () => {
    const url = new URL(
      createFacebookProvider().authorizationUrl(credentials, {
        state: 'the-state',
        codeVerifier: 'the-verifier',
        nonce: 'nonce-of-this-attempt',
        redirectUri: REDIRECT_URI,
      })
    )
    expect(url.origin + url.pathname).toBe('https://www.facebook.com/v16.0/dialog/oauth')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: CLIENT_ID,
      state: 'the-state',
      scope: 'public_profile',
      redirect_uri: REDIRECT_URI,
    })
    expect(url.toString()).not.toContain('the-verifier')
    expect(url.toString()).not.toContain('nonce-of-this-attempt')
    expect(url.toString()).not.toContain(SECRET)
  })

  test('the one scope is public_profile: the email permission is never asked for', () => {
    expect(FACEBOOK_SCOPES).toEqual(['public_profile'])
  })
})

describe('the exchange', () => {
  test('sends the code and the secret in the token request’s body, then reads two fields with the token and its proof', async () => {
    const calls = facebook()
    expect(await createFacebookProvider().exchange(credentials, exchangeInput)).toEqual({
      subject: '10158712345678901',
      email: null,
      emailVerified: false,
      givenName: 'Nelly',
      familyName: 'Okafor',
    })
    // Two requests, to Facebook's two addresses and nowhere else.
    expect(calls.map((call) => call.url)).toEqual([TOKEN_URL, USER_URL])
    const [token, profile] = calls
    expect(Object.fromEntries(new URLSearchParams(token?.body))).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      client_secret: SECRET,
    })
    const read = new URL(profile?.url ?? '')
    expect(read.pathname).toBe(`/${FACEBOOK_GRAPH_VERSION}/me`)
    // The fields asked for: the id and the name. Never `email`.
    expect(read.searchParams.get('fields')).toBe('id,name')
    expect([...read.searchParams.keys()].sort()).toEqual(['appsecret_proof', 'fields'])
    // The token travels in the header, not in the address; the secret in neither.
    expect(profile?.headers.get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`)
    expect(profile?.url).not.toContain(ACCESS_TOKEN)
    expect(profile?.url).not.toContain(SECRET)
    expect(profile?.signal).toBeInstanceOf(AbortSignal)
  })

  test('the proof is the token’s HMAC-SHA256 under the app secret, in hex', () => {
    expect(appSecretProof(ACCESS_TOKEN, SECRET)).toBe(PROOF)
    expect(PROOF).toMatch(/^[0-9a-f]{64}$/)
    expect(appSecretProof(ACCESS_TOKEN, 'another-secret')).not.toBe(PROOF)
    expect(appSecretProof('another-token', SECRET)).not.toBe(PROOF)
  })

  test('the profile holds nothing of a token, the proof or the secret, and nothing is logged', async () => {
    facebook()
    const logged = (['debug', 'info', 'warn', 'error'] as const).map((level) => {
      const spy = spyOn(logger, level).mockImplementation(() => undefined)
      spies.push(spy)
      return spy
    })
    const profile = await createFacebookProvider().exchange(credentials, exchangeInput)
    expect(JSON.stringify(profile)).not.toContain('canary')
    expect(JSON.stringify(profile)).not.toContain(PROOF)
    expect(JSON.stringify(profile)).not.toContain(SECRET)
    expect(Object.keys(profile).sort()).toEqual([
      'email',
      'emailVerified',
      'familyName',
      'givenName',
      'subject',
    ])
    for (const spy of logged) {
      expect(spy).not.toHaveBeenCalled()
    }
  })
})

describe('no address is taken from Facebook', () => {
  // Facebook returns `email` with the `email` permission, and says only that it is "the
  // primary email address listed on their profile". The adapter asks for neither the
  // permission nor the field, and an answer that carries one anyway must not become the
  // account's.
  test.each([
    ['an email', { email: 'victim@northline.app' }],
    [
      'an email and flags that say verified',
      { email: 'victim@northline.app', verified: true, email_verified: true, is_verified: true },
    ],
  ] as [string, Record<string, unknown>][])(
    'an answer with %s gives a profile with none',
    async (_name, fields) => {
      facebook(user(fields))
      const profile = await createFacebookProvider().exchange(credentials, exchangeInput)
      expect(profile.email).toBeNull()
      expect(profile.emailVerified).toBe(false)
      expect(JSON.stringify(profile)).not.toContain('victim')
    }
  )
})

describe('the account is the app-scoped user id', () => {
  test('never the name: two answers with one id and different names are one subject', async () => {
    facebook(user({ name: null }))
    const profile = await createFacebookProvider().exchange(credentials, exchangeInput)
    expect(profile.subject).toBe(USER.id)
    expect(profile.givenName).toBeUndefined()
    expect(profile.familyName).toBeUndefined()
  })

  test.each([
    ['thirty-two digits', '12345678901234567890123456789012'],
    ['a short id', '4'],
  ])('%s is taken as written', async (_name, id) => {
    facebook(user({ id }))
    expect((await createFacebookProvider().exchange(credentials, exchangeInput)).subject).toBe(id)
    expect(isFacebookUserId(id)).toBe(true)
  })

  test.each([
    ['no id', { id: undefined }],
    ['a number (Facebook writes a numeric string)', { id: 1015871234567890 }],
    ['an empty id', { id: '' }],
    ['a name in its place', { id: 'nelly.okafor' }],
    ['digits with something after them', { id: '10158712345678901:admin' }],
    ['a leading zero (another spelling of another id)', { id: '010158712345678901' }],
    ['a sign', { id: '-10158712345678901' }],
    ['thirty-three digits', { id: '123456789012345678901234567890123' }],
    ['digits of another script', { id: '１０１５８７１２３４５' }],
    ['a line break after the digits', { id: '10158712345678901\n' }],
  ] as [string, Record<string, unknown>][])('%s is refused', async (_name, fields) => {
    facebook(user(fields))
    expect(await failureOf(createFacebookProvider().exchange(credentials, exchangeInput))).toBe(
      'invalid_profile'
    )
  })
})

describe('refusals', () => {
  const big = 'x'.repeat(FACEBOOK_MAX_PROFILE_BYTES)
  test.each([
    [
      'a refused code',
      {
        [TOKEN_URL]: () =>
          jsonResponse({ error: 'invalid_grant', error_description: 'expired' }, 400),
      },
      'invalid_grant',
    ],
    [
      'a refused code, as the Graph API words an error',
      {
        [TOKEN_URL]: () =>
          jsonResponse(
            { error: { message: 'This authorization code has expired.', code: 100 } },
            400
          ),
      },
      'unavailable',
    ],
    [
      'a token endpoint that is down',
      { [TOKEN_URL]: () => new Response('x', { status: 502 }) },
      'unavailable',
    ],
    [
      'a token answer with no access token',
      { [TOKEN_URL]: () => jsonResponse({ token_type: 'bearer' }) },
      'unavailable',
    ],
    [
      'a refused profile call',
      { [USER_URL]: () => jsonResponse({ error: { code: 190, type: 'OAuthException' } }, 401) },
      'unavailable',
    ],
    [
      'an unreachable API',
      { [USER_URL]: () => Promise.reject(new TypeError('fetch failed')) },
      'unavailable',
    ],
    ['a profile that is not JSON', { [USER_URL]: () => new Response('<html>') }, 'invalid_profile'],
    ['a profile that is a list', { [USER_URL]: () => jsonResponse([USER]) }, 'invalid_profile'],
    ['a profile that is null', { [USER_URL]: () => jsonResponse(null) }, 'invalid_profile'],
    [
      'an error object with a 200',
      { [USER_URL]: () => jsonResponse({ error: { code: 190 } }) },
      'invalid_profile',
    ],
    [
      'a profile over the size cap, though it is a good one',
      { [USER_URL]: () => jsonResponse({ ...USER, about: big }) },
      'invalid_profile',
    ],
  ] as [string, Record<string, Answer>, OAuthFailure][])(
    '%s is a failure',
    async (_name, overrides, failure) => {
      facebook(overrides)
      expect(await failureOf(createFacebookProvider().exchange(credentials, exchangeInput))).toBe(
        failure
      )
    }
  )

  test.each([400, 401, 403, 404, 429, 500, 502, 503])(
    'the profile endpoint answering %i is unavailable',
    async (status) => {
      facebook({ [USER_URL]: () => jsonResponse(USER, status) })
      expect(await failureOf(createFacebookProvider().exchange(credentials, exchangeInput))).toBe(
        'unavailable'
      )
    }
  )

  test.each([301, 302, 303, 307, 308])(
    'a %i from the profile endpoint is not followed: the token goes nowhere else',
    async (status) => {
      const elsewhere = 'https://elsewhere.test/collect'
      const calls = facebook({
        [USER_URL]: () => new Response(null, { status, headers: { location: elsewhere } }),
        // What a followed redirect would find: a good profile, for someone else.
        [elsewhere]: () => jsonResponse({ ...USER, id: '99999999999999999' }),
      })
      expect(await failureOf(createFacebookProvider().exchange(credentials, exchangeInput))).toBe(
        'unavailable'
      )
      expect(calls.map((call) => call.url)).toEqual([TOKEN_URL, USER_URL])
    }
  )

  test('a profile exactly at the cap is read', async () => {
    const padding = FACEBOOK_MAX_PROFILE_BYTES - JSON.stringify({ ...USER, pad: '' }).length
    const body = JSON.stringify({ ...USER, pad: 'x'.repeat(padding) })
    expect(body.length).toBe(FACEBOOK_MAX_PROFILE_BYTES)
    facebook({ [USER_URL]: () => new Response(body) })
    expect((await createFacebookProvider().exchange(credentials, exchangeInput)).subject).toBe(
      USER.id
    )
  })

  test('an oversized body is not read to its end', async () => {
    let pulled = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        controller.enqueue(new Uint8Array(16 * 1024).fill(0x20))
      },
    })
    facebook({ [USER_URL]: () => new Response(endless) })
    expect(await failureOf(createFacebookProvider().exchange(credentials, exchangeInput))).toBe(
      'invalid_profile'
    )
    expect(pulled * 16 * 1024).toBeLessThan(FACEBOOK_MAX_PROFILE_BYTES * 4)
  })

  test('a body cut off mid-answer is unavailable', async () => {
    const cut = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"id":"10158'))
        controller.error(new TypeError('connection reset: canary-in-the-answer'))
      },
    })
    facebook({ [USER_URL]: () => new Response(cut) })
    const error = await createFacebookProvider()
      .exchange(credentials, exchangeInput)
      .catch((caught: unknown) => caught)
    expect((error as OAuthProviderError).failure).toBe('unavailable')
    expect(`${String(error)}${JSON.stringify(error)}`).not.toContain('canary')
  })

  test.each([
    [
      'an OAuth error',
      {
        [TOKEN_URL]: () =>
          jsonResponse({ error: 'invalid_grant', error_description: 'canary-in-the-answer' }, 400),
      },
      'invalid_grant',
    ],
    [
      'a refused profile call',
      { [USER_URL]: () => new Response('canary-in-the-answer', { status: 403 }) },
      'unavailable',
    ],
    [
      'a profile without an id',
      { [USER_URL]: () => jsonResponse({ name: 'canary-in-the-answer' }) },
      'invalid_profile',
    ],
    [
      'a network failure',
      { [USER_URL]: () => Promise.reject(new TypeError('fetch failed: canary-in-the-answer')) },
      'unavailable',
    ],
  ] as [string, Record<string, Answer>, OAuthFailure][])(
    '%s becomes an error that carries nothing of the answer, of a token or of its proof',
    async (_name, overrides, failure) => {
      facebook(overrides)
      const logged = (['debug', 'info', 'warn', 'error'] as const).map((level) => {
        const spy = spyOn(logger, level).mockImplementation(() => undefined)
        spies.push(spy)
        return spy
      })
      const error = await createFacebookProvider()
        .exchange(credentials, exchangeInput)
        .catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(OAuthProviderError)
      expect((error as Error).message).toBe(`oauth provider: ${failure}`)
      expect((error as Error).cause).toBeUndefined()
      const said = `${String(error)}${JSON.stringify(error)}`
      expect(said).not.toContain('canary')
      expect(said).not.toContain(PROOF)
      expect(said).not.toContain(SECRET)
      for (const spy of logged) {
        expect(spy).not.toHaveBeenCalled()
      }
    }
  )
})

describe('a Facebook that never answers', () => {
  const TIMEOUT = { timeoutMs: 40 }
  const hang = () => new Promise<Response>(() => undefined)

  test.each([
    ['the token endpoint', TOKEN_URL],
    ['the Graph API', USER_URL],
  ])('%s hanging is unavailable after the timeout', async (_name, url) => {
    facebook({ [url]: hang })
    const since = performance.now()
    expect(
      await failureOf(createFacebookProvider(TIMEOUT).exchange(credentials, exchangeInput))
    ).toBe('unavailable')
    expect(performance.now() - since).toBeLessThan(2000)
  })

  test('a body that never finishes is unavailable too', async () => {
    facebook({
      [USER_URL]: () =>
        new Response(new ReadableStream({ start: () => undefined }), { status: 200 }),
    })
    const since = performance.now()
    expect(
      await failureOf(createFacebookProvider(TIMEOUT).exchange(credentials, exchangeInput))
    ).toBe('unavailable')
    expect(performance.now() - since).toBeLessThan(2000)
  })
})
