import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose'
import * as logger from '~/lib/logger'
import { type OAuthFailure, OAuthProviderError } from '~/ports/oauth-provider'
import { NONCE_NOT_ECHOED, remoteKeySet, verifyIdToken } from './id-token'
import { createLinkedInProvider, linkedInProfile } from './linkedin'
import { MAX_PROFILE_BYTES } from './profile-read'

const REDIRECT_URI = 'https://auth.northline.app/v1/oauth/callback/linkedin'
const CLIENT_ID = '86abcd1234efgh'
const SECRET = 'linkedin-client-secret'
const ACCESS_TOKEN = 'linkedin-access-token-canary'
const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken'
const KEYS_URL = 'https://www.linkedin.com/oauth/openid/jwks'
const USERINFO_URL = 'https://api.linkedin.com/v2/userinfo'
const SUBJECT = '782bbtaQ'
/** The issuer of LinkedIn's discovery document, and the one its guide's table gives. */
const ISSUER = 'https://www.linkedin.com/oauth'
const GUIDE_ISSUER = 'https://www.linkedin.com'
const credentials = { clientId: CLIENT_ID, clientSecret: SECRET }
const exchangeInput = {
  code: 'the-code',
  codeVerifier: 'the-verifier',
  nonce: 'nonce-of-this-attempt',
  redirectUri: REDIRECT_URI,
}

type Keys = { privateKey: CryptoKey; jwk: JWK }
let linkedinKeys: Keys
let stranger: Keys

async function keys(kid: string): Promise<Keys> {
  const pair = await generateKeyPair('RS256', { extractable: true })
  return {
    privateKey: pair.privateKey,
    jwk: { ...(await exportJWK(pair.publicKey)), kid, alg: 'RS256', use: 'sig' },
  }
}

beforeAll(async () => {
  linkedinKeys = await keys('linkedin-key')
  stranger = await keys('linkedin-key')
})

const spies: ReturnType<typeof spyOn>[] = []
afterEach(() => {
  for (const spy of spies.splice(0)) {
    spy.mockRestore()
  }
})

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

interface TokenOptions {
  issuer?: string
  audience?: string
  subject?: string | null
  expiresIn?: string
  key?: Keys
  alg?: string
  claims?: Record<string, unknown>
}

/**
 * A token with the claims LinkedIn's discovery document lists, and no nonce. Its address and
 * names are not the userinfo answer's: a profile that holds one of them was read from the
 * wrong place.
 */
function idToken(options: TokenOptions = {}): Promise<string> {
  const jwt = new SignJWT({
    name: 'Token Says',
    given_name: 'Token',
    family_name: 'Says',
    picture: 'https://media.licdn.test/picture',
    locale: 'en_US',
    email: 'the-token-says@elsewhere.test',
    email_verified: true,
    ...options.claims,
  })
    .setProtectedHeader({ alg: options.alg ?? 'RS256', kid: 'linkedin-key' })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '5m')
  if (options.subject !== null) {
    jwt.setSubject(options.subject ?? SUBJECT)
  }
  return jwt.sign((options.key ?? linkedinKeys).privateKey)
}

const unsigned = (claims: Record<string, unknown>) =>
  [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    '',
  ].join('.')

type Answer = () => Response | Promise<Response>
interface Call {
  url: string
  body: string
  headers: Headers
  redirect: RequestInit['redirect']
  signal: AbortSignal | null | undefined
}

/** The userinfo answer of LinkedIn's guide, for the member the token is about. */
const USERINFO = {
  sub: SUBJECT,
  name: 'Maya Okafor',
  given_name: 'Maya',
  family_name: 'Okafor',
  picture: 'https://media.licdn.test/picture',
  locale: 'en-US',
  email: 'maya@northline.app',
  email_verified: true,
}
const userinfo = (fields: Record<string, unknown> = {}) => ({
  [USERINFO_URL]: () => jsonResponse({ ...USERINFO, ...fields }),
})

/**
 * Stand in for LinkedIn: its token endpoint, its key document and its userinfo endpoint, by
 * exact address. A request to any other address fails the test.
 */
