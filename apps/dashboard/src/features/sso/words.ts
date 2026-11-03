import { messageFor, toApiError } from '~/api/errors'
import { own } from '~/lib/own'

// The sentences the SSO section says about a refusal and a certificate. The rules (which
// change is a weakening) are the server's, `weakens` in `modules/sso-connection/service.ts`;
// only the words are the dashboard's.

/** The code the server answers while an environment has single sign-on switched off. */
export const SSO_DISABLED_CODE = 'sso.disabled'

/** A certificate that ends within this many days is warned about. */
export const CERTIFICATE_WARNING_DAYS = 30

/**
 * Whether a failure is the environment having single sign-on switched off.
 *
 * @param error - What a query or mutation threw.
 * @returns True for `sso.disabled`.
 */
export function isSsoDisabled(error: unknown): boolean {
  return toApiError(error).code === SSO_DISABLED_CODE
}

const SENTENCES: Record<string, string> = {
  [SSO_DISABLED_CODE]:
    'Single sign-on is switched off in this environment. Switch it on in Organization settings first.',
  'sso.name_taken': 'This organization already has a connection with that name.',
  'sso.domain_taken': 'Another connection already uses one of those domains.',
  'sso.domain_not_verified':
    'Every domain must be verified for this organization first. Claim and verify it under Domains.',
  'sso.issuer_not_allowed': 'That address cannot be used: it is not a public https address.',
  'sso.saml_invalid':
    'The identity provider values were not accepted. Give the metadata (pasted or as an address) or the entity id, sign-in URL and certificate.',
  'sso.connection_in_use':
    'People have signed in through this connection. Disable it instead of deleting it.',
  'sso.invalid_transition': 'The connection cannot move to that status from where it is.',
}

/**
 * The words for a refused SSO request.
 *
 * @param error - What a mutation threw.
 * @returns A sentence for the person at the screen.
 */
export function ssoMessageFor(error: unknown): string {
  const failure = toApiError(error)
  return own(SENTENCES, failure.code) ?? messageFor(failure)
}

/** How a certificate stands: fine, ending soon, or over. */
export type CertificateStanding = 'ok' | 'soon' | 'expired'

/**
 * Where a certificate stands against the browser's clock.
 *
 * @param certificate - Its end and the server's own `expired` flag.
 * @param now - The time to judge by.
 * @returns `expired`, `soon` (within {@link CERTIFICATE_WARNING_DAYS}) or `ok`.
 */
export function certificateStanding(
  certificate: { notAfter: string; expired: boolean },
  now: number
): CertificateStanding {
  const end = Date.parse(certificate.notAfter)
  if (certificate.expired || end <= now) {
    return 'expired'
  }
  return end - now <= CERTIFICATE_WARNING_DAYS * 86_400_000 ? 'soon' : 'ok'
}
