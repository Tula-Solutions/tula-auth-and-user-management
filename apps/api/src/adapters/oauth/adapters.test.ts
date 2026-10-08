import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose'
import { FixedClock } from '~/adapters/memory/clock'
import { createAppleProvider } from '~/adapters/oauth/apple'
import { createGitHubProvider } from '~/adapters/oauth/github'
import { createGoogleProvider } from '~/adapters/oauth/google'
import {
  displayName,
  emailClaims,
  exchangeFailure,
  PROVIDER_TIMEOUT_MS,
  remoteKeySet,
  verifyIdToken,
  withDeadline,
} from '~/adapters/oauth/id-token'
import { createMockProvider, issueMockCode, type MockGrant, s256 } from '~/adapters/oauth/mock'
import { createSecretBox } from '~/lib/secret-box'
import { type OAuthFailure, OAuthProviderError } from '~/ports/oauth-provider'
import { TEST_MASTER_KEY } from '~/testing'

const REDIRECT_URI = 'https://auth.northline.app/v1/oauth/callback/google'
const CLIENT_ID = 'client-id.apps.example'
const NONCE = 'nonce-of-this-attempt'
const exchangeInput = {
  code: 'the-code',
  codeVerifier: 'the-verifier',
  nonce: NONCE,
  redirectUri: REDIRECT_URI,
}

type Keys = { privateKey: CryptoKey; jwk: JWK }
let provider: Keys
let stranger: Keys

async function keys(kid: string): Promise<Keys> {
  const pair = await generateKeyPair('RS256', { extractable: true })
  return {
    privateKey: pair.privateKey,
    jwk: { ...(await exportJWK(pair.publicKey)), kid, alg: 'RS256', use: 'sig' },
  }
}

beforeAll(async () => {
  provider = await keys('provider-key')
  stranger = await keys('provider-key')
})

let fetchSpy: ReturnType<typeof spyOn> | undefined
afterEach(() => {
  fetchSpy?.mockRestore()
  fetchSpy = undefined
})

/** Answer every outgoing request from a table of URL prefixes. Anything else fails the test. */
function stubFetch(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: { url: string; init: RequestInit | undefined; body: string }[] = []
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url = input instanceof Request ? input.url : String(input)
    const body = input instanceof Request ? await input.clone().text() : ''
    calls.push({ url, init: input instanceof Request ? { headers: input.headers } : init, body })
    const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))
    if (!route) {
      throw new Error(`unexpected request to ${url}`)
    }
    return route[1]()
  }) as typeof fetch)
  return calls
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

interface TokenOptions {
  issuer?: string
  audience?: string
  subject?: string | null
  nonce?: string | null
  expiresIn?: string
  key?: Keys
  claims?: Record<string, unknown>
}

function idToken(options: TokenOptions = {}): Promise<string> {
  const jwt = new SignJWT({
    email: 'maya@northline.app',
    email_verified: true,
    ...(options.nonce !== null && { nonce: options.nonce ?? NONCE }),
    ...options.claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'provider-key' })
    .setIssuer(options.issuer ?? 'https://accounts.google.com')
    .setAudience(options.audience ?? CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '5m')
  if (options.subject !== null) {
    jwt.setSubject(options.subject ?? '1122334455')
  }
  return jwt.sign((options.key ?? provider).privateKey)
}

const unsigned = (claims: Record<string, unknown>) =>
  [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    '',
  ].join('.')

async function failureOf(promise: Promise<unknown>): Promise<OAuthFailure | string> {
  try {
    await promise
    return 'resolved'
  } catch (error) {
    return error instanceof OAuthProviderError ? error.failure : `threw ${String(error)}`
  }
}

