import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { s256 } from '~/adapters/oauth/mock'
import * as logger from '~/lib/logger'
import { type OAuthFailure, OAuthProviderError } from '~/ports/oauth-provider'
import { createDiscordProvider, DISCORD_MAX_PROFILE_BYTES } from './discord'

const REDIRECT_URI = 'https://auth.northline.app/v1/oauth/callback/discord'
const CLIENT_ID = '1157331554103296020'
const SECRET = 'discord-client-secret'
const ACCESS_TOKEN = 'discord-access-token-canary'
const TOKEN_URL = 'https://discord.com/api/oauth2/token'
const USER_URL = 'https://discord.com/api/v10/users/@me'
const credentials = { clientId: CLIENT_ID, clientSecret: SECRET }
const exchangeInput = {
  code: 'the-code',
  codeVerifier: 'the-verifier',
  nonce: 'nonce-of-this-attempt',
  redirectUri: REDIRECT_URI,
}
/** The example user of Discord's own reference, with the two fields the `email` scope adds. */
const USER = {
  id: '80351110224678912',
  username: 'nelly',
  global_name: 'Nelly Okafor',
  verified: true,
  email: 'nelly@northline.app',
}

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
 * Stand in for Discord: its token endpoint and its current-user endpoint, by exact address. A
 * request to any other address fails the test.
 */
function discord(overrides: Record<string, Answer> = {}): Call[] {
  const calls: Call[] = []
  const routes: Record<string, Answer> = {
    [TOKEN_URL]: () =>
      jsonResponse({
        access_token: ACCESS_TOKEN,
        token_type: 'Bearer',
        expires_in: 604800,
        refresh_token: 'discord-refresh-token-canary',
        scope: 'identify email',
      }),
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
  test('carries state, the S256 challenge and the two scopes, never the verifier or the secret', () => {
    const url = new URL(
      createDiscordProvider().authorizationUrl(credentials, {
        state: 'the-state',
        codeVerifier: 'the-verifier',
        nonce: 'nonce-of-this-attempt',
        redirectUri: REDIRECT_URI,
      })
    )
    expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize')
    // No nonce: Discord is OAuth 2.0, there is no ID token to carry one back.
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      state: 'the-state',
      code_challenge_method: 'S256',
      code_challenge: s256('the-verifier'),
      scope: 'identify email',
    })
    expect(url.toString()).not.toContain('the-verifier')
    expect(url.toString()).not.toContain(SECRET)
  })
})

describe('the exchange', () => {
  test('sends the code with the verifier, the secret only as Basic credentials, then reads the user with the token', async () => {
    const calls = discord()
    expect(await createDiscordProvider().exchange(credentials, exchangeInput)).toEqual({
      subject: '80351110224678912',
      email: 'nelly@northline.app',
      emailVerified: true,
      givenName: 'Nelly',
      familyName: 'Okafor',
    })
    // Two requests, to Discord's two addresses and nowhere else.
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
    discord()
    const logged = (['debug', 'info', 'warn', 'error'] as const).map((level) => {
      const spy = spyOn(logger, level).mockImplementation(() => undefined)
      spies.push(spy)
      return spy
    })
    const profile = await createDiscordProvider().exchange(credentials, exchangeInput)
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
    const calls = discord()
    expect(
      await failureOf(
        createDiscordProvider().exchange(credentials, { ...exchangeInput, codeVerifier: '' })
      )
    ).toBe('invalid_grant')
    expect(calls).toHaveLength(0)
  })
})

describe('whether the address is verified', () => {
  // Discord's user object: `verified` is "whether the email on this account has been
  // verified", a boolean, present with the `email` scope. Only the JSON boolean `true` beside
  // an address counts.
  test.each([
    ['verified: true and an address', { verified: true }, 'nelly@northline.app', true],
    ['verified: false', { verified: false }, 'nelly@northline.app', false],
    ['no verified flag', { verified: undefined }, 'nelly@northline.app', false],
    ['the string "true"', { verified: 'true' }, 'nelly@northline.app', false],
    ['the number 1', { verified: 1 }, 'nelly@northline.app', false],
    ['verified: true and a null address', { verified: true, email: null }, null, false],
    ['verified: true and no address', { verified: true, email: undefined }, null, false],
    ['verified: true and an empty address', { verified: true, email: '' }, null, false],
    ['an address that is not a string', { verified: true, email: 7 }, null, false],
  ] as [string, Record<string, unknown>, string | null, boolean][])(
    '%s',
    async (_name, fields, email, emailVerified) => {
      discord(user(fields))
      expect(await createDiscordProvider().exchange(credentials, exchangeInput)).toMatchObject({
        email,
        emailVerified,
      })
    }
  )
})

describe('the account is the user id', () => {
  test('never the username: two answers with one id and different names are one subject', async () => {
    discord(user({ username: 'renamed', global_name: null }))
    const profile = await createDiscordProvider().exchange(credentials, exchangeInput)
    expect(profile.subject).toBe(USER.id)
    expect(profile.givenName).toBeUndefined()
    expect(profile.familyName).toBeUndefined()
  })

  test.each([
    ['the largest 64-bit value', '18446744073709551615'],
    ['a short id', '7'],
  ])('%s is taken as written', async (_name, id) => {
    discord(user({ id }))
    expect((await createDiscordProvider().exchange(credentials, exchangeInput)).subject).toBe(id)
  })

  test.each([
    ['no id', { id: undefined }],
    ['a number (a snowflake does not fit one)', { id: 80351110224678912 }],
    ['an empty id', { id: '' }],
    ['a username in its place', { id: 'nelly' }],
    ['digits with something after them', { id: '80351110224678912:admin' }],
    ['a leading zero (another spelling of another id)', { id: '080351110224678912' }],
    ['a sign', { id: '-80351110224678912' }],
    ['twenty-one digits', { id: '123456789012345678901' }],
    ['digits of another script', { id: '８０３５１１１０２２４６７８９１２' }],
  ] as [string, Record<string, unknown>][])('%s is refused', async (_name, fields) => {
    discord(user(fields))
    expect(await failureOf(createDiscordProvider().exchange(credentials, exchangeInput))).toBe(
      'invalid_profile'
    )
  })
})

