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

/** What is asked of GitHub: the profile, and the email addresses (the public one may be empty). */
export const GITHUB_SCOPES = ['read:user', 'user:email']

const GITHUB_API = 'https://api.github.com'
const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize'
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'

/**
 * `arctic`'s generic client, not its `GitHub` one: that class (3.7.0) has no parameter for a
 * PKCE verifier on either call. The generic client sends the same requests (the client id and
 * secret as Basic credentials) plus the challenge and the verifier.
 */
function client(credentials: OAuthCredentials, redirectUri: string): OAuth2Client {
  return new OAuth2Client(credentials.clientId, credentials.clientSecret ?? '', redirectUri)
}

/**
 * Exchange the code, with the verifier, for GitHub's access token.
 *
 * GitHub answers a refused code with status 200 and an `error` member, which the generic
 * client takes for a token response: it is told apart here.
 */
async function accessTokenOf(
  credentials: OAuthCredentials,
  exchange: OAuthCodeExchange
): Promise<string> {
  const tokens = await client(credentials, exchange.redirectUri).validateAuthorizationCode(
    GITHUB_TOKEN_URL,
    exchange.code,
    exchange.codeVerifier
  )
  if ('error' in tokens.data) {
    throw new OAuthProviderError('invalid_grant')
  }
  return tokens.accessToken()
}

/**
 * Read one resource of GitHub's API. The request is aborted at the timeout (the signal also
 * ends a body that stops arriving); {@link withDeadline} guards a `fetch` that ignores it.
 */
function api(path: string, accessToken: string, timeoutMs: number): Promise<unknown> {
  return withDeadline(read(path, accessToken, AbortSignal.timeout(timeoutMs)), timeoutMs)
}

async function read(path: string, accessToken: string, signal: AbortSignal): Promise<unknown> {
  let response: Response
  try {
    response = await globalThis.fetch(`${GITHUB_API}${path}`, {
      signal,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'tula-auth',
        'x-github-api-version': '2022-11-28',
      },
    })
  } catch {
    throw new OAuthProviderError('unavailable')
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new OAuthProviderError('unavailable')
  }
  try {
    return await response.json()
  } catch {
    // A body cut off by the timeout is the provider not answering, not a bad profile.
    throw new OAuthProviderError(signal.aborted ? 'unavailable' : 'invalid_profile')
  }
}

/** The primary address of a GitHub account and whether GitHub has verified it. */
function primaryEmail(emails: unknown): Pick<OAuthProfile, 'email' | 'emailVerified'> {
  if (!Array.isArray(emails)) {
    throw new OAuthProviderError('invalid_profile')
  }
  const primary = emails.find(
    (entry): entry is { email: string; verified?: unknown } =>
      typeof entry === 'object' &&
      entry !== null &&
      (entry as { primary?: unknown }).primary === true &&
      typeof (entry as { email?: unknown }).email === 'string'
  )
  return primary
    ? { email: primary.email, emailVerified: primary.verified === true }
    : { email: null, emailVerified: false }
}

/**
 * GitHub sign-in: plain OAuth 2.0, not OpenID Connect, so there is no ID token to verify.
 *
 * The code is exchanged through `arctic`; the profile is then read from GitHub's API over TLS
 * with the access token, which is dropped when this function returns:
 *
 * - **Subject: the numeric user id** (`/user` → `id`). Never the login name: a login can be
 *   renamed and then registered by someone else.
 * - **Email: the primary address** of `/user/emails`, with its own `verified` flag. The public
 *   profile email is ignored (it is optional and says nothing about verification).
 *
 * GitHub has no nonce. The code is bound to the attempt by **PKCE** (RFC 7636): the
 * authorization URL carries the S256 challenge of the attempt's verifier and the token request
 * the verifier itself, so a code that leaks on its way back is worth nothing without what only
 * the attempt holds. It is bound by the single-use `state` too, and to this app by the client
 * secret. An exchange with no verifier is refused before anything is sent: GitHub would accept
 * it for a code that was asked for without a challenge.
 *
 * Every outbound call has a deadline (`options.timeoutMs`, ten seconds by default); a provider
 * that does not answer in time is `unavailable`.
 *
 * @param options - The timeout of one outbound call.
 * @returns The adapter.
 */
export function createGitHubProvider(options: ProviderOptions = {}): OAuthProvider {
  const timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS
  return {
    authorizationUrl(credentials: OAuthCredentials, request: OAuthAuthorizationRequest): string {
      return client(credentials, request.redirectUri)
        .createAuthorizationURLWithPKCE(
          GITHUB_AUTHORIZE_URL,
          request.state,
          CodeChallengeMethod.S256,
          request.codeVerifier,
          GITHUB_SCOPES
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
      const [user, emails] = await Promise.all([
        api('/user', accessToken, timeoutMs),
        api('/user/emails', accessToken, timeoutMs),
      ])
      const { id, name } = (user ?? {}) as { id?: unknown; name?: unknown }
      if (typeof id !== 'number' || !Number.isSafeInteger(id)) {
        throw new OAuthProviderError('invalid_profile')
      }
      // GitHub has one free-text name. Its first word is kept as the given name and the rest
      // as the family name; both are display-only.
      const [given, ...rest] = (displayName(name) ?? '').split(/\s+/)
      return {
        subject: String(id),
        ...primaryEmail(emails),
        givenName: displayName(given),
        familyName: displayName(rest.join(' ')),
      }
    },
  }
}