describe('Google', () => {
  const credentials = { clientId: CLIENT_ID, clientSecret: 'google-secret' }
  const google = (token: string | Promise<string>) => {
    const calls = stubFetch({
      'https://oauth2.googleapis.com/token': async () =>
        jsonResponse({
          access_token: 'ya29.access',
          token_type: 'Bearer',
          expires_in: 3600,
          id_token: await token,
        }),
      'https://www.googleapis.com/oauth2/v3/certs': () => jsonResponse({ keys: [provider.jwk] }),
    })
    return { calls, adapter: createGoogleProvider() }
  }

  test('the authorization URL carries state, the S256 challenge and the nonce, never the verifier', () => {
    const url = new URL(
      createGoogleProvider().authorizationUrl(credentials, {
        state: 'the-state',
        codeVerifier: 'the-verifier',
        nonce: NONCE,
        redirectUri: REDIRECT_URI,
      })
    )
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: CLIENT_ID,
      state: 'the-state',
      scope: 'openid email profile',
      redirect_uri: REDIRECT_URI,
      code_challenge_method: 'S256',
      code_challenge: s256('the-verifier'),
      nonce: NONCE,
    })
    expect(url.toString()).not.toContain('the-verifier')
    expect(url.toString()).not.toContain('google-secret')
  })

  test('exchanges the code with the verifier and reads the profile from a verified ID token', async () => {
    const { calls, adapter } = google(
      idToken({ claims: { given_name: ' Maya ', family_name: 'Okafor' } })
    )
    expect(await adapter.exchange(credentials, exchangeInput)).toEqual({
      subject: '1122334455',
      email: 'maya@northline.app',
      emailVerified: true,
      givenName: 'Maya',
      familyName: 'Okafor',
    })
    const body = new URLSearchParams(calls[0]?.body)
    expect(body.get('code')).toBe('the-code')
    expect(body.get('code_verifier')).toBe('the-verifier')
    expect(body.get('redirect_uri')).toBe(REDIRECT_URI)
  })

  test('accepts Google’s other issuer spelling, and reports an unverified address as such', async () => {
    const { adapter } = google(
      idToken({ issuer: 'accounts.google.com', claims: { email_verified: false } })
    )
    expect(await adapter.exchange(credentials, exchangeInput)).toMatchObject({
      emailVerified: false,
    })
  })

  test.each([
    ['another issuer', () => idToken({ issuer: 'https://accounts.evil.test' })],
    ['another audience', () => idToken({ audience: 'someone-elses-client' })],
    ['an expired token', () => idToken({ expiresIn: '-5m' })],
    ['a token signed by another key with the same kid', () => idToken({ key: stranger })],
    ['another attempt’s nonce', () => idToken({ nonce: 'nonce-of-another-attempt' })],
    ['no nonce', () => idToken({ nonce: null })],
    [
      'an unsigned token',
      async () =>
        unsigned({
          iss: 'https://accounts.google.com',
          aud: CLIENT_ID,
          sub: '1',
          nonce: NONCE,
          exp: 9_999_999_999,
          iat: 1,
        }),
    ],
    [
      'a tampered payload',
      async () => {
        const [header, , signature] = (await idToken()).split('.')
        const forged = Buffer.from(
          JSON.stringify({
            iss: 'https://accounts.google.com',
            aud: CLIENT_ID,
            sub: 'victim',
            nonce: NONCE,
            exp: 9_999_999_999,
            iat: 1,
          })
        ).toString('base64url')
        return `${header}.${forged}.${signature}`
      },
    ],
    ['something that is not a token', async () => 'not-a-jwt'],
  ] as [string, () => Promise<string>][])('refuses %s', async (_name, token) => {
    const { adapter } = google(token())
    expect(await failureOf(adapter.exchange(credentials, exchangeInput))).toBe('invalid_token')
  })

  test('refuses a token without a subject', async () => {
    const { adapter } = google(idToken({ subject: null }))
    expect(await failureOf(adapter.exchange(credentials, exchangeInput))).toBe('invalid_token')
  })

  test('a token response without an ID token is refused', async () => {
    stubFetch({
      'https://oauth2.googleapis.com/token': () =>
        jsonResponse({ access_token: 'x', token_type: 'Bearer' }),
    })
    expect(await failureOf(createGoogleProvider().exchange(credentials, exchangeInput))).toBe(
      'invalid_token'
    )
  })

  test.each([
    [
      'an OAuth error',
      () => jsonResponse({ error: 'invalid_grant', error_description: 'Bad Request' }, 400),
      'invalid_grant',
    ],
    ['a server error', () => new Response('upstream', { status: 503 }), 'unavailable'],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 }), 'unavailable'],
    ['an error body of the wrong shape', () => jsonResponse('nope', 400), 'unavailable'],
    [
      'a network failure',
      () => Promise.reject(new TypeError('fetch failed: ya29.secret')),
      'unavailable',
    ],
  ] as [string, () => Response | Promise<Response>, string][])(
    'maps %s to a failure that carries nothing of it',
    async (_name, answer, failure) => {
      stubFetch({ 'https://oauth2.googleapis.com/token': answer })
      const error = await createGoogleProvider()
        .exchange(credentials, exchangeInput)
        .catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(OAuthProviderError)
      expect((error as OAuthProviderError).failure).toBe(failure as OAuthFailure)
      expect(String((error as Error).message)).toBe(`oauth provider: ${failure}`)
      expect((error as Error).cause).toBeUndefined()
    }
  )

  test('the key set cannot be fetched: the token does not verify', async () => {
    stubFetch({
      'https://oauth2.googleapis.com/token': async () =>
        jsonResponse({ access_token: 'x', token_type: 'Bearer', id_token: await idToken() }),
      'https://www.googleapis.com/oauth2/v3/certs': () => new Response('down', { status: 500 }),
    })
    expect(await failureOf(createGoogleProvider().exchange(credentials, exchangeInput))).toBe(
      'invalid_token'
    )
  })
})