describe('refusals', () => {
  const big = 'x'.repeat(DISCORD_MAX_PROFILE_BYTES)
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
      { [TOKEN_URL]: () => jsonResponse({ token_type: 'Bearer' }) },
      'unavailable',
    ],
    [
      'a refused profile call',
      { [USER_URL]: () => jsonResponse({ message: '401: Unauthorized', code: 0 }, 401) },
      'unavailable',
    ],
    [
      'a rate-limited profile call',
      { [USER_URL]: () => jsonResponse({ retry_after: 1 }, 429) },
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
      'a profile over the size cap, though it is a good one',
      { [USER_URL]: () => jsonResponse({ ...USER, banner: big }) },
      'invalid_profile',
    ],
  ] as [string, Record<string, Answer>, OAuthFailure][])(
    '%s is a failure',
    async (_name, overrides, failure) => {
      discord(overrides)
      expect(await failureOf(createDiscordProvider().exchange(credentials, exchangeInput))).toBe(
        failure
      )
    }
  )

  // Review finding F3. Every status but a 2xx is the one word `unavailable`, a 401 and a 403
  // among them: what GitHub's adapter has always answered for its profile read. The access
  // token is seconds old and was issued for this code, so a refusal says something about
  // Discord, not about the user's grant.
  test.each([400, 401, 403, 404, 429, 500, 502, 503])(
    'the profile endpoint answering %i is unavailable',
    async (status) => {
      discord({ [USER_URL]: () => jsonResponse(USER, status) })
      expect(await failureOf(createDiscordProvider().exchange(credentials, exchangeInput))).toBe(
        'unavailable'
      )
    }
  )

  test.each([200, 201, 206])(
    'the profile endpoint answering %i with a user is read',
    async (status) => {
      discord({ [USER_URL]: () => jsonResponse(USER, status) })
      expect(await failureOf(createDiscordProvider().exchange(credentials, exchangeInput))).toBe(
        'resolved'
      )
    }
  )

  // Review finding F1: nothing failed when `redirect: 'error'` was taken off the profile read.
  test.each([301, 302, 303, 307, 308])(
    'a %i from the profile endpoint is not followed: the token goes nowhere else',
    async (status) => {
      const elsewhere = 'https://elsewhere.test/collect'
      const calls = discord({
        [USER_URL]: () => new Response(null, { status, headers: { location: elsewhere } }),
        // What a followed redirect would find: a good profile, for someone else.
        [elsewhere]: () => jsonResponse({ ...USER, id: '99999999999999999' }),
      })
      expect(await failureOf(createDiscordProvider().exchange(credentials, exchangeInput))).toBe(
        'unavailable'
      )
      expect(calls.map((call) => call.url)).toEqual([TOKEN_URL, USER_URL])
    }
  )

  test('a profile exactly at the cap is read', async () => {
    const padding = DISCORD_MAX_PROFILE_BYTES - JSON.stringify({ ...USER, pad: '' }).length
    const body = JSON.stringify({ ...USER, pad: 'x'.repeat(padding) })
    expect(body.length).toBe(DISCORD_MAX_PROFILE_BYTES)
    discord({ [USER_URL]: () => new Response(body) })
    expect((await createDiscordProvider().exchange(credentials, exchangeInput)).subject).toBe(
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
    discord({ [USER_URL]: () => new Response(endless) })
    expect(await failureOf(createDiscordProvider().exchange(credentials, exchangeInput))).toBe(
      'invalid_profile'
    )
    expect(pulled * 16 * 1024).toBeLessThan(DISCORD_MAX_PROFILE_BYTES * 4)
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
      { [USER_URL]: () => jsonResponse({ username: 'canary-in-the-answer' }) },
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
      discord(overrides)
      const error = await createDiscordProvider()
        .exchange(credentials, exchangeInput)
        .catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(OAuthProviderError)
      expect((error as Error).message).toBe(`oauth provider: ${failure}`)
      expect((error as Error).cause).toBeUndefined()
      expect(`${String(error)}${JSON.stringify(error)}`).not.toContain('canary')
    }
  )
})

describe('a Discord that never answers', () => {
  const TIMEOUT = { timeoutMs: 40 }
  const hang = () => new Promise<Response>(() => undefined)

  test.each([
    ['the token endpoint', TOKEN_URL],
    ['the user endpoint', USER_URL],
  ])('%s hanging is unavailable after the timeout', async (_name, url) => {
    discord({ [url]: hang })
    const since = performance.now()
    expect(
      await failureOf(createDiscordProvider(TIMEOUT).exchange(credentials, exchangeInput))
    ).toBe('unavailable')
    expect(performance.now() - since).toBeLessThan(2000)
  })

  test('a body that never finishes is unavailable too', async () => {
    discord({
      [USER_URL]: () =>
        new Response(new ReadableStream({ start: () => undefined }), { status: 200 }),
    })
    const since = performance.now()
    expect(
      await failureOf(createDiscordProvider(TIMEOUT).exchange(credentials, exchangeInput))
    ).toBe('unavailable')
    expect(performance.now() - since).toBeLessThan(2000)
  })
})
