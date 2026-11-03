import { DOMParser, type Document, type Element, type Text } from '@xmldom/xmldom'
import { SignedXml } from 'xml-crypto'
import type { Deps } from '~/dependencies'
import { sha256Hex } from '~/lib/crypto'

/*
 * The one place a SAML response is accepted (ADR 0067). The library does two things only:
 * parse XML (@xmldom/xmldom) and check an XML signature (xml-crypto). Every decision about
 * *what* was signed, for whom, for when and whether it was seen before is made here, on the
 * canonical XML the signature covers, never on the document as it arrived.
 */

const NS_PROTOCOL = 'urn:oasis:names:tc:SAML:2.0:protocol'
const NS_ASSERTION = 'urn:oasis:names:tc:SAML:2.0:assertion'
const NS_DSIG = 'http://www.w3.org/2000/09/xmldsig#'

/** The clock skew allowed on every assertion time, in milliseconds (ADR 0067). */
export const SAML_CLOCK_SKEW_MS = 120_000
/** The largest base64 `SAMLResponse` accepted, in characters. */
export const SAML_RESPONSE_MAX_LENGTH = 512 * 1024

const STATUS_SUCCESS = 'urn:oasis:names:tc:SAML:2.0:status:Success'
const CM_BEARER = 'urn:oasis:names:tc:SAML:2.0:cm:bearer'

/** Algorithms an assertion's signature may use. SHA-1 and HMAC are refused on purpose. */
const SIGNATURE_METHODS = new Set([
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha384',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512',
])
const DIGEST_METHODS = new Set([
  'http://www.w3.org/2001/04/xmlenc#sha256',
  'http://www.w3.org/2001/04/xmldsig-more#sha384',
  'http://www.w3.org/2001/04/xmlenc#sha512',
])
const C14N_METHODS = new Set([
  'http://www.w3.org/2001/10/xml-exc-c14n#',
  'http://www.w3.org/2001/10/xml-exc-c14n#WithComments',
])
const TRANSFORMS = new Set([
  'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
  'http://www.w3.org/2001/10/xml-exc-c14n#',
  'http://www.w3.org/2001/10/xml-exc-c14n#WithComments',
])

/**
 * Every reason a response is refused. Fixed words: nothing the response said is ever part of
 * one, so a code can be shown to the person setting a connection up and logged freely.
 */
export const SAML_REFUSALS = [
  'malformed',
  'forbidden_xml',
  'unsolicited',
  'status_not_success',
  'encrypted_assertion_unsupported',
  'no_assertion',
  'multiple_assertions',
  'assertion_misplaced',
  'unsigned',
  'assertion_unsigned',
  'signature_invalid',
  'signature_algorithm_refused',
  'certificate_not_configured',
  'issuer_mismatch',
  'destination_mismatch',
  'in_response_to_missing',
  'in_response_to_mismatch',
  'subject_confirmation_invalid',
  'recipient_mismatch',
  'audience_mismatch',
  'conditions_missing',
  'not_yet_valid',
  'expired',
  'name_id_invalid',
  'attribute_invalid',
  'replayed',
] as const

/** The reason a response was refused. */
export type SamlRefusal = (typeof SAML_REFUSALS)[number]

/** What a connection expects of the response to one sign-in attempt. */
export interface SamlExpectations {
  /** The service provider's entity id: the one audience accepted. */
  spEntityId: string
  /** The assertion consumer service URL: the one `Destination` and `Recipient` accepted. */
  acsUrl: string
  /** The `ID` of the attempt's authentication request; `null` for an unsolicited response. */
  requestId: string | null
  /** The identity provider's entity id: the one issuer accepted. */
  idpEntityId: string
  /** The identity provider's signing certificates (PEM or bare base64); any one may sign. */
  certificates: readonly string[]
}

/** What a verified response says. Taken from the signed assertion only. */
export interface SamlAssertion {
  /** The assertion's `ID`. */
  id: string
  /** The `NameID`'s text. */
  subject: string
  /** The `NameID`'s format, when it has one. */
  nameIdFormat: string | null
  /** `SessionIndex` of the `AuthnStatement`, when there is one. */
  sessionIndex: string | null
  /** Attribute name to its values. */
  attributes: Record<string, string[]>
}

