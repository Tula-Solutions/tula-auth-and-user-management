import { Apple } from 'arctic'
import type { JWTPayload } from 'jose'
import { sha256Hex } from '~/lib/crypto'
import { pkcs8FromPem } from '~/lib/pkcs8'
import {
  type OAuthAuthorizationRequest,
  type OAuthCodeExchange,
  type OAuthCredentials,
  type OAuthIdTokenExchange,
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
  nativeIdTokenProfile,
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
 * The `nonce` claim an Apple ID token of a native sign-in must carry for an attempt's nonce
 * (ADR 0047): the **lowercase hexadecimal SHA-256 of the nonce's UTF-8 bytes**.
 *
 * Apple puts into the token the string the app gave `ASAuthorizationAppleIDRequest.nonce`,
 * as it was given. The app is told to give it this hash, which is what the libraries an
 * iOS app is likely to use already do with a nonce. **One form is accepted**: a token that
 * carries the attempt's nonce itself is refused, and so is any other encoding of the hash.
 *
 * @param nonce - The attempt's nonce, as the server made it.
 * @returns The 64 characters the token's `nonce` claim must be.
 */
export function appleNonceClaim(nonce: string): string {
  return sha256Hex(nonce)
}

/**
 * Judge the claims of an Apple ID token **a native app handed over** (ADR 0047), once its
 * signature, issuer and expiry are known to be good, and read the profile from them.
 *
 * The one statement of the rule for Apple, shared by the real adapter and the mock
 * provider. The audience, `azp`, the nonce and the subject are `nativeIdTokenProfile`'s
 * (ADR 0045), with what Apple does differently:
 *
 * - **The nonce is hashed** ({@link appleNonceClaim}), compared in constant time. A token
 *   with no `nonce` is refused, and so is one that says `nonce_supported: false`: Apple
 *   sets that for a transaction on a platform that carries no nonce, and a sign-in without
 *   one is tied to no attempt.
 * - **`email_verified` may be the string `"true"`** as well as the boolean, as in Apple's
 *   web flow ({@link emailClaims}). A private relay address is an address like any other;
 *   `is_private_email` is not read.
 * - **The token carries no name.** The system's sheet hands the name to the app, on the
 *   first authorization only; what the app passed on (`expected.user`) is read for a
 *   display name and nothing else, exactly as the unsigned `user` field of the web flow's
 *   form post is.
 *
 * A token after the first authorization may carry no address: it is then `email: null`,
 * which signs a known identity in and is `oauth.email_missing` for a new one.
 *
 * @param payload - The token's claims.
 * @param expected - The accepted bundle ids, the attempt's nonce (as the server made it)
 *   and the name the app passed on, if any.
 * @returns The profile.
 * @throws OAuthProviderError `invalid_token`, or `invalid_profile` for a token with no
 *   subject.
 */
export function appleNativeIdTokenProfile(
  payload: JWTPayload,
  expected: Pick<OAuthIdTokenExchange, 'audiences' | 'nonce' | 'user'>
): OAuthProfile {
  if (
    typeof expected.nonce !== 'string' ||
    expected.nonce === '' ||
    payload.nonce_supported === false ||
    payload.nonce_supported === 'false'
  ) {
    throw new OAuthProviderError('invalid_token')
  }
  const { subject } = nativeIdTokenProfile(payload, {
    audiences: expected.audiences,
    nonce: appleNonceClaim(expected.nonce),
  })
  const givenName = displayName(expected.user?.givenName)
  const familyName = displayName(expected.user?.familyName)
  return {
    subject,
    ...emailClaims(payload),
    ...(givenName !== undefined && { givenName }),
    ...(familyName !== undefined && { familyName }),
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
 * **No PKCE** (the attempt's verifier is not used here): `arctic`'s `Apple` client sends none,
 * and Apple documents neither a `code_challenge` nor a `code_verifier`, nor lists a challenge
 * method in its discovery document. The code is bound to the attempt by the `nonce` in the
 * signed ID token, the single-use `state` and the client-secret JWT (ADR 0026).
 *
 * `verifyIdToken` is the native path (ADR 0047): the token comes from an iOS app, which got
 * it from the system's Sign in with Apple sheet, and no request is made to Apple but the
 * fetch of its keys. It is verified by the same verifier as the code flow's (Apple's keys,
 * `RS256` only, Apple's issuer, the expiry), against the **bundle ids** of the
 * environment's iOS apps instead of the Services ID, and held to
 * {@link appleNativeIdTokenProfile}. The credentials are not used: a native token involves
 * no client secret.
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

    async verifyIdToken(
      _credentials: OAuthCredentials,
      exchange: OAuthIdTokenExchange
    ): Promise<OAuthProfile> {
      if (typeof exchange.nonce !== 'string' || exchange.nonce === '') {
        // The hash of nothing is still 64 characters: never let an attempt without a nonce
        // become a token's expected claim.
        throw new OAuthProviderError('invalid_token')
      }
      // `handedOver`: keys that could not be had are `unavailable` however they failed, and
      // a token that names no key is refused before they are asked for (ADR 0045).
      const payload = await verify(exchange.idToken, {
        audience: exchange.audiences,
        nonce: appleNonceClaim(exchange.nonce),
        handedOver: true,
      })
      return appleNativeIdTokenProfile(payload, exchange)
    },
  }
}
