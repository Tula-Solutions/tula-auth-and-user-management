import { LinkedIn } from 'arctic'
import {
  type OAuthAuthorizationRequest,
  type OAuthCodeExchange,
  type OAuthCredentials,
  type OAuthProfile,
  type OAuthProvider,
  OAuthProviderError,
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
import { readProfile } from './profile-read'

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
 * LinkedIn's userinfo endpoint, where its guide ("Sign In with LinkedIn using OpenID Connect")
 * documents the member's address, whether it is verified and the name.
 */
const LINKEDIN_USERINFO_URL = 'https://api.linkedin.com/v2/userinfo'

/**
 * The profile of a LinkedIn member, from a userinfo answer and the subject of the ID token
 * that was verified for the same exchange.
 *
 * The one place a LinkedIn answer becomes a profile: the adapter calls it with what LinkedIn
 * answered and the mock provider with what its consent page was told, so both hold the same
 * rules.
 *
 * - The answer's own `sub` must be the token's. The token is what was verified (signature,
 *   audience, issuer, expiry); an answer about anyone else is not this member's profile.
 * - `email` and `email_verified` are optional and read strictly: LinkedIn documents
 *   `email_verified` as a Boolean, and nothing but the JSON boolean `true` beside an address
 *   counts (not `"true"`, not `1`).
 * - Only the answer's own fields are read; nothing of the ID token's profile claims is.
 *
 * @param tokenSubject - `sub` of the verified ID token.
 * @param userinfo - The userinfo answer's JSON, unjudged.
 * @returns The profile.
 * @throws OAuthProviderError `invalid_profile` when the answer is not a JSON object,
 *   `invalid_token` when its `sub` is not the token's.
 */
export function linkedInProfile(tokenSubject: string, userinfo: unknown): OAuthProfile {
  if (typeof userinfo !== 'object' || userinfo === null || Array.isArray(userinfo)) {
    throw new OAuthProviderError('invalid_profile')
  }
  const field = (name: string): unknown =>
    Object.hasOwn(userinfo, name) ? (userinfo as Record<string, unknown>)[name] : undefined
  if (tokenSubject === '' || field('sub') !== tokenSubject) {
    throw new OAuthProviderError('invalid_token')
  }
  const address = field('email')
  const email = typeof address === 'string' && address !== '' ? address : null
  return {
    subject: tokenSubject,
    email,
    emailVerified: email !== null && field('email_verified') === true,
    givenName: displayName(field('given_name')),
    familyName: displayName(field('family_name')),
  }
}

/**
 * LinkedIn sign-in: "Sign In with LinkedIn using OpenID Connect".
 *
 * The authorization URL and the code exchange are `arctic`'s `LinkedIn` client (the client id
 * and secret travel in the token request's body, as LinkedIn documents them). Two things are
 * then read, each for one purpose:
 *
 * - **The ID token is the identity.** It is verified with the shared verifier: the signature
 *   against LinkedIn's published keys, `RS256` only, the issuer ({@link LINKEDIN_ISSUERS}),
 *   the audience (this environment's client id) and the expiry. Its `sub` is the account.
 *   LinkedIn's subjects are pairwise: another LinkedIn app gets another value for the same
 *   member. Nothing else of the token is used.
 * - **The userinfo endpoint is the profile.** `GET https://api.linkedin.com/v2/userinfo` with
 *   the access token, only after the token verified, is where LinkedIn documents `email`,
 *   `email_verified` and the name. The answer must carry the token's `sub`
 *   ({@link linkedInProfile}); the address is verified only when `email_verified` is the JSON
 *   boolean `true`. One path: the token's own `email` is never a fallback.
 *
 * The userinfo read has the bounds of every profile read (`readProfile`): a deadline, no
 * redirect followed, at most 64 KiB. The access token is sent to that one address in a
 * header and dropped when the exchange returns; it is not returned, logged or stored.
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
      let accessToken: string
      try {
        const tokens = await withDeadline(
          client(credentials, exchange.redirectUri).validateAuthorizationCode(exchange.code),
          timeoutMs
        )
        idToken = idTokenOf(tokens)
        accessToken = tokens.accessToken()
      } catch (error) {
        throw exchangeFailure(error)
      }
      // The token first: the access token is sent nowhere for an exchange that proved nothing.
      const { payload } = await verifyIdToken(
        keys,
        idToken,
        { audience: credentials.clientId, nonce: NONCE_NOT_ECHOED, issuers: LINKEDIN_ISSUERS },
        timeoutMs
      )
      return linkedInProfile(
        payload.sub as string,
        await readProfile(LINKEDIN_USERINFO_URL, accessToken, timeoutMs)
      )
    },
  }
}
