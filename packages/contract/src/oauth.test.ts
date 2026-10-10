import { describe, expect, test } from 'bun:test'
import { FirstFactorStrategySchema } from './flow'
import { HOOK_SIGN_UP_METHODS } from './hook'
import {
  AdditionalClientIdsSchema,
  givesNoAddress,
  ID_TOKEN_PROVIDERS,
  IdTokenExchangeRequestSchema,
  IdTokenStartRequestSchema,
  isGoogleClientId,
  MAX_ADDITIONAL_CLIENT_IDS,
  MAX_ID_TOKEN_LENGTH,
  MICROSOFT_TENANT_ALIASES,
  MicrosoftTenantSchema,
  OAUTH_PROVIDERS,
  OAUTH_PROVIDERS_WITHOUT_ADDRESS,
  OAuthProviderSettingsSchema,
  OAuthProviderUpdateSchema,
  oauthProviderWeakenings,
  ownClientIdAmong,
} from './oauth'

const TENANT_ID = '72f988bf-86f1-41af-91ab-2d7cd011db47'

describe('OAuth providers', () => {
  test('every provider is a first factor and a sign-up method a hook is asked about', () => {
    for (const provider of OAUTH_PROVIDERS) {
      expect(FirstFactorStrategySchema.options).toContain(`oauth_${provider}`)
      expect(HOOK_SIGN_UP_METHODS).toContain(`oauth_${provider}`)
    }
    expect(OAUTH_PROVIDERS).toContain('microsoft')
    expect(OAUTH_PROVIDERS).toContain('discord')
    expect(OAUTH_PROVIDERS).toContain('linkedin')
    expect(OAUTH_PROVIDERS).toContain('x')
    expect(OAUTH_PROVIDERS).toContain('facebook')
  })
})

describe('the providers Tula takes no address from', () => {
  test('are X and Facebook, and nothing else', () => {
    expect([...OAUTH_PROVIDERS_WITHOUT_ADDRESS]).toEqual(['x', 'facebook'])
    expect(OAUTH_PROVIDERS.filter((provider) => givesNoAddress(provider))).toEqual([
      'x',
      'facebook',
    ])
  })

  test.each(['X', 'Facebook', 'x ', 'twitter', 'constructor', ''])(
    '%j is not one of them: the name is matched exactly',
    (name) => {
      expect(givesNoAddress(name)).toBe(false)
    }
  )
})

describe('MicrosoftTenantSchema', () => {
  test.each([
    ...MICROSOFT_TENANT_ALIASES.map((alias) => [alias, alias] as const),
    ['Common', 'common'],
    ['  organizations ', 'organizations'],
    [TENANT_ID, TENANT_ID],
    [TENANT_ID.toUpperCase(), TENANT_ID],
    ['9188040d-6c67-4c5b-b112-36a304b66dad', '9188040d-6c67-4c5b-b112-36a304b66dad'],
  ])('%p is accepted as %p', (input, stored) => {
    expect(MicrosoftTenantSchema.parse(input)).toBe(stored)
  })

  // The value becomes a path segment of Microsoft's endpoints and is compared with a token's
  // tenant id: nothing but an alias or an id gets that far.
  test.each([
    ['a domain name', 'contoso.onmicrosoft.com'],
    ['an authority', 'https://login.microsoftonline.com/common'],
    ['an alias with a path', 'common/v2.0'],
    ['a path that climbs', '../common'],
    ['the issuer template', '{tenantid}'],
    ['an id without its dashes', TENANT_ID.replaceAll('-', '')],
    ['an id in braces', `{${TENANT_ID}}`],
    ['an id with something after it', `${TENANT_ID}/x`],
    ['an id with a query', `${TENANT_ID}?p=1`],
    ['two ids', `${TENANT_ID},${TENANT_ID}`],
    ['an unknown alias', 'everyone'],
    ['nothing', ''],
    ['only spaces', '   '],
    ['a number', 7],
    ['null', null],
  ])('%s is refused', (_name, input) => {
    expect(MicrosoftTenantSchema.safeParse(input).success).toBe(false)
  })
})

describe('OAuthProviderUpdateSchema', () => {
  test('takes a tenant, lower-cased, and still takes a body without one', () => {
    expect(
      OAuthProviderUpdateSchema.parse({
        clientId: 'c',
        clientSecret: 's',
        tenant: TENANT_ID.toUpperCase(),
      })
    ).toEqual({ clientId: 'c', clientSecret: 's', tenant: TENANT_ID, enabled: true })
    expect(OAuthProviderUpdateSchema.parse({ clientId: 'c' })).toEqual({
      clientId: 'c',
      enabled: true,
    })
  })

  test('refuses a tenant that is not an alias or an id', () => {
    const result = OAuthProviderUpdateSchema.safeParse({ clientId: 'c', tenant: 'contoso.com' })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['tenant'])
  })
})

describe('OAuthProviderSettingsSchema', () => {
  const settings = {
    provider: 'microsoft',
    configured: true,
    enabled: true,
    clientId: 'c',
    teamId: null,
    keyId: null,
    callbackUrl: 'https://auth.example.com/v1/oauth/callback/microsoft',
    updatedAt: null,
  }

  test('carries the tenant, or null for a provider that has none', () => {
    expect(OAuthProviderSettingsSchema.parse({ ...settings, tenant: 'common' }).tenant).toBe(
      'common'
    )
    expect(OAuthProviderSettingsSchema.parse({ ...settings, tenant: null }).tenant).toBeNull()
  })

  test('an answer from before the accepted client ids is read as having none', () => {
    expect(OAuthProviderSettingsSchema.parse({ ...settings, tenant: null })).toMatchObject({
      additionalClientIds: [],
    })
  })

  test('names no secret', () => {
    const keys = Object.keys(OAuthProviderSettingsSchema.shape)
    expect(keys.filter((key) => /secret|private|key$/i.test(key) && key !== 'keyId')).toEqual([])
  })
})

