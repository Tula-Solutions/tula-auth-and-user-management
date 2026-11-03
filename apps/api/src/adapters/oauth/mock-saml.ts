import { SignedXml } from 'xml-crypto'
import { MOCK_SAML_KEY_A, MOCK_SAML_KEY_B, MOCK_SAML_KEY_C } from '~/adapters/oauth/mock-saml-keys'
import { escapeHtml } from '~/modules/email/templates'

/*
 * The mock enterprise IdP's SAML signer (ADR 0067), beside the mock OAuth provider and behind
 * the same gate. It builds real signed responses with a published test key, and can be told
 * to produce each way a response can be wrong, so that tests drive the real verifier.
 */

/** The keys a mock response can be signed with. `c` is never configured on a connection. */
export const MOCK_SAML_KEYS = {
  a: MOCK_SAML_KEY_A,
  b: MOCK_SAML_KEY_B,
  c: MOCK_SAML_KEY_C,
} as const

/** Every way the mock can be told to get a response wrong. */
export type MockSamlFailure =
  | 'wrong_audience'
  | 'wrong_recipient'
  | 'wrong_destination'
  | 'missing_in_response_to'
  | 'wrong_in_response_to'
  | 'expired'
  | 'not_yet_valid'
  | 'unsigned'
  | 'response_signed_assertion_unsigned'
  | 'second_assertion'
  | 'comment_in_name_id'
  | 'doctype'
  | 'entity'
  | 'wrong_issuer'
  | 'status_failure'

/** What the mock IdP is asked to say. */
export interface MockSamlOptions {
  /** `OAUTH_MOCK_PROVIDER`: the signer refuses to build anything when this is off. */
  mockProviderEnabled: boolean
  spEntityId: string
  acsUrl: string
  idpEntityId: string
  /** The `ID` of the request answered; leave out for an unsolicited response. */
  requestId?: string
  /** The `NameID`. */
  subject: string
  attributes?: Record<string, string[]>
  /** The time the IdP believes it is. */
  now: Date
  /** Which test key signs. Default `a`. */
  key?: keyof typeof MOCK_SAML_KEYS
  /** The assertion's `ID`; fixed by a test that replays one. */
  assertionId?: string
  failure?: MockSamlFailure
}

const SIG_ALG = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256'
const C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#'
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature'
const DIGEST = 'http://www.w3.org/2001/04/xmlenc#sha256'

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function sign(xml: string, key: keyof typeof MOCK_SAML_KEYS, target: 'Assertion' | 'Response') {
  const material = MOCK_SAML_KEYS[key]
  const sig = new SignedXml({
    privateKey: material.privateKey,
    publicCert: material.certificate,
    signatureAlgorithm: SIG_ALG,
    canonicalizationAlgorithm: C14N,
  })
  const path = target === 'Assertion' ? "//*[local-name(.)='Assertion']" : '/*'
  sig.addReference({
    xpath: path,
    transforms: [ENVELOPED, C14N],
    digestAlgorithm: DIGEST,
  })
  sig.computeSignature(xml, {
    location: { reference: `${path}/*[local-name(.)='Issuer']`, action: 'after' },
  })
  return sig.getSignedXml()
}

/**
 * Build the base64 `SAMLResponse` the mock IdP would post to a connection's ACS URL.
 *
 * @param options - What to say, and optionally how to get it wrong.
 * @returns The base64 response.
 * @throws Error when the mock provider is not enabled: nothing here is reachable otherwise.
 */
export function buildMockSamlResponse(options: MockSamlOptions): string {
  if (!options.mockProviderEnabled) {
    throw new Error('The mock SAML signer is available only with OAUTH_MOCK_PROVIDER on')
  }
  const f = options.failure
  const now = options.now.getTime()
  const e = escapeHtml
  const notBefore = f === 'not_yet_valid' ? now + 600_000 : now - 60_000
  const notOnOrAfter = f === 'expired' ? now - 600_000 : now + 300_000
  const requestId = f === 'wrong_in_response_to' ? '_other' : options.requestId
  const inResponseTo =
    requestId && f !== 'missing_in_response_to' ? ` InResponseTo="${e(requestId)}"` : ''
  const assertionId = options.assertionId ?? `_a${Bun.randomUUIDv7()}`
  const name =
    f === 'comment_in_name_id' ? `${e(options.subject)}<!---->.evil.example` : e(options.subject)
  const values = Object.entries(options.attributes ?? {})
    .map(
      ([attr, vs]) =>
        `<saml:Attribute Name="${e(attr)}">${vs.map((v) => `<saml:AttributeValue>${e(v)}</saml:AttributeValue>`).join('')}</saml:Attribute>`
    )
    .join('')
  const assertion = (id: string, subject: string) =>
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" IssueInstant="${iso(now)}" Version="2.0">` +
    `<saml:Issuer>${e(f === 'wrong_issuer' ? `${options.idpEntityId}/other` : options.idpEntityId)}</saml:Issuer>` +
    `<saml:Subject><saml:NameID>${subject}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData${inResponseTo} NotOnOrAfter="${iso(notOnOrAfter)}" Recipient="${e(f === 'wrong_recipient' ? `${options.acsUrl}/other` : options.acsUrl)}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(notBefore)}" NotOnOrAfter="${iso(notOnOrAfter)}"><saml:AudienceRestriction><saml:Audience>${e(f === 'wrong_audience' ? `${options.spEntityId}/other` : options.spEntityId)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="_s1"/>` +
    `<saml:AttributeStatement>${values}</saml:AttributeStatement></saml:Assertion>`
  const key = options.key ?? 'a'
  const signAssertion = f !== 'unsigned' && f !== 'response_signed_assertion_unsigned'
  const inner = assertion(assertionId, name)
  const extra = f === 'second_assertion' ? assertion('_evil', e('attacker@evil.example')) : ''
  const status =
    f === 'status_failure'
      ? 'urn:oasis:names:tc:SAML:2.0:status:Responder'
      : 'urn:oasis:names:tc:SAML:2.0:status:Success'
  const wrap = (body: string) =>
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${Bun.randomUUIDv7()}" Version="2.0" IssueInstant="${iso(now)}" Destination="${e(f === 'wrong_destination' ? `${options.acsUrl}/other` : options.acsUrl)}"${inResponseTo}>` +
    `<saml:Issuer>${e(options.idpEntityId)}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="${status}"/></samlp:Status>${body}</samlp:Response>`
  let xml: string
  if (signAssertion) {
    const signed = sign(wrap(inner), key, 'Assertion')
    xml = extra ? signed.replace('</samlp:Response>', `${extra}</samlp:Response>`) : signed
  } else if (f === 'response_signed_assertion_unsigned') {
    xml = sign(wrap(inner), key, 'Response')
  } else {
    xml = wrap(inner)
  }
  if (f === 'doctype') {
    xml = `<!DOCTYPE foo [<!ELEMENT foo ANY>]>${xml}`
  } else if (f === 'entity') {
    xml = `<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>${xml}`
  }
  return Buffer.from(xml).toString('base64')
}
