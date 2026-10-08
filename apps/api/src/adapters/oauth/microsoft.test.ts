import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose'
import { s256 } from '~/adapters/oauth/mock'
import { type OAuthFailure, OAuthProviderError } from '~/ports/oauth-provider'
import {
  createMicrosoftProvider,
  MICROSOFT_CONSUMER_TENANT_ID,
  microsoftSubject,
  tenantAccepts,
} from './microsoft'

const REDIRECT_URI = 'https://auth.northline.app/v1/oauth/callback/microsoft'
const CLIENT_ID = '6731de76-14a6-49ae-97bc-6eba6914391e'
const NONCE = 'nonce-of-this-attempt'
/** An organization's tenant, another one, and an account in the first. */
const CONTOSO = 'aaaabbbb-0000-cccc-1111-dddd2222eeee'
const FABRIKAM = 'bbbbcccc-1111-dddd-2222-eeee3333ffff'
const OBJECT_ID = '00aa11bb-22cc-33dd-44ee-55ff66aa77bb'
/** The key documents' own words for "any tenant" and for the personal-account tenant. */
const ANY_TENANT = 'https://login.microsoftonline.com/{tenantid}/v2.0'
const issuerOf = (tenantId: string) => `https://login.microsoftonline.com/${tenantId}/v2.0`

const exchangeInput = {
  code: 'the-code',
  codeVerifier: 'the-verifier',
  nonce: NONCE,
  redirectUri: REDIRECT_URI,
}

type Keys = { privateKey: CryptoKey; jwk: JWK; kid: string }
let organizations: Keys
let consumers: Keys
let stranger: Keys

async function keys(kid: string, issuer?: string): Promise<Keys> {
  const pair = await generateKeyPair('RS256', { extractable: true })
  return {
    kid,
    privateKey: pair.privateKey,
    jwk: {
      ...(await exportJWK(pair.publicKey)),
      kid,
      alg: 'RS256',
      use: 'sig',
      ...(issuer !== undefined && { issuer }),
    },
  }
}

beforeAll(async () => {
  organizations = await keys('org-key', ANY_TENANT)
  consumers = await keys('msa-key', issuerOf(MICROSOFT_CONSUMER_TENANT_ID))
  stranger = await keys('org-key', ANY_TENANT)
})

let fetchSpy: ReturnType<typeof spyOn> | undefined
afterEach(() => {
  fetchSpy?.mockRestore()
  fetchSpy = undefined
})

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

interface TokenOptions {
  tenantId?: string | null
  objectId?: unknown
  subject?: string
  issuer?: string
  audience?: string
  nonce?: string | null
  expiresIn?: string
  key?: Keys
  alg?: string
  claims?: Record<string, unknown>
}

function idToken(options: TokenOptions = {}): Promise<string> {
  const tenantId = options.tenantId === undefined ? CONTOSO : options.tenantId
  const key = options.key ?? organizations
  return new SignJWT({
    ver: '2.0',
    email: 'maya@northline.app',
    ...(tenantId !== null && { tid: tenantId }),
    oid: OBJECT_ID,
    ...('objectId' in options && { oid: options.objectId }),
    ...(options.nonce !== null && { nonce: options.nonce ?? NONCE }),
    ...options.claims,
  })
    .setProtectedHeader({ alg: options.alg ?? 'RS256', kid: key.kid })
    .setIssuer(options.issuer ?? issuerOf(tenantId ?? CONTOSO))
    .setAudience(options.audience ?? CLIENT_ID)
    .setSubject(options.subject ?? 'pairwise-sub-of-this-app-registration')
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '5m')
    .sign(key.privateKey)
}

interface Call {
  url: string
  body: string
  headers: Headers
}

/**
 * Stand in for Microsoft: the token endpoint and the key document of one authority. A request
 * to any other address fails the test, which is how "the keys of the configured authority" is
 * held.
 */
