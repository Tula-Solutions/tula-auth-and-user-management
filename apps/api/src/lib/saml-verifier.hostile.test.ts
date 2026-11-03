import { describe, expect, test } from 'bun:test'
import { SignedXml } from 'xml-crypto'
import {
  buildMockSamlResponse,
  MOCK_SAML_KEYS,
  type MockSamlOptions,
} from '~/adapters/oauth/mock-saml'
import { createTestDeps } from '~/testing'
import { type SamlExpectations, type SamlRefusal, verify } from './saml-verifier'

/*
 * The rows the verifier's table (saml-verifier.test.ts) cannot reach with the mock's own
 * failures: hand-built documents, re-signed where the mutation is inside the assertion.
 */

const SP = 'https://auth.example.com/v1/environments/env_1/saml/metadata'
const ACS = 'https://auth.example.com/v1/environments/env_1/saml/acs'
const IDP = 'https://idp.example.com/entity'
const REQUEST = '_req1'
const expected: SamlExpectations = {
  spEntityId: SP,
  acsUrl: ACS,
  requestId: REQUEST,
  idpEntityId: IDP,
  certificates: [MOCK_SAML_KEYS.a.certificate, MOCK_SAML_KEYS.b.certificate],
}
const SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256'
const C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#'
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature'
const DIGEST = 'http://www.w3.org/2001/04/xmlenc#sha256'
const ASSERTION = "//*[local-name(.)='Assertion']"

const b64 = (xml: string) => Buffer.from(xml).toString('base64')
const iso = (ms: number) => new Date(ms).toISOString()
const bare = (pem: string) => pem.replace(/-----[A-Z ]+-----|\s+/g, '')
const ASSERTION_XML = /<saml:Assertion[\s\S]*<\/saml:Assertion>/

function mock(deps: ReturnType<typeof createTestDeps>, o: Partial<MockSamlOptions> = {}) {
  return Buffer.from(
    buildMockSamlResponse({
      mockProviderEnabled: true,
      spEntityId: SP,
      acsUrl: ACS,
      idpEntityId: IDP,
      requestId: REQUEST,
      subject: 'ada@example.com',
      attributes: { email: ['ada@example.com'] },
      now: deps.clock.now(),
      ...o,
    }),
    'base64'
  ).toString()
}

interface SignOptions {
  key?: keyof typeof MOCK_SAML_KEYS
  extraReference?: string
  keyInfoNames?: string
}

/** Sign the (unsigned) assertion of a document the way an IdP would, with these deviations. */
function resign(xml: string, o: SignOptions = {}): string {
  const material = MOCK_SAML_KEYS[o.key ?? 'a']
  const sig = new SignedXml({
    privateKey: material.privateKey,
    publicCert: material.certificate,
    signatureAlgorithm: SHA256,
    canonicalizationAlgorithm: C14N,
    ...(o.keyInfoNames && {
      getKeyInfoContent: () =>
        `<X509Data><X509Certificate>${o.keyInfoNames}</X509Certificate></X509Data>`,
    }),
  })
  for (const xpath of [ASSERTION, ...(o.extraReference ? [o.extraReference] : [])]) {
    sig.addReference({ xpath, transforms: [ENVELOPED, C14N], digestAlgorithm: DIGEST })
  }
  sig.computeSignature(xml, {
    location: { reference: `${ASSERTION}/*[local-name(.)='Issuer']`, action: 'after' },
  })
  return sig.getSignedXml()
}

async function refused(xml: string, reason: SamlRefusal) {
  expect(await verify(createTestDeps(), b64(xml), expected)).toEqual({ ok: false, reason })
}

/** The unsigned document, its hand-signed form and an attacker's assertion, to take apart. */
function parts() {
  const deps = createTestDeps()
  const unsigned = mock(deps, { failure: 'unsigned' })
  const signed = resign(unsigned)
  const assertion = ASSERTION_XML.exec(signed)?.[0] ?? ''
  const evil = (ASSERTION_XML.exec(unsigned)?.[0] ?? '')
    .replace('ada@example.com</saml:NameID>', 'eve@example.com</saml:NameID>')
    .replace(/ ID="[^"]*"/, ' ID="_evil"')
  return { deps, unsigned, signed, assertion, evil }
}

