import { Apple } from 'arctic'
import { pkcs8FromPem } from '~/lib/pkcs8'
import {
  type OAuthAuthorizationRequest,
  type OAuthCodeExchange,
  type OAuthCredentials,
  type OAuthProfile,
  type OAuthProvider,
  OAuthProviderError,
} from '~/ports/oauth-provider'
import {
  createIdTokenVerifier,
  displayName,
  emailClaims,
  exchangeFailure,
  idTokenOf,
  PROVIDER_TIMEOUT_MS,
  type ProviderOptions,
  withDeadline,
} from './id-token'

/** What is asked of Apple. Asking for either makes Apple answer with a form post. */
export const APPLE_SCOPES = ['name', 'email']

const APPLE_ID_TOKENS = {
  issuers: ['https://appleid.apple.com'],
  jwksUrl: 'https://appleid.apple.com/auth/keys',
}

function client(credentials: OAuthCredentials, redirectUri: string): Apple {
  let key: Uint8Array
  try {
    key = pkcs8FromPem(credentials.privateKey ?? '')
  } catch {
    throw new OAuthProviderError('unavailable')
  }
  return new Apple(
    credentials.clientId,
    credentials.teamId ?? '',
    credentials.keyId ?? '',
    key,
    redirectUri
  )
}

/**
 * The display name in the `user` field Apple posts on a first authorization.
 *
 * That field is **not signed**: anyone who can post to the callback can put anything in it. So
 * only a display name is read from it, and never an email address or an id (those come from the
 * verified ID token).
 */
function postedName(user: string | undefined): Pick<OAuthProfile, 'givenName' | 'familyName'> {
  if (user === undefined) {
    return {}
  }
  try {
    const { name } = JSON.parse(user) as { name?: { firstName?: unknown; lastName?: unknown } }
    return { givenName: displayName(name?.firstName), familyName: displayName(name?.lastName) }
  } catch {
    return {}
  }
}

/**
 * Sign in with Apple: OpenID Connect, with three differences from Google.
 *
 * - **The answer is a form post.** Asking for the name or email scope requires
 *   `response_mode=form_post`, so Apple sends the browser to the callback with a cross-site
 *   `POST`. The callback therefore depends on no cookie.
 * - **The client secret is a JWT** signed (ES256) with the developer's key, naming the team,
 *   the key and the Services ID. `arctic` builds a fresh one, valid five minutes, per exchange.
 * - **The name arrives once**, unsigned, in the posted `user` field, and never again.
 *
 * A private relay address (`…@privaterelay.appleid.com`) is a real, deliverable address and is
 * treated like any other. `email_verified` may be the string `"true"`.
 *
 * Every outbound call has a deadline (`options.timeoutMs`, ten seconds by default); a provider
 * that does not answer in time is `unavailable`.
 *
 * @param options - The timeout of one outbound call.
 * @returns The adapter.
 */
export function createAppleProvider(options: ProviderOptions = {}): OAuthProvider {
  const timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS
  const verify = createIdTokenVerifier(APPLE_ID_TOKENS, { timeoutMs })
  return {
    authorizationUrl(credentials: OAuthCredentials, request: OAuthAuthorizationRequest): string {
      const url = client(credentials, request.redirectUri).createAuthorizationURL(
        request.state,
        APPLE_SCOPES
      )
      url.searchParams.set('response_mode', 'form_post')
      url.searchParams.set('nonce', request.nonce)
      return url.toString()
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
      const payload = await verify(idToken, {
        audience: credentials.clientId,
        nonce: exchange.nonce,
      })
      return {
        subject: payload.sub as string,
        ...emailClaims(payload),
        ...postedName(exchange.user),
      }
    },
  }
}