describe('Apple', () => {
  let credentials: { clientId: string; teamId: string; keyId: string; privateKey: string }

  beforeAll(async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])
    const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString(
      'base64'
    )
    credentials = {
      clientId: CLIENT_ID,
      teamId: 'TEAM123456',
      keyId: 'KEY1234567',
      privateKey: `-----BEGIN PRIVATE KEY-----\n${der}\n-----END PRIVATE KEY-----`,
    }
  })

  const apple = (token: Promise<string>) =>
    stubFetch({
      'https://appleid.apple.com/auth/token': async () =>
        jsonResponse({ access_token: 'a', token_type: 'Bearer', id_token: await token }),
      'https://appleid.apple.com/auth/keys': () => jsonResponse({ keys: [provider.jwk] }),
    })
  const appleToken = (options: TokenOptions = {}) =>
    idToken({ issuer: 'https://appleid.apple.com', ...options })

  test('asks for a form post and carries the nonce', () => {
    const url = new URL(
      createAppleProvider().authorizationUrl(credentials, {
        state: 's',
        codeVerifier: 'v',
        nonce: NONCE,
        redirectUri: REDIRECT_URI,
      })
    )
    expect(url.origin + url.pathname).toBe('https://appleid.apple.com/auth/authorize')
    expect(url.searchParams.get('response_mode')).toBe('form_post')
    expect(url.searchParams.get('scope')).toBe('name email')
    expect(url.searchParams.get('nonce')).toBe(NONCE)
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
  })

  test('signs an ES256 client secret naming the team, key and client, and reads the verified token', async () => {
    const calls = apple(
      appleToken({
        subject: '000123.abc.456',
        claims: { email: 'x7k@privaterelay.appleid.com', email_verified: 'true' },
      })
    )
    const user = JSON.stringify({
      name: { firstName: 'Maya', lastName: 'Okafor' },
      email: 'attacker@evil.test',
    })
    expect(await createAppleProvider().exchange(credentials, { ...exchangeInput, user })).toEqual({
      subject: '000123.abc.456',
      // A private relay address is a real address; `"true"` as a string counts as verified.
      email: 'x7k@privaterelay.appleid.com',
      emailVerified: true,
      givenName: 'Maya',
      familyName: 'Okafor',
    })
    const secret = new URLSearchParams(calls[0]?.body).get('client_secret') ?? ''
    const [header, payload] = secret
      .split('.')
      .slice(0, 2)
      .map((part) => JSON.parse(Buffer.from(part, 'base64url').toString()))
    expect(header).toMatchObject({ alg: 'ES256', kid: 'KEY1234567' })
    expect(payload).toMatchObject({
      iss: 'TEAM123456',
      sub: CLIENT_ID,
      aud: ['https://appleid.apple.com'],
    })
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(300)
  })

  test.each([
    ['not JSON', '{nope'],
    ['a name that is not text', JSON.stringify({ name: { firstName: { $ne: 1 }, lastName: 42 } })],
    ['no name', JSON.stringify({ email: 'attacker@evil.test' })],
  ] as [string, string][])(
    'the unsigned user field (%s) yields no name and never an address or id',
    async (_name, user) => {
      apple(appleToken())
      const profile = await createAppleProvider().exchange(credentials, { ...exchangeInput, user })
      expect(profile).toEqual({
        subject: '1122334455',
        email: 'maya@northline.app',
        emailVerified: true,
      })
    }
  )

  test('verifies the token like any OIDC provider: issuer, audience, nonce', async () => {
    for (const token of [
      idToken(),
      appleToken({ audience: 'other' }),
      appleToken({ nonce: 'other' }),
    ]) {
      apple(token)
      expect(await failureOf(createAppleProvider().exchange(credentials, exchangeInput))).toBe(
        'invalid_token'
      )
      fetchSpy?.mockRestore()
    }
  })

  test('a stored key that is not a PEM makes the provider unusable, without throwing its text', () => {
    expect(() =>
      createAppleProvider().authorizationUrl(
        { ...credentials, privateKey: 'garbage' },
        { state: 's', codeVerifier: 'v', nonce: NONCE, redirectUri: REDIRECT_URI }
      )
    ).toThrow('oauth provider: unavailable')
  })

  test('a refused code is invalid_grant', async () => {
    stubFetch({
      'https://appleid.apple.com/auth/token': () => jsonResponse({ error: 'invalid_grant' }, 400),
    })
    expect(await failureOf(createAppleProvider().exchange(credentials, exchangeInput))).toBe(
      'invalid_grant'
    )
  })
})

