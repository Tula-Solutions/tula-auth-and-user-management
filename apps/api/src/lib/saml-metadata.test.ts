import { describe, expect, test } from 'bun:test'
import { DOMParser } from '@xmldom/xmldom'
import { MOCK_SAML_KEY_A, MOCK_SAML_KEY_B } from '~/adapters/oauth/mock-saml-keys'
import {
  buildSpMetadata,
  parseIdpMetadata,
  readCertificate,
  SamlMetadataError,
} from '~/lib/saml-metadata'

const bare = (pem: string) => pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')
const A = bare(MOCK_SAML_KEY_A.certificate)
const B = bare(MOCK_SAML_KEY_B.certificate)

const key = (cert: string, use = '') =>
  `<md:KeyDescriptor${use}><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${cert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`

function idp(extra = '', head = '', binding = 'HTTP-Redirect', kind = 'IDPSSODescriptor') {
  return (
    `${head}<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="https://idp.example/e">` +
    `<md:${kind} protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">` +
    key(A, ' use="signing"') +
    extra +
    '<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example/post"/>' +
    `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:${binding}" Location="https://idp.example/sso"/>` +
    `</md:${kind}></md:EntityDescriptor>`
  )
}

function reason(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (error) {
    return error instanceof SamlMetadataError ? error.reason : 'other'
  }
  return undefined
}

describe('parseIdpMetadata', () => {
  test('takes the entity id, the Redirect SSO URL and the signing certificates', () => {
    expect(parseIdpMetadata(idp())).toEqual({
      idpEntityId: 'https://idp.example/e',
      ssoUrl: 'https://idp.example/sso',
      certificates: [A],
    })
  })

  test('takes no encryption certificate and at most two signing ones', () => {
    expect(parseIdpMetadata(idp(key(B, ' use="encryption"'))).certificates).toEqual([A])
    expect(parseIdpMetadata(idp(key(B) + key(B))).certificates).toEqual([A, B])
  })

  test('refuses a DTD and an entity', () => {
    expect(reason(() => parseIdpMetadata(idp('', '<!DOCTYPE x [<!ENTITY e "v">]>')))).toBe(
      'forbidden_xml'
    )
    expect(
      reason(() =>
        parseIdpMetadata(idp('', '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>'))
      )
    ).toBe('forbidden_xml')
  })

  test('refuses a DTD before parsing it, even one the parser would choke on', () => {
    expect(reason(() => parseIdpMetadata('<!DOCTYPE x [<!ENTITY e "&nope;">'))).toBe(
      'forbidden_xml'
    )
    expect(reason(() => parseIdpMetadata('<!doctype x [<!ENTITY a "x">'))).toBe('forbidden_xml')
  })

  test('refuses a document nested deeper than any metadata is (H-023)', () => {
    const deep = (n: number) => `${'<md:Extensions>'.repeat(n)}${'</md:Extensions>'.repeat(n)}`
    expect(reason(() => parseIdpMetadata(idp(deep(5000))))).toBe('malformed')
    expect(reason(() => parseIdpMetadata(idp(deep(10))))).toBeUndefined()
  })

  test('refuses what is not usable metadata', () => {
    expect(reason(() => parseIdpMetadata('<nope'))).toBe('malformed')
    expect(reason(() => parseIdpMetadata('<a xmlns="urn:x"/>'))).toBe('malformed')
    expect(reason(() => parseIdpMetadata(idp('', '', 'HTTP-Other')))).toBe('no_sso_url')
    expect(reason(() => parseIdpMetadata(idp('', '', 'HTTP-Redirect', 'SPSSODescriptor')))).toBe(
      'no_idp'
    )
    expect(reason(() => parseIdpMetadata(idp().replace('use="signing"', 'use="encryption"')))).toBe(
      'no_certificate'
    )
  })
})

describe('readCertificate', () => {
  test('gives the PEM, the expiry and a fingerprint of bare base64 or PEM alike', () => {
    const fromBare = readCertificate(A)
    expect(fromBare.pem).toStartWith('-----BEGIN CERTIFICATE-----')
    expect(fromBare.notAfter.getTime()).toBeGreaterThan(0)
    expect(readCertificate(MOCK_SAML_KEY_A.certificate).fingerprint).toBe(fromBare.fingerprint)
    expect(fromBare.fingerprint).not.toBe(readCertificate(B).fingerprint)
  })

  test('refuses garbage', () => {
    expect(reason(() => readCertificate('AAAA'))).toBe('certificate_invalid')
  })
})

describe('buildSpMetadata', () => {
  test('has the entity id, a POST ACS and the NameID format Okta and Entra need', () => {
    const xml = buildSpMetadata({
      entityId: 'https://sp.example/m?a=1&b=2',
      acsUrl: 'https://sp.example/acs',
    })
    const doc = new DOMParser().parseFromString(xml, 'text/xml')
    const md = 'urn:oasis:names:tc:SAML:2.0:metadata'
    expect(doc.documentElement?.localName).toBe('EntityDescriptor')
    expect(doc.documentElement?.getAttribute('entityID')).toBe('https://sp.example/m?a=1&b=2')
    const acs = doc.getElementsByTagNameNS(md, 'AssertionConsumerService')[0]
    expect(acs?.getAttribute('Binding')).toBe('urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST')
    expect(acs?.getAttribute('Location')).toBe('https://sp.example/acs')
    expect(acs?.getAttribute('index')).toBe('0')
    expect(doc.getElementsByTagNameNS(md, 'NameIDFormat')[0]?.textContent).toBe(
      'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'
    )
    expect(
      doc.getElementsByTagNameNS(md, 'SPSSODescriptor')[0]?.getAttribute('WantAssertionsSigned')
    ).toBe('true')
  })

  test('escapes hostile values, so they cannot add an attribute or an element (H-036)', () => {
    const hostile = '"/><evil x="1'
    const xml = buildSpMetadata({ entityId: hostile, acsUrl: `https://sp.example/${hostile}` })
    expect(xml).not.toContain('<evil')
    const doc = new DOMParser().parseFromString(xml, 'text/xml')
    expect(doc.getElementsByTagName('evil')).toHaveLength(0)
    expect(doc.documentElement?.getAttribute('entityID')).toBe(hostile)
  })
})
