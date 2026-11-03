import {
  EMAIL_LINK_ATTEMPT_PARAM,
  OAUTH_ERROR_PARAM,
  OAUTH_TICKET_PARAM,
} from '@tula-tech/contract/headers'
import { SandboxError } from './errors'
import type { OAuthProfile, OAuthRequest, SandboxProvider } from './types'
import { DEMO_EMAIL, type World } from './world'

// The provider's side of a round trip, in the sandbox. A real provider is a page on another
// site; here it is a consent screen the playground draws, labelled as a sandbox. These
// functions are what its two buttons do: approve (the provider vouches for a person and the
// browser goes back with a ticket) or deny (the browser goes back with an error code).

/** The ordinary name of each provider, for the consent screen's wordmark. */
export const PROVIDER_NAMES: Record<SandboxProvider, string> = {
  google: 'Google',
  github: 'GitHub',
  apple: 'Apple',
  microsoft: 'Microsoft',
  discord: 'Discord',
  linkedin: 'LinkedIn',
  x: 'X',
  facebook: 'Facebook',
}

/**
 * The people a sandbox provider can vouch for: a returning user whose address matches an
 * account (the provider says it is verified, so it signs in to that account), and a new person.
 *
 * @param provider - The provider.
 * @returns Two profiles.
 */
export function sandboxProfiles(provider: SandboxProvider): OAuthProfile[] {
  return [
    { subject: `${provider}:ada`, email: DEMO_EMAIL, name: 'Ada Lovelace' },
    { subject: `${provider}:alex`, email: `alex.${provider}@example.test`, name: 'Alex Sandbox' },
  ]
}

/**
 * The provider round trip an attempt is waiting on.
 *
 * @param world - The sandbox.
 * @param attemptId - The attempt the authorization URL carries.
 * @returns What the consent screen needs, or `null` for an attempt that is not at a provider.
 */
export function pendingOAuth(world: World, attemptId: string): OAuthRequest | null {
  const attempt = world.attempts.get(attemptId)
  if (!attempt?.oauth || attempt.oauth.result !== null || attempt.expiresAt <= world.now()) {
    return null
  }
  return { attemptId, provider: attempt.oauth.provider, redirectUrl: attempt.oauth.redirectUrl }
}

/**
 * Read the attempt id out of an authorization URL the client was sent to.
 *
 * @param url - The URL `startOAuthSignIn` answered with.
 * @returns The attempt id, or `null` for a URL that is not the sandbox's.
 */
export function attemptOfAuthorizationUrl(url: string): string | null {
  try {
    return new URL(url).searchParams.get('attempt')
  } catch {
    return null
  }
}

/**
 * The provider vouches for a person: the browser goes back to the app with a ticket.
 *
 * @param world - The sandbox.
 * @param attemptId - The attempt.
 * @param profile - Who approved.
 * @returns The address the browser returns to, ticket in its fragment as the real callback sets it.
 * @throws SandboxError `oauth.state_invalid` for an attempt that is not at a provider.
 */
export function approveOAuth(world: World, attemptId: string, profile: OAuthProfile): string {
  const attempt = world.attempts.get(attemptId)
  if (!attempt?.oauth || attempt.oauth.result !== null) {
    throw new SandboxError('oauth.state_invalid')
  }
  const ticket = `sbx_ot_${world.secret(18)}`
  attempt.oauth.result = { ticket, expiresAt: world.now() + 60_000, profile, used: false }
  const fragment = new URLSearchParams({
    [OAUTH_TICKET_PARAM]: ticket,
    [EMAIL_LINK_ATTEMPT_PARAM]: attempt.id,
  })
  return `${attempt.oauth.redirectUrl}#${fragment.toString()}`
}

/**
 * The person refuses on the provider's page: the browser goes back with an error code.
 *
 * @param world - The sandbox.
 * @param attemptId - The attempt.
 * @returns The address the browser returns to.
 * @throws SandboxError `oauth.state_invalid` for an attempt that is not at a provider.
 */
export function denyOAuth(world: World, attemptId: string): string {
  const attempt = world.attempts.get(attemptId)
  if (!attempt?.oauth || attempt.oauth.result !== null) {
    throw new SandboxError('oauth.state_invalid')
  }
  // The state is spent either way, as the real callback's is.
  attempt.oauth.result = {
    ticket: '',
    expiresAt: 0,
    profile: { subject: '', email: '', name: '' },
    used: true,
  }
  const fragment = new URLSearchParams({
    [OAUTH_ERROR_PARAM]: 'oauth.access_denied',
    [EMAIL_LINK_ATTEMPT_PARAM]: attempt.id,
  })
  return `${attempt.oauth.redirectUrl}#${fragment.toString()}`
}
