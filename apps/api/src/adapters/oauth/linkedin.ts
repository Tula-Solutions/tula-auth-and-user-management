import { LinkedIn } from 'arctic'
import type { JWTPayload } from 'jose'
import type {
  OAuthAuthorizationRequest,
  OAuthCodeExchange,
  OAuthCredentials,
  OAuthProfile,
  OAuthProvider,
} from '~/ports/oauth-provider'
import {
  displayName,
  exchangeFailure,
  idTokenOf,
  NONCE_NOT_ECHOED,
  PROVIDER_TIMEOUT_MS,
  type ProviderOptions,
  remoteKeySet,
  verifyIdToken,
  withDeadline,
} from './id-token'

/**
 * What is asked of LinkedIn, the three scopes of "Sign In with LinkedIn using OpenID Connect":
 * `openid` (an ID token), `profile` (the member's id and name) and `email`. Nothing else.
 */
export const LINKEDIN_SCOPES = ['openid', 'profile', 'email']

/**
 * LinkedIn's issuer, in both spellings LinkedIn publishes: its discovery document
 * (`https://www.linkedin.com/oauth/.well-known/openid-configuration`) says
 * `https://www.linkedin.com/oauth`, the table of ID-token claims in its guide says
 * `https://www.linkedin.com`. Which of the two a token carries was not observed; both are
 * LinkedIn's own and the signature is checked against LinkedIn's keys either way.
 */
export const LINKEDIN_ISSUERS = ['https://www.linkedin.com/oauth', 'https://www.linkedin.com']

/** `jwks_uri` of LinkedIn's discovery document. */
const LINKEDIN_KEYS_URL = 'https://www.linkedin.com/oauth/openid/jwks'

function client(credentials: OAuthCredentials, redirectUri: string): LinkedIn {
  return new LinkedIn(credentials.clientId, credentials.clientSecret ?? '', redirectUri)
}

/**
 * The email claims of a LinkedIn ID token, read strictly: LinkedIn documents `email_verified`
 * as a Boolean and both claims as optional. Unlike the shared `emailClaims` (which also takes
 * Apple's string `"true"`), nothing but the JSON boolean `true` counts.
 */
function emailOf(payload: JWTPayload): Pick<OAuthProfile, 'email' | 'emailVerified'> {
  const email = typeof payload.email === 'string' && payload.email !== '' ? payload.email : null
  return { email, emailVerified: email !== null && payload.email_verified === true }
}

/**
 * LinkedIn sign-in: "Sign In with LinkedIn using OpenID Connect".
 *
 * The authorization URL and the code exchange are `arctic`'s `LinkedIn` client (the client id
 * and secret travel in the token request's body, as LinkedIn documents them). The profile is
 * read from the **ID token**, verified with the shared verifier: the signature against
 * LinkedIn's published keys, `RS256` only, the issuer ({@link LINKEDIN_ISSUERS}), the audience
 * (this environment's client id) and the expiry. The userinfo endpoint is never called, so
 * LinkedIn's access token is used for nothing and dropped when the exchange returns.
 *
 * - **Subject: `sub`.** LinkedIn's subjects are pairwise: another LinkedIn app gets another
 *   value for the same member.
 * - **Email: the token's `email`**, verified only when `email_verified` is the JSON boolean
 *   `true`. Both claims are optional.
 *
 * **No PKCE and no nonce, deliberately.** LinkedIn's authorization request for a server-side
 * app documents five parameters (`response_type`, `client_id`, `redirect_uri`, `state`,
 * `scope`) and its token request five; neither names a `code_challenge`, a `code_verifier` or
 * a `nonce`, its discovery document lists no `code_challenge_methods_supported` and no
 * `nonce` among its claims, and `arctic`'s client has a parameter for none of them. The code
 * is therefore bound to the attempt by the single-use `state` and to this app by the client
 * secret, and by nothing else: weaker than every other provider here (ADR 0026).
 *
 * Every outbound call has a deadline (`options.timeoutMs`, ten seconds by default); a provider
 * that does not answer in time is `unavailable`.
 *
 * @param options - The timeout of one outbound call.
 * @returns The adapter.
 */
export function createLinkedInProvider(options: ProviderOptions = {}): OAuthProvider {
  const timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS
  const keys = remoteKeySet(LINKEDIN_KEYS_URL, timeoutMs)
  return {
    authorizationUrl(credentials: OAuthCredentials, request: OAuthAuthorizationRequest): string {
      return client(credentials, request.redirectUri)
        .createAuthorizationURL(request.state, LINKEDIN_SCOPES)
        .toString()
    },

    async exchange(
      credentials: OAuthCredentials,
      exchange: OAuthCodeExchange
    ): Promise<OAuthProfile> {
      let idToken: string
      try {
        idToken = idTokenOf(
          await withDeadline(
            client(credentials, exchange.redirectUri).validateAuthorizationCode(exchange.code),
            timeoutMs
          )
        )
      } catch (error) {
        throw exchangeFailure(error)
      }
      const { payload } = await verifyIdToken(
        keys,
        idToken,
        { audience: credentials.clientId, nonce: NONCE_NOT_ECHOED, issuers: LINKEDIN_ISSUERS },
        timeoutMs
      )
      return {
        subject: payload.sub as string,
        ...emailOf(payload),
        givenName: displayName(payload.given_name),
        familyName: displayName(payload.family_name),
      }
    },
  }
}