describe('GitHub', () => {
  const credentials = { clientId: 'Iv1.github', clientSecret: 'github-secret' }
  const emails = [
    { email: 'public@elsewhere.test', primary: false, verified: true },
    { email: 'maya@northline.app', primary: true, verified: true },
  ]
  const github = (overrides: Record<string, () => Response | Promise<Response>> = {}) =>
    stubFetch({
      'https://github.com/login/oauth/access_token': () =>
        jsonResponse({
          access_token: 'gho_access',
          token_type: 'bearer',
          scope: 'read:user,user:email',
        }),
      'https://api.github.com/user/emails': () => jsonResponse(emails),
      'https://api.github.com/user': () =>
        jsonResponse({
          id: 583231,
          login: 'maya',
          name: 'Maya Adaeze Okafor',
          email: 'public@elsewhere.test',
        }),
      ...overrides,
    })

  // Phase 1 review, deferred item: GitHub's authorization code was bound to the attempt by
  // `state` alone. A code stolen on its way back could be redeemed by whoever held it.
  test('the authorization URL carries state, the S256 challenge and the scopes, never the verifier', () => {
    const url = new URL(
      createGitHubProvider().authorizationUrl(credentials, {
        state: 'the-state',
        codeVerifier: 'the-verifier',
        nonce: NONCE,
        redirectUri: REDIRECT_URI,
      })
    )
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'Iv1.github',
      redirect_uri: REDIRECT_URI,
      state: 'the-state',
      code_challenge_method: 'S256',
      code_challenge: s256('the-verifier'),
      scope: 'read:user user:email',
    })
    expect(url.toString()).not.toContain('the-verifier')
    expect(url.toString()).not.toContain('github-secret')
  })

  test('the token request carries the verifier of the challenge, and the secret only as Basic credentials', async () => {
    const calls = github()
    await createGitHubProvider().exchange(credentials, exchangeInput)
    const token = calls.find((call) => call.url === 'https://github.com/login/oauth/access_token')
    const body = new URLSearchParams(token?.body)
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: REDIRECT_URI,
      code_verifier: 'the-verifier',
    })
    // What GitHub compares: the challenge of this verifier is the one the URL carried.
    const url = new URL(
      createGitHubProvider().authorizationUrl(credentials, {
        state: 's',
        codeVerifier: exchangeInput.codeVerifier,
        nonce: NONCE,
        redirectUri: REDIRECT_URI,
      })
    )
    expect(s256(body.get('code_verifier') as string)).toBe(
      url.searchParams.get('code_challenge') as string
    )
    expect(new Headers(token?.init?.headers).get('authorization')).toBe(
      `Basic ${Buffer.from('Iv1.github:github-secret').toString('base64')}`
    )
    expect(token?.body).not.toContain('github-secret')
  })

  test('an exchange with no verifier is refused before anything is sent', async () => {
    const calls = github()
    expect(
      await failureOf(
        createGitHubProvider().exchange(credentials, { ...exchangeInput, codeVerifier: '' })
      )
    ).toBe('invalid_grant')
    expect(calls).toHaveLength(0)
  })

  test('the subject is the numeric id and the email the primary one with its own verified flag', async () => {
    const calls = github()
    expect(await createGitHubProvider().exchange(credentials, exchangeInput)).toEqual({
      subject: '583231',
      email: 'maya@northline.app',
      emailVerified: true,
      givenName: 'Maya',
      familyName: 'Adaeze Okafor',
    })
    const api = calls.filter((call) => call.url.startsWith('https://api.github.com'))
    expect(api).toHaveLength(2)
    for (const call of api) {
      expect(new Headers(call.init?.headers).get('authorization')).toBe('Bearer gho_access')
    }
  })

  test.each([
    [
      'an unverified primary address',
      [{ email: 'maya@northline.app', primary: true, verified: false }],
      { email: 'maya@northline.app', emailVerified: false },
    ],
    [
      'no primary address',
      [{ email: 'maya@northline.app', primary: false, verified: true }],
      { email: null, emailVerified: false },
    ],
    ['no address at all', [], { email: null, emailVerified: false }],
  ] as [string, unknown[], Record<string, unknown>][])(
    '%s is reported as it is',
    async (_name, list, expected) => {
      github({ 'https://api.github.com/user/emails': () => jsonResponse(list) })
      expect(await createGitHubProvider().exchange(credentials, exchangeInput)).toMatchObject(
        expected
      )
    }
  )

  test('a user without a display name has none', async () => {
    github({
      'https://api.github.com/user': () => jsonResponse({ id: 7, login: 'maya', name: null }),
    })
    const profile = await createGitHubProvider().exchange(credentials, exchangeInput)
    expect(profile.givenName).toBeUndefined()
    expect(profile.familyName).toBeUndefined()
  })

  test.each([
    [
      'a login instead of an id',
      { 'https://api.github.com/user': () => jsonResponse({ login: 'maya' }) },
      'invalid_profile',
    ],
    [
      'an id that is not a number',
      { 'https://api.github.com/user': () => jsonResponse({ id: '583231' }) },
      'invalid_profile',
    ],
    [
      'emails that are not a list',
      { 'https://api.github.com/user/emails': () => jsonResponse({ message: 'x' }) },
      'invalid_profile',
    ],
    [
      'a profile that is not JSON',
      { 'https://api.github.com/user': () => new Response('<html>') },
      'invalid_profile',
    ],
    [
      'a refused API call',
      {
        'https://api.github.com/user/emails': () =>
          jsonResponse({ message: 'Bad credentials' }, 401),
      },
      'unavailable',
    ],
    [
      'an unreachable API',
      { 'https://api.github.com/user': () => Promise.reject(new TypeError('fetch failed')) },
      'unavailable',
    ],
    [
      'a refused code',
      {
        'https://github.com/login/oauth/access_token': () =>
          jsonResponse({ error: 'bad_verification_code' }),
      },
      'invalid_grant',
    ],
    [
      'a token endpoint that is down',
      { 'https://github.com/login/oauth/access_token': () => new Response('x', { status: 502 }) },
      'unavailable',
    ],
  ] as [string, Record<string, () => Response | Promise<Response>>, string][])(
    '%s is a failure',
    async (_name, overrides, failure) => {
      github(overrides)
      expect(await failureOf(createGitHubProvider().exchange(credentials, exchangeInput))).toBe(
        failure
      )
    }
  )
})

