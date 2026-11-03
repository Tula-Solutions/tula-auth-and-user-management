import { describe, expect, test } from 'bun:test'
import { effectiveAttributeNames, SSO_ATTRIBUTE_DEFAULTS, SSO_IDP_PRESETS } from './sso-attributes'

const PROTOCOLS = ['saml', 'oidc'] as const

describe('the default attribute mapping per identity provider', () => {
  const cases = PROTOCOLS.flatMap((protocol) =>
    SSO_IDP_PRESETS.map((idp) => [protocol, idp] as const)
  )

  test.each(cases)('%s %s names an attribute for each field', (protocol, idp) => {
    const names = SSO_ATTRIBUTE_DEFAULTS[protocol][idp]
    for (const field of ['email', 'firstName', 'lastName', 'groups'] as const) {
      expect(names[field].length).toBeGreaterThan(0)
      expect(names[field].every((name) => name.trim() !== '')).toBe(true)
    }
  })

  test.each([
    ['saml', 'okta', 'groups'],
    ['saml', 'entra', 'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups'],
    ['saml', 'jumpcloud', 'memberOf'],
    ['saml', 'ping', 'memberOf'],
    ['oidc', 'okta', 'groups'],
    ['oidc', 'entra', 'groups'],
    ['oidc', 'ping', 'memberOf'],
  ] as const)('%s %s reads the groups from %s', (protocol, idp, groups) => {
    expect(effectiveAttributeNames(protocol, { idp }).groups).toContain(groups)
  })

  test('a connection with no mapping reads the protocol generic names', () => {
    expect(effectiveAttributeNames('oidc', null)).toEqual(SSO_ATTRIBUTE_DEFAULTS.oidc.generic)
    expect(effectiveAttributeNames('saml', null)).toEqual(SSO_ATTRIBUTE_DEFAULTS.saml.generic)
  })

  test('an override replaces the preset name of its field only', () => {
    const names = effectiveAttributeNames('saml', { idp: 'okta', groups: 'teams' })
    expect(names.groups).toEqual(['teams'])
    expect(names.email).toEqual(SSO_ATTRIBUTE_DEFAULTS.saml.okta.email)
  })
})