function linkedin(token: string | Promise<string>, overrides: Record<string, Answer> = {}) {
  const calls: Call[] = []
  const routes: Record<string, Answer> = {
    [TOKEN_URL]: async () =>
      jsonResponse({
        access_token: ACCESS_TOKEN,
        expires_in: 5184000,
        scope: 'email,openid,profile',
        token_type: 'Bearer',
        id_token: await token,
      }),
    [KEYS_URL]: () => jsonResponse({ keys: [linkedinKeys.jwk] }),
    ...userinfo(),
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
        redirect: input instanceof Request ? input.redirect : init?.redirect,
        signal: input instanceof Request ? input.signal : init?.signal,
      })
      const route = routes[url]
      if (!route) {
        throw new Error(`unexpected request to ${url}`)
      }
      return route()
    }) as typeof fetch)
  )
  return { calls, exchange: () => createLinkedInProvider().exchange(credentials, exchangeInput) }
}

async function failureOf(promise: Promise<unknown>): Promise<OAuthFailure | string> {
  try {
    await promise
    return 'resolved'
  } catch (error) {
    return error instanceof OAuthProviderError ? error.failure : `threw ${String(error)}`
  }
}

describe('the authorization URL', () => {
  test('carries state and the three scopes; no challenge and no nonce, which LinkedIn documents neither of', () => {
    const url = new URL(
      createLinkedInProvider().authorizationUrl(credentials, {
        state: 'the-state',
        codeVerifier: 'the-verifier',
        nonce: 'nonce-of-this-attempt',
        redirectUri: REDIRECT_URI,
      })
    )
    expect(url.origin + url.pathname).toBe('https://www.linkedin.com/oauth/v2/authorization')
    // Exactly the five parameters of LinkedIn's "Request an Authorization Code" table.
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: CLIENT_ID,
      state: 'the-state',
      scope: 'openid profile email',
      redirect_uri: REDIRECT_URI,
    })
    for (const kept of ['the-verifier', 'nonce-of-this-attempt', SECRET]) {
      expect(url.toString()).not.toContain(kept)
    }
  })
})

