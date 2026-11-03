import { type SsoWeakening, ssoWeakenings } from '@tula-tech/contract'
import { messageFor, toApiError } from '~/api/errors'
import type { SsoConnection, UpdateSsoConnectionRequest } from '~/api/generated/api.gen'
import { own } from '~/lib/own'
import { printableName } from '~/lib/printable'

// The sentences the SSO section says about a refusal and a certificate. The rule (which
// change is a weakening) is the contract's `ssoWeakenings`; only the words are the dashboard's.

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
  'sso.connection_in_use': 'This connection is active. Disable it before deleting it.',
  'sso.test_required':
    'Run a test sign-in that passes with the connection’s current settings before activating it.',
  'sso.role_not_allowed':
    'A group cannot be mapped to a system role. Choose one of the organization’s own roles.',
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

const WEAKENING_SENTENCES: Record<SsoWeakening, string> = {
  activate: 'Activating lets people on the bound domains sign in through this connection.',
  active_content:
    'This connection is active, so changing its provider values, role or domains changes who can sign in through it as soon as it is saved.',
  enforcement_off:
    'Turning enforcement off lets people on the bound domains sign in with a password again, not only through this connection.',
  trust_idp_mfa:
    'Trusting the identity provider for two-step verification means people who sign in through it are no longer asked for a second step by Tula.',
  break_glass_role: '',
}

/**
 * What a change to a connection lets through that it did not before, one sentence each.
 *
 * The rule is the contract's `ssoWeakenings`, the same one the server's audit entry uses
 * (`weakened: true`); the dashboard only asks first and words it. Break-glass is about
 * password sign-in alone, so it is never worded as more.
 *
 * @param current - The connection as listed.
 * @param changes - The fields about to be sent.
 * @returns The sentences; empty when nothing is weakened.
 */
export function weakeningSentences(
  current: SsoConnection,
  changes: UpdateSsoConnectionRequest
): string[] {
  return ssoWeakenings(current, changes).map((kind) =>
    kind === 'break_glass_role'
      ? `Anyone with the role ${printableName(String(changes.breakGlassRole))} keeps password sign-in even where enforcement is on.`
      : WEAKENING_SENTENCES[kind]
  )
}
