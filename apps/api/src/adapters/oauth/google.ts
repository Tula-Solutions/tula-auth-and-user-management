import { Google } from 'arctic'
import type {
  OAuthAuthorizationRequest,
  OAuthCodeExchange,
  OAuthCredentials,
  OAuthProfile,
  OAuthProvider,
} from '~/ports/oauth-provider'
import {
  createIdTokenVerifier,
  displayName,
  emailClaims,
  exchangeFailure,
  idTokenOf,
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
 * @returns The adapter.
 */
export function createGoogleProvider(): OAuthProvider {
  const verify = createIdTokenVerifier(GOOGLE_ID_TOKENS)
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
          await client(credentials, exchange.redirectUri).validateAuthorizationCode(
            exchange.code,
            exchange.codeVerifier
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
  }
}
