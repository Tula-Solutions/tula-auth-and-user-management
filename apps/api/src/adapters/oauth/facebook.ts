import { Facebook } from 'arctic'
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
 * What is asked of Facebook: `public_profile` and nothing else. **Never `email`**: Tula takes
 * no address from Facebook (ADR 0026), so it asks for none.
 */
export const FACEBOOK_SCOPES = ['public_profile']

/**
 * The Graph API version the profile is read on. Meta retires a version about two years after
 * it is released: this constant has to be raised before then (`docs/providers/facebook.md`).
 */
export const FACEBOOK_GRAPH_VERSION = 'v25.0'

/** The current user, with the two fields that are read and no others. */
const FACEBOOK_USER_URL = `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/me`

/**
 * The longest current-user answer that is read: the cap every profile read shares
 * ({@link MAX_PROFILE_BYTES}, 64 KiB).
 */
export const FACEBOOK_MAX_PROFILE_BYTES = MAX_PROFILE_BYTES

/**
 * An app-scoped user id as the Graph API writes it: a "numeric string". One spelling per id
 * (no sign, no leading zero), at most thirty-two digits: Meta documents no width, and the
 * ids seen are far shorter.
 */
const FACEBOOK_USER_ID = /^[1-9][0-9]{0,31}$/

/**
 * Whether a value is a Facebook app-scoped user id as the adapter takes one.
 *
 * @param value - Anything.
 * @returns `true` for a decimal string of one to thirty-two digits with no sign and no
 *   leading zero.
 */
export function isFacebookUserId(value: unknown): value is string {
  return typeof value === 'string' && FACEBOOK_USER_ID.test(value)
}

/**
 * The proof Meta documents for a Graph API call made from a server: the access token's
 * HMAC-SHA256 under the app secret, in hex. With it a token alone (one that leaked from a
 * client, say) cannot be used against this app's calls, and an app with "Require App Secret"
 * switched on accepts no call without it.
 *
 * Computed here, inside the adapter, from the two secrets it already holds; the result goes
 * into the one request's query and nowhere else.
 *
 * @param accessToken - The access token the code was just exchanged for.
 * @param appSecret - The app secret.
 * @returns The proof.
 */
export function appSecretProof(accessToken: string, appSecret: string): string {
  return new Bun.CryptoHasher('sha256', appSecret).update(accessToken).digest('hex')
}

function client(credentials: OAuthCredentials, redirectUri: string): Facebook {
  return new Facebook(credentials.clientId, credentials.clientSecret ?? '', redirectUri)
}

/**
 * Facebook Login: plain OAuth 2.0 ("manually build a login flow"), not OpenID Connect, so
 * there is no ID token to verify.
 *
 * The authorization URL and the code exchange are `arctic`'s `Facebook` client (the app id
 * and secret travel in the token request's body). The profile is then read from the Graph
 * API (`GET /me?fields=id,name`, on {@link FACEBOOK_GRAPH_VERSION}) over TLS with the access
 * token in a header and its {@link appSecretProof} in the query. The token is dropped when
 * this function returns: not returned, logged or stored.
 *
 * - **Subject: the app-scoped user id** (`id`), taken only as a decimal string of at most
 *   thirty-two digits with no sign and no leading zero. It is this app's id for the person:
 *   another Facebook app gets another value. Never the name.
 * - **No email address, ever.** The `email` permission is not asked for, `email` is not
 *   among the fields requested, and an answer that carries one anyway is not read: the
 *   profile's `email` is always `null`. Facebook is one of
 *   `OAUTH_PROVIDERS_WITHOUT_ADDRESS` (ADR 0026): a first sign-in makes an account with no
 *   address.
 *
 * **No PKCE and no nonce.** Meta's manual-flow page documents `client_id`, `redirect_uri`,
 * `state`, `response_type` and `scope` for the dialog and `client_id`, `redirect_uri`,
 * `client_secret` and `code` for the exchange; a `code_challenge` appears only in its
 * OpenID Connect flow (the `openid` scope), which this adapter does not use, and `arctic`'s
 * client has a parameter for neither. The code is therefore bound to the attempt by the
 * single-use `state` and to this app by the app secret and the redirect URI, and by nothing
 * else (ADR 0026).
 *
 * `arctic`'s client writes the dialog and the token endpoint with the Graph version it was
 * built with (`v16.0`), which is not this adapter's to choose. Meta's versioning page says a
 * call to a version that is no longer usable is answered by the next oldest usable one; it
 * does not say so of the dialog, and neither was observed here (ADR 0026). Only the profile
 * read is on the version pinned here.
 *
 * Every outbound call has a deadline (`options.timeoutMs`, ten seconds by default); a provider
 * that does not answer in time is `unavailable`. A profile answer over
 * {@link FACEBOOK_MAX_PROFILE_BYTES} is `invalid_profile` and is not read to its end.
 *
 * @param options - The timeout of one outbound call.
 * @returns The adapter.
 */
export function createFacebookProvider(options: ProviderOptions = {}): OAuthProvider {
  const timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS
  return {
    authorizationUrl(credentials: OAuthCredentials, request: OAuthAuthorizationRequest): string {
      return client(credentials, request.redirectUri)
        .createAuthorizationURL(request.state, FACEBOOK_SCOPES)
        .toString()
    },

    async exchange(
      credentials: OAuthCredentials,
      exchange: OAuthCodeExchange
    ): Promise<OAuthProfile> {
      let accessToken: string
      try {
        const tokens = await withDeadline(
          client(credentials, exchange.redirectUri).validateAuthorizationCode(exchange.code),
          timeoutMs
        )
        accessToken = tokens.accessToken()
      } catch (error) {
        throw exchangeFailure(error)
      }
      const url = new URL(FACEBOOK_USER_URL)
      url.searchParams.set('fields', 'id,name')
      url.searchParams.set(
        'appsecret_proof',
        appSecretProof(accessToken, credentials.clientSecret ?? '')
      )
      const user = await readProfile(url.toString(), accessToken, timeoutMs)
      if (typeof user !== 'object' || user === null || Array.isArray(user)) {
        throw new OAuthProviderError('invalid_profile')
      }
      // Two fields are read, by name. Whatever else the answer holds, an address among it,
      // is left where it is.
      const { id, name } = user as Record<string, unknown>
      if (!isFacebookUserId(id)) {
        throw new OAuthProviderError('invalid_profile')
      }
      // One free-text name is asked for. As with GitHub's, its first word is kept as the
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