describe('the exchange', () => {
  test('sends the code and the client’s credentials in the body, verifies the ID token, and reads the address and the name from userinfo', async () => {
    const { calls, exchange } = linkedin(idToken())
    // The token says another address and other names: none of it is in the profile.
    expect(await exchange()).toEqual({
      subject: SUBJECT,
      email: 'maya@northline.app',
      emailVerified: true,
      givenName: 'Maya',
      familyName: 'Okafor',
    })
    // In this order: the token is verified before the access token is sent anywhere.
    expect(calls.map((call) => call.url)).toEqual([TOKEN_URL, KEYS_URL, USERINFO_URL])
    // Exactly the five parameters of LinkedIn's "Exchange Authorization Code" table.
    expect(Object.fromEntries(new URLSearchParams(calls[0]?.body))).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      client_secret: SECRET,
    })
    // The access token goes to userinfo, in a header, and nowhere else.
    for (const call of calls) {
      expect(call.headers.get('authorization')).toBe(
        call.url === USERINFO_URL ? `Bearer ${ACCESS_TOKEN}` : null
      )
      expect(`${call.url}${call.body}`).not.toContain(ACCESS_TOKEN)
    }
    const read = calls[2] as Call
    // A redirect would carry the token to wherever it points.
    expect(read.redirect).toBe('error')
    expect(read.signal).toBeInstanceOf(AbortSignal)
    expect(read.body).toBe('')
  })

  test('the userinfo answer must be about the member the token is about', async () => {
    for (const sub of ['someone-else', '', undefined, null, 782, [SUBJECT], `${SUBJECT} `]) {
      const { exchange } = linkedin(idToken(), userinfo({ sub }))
      expect(await failureOf(exchange())).toBe('invalid_token')
      spies.splice(0).forEach((spy) => {
        spy.mockRestore()
      })
    }
  })

  test('a mismatched sub is refused like an invalid token, with nothing of either in the error', async () => {
    const { exchange } = linkedin(
      idToken(),
      userinfo({ sub: 'canary-subject', email: 'canary@elsewhere.test' })
    )
    const error = await exchange().catch((caught: unknown) => caught)
    expect((error as Error).message).toBe('oauth provider: invalid_token')
    expect((error as Error).cause).toBeUndefined()
    expect(`${String(error)}${JSON.stringify(error)}`).not.toContain('canary')
  })

  test('a token that does not verify is never followed by a userinfo call', async () => {
    const { calls, exchange } = linkedin(idToken({ audience: 'someone-elses-client' }))
    expect(await failureOf(exchange())).toBe('invalid_token')
    expect(calls.map((call) => call.url)).toEqual([TOKEN_URL, KEYS_URL])
  })

  test('the profile holds nothing of a token, and nothing is logged', async () => {
    const token = await idToken()
    const { exchange } = linkedin(token)
    const logged = (['debug', 'info', 'warn', 'error'] as const).map((level) => {
      const spy = spyOn(logger, level).mockImplementation(() => undefined)
      spies.push(spy)
      return spy
    })
    const profile = await exchange()
    expect(JSON.stringify(profile)).not.toContain('canary')
    expect(JSON.stringify(profile)).not.toContain(token.split('.')[2] as string)
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

  test('both spellings of LinkedIn’s issuer are accepted', async () => {
    expect((await linkedin(idToken({ issuer: ISSUER })).exchange()).subject).toBe(SUBJECT)
    spies.splice(0).forEach((spy) => {
      spy.mockRestore()
    })
    expect((await linkedin(idToken({ issuer: GUIDE_ISSUER })).exchange()).subject).toBe(SUBJECT)
  })

  test('the account is sub, never the address or a name', async () => {
    const first = await linkedin(
      idToken(),
      userinfo({ email: 'someone-else@elsewhere.test', name: 'Renamed' })
    ).exchange()
    expect(first.subject).toBe(SUBJECT)
  })

  test('a token that carries a nonce is judged by the rest: LinkedIn is asked for none', async () => {
    const { exchange } = linkedin(idToken({ claims: { nonce: 'whatever-linkedin-put-there' } }))
    expect((await exchange()).subject).toBe(SUBJECT)
  })
})

describe('whether the address is verified', () => {
  // LinkedIn documents `email_verified` as a Boolean and both fields as optional. Only the
  // JSON boolean `true` beside an address counts; a string is not taken for one. These are
  // fields of the userinfo answer: the token says "verified" in every row and decides none.
  test.each([
    ['email_verified: true and an address', { email_verified: true }, 'maya@northline.app', true],
    ['email_verified: false', { email_verified: false }, 'maya@northline.app', false],
    ['no email_verified', { email_verified: undefined }, 'maya@northline.app', false],
    ['the string "true"', { email_verified: 'true' }, 'maya@northline.app', false],
    ['the number 1', { email_verified: 1 }, 'maya@northline.app', false],
    ['email_verified: true and no address', { email: undefined }, null, false],
    ['email_verified: true and an empty address', { email: '' }, null, false],
    ['an address that is not a string', { email: ['maya@northline.app'] }, null, false],
  ] as [string, Record<string, unknown>, string | null, boolean][])(
    '%s',
    async (_name, fields, email, emailVerified) => {
      const { exchange } = linkedin(idToken(), userinfo(fields))
      expect(await exchange()).toMatchObject({ email, emailVerified })
    }
  )

  test('a token that says verified beside a userinfo answer with no address proves no address', async () => {
    const { exchange } = linkedin(
      idToken({ claims: { email: 'maya@northline.app', email_verified: true } }),
      userinfo({ email: undefined, email_verified: undefined })
    )
    expect(await exchange()).toMatchObject({ email: null, emailVerified: false })
  })

  test('names come from userinfo and are optional', async () => {
    const { exchange } = linkedin(idToken(), userinfo({ given_name: undefined, family_name: 7 }))
    const profile = await exchange()
    expect(profile.givenName).toBeUndefined()
    expect(profile.familyName).toBeUndefined()
  })
})

