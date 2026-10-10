import {
  givesNoAddress,
  ID_TOKEN_PROVIDERS,
  type OAuthProvider as OAuthProviderName,
} from '@tula/contract'
import type { JWTPayload } from 'jose'
import { isSnowflake } from '~/adapters/oauth/discord'
import { isFacebookUserId } from '~/adapters/oauth/facebook'
import { nativeIdTokenProfile } from '~/adapters/oauth/id-token'
import { linkedInProfile } from '~/adapters/oauth/linkedin'
import { tenantAccepts } from '~/adapters/oauth/microsoft'
import { isXUserId } from '~/adapters/oauth/x'
import { timingSafeEqual } from '~/lib/crypto'
import type { SecretBox } from '~/lib/secret-box'
import type { Clock } from '~/ports/clock'
import {
  type OAuthAuthorizationRequest,
  type OAuthCodeExchange,
  type OAuthCredentials,
  type OAuthIdTokenExchange,
  type OAuthProfile,
  type OAuthProvider,
  OAuthProviderError,
  type OAuthProviders,
} from '~/ports/oauth-provider'

/** Where the mock provider's consent page is served, on the API itself. */
export const MOCK_AUTHORIZE_PATH = '/v1/dev/oauth/authorize'
/** How long a mock authorization code can be exchanged, in milliseconds. */
export const MOCK_CODE_TTL_MS = 60_000

const PURPOSE = 'oauth-mock-codes'

/** What the mock consent page decided, sealed into the authorization code. */
export interface MockGrant {
  provider: OAuthProviderName
  clientId: string
  redirectUri: string
  nonce: string
  /** The S256 challenge the authorization URL carried. */
  codeChallenge: string
  profile: OAuthProfile
  /**
   * LinkedIn only: the userinfo answer the mock serves for this code. The real adapter takes
   * the account from the ID token (`profile.subject` here) and the address, whether it is
   * verified and the name from userinfo alone; so does the mock, and a LinkedIn code without
   * this is refused.
   */
  userinfo?: unknown
}

/**
 * The S256 code challenge of a PKCE verifier (RFC 7636).
 *
 * @param codeVerifier - The verifier.
 * @returns `BASE64URL(SHA256(verifier))`.
 */
export function s256(codeVerifier: string): string {
  return new Bun.CryptoHasher('sha256').update(codeVerifier).digest('base64url')
}

/**
 * Mint the authorization code the mock consent page redirects back with.
 *
 * The code is the grant itself, sealed with the secret box: nothing is stored, so it works
 * across several API instances that share `TULA_MASTER_KEY`.
 *
 * @param secretBox - The deployment's secret box.
 * @param clock - Clock; the code expires {@link MOCK_CODE_TTL_MS} from now.
 * @param grant - What the "user" consented to.
 * @returns The code.
 */
export function issueMockCode(
  secretBox: SecretBox,
  clock: Clock,
  grant: MockGrant
): Promise<string> {
  const body = JSON.stringify({ ...grant, expiresAt: clock.now().getTime() + MOCK_CODE_TTL_MS })
  return secretBox.seal(PURPOSE, new TextEncoder().encode(body), grant.provider)
}

/** Where the mock provider mints an ID token for a native sign-in, on the API itself. */
export const MOCK_ID_TOKEN_PATH = '/v1/dev/oauth/id-token'
/** How long a mock ID token is accepted, in milliseconds. Google's own last an hour. */
export const MOCK_ID_TOKEN_TTL_MS = 3_600_000
/** The `iss` of a mock ID token. No real provider's, so that no real verifier accepts one. */
export const MOCK_ID_TOKEN_ISSUER = 'https://mock.tula.invalid'

const ID_TOKEN_PURPOSE = 'oauth-mock-id-tokens'

/**
 * The claims of a mock ID token, in the names an OIDC provider uses. What a test wants the
 * "provider" to have said: the audience and the nonce are whatever the caller asks for, so
 * that another app's token and another attempt's can be made as easily as a good one.
 */
export interface MockIdTokenClaims {
  aud: string
  /** The client that asked, when it is not the audience (Android's client beside the web one). */
  azp?: string
  sub: string
  nonce?: string
  email?: string
  email_verified?: boolean
  given_name?: string
  family_name?: string
}