describe('native ID-token sign-in (ADR 0045)', () => {
  const ID = '1234567890-abc123def456.apps.googleusercontent.com'
  const OTHER = '2-b.apps.googleusercontent.com'

  test('only a provider on the closed list exchanges an ID token', () => {
    expect([...ID_TOKEN_PROVIDERS]).toEqual(['google'])
    for (const provider of OAUTH_PROVIDERS) {
      expect(IdTokenStartRequestSchema.safeParse({ provider }).success).toBe(
        (ID_TOKEN_PROVIDERS as readonly string[]).includes(provider)
      )
    }
  })

  test.each([
    ['a redirect URL', { provider: 'google', redirectUrl: 'https://app.example/cb' }],
    ['a nonce of the client’s own', { provider: 'google', nonce: 'mine' }],
    ['an audience', { provider: 'google', audience: ID }],
    ['no provider', {}],
  ])('the start takes the provider and nothing else: %s', (_name, body) => {
    expect(IdTokenStartRequestSchema.safeParse(body).success).toBe(false)
  })

  test.each([
    ['an empty token', { idToken: '' }],
    ['no token', {}],
    ['a token over the cap', { idToken: 'x'.repeat(MAX_ID_TOKEN_LENGTH + 1) }],
    ['a provider beside the token', { idToken: 'x', provider: 'google' }],
    ['a nonce beside the token', { idToken: 'x', nonce: 'mine' }],
    ['an audience beside the token', { idToken: 'x', audience: ID }],
  ])('the exchange takes the token and nothing else: %s', (_name, body) => {
    expect(IdTokenExchangeRequestSchema.safeParse(body).success).toBe(false)
  })

  test('a token at the cap is taken', () => {
    expect(
      IdTokenExchangeRequestSchema.safeParse({ idToken: 'x'.repeat(MAX_ID_TOKEN_LENGTH) }).success
    ).toBe(true)
  })

  test.each([
    [ID, true],
    ['1234567890.apps.googleusercontent.com', true],
    ['1234567890-ABC.apps.googleusercontent.com', false],
    ['abc.apps.googleusercontent.com', false],
    ['1234567890-abc.apps.googleusercontent.com.evil.test', false],
    ['evil.test/1234567890-abc.apps.googleusercontent.com', false],
    ['https://1234567890-abc.apps.googleusercontent.com', false],
    ['*.apps.googleusercontent.com', false],
    ['1234567890-abc.apps.googleusercontent.com ', false],
    ['1234567890-abc.apps.googleusercontent.com\n', false],
    ['1234567890-a_b.apps.googleusercontent.com', false],
    ['1234567890-abc.googleusercontent.com', false],
    ['com.example.app', false],
    ['', false],
    [`1-${'a'.repeat(64)}.apps.googleusercontent.com`, true],
    [`1-${'a'.repeat(65)}.apps.googleusercontent.com`, false],
  ])('isGoogleClientId(%j) is %p', (value, expected) => {
    expect(isGoogleClientId(value)).toBe(expected)
  })

  test('the accepted client ids are a capped set of Google client ids', () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, i) => `${i + 1}-app.apps.googleusercontent.com`)
    expect(AdditionalClientIdsSchema.safeParse([]).success).toBe(true)
    expect(AdditionalClientIdsSchema.safeParse(many(MAX_ADDITIONAL_CLIENT_IDS)).success).toBe(true)
    expect(AdditionalClientIdsSchema.safeParse(many(MAX_ADDITIONAL_CLIENT_IDS + 1)).success).toBe(
      false
    )
    expect(AdditionalClientIdsSchema.safeParse([ID, ID]).success).toBe(false)
    expect(AdditionalClientIdsSchema.safeParse([ID, 'com.example.app']).success).toBe(false)
  })

  test.each<[string, string[] | null, string[], string[]]>([
    ['an id gained', [], [ID], ['additionalClientIds']],
    ['a first id on a new provider', null, [ID], ['additionalClientIds']],
    ['one swapped for another', [ID], [OTHER], ['additionalClientIds']],
    ['an id taken away', [ID, OTHER], [ID], []],
    ['another order', [ID, OTHER], [OTHER, ID], []],
    ['nothing before, nothing after', null, [], []],
  ])('a weakening is an id gained and nothing else: %s', (_name, before, after, expected) => {
    expect(
      oauthProviderWeakenings(before === null ? null : { additionalClientIds: before }, {
        additionalClientIds: after,
      })
    ).toEqual(expected)
  })

  test.each<[string, string, string[], number]>([
    ['not among them', ID, [OTHER], -1],
    ['an empty list', ID, [], -1],
    ['the only entry', ID, [ID], 0],
    ['after another', ID, [OTHER, ID], 1],
    ['compared exactly: another case is another string', ID, [ID.toUpperCase()], -1],
  ])('where the own client id is among the additional ones: %s', (_name, own, ids, expected) => {
    expect(ownClientIdAmong(own, ids)).toBe(expected)
  })

  test('a record with no list has none', () => {
    expect(oauthProviderWeakenings({}, {})).toEqual([])
    expect(oauthProviderWeakenings({}, { additionalClientIds: [ID] })).toEqual([
      'additionalClientIds',
    ])
  })
})