describe('the userinfo answer', () => {
  const big = 'x'.repeat(MAX_PROFILE_BYTES)
  test.each([
    [
      'a refused call',
      () => jsonResponse({ message: 'canary-in-the-answer', status: 401 }, 401),
      'unavailable',
    ],
    [
      'a rate-limited call',
      () => jsonResponse({ message: 'canary-in-the-answer' }, 429),
      'unavailable',
    ],
    ['a server error', () => new Response('canary-in-the-answer', { status: 503 }), 'unavailable'],
    [
      'an unreachable API',
      () => Promise.reject(new TypeError('fetch failed: canary-in-the-answer')),
      'unavailable',
    ],
    [
      'a redirect, which is not followed',
      () => Promise.reject(new TypeError('unexpected redirect: canary-in-the-answer')),
      'unavailable',
    ],
    [
      'an answer that is not JSON',
      () => new Response('<html>canary-in-the-answer'),
      'invalid_profile',
    ],
    [
      'a list',
      () => jsonResponse([{ ...USERINFO, note: 'canary-in-the-answer' }]),
      'invalid_profile',
    ],
    ['null', () => jsonResponse(null), 'invalid_profile'],
    ['a string', () => jsonResponse('canary-in-the-answer'), 'invalid_profile'],
    [
      'an answer over the size cap, though it is a good one',
      () => jsonResponse({ ...USERINFO, note: `canary-in-the-answer${big}` }),
      'invalid_profile',
    ],
  ] as [string, Answer, OAuthFailure][])(
    '%s is a failure that carries nothing of it or of the token',
    async (_name, answer, failure) => {
      const logged = (['debug', 'info', 'warn', 'error'] as const).map((level) => {
        const spy = spyOn(logger, level).mockImplementation(() => undefined)
        spies.push(spy)
        return spy
      })
      const { exchange } = linkedin(idToken(), { [USERINFO_URL]: answer })
      const error = await exchange().catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(OAuthProviderError)
      expect((error as Error).message).toBe(`oauth provider: ${failure}`)
      expect((error as Error).cause).toBeUndefined()
      expect(`${String(error)}${JSON.stringify(error)}`).not.toContain('canary')
      for (const spy of logged) {
        expect(spy).not.toHaveBeenCalled()
      }
    }
  )

  test('an answer exactly at the cap is read', async () => {
    const padding = MAX_PROFILE_BYTES - JSON.stringify({ ...USERINFO, pad: '' }).length
    const body = JSON.stringify({ ...USERINFO, pad: 'x'.repeat(padding) })
    expect(body.length).toBe(MAX_PROFILE_BYTES)
    const { exchange } = linkedin(idToken(), { [USERINFO_URL]: () => new Response(body) })
    expect((await exchange()).subject).toBe(SUBJECT)
  })

  test('an oversized body is not read to its end', async () => {
    let pulled = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        controller.enqueue(new Uint8Array(16 * 1024).fill(0x20))
      },
    })
    const { exchange } = linkedin(idToken(), { [USERINFO_URL]: () => new Response(endless) })
    expect(await failureOf(exchange())).toBe('invalid_profile')
    expect(pulled * 16 * 1024).toBeLessThan(MAX_PROFILE_BYTES * 4)
  })

  test('a token answer with no access token: nothing is asked of userinfo', async () => {
    const token = await idToken()
    const { calls, exchange } = linkedin(token, {
      [TOKEN_URL]: () => jsonResponse({ id_token: token, token_type: 'Bearer' }),
    })
    expect(await failureOf(exchange())).toBe('unavailable')
    expect(calls.map((call) => call.url)).not.toContain(USERINFO_URL)
  })
})