describe('the mock provider', () => {
  const clock = new FixedClock()
  const secretBox = createSecretBox(TEST_MASTER_KEY)
  const mock = createMockProvider('google', {
    secretBox,
    clock,
    publicUrl: 'http://localhost:3003/',
  })
  const credentials = { clientId: CLIENT_ID }
  const grant: MockGrant = {
    provider: 'google',
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    nonce: NONCE,
    codeChallenge: s256('the-verifier'),
    // Digits: an id every provider the mock stands in for can have (Discord's are snowflakes).
    profile: { subject: '4815162342', email: 'maya@northline.app', emailVerified: true },
  }

  test('sends the browser to the consent page on the API with the standard parameters', () => {
    const url = new URL(
      mock.authorizationUrl(credentials, {
        state: 's',
        codeVerifier: 'the-verifier',
        nonce: NONCE,
        redirectUri: REDIRECT_URI,
      })
    )
    expect(url.origin + url.pathname).toBe('http://localhost:3003/v1/dev/oauth/authorize')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      provider: 'google',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      state: 's',
      nonce: NONCE,
      code_challenge: s256('the-verifier'),
      code_challenge_method: 'S256',
    })
  })

  test('exchanges a code it issued, with the matching verifier', async () => {
    const code = await issueMockCode(secretBox, clock, grant)
    expect(await mock.exchange(credentials, { ...exchangeInput, code })).toEqual(grant.profile)
  })

  test.each([
    ['another verifier', { codeVerifier: 'another-verifier' }, {}, 'invalid_grant'],
    ['another redirect URI', { redirectUri: 'https://evil.test/cb' }, {}, 'invalid_grant'],
    ['another client', {}, { clientId: 'other-client' }, 'invalid_grant'],
    ['another nonce', { nonce: 'other' }, {}, 'invalid_token'],
  ] as [string, Record<string, string>, Record<string, string>, string][])(
    'refuses %s',
    async (_name, input, creds, failure) => {
      const code = await issueMockCode(secretBox, clock, grant)
      expect(
        await failureOf(
          mock.exchange({ ...credentials, ...creds }, { ...exchangeInput, code, ...input })
        )
      ).toBe(failure)
    }
  )

  // The conformance scenarios and SDK journeys sign in with GitHub through this adapter: the
  // verifier is checked for every provider it stands in for, not only Google.
  test.each(['google', 'github', 'apple', 'discord', 'linkedin'] as const)(
    'standing in for %s: the URL carries the S256 challenge and only its verifier redeems the code',
    async (name) => {
      const standIn = createMockProvider(name, {
        secretBox,
        clock,
        publicUrl: 'http://localhost:3003',
      })
      const url = new URL(
        standIn.authorizationUrl(credentials, {
          state: 's',
          codeVerifier: 'the-verifier',
          nonce: NONCE,
          redirectUri: REDIRECT_URI,
        })
      )
      expect(url.searchParams.get('code_challenge_method')).toBe('S256')
      const codeChallenge = url.searchParams.get('code_challenge') as string
      expect(codeChallenge).toBe(s256('the-verifier'))
      const code = () =>
        issueMockCode(secretBox, clock, { ...grant, provider: name, codeChallenge })
      expect(await standIn.exchange(credentials, { ...exchangeInput, code: await code() })).toEqual(
        grant.profile
      )
      for (const codeVerifier of ['another-verifier', '']) {
        expect(
          await failureOf(
            standIn.exchange(credentials, { ...exchangeInput, code: await code(), codeVerifier })
          )
        ).toBe('invalid_grant')
      }
    }
  )

  test('refuses a code after a minute, a forged code, and another provider’s code', async () => {
    const code = await issueMockCode(secretBox, clock, grant)
    const github = createMockProvider('github', {
      secretBox,
      clock,
      publicUrl: 'http://localhost:3003',
    })
    expect(await failureOf(github.exchange(credentials, { ...exchangeInput, code }))).toBe(
      'invalid_grant'
    )
    expect(
      await failureOf(mock.exchange(credentials, { ...exchangeInput, code: 'v1.AAAA.BBBB' }))
    ).toBe('invalid_grant')
    clock.advance('61s')
    expect(await failureOf(mock.exchange(credentials, { ...exchangeInput, code }))).toBe(
      'invalid_grant'
    )
  })
})

