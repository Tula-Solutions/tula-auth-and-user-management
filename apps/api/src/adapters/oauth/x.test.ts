import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { s256 } from '~/adapters/oauth/mock'
import * as logger from '~/lib/logger'
import { type OAuthFailure, OAuthProviderError } from '~/ports/oauth-provider'
import { createXProvider, isXUserId, X_MAX_PROFILE_BYTES, X_SCOPES } from './x'

const REDIRECT_URI = 'https://auth.northline.app/v1/oauth/callback/x'
const CLIENT_ID = 'bDNxS0tWYXJ4Zm5PWUtzbGpGTmE6MTpjaQ'
const SECRET = 'x-client-secret'
const ACCESS_TOKEN = 'x-access-token-canary'
const TOKEN_URL = 'https://api.x.com/2/oauth2/token'
const USER_URL = 'https://api.x.com/2/users/me'
const credentials = { clientId: CLIENT_ID, clientSecret: SECRET }
const exchangeInput = {
  code: 'the-code',
  codeVerifier: 'the-verifier',
  nonce: 'nonce-of-this-attempt',
  redirectUri: REDIRECT_URI,
}
/** The example user of X's own reference. */
const USER = { id: '2244994945', name: 'Nelly Okafor', username: 'nelly' }

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
 * Stand in for X: its token endpoint and its authenticated-user endpoint, by exact address. A
 * request to any other address fails the test.
 */
function x(overrides: Record<string, Answer> = {}): Call[] {
  const calls: Call[] = []
  const routes: Record<string, Answer> = {
    [TOKEN_URL]: () =>
      jsonResponse({
        token_type: 'bearer',
        expires_in: 7200,
        access_token: ACCESS_TOKEN,
        scope: 'users.read tweet.read',
      }),
    [USER_URL]: () => jsonResponse({ data: USER }),
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
  [USER_URL]: () => jsonResponse({ data: { ...USER, ...fields } }),
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
  test('carries state, the S256 challenge and the two scopes, never the verifier or the secret', () => {
    const url = new URL(
      createXProvider().authorizationUrl(credentials, {
        state: 'the-state',
        codeVerifier: 'the-verifier',
        nonce: 'nonce-of-this-attempt',
        redirectUri: REDIRECT_URI,
      })
    )
    expect(url.origin + url.pathname).toBe('https://x.com/i/oauth2/authorize')
    // No nonce: X is OAuth 2.0, there is no ID token to carry one back.
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      state: 'the-state',
      code_challenge_method: 'S256',
      code_challenge: s256('the-verifier'),
      scope: 'users.read tweet.read',
    })
    expect(url.toString()).not.toContain('the-verifier')
    expect(url.toString()).not.toContain(SECRET)
  })

  test('no scope asks for an address or a refresh token', () => {
    expect(X_SCOPES).toEqual(['users.read', 'tweet.read'])
    expect(X_SCOPES.join(' ')).not.toMatch(/email|offline/)
  })
})