/**
 * Mint the ID token a native app would have been handed by the mock provider (ADR 0045).
 *
 * The token is the claims themselves, sealed with the secret box under a purpose of its own
 * and bound to the provider: only this deployment's mock can have made one, nothing is
 * stored, and it works across instances that share `TULA_MASTER_KEY`. It is **not a JWT**:
 * what the mock shares with the real adapter is the rule a verified token's claims are held
 * to (`nativeIdTokenProfile`), not the signature check, which the adapter's own tests cover
 * with tokens they sign.
 *
 * @param secretBox - The deployment's secret box.
 * @param clock - Clock; the token expires {@link MOCK_ID_TOKEN_TTL_MS} from now.
 * @param provider - The provider the token is of.
 * @param claims - What the token says.
 * @param options - `expired`: mint a token whose expiry has already passed.
 * @returns The token.
 */
export function issueMockIdToken(
  secretBox: SecretBox,
  clock: Clock,
  provider: OAuthProviderName,
  claims: MockIdTokenClaims,
  options: { expired?: boolean } = {}
): Promise<string> {
  const now = clock.now().getTime()
  const body = JSON.stringify({
    ...claims,
    iss: MOCK_ID_TOKEN_ISSUER,
    exp: Math.floor((options.expired ? now - 1000 : now + MOCK_ID_TOKEN_TTL_MS) / 1000),
  })
  return secretBox.seal(ID_TOKEN_PURPOSE, new TextEncoder().encode(body), provider)
}

/**
 * A stand-in for a real provider, **for local development and tests only** (ADR 0026).
 *
 * Developers have no shared OAuth credentials and CI has none, so without this nothing past the
 * unit tests could exercise the real callback, ticket, exchange and linking code. With
 * `OAUTH_MOCK_PROVIDER=true` (accepted only where `ENVIRONMENT=local`; `env.ts` refuses to boot
 * otherwise) every provider is served by this adapter instead of the real one: the
 * authorization URL points at a consent page on the API itself ({@link MOCK_AUTHORIZE_PATH}),
 * where the developer types the email address the "provider" should assert.
 *
 * It keeps the checks a real provider makes, so the server code is exercised honestly: the code
 * is bound to the client id and redirect URI, expires in a minute, carries the nonce, and is
 * only exchanged with the PKCE verifier matching the challenge the authorization URL carried.
 * For Microsoft it also keeps the tenant rule: an account of a tenant the environment's
 * `tenant` does not accept is refused, as the real adapter refuses its token.
 * For Discord it keeps the shape of an id: an account id that is not a snowflake is refused, as
 * the real adapter refuses such a user object.
 * For LinkedIn it keeps the two sources: the code carries a userinfo answer beside the "ID
 * token's" subject, and the profile is made of the two by the real adapter's own function
 * (`linkedInProfile`: the answer's `sub` must be the token's, `email_verified` must be the
 * boolean `true`). The mock makes no request: what it shares with the real adapter is that
 * rule, not the call to LinkedIn. It checks a PKCE verifier and a nonce for LinkedIn as for
 * every provider, which the real adapter cannot (LinkedIn takes neither: ADR 0026): a
 * scenario that passes here is no evidence that LinkedIn's code is bound by them.
 * For X and Facebook it keeps the two things their adapters do with a user object: an account
 * id that is not a decimal id as the real adapter takes one is refused, and **whatever
 * address the code carries is dropped** (`email: null`, unverified), as the real adapters
 * read none. So a scenario can have the "provider" report someone's address and see that it
 * reaches nothing. It checks a PKCE verifier for Facebook too, which the real adapter cannot
 * (Facebook's manual flow documents none: ADR 0026).
 * For a provider of `ID_TOKEN_PROVIDERS` (Google) it also verifies the ID token of a native
 * sign-in (ADR 0045): one of its own ({@link issueMockIdToken}), not expired, and then held
 * to the real adapter's own rule for the claims (`nativeIdTokenProfile`: the audience, `azp`,
 * the nonce, the subject).
 *
 * @param provider - The provider this instance stands in for.
 * @param deps - Secret box, clock and the API's public URL.
 * @returns The adapter.
 */
