import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose'
import { FixedClock } from '~/adapters/memory/clock'
import {
  appleNativeIdTokenProfile,
  appleNonceClaim,
  createAppleProvider,
} from '~/adapters/oauth/apple'
import { createMockProvider, issueMockIdToken, type MockIdTokenClaims } from '~/adapters/oauth/mock'
import { sha256Hex } from '~/lib/crypto'
import { createSecretBox } from '~/lib/secret-box'
import { type OAuthFailure, OAuthProviderError } from '~/ports/oauth-provider'
import { TEST_MASTER_KEY } from '~/testing'

// The identity token an iOS app hands over (ADR 0047), as the Apple adapter and the mock
// judge it. Every token here is signed by a key this file makes; `fetch` is a stub and
// nothing reaches Apple. Nothing here was observed from a device.

const APPLE_KEYS = 'https://appleid.apple.com/auth/keys'
const BUNDLE = 'app.northline.ios'
const OTHER_BUNDLE = 'app.northline.ios.clip'
const SERVICES_ID = 'app.northline.web'
const STRANGER = 'com.someone.else'
const AUDIENCES = [BUNDLE, OTHER_BUNDLE]
const NONCE = 'k3o8m1c0Yb7mYt3yYq0d6m3kq2H4t0mVQeT5n0Xb1aA'
const HASHED = sha256Hex(NONCE)
const SUBJECT = '001234.5c3f0a1b2d3e4f5a6b7c8d9e0f1a2b3c.0412'
// What the web flow uses. A native token involves none of it, and the adapter reads none.
const credentials = { clientId: SERVICES_ID, teamId: 'A1B2C3D4E5', keyId: 'KEY1234567' }

type Keys = { privateKey: CryptoKey; jwk: JWK }
let apple: Keys
let stranger: Keys

async function keys(kid: string, alg = 'RS256'): Promise<Keys> {
  const pair = await generateKeyPair(alg, { extractable: true })
  return {
    privateKey: pair.privateKey,
    jwk: { ...(await exportJWK(pair.publicKey)), kid, alg, use: 'sig' },
  }
}

beforeAll(async () => {
  apple = await keys('apple-key')
  stranger = await keys('apple-key')
})

let fetchSpy: ReturnType<typeof spyOn> | undefined
afterEach(() => {
  fetchSpy?.mockRestore()
  fetchSpy = undefined
})

