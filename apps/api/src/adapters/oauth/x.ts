import { CodeChallengeMethod, OAuth2Client } from 'arctic'
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
  PROVIDER_TIMEOUT_MS,
  type ProviderOptions,
  withDeadline,
} from './id-token'
import { MAX_PROFILE_BYTES, readProfile } from './profile-read'

/**
 * What is asked of X: `users.read` and `tweet.read`, the two scopes X's reference lists for
 * `GET /2/users/me`. **Not `users.email`**: Tula takes no address from X (ADR 0026), so it
 * asks for none. Not `offline.access` either: no refresh token is wanted.
 */
export const X_SCOPES = ['users.read', 'tweet.read']

/** X's authorization page, as its OAuth 2.0 guide writes it. */
const X_AUTHORIZATION_URL = 'https://x.com/i/oauth2/authorize'

/** X's token endpoint. */
const X_TOKEN_URL = 'https://api.x.com/2/oauth2/token'

/**
 * X's authenticated-user endpoint, with no `user.fields`: the default fields are the id, the
 * name and the username, and nothing more is asked for (never `confirmed_email`).
 */
const X_USER_URL = 'https://api.x.com/2/users/me'

/**
 * The longest authenticated-user answer that is read: the cap every profile read shares
 * ({@link MAX_PROFILE_BYTES}, 64 KiB).
 */
export const X_MAX_PROFILE_BYTES = MAX_PROFILE_BYTES

/**
 * A user id as X's API writes it: a decimal number in a string. One spelling per id (no
 * sign, no leading zero), at most twenty digits (X's ids are 64-bit).
 */
const X_USER_ID = /^[1-9][0-9]{0,19}$/

/**
 * Whether a value is an X user id as the adapter takes one.
 *
 * @param value - Anything.
 * @returns `true` for a decimal string of one to twenty digits with no sign and no leading zero.
 */
export function isXUserId(value: unknown): value is string {
  return typeof value === 'string' && X_USER_ID.test(value)
}

function client(credentials: OAuthCredentials, redirectUri: string): OAuth2Client {
  return new OAuth2Client(credentials.clientId, credentials.clientSecret ?? '', redirectUri)
}

/** Exchange the code, with the verifier, for X's access token. */
async function accessTokenOf(
  credentials: OAuthCredentials,
  exchange: OAuthCodeExchange
): Promise<string> {
  const tokens = await client(credentials, exchange.redirectUri).validateAuthorizationCode(
    X_TOKEN_URL,
    exchange.code,
    exchange.codeVerifier
  )
  return tokens.accessToken()
}

/**
 * X sign-in: OAuth 2.0 with PKCE, not OpenID Connect, so there is no ID token to verify.
 *
 * The authorization URL and the code exchange are `arctic`'s generic `OAuth2Client` on the
 * addresses X's guide gives (`x.com`, `api.x.com`): a confidential client, the secret only as
 * Basic credentials. (`arctic`'s own `Twitter` client does the same on the older
 * `twitter.com` addresses.) The profile is then read from `GET /2/users/me` over TLS with the
 * access token, which is dropped when this function returns: not returned, logged or stored,
 * and not revoked either (as GitHub's is not). Tula asked for nothing it could be used for
 * beyond reading the same profile again.
 *
 * - **Subject: the user id** (`data.id`), taken only as a decimal string of at most twenty
 *   digits with no sign and no leading zero. Never the username: it can be changed and then
 *   taken by someone else.
 * - **No email address, ever.** No scope asks for one, and an answer that carries one anyway
 *   (`confirmed_email`, `email`) is not read: the profile's `email` is always `null`. X is
 *   one of `OAUTH_PROVIDERS_WITHOUT_ADDRESS` (ADR 0026): a first sign-in makes an account
 *   with no address.
 *
 * X has no nonce. The code is bound to the attempt by **PKCE** (RFC 7636, S256), which X's
 * flow is built on, by the single-use `state` and by the client secret. An exchange with no
 * verifier is refused before anything is sent.
 *
 * Every outbound call has a deadline (`options.timeoutMs`, ten seconds by default); a provider
 * that does not answer in time is `unavailable`. A profile answer over
 * {@link X_MAX_PROFILE_BYTES} is `invalid_profile` and is not read to its end.
 *
 * @param options - The timeout of one outbound call.
 * @returns The adapter.
 */
export function createXProvider(options: ProviderOptions = {}): OAuthProvider {
  const timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS
  return {
    authorizationUrl(credentials: OAuthCredentials, request: OAuthAuthorizationRequest): string {
      return client(credentials, request.redirectUri)
        .createAuthorizationURLWithPKCE(
          X_AUTHORIZATION_URL,
          request.state,
          CodeChallengeMethod.S256,
          request.codeVerifier,
          X_SCOPES
        )
        .toString()
    },

    async exchange(
      credentials: OAuthCredentials,
      exchange: OAuthCodeExchange
    ): Promise<OAuthProfile> {
      if (exchange.codeVerifier === '') {
        throw new OAuthProviderError('invalid_grant')
      }
      let accessToken: string
      try {
        accessToken = await withDeadline(accessTokenOf(credentials, exchange), timeoutMs)
      } catch (error) {
        throw exchangeFailure(error)
      }
      const answer = await readProfile(X_USER_URL, accessToken, timeoutMs)
      const user =
        typeof answer === 'object' && answer !== null && Object.hasOwn(answer, 'data')
          ? (answer as { data: unknown }).data
          : null
      if (typeof user !== 'object' || user === null || Array.isArray(user)) {
        throw new OAuthProviderError('invalid_profile')
      }
      // Two fields are read, by name. Whatever else the answer holds, an address among it,
      // is left where it is.
      const { id, name } = user as Record<string, unknown>
      if (!isXUserId(id)) {
        throw new OAuthProviderError('invalid_profile')
      }
      // X has one free-text display name. As with GitHub's, its first word is kept as the
      // given name and the rest as the family name; both are display-only.
      const [given, ...rest] = (displayName(name) ?? '').split(/\s+/)
      return {
        subject: id,
        email: null,
        emailVerified: false,
        givenName: displayName(given),
        familyName: displayName(rest.join(' ')),
      }
    },
  }
}