export function createMockProvider(
  provider: OAuthProviderName,
  deps: { secretBox: SecretBox; clock: Clock; publicUrl: string }
): OAuthProvider {
  return {
    authorizationUrl(credentials: OAuthCredentials, request: OAuthAuthorizationRequest): string {
      const url = new URL(MOCK_AUTHORIZE_PATH, deps.publicUrl)
      url.searchParams.set('provider', provider)
      url.searchParams.set('client_id', credentials.clientId)
      url.searchParams.set('redirect_uri', request.redirectUri)
      url.searchParams.set('state', request.state)
      url.searchParams.set('nonce', request.nonce)
      url.searchParams.set('code_challenge', s256(request.codeVerifier))
      url.searchParams.set('code_challenge_method', 'S256')
      if (provider === 'microsoft' && credentials.tenant !== undefined) {
        // So that the consent page can offer a tenant id the environment accepts.
        url.searchParams.set('tenant', credentials.tenant)
      }
      return url.toString()
    },

    async exchange(
      credentials: OAuthCredentials,
      exchange: OAuthCodeExchange
    ): Promise<OAuthProfile> {
      let grant: MockGrant & { expiresAt: number }
      try {
        grant = JSON.parse(
          new TextDecoder().decode(await deps.secretBox.open(PURPOSE, exchange.code, provider))
        )
      } catch {
        throw new OAuthProviderError('invalid_grant')
      }
      if (
        grant.expiresAt <= deps.clock.now().getTime() ||
        grant.clientId !== credentials.clientId ||
        grant.redirectUri !== exchange.redirectUri ||
        !timingSafeEqual(grant.codeChallenge, s256(exchange.codeVerifier))
      ) {
        throw new OAuthProviderError('invalid_grant')
      }
      if (!timingSafeEqual(grant.nonce, exchange.nonce)) {
        throw new OAuthProviderError('invalid_token')
      }
      if (
        provider === 'microsoft' &&
        !tenantAccepts(credentials.tenant, grant.profile.subject.split(':')[0] ?? '')
      ) {
        throw new OAuthProviderError('invalid_token')
      }
      if (provider === 'discord' && !isSnowflake(grant.profile.subject)) {
        throw new OAuthProviderError('invalid_profile')
      }
      if (provider === 'linkedin') {
        return linkedInProfile(grant.profile.subject, grant.userinfo)
      }
      if (
        (provider === 'x' && !isXUserId(grant.profile.subject)) ||
        (provider === 'facebook' && !isFacebookUserId(grant.profile.subject))
      ) {
        throw new OAuthProviderError('invalid_profile')
      }
      if (givesNoAddress(provider)) {
        return { ...grant.profile, email: null, emailVerified: false }
      }
      return grant.profile
    },

    // Only for a provider that has the exchange for real: the others have no such method,
    // as their real adapters have none.
    ...((ID_TOKEN_PROVIDERS as readonly string[]).includes(provider) && {
      async verifyIdToken(
        _credentials: OAuthCredentials,
        exchange: OAuthIdTokenExchange
      ): Promise<OAuthProfile> {
        let claims: JWTPayload
        try {
          claims = JSON.parse(
            new TextDecoder().decode(
              await deps.secretBox.open(ID_TOKEN_PURPOSE, exchange.idToken, provider)
            )
          )
        } catch {
          // Not this mock's, another provider's, or tampered with: the "signature" is bad.
          throw new OAuthProviderError('invalid_token')
        }
        if (
          claims.iss !== MOCK_ID_TOKEN_ISSUER ||
          typeof claims.exp !== 'number' ||
          claims.exp * 1000 <= deps.clock.now().getTime()
        ) {
          throw new OAuthProviderError('invalid_token')
        }
        return nativeIdTokenProfile(claims, exchange)
      },
    }),
  }
}

/**
 * The mock adapter for every provider.
 *
 * @param deps - Secret box, clock and the API's public URL.
 * @returns The adapters.
 */
export function mockOAuthProviders(deps: {
  secretBox: SecretBox
  clock: Clock
  publicUrl: string
}): OAuthProviders {
  return {
    google: createMockProvider('google', deps),
    github: createMockProvider('github', deps),
    apple: createMockProvider('apple', deps),
    microsoft: createMockProvider('microsoft', deps),
    discord: createMockProvider('discord', deps),
    linkedin: createMockProvider('linkedin', deps),
    x: createMockProvider('x', deps),
    facebook: createMockProvider('facebook', deps),
  }
}