/** The outcome of {@link verify}. */
export type SamlVerdict =
  | { ok: true; assertion: SamlAssertion }
  | { ok: false; reason: SamlRefusal }

class Refuse extends Error {
  constructor(readonly reason: SamlRefusal) {
    super(reason)
  }
}

function refuse(reason: SamlRefusal): never {
  throw new Refuse(reason)
}

function childElements(parent: Element, ns: string, local: string): Element[] {
  const found: Element[] = []
  for (let n = parent.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && n.namespaceURI === ns && (n as Element).localName === local) {
      found.push(n as Element)
    }
  }
  return found
}

function only(parent: Element, ns: string, local: string, reason: SamlRefusal): Element {
  const found = childElements(parent, ns, local)
  if (found.length !== 1) {
    refuse(reason)
  }
  return found[0] as Element
}

/**
 * The text of an element that holds nothing but text. A comment, a CDATA section, a
 * processing instruction or a child element splits or hides text differently in different
 * parsers (the NameID comment attack), so any of them is a refusal, not something to skip.
 */
function plainText(el: Element, reason: SamlRefusal): string {
  const kids = el.childNodes
  if (kids.length === 0) {
    return ''
  }
  const child = kids.item(0)
  if (kids.length !== 1 || !child || child.nodeType !== 3) {
    refuse(reason)
  }
  return (child as Text).data
}

function time(value: string | null, reason: SamlRefusal): number {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    refuse(reason)
  }
  const ms = Date.parse(value as string)
  if (Number.isNaN(ms)) {
    refuse(reason)
  }
  return ms
}

function parse(xml: string): Document {
  const throwing = (_level: string, message: string): never => {
    throw new Error(message)
  }
  try {
    return new DOMParser({ onError: throwing }).parseFromString(xml, 'text/xml') as Document
  } catch {
    return refuse('malformed')
  }
}

/** A certificate as bare base64, whatever form it was configured in. */
function bareCertificate(cert: string): string {
  return cert.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '')
}

function pem(cert: string): string {
  const body =
    bareCertificate(cert)
      .match(/.{1,64}/g)
      ?.join('\n') ?? ''
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`
}

function decode(samlResponse: string): string {
  if (samlResponse.length === 0 || samlResponse.length > SAML_RESPONSE_MAX_LENGTH) {
    refuse('malformed')
  }
  const compact = samlResponse.replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    refuse('malformed')
  }
  let xml: string
  try {
    xml = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(compact, 'base64'))
  } catch {
    return refuse('malformed')
  }
  // Refused before any parser sees it: a DTD is where entity expansion and external
  // entities live, and no IdP needs one.
  if (/<!\s*(DOCTYPE|ENTITY)/i.test(xml)) {
    refuse('forbidden_xml')
  }
  if (/^\s*<\?xml[^>]*encoding\s*=\s*["'](?!utf-8["'])/i.test(xml)) {
    refuse('malformed')
  }
  return xml
}

/** Check what the Signature element declares before the library is asked to verify it. */
function checkSignatureShape(signature: Element, assertionId: string): void {
  const signedInfo = only(signature, NS_DSIG, 'SignedInfo', 'signature_invalid')
  const algorithm = (name: string, parent: Element, allowed: Set<string>) => {
    const el = only(parent, NS_DSIG, name, 'signature_invalid')
    if (!allowed.has(el.getAttribute('Algorithm') ?? '')) {
      refuse('signature_algorithm_refused')
    }
    return el
  }
  algorithm('CanonicalizationMethod', signedInfo, C14N_METHODS)
  algorithm('SignatureMethod', signedInfo, SIGNATURE_METHODS)
  // One reference, to this assertion: a second one is how a signature is made to cover less
  // than it appears to (CVE-2025-29774).
  const reference = only(signedInfo, NS_DSIG, 'Reference', 'signature_invalid')
  if (reference.getAttribute('URI') !== `#${assertionId}`) {
    refuse('signature_invalid')
  }
  algorithm('DigestMethod', reference, DIGEST_METHODS)
  const transforms = childElements(reference, NS_DSIG, 'Transforms')
  for (const transform of transforms.flatMap((t) => childElements(t, NS_DSIG, 'Transform'))) {
    if (!TRANSFORMS.has(transform.getAttribute('Algorithm') ?? '')) {
      refuse('signature_algorithm_refused')
    }
  }
}