function microsoft(
  tenant: string,
  token: string | Promise<string>,
  published: Keys[] = [organizations, consumers]
) {
  const calls: Call[] = []
  const routes: Record<string, () => Response | Promise<Response>> = {
    [`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`]: async () =>
      jsonResponse({
        access_token: 'EwB.microsoft-access-token',
        token_type: 'Bearer',
        expires_in: 3600,
        id_token: await token,
      }),
    [`https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`]: () =>
      jsonResponse({ keys: published.map((key) => key.jwk) }),
  }
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url = input instanceof Request ? input.url : String(input)
    calls.push({
      url,
      body: input instanceof Request ? await input.clone().text() : '',
      headers: input instanceof Request ? input.headers : new Headers(init?.headers),
    })
    const route = routes[url]
    if (!route) {
      throw new Error(`unexpected request to ${url}`)
    }
    return route()
  }) as typeof fetch)
  return {
    calls,
    exchange: () =>
      createMicrosoftProvider().exchange(
        { clientId: CLIENT_ID, clientSecret: 'microsoft-secret', tenant },
        exchangeInput
      ),
  }
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
  test.each(['common', 'organizations', 'consumers', CONTOSO])(
    'for the tenant %s: its authority, the S256 challenge, the nonce, three scopes',
    (tenant) => {
      const url = new URL(
        createMicrosoftProvider().authorizationUrl(
          { clientId: CLIENT_ID, clientSecret: 'microsoft-secret', tenant },
          {
            state: 'the-state',
            codeVerifier: 'the-verifier',
            nonce: NONCE,
            redirectUri: REDIRECT_URI,
          }
        )
      )
      expect(url.origin + url.pathname).toBe(
        `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`
      )
      expect(Object.fromEntries(url.searchParams)).toEqual({
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        state: 'the-state',
        code_challenge_method: 'S256',
        code_challenge: s256('the-verifier'),
        scope: 'openid profile email',
        nonce: NONCE,
      })
      expect(url.toString()).not.toContain('the-verifier')
      expect(url.toString()).not.toContain('microsoft-secret')
    }
  )

  test.each([
    ['no tenant', undefined],
    ['a domain name', 'contoso.onmicrosoft.com'],
    ['a path', 'common/../evil'],
    ['an empty value', ''],
  ])('is not built for %s', (_name, tenant) => {
    expect(() =>
      createMicrosoftProvider().authorizationUrl(
        { clientId: CLIENT_ID, clientSecret: 's', tenant },
        { state: 's', codeVerifier: 'v', nonce: NONCE, redirectUri: REDIRECT_URI }
      )
    ).toThrow(OAuthProviderError)
  })
})

describe('the exchange', () => {
  test('sends the code with the PKCE verifier and the client’s credentials, to the configured authority', async () => {
    const { calls, exchange } = microsoft('common', idToken())
    await exchange()
    const body = new URLSearchParams(calls[0]?.body)
    expect(calls[0]?.url).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token')
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: REDIRECT_URI,
      code_verifier: 'the-verifier',
    })
    expect(calls[0]?.headers.get('authorization')).toBe(
      `Basic ${Buffer.from(`${CLIENT_ID}:microsoft-secret`).toString('base64')}`
    )
    expect(calls.map((call) => call.url)).toEqual([
      'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      'https://login.microsoftonline.com/common/discovery/v2.0/keys',
    ])
  })

  test('the account is the tenant id and the object id, never sub or an address', async () => {
    const { exchange } = microsoft(
      'common',
      idToken({
        claims: {
          preferred_username: 'someone.else@contoso.example',
          upn: 'upn@contoso.example',
          given_name: ' Maya ',
          family_name: 'Okafor',
        },
      })
    )
    expect(await exchange()).toEqual({
      subject: `${CONTOSO}:${OBJECT_ID}`,
      email: 'maya@northline.app',
      emailVerified: false,
      givenName: 'Maya',
      familyName: 'Okafor',
    })
  })

  test('upper-case ids in a token are the same account as lower-case ones', async () => {
    const tenantId = CONTOSO.toUpperCase()
    const { exchange } = microsoft(
      'common',
      idToken({ tenantId, objectId: OBJECT_ID.toUpperCase() })
    )
    expect((await exchange()).subject).toBe(`${CONTOSO}:${OBJECT_ID}`)
  })

  test('the same object id in another tenant is another account', async () => {
    const first = await microsoft('common', idToken()).exchange()
    fetchSpy?.mockRestore()
    const second = await microsoft('common', idToken({ tenantId: FABRIKAM })).exchange()
    expect(second.subject).toBe(`${FABRIKAM}:${OBJECT_ID}`)
    expect(second.subject).not.toBe(first.subject)
  })
})