describe('the exchange', () => {
  test('sends the code with the verifier, the secret only as Basic credentials, then reads the user with the token', async () => {
    const calls = x()
    expect(await createXProvider().exchange(credentials, exchangeInput)).toEqual({
      subject: '2244994945',
      email: null,
      emailVerified: false,
      givenName: 'Nelly',
      familyName: 'Okafor',
    })
    // Two requests, to X's two addresses and nowhere else; the user is asked for with no
    // field list, so nothing beyond the defaults (id, name, username) is requested.
    expect(calls.map((call) => call.url)).toEqual([TOKEN_URL, USER_URL])
    const [token, profile] = calls
    expect(Object.fromEntries(new URLSearchParams(token?.body))).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: REDIRECT_URI,
      code_verifier: 'the-verifier',
    })
    expect(token?.headers.get('authorization')).toBe(
      `Basic ${Buffer.from(`${CLIENT_ID}:${SECRET}`).toString('base64')}`
    )
    expect(token?.body).not.toContain(SECRET)
    expect(profile?.headers.get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`)
    expect(profile?.signal).toBeInstanceOf(AbortSignal)
  })

  test('the profile holds nothing of a token, and nothing is logged', async () => {
    x()
    const logged = (['debug', 'info', 'warn', 'error'] as const).map((level) => {
      const spy = spyOn(logger, level).mockImplementation(() => undefined)
      spies.push(spy)
      return spy
    })
    const profile = await createXProvider().exchange(credentials, exchangeInput)
    expect(JSON.stringify(profile)).not.toContain('canary')
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

  test('an exchange with no verifier is refused before anything is sent', async () => {
    const calls = x()
    expect(
      await failureOf(
        createXProvider().exchange(credentials, { ...exchangeInput, codeVerifier: '' })
      )
    ).toBe('invalid_grant')
    expect(calls).toHaveLength(0)
  })
})

describe('no address is taken from X', () => {
  // X can be asked for `confirmed_email` (with the `users.email` scope). The adapter asks for
  // neither, and an answer that carries an address anyway must not become the account's.
  test.each([
    ['a confirmed_email', { confirmed_email: 'victim@northline.app' }],
    ['an email', { email: 'victim@northline.app' }],
    [
      'both, and flags that say verified',
      {
        email: 'victim@northline.app',
        confirmed_email: 'victim@northline.app',
        verified: true,
        email_verified: true,
      },
    ],
  ] as [string, Record<string, unknown>][])(
    'an answer with %s gives a profile with none',
    async (_name, fields) => {
      x(user(fields))
      const profile = await createXProvider().exchange(credentials, exchangeInput)
      expect(profile.email).toBeNull()
      expect(profile.emailVerified).toBe(false)
      expect(JSON.stringify(profile)).not.toContain('victim')
    }
  )

  test('nor from beside the user object', async () => {
    x({
      [USER_URL]: () =>
        jsonResponse({
          data: USER,
          email: 'victim@northline.app',
          includes: { email: 'v@x.test' },
        }),
    })
    const profile = await createXProvider().exchange(credentials, exchangeInput)
    expect(profile).toMatchObject({ subject: USER.id, email: null, emailVerified: false })
  })
})

describe('the account is the user id', () => {
  test('never the username: two answers with one id and different names are one subject', async () => {
    x(user({ username: 'renamed', name: null }))
    const profile = await createXProvider().exchange(credentials, exchangeInput)
    expect(profile.subject).toBe(USER.id)
    expect(profile.givenName).toBeUndefined()
    expect(profile.familyName).toBeUndefined()
  })

  test.each([
    ['the largest 64-bit value', '18446744073709551615'],
    ['a short id', '7'],
  ])('%s is taken as written', async (_name, id) => {
    x(user({ id }))
    expect((await createXProvider().exchange(credentials, exchangeInput)).subject).toBe(id)
    expect(isXUserId(id)).toBe(true)
  })

  test.each([
    ['no id', { id: undefined }],
    ['a number (an id does not fit one)', { id: 2244994945 }],
    ['an empty id', { id: '' }],
    ['a username in its place', { id: 'nelly' }],
    ['digits with something after them', { id: '2244994945:admin' }],
    ['a leading zero (another spelling of another id)', { id: '02244994945' }],
    ['a sign', { id: '-2244994945' }],
    ['twenty-one digits', { id: '123456789012345678901' }],
    ['digits of another script', { id: '２２４４９９４９４５' }],
    ['a line break after the digits', { id: '2244994945\n' }],
  ] as [string, Record<string, unknown>][])('%s is refused', async (_name, fields) => {
    x(user(fields))
    expect(await failureOf(createXProvider().exchange(credentials, exchangeInput))).toBe(
      'invalid_profile'
    )
  })
})

describe('refusals', () => {
  const big = 'x'.repeat(X_MAX_PROFILE_BYTES)
  test.each([
    [
      'a refused code',
      { [TOKEN_URL]: () => jsonResponse({ error: 'invalid_grant' }, 400) },
      'invalid_grant',
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
      { [USER_URL]: () => jsonResponse({ title: 'Unauthorized', status: 401 }, 401) },
      'unavailable',
    ],
    [
      'a profile call over its limit',
      { [USER_URL]: () => jsonResponse({ title: 'Too Many Requests' }, 429) },
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
    ['a user outside `data`', { [USER_URL]: () => jsonResponse(USER) }, 'invalid_profile'],
    [
      'a `data` that is a list',
      { [USER_URL]: () => jsonResponse({ data: [USER] }) },
      'invalid_profile',
    ],
    [
      'a `data` that is null',
      { [USER_URL]: () => jsonResponse({ data: null }) },
      'invalid_profile',
    ],
    [
      'errors and no user',
      { [USER_URL]: () => jsonResponse({ errors: [{ title: 'Forbidden' }] }) },
      'invalid_profile',
    ],
    [
      'a profile over the size cap, though it is a good one',
      { [USER_URL]: () => jsonResponse({ data: { ...USER, description: big } }) },
      'invalid_profile',
    ],
  ] as [string, Record<string, Answer>, OAuthFailure][])(
    '%s is a failure',
    async (_name, overrides, failure) => {
      x(overrides)
      expect(await failureOf(createXProvider().exchange(credentials, exchangeInput))).toBe(failure)
    }
  )

  test.each([400, 401, 403, 404, 429, 500, 502, 503])(
    'the profile endpoint answering %i is unavailable',
    async (status) => {
      x({ [USER_URL]: () => jsonResponse({ data: USER }, status) })
      expect(await failureOf(createXProvider().exchange(credentials, exchangeInput))).toBe(
        'unavailable'
      )
    }
  )

  test.each([301, 302, 303, 307, 308])(
    'a %i from the profile endpoint is not followed: the token goes nowhere else',
    async (status) => {
      const elsewhere = 'https://elsewhere.test/collect'
      const calls = x({
        [USER_URL]: () => new Response(null, { status, headers: { location: elsewhere } }),
        // What a followed redirect would find: a good profile, for someone else.
        [elsewhere]: () => jsonResponse({ data: { ...USER, id: '99999999999999999' } }),
      })
      expect(await failureOf(createXProvider().exchange(credentials, exchangeInput))).toBe(
        'unavailable'
      )
      expect(calls.map((call) => call.url)).toEqual([TOKEN_URL, USER_URL])
    }
  )

  test('a profile exactly at the cap is read', async () => {
    const padding = X_MAX_PROFILE_BYTES - JSON.stringify({ data: { ...USER, pad: '' } }).length
    const body = JSON.stringify({ data: { ...USER, pad: 'x'.repeat(padding) } })
    expect(body.length).toBe(X_MAX_PROFILE_BYTES)
    x({ [USER_URL]: () => new Response(body) })
    expect((await createXProvider().exchange(credentials, exchangeInput)).subject).toBe(USER.id)
  })

  test('an oversized body is not read to its end', async () => {
    let pulled = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        controller.enqueue(new Uint8Array(16 * 1024).fill(0x20))
      },
    })
    x({ [USER_URL]: () => new Response(endless) })
    expect(await failureOf(createXProvider().exchange(credentials, exchangeInput))).toBe(
      'invalid_profile'
    )
    expect(pulled * 16 * 1024).toBeLessThan(X_MAX_PROFILE_BYTES * 4)
  })

  test('a body cut off mid-answer is unavailable', async () => {
    const cut = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":{"id":"22449'))
        controller.error(new TypeError('connection reset: canary-in-the-answer'))
      },
    })
    x({ [USER_URL]: () => new Response(cut) })
    const error = await createXProvider()
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
      { [USER_URL]: () => jsonResponse({ data: { username: 'canary-in-the-answer' } }) },
      'invalid_profile',
    ],
    [
      'a network failure',
      { [USER_URL]: () => Promise.reject(new TypeError('fetch failed: canary-in-the-answer')) },
      'unavailable',
    ],
  ] as [string, Record<string, Answer>, OAuthFailure][])(
    '%s becomes an error that carries nothing of the answer or of a token',
    async (_name, overrides, failure) => {
      x(overrides)
      const logged = (['debug', 'info', 'warn', 'error'] as const).map((level) => {
        const spy = spyOn(logger, level).mockImplementation(() => undefined)
        spies.push(spy)
        return spy
      })
      const error = await createXProvider()
        .exchange(credentials, exchangeInput)
        .catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(OAuthProviderError)
      expect((error as Error).message).toBe(`oauth provider: ${failure}`)
      expect((error as Error).cause).toBeUndefined()
      expect(`${String(error)}${JSON.stringify(error)}`).not.toContain('canary')
      for (const spy of logged) {
        expect(spy).not.toHaveBeenCalled()
      }
    }
  )
})

describe('an X that never answers', () => {
  const TIMEOUT = { timeoutMs: 40 }
  const hang = () => new Promise<Response>(() => undefined)

  test.each([
    ['the token endpoint', TOKEN_URL],
    ['the user endpoint', USER_URL],
  ])('%s hanging is unavailable after the timeout', async (_name, url) => {
    x({ [url]: hang })
    const since = performance.now()
    expect(await failureOf(createXProvider(TIMEOUT).exchange(credentials, exchangeInput))).toBe(
      'unavailable'
    )
    expect(performance.now() - since).toBeLessThan(2000)
  })

  test('a body that never finishes is unavailable too', async () => {
    x({
      [USER_URL]: () =>
        new Response(new ReadableStream({ start: () => undefined }), { status: 200 }),
    })
    const since = performance.now()
    expect(await failureOf(createXProvider(TIMEOUT).exchange(credentials, exchangeInput))).toBe(
      'unavailable'
    )
    expect(performance.now() - since).toBeLessThan(2000)
  })
})