/** The certificates the signature names itself, as bare base64. */
function namedCertificates(signature: Element): string[] {
  const found: string[] = []
  for (const keyInfo of childElements(signature, NS_DSIG, 'KeyInfo')) {
    for (const data of childElements(keyInfo, NS_DSIG, 'X509Data')) {
      for (const cert of childElements(data, NS_DSIG, 'X509Certificate')) {
        found.push(bareCertificate(cert.textContent ?? ''))
      }
    }
  }
  return found
}

/** Check the signature with each configured certificate; returns the signed canonical XML. */
function signedAssertionXml(xml: string, signature: Element, certificates: readonly string[]) {
  for (const cert of certificates) {
    // `getCertFromKeyInfo` returns nothing so that the key is always the configured one and
    // never one the response carries (CVE-2024-32962).
    const sig = new SignedXml({ publicCert: pem(cert), getCertFromKeyInfo: () => null })
    try {
      // `never`: xml-crypto types its parameter as the DOM's Node, @xmldom's Element is not that
      // type under a package that compiles this file with the DOM lib (nextjs, expo).
      sig.loadSignature(signature as never)
      if (sig.checkSignature(xml)) {
        const signed = sig.getSignedReferences()
        if (signed.length === 1) {
          return signed[0] as string
        }
      }
    } catch {
      // Try the next certificate; a thrown error is a failed check, not a reason of its own.
    }
  }
  return refuse('signature_invalid')
}

/**
 * Verify a SAML response and return what its signed assertion says.
 *
 * Policy, all of it here and none of it the library's: the assertion itself must be signed by
 * one of the connection's certificates (a signed response around an unsigned assertion is
 * refused); everything is read from the canonical XML the signature covers; exactly one
 * assertion; the audience, `Recipient`, `Destination`, issuer and `InResponseTo` must match
 * the expectations exactly; the times hold within {@link SAML_CLOCK_SKEW_MS}; and the
 * assertion's id has not been seen before (`deps.proofReplay`). Encrypted assertions, DTDs,
 * unsolicited responses and SHA-1 are refused.
 *
 * @param deps - The clock and the replay guard.
 * @param samlResponse - The `SAMLResponse` form field: the base64 of the response XML.
 * @param expected - What the connection and the attempt expect.
 * @returns The assertion, or the fixed reason it was refused.
 * @throws ServiceUnavailableError `service.unavailable` when the replay guard cannot answer;
 *   the response is not accepted while nobody can say whether it was used before.
 */
export async function verify(
  deps: Pick<Deps, 'clock' | 'proofReplay'>,
  samlResponse: string,
  expected: SamlExpectations
): Promise<SamlVerdict> {
  try {
    const assertion = await check(deps, samlResponse, expected)
    return { ok: true, assertion }
  } catch (error) {
    if (error instanceof Refuse) {
      return { ok: false, reason: error.reason }
    }
    throw error
  }
}

