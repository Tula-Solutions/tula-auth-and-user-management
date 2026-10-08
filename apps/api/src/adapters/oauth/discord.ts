import { Discord } from 'arctic'
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

/**
 * What is asked of Discord: `identify` (the user object without its address) and `email` (the
 * address and whether Discord has verified it). Nothing about servers, messages or
 * connections.
 */
export const DISCORD_SCOPES = ['identify', 'email']

/** Discord's current-user endpoint, on the API version its reference documents (v10). */
const DISCORD_USER_URL = 'https://discord.com/api/v10/users/@me'

/**
 * The longest current-user answer that is read. A user object is a few hundred bytes; an
 * answer beyond this is not one, and is dropped unread instead of being buffered.
 */
export const DISCORD_MAX_PROFILE_BYTES = 64 * 1024

/**
 * A snowflake as Discord's API writes it: a 64-bit unsigned integer in decimal, in a string.
 * One spelling per id (no sign, no leading zero), at most the twenty digits of 2^64 - 1.
 */
const SNOWFLAKE = /^[1-9][0-9]{0,19}$/

/**
 * Whether a value is a Discord id as the adapter takes one.
 *
 * @param value - Anything.
 * @returns `true` for a decimal string of one to twenty digits with no sign and no leading zero.
 */
export function isSnowflake(value: unknown): value is string {
  return typeof value === 'string' && SNOWFLAKE.test(value)
}

function client(credentials: OAuthCredentials, redirectUri: string): Discord {
  return new Discord(credentials.clientId, credentials.clientSecret ?? '', redirectUri)
}

/** Exchange the code, with the verifier, for Discord's access token. */
async function accessTokenOf(
  credentials: OAuthCredentials,
  exchange: OAuthCodeExchange
): Promise<string> {
  const tokens = await client(credentials, exchange.redirectUri).validateAuthorizationCode(
    exchange.code,
    exchange.codeVerifier
  )
  return tokens.accessToken()
}

/**
 * Read a response body as text, up to a number of bytes.
 *
 * @returns The text, or `null` when the body is longer: the rest is cancelled, not read.
 */
async function boundedText(response: Response, maxBytes: number): Promise<string | null> {
  const reader = response.body?.getReader()
  if (!reader) {
    return ''
  }
  const decoder = new TextDecoder()
  let text = ''
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      return text + decoder.decode()
    }
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    text += decoder.decode(value, { stream: true })
  }
}

/**
 * Read the current user. The request is aborted at the timeout (the signal also ends a body
 * that stops arriving); {@link withDeadline} guards a `fetch` that ignores it.
 */
function currentUser(accessToken: string, timeoutMs: number): Promise<unknown> {
  return withDeadline(read(accessToken, AbortSignal.timeout(timeoutMs)), timeoutMs)
}

async function read(accessToken: string, signal: AbortSignal): Promise<unknown> {
  let response: Response
  try {
    response = await globalThis.fetch(DISCORD_USER_URL, {
      signal,
      // A redirect would carry the token to wherever it points.
      redirect: 'error',
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    })
  } catch {
    throw new OAuthProviderError('unavailable')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new OAuthProviderError('unavailable')
  }
  let text: string | null
  try {
    text = await boundedText(response, DISCORD_MAX_PROFILE_BYTES)
  } catch {
    // A body cut off (by the timeout or the connection) is the provider not answering.
    throw new OAuthProviderError('unavailable')
  }
  if (text === null) {
    throw new OAuthProviderError('invalid_profile')
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new OAuthProviderError('invalid_profile')
  }
}

/**
 * Discord sign-in: plain OAuth 2.0, not OpenID Connect, so there is no ID token to verify.
 *
 * The code is exchanged through `arctic`'s `Discord` client; the profile is then read from
 * Discord's API (`GET /users/@me`) over TLS with the access token, which is dropped when this
 * function returns. It is not returned, logged or stored, and it is not revoked either (as
 * GitHub's is not): Tula asked for nothing it could be used for beyond reading the same
 * profile again.
 *
 * - **Subject: the user id**, a snowflake, taken only as a decimal string of at most twenty
 *   digits with no sign and no leading zero. Never the username: it can be changed and then
 *   taken by someone else.
 * - **Email: the user object's `email`**, verified only when its `verified` is the JSON
 *   boolean `true`. Absent, `false`, `"true"` or `1`: unverified. An address needs the `email`
 *   scope; a user may have none.
 *
 * Discord has no nonce. The code is bound to the attempt by **PKCE** (RFC 7636, S256), which
 * `arctic`'s client sends beside the client's Basic credentials, by the single-use `state`
 * and by the client secret. An exchange with no verifier is refused before anything is sent.
 * **Discord's OAuth2 page does not mention PKCE**: that it refuses a wrong verifier is
 * `arctic`'s reading of it and was never observed here (ADR 0026).
 *
 * Every outbound call has a deadline (`options.timeoutMs`, ten seconds by default); a provider
 * that does not answer in time is `unavailable`. A profile answer over
 * {@link DISCORD_MAX_PROFILE_BYTES} is `invalid_profile` and is not read to its end.
 *
 * @param options - The timeout of one outbound call.
 * @returns The adapter.
 */
export function createDiscordProvider(options: ProviderOptions = {}): OAuthProvider {
  const timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS
  return {
    authorizationUrl(credentials: OAuthCredentials, request: OAuthAuthorizationRequest): string {
      return client(credentials, request.redirectUri)
        .createAuthorizationURL(request.state, request.codeVerifier, DISCORD_SCOPES)
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
      const user = await currentUser(accessToken, timeoutMs)
      if (typeof user !== 'object' || user === null || Array.isArray(user)) {
        throw new OAuthProviderError('invalid_profile')
      }
      const { id, email, verified, global_name } = user as Record<string, unknown>
      if (!isSnowflake(id)) {
        throw new OAuthProviderError('invalid_profile')
      }
      const address = typeof email === 'string' && email !== '' ? email : null
      // Discord has one free-text display name. As with GitHub's, its first word is kept as
      // the given name and the rest as the family name; both are display-only.
      const [given, ...rest] = (displayName(global_name) ?? '').split(/\s+/)
      return {
        subject: id,
        email: address,
        emailVerified: address !== null && verified === true,
        givenName: displayName(given),
        familyName: displayName(rest.join(' ')),
      }
    },
  }
}
