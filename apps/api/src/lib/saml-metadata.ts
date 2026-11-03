import { X509Certificate } from 'node:crypto'
import { DOMParser, type Element } from '@xmldom/xmldom'
import { escapeHtml } from '~/modules/email/templates'

/*
 * SAML metadata (ADR 0067): reading an identity provider's, and writing the service
 * provider's own. Reading is about *values*, not trust: nothing here checks a signature on
 * the metadata, because the operator chose where it came from; what the metadata says is only
 * ever used to configure a connection, and every response is still verified against it.
 */

const NS_MD = 'urn:oasis:names:tc:SAML:2.0:metadata'
const NS_DSIG = 'http://www.w3.org/2000/09/xmldsig#'
const BINDING_REDIRECT = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect'
const BINDING_POST = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST'
/** The one NameID format a sign-in asks for: the address is what an account is matched on. */
export const SAML_NAME_ID_FORMAT = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'

/** Every reason metadata or a certificate is refused. Fixed words: nothing of the input is in one. */
export const SAML_METADATA_REFUSALS = [
  'malformed',
  'forbidden_xml',
  'no_idp',
  'no_sso_url',
  'no_certificate',
  'certificate_invalid',
] as const

/** One of {@link SAML_METADATA_REFUSALS}. */
export type SamlMetadataRefusal = (typeof SAML_METADATA_REFUSALS)[number]

/** Thrown for metadata that cannot be used; `reason` is a fixed word. */
export class SamlMetadataError extends Error {
  constructor(readonly reason: SamlMetadataRefusal) {
    super(reason)
  }
}

/** What an identity provider's metadata gives a connection. */
export interface IdpMetadata {
  idpEntityId: string
  /** The HTTP-Redirect single sign-on URL. */
  ssoUrl: string
  /** Signing certificates as bare base64, at most the first two. */
  certificates: string[]
}

function children(parent: Element, ns: string, local: string): Element[] {
  const found: Element[] = []
  for (let n = parent.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && n.namespaceURI === ns && (n as Element).localName === local) {
      found.push(n as Element)
    }
  }
  return found
}

/**
 * Read an identity provider's metadata: its entity id, its HTTP-Redirect single sign-on URL
 * and its **signing** certificates (a key marked `use="encryption"` is never taken).
 *
 * A document type declaration (hence any entity) is refused outright.
 *
 * @param xml - The metadata document.
 * @returns The values.
 * @throws SamlMetadataError with a fixed reason.
 */
export function parseIdpMetadata(xml: string): IdpMetadata {
  if (xml.length > 512 * 1024) {
    throw new SamlMetadataError('malformed')
  }
  // Before any parser sees it, as the response verifier does: a DTD is where entities live.
  if (/<!\s*(DOCTYPE|ENTITY)/i.test(xml)) {
    throw new SamlMetadataError('forbidden_xml')
  }
  let root: Element | null
  let doctype: unknown
  try {
    const doc = new DOMParser({
      onError: (_level: string, message: string): never => {
        throw new Error(message)
      },
    }).parseFromString(xml, 'text/xml')
    doctype = doc.doctype
    root = doc.documentElement
  } catch {
    throw new SamlMetadataError('malformed')
  }
  if (doctype) {
    throw new SamlMetadataError('forbidden_xml')
  }
  if (!root || root.namespaceURI !== NS_MD) {
    throw new SamlMetadataError('malformed')
  }
  const entities =
    root.localName === 'EntityDescriptor'
      ? [root]
      : root.localName === 'EntitiesDescriptor'
        ? children(root, NS_MD, 'EntityDescriptor')
        : []
  const entity = entities.length === 1 ? entities[0] : undefined
  const idp = entity && children(entity, NS_MD, 'IDPSSODescriptor')[0]
  const idpEntityId = entity?.getAttribute('entityID')
  if (!entity || !idp || !idpEntityId) {
    throw new SamlMetadataError('no_idp')
  }
  const ssoUrl = children(idp, NS_MD, 'SingleSignOnService')
    .find((s) => s.getAttribute('Binding') === BINDING_REDIRECT)
    ?.getAttribute('Location')
  if (!ssoUrl) {
    throw new SamlMetadataError('no_sso_url')
  }
  const certificates: string[] = []
  for (const key of children(idp, NS_MD, 'KeyDescriptor')) {
    if (key.getAttribute('use') === 'encryption') {
      continue
    }
    for (const info of children(key, NS_DSIG, 'KeyInfo')) {
      for (const data of children(info, NS_DSIG, 'X509Data')) {
        for (const cert of children(data, NS_DSIG, 'X509Certificate')) {
          certificates.push((cert.textContent ?? '').replace(/\s+/g, ''))
        }
      }
    }
  }
  if (certificates.length === 0) {
    throw new SamlMetadataError('no_certificate')
  }
  return { idpEntityId, ssoUrl, certificates: certificates.slice(0, 2) }
}

/** A certificate as the PEM the verifier and the store use. */
export interface CertificateInfo {
  pem: string
  /** When it stops being valid. */
  notAfter: Date
  /** SHA-256 of the DER, as colon-separated hex: how an operator recognizes it. */
  fingerprint: string
}

/**
 * Read a certificate given as PEM or bare base64.
 *
 * @param cert - The certificate.
 * @returns Its PEM, expiry and fingerprint.
 * @throws SamlMetadataError `certificate_invalid` when it does not parse.
 */
export function readCertificate(cert: string): CertificateInfo {
  const body = cert.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '')
  const pem = `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)?.join('\n') ?? ''}\n-----END CERTIFICATE-----\n`
  try {
    const x509 = new X509Certificate(pem)
    return { pem, notAfter: new Date(x509.validTo), fingerprint: x509.fingerprint256 }
  } catch {
    throw new SamlMetadataError('certificate_invalid')
  }
}

/**
 * The service provider's own metadata for one connection: its entity id, and an assertion
 * consumer service that takes the HTTP-POST binding, with the NameID format it asks for.
 * It asks for signed assertions and sends unsigned requests.
 *
 * @param sp - The entity id and the ACS URL.
 * @returns The metadata XML.
 */
export function buildSpMetadata(sp: { entityId: string; acsUrl: string }): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<md:EntityDescriptor xmlns:md="${NS_MD}" entityID="${escapeHtml(sp.entityId)}">` +
    '<md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">' +
    `<md:NameIDFormat>${SAML_NAME_ID_FORMAT}</md:NameIDFormat>` +
    `<md:AssertionConsumerService Binding="${BINDING_POST}" Location="${escapeHtml(sp.acsUrl)}" index="0" isDefault="true"/>` +
    '</md:SPSSODescriptor></md:EntityDescriptor>'
  )
}