describe('signature wrapping and structure', () => {
  test('the base document, signed by hand, is accepted', async () => {
    const { deps, signed } = parts()
    expect((await verify(deps, b64(signed), expected)).ok).toBe(true)
  })

  test('the signed assertion moved into Advice of an unsigned one is refused', async () => {
    const { signed, assertion, evil } = parts()
    const wrapped = evil.replace(
      '</saml:Assertion>',
      `<saml:Advice>${assertion}</saml:Advice></saml:Assertion>`
    )
    await refused(signed.replace(assertion, wrapped), 'multiple_assertions')
  })

  test('the signed assertion moved into Extensions beside an unsigned one is refused', async () => {
    const { signed, assertion, evil } = parts()
    const wrapped = `<samlp:Extensions>${assertion}</samlp:Extensions>${evil}`
    await refused(signed.replace(assertion, wrapped), 'multiple_assertions')
  })

  test('an unsigned assertion placed BEFORE the signed one is refused', async () => {
    const { signed, assertion, evil } = parts()
    await refused(signed.replace(assertion, evil + assertion), 'multiple_assertions')
  })

  test('a decoy element carrying the signed assertion id is refused', async () => {
    const { signed } = parts()
    const id = /<saml:Assertion[^>]* ID="([^"]*)"/.exec(signed)?.[1]
    const decoy = `<samlp:Extensions><x:Decoy xmlns:x="urn:x" ID="${id}"/></samlp:Extensions>`
    const verdict = await verify(
      createTestDeps(),
      b64(signed.replace('</samlp:Status>', `</samlp:Status>${decoy}`)),
      expected
    )
    expect(verdict.ok).toBe(false)
  })

  test('the assertion signature moved into Extensions is refused', async () => {
    const { signed } = parts()
    const signature = /<Signature[\s\S]*<\/Signature>/.exec(signed)?.[0] ?? ''
    expect(signature).not.toBe('')
    const moved = signed
      .replace(signature, '')
      .replace(
        '</samlp:Status>',
        `</samlp:Status><samlp:Extensions>${signature}</samlp:Extensions>`
      )
    const verdict = await verify(createTestDeps(), b64(moved), expected)
    expect(verdict.ok).toBe(false)
  })

  test('a signature with a second Reference is refused (CVE-2025-29774)', async () => {
    const { deps, unsigned } = parts()
    const signed = resign(unsigned, { extraReference: '/*' })
    expect(await verify(deps, b64(signed), expected)).toEqual({
      ok: false,
      reason: 'signature_invalid',
    })
  })

  test('an EncryptedAssertion is refused', async () => {
    const { signed } = parts()
    await refused(
      signed.replace('</samlp:Response>', '<saml:EncryptedAssertion/></samlp:Response>'),
      'encrypted_assertion_unsupported'
    )
  })
})

describe('algorithms', () => {
  // The shape is judged before any key is used, so an attribute can be swapped on a signed document.
  const rows: [string, string, string][] = [
    ['SHA-1 signature', SHA256, 'http://www.w3.org/2000/09/xmldsig#rsa-sha1'],
    ['HMAC signature', SHA256, 'http://www.w3.org/2001/04/xmldsig-more#hmac-sha256'],
    ['SHA-1 digest', DIGEST, 'http://www.w3.org/2000/09/xmldsig#sha1'],
    [
      'inclusive c14n',
      `CanonicalizationMethod Algorithm="${C14N}"`,
      'CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"',
    ],
    [
      'XSLT transform',
      `Transform Algorithm="${ENVELOPED}"`,
      'Transform Algorithm="http://www.w3.org/TR/1999/REC-xslt-19991116"',
    ],
  ]
  for (const [name, from, to] of rows) {
    test(`refuses a ${name}`, async () => {
      const { signed } = parts()
      expect(signed).toContain(from)
      await refused(signed.replace(from, to), 'signature_algorithm_refused')
    })
  }
})

describe('KeyInfo is never trusted', () => {
  test('an attacker key whose KeyInfo names a configured certificate is refused', async () => {
    const { deps, unsigned } = parts()
    const forged = resign(unsigned, { key: 'c', keyInfoNames: bare(MOCK_SAML_KEYS.a.certificate) })
    expect(forged).toContain(bare(MOCK_SAML_KEYS.a.certificate))
    expect(await verify(deps, b64(forged), expected)).toEqual({
      ok: false,
      reason: 'signature_invalid',
    })
  })
})

describe('times', () => {
  const swap = (xml: string, pattern: RegExp, value: string) => {
    expect(xml).toMatch(pattern)
    return xml.replace(pattern, value)
  }
  const confirmation = /(<saml:SubjectConfirmationData [^>]*?)NotOnOrAfter="[^"]*"/
  const conditions = /<saml:Conditions NotBefore="[^"]*"/

  async function run(mutate: (xml: string, now: number) => string) {
    const deps = createTestDeps()
    const now = deps.clock.now().getTime()
    const xml = resign(mutate(mock(deps, { failure: 'unsigned' }), now))
    return verify(deps, b64(xml), expected)
  }

  test('SubjectConfirmationData NotOnOrAfter alone expires the response', async () => {
    const verdict = await run((xml, now) =>
      swap(xml, confirmation, `$1NotOnOrAfter="${iso(now - 600_000)}"`)
    )
    expect(verdict).toEqual({ ok: false, reason: 'expired' })
  })

  test('SubjectConfirmationData NotBefore alone makes it not yet valid', async () => {
    const verdict = await run((xml, now) =>
      swap(
        xml,
        confirmation,
        `$1NotBefore="${iso(now + 600_000)}" NotOnOrAfter="${iso(now + 900_000)}"`
      )
    )
    expect(verdict).toEqual({ ok: false, reason: 'not_yet_valid' })
  })

  const places: [string, (xml: string, at: string) => string][] = [
    ['Conditions', (xml, at) => swap(xml, conditions, `<saml:Conditions NotBefore="${at}"`)],
    [
      'SubjectConfirmationData',
      (xml, at) =>
        swap(
          xml,
          confirmation,
          `$1NotBefore="${at}" NotOnOrAfter="${iso(Date.parse(at) + 600_000)}"`
        ),
    ],
  ]
  for (const [where, mutate] of places) {
    test(`${where} NotBefore one minute ahead is within the skew`, async () => {
      const verdict = await run((xml, now) => mutate(xml, iso(now + 60_000)))
      expect(verdict.ok).toBe(true)
    })
    test(`${where} NotBefore three minutes ahead is refused`, async () => {
      const verdict = await run((xml, now) => mutate(xml, iso(now + 180_000)))
      expect(verdict).toEqual({ ok: false, reason: 'not_yet_valid' })
    })
  }
})