async function check(
  deps: Pick<Deps, 'clock' | 'proofReplay'>,
  samlResponse: string,
  expected: SamlExpectations
): Promise<SamlAssertion> {
  if (expected.requestId === null) {
    refuse('unsolicited')
  }
  const xml = decode(samlResponse)
  const doc = parse(xml)
  if (doc.doctype) {
    refuse('forbidden_xml')
  }
  const root = doc.documentElement
  if (!root || root.namespaceURI !== NS_PROTOCOL || root.localName !== 'Response') {
    refuse('malformed')
  }

  if (doc.getElementsByTagNameNS(NS_ASSERTION, 'EncryptedAssertion').length > 0) {
    refuse('encrypted_assertion_unsupported')
  }
  const all = doc.getElementsByTagNameNS(NS_ASSERTION, 'Assertion')
  if (all.length === 0) {
    refuse('no_assertion')
  }
  if (all.length > 1) {
    refuse('multiple_assertions')
  }
  const assertionEl = childElements(root, NS_ASSERTION, 'Assertion')[0]
  if (!assertionEl) {
    refuse('assertion_misplaced')
  }
  const assertionId = assertionEl.getAttribute('ID')
  if (!assertionId) {
    refuse('malformed')
  }

  const signatures = doc.getElementsByTagNameNS(NS_DSIG, 'Signature')
  if (signatures.length === 0) {
    refuse('unsigned')
  }
  const own = childElements(assertionEl, NS_DSIG, 'Signature')
  if (own.length !== 1) {
    refuse('assertion_unsigned')
  }
  const signature = own[0] as Element
  // Only a signature that is a direct child of the response or the assertion; one hidden in
  // an extension is a wrapping attempt.
  for (let i = 0; i < signatures.length; i++) {
    const parent = signatures.item(i)?.parentNode
    if (parent !== root && parent !== assertionEl) {
      refuse('signature_invalid')
    }
  }

  const named = namedCertificates(signature)
  const configured = expected.certificates.map(bareCertificate)
  if (named.length > 0 && !named.some((cert) => configured.includes(cert))) {
    refuse('certificate_not_configured')
  }
  checkSignatureShape(signature, assertionId)
  const signedXml = signedAssertionXml(xml, signature, expected.certificates)

  // Canonicalisation drops comments, so a NameID split by one verifies yet reads differently
  // in the document as sent: judge the original's text too, then read the signed form.
  plainText(
    only(
      only(assertionEl, NS_ASSERTION, 'Subject', 'name_id_invalid'),
      NS_ASSERTION,
      'NameID',
      'name_id_invalid'
    ),
    'name_id_invalid'
  )

  // From here on, only the signed canonical XML is read for the assertion.
  const signedDoc = parse(signedXml)
  const a = signedDoc.documentElement
  if (
    !a ||
    a.namespaceURI !== NS_ASSERTION ||
    a.localName !== 'Assertion' ||
    a.getAttribute('ID') !== assertionId
  ) {
    refuse('signature_invalid')
  }

  checkResponse(root, expected)
  const now = deps.clock.now().getTime()
  const issuer = only(a, NS_ASSERTION, 'Issuer', 'issuer_mismatch')
  if (plainText(issuer, 'issuer_mismatch') !== expected.idpEntityId) {
    refuse('issuer_mismatch')
  }

  const subject = only(a, NS_ASSERTION, 'Subject', 'name_id_invalid')
  const nameIdEl = only(subject, NS_ASSERTION, 'NameID', 'name_id_invalid')
  const nameId = plainText(nameIdEl, 'name_id_invalid')
  if (nameId.trim() === '' || nameId !== nameId.trim()) {
    refuse('name_id_invalid')
  }

  const expiry = checkConfirmation(subject, expected, now)
  checkConditions(a, expected, now)
  const attributes = readAttributes(a)

  // Last, so that nothing a forger can send burns an id: only a response that is signed,
  // current and addressed to this connection reaches the guard.
  const key = `saml:${sha256Hex(`${expected.idpEntityId}\0${assertionId}`)}`
  if (!(await deps.proofReplay.remember(key, new Date(expiry + SAML_CLOCK_SKEW_MS)))) {
    refuse('replayed')
  }

  const authn = childElements(a, NS_ASSERTION, 'AuthnStatement')[0]
  return {
    id: assertionId,
    subject: nameId,
    nameIdFormat: nameIdEl.getAttribute('Format') || null,
    sessionIndex: authn?.getAttribute('SessionIndex') || null,
    attributes,
  }
}

