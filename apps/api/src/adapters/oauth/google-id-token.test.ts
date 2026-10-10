import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose'
import { FixedClock } from '~/adapters/memory/clock'
import { createGoogleProvider } from '~/adapters/oauth/google'
import { nativeIdTokenProfile } from '~/adapters/oauth/id-token'
import {
  createMockProvider,
  issueMockIdToken,
  MOCK_ID_TOKEN_TTL_MS,
  type MockIdTokenClaims,
} from '~/adapters/oauth/mock'
import { createSecretBox } from '~/lib/secret-box'
import { type OAuthFailure, OAuthProviderError } from '~/ports/oauth-provider'
import { TEST_MASTER_KEY } from '~/testing'

// The ID token a native app hands over (ADR 0045), as the Google adapter and the mock judge
// it. Every token here is signed by a key this file makes; `fetch` is a stub and nothing
// reaches Google.

const WEB = '1234567890-webclient0000000000000000000000.apps.googleusercontent.com'
const ANDROID = '1234567890-androidclient00000000000000000.apps.googleusercontent.com'
const IOS = '1234567890-iosclient000000000000000000000.apps.googleusercontent.com'
const STRANGER = '9999999999-someoneelsesapp00000000000000.apps.googleusercontent.com'
const AUDIENCES = [WEB, ANDROID, IOS]
const NONCE = 'k3o8m1c0Yb7mYt3yYq0d6m3kq2H4t0mVQeT5n0Xb1aA'
const credentials = { clientId: WEB, clientSecret: 'google-secret' }

type Keys = { privateKey: CryptoKey; jwk: JWK }
let google: Keys
let stranger: Keys

async function keys(kid: string, alg = 'RS256'): Promise<Keys> {
  const pair = await generateKeyPair(alg, { extractable: true })
  return {
    privateKey: pair.privateKey,
    jwk: { ...(await exportJWK(pair.publicKey)), kid, alg, use: 'sig' },
  }
}

beforeAll(async () => {
  google = await keys('google-key')
  stranger = await keys('google-key')
})

let fetchSpy: ReturnType<typeof spyOn> | undefined
afterEach(() => {
  fetchSpy?.mockRestore()
  fetchSpy = undefined
})

/** Serve Google's key set and fail the test for any other request. */
function stubKeys(
  answer: () => Response | Promise<Response> = () => Response.json({ keys: [google.jwk] })
) {
  const calls: string[] = []
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (
    input: string | URL | Request
  ) => {
    const url = input instanceof Request ? input.url : String(input)
    calls.push(url)
    if (!url.startsWith('https://www.googleapis.com/oauth2/v3/certs')) {
      throw new Error(`unexpected request to ${url}`)
    }
    return answer()
  }) as typeof fetch)
  return calls
}

interface TokenOptions {
  issuer?: string
  audience?: string | string[]
  subject?: string | null
  nonce?: string | null
  expiresIn?: string | number
  key?: Keys
  alg?: string
  claims?: Record<string, unknown>
}

function idToken(options: TokenOptions = {}): Promise<string> {
  const jwt = new SignJWT({
    email: 'maya@northline.app',
    email_verified: true,
    ...(options.nonce !== null && { nonce: options.nonce ?? NONCE }),
    ...options.claims,
  })
    .setProtectedHeader({ alg: options.alg ?? 'RS256', kid: 'google-key' })
    .setIssuer(options.issuer ?? 'https://accounts.google.com')
    .setAudience(options.audience ?? WEB)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '5m')
  if (options.subject !== null) {
    jwt.setSubject(options.subject ?? '110169484474386276334')
  }
  return jwt.sign((options.key ?? google).privateKey)
}

async function failureOf(promise: Promise<unknown>): Promise<OAuthFailure | string> {
  try {
    await promise
    return 'resolved'
  } catch (error) {
    return error instanceof OAuthProviderError ? error.failure : `threw ${String(error)}`
  }
}

function verify(token: string, expected: { audiences?: readonly string[]; nonce?: string } = {}) {
  const verifyIdToken = createGoogleProvider().verifyIdToken
  if (!verifyIdToken) {
    throw new Error('the Google adapter has no verifyIdToken')
  }
  return verifyIdToken(credentials, {
    idToken: token,
    audiences: expected.audiences ?? AUDIENCES,
    nonce: expected.nonce ?? NONCE,
  })
}

