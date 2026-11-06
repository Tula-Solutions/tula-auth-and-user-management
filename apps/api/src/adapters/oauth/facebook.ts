import { OAuth2Client } from 'arctic'
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
 * The Graph API version all three requests are made on: the dialog, the token endpoint and the
 * profile read. Meta retires a version about two years after
 * it is released: this constant has to be raised before then (`docs/providers/facebook.md`).
 */
export const FACEBOOK_GRAPH_VERSION = 'v25.0'

/** The login dialog, on the pinned version. */
const FACEBOOK_DIALOG_URL = `https://www.facebook.com/${FACEBOOK_GRAPH_VERSION}/dialog/oauth`

/** The token endpoint, on the pinned version. */
const FACEBOOK_TOKEN_URL = `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/oauth/access_token`

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

function client(credentials: OAuthCredentials, redirectUri: string): OAuth2Client {
  return new OAuth2Client(credentials.clientId, credentials.clientSecret ?? '', redirectUri)
}

/**
 * Exchange the code for the access token. Written by hand because Meta documents the app id
 * and secret as body parameters, which `arctic`'s generic client sends as Basic credentials
 * instead. The mapping of answers is the library's: an OAuth `error` string on a 400 or 401
 * is a refused code; anything else, the Graph API's own `error` object included, is the
 * provider being unavailable.
 */
async function accessTokenOf(
  credentials: OAuthCredentials,
  exchange: OAuthCodeExchange
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: exchange.code,
    redirect_uri: exchange.redirectUri,
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret ?? '',
  })
  const response = await fetch(
    new Request(FACEBOOK_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      redirect: 'error',
    })
  )
  const data: unknown = await response.json().catch(() => null)
  const record = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
  if ((response.status === 400 || response.status === 401) && typeof record.error === 'string') {
    throw new OAuthProviderError('invalid_grant')
  }
  if (response.status !== 200 || typeof record.access_token !== 'string') {
    throw new OAuthProviderError('unavailable')
  }
  return record.access_token
}

/**
 * Facebook Login: plain OAuth 2.0 ("manually build a login flow"), not OpenID Connect, so
 * there is no ID token to verify.
 *
 * The authorization URL is `arctic`'s generic `OAuth2Client` on the pinned version's dialog;
 * the code exchange is a request of its own to the pinned version's token endpoint (the app
 * id and secret travel in its body). The profile is then read from the Graph
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
 * OpenID Connect flow (the `openid` scope), which this adapter does not use. The code is therefore bound to the attempt by the
 * single-use `state` and to this app by the app secret and the redirect URI, and by nothing
 * else (ADR 0026).
 *
 * All three requests, the dialog, the token endpoint and the profile read, are on the one
 * pinned {@link FACEBOOK_GRAPH_VERSION}.
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
        .createAuthorizationURL(FACEBOOK_DIALOG_URL, request.state, FACEBOOK_SCOPES)
        .toString()
    },

    async exchange(
      credentials: OAuthCredentials,
      exchange: OAuthCodeExchange
    ): Promise<OAuthProfile> {
      let accessToken: string
      try {
        accessToken = await withDeadline(accessTokenOf(credentials, exchange), timeoutMs)
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