describe('the rule the mock provider shares', () => {
  test('linkedInProfile judges an answer as the adapter does', () => {
    expect(linkedInProfile(SUBJECT, USERINFO)).toEqual({
      subject: SUBJECT,
      email: 'maya@northline.app',
      emailVerified: true,
      givenName: 'Maya',
      familyName: 'Okafor',
    })
    const failure = (work: () => unknown) => {
      try {
        work()
        return 'returned'
      } catch (error) {
        return error instanceof OAuthProviderError ? error.failure : 'threw'
      }
    }
    expect(failure(() => linkedInProfile(SUBJECT, { ...USERINFO, sub: 'another' }))).toBe(
      'invalid_token'
    )
    expect(failure(() => linkedInProfile(SUBJECT, undefined))).toBe('invalid_profile')
    expect(failure(() => linkedInProfile(SUBJECT, [USERINFO]))).toBe('invalid_profile')
    // An inherited key is not the answer's own `sub`.
    expect(
      failure(() => linkedInProfile('constructor', Object.create({ sub: 'constructor' })))
    ).toBe('invalid_token')
  })
})

describe('refusals', () => {
  test.each([
    ['another issuer', () => idToken({ issuer: 'https://www.linkedin.com.evil.test' })],
    ['an issuer that only starts like LinkedIn’s', () => idToken({ issuer: `${ISSUER}/v2` })],
    ['Google’s issuer', () => idToken({ issuer: 'https://accounts.google.com' })],
    ['another audience', () => idToken({ audience: 'someone-elses-client' })],
    ['an expired token', () => idToken({ expiresIn: '-5m' })],
    ['a token signed by another key with the same kid', () => idToken({ key: stranger })],
    [
      'an unsigned token',
      async () =>
        unsigned({
          iss: ISSUER,
          aud: CLIENT_ID,
          sub: SUBJECT,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 300,
          email: 'maya@northline.app',
          email_verified: true,
        }),
    ],
    [
      'a tampered payload',
      async () => {
        const [header, payload, signature] = (await idToken()).split('.') as [
          string,
          string,
          string,
        ]
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
        const forged = Buffer.from(
          JSON.stringify({ ...claims, email: 'victim@northline.app' })
        ).toString('base64url')
        return [header, forged, signature].join('.')
      },
    ],
    ['something that is not a token', async () => 'not-a-jwt'],
  ] as [string, () => Promise<string>][])('refuses %s', async (_name, token) => {
    expect(await failureOf(linkedin(token()).exchange())).toBe('invalid_token')
  })

  test('refuses a PS256 token: RS256 is the only algorithm LinkedIn lists', async () => {
    const pair = await generateKeyPair('PS256', { extractable: true })
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'linkedin-key', use: 'sig' }
    const token = idToken({ alg: 'PS256', key: { privateKey: pair.privateKey, jwk } })
    const { exchange } = linkedin(token, { [KEYS_URL]: () => jsonResponse({ keys: [jwk] }) })
    expect(await failureOf(exchange())).toBe('invalid_token')
  })

  test('refuses a token without a subject', async () => {
    expect(await failureOf(linkedin(idToken({ subject: null })).exchange())).toBe('invalid_token')
  })

  test('a token response without an ID token is refused, and userinfo is not asked without one', async () => {
    const { calls, exchange } = linkedin('', {
      [TOKEN_URL]: () => jsonResponse({ access_token: ACCESS_TOKEN, expires_in: 5184000 }),
    })
    expect(await failureOf(exchange())).toBe('invalid_token')
    expect(calls.map((call) => call.url)).toEqual([TOKEN_URL])
  })

  test.each([
    [
      'a refused code',
      () =>
        jsonResponse({ error: 'invalid_request', error_description: 'canary-in-the-answer' }, 400),
      'invalid_grant',
    ],
    ['a server error', () => new Response('canary-in-the-answer', { status: 503 }), 'unavailable'],
    [
      'a network failure',
      () => Promise.reject(new TypeError('fetch failed: canary-in-the-answer')),
      'unavailable',
    ],
  ] as [string, Answer, OAuthFailure][])(
    'maps %s to a failure that carries nothing of it',
    async (_name, answer, failure) => {
      const { exchange } = linkedin('', { [TOKEN_URL]: answer })
      const error = await exchange().catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(OAuthProviderError)
      expect((error as Error).message).toBe(`oauth provider: ${failure}`)
      expect((error as Error).cause).toBeUndefined()
      expect(`${String(error)}${JSON.stringify(error)}`).not.toContain('canary')
    }
  )

  test('a refused token’s error carries nothing of the token', async () => {
    const token = await idToken({ audience: 'someone-elses-client' })
    const error = await linkedin(token)
      .exchange()
      .catch((caught: unknown) => caught)
    expect((error as Error).message).toBe('oauth provider: invalid_token')
    expect((error as Error).cause).toBeUndefined()
    expect(`${String(error)}${JSON.stringify(error)}`).not.toContain(token.split('.')[1] as string)
  })

  test.each([
    ['cannot be fetched', () => new Response('nope', { status: 500 }), 'invalid_token'],
    ['is not a key set', () => jsonResponse({ keys: 'none' }), 'invalid_token'],
    ['holds no key of that id', () => jsonResponse({ keys: [] }), 'invalid_token'],
  ] as [string, Answer, OAuthFailure][])(
    'the key document %s: the token does not verify',
    async (_name, answer, failure) => {
      const { exchange } = linkedin(idToken(), { [KEYS_URL]: answer })
      expect(await failureOf(exchange())).toBe(failure)
    }
  )
})

