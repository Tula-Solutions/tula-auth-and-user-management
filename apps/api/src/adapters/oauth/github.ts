import { GitHub } from 'arctic'
import {
  type OAuthAuthorizationRequest,
  type OAuthCodeExchange,
  type OAuthCredentials,
  type OAuthProfile,
  type OAuthProvider,
  OAuthProviderError,
} from '~/ports/oauth-provider'
import { displayName, exchangeFailure } from './id-token'

/** What is asked of GitHub: the profile, and the email addresses (the public one may be empty). */
export const GITHUB_SCOPES = ['read:user', 'user:email']

const GITHUB_API = 'https://api.github.com'

function client(credentials: OAuthCredentials, redirectUri: string): GitHub {
  return new GitHub(credentials.clientId, credentials.clientSecret ?? '', redirectUri)
}

async function api(path: string, accessToken: string): Promise<unknown> {
  let response: Response
  try {
    response = await globalThis.fetch(`${GITHUB_API}${path}`, {
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
    throw new OAuthProviderError('invalid_profile')
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
 * GitHub has no nonce and `arctic`'s client sends no PKCE challenge for it; the code is bound to
 * the attempt by the single-use `state` alone, and to this app by the client secret.
 *
 * @returns The adapter.
 */
export function createGitHubProvider(): OAuthProvider {
  return {
    authorizationUrl(credentials: OAuthCredentials, request: OAuthAuthorizationRequest): string {
      return client(credentials, request.redirectUri)
        .createAuthorizationURL(request.state, GITHUB_SCOPES)
        .toString()
    },

    async exchange(
      credentials: OAuthCredentials,
      exchange: OAuthCodeExchange
    ): Promise<OAuthProfile> {
      let accessToken: string
      try {
        const tokens = await client(credentials, exchange.redirectUri).validateAuthorizationCode(
          exchange.code
        )
        accessToken = tokens.accessToken()
      } catch (error) {
        throw exchangeFailure(error)
      }
      const [user, emails] = await Promise.all([
        api('/user', accessToken),
        api('/user/emails', accessToken),
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
