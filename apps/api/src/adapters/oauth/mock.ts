import type { OAuthProvider as OAuthProviderName } from '@tula/contract'
import { tenantAccepts } from '~/adapters/oauth/microsoft'
import { timingSafeEqual } from '~/lib/crypto'
import type { SecretBox } from '~/lib/secret-box'
import type { Clock } from '~/ports/clock'
import {
  type OAuthAuthorizationRequest,
  type OAuthCodeExchange,
  type OAuthCredentials,
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
      return grant.profile
    },
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
  }
}