describe('audiences, confirmations and the rest of the response', () => {
  const audience = `<saml:Audience>${SP}</saml:Audience>`
  const restriction = `<saml:AudienceRestriction>${audience}</saml:AudienceRestriction>`
  const other = '<saml:Audience>https://other.example/sp</saml:Audience>'
  const confirmation = /<saml:SubjectConfirmation [\s\S]*<\/saml:SubjectConfirmation>/

  async function run(mutate: (xml: string) => string) {
    const deps = createTestDeps()
    const unsigned = mock(deps, { failure: 'unsigned' })
    expect(unsigned).toContain(restriction)
    return verify(deps, b64(resign(mutate(unsigned))), expected)
  }

  test('two restrictions, both naming this SP, are accepted', async () => {
    expect((await run((x) => x.replace(restriction, restriction + restriction))).ok).toBe(true)
  })

  test('a second restriction that does not name this SP is refused', async () => {
    const verdict = await run((x) =>
      x.replace(
        restriction,
        `${restriction}<saml:AudienceRestriction>${other}</saml:AudienceRestriction>`
      )
    )
    expect(verdict).toEqual({ ok: false, reason: 'audience_mismatch' })
  })

  test('several Audience elements in one restriction, one of them this SP, are accepted', async () => {
    expect((await run((x) => x.replace(audience, other + audience))).ok).toBe(true)
  })

  test('several Audience elements, none this SP, are refused', async () => {
    const verdict = await run((x) => x.replace(audience, other + other.replace('other', 'another')))
    expect(verdict).toEqual({ ok: false, reason: 'audience_mismatch' })
  })

  test('no SubjectConfirmation is refused', async () => {
    const verdict = await run((x) => x.replace(confirmation, ''))
    expect(verdict).toEqual({ ok: false, reason: 'subject_confirmation_invalid' })
  })

  test('two SubjectConfirmation elements are refused', async () => {
    const verdict = await run((x) => {
      const one = confirmation.exec(x)?.[0] ?? ''
      return x.replace(one, one + one)
    })
    expect(verdict).toEqual({ ok: false, reason: 'subject_confirmation_invalid' })
  })

  test('a comment inside an attribute value is refused', async () => {
    const verdict = await run((x) =>
      x.replace(
        '<saml:AttributeValue>ada@example.com',
        '<saml:AttributeValue>ada@example.com<!---->.evil'
      )
    )
    expect(verdict).toEqual({ ok: false, reason: 'attribute_invalid' })
  })

  test('a Response without Destination is refused', async () => {
    const { signed } = parts()
    expect(signed).toContain(` Destination="${ACS}"`)
    await refused(signed.replace(` Destination="${ACS}"`, ''), 'destination_mismatch')
  })

  test('a Status without a StatusCode is refused', async () => {
    const { signed } = parts()
    await refused(signed.replace(/<samlp:StatusCode [^>]*\/>/, ''), 'status_not_success')
  })
})

describe('parse errors and replay across connections', () => {
  const protocol = 'xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"'
  const bad: [string, string][] = [
    ['an unclosed element', `<samlp:Response ${protocol}><a></samlp:Response>`],
    ['an undeclared prefix', '<samlp:Response><saml:Issuer/></samlp:Response>'],
    ['text before the root', `junk<samlp:Response ${protocol}/>`],
  ]
  for (const [name, xml] of bad) {
    test(`${name} is refused as malformed`, async () => {
      await refused(xml, 'malformed')
    })
  }

  test('the same assertion id from two identity providers does not collide', async () => {
    const deps = createTestDeps()
    const other = 'https://idp2.example.com/entity'
    const make = (idpEntityId: string) =>
      buildMockSamlResponse({
        mockProviderEnabled: true,
        spEntityId: SP,
        acsUrl: ACS,
        idpEntityId,
        requestId: REQUEST,
        subject: 'a@example.com',
        now: deps.clock.now(),
        assertionId: '_same',
      })
    const [first, second] = [make(IDP), make(other)]
    const second_expected = { ...expected, idpEntityId: other }
    expect((await verify(deps, first, expected)).ok).toBe(true)
    expect((await verify(deps, second, second_expected)).ok).toBe(true)
    expect(await verify(deps, first, expected)).toEqual({ ok: false, reason: 'replayed' })
    expect(await verify(deps, second, second_expected)).toEqual({ ok: false, reason: 'replayed' })
  })
})