// Review finding F6: no outbound provider call had a timeout, so a provider that accepted the
// connection and never answered held the callback (and the user's browser) open for good.
describe('a provider that never answers', () => {
  /** A request that stays open: it settles only if the caller aborts it. */
  const hang = () => () => new Promise<Response>(() => undefined)
  const TIMEOUT = { timeoutMs: 40 }
  const started = () => performance.now()
  const within = (since: number) => expect(performance.now() - since).toBeLessThan(2000)

  test('the default is ten seconds', () => {
    expect(PROVIDER_TIMEOUT_MS).toBe(10_000)
  })

  test('Google: a token endpoint that hangs is unavailable after the timeout', async () => {
    stubFetch({ 'https://oauth2.googleapis.com/token': hang() })
    const since = started()
    const adapter = createGoogleProvider(TIMEOUT)
    expect(
      await failureOf(
        adapter.exchange({ clientId: CLIENT_ID, clientSecret: 'google-secret' }, exchangeInput)
      )
    ).toBe('unavailable')
    within(since)
  })

  test('Google: a key set that hangs is unavailable, not an invalid token', async () => {
    stubFetch({
      'https://oauth2.googleapis.com/token': async () =>
        jsonResponse({
          access_token: 'ya29.access',
          token_type: 'Bearer',
          expires_in: 3600,
          id_token: await idToken(),
        }),
      'https://www.googleapis.com/oauth2/v3/certs': hang(),
    })
    const since = started()
    expect(
      await failureOf(
        createGoogleProvider(TIMEOUT).exchange(
          { clientId: CLIENT_ID, clientSecret: 'google-secret' },
          exchangeInput
        )
      )
    ).toBe('unavailable')
    within(since)
  })

  test('Apple: a token endpoint that hangs is unavailable after the timeout', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])
    const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString(
      'base64'
    )
    stubFetch({ 'https://appleid.apple.com/auth/token': hang() })
    const since = started()
    expect(
      await failureOf(
        createAppleProvider(TIMEOUT).exchange(
          {
            clientId: CLIENT_ID,
            teamId: 'TEAM123456',
            keyId: 'KEY1234567',
            privateKey: `-----BEGIN PRIVATE KEY-----\n${der}\n-----END PRIVATE KEY-----`,
          },
          exchangeInput
        )
      )
    ).toBe('unavailable')
    within(since)
  })

  test('GitHub: a token endpoint that hangs is unavailable after the timeout', async () => {
    stubFetch({ 'https://github.com/login/oauth/access_token': hang() })
    const since = started()
    expect(
      await failureOf(
        createGitHubProvider(TIMEOUT).exchange(
          { clientId: 'Iv1.github', clientSecret: 'github-secret' },
          exchangeInput
        )
      )
    ).toBe('unavailable')
    within(since)
  })

  test.each(['https://api.github.com/user/emails', 'https://api.github.com/user'])(
    'GitHub: %s hanging is unavailable, and the request is given an abort signal',
    async (hanging) => {
      const calls = stubFetch({
        'https://github.com/login/oauth/access_token': () =>
          jsonResponse({ access_token: 'gho_access', token_type: 'bearer', scope: 'read:user' }),
        'https://api.github.com/user/emails': () =>
          jsonResponse([{ email: 'maya@northline.app', primary: true, verified: true }]),
        'https://api.github.com/user': () => jsonResponse({ id: 583231, name: 'Maya' }),
        [hanging]: hang(),
      })
      const since = started()
      expect(
        await failureOf(
          createGitHubProvider(TIMEOUT).exchange(
            { clientId: 'Iv1.github', clientSecret: 'github-secret' },
            exchangeInput
          )
        )
      ).toBe('unavailable')
      within(since)
      const api = calls.filter((call) => call.url.startsWith('https://api.github.com/'))
      expect(api).toHaveLength(2)
      for (const call of api) {
        expect(call.init?.signal).toBeInstanceOf(AbortSignal)
      }
    }
  )

  test('a body that never finishes is unavailable too', async () => {
    stubFetch({
      'https://github.com/login/oauth/access_token': () =>
        jsonResponse({ access_token: 'gho_access', token_type: 'bearer', scope: 'read:user' }),
      'https://api.github.com/user/emails': () =>
        jsonResponse([{ email: 'maya@northline.app', primary: true, verified: true }]),
      // Headers arrive, the body never does.
      'https://api.github.com/user': () =>
        new Response(new ReadableStream({ start: () => undefined }), { status: 200 }),
    })
    const since = started()
    expect(
      await failureOf(
        createGitHubProvider(TIMEOUT).exchange(
          { clientId: 'Iv1.github', clientSecret: 'github-secret' },
          exchangeInput
        )
      )
    ).toBe('unavailable')
    within(since)
  })

  test('withDeadline passes a result and a failure through, and leaves no timer behind', async () => {
    expect(await withDeadline(Promise.resolve('ok'), 1000)).toBe('ok')
    await expect(withDeadline(Promise.reject(new Error('boom')), 1000)).rejects.toThrow('boom')
    expect(await failureOf(withDeadline(new Promise(() => undefined), 5))).toBe('unavailable')
  })
})

