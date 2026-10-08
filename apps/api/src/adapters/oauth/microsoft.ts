import { MICROSOFT_TENANT_ALIASES } from '@tula/contract'
import { MicrosoftEntraId } from 'arctic'
import type { JSONWebKeySet } from 'jose'
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
  idTokenOf,
  PROVIDER_TIMEOUT_MS,
  type ProviderKeySet,
  type ProviderOptions,
  remoteKeySet,
  verifyIdToken,
  withDeadline,
} from './id-token'

/**
 * What is asked of Microsoft: who the user is and their email address. No Graph permission and
 * no `offline_access`: Tula calls no Microsoft API for a user and keeps no token. `profile` is
 * what makes Microsoft put `oid` in the ID token.
 */
export const MICROSOFT_SCOPES = ['openid', 'profile', 'email']

/** The tenant id every personal Microsoft account signs in to. Fixed by Microsoft. */
export const MICROSOFT_CONSUMER_TENANT_ID = '9188040d-6c67-4c5b-b112-36a304b66dad'

const AUTHORITY = 'https://login.microsoftonline.com'
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** The placeholder Microsoft's tenant-independent key documents put in a key's `issuer`. */
const TENANT_PLACEHOLDER = /\{tenantid\}/i
/** Key sets kept at once: one per distinct `tenant` value in use. The oldest goes first. */
const MAX_KEY_SETS = 64

/**
 * Whether a value is a GUID in the 8-4-4-4-12 spelling, in either case.
 *
 * @param value - Anything.
 * @returns `true` for a GUID.
 */
export function isGuid(value: unknown): value is string {
  return typeof value === 'string' && GUID.test(value)
}

/**
 * The stable identity of a Microsoft account: its tenant id and its object id, as one string.
 *
 * Never the token's `sub` (pairwise: another application registration, another value), and
 * never `email`, `preferred_username` or `upn`, which a tenant administrator can set to
 * anything and which change hands. The same person in two tenants is two accounts, which is
 * what Microsoft says they are.
 *
 * @param tenantId - The token's `tid`.
 * @param objectId - The token's `oid`.
 * @returns `<tid>:<oid>`, both lower-cased, or `null` when either is not a GUID.
 */
export function microsoftSubject(tenantId: unknown, objectId: unknown): string | null {
  return isGuid(tenantId) && isGuid(objectId)
    ? `${tenantId.toLowerCase()}:${objectId.toLowerCase()}`
    : null
}

/**
 * Whether an account of the tenant `tenantId` may sign in to an environment configured with
 * `configured`.
 *
 * @param configured - The credentials' `tenant`: `common`, `organizations`, `consumers` or a
 *   tenant id.
 * @param tenantId - The token's `tid`.
 * @returns `common`: any tenant. `organizations`: any but the personal-account tenant.
 *   `consumers`: only that one. A tenant id: only itself. Anything else: none.
 */
export function tenantAccepts(configured: string | undefined, tenantId: string): boolean {
  const tid = tenantId.toLowerCase()
  switch (configured) {
    case 'common':
      return true
    case 'organizations':
      return tid !== MICROSOFT_CONSUMER_TENANT_ID
    case 'consumers':
      return tid === MICROSOFT_CONSUMER_TENANT_ID
    default:
      return isGuid(configured) && configured.toLowerCase() === tid
  }
}

/**
 * The credentials' `tenant`, checked again before it is put into a URL: it becomes a path
 * segment of Microsoft's endpoints.
 */
function authorityOf(credentials: OAuthCredentials): string {
  const tenant = credentials.tenant
  if (
    tenant === undefined ||
    !((MICROSOFT_TENANT_ALIASES as readonly string[]).includes(tenant) || isGuid(tenant))
  ) {
    throw new OAuthProviderError('unavailable')
  }
  return tenant.toLowerCase()
}

function client(credentials: OAuthCredentials, redirectUri: string): MicrosoftEntraId {
  return new MicrosoftEntraId(
    authorityOf(credentials),
    credentials.clientId,
    credentials.clientSecret ?? '',
    redirectUri
  )
}

/**
 * Whether the key that signed a token may sign for the token's issuer.
 *
 * Microsoft's key documents say, per key, whose tokens it signs (`issuer`): either one issuer
 * exactly (the personal-account tenant's keys) or a template for any tenant. Without this
 * check a key of one issuer would be accepted for a token that names another.
 *
 * A key that names no issuer is refused: every key of the v2.0 documents has one, and a key
 * whose scope is unknown cannot be shown to be the right one.
 */
