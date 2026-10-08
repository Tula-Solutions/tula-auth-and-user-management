import type { OAuthProvider as OAuthProviderName } from '@tula/contract'

/** What a provider says about the account that just authorized, in one shape for all of them. */
export interface OAuthProfile {
  /**
   * The provider's stable id for the account: the `sub` of an ID token, GitHub's numeric user
   * id, Microsoft's tenant id and object id (`<tid>:<oid>`), Discord's user id (a snowflake).
   * Never a login name or an email address, both of which can change hands.
   */
  subject: string
  /** The account's email address, or `null` when the provider shared none. */
  email: string | null
  /** Whether **the provider** asserts the address is verified. `false` when it says nothing. */
  emailVerified: boolean
  /** Display names. Untrusted, display-only: never used to find or match an account. */
  givenName?: string
  familyName?: string
}

/** An environment's own credentials for one provider, opened from the secret box. */
export interface OAuthCredentials {
  clientId: string
  /** Google, GitHub, Microsoft, Discord, LinkedIn. */
  clientSecret?: string
  /** Apple: the developer team id. */
  teamId?: string
  /** Apple: the id of the signing key. */
  keyId?: string
  /** Apple: the PKCS#8 private key (PEM) the client-secret JWT is signed with. */
  privateKey?: string
  /**
   * Microsoft: which accounts may sign in (`common`, `organizations`, `consumers` or a tenant
   * id). Not a secret.
   */
  tenant?: string
}

/** What an authorization URL is built from. All of it is kept server-side on the attempt. */
export interface OAuthAuthorizationRequest {
  /** Random, single use. The only link between the provider's answer and the attempt. */
  state: string
  /** PKCE verifier (RFC 7636). The URL carries only its S256 challenge (not sent to Apple). */
  codeVerifier: string
  /** Bound into the ID token by OIDC providers, and checked when it comes back. */
  nonce: string
  /** This API's callback URL for the provider. */
  redirectUri: string
}

/** What the provider's answer is exchanged with. */
export interface OAuthCodeExchange {
  code: string
  codeVerifier: string
  nonce: string
  redirectUri: string
  /**
   * Apple only: the raw `user` field of the form post, sent on the first authorization. It is
   * not signed, so only a display name is ever read from it.
   */
  user?: string
}

/** Why an exchange failed. Deliberately coarse: none of it is shown to a user. */
export type OAuthFailure =
  /** The provider refused the code (wrong, used, expired, wrong verifier). */
  | 'invalid_grant'
  /** The provider could not be reached or answered with something unusable. */
  | 'unavailable'
  /** An ID token that does not verify: signature, issuer, audience, expiry or nonce. */
  | 'invalid_token'
  /** The profile could not be read or has no stable subject. */
  | 'invalid_profile'

/**
 * An exchange that failed. Carries a {@link OAuthFailure} and nothing from the provider's
 * response: neither a token nor the provider's own error text may reach a log or a client.
 */
export class OAuthProviderError extends Error {
  constructor(readonly failure: OAuthFailure) {
    super(`oauth provider: ${failure}`)
    this.name = 'OAuthProviderError'
  }
}

/**
 * One OAuth provider's protocol: where to send the user, and how to turn the code that comes
 * back into a profile (ADR 0026).
 *
 * Adapters are stateless: the environment's credentials are passed to every call. They return a
 * {@link OAuthProfile} and nothing else. **No provider access token, refresh token or ID token
 * leaves an adapter**: Tula signs users in with a provider, it does not call provider APIs on
 * their behalf.
 *
 * Phase 2 adds native sign-in (Google and Apple hand an app an ID token directly). That is a
 * second method here, `verifyIdToken(credentials, idToken, nonce)`, sharing the ID-token
 * verification the OIDC adapters already have. It is deliberately not declared yet.
 */
export interface OAuthProvider {
  /**
   * @param credentials - The environment's credentials for this provider.
   * @param request - State, PKCE verifier, nonce and this API's callback URL.
   * @returns The provider's consent page for this attempt.
   */
  authorizationUrl(credentials: OAuthCredentials, request: OAuthAuthorizationRequest): string

  /**
   * Exchange an authorization code for the account's profile.
   *
   * @param credentials - The environment's credentials for this provider.
   * @param exchange - The code, and what the attempt stored when it started.
   * @returns The profile.
   * @throws OAuthProviderError for every failure.
   */
  exchange(credentials: OAuthCredentials, exchange: OAuthCodeExchange): Promise<OAuthProfile>
}

/** The adapter of every provider. `container.ts` picks them. */
export type OAuthProviders = Record<OAuthProviderName, OAuthProvider>