describe('who checks the issuer is said at every call', () => {
  const JWKS_URL = 'https://keys.provider.test/jwks'
  const expected = { audience: CLIENT_ID, nonce: NONCE }

  function keySet() {
    stubFetch({ [JWKS_URL]: () => jsonResponse({ keys: [provider.jwk] }) })
    return remoteKeySet(JWKS_URL, 1000)
  }

  test('a call that does not say is refused, by the compiler and at run time', async () => {
    const token = await idToken()
    expect(
      await failureOf(
        // @ts-expect-error -- `issuers` is required: leaving it out must not turn the check off.
        verifyIdToken(keySet(), token, expected, 1000)
      )
    ).toBe('invalid_token')
  })

  test('a list is checked here: an issuer that is not on it is refused', async () => {
    const token = await idToken({ issuer: 'https://accounts.elsewhere.test' })
    const issuers = ['https://accounts.google.com']
    expect(await failureOf(verifyIdToken(keySet(), token, { ...expected, issuers }, 1000))).toBe(
      'invalid_token'
    )
    fetchSpy?.mockRestore()
    const listed = await idToken()
    expect(await failureOf(verifyIdToken(keySet(), listed, { ...expected, issuers }, 1000))).toBe(
      'resolved'
    )
  })

  test('an empty list accepts no issuer', async () => {
    const token = await idToken()
    expect(
      await failureOf(verifyIdToken(keySet(), token, { ...expected, issuers: [] }, 1000))
    ).toBe('invalid_token')
  })

  test('a caller that says it verifies gets the claims with iss unjudged', async () => {
    const token = await idToken({ issuer: 'https://accounts.elsewhere.test' })
    const verified = await verifyIdToken(
      keySet(),
      token,
      { ...expected, issuers: 'caller-verifies' },
      1000
    )
    expect(verified.payload.iss).toBe('https://accounts.elsewhere.test')
  })
})