function keyMayIssue(
  jwks: JSONWebKeySet | undefined,
  kid: string | undefined,
  tenantId: string,
  issuer: string
): boolean {
  const key = kid === undefined ? undefined : jwks?.keys.find((candidate) => candidate.kid === kid)
  // Not a member of RFC 7517's key: Microsoft's own.
  const scope = (key as { issuer?: unknown } | undefined)?.issuer
  return typeof scope === 'string' && scope.replace(TENANT_PLACEHOLDER, tenantId) === issuer
}

/**
 * Microsoft sign-in (Entra ID and personal accounts): OpenID Connect with PKCE (ADR 0026).
 *
 * The authorization URL and the code exchange are `arctic`'s; the ID token is verified here
 * with `jose` against the keys of the configured authority (`RS256` only, audience = client id,
 * expiry, the attempt's nonce), and then by the rules that are Microsoft's own:
 *
 * - **The issuer is the token's own tenant's.** `iss` must be exactly
 *   `https://login.microsoftonline.com/<tid>/v2.0` for the `tid` the token carries (a GUID),
 *   and the key that signed it must be one its key document scopes to that issuer.
 * - **The tenant is one the environment accepts** ({@link tenantAccepts}).
 * - **The account is `tid` + `oid`** ({@link microsoftSubject}). A token without both is
 *   refused.
 * - **The address is unverified unless the token says its domain's owner is verified**: the
 *   optional claim `xms_edov`, the boolean `true`. `email` alone is whatever a tenant
 *   administrator typed, so without the claim `emailVerified` is `false` and the account
 *   rules never link or create on it.
 *
 * Microsoft's tokens are dropped as soon as the exchange returns.
 *
 * @param options - The timeout of one outbound call.
 * @returns The adapter.
 */
export function createMicrosoftProvider(options: ProviderOptions = {}): OAuthProvider {
  const timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS
  const keySets = new Map<string, ProviderKeySet>()
  function keysOf(authority: string): ProviderKeySet {
    let keys = keySets.get(authority)
    if (!keys) {
      if (keySets.size >= MAX_KEY_SETS) {
        keySets.delete(keySets.keys().next().value as string)
      }
      keys = remoteKeySet(`${AUTHORITY}/${authority}/discovery/v2.0/keys`, timeoutMs)
      keySets.set(authority, keys)
    }
    return keys
  }

  return {
    authorizationUrl(credentials: OAuthCredentials, request: OAuthAuthorizationRequest): string {
      const url = client(credentials, request.redirectUri).createAuthorizationURL(
        request.state,
        request.codeVerifier,
        MICROSOFT_SCOPES
      )
      url.searchParams.set('nonce', request.nonce)
      return url.toString()
    },

    async exchange(
      credentials: OAuthCredentials,
      exchange: OAuthCodeExchange
    ): Promise<OAuthProfile> {
      const authority = authorityOf(credentials)
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
      const keys = keysOf(authority)
      const { payload, protectedHeader } = await verifyIdToken(
        keys,
        idToken,
        // The issuer is the token's own tenant's: judged just below, with the key's scope.
        { audience: credentials.clientId, nonce: exchange.nonce, issuers: 'caller-verifies' },
        timeoutMs
      )
      const tenantId = payload.tid
      if (
        !isGuid(tenantId) ||
        payload.iss !== `${AUTHORITY}/${tenantId}/v2.0` ||
        !keyMayIssue(keys.jwks(), protectedHeader.kid, tenantId, payload.iss) ||
        !tenantAccepts(authority, tenantId)
      ) {
        throw new OAuthProviderError('invalid_token')
      }
      const subject = microsoftSubject(tenantId, payload.oid)
      if (subject === null) {
        throw new OAuthProviderError('invalid_profile')
      }
      const email = typeof payload.email === 'string' && payload.email !== '' ? payload.email : null
      return {
        subject,
        email,
        // Microsoft documents `xms_edov` as a boolean; nothing else counts.
        emailVerified: email !== null && payload.xms_edov === true,
        givenName: displayName(payload.given_name),
        familyName: displayName(payload.family_name),
      }
    },
  }
}