describe('whether the address is verified', () => {
  // The rule: verified only with the verified-domain claim, the boolean true, and an address.
  test.each([
    ['xms_edov: true', { xms_edov: true }, true],
    ['no xms_edov', {}, false],
    ['xms_edov: false', { xms_edov: false }, false],
    ['xms_edov: "true" (a string)', { xms_edov: 'true' }, false],
    ['xms_edov: 1', { xms_edov: 1 }, false],
    ['xms_edov: "1"', { xms_edov: '1' }, false],
    ['email_verified: true and no xms_edov', { email_verified: true }, false],
    [
      'verified_primary_email and no xms_edov',
      { verified_primary_email: ['maya@northline.app'] },
      false,
    ],
  ] as [string, Record<string, unknown>, boolean][])(
    '%s → emailVerified %p',
    async (_name, claims, expected) => {
      const { exchange } = microsoft('common', idToken({ claims }))
      expect(await exchange()).toMatchObject({
        email: 'maya@northline.app',
        emailVerified: expected,
      })
    }
  )

  test('a personal account without the claim is unverified too', async () => {
    const { exchange } = microsoft(
      'consumers',
      idToken({ tenantId: MICROSOFT_CONSUMER_TENANT_ID, key: consumers })
    )
    expect(await exchange()).toMatchObject({
      subject: `${MICROSOFT_CONSUMER_TENANT_ID}:${OBJECT_ID}`,
      emailVerified: false,
    })
  })

  test.each([
    ['no email claim', { email: undefined }],
    ['an empty email claim', { email: '' }],
    ['an email claim that is not a string', { email: ['maya@northline.app'] }],
  ])('%s: no address, and not verified whatever xms_edov says', async (_name, claims) => {
    const { exchange } = microsoft('common', idToken({ claims: { ...claims, xms_edov: true } }))
    expect(await exchange()).toMatchObject({ email: null, emailVerified: false })
  })

  test('preferred_username and upn are never taken for the address', async () => {
    const { exchange } = microsoft(
      'common',
      idToken({
        claims: {
          email: undefined,
          preferred_username: 'victim@northline.app',
          upn: 'victim@northline.app',
          xms_edov: true,
        },
      })
    )
    expect(await exchange()).toMatchObject({ email: null, emailVerified: false })
  })
})

describe('which tenant may sign in', () => {
  // configured tenant × the token's tenant → accepted
  const table: [string, string, boolean][] = [
    ['common', CONTOSO, true],
    ['common', MICROSOFT_CONSUMER_TENANT_ID, true],
    ['organizations', CONTOSO, true],
    ['organizations', MICROSOFT_CONSUMER_TENANT_ID, false],
    ['consumers', MICROSOFT_CONSUMER_TENANT_ID, true],
    ['consumers', CONTOSO, false],
    [CONTOSO, CONTOSO, true],
    [CONTOSO, FABRIKAM, false],
    [CONTOSO, MICROSOFT_CONSUMER_TENANT_ID, false],
  ]

  test.each(table)('configured %s, token of %s → %p', async (configured, tenantId, accepted) => {
    const key = tenantId === MICROSOFT_CONSUMER_TENANT_ID ? consumers : organizations
    const { exchange } = microsoft(configured, idToken({ tenantId, key }))
    expect(await failureOf(exchange())).toBe(accepted ? 'resolved' : 'invalid_token')
  })

  test.each(table)('tenantAccepts(%s, %s) is %p', (configured, tenantId, accepted) => {
    expect(tenantAccepts(configured, tenantId)).toBe(accepted)
    expect(tenantAccepts(configured, tenantId.toUpperCase())).toBe(accepted)
  })

  test.each([undefined, '', 'contoso.onmicrosoft.com', '*'])(
    'a configured tenant of %p accepts nobody',
    (configured) => {
      expect(tenantAccepts(configured, CONTOSO)).toBe(false)
    }
  )
})