describe('shared helpers', () => {
  test('a display name is trimmed, cut and cleared of control characters', () => {
    expect(displayName('  Maya\u0000\nOkafor ')).toBe('Maya  Okafor')
    expect(displayName('x'.repeat(300))).toHaveLength(100)
    expect(displayName('   ')).toBeUndefined()
    expect(displayName(42)).toBeUndefined()
  })

  test('email claims: verified only when the provider says so about an address it gave', () => {
    expect(emailClaims({ email: 'a@b.test', email_verified: true })).toEqual({
      email: 'a@b.test',
      emailVerified: true,
    })
    expect(emailClaims({ email: 'a@b.test', email_verified: 'true' })).toEqual({
      email: 'a@b.test',
      emailVerified: true,
    })
    expect(emailClaims({ email: 'a@b.test', email_verified: 'false' }).emailVerified).toBe(false)
    expect(emailClaims({ email: 'a@b.test' }).emailVerified).toBe(false)
    expect(emailClaims({ email_verified: true })).toEqual({ email: null, emailVerified: false })
    expect(emailClaims({ email: '', email_verified: true })).toEqual({
      email: null,
      emailVerified: false,
    })
  })

  test('an unknown exchange error is unavailable, and a port error passes through', () => {
    expect(exchangeFailure(new Error('boom')).failure).toBe('unavailable')
    const original = new OAuthProviderError('invalid_token')
    expect(exchangeFailure(original)).toBe(original)
  })
})