/** The response's own attributes: unsigned, so a second line of defence and not the first. */
function checkResponse(root: Element, expected: SamlExpectations): void {
  if (root.getAttribute('Destination') !== expected.acsUrl) {
    refuse('destination_mismatch')
  }
  const inResponseTo = root.getAttribute('InResponseTo')
  if (!inResponseTo) {
    refuse('in_response_to_missing')
  }
  if (inResponseTo !== expected.requestId) {
    refuse('in_response_to_mismatch')
  }
  const status = childElements(root, NS_PROTOCOL, 'Status')[0]
  const code = status && childElements(status, NS_PROTOCOL, 'StatusCode')[0]
  if (!code || code.getAttribute('Value') !== STATUS_SUCCESS) {
    refuse('status_not_success')
  }
}

/** The bearer confirmation: recipient, `InResponseTo` and expiry. Returns its expiry. */
function checkConfirmation(subject: Element, expected: SamlExpectations, now: number): number {
  const confirmation = only(
    subject,
    NS_ASSERTION,
    'SubjectConfirmation',
    'subject_confirmation_invalid'
  )
  if (confirmation.getAttribute('Method') !== CM_BEARER) {
    refuse('subject_confirmation_invalid')
  }
  const data = only(
    confirmation,
    NS_ASSERTION,
    'SubjectConfirmationData',
    'subject_confirmation_invalid'
  )
  if (data.getAttribute('Recipient') !== expected.acsUrl) {
    refuse('recipient_mismatch')
  }
  const inResponseTo = data.getAttribute('InResponseTo')
  if (!inResponseTo) {
    refuse('in_response_to_missing')
  }
  if (inResponseTo !== expected.requestId) {
    refuse('in_response_to_mismatch')
  }
  const notOnOrAfter = time(data.getAttribute('NotOnOrAfter'), 'subject_confirmation_invalid')
  if (now >= notOnOrAfter + SAML_CLOCK_SKEW_MS) {
    refuse('expired')
  }
  const notBefore = data.getAttribute('NotBefore')
  if (notBefore && now < time(notBefore, 'subject_confirmation_invalid') - SAML_CLOCK_SKEW_MS) {
    refuse('not_yet_valid')
  }
  return notOnOrAfter
}

function checkConditions(a: Element, expected: SamlExpectations, now: number): void {
  const conditions = only(a, NS_ASSERTION, 'Conditions', 'conditions_missing')
  const notBefore = time(conditions.getAttribute('NotBefore'), 'conditions_missing')
  const notOnOrAfter = time(conditions.getAttribute('NotOnOrAfter'), 'conditions_missing')
  if (now < notBefore - SAML_CLOCK_SKEW_MS) {
    refuse('not_yet_valid')
  }
  if (now >= notOnOrAfter + SAML_CLOCK_SKEW_MS) {
    refuse('expired')
  }
  // Every restriction must be satisfied, and a restriction is satisfied by naming this SP.
  const restrictions = childElements(conditions, NS_ASSERTION, 'AudienceRestriction')
  if (restrictions.length === 0) {
    refuse('audience_mismatch')
  }
  for (const restriction of restrictions) {
    const audiences = childElements(restriction, NS_ASSERTION, 'Audience')
    if (!audiences.some((el) => plainText(el, 'audience_mismatch') === expected.spEntityId)) {
      refuse('audience_mismatch')
    }
  }
}

function readAttributes(a: Element): Record<string, string[]> {
  const attributes: Record<string, string[]> = {}
  const statement = childElements(a, NS_ASSERTION, 'AttributeStatement')
  for (const attribute of statement.flatMap((s) => childElements(s, NS_ASSERTION, 'Attribute'))) {
    const name = attribute.getAttribute('Name')
    if (!name) {
      refuse('attribute_invalid')
    }
    const values = childElements(attribute, NS_ASSERTION, 'AttributeValue').map((v) =>
      plainText(v, 'attribute_invalid')
    )
    attributes[name as string] = [...(attributes[name as string] ?? []), ...values]
  }
  return attributes
}