describe('refusals', () => {
  test.each([
    [
      'an issuer of another tenant than the token’s tid',
      () => idToken({ tenantId: CONTOSO, issuer: issuerOf(FABRIKAM) }),
    ],
    ['a v1.0 issuer for the tid', () => idToken({ issuer: `https://sts.windows.net/${CONTOSO}/` })],
    [
      'an issuer on another host',
      () => idToken({ issuer: `https://login.microsoftonline.evil.test/${CONTOSO}/v2.0` }),
    ],
    ['the issuer with a trailing slash', () => idToken({ issuer: `${issuerOf(CONTOSO)}/` })],
    ['the issuer template itself', () => idToken({ issuer: ANY_TENANT })],
    ['no tid', () => idToken({ tenantId: null })],
    ['a tid that is not a GUID', () => idToken({ tenantId: 'contoso.onmicrosoft.com' })],
    ['a tid that is an alias', () => idToken({ tenantId: 'common' })],
    ['a tid in braces', () => idToken({ tenantId: `{${CONTOSO}}` })],
    ['another audience', () => idToken({ audience: 'someone-elses-client' })],
    ['an expired token', () => idToken({ expiresIn: '-5m' })],
    ['another attempt’s nonce', () => idToken({ nonce: 'nonce-of-another-attempt' })],
    ['no nonce', () => idToken({ nonce: null })],
    ['a token signed by another key with the same kid', () => idToken({ key: stranger })],
    [
      'a personal-account key signing for an organization’s tenant',
      () => idToken({ tenantId: CONTOSO, key: consumers }),
    ],
    [
      'an unsigned token',
      async () =>
        [
          Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
          Buffer.from(
            JSON.stringify({
              iss: issuerOf(CONTOSO),
              tid: CONTOSO,
              oid: OBJECT_ID,
              aud: CLIENT_ID,
              sub: 's',
              nonce: NONCE,
              exp: 9_999_999_999,
              iat: 1,
            })
          ).toString('base64url'),
          '',
        ].join('.'),
    ],
    [
      'a token signed with the public key as an HMAC secret',
      async () =>
        new SignJWT({ tid: CONTOSO, oid: OBJECT_ID, nonce: NONCE })
          .setProtectedHeader({ alg: 'HS256', kid: 'org-key' })
          .setIssuer(issuerOf(CONTOSO))
          .setAudience(CLIENT_ID)
          .setSubject('s')
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(new TextEncoder().encode(JSON.stringify(organizations.jwk))),
    ],
    [
      'a tampered payload',
      async () => {
        const [header, , signature] = (await idToken()).split('.')
        const forged = Buffer.from(
          JSON.stringify({
            iss: issuerOf(CONTOSO),
            tid: CONTOSO,
            oid: '99999999-9999-9999-9999-999999999999',
            aud: CLIENT_ID,
            sub: 's',
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
    const { exchange } = microsoft('common', token())
    expect(await failureOf(exchange())).toBe('invalid_token')
  })

  test('refuses a PS256 token: RS256 is the only algorithm', async () => {
    const pair = await generateKeyPair('PS256', { extractable: true })
    const key: Keys = {
      kid: 'ps-key',
      privateKey: pair.privateKey,
      jwk: {
        ...(await exportJWK(pair.publicKey)),
        kid: 'ps-key',
        use: 'sig',
        issuer: ANY_TENANT,
      } as JWK,
    }
    const { exchange } = microsoft('common', idToken({ key, alg: 'PS256' }), [key])
    expect(await failureOf(exchange())).toBe('invalid_token')
  })

  // The exact `iss` rule and the key-scope rule overlap for most forged tokens: each of
  // these rows is refused by one of them alone, so that neither can go unnoticed.
  describe('the issuer rule and the key-scope rule, each alone', () => {
    test('a personal-account key signing its own issuer with another tenant’s tid: only the exact iss rule refuses it', async () => {
      // The key's scope equals the token's `iss`, and `common` accepts any tenant: what is
      // wrong is that `iss` is not the issuer of the `tid` the account would be filed under.
      const token = idToken({
        key: consumers,
        tenantId: CONTOSO,
        issuer: issuerOf(MICROSOFT_CONSUMER_TENANT_ID),
      })
      const { exchange } = microsoft('common', token)
      expect(await failureOf(exchange())).toBe('invalid_token')
    })

    test('a template-scoped key signing tid A under the issuer of B', async () => {
      const token = idToken({ key: organizations, tenantId: CONTOSO, issuer: issuerOf(FABRIKAM) })
      const { exchange } = microsoft('common', token)
      expect(await failureOf(exchange())).toBe('invalid_token')
    })

    test.each([
      ['another tenant’s fixed issuer', issuerOf(FABRIKAM)],
      // A template is not enough: it has to be the template of this issuer.
      ['a template of the v1.0 issuer', 'https://sts.windows.net/{tenantid}/'],
      ['a template on another host', 'https://login.microsoftonline.evil.test/{tenantid}/v2.0'],
      ['a template without the version', 'https://login.microsoftonline.com/{tenantid}'],
      ['only the placeholder', '{tenantid}'],
    ])(
      'a key scoped to %s signing a well-formed token: only the key-scope rule refuses it',
      async (_name, scope) => {
        const scoped = await keys('scoped-key', scope)
        // `iss` is exactly the issuer of the token's own `tid`, and the tenant is accepted.
        const token = idToken({ key: scoped, tenantId: CONTOSO })
        const { exchange } = microsoft('common', token, [scoped])
        expect(await failureOf(exchange())).toBe('invalid_token')
      }
    )

    test('the same token under a key scoped to its issuer, by template or exactly, is accepted', async () => {
      for (const scope of [ANY_TENANT, issuerOf(CONTOSO)]) {
        const scoped = await keys('scoped-key', scope)
        const { exchange } = microsoft('common', idToken({ key: scoped }), [scoped])
        expect(await failureOf(exchange())).toBe('resolved')
        fetchSpy?.mockRestore()
      }
    })
  })

  test('refuses a token whose key names no issuer in the key document', async () => {
    const unscoped = await keys('unscoped-key')
    const { exchange } = microsoft('common', idToken({ key: unscoped }), [unscoped])
    expect(await failureOf(exchange())).toBe('invalid_token')
  })

  test.each([
    ['no oid', undefined],
    ['an oid that is not a GUID', 'maya@northline.app'],
    ['an oid that is not a string', 12345],
    ['an empty oid', ''],
  ])('refuses a token with %s', async (_name, objectId) => {
    const { exchange } = microsoft('common', idToken({ objectId }))
    expect(await failureOf(exchange())).toBe('invalid_profile')
  })

  test('a token response without an ID token is refused', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () =>
      jsonResponse({ access_token: 'x', token_type: 'Bearer' })) as unknown as typeof fetch)
    expect(
      await failureOf(
        createMicrosoftProvider().exchange(
          { clientId: CLIENT_ID, clientSecret: 's', tenant: 'common' },
          exchangeInput
        )
      )
    ).toBe('invalid_token')
  })

  test.each([
    [
      'an OAuth error',
      () =>
        jsonResponse(
          { error: 'invalid_grant', error_description: 'AADSTS70000: canary-in-the-answer' },
          400
        ),
      'invalid_grant',
    ],
    ['a server error', () => new Response('canary-in-the-answer', { status: 503 }), 'unavailable'],
    [
      'a network failure',
      () => Promise.reject(new TypeError('fetch failed: canary-in-the-answer')),
      'unavailable',
    ],
  ] as [string, () => Response | Promise<Response>, OAuthFailure][])(
    'maps %s to a failure that carries nothing of it',
    async (_name, answer, failure) => {
      fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () =>
        answer()) as unknown as typeof fetch)
      const error = await createMicrosoftProvider()
        .exchange({ clientId: CLIENT_ID, clientSecret: 's', tenant: 'common' }, exchangeInput)
        .catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(OAuthProviderError)
      expect((error as OAuthProviderError).failure).toBe(failure)
      expect(String((error as Error).message)).toBe(`oauth provider: ${failure}`)
      expect((error as Error).cause).toBeUndefined()
      expect(JSON.stringify(error)).not.toContain('canary')
    }
  )

  test('a refused token’s error carries nothing of the token', async () => {
    const token = await idToken({ audience: 'someone-elses-client' })
    const error = await microsoft('common', token)
      .exchange()
      .catch((caught: unknown) => caught)
    expect((error as Error).message).toBe('oauth provider: invalid_token')
    expect((error as Error).cause).toBeUndefined()
    expect(`${String(error)}${JSON.stringify(error)}`).not.toContain(token.split('.')[1] as string)
  })

  test('a configured tenant that is not one is refused before any request', async () => {
    const calls: string[] = []
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
      calls.push(String(input))
      return jsonResponse({})
    }) as unknown as typeof fetch)
    expect(
      await failureOf(
        createMicrosoftProvider().exchange(
          { clientId: CLIENT_ID, clientSecret: 's', tenant: 'common/../evil' },
          exchangeInput
        )
      )
    ).toBe('unavailable')
    expect(calls).toEqual([])
  })
})

describe('microsoftSubject', () => {
  test('is <tid>:<oid>, lower-cased', () => {
    expect(microsoftSubject(CONTOSO.toUpperCase(), OBJECT_ID.toUpperCase())).toBe(
      'aaaabbbb-0000-cccc-1111-dddd2222eeee:00aa11bb-22cc-33dd-44ee-55ff66aa77bb'
    )
  })

  test.each([
    [undefined, OBJECT_ID],
    [CONTOSO, undefined],
    ['common', OBJECT_ID],
    [CONTOSO, 'maya@northline.app'],
    [`${CONTOSO}:x`, OBJECT_ID],
    [CONTOSO, `${OBJECT_ID}\n`],
  ])('is null for (%p, %p)', (tenantId, objectId) => {
    expect(microsoftSubject(tenantId, objectId)).toBeNull()
  })
})