describe('a Google ID token from a native app', () => {
  test('as Android sends it: the web client as aud, the Android client as azp', async () => {
    const calls = stubKeys()
    const profile = await verify(
      await idToken({
        audience: WEB,
        claims: { azp: ANDROID, given_name: 'Maya', family_name: 'Okafor' },
      })
    )
    expect(profile).toEqual({
      subject: '110169484474386276334',
      email: 'maya@northline.app',
      emailVerified: true,
      givenName: 'Maya',
      familyName: 'Okafor',
    })
    // The keys, and nothing else: no token endpoint, no userinfo.
    expect(calls).toEqual(['https://www.googleapis.com/oauth2/v3/certs'])
  })

  test('as iOS sends it without a server client id: the iOS client as aud and as azp', async () => {
    stubKeys()
    const profile = await verify(await idToken({ audience: IOS, claims: { azp: IOS } }))
    expect(profile.subject).toBe('110169484474386276334')
  })

  test('with no azp at all', async () => {
    stubKeys()
    expect((await verify(await idToken({ audience: ANDROID }))).emailVerified).toBe(true)
  })

  test('both spellings of Google’s issuer', async () => {
    stubKeys()
    expect(await failureOf(verify(await idToken({ issuer: 'accounts.google.com' })))).toBe(
      'resolved'
    )
  })

  test.each<[string, TokenOptions]>([
    ['another app’s audience', { audience: STRANGER }],
    ['our audience, asked for by another app (azp)', { claims: { azp: STRANGER } }],
    ['an azp that is not a string', { claims: { azp: [ANDROID] } }],
    ['an empty azp', { claims: { azp: '' } }],
    ['a list of audiences with ours among them', { audience: [WEB, STRANGER] }],
    ['a list of audiences that are all ours', { audience: [WEB, ANDROID] }],
    ['another nonce', { nonce: 'the-nonce-of-another-attempt' }],
    ['no nonce', { nonce: null }],
    ['a nonce that is not a string', { nonce: null, claims: { nonce: 12345 } }],
    ['the hash of the nonce, as some client libraries send', { nonce: sha256(NONCE) }],
    ['expired', { expiresIn: Math.floor(Date.now() / 1000) - 120 }],
    ['another issuer', { issuer: 'https://accounts.example.com' }],
    ['a look-alike issuer', { issuer: 'https://accounts.google.com.example.com' }],
  ])('refused as invalid_token: %s', async (_name, options) => {
    stubKeys()
    expect(await failureOf(verify(await idToken(options)))).toBe('invalid_token')
  })

  test('refused: signed by a key that is not Google’s', async () => {
    stubKeys()
    expect(await failureOf(verify(await idToken({ key: stranger })))).toBe('invalid_token')
  })

  test('refused: an unsigned token (alg none), whatever it claims', async () => {
    stubKeys()
    const now = Math.floor(Date.now() / 1000)
    const token = [
      Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
      Buffer.from(
        JSON.stringify({
          iss: 'https://accounts.google.com',
          aud: WEB,
          sub: '1',
          nonce: NONCE,
          iat: now,
          exp: now + 300,
        })
      ).toString('base64url'),
      '',
    ].join('.')
    expect(await failureOf(verify(token))).toBe('invalid_token')
  })

  test('refused: an algorithm the token names and the adapter does not pin', async () => {
    const elliptic = await keys('google-key', 'ES256')
    stubKeys(() => Response.json({ keys: [elliptic.jwk] }))
    expect(await failureOf(verify(await idToken({ key: elliptic, alg: 'ES256' })))).toBe(
      'invalid_token'
    )
  })

  test('refused: a tampered payload', async () => {
    stubKeys()
    const [header, , signature] = (await idToken()).split('.')
    const forged = Buffer.from(
      JSON.stringify({
        iss: 'https://accounts.google.com',
        aud: WEB,
        sub: 'someone-else',
        nonce: NONCE,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
      })
    ).toString('base64url')
    expect(await failureOf(verify(`${header}.${forged}.${signature}`))).toBe('invalid_token')
  })

  test('refused: not a token at all', async () => {
    stubKeys()
    expect(await failureOf(verify('not-a-jwt'))).toBe('invalid_token')
  })

  test('refused: no accepted audience at all', async () => {
    stubKeys()
    expect(await failureOf(verify(await idToken(), { audiences: [] }))).toBe('invalid_token')
  })

  test('refused: an empty nonce on the attempt never matches a token without one', async () => {
    stubKeys()
    expect(await failureOf(verify(await idToken({ nonce: null }), { nonce: '' }))).toBe(
      'invalid_token'
    )
  })

  test('a token with no subject is invalid_profile', async () => {
    stubKeys()
    // `jose` requires the claim, so a missing one is a token that does not verify; an empty
    // one is a profile with nobody in it.
    expect(await failureOf(verify(await idToken({ subject: null })))).toBe('invalid_token')
    expect(await failureOf(verify(await idToken({ subject: '' })))).toBe('invalid_profile')
  })

  test.each([
    ['the string "true"', 'true'],
    ['the number 1', 1],
    ['absent', undefined],
    ['false', false],
  ])('email_verified counts only as the boolean true: %s', async (_name, value) => {
    stubKeys()
    const profile = await verify(await idToken({ claims: { email_verified: value } }))
    expect(profile.email).toBe('maya@northline.app')
    expect(profile.emailVerified).toBe(false)
  })

  test('a token with no address has none, and is not verified', async () => {
    stubKeys()
    const profile = await verify(
      await idToken({ claims: { email: undefined, email_verified: true } })
    )
    expect(profile).toMatchObject({ email: null, emailVerified: false })
  })

  test('keys that do not arrive in time are unavailable, not a bad token', async () => {
    stubKeys(() => new Promise<Response>(() => {}))
    const slow = createGoogleProvider({ timeoutMs: 20 }).verifyIdToken
    const failure = await failureOf(
      slow?.(credentials, { idToken: await idToken(), audiences: AUDIENCES, nonce: NONCE }) ??
        Promise.resolve()
    )
    expect(failure).toBe('unavailable')
  })

  // On this path a key set that could not be had says nothing about the token, whatever the
  // way it failed (ADR 0045, "Keys that could not be had"). The browser's code flow keeps
  // its own, older classification, which `adapters.test.ts` holds.
  test.each<[string, () => Response | Promise<Response>]>([
    ['the request fails (no network)', () => Promise.reject(new TypeError('fetch failed'))],
    ['a 503 where the keys should be', () => new Response('upstream error', { status: 503 })],
    ['a 404', () => new Response('not found', { status: 404 })],
    ['a redirect handed back', () => new Response(null, { status: 302 })],
    ['a 200 that is not JSON', () => new Response('<html>maintenance</html>')],
    ['a 200 that is JSON and no key set', () => Response.json({ error: 'backend' })],
    ['a 200 whose body breaks off', () => new Response('{"keys":[{"kty":"RSA","n":"')],
  ])('keys that could not be had are unavailable: %s', async (_name, answer) => {
    const calls = stubKeys(answer)
    expect(await failureOf(verify(await idToken()))).toBe('unavailable')
    expect(calls).toHaveLength(1)
  })

  test('a key id the fetched key set does not have is a bad token, not missing keys', async () => {
    const other = await keys('a-key-google-never-had')
    const calls = stubKeys()
    const token = await new SignJWT({ nonce: NONCE })
      .setProtectedHeader({ alg: 'RS256', kid: 'a-key-google-never-had' })
      .setIssuer('https://accounts.google.com')
      .setAudience(WEB)
      .setSubject('1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(other.privateKey)
    expect(await failureOf(verify(token))).toBe('invalid_token')
    expect(calls).toHaveLength(1)
  })

  test('unknown key ids do not make the server ask Google again: one request for many tokens', async () => {
    const other = await keys('a-key-google-never-had')
    const calls = stubKeys()
    const verifyIdToken = createGoogleProvider().verifyIdToken
    for (let index = 0; index < 25; index++) {
      const token = await new SignJWT({ nonce: NONCE })
        .setProtectedHeader({ alg: 'RS256', kid: `made-up-${index}` })
        .setIssuer('https://accounts.google.com')
        .setAudience(WEB)
        .setSubject('1')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(other.privateKey)
      expect(
        await failureOf(
          verifyIdToken?.(credentials, { idToken: token, audiences: AUDIENCES, nonce: NONCE }) ??
            Promise.resolve()
        )
      ).toBe('invalid_token')
    }
    // `jose` fetched the set for the first and is inside its cooldown for the rest.
    expect(calls).toHaveLength(1)
  })

  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const claims = () => {
    const now = Math.floor(Date.now() / 1000)
    return part({
      iss: 'https://accounts.google.com',
      aud: WEB,
      sub: '1',
      nonce: NONCE,
      iat: now,
      exp: now + 300,
    })
  }
  test.each<[string, () => string | Promise<string>]>([
    ['not a token at all', () => 'not-a-jwt'],
    ['an empty string', () => ''],
    ['two parts', () => `${part({ alg: 'RS256', kid: 'google-key' })}.${claims()}`],
    ['four parts', () => `${part({ alg: 'RS256', kid: 'google-key' })}.${claims()}.AAAA.AAAA`],
    ['a header that is not base64url JSON', () => `!!!.${claims()}.AAAA`],
    ['a header that is a JSON list', () => `${part(['RS256'])}.${claims()}.AAAA`],
    ['no alg', () => `${part({ kid: 'google-key' })}.${claims()}.AAAA`],
    ['alg none', () => `${part({ alg: 'none', kid: 'google-key' })}.${claims()}.`],
    ['a symmetric alg', () => `${part({ alg: 'HS256', kid: 'google-key' })}.${claims()}.AAAA`],
    [
      'another asymmetric alg',
      () => `${part({ alg: 'ES256', kid: 'google-key' })}.${claims()}.AAAA`,
    ],
    ['no kid', () => `${part({ alg: 'RS256' })}.${claims()}.AAAA`],
    ['an empty kid', () => `${part({ alg: 'RS256', kid: '' })}.${claims()}.AAAA`],
    ['a kid that is not a string', () => `${part({ alg: 'RS256', kid: 7 })}.${claims()}.AAAA`],
    [
      'a critical header nobody knows',
      () => `${part({ alg: 'RS256', kid: 'google-key', crit: ['x'], x: 1 })}.${claims()}.AAAA`,
    ],
  ])('refused without asking for the keys, also while they are down: %s', async (_name, make) => {
    // The keys are down: were they asked for, the answer would be `unavailable`, and a caller
    // could tell the two apart only by what Google's endpoint does, never by this server.
    const calls = stubKeys(() => new Response('upstream error', { status: 503 }))
    expect(await failureOf(verify(await make()))).toBe('invalid_token')
    expect(calls).toEqual([])
  })

  test('a token without a key id is refused where the key set has one key too', async () => {
    // `jose` would try the set's only key for a token that names none. Google always names
    // one, so the native path refuses before it looks.
    const calls = stubKeys()
    const token = await new SignJWT({ nonce: NONCE, email_verified: true })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('https://accounts.google.com')
      .setAudience(WEB)
      .setSubject('1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(google.privateKey)
    expect(await failureOf(verify(token))).toBe('invalid_token')
    expect(calls).toEqual([])
  })

  test('the keys are asked for once while one request for them is under way', async () => {
    let release: (response: Response) => void = () => {}
    const calls = stubKeys(() => new Promise<Response>((resolve) => (release = resolve)))
    const verifyIdToken = createGoogleProvider().verifyIdToken
    const token = await idToken()
    const ask = () =>
      failureOf(
        verifyIdToken?.(credentials, { idToken: token, audiences: AUDIENCES, nonce: NONCE }) ??
          Promise.resolve()
      )
    const pending = [ask(), ask(), ask()]
    await new Promise((resolve) => setTimeout(resolve, 10))
    release(new Response('upstream error', { status: 503 }))
    expect(await Promise.all(pending)).toEqual(['unavailable', 'unavailable', 'unavailable'])
    expect(calls).toHaveLength(1)
  })

  test('nothing of the token is in the error', async () => {
    stubKeys()
    const token = await idToken({ audience: STRANGER })
    try {
      await verify(token)
      throw new Error('accepted')
    } catch (error) {
      const text = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack ?? ''}`
      expect(text).not.toContain(token)
      expect(text).not.toContain('maya@northline.app')
      expect(text).not.toContain(STRANGER)
    }
  })
})

function sha256(value: string): string {
  return new Bun.CryptoHasher('sha256').update(value).digest('hex')
}

describe('nativeIdTokenProfile', () => {
  const claims = { aud: WEB, sub: 'subject-1', nonce: NONCE }
  const expected = { audiences: AUDIENCES, nonce: NONCE }

  test('accepts one accepted audience, an accepted azp and the nonce', () => {
    expect(nativeIdTokenProfile({ ...claims, azp: IOS }, expected).subject).toBe('subject-1')
  })

  test.each<[string, Record<string, unknown>]>([
    ['no aud', { aud: undefined }],
    ['an empty aud', { aud: '' }],
    ['another aud', { aud: STRANGER }],
    ['a list as aud', { aud: [WEB] }],
    ['another azp', { azp: STRANGER }],
    ['a null azp', { azp: null }],
    ['no nonce', { nonce: undefined }],
    ['a longer nonce', { nonce: `${NONCE}x` }],
  ])('refuses %s', (_name, change) => {
    expect(() => nativeIdTokenProfile({ ...claims, ...change }, expected)).toThrow(
      new OAuthProviderError('invalid_token')
    )
  })

  test('an empty string among the accepted audiences accepts no empty aud', () => {
    expect(() =>
      nativeIdTokenProfile({ ...claims, aud: '' }, { audiences: [''], nonce: NONCE })
    ).toThrow(new OAuthProviderError('invalid_token'))
  })
})

describe('the mock provider’s ID tokens', () => {
  const clock = new FixedClock(new Date('2026-03-01T12:00:00Z'))
  const secretBox = createSecretBox(TEST_MASTER_KEY)
  const deps = { secretBox, clock, publicUrl: 'http://localhost:3003' }
  const mock = createMockProvider('google', deps)
  const claims: MockIdTokenClaims = {
    aud: WEB,
    azp: ANDROID,
    sub: 'mock-subject',
    nonce: NONCE,
    email: 'maya@northline.app',
    email_verified: true,
  }
  const mint = (
    change: Partial<MockIdTokenClaims> = {},
    options: { expired?: boolean; provider?: 'google' | 'apple' } = {}
  ) =>
    issueMockIdToken(
      secretBox,
      clock,
      options.provider ?? 'google',
      { ...claims, ...change },
      options
    )
  const check = (token: string, nonce = NONCE) =>
    mock.verifyIdToken?.(credentials, { idToken: token, audiences: AUDIENCES, nonce }) ??
    Promise.reject(new Error('the mock has no verifyIdToken'))

  test('one it minted, for an accepted audience and the nonce, is the profile', async () => {
    expect(await check(await mint())).toMatchObject({
      subject: 'mock-subject',
      email: 'maya@northline.app',
      emailVerified: true,
    })
  })

  test.each<[string, Partial<MockIdTokenClaims>]>([
    ['another app’s audience', { aud: STRANGER }],
    ['another app as azp', { azp: STRANGER }],
    ['another nonce', { nonce: 'another' }],
    ['no nonce', { nonce: undefined }],
  ])('refuses %s', async (_name, change) => {
    expect(await failureOf(check(await mint(change)))).toBe('invalid_token')
  })

  test('refuses an expired one, at the instant it expires and not before', async () => {
    expect(await failureOf(check(await mint({}, { expired: true })))).toBe('invalid_token')
    const local = new FixedClock(new Date('2026-03-01T12:00:00Z'))
    const provider = createMockProvider('google', { ...deps, clock: local })
    const token = await issueMockIdToken(secretBox, local, 'google', claims)
    const ask = () =>
      provider.verifyIdToken?.(credentials, { idToken: token, audiences: AUDIENCES, nonce: NONCE })
    local.advance(MOCK_ID_TOKEN_TTL_MS - 1000)
    expect(await failureOf(Promise.resolve(ask()))).toBe('resolved')
    local.advance(1000)
    expect(await failureOf(Promise.resolve(ask()))).toBe('invalid_token')
  })

  test('refuses a token minted for another provider, a tampered one and garbage', async () => {
    expect(await failureOf(check(await mint({}, { provider: 'apple' })))).toBe('invalid_token')
    const token = await mint()
    expect(await failureOf(check(`${token.slice(0, -2)}AA`))).toBe('invalid_token')
    expect(await failureOf(check('garbage'))).toBe('invalid_token')
  })

  test('refuses one sealed under another deployment’s key', async () => {
    const other = createSecretBox('b'.repeat(TEST_MASTER_KEY.length))
    const token = await issueMockIdToken(other, clock, 'google', claims)
    expect(await failureOf(check(token))).toBe('invalid_token')
  })

  test('only a provider that has the exchange has the method', () => {
    for (const provider of [
      'github',
      'apple',
      'microsoft',
      'discord',
      'linkedin',
      'x',
      'facebook',
    ] as const) {
      expect(createMockProvider(provider, deps).verifyIdToken).toBeUndefined()
    }
  })
})
