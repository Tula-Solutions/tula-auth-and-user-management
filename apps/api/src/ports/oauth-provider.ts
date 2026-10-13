import type { OAuthProvider as OAuthProviderName } from '@tula/contract'

/** What a provider says about the account that just authorized, in one shape for all of them. */
export interface OAuthProfile {
  /**
   * The provider's stable id for the account: the `sub` of an ID token, GitHub's numeric user
   * id, Microsoft's tenant id and object id (`<tid>:<oid>`), Discord's user id (a snowflake),
   * X's user id, Facebook's app-scoped user id (decimal numbers in a string). Never a login name or an email address, both of which can change hands.
   */
  subject: string
  /**
   * The account's email address, or `null` when the provider shared none. Always `null` from
   * X and Facebook, whose adapters ask for none (`OAUTH_PROVIDERS_WITHOUT_ADDRESS`).
   */
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
  /** Google, GitHub, Microsoft, Discord, LinkedIn, X, Facebook (its app secret). */
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
  /**
   * Google: the client ids of the operator's native apps, accepted beside `clientId` as the
   * audience of an ID token a native app hands over (ADR 0045). Not secrets. Read only
   * through `OAuth.idTokenAudiences`; the code flow accepts `clientId` alone.
   */
  additionalClientIds?: string[]
}

/**
 * An ID token a native app was handed by the provider's own SDK, and what it must match
 * (ADR 0045, ADR 0047).
 */
export interface OAuthIdTokenExchange {
  /** The token as the app sent it. Never logged, stored or returned. */
  idToken: string
  /**
   * The audiences the token may have been issued for, as `OAuth.idTokenAudiences` put them
   * together: for Google the environment's own `clientId` and its `additionalClientIds`,
   * for Apple the bundle ids of the environment's registered iOS apps. `aud` must be one of
   * them, and so must `azp` when the token has one. Data: an adapter reads no store.
   */
  audiences: readonly string[]
  /**
   * The nonce the attempt was started with, as the server made it. How the token must carry
   * it is the adapter's to know, and each adapter accepts exactly one form: Google's `nonce`
   * claim is exactly this string, Apple's is the lowercase hexadecimal SHA-256 of it.
   */
  nonce: string
  /**
   * Apple only: the name the system's sheet handed the app on the first authorization, as
   * the app passed it on. Apple's ID token carries no name. **Not signed by anyone**, as the
   * `user` field of Apple's form post is not: only a display name is ever read from it. An
   * adapter whose token carries its own names does not read it.
   */
  user?: { givenName?: string; familyName?: string }
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
 * Native sign-in (ADR 0045) is the second way to a profile: a provider's SDK hands an app an
 * ID token directly, and {@link OAuthProvider.verifyIdToken} verifies it. Only a provider of
 * the contract's `ID_TOKEN_PROVIDERS` has the method; for every other one it is absent, and
 * the flow answers as for a provider that is off.
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

  /**
   * Verify an ID token a native app was handed by the provider, and read the account's
   * profile from it (ADR 0045). Absent for a provider that has no such exchange.
   *
   * Checked, all of it, before anything is returned: the signature against the provider's
   * published keys (a pinned algorithm, never the one the token names), the issuer, the
   * expiry, that `aud` is one of `exchange.audiences` (and `azp`, when present), that
   * `nonce` is `exchange.nonce` in the provider's one accepted form (as issued for Google,
   * its SHA-256 for Apple), and that there is a subject. The profile is the
   * same shape the code flow returns, and nothing else of the token leaves the adapter.
   *
   * @param credentials - The environment's credentials for this provider.
   * @param exchange - The token, the accepted audiences and the attempt's nonce.
   * @returns The profile.
   * @throws OAuthProviderError `invalid_token` for a token that does not verify, whatever
   *   was wrong with it; `invalid_profile` for one without a subject; `unavailable` when
   *   the provider's keys could not be fetched (which says nothing about the token).
   */
  verifyIdToken?(
    credentials: OAuthCredentials,
    exchange: OAuthIdTokenExchange
  ): Promise<OAuthProfile>
}

/** The adapter of every provider. `container.ts` picks them. */
export type OAuthProviders = Record<OAuthProviderName, OAuthProvider>