describe('a LinkedIn that never answers', () => {
  const hang = () => new Promise<Response>(() => undefined)

  test.each([
    ['the token endpoint', TOKEN_URL],
    ['the key document', KEYS_URL],
    ['the userinfo endpoint', USERINFO_URL],
  ])('%s hanging is unavailable after the timeout', async (_name, url) => {
    linkedin(idToken(), { [url]: hang })
    const since = performance.now()
    expect(
      await failureOf(
        createLinkedInProvider({ timeoutMs: 40 }).exchange(credentials, exchangeInput)
      )
    ).toBe('unavailable')
    expect(performance.now() - since).toBeLessThan(2000)
  })
})

describe('whether the nonce is checked is said at every call', () => {
  const expected = { audience: CLIENT_ID, issuers: [ISSUER] }

  function keySet() {
    spies.push(
      spyOn(globalThis, 'fetch').mockImplementation((async () =>
        jsonResponse({ keys: [linkedinKeys.jwk] })) as unknown as typeof fetch)
    )
    return remoteKeySet(KEYS_URL, 1000)
  }

  test('a call that does not say is refused, by the compiler and at run time', async () => {
    const token = await idToken()
    expect(
      await failureOf(
        // @ts-expect-error -- `nonce` is required: leaving it out must not turn the check off.
        verifyIdToken(keySet(), token, expected, 1000)
      )
    ).toBe('invalid_token')
  })

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['another symbol', Symbol('nonce-not-echoed')],
  ])('%s in its place refuses every token', async (_name, nonce) => {
    const token = await idToken({ claims: { nonce: '' } })
    expect(
      await failureOf(
        verifyIdToken(keySet(), token, { ...expected, nonce: nonce as unknown as string }, 1000)
      )
    ).toBe('invalid_token')
  })

  test('a string is compared: a token with none, or another, is refused', async () => {
    for (const claims of [{}, { nonce: 'another' }]) {
      const token = await idToken({ claims })
      expect(
        await failureOf(
          verifyIdToken(keySet(), token, { ...expected, nonce: 'this-attempt' }, 1000)
        )
      ).toBe('invalid_token')
    }
    const token = await idToken({ claims: { nonce: 'this-attempt' } })
    expect(
      await failureOf(verifyIdToken(keySet(), token, { ...expected, nonce: 'this-attempt' }, 1000))
    ).toBe('resolved')
  })

  test('the marker accepts a token with no nonce, and still checks everything else', async () => {
    const good = await idToken()
    expect(
      await failureOf(verifyIdToken(keySet(), good, { ...expected, nonce: NONCE_NOT_ECHOED }, 1000))
    ).toBe('resolved')
    const foreign = await idToken({ audience: 'someone-elses-client' })
    expect(
      await failureOf(
        verifyIdToken(keySet(), foreign, { ...expected, nonce: NONCE_NOT_ECHOED }, 1000)
      )
    ).toBe('invalid_token')
  })
})
