import { Google } from 'arctic'
import type {
  OAuthAuthorizationRequest,
  OAuthCodeExchange,
  OAuthCredentials,
  OAuthIdTokenExchange,
  OAuthProfile,
  OAuthProvider,
} from '~/ports/oauth-provider'
import {
  createIdTokenVerifier,
  displayName,
  emailClaims,
  exchangeFailure,
  idTokenOf,
  nativeIdTokenProfile,
  PROVIDER_TIMEOUT_MS,
  type ProviderOptions,
  withDeadline,
} from './id-token'

/** What is asked of Google: who the user is and their email address. Nothing else. */
export const GOOGLE_SCOPES = ['openid', 'email', 'profile']

const GOOGLE_ID_TOKENS = {
  // Google documents both spellings of its issuer.
  issuers: ['https://accounts.google.com', 'accounts.google.com'],
  jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
}

function client(credentials: OAuthCredentials, redirectUri: string): Google {
  return new Google(credentials.clientId, credentials.clientSecret ?? '', redirectUri)
}

/**
 * Google sign-in: OpenID Connect with PKCE.
 *
 * The authorization URL and the code exchange are `arctic`'s; the ID token is verified here
 * with `jose` (signature against Google's keys, issuer, audience, expiry, nonce). The subject is
 * the token's `sub`, the email its `email`, and `emailVerified` its `email_verified`. Google's
 * access token is dropped as soon as the exchange returns.
 *
 * `verifyIdToken` is the native path (ADR 0045): the token comes from the app, which got it
 * from Credential Manager on Android or Google Sign-In on iOS, and no request is made to
 * Google but the fetch of its keys. It is verified by the same verifier, against the
 * environment's own client id and the client ids of its native apps.
 *
 * Every outbound call has a deadline (`options.timeoutMs`, ten seconds by default); a provider
 * that does not answer in time is `unavailable`.
 *
 * @param options - The timeout of one outbound call.
 * @returns The adapter.
 */
export function createGoogleProvider(options: ProviderOptions = {}): OAuthProvider {
  const timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS
  const verify = createIdTokenVerifier(GOOGLE_ID_TOKENS, { timeoutMs })
  return {
    authorizationUrl(credentials: OAuthCredentials, request: OAuthAuthorizationRequest): string {
      const url = client(credentials, request.redirectUri).createAuthorizationURL(
        request.state,
        request.codeVerifier,
        GOOGLE_SCOPES
      )
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
            client(credentials, exchange.redirectUri).validateAuthorizationCode(
              exchange.code,
              exchange.codeVerifier
            ),
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
        givenName: displayName(payload.given_name),
        familyName: displayName(payload.family_name),
      }
    },

    async verifyIdToken(
      _credentials: OAuthCredentials,
      exchange: OAuthIdTokenExchange
    ): Promise<OAuthProfile> {
      // The same verifier as the code flow's: Google's keys, `RS256` only, its two issuers,
      // the expiry. The audience is one of several here, and what else a native app's token
      // must satisfy (`aud` one string, `azp`, the nonce) is `nativeIdTokenProfile`'s.
      const payload = await verify(exchange.idToken, {
        audience: exchange.audiences,
        nonce: exchange.nonce,
      })
      return nativeIdTokenProfile(payload, exchange)
    },
  }
}