/** Serve Apple's key set and fail the test for any other request. */
function stubKeys(
  answer: () => Response | Promise<Response> = () => Response.json({ keys: [apple.jwk] })
) {
  const calls: string[] = []
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (
    input: string | URL | Request
  ) => {
    const url = input instanceof Request ? input.url : String(input)
    calls.push(url)
    if (url !== APPLE_KEYS) {
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
  /** The `nonce` claim as it is in the token. `null`: none. Default: the hash an app passes. */
  nonce?: string | null
  expiresIn?: string | number
  key?: Keys
  alg?: string
  kid?: string | null
  claims?: Record<string, unknown>
}

/** A token in the shape Apple documents: string booleans, `nonce_supported`, no name. */
function idToken(options: TokenOptions = {}): Promise<string> {
  const jwt = new SignJWT({
    email: 'maya@northline.app',
    email_verified: 'true',
    is_private_email: 'false',
    nonce_supported: true,
    ...(options.nonce !== null && { nonce: options.nonce ?? HASHED }),
    ...options.claims,
  })
    .setProtectedHeader({
      alg: options.alg ?? 'RS256',
      ...(options.kid !== null && { kid: options.kid ?? 'apple-key' }),
    })
    .setIssuer(options.issuer ?? 'https://appleid.apple.com')
    .setAudience(options.audience ?? BUNDLE)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '5m')
  if (options.subject !== null) {
    jwt.setSubject(options.subject ?? SUBJECT)
  }
  return jwt.sign((options.key ?? apple).privateKey)
}

async function failureOf(promise: Promise<unknown>): Promise<OAuthFailure | string> {
  try {
    await promise
    return 'resolved'
  } catch (error) {
    return error instanceof OAuthProviderError ? error.failure : `threw ${String(error)}`
  }
}

function verify(
  token: string,
  expected: {
    audiences?: readonly string[]
    nonce?: string
    user?: { givenName?: string; familyName?: string }
  } = {}
) {
  const verifyIdToken = createAppleProvider().verifyIdToken
  if (!verifyIdToken) {
    throw new Error('the Apple adapter has no verifyIdToken')
  }
  return verifyIdToken(credentials, {
    idToken: token,
    audiences: expected.audiences ?? AUDIENCES,
    nonce: expected.nonce ?? NONCE,
    ...(expected.user && { user: expected.user }),
  })
}

describe('the nonce an Apple token must carry', () => {
  test('is the lowercase hexadecimal SHA-256 of the attempt’s nonce', () => {
    // RFC 6234's vector, so that the encoding is pinned by something this file did not compute.
    expect(appleNonceClaim('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
    expect(appleNonceClaim(NONCE)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('an Apple ID token from a native app', () => {
  test('a first authorization: the bundle id as aud, the hashed nonce, the address', async () => {
    const calls = stubKeys()
    const profile = await verify(await idToken())
    expect(profile).toEqual({
      subject: SUBJECT,
      email: 'maya@northline.app',
      emailVerified: true,
    })
    // The keys, and nothing else: no token endpoint, no client secret, no revocation.
    expect(calls).toEqual([APPLE_KEYS])
  })

  test('any registered app’s bundle id is an audience', async () => {
    stubKeys()
    expect((await verify(await idToken({ audience: OTHER_BUNDLE }))).subject).toBe(SUBJECT)
  })

  test.each<[string, unknown, boolean]>([
    ['the string "true"', 'true', true],
    ['the boolean true', true, true],
    ['the string "false"', 'false', false],
    ['the boolean false', false, false],
    ['nothing', undefined, false],
    ['the number 1', 1, false],
    ['the string "TRUE"', 'TRUE', false],
  ])('email_verified as %s', async (_name, claim, verified) => {
    stubKeys()
    const profile = await verify(await idToken({ claims: { email_verified: claim } }))
    expect(profile.emailVerified).toBe(verified)
  })

  test('a private relay address is an address like any other', async () => {
    stubKeys()
    const profile = await verify(
      await idToken({
        claims: { email: 'x7k2m9@privaterelay.appleid.com', is_private_email: 'true' },
      })
    )
    expect(profile).toEqual({
      subject: SUBJECT,
      email: 'x7k2m9@privaterelay.appleid.com',
      emailVerified: true,
    })
  })

  test('a token with no address has none, and is not verified', async () => {
    stubKeys()
    const profile = await verify(
      await idToken({ claims: { email: undefined, email_verified: undefined } })
    )
    expect(profile).toEqual({ subject: SUBJECT, email: null, emailVerified: false })
  })

  test('the name is what the app passed on, cleaned, and never the token’s', async () => {
    stubKeys()
    const profile = await verify(
      await idToken({ claims: { given_name: 'Token', family_name: 'Claim' } }),
      { user: { givenName: '  Maya\u0000 ', familyName: 'Okafor' } }
    )
    expect(profile.givenName).toBe('Maya')
    expect(profile.familyName).toBe('Okafor')
    stubKeys()
    const unnamed = await verify(
      await idToken({ claims: { given_name: 'Token', family_name: 'Claim' } })
    )
    expect(unnamed).toEqual({ subject: SUBJECT, email: 'maya@northline.app', emailVerified: true })
  })

  test('what the app passed on is a name and nothing else', async () => {
    stubKeys()
    const profile = await verify(await idToken({ claims: { email: undefined } }), {
      user: {
        givenName: 'Maya',
        email: 'victim@northline.app',
        sub: 'someone-else',
      } as never,
    })
    expect(profile).toEqual({
      subject: SUBJECT,
      email: null,
      emailVerified: false,
      givenName: 'Maya',
    })
  })

  test.each<[string, TokenOptions]>([
    ['the nonce itself, not its hash', { nonce: NONCE }],
    ['the hash in upper case', { nonce: HASHED.toUpperCase() }],
    ['the hash in base64url', { nonce: Buffer.from(HASHED, 'hex').toString('base64url') }],
    ['the hash of the hash', { nonce: sha256Hex(HASHED) }],
    ['another attempt’s hashed nonce', { nonce: sha256Hex('another-attempt') }],
    ['no nonce', { nonce: null }],
    ['an empty nonce', { nonce: '' }],
    ['a nonce that is not a string', { claims: { nonce: 7 } }],
    ['nonce_supported false, with the right nonce', { claims: { nonce_supported: false } }],
    ['nonce_supported "false", with the right nonce', { claims: { nonce_supported: 'false' } }],
    ['nonce_supported false and no nonce', { nonce: null, claims: { nonce_supported: false } }],
    ['another app’s bundle id', { audience: STRANGER }],
    ['the Services ID of the web flow', { audience: SERVICES_ID }],
    ['a bundle id that only starts like ours', { audience: `${BUNDLE}.evil` }],
    ['our bundle id among several audiences', { audience: [BUNDLE, STRANGER] }],
    ['our bundle id with the team in front', { audience: `A1B2C3D4E5.${BUNDLE}` }],
    ['an azp that is not a registered app', { claims: { azp: STRANGER } }],
    ['another issuer', { issuer: 'https://appleid.apple.com.evil.test' }],
    ['Google’s issuer', { issuer: 'https://accounts.google.com' }],
    ['the issuer without its scheme', { issuer: 'appleid.apple.com' }],
    ['expired', { expiresIn: Math.floor(Date.now() / 1000) - 3600 }],
  ])('refused: %s', async (_name, options) => {
    stubKeys()
    expect(await failureOf(verify(await idToken(options)))).toBe('invalid_token')
  })

  test('nonce_supported left out is no refusal: the nonce itself is what is checked', async () => {
    stubKeys()
    const profile = await verify(await idToken({ claims: { nonce_supported: undefined } }))
    expect(profile.subject).toBe(SUBJECT)
  })

  test('refused: no registered iOS app means no audience, whatever the token says', async () => {
    stubKeys()
    expect(await failureOf(verify(await idToken(), { audiences: [] }))).toBe('invalid_token')
  })

  test('refused: an attempt with no nonce never matches, not even the hash of nothing', async () => {
    const calls = stubKeys()
    expect(await failureOf(verify(await idToken({ nonce: sha256Hex('') }), { nonce: '' }))).toBe(
      'invalid_token'
    )
    expect(calls).toEqual([])
  })

  test('refused: signed by a key that is not Apple’s', async () => {
    stubKeys()
    expect(await failureOf(verify(await idToken({ key: stranger })))).toBe('invalid_token')
  })

  test('refused: an unsigned token (alg none), whatever it claims', async () => {
    const calls = stubKeys()
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const now = Math.floor(Date.now() / 1000)
    const unsigned = `${encode({ alg: 'none', kid: 'apple-key' })}.${encode({
      iss: 'https://appleid.apple.com',
      aud: BUNDLE,
      sub: SUBJECT,
      nonce: HASHED,
      iat: now,
      exp: now + 300,
    })}.`
    expect(await failureOf(verify(unsigned))).toBe('invalid_token')
    expect(calls).toEqual([])
  })

  test('refused: an algorithm the token names and the adapter does not pin', async () => {
    const calls = stubKeys()
    const es256 = await keys('apple-key', 'ES256')
    expect(await failureOf(verify(await idToken({ key: es256, alg: 'ES256' })))).toBe(
      'invalid_token'
    )
    // Refused on the header alone: Apple is not asked.
    expect(calls).toEqual([])
  })

  test('refused: a token that names no key, before Apple is asked', async () => {
    const calls = stubKeys()
    expect(await failureOf(verify(await idToken({ kid: null })))).toBe('invalid_token')
    expect(calls).toEqual([])
  })

  test('refused: not a token at all', async () => {
    const calls = stubKeys()
    expect(await failureOf(verify('not-a-token'))).toBe('invalid_token')
    expect(calls).toEqual([])
  })

  test('a token with no subject is invalid_profile', async () => {
    stubKeys()
    expect(await failureOf(verify(await idToken({ subject: null })))).toBe('invalid_token')
    stubKeys()
    expect(await failureOf(verify(await idToken({ subject: '' })))).toBe('invalid_profile')
  })

  test.each<[string, () => Response | Promise<Response>]>([
    ['a 500', () => new Response('down', { status: 500 })],
    ['a 404', () => new Response('nothing here', { status: 404 })],
    ['a redirect', () => new Response(null, { status: 302, headers: { location: 'https://x' } })],
    ['a page where the keys should be', () => new Response('<html>', { status: 200 })],
    ['JSON that is no key set', () => Response.json({ hello: 'world' })],
    [
      'a request that fails',
      () => {
        throw new TypeError('connection refused')
      },
    ],
  ])('keys that could not be had (%s) are unavailable, not a bad token', async (_name, answer) => {
    stubKeys(answer)
    expect(await failureOf(verify(await idToken()))).toBe('unavailable')
  })

  test('keys that do not arrive in time are unavailable', async () => {
    stubKeys(() => new Promise<Response>(() => undefined))
    const verifyIdToken = createAppleProvider({ timeoutMs: 20 }).verifyIdToken
    expect(
      await failureOf(
        verifyIdToken?.(credentials, {
          idToken: await idToken(),
          audiences: AUDIENCES,
          nonce: NONCE,
        }) ?? Promise.resolve()
      )
    ).toBe('unavailable')
  })

  test('a key id the fetched key set does not have is a bad token, not missing keys', async () => {
    stubKeys()
    expect(await failureOf(verify(await idToken({ kid: 'a-key-apple-never-had' })))).toBe(
      'invalid_token'
    )
  })

  test('nothing of the token, the nonce or the name is in the error', async () => {
    stubKeys()
    const token = await idToken({ audience: STRANGER })
    try {
      await verify(token, { user: { givenName: 'Maya' } })
      throw new Error('accepted')
    } catch (error) {
      const said = `${String(error)} ${JSON.stringify(error)}`
      expect(said).not.toContain(token)
      expect(said).not.toContain(HASHED)
      expect(said).not.toContain(NONCE)
      expect(said).not.toContain(STRANGER)
      expect(said).not.toContain('Maya')
      expect(said).not.toContain('northline')
    }
  })

  test('the web flow’s audience is still the Services ID, and its nonce is not hashed', async () => {
    // The code flow is not changed by the native path: this is its verifier's own contract,
    // asked through the adapter with a stubbed code exchange.
    stubKeys()
    const provider = createAppleProvider()
    const url = new URL(
      provider.authorizationUrl(
        { ...credentials, privateKey: await pkcs8() },
        { state: 's', codeVerifier: 'v', nonce: NONCE, redirectUri: 'https://api.test/cb' }
      )
    )
    expect(url.searchParams.get('client_id')).toBe(SERVICES_ID)
    expect(url.searchParams.get('nonce')).toBe(NONCE)
  })
})

async function pkcs8(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString(
    'base64'
  )
  return `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)?.join('\n')}\n-----END PRIVATE KEY-----`
}

describe('appleNativeIdTokenProfile', () => {
  const good = { aud: BUNDLE, sub: SUBJECT, nonce: HASHED }
  const expected = { audiences: AUDIENCES, nonce: NONCE }

  test('accepts a registered bundle id and the hashed nonce', () => {
    expect(appleNativeIdTokenProfile(good, expected)).toEqual({
      subject: SUBJECT,
      email: null,
      emailVerified: false,
    })
  })

  test.each<[string, Record<string, unknown>]>([
    ['the raw nonce', { nonce: NONCE }],
    ['no nonce', { nonce: undefined }],
    ['nonce_supported false', { nonce_supported: false }],
    ['another audience', { aud: STRANGER }],
    ['a list of audiences', { aud: [BUNDLE] }],
    ['no audience', { aud: undefined }],
  ])('refuses %s', (_name, change) => {
    expect(() => appleNativeIdTokenProfile({ ...good, ...change }, expected)).toThrow(
      new OAuthProviderError('invalid_token')
    )
  })

  test('refuses every token for an attempt without a nonce', () => {
    for (const nonce of ['', undefined as unknown as string]) {
      expect(() =>
        appleNativeIdTokenProfile(
          { ...good, nonce: sha256Hex('') },
          { audiences: AUDIENCES, nonce }
        )
      ).toThrow(new OAuthProviderError('invalid_token'))
    }
  })
})

describe('the mock provider’s Apple ID tokens', () => {
  const clock = new FixedClock(new Date('2026-03-01T12:00:00Z'))
  const secretBox = createSecretBox(TEST_MASTER_KEY)
  const deps = { secretBox, clock, publicUrl: 'http://localhost:3003' }
  const mock = createMockProvider('apple', deps)
  const claims: MockIdTokenClaims = {
    aud: BUNDLE,
    sub: SUBJECT,
    nonce: HASHED,
    nonce_supported: true,
    email: 'maya@northline.app',
    email_verified: 'true',
    is_private_email: 'false',
  }
  const mint = (
    change: Partial<MockIdTokenClaims> = {},
    options: { expired?: boolean; provider?: 'google' | 'apple' } = {}
  ) =>
    issueMockIdToken(
      secretBox,
      clock,
      options.provider ?? 'apple',
      { ...claims, ...change },
      options
    )
  const check = (token: string, user?: { givenName?: string; familyName?: string }) =>
    mock.verifyIdToken?.(credentials, {
      idToken: token,
      audiences: AUDIENCES,
      nonce: NONCE,
      ...(user && { user }),
    }) ?? Promise.reject(new Error('the mock has no verifyIdToken'))

  test('one it minted is held to Apple’s rule: the hashed nonce, the string boolean, the passed name', async () => {
    expect(await check(await mint(), { givenName: 'Maya', familyName: 'Okafor' })).toEqual({
      subject: SUBJECT,
      email: 'maya@northline.app',
      emailVerified: true,
      givenName: 'Maya',
      familyName: 'Okafor',
    })
  })

  test.each<[string, Partial<MockIdTokenClaims>]>([
    ['the raw nonce', { nonce: NONCE }],
    ['another nonce', { nonce: sha256Hex('another') }],
    ['no nonce', { nonce: undefined }],
    ['nonce_supported false', { nonce_supported: false }],
    ['another app’s bundle id', { aud: STRANGER }],
    ['the Services ID', { aud: SERVICES_ID }],
  ])('refuses %s', async (_name, change) => {
    expect(await failureOf(check(await mint(change)))).toBe('invalid_token')
  })

  test('refuses an expired one, and one minted for Google', async () => {
    expect(await failureOf(check(await mint({}, { expired: true })))).toBe('invalid_token')
    expect(await failureOf(check(await mint({}, { provider: 'google' })))).toBe('invalid_token')
  })

  test('Google’s mock still wants the nonce as it was issued', async () => {
    const google = createMockProvider('google', deps)
    const token = await mint({ nonce: HASHED }, { provider: 'google' })
    const ask = (nonce: string) =>
      google.verifyIdToken?.(credentials, { idToken: token, audiences: AUDIENCES, nonce }) ??
      Promise.reject(new Error('no verifyIdToken'))
    expect(await failureOf(ask(NONCE))).toBe('invalid_token')
    expect(await failureOf(ask(HASHED))).toBe('resolved')
  })
})
