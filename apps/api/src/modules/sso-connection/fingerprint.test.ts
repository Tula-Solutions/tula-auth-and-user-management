import { describe, expect, test } from 'bun:test'
import { fingerprint } from './service'

const base = {
  protocol: 'oidc' as const,
  issuer: 'https://idp.example.test',
  clientId: 'c',
  clientSecretSealed: 'sealed',
  saml: null,
  defaultRole: 'org:member',
  domains: ['acme.test'],
  attributeMapping: {},
  enforced: false,
  trustIdpMfa: false,
  breakGlassRole: null as string | null,
}

describe('the SSO test fingerprint (TULA-157, H-011)', () => {
  test('is stable for the same settings', () => {
    expect(fingerprint(base as never)).toBe(fingerprint({ ...base } as never))
  })

  test.each([
    ['enforced', { enforced: true }],
    ['trustIdpMfa', { trustIdpMfa: true }],
    ['breakGlassRole', { breakGlassRole: 'org:admin' }],
  ])('a change of %s resets a passing test', (_name, change) => {
    expect(fingerprint({ ...base, ...change } as never)).not.toBe(fingerprint(base as never))
  })
})
