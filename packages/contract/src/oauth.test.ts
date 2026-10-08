import { describe, expect, test } from 'bun:test'
import { FirstFactorStrategySchema } from './flow'
import { HOOK_SIGN_UP_METHODS } from './hook'
import {
  MICROSOFT_TENANT_ALIASES,
  MicrosoftTenantSchema,
  OAUTH_PROVIDERS,
  OAuthProviderSettingsSchema,
  OAuthProviderUpdateSchema,
} from './oauth'

const TENANT_ID = '72f988bf-86f1-41af-91ab-2d7cd011db47'

describe('OAuth providers', () => {
  test('every provider is a first factor and a sign-up method a hook is asked about', () => {
    for (const provider of OAUTH_PROVIDERS) {
      expect(FirstFactorStrategySchema.options).toContain(`oauth_${provider}`)
      expect(HOOK_SIGN_UP_METHODS).toContain(`oauth_${provider}`)
    }
    expect(OAUTH_PROVIDERS).toContain('microsoft')
  })
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

  test('names no secret', () => {
    const keys = Object.keys(OAuthProviderSettingsSchema.shape)
    expect(keys.filter((key) => /secret|private|key$/i.test(key) && key !== 'keyId')).toEqual([])
  })
})
