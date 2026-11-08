import {
  readOrganizationTokenClaims,
  verifyPermissionsHash,
} from '@tula-tech/contract/custom-claims'
import { environmentIssuer, jwksUrl } from '@tula-tech/contract/issuer'
import { PERMISSION_KEY_PATTERN } from '@tula-tech/contract/organization-permissions'

// The server-side permission check ([ADR 0068](../../../docs/adr/0068-role-permission-snapshots.md),
// section 5): verify a token offline, then decide from its claims or from a list fetched once per
// role version. Web Crypto only (no dependency), so it runs where `@tula-tech/core` does.

/** Seconds of clock difference tolerated between this server and the API. */
const CLOCK_TOLERANCE_SECONDS = 5
/** The least time between two refetches of the key set for a `kid` it does not hold. */
const JWKS_REFETCH_MS = 30_000
const DEFAULT_CACHE_BYTES = 8 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 5000

/**
 * Thrown by {@link AccessChecker.check} when a decision cannot be made safely: the permission
 * list could not be fetched, or did not prove to be the token's. Map it to 503; never allow.
 *
 * @example
 * ```ts
 * try {
 *   await access.check(token, 'org:leads:view')
 * } catch (error) {
 *   if (error instanceof AccessUnavailableError) {
 *     return new Response(null, { status: 503 })
 *   }
 * }
 * ```
 */
export class AccessUnavailableError extends Error {
  override readonly name = 'AccessUnavailableError'
}

/** What {@link AccessChecker.check} answers. */
export type AccessDecision =
  | {
      allowed: true
      orgId: string
      role: string
      /** The role's version; absent for a token that carries its permissions inline. */
      version: number | undefined
    }
  | { allowed: false; reason: 'no_organization' | 'not_granted' | 'invalid_token' }

/** Options of {@link createAccessChecker}. */
export interface AccessCheckerOptions {
  /** The API's address; the only host the checker ever calls. */
  apiUrl: string
  /** The environment whose tokens are accepted. */
  environmentId: string
  /** The environment's publishable key, sent with a permission lookup. */
  publishableKey: string
  /** A `fetch` to use instead of the global one. */
  fetch?: typeof fetch
  /** The most the cache of permission lists may hold, estimated in bytes. Default 8 MB. */
  cacheBytes?: number
  /** The deadline of one request to the API, in milliseconds. Default 5000. */
  timeoutMs?: number
}

/** The checker {@link createAccessChecker} builds. */
export interface AccessChecker {
  /**
   * Verify an access token and decide whether its active organization grants a permission.
   *
   * @param token - The raw access token.
   * @param permission - A permission key such as `org:leads:view`.
   * @returns The decision.
   * @throws AccessUnavailableError when a needed lookup fails or its answer is not the token's.
   */
  check(token: string, permission: string): Promise<AccessDecision>
}

interface Entry {
  permissions: Set<string>
  bytes: number
}

function decodePart(part: string): Uint8Array<ArrayBuffer> {
  const binary = atob(part.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(decodePart(part)))
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * Build a checker for one environment of one API.
 *
 * A token's permissions inline are checked with no I/O. A large role's are fetched once per
 * `org_ph` and kept in a least-recently-used cache bounded in bytes and never by time: a role
 * change is a new hash, so an entry cannot go stale. Failures are never cached.
 *
 * @param options - The API, the environment and the publishable key.
 * @returns The checker.
 *
 * @example
 * ```ts
 * import { createAccessChecker } from '@tula-tech/core/access'
 *
 * const access = createAccessChecker({
 *   apiUrl: 'https://auth.example.com',
 *   environmentId: 'env_1',
 *   publishableKey: 'tula_pk_prod_...',
 * })
 * const decision = await access.check(accessToken, 'org:leads:view')
 * ```
 */
export function createAccessChecker(options: AccessCheckerOptions): AccessChecker {
  const doFetch = options.fetch ?? fetch
  const issuer = environmentIssuer(options.apiUrl, options.environmentId)
  const maxBytes = options.cacheBytes ?? DEFAULT_CACHE_BYTES
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const keys = new Map<string, CryptoKey>()
  let keysFetchedAt = Number.NEGATIVE_INFINITY
  let keysInFlight: Promise<void> | null = null
  const cache = new Map<string, Entry>() // insertion order is recency
  const inFlight = new Map<string, Promise<Set<string>>>()
  let cachedBytes = 0

  async function request(url: string, headers: Record<string, string>): Promise<unknown> {
    const signal = AbortSignal.timeout(timeoutMs)
    // Raced as well as passed: a `fetch` that ignores the signal still ends at the deadline.
    const deadline = new Promise<never>((_, reject) =>
      signal.addEventListener('abort', () => reject(new Error('timeout')))
    )
    try {
      const work = (async () => {
        const response = await doFetch(url, { headers, signal, redirect: 'error' })
        if (!response.ok) {
          throw new Error(`status ${response.status}`)
        }
        return response.json() as Promise<unknown>
      })()
      return await Promise.race([work, deadline])
    } catch (cause) {
      throw new AccessUnavailableError('The access lookup failed.', { cause })
    }
  }

  function refreshKeys(): Promise<void> {
    keysInFlight ??= (async () => {
      try {
        keysFetchedAt = Date.now()
        const body = (await request(jwksUrl(issuer), {})) as { keys?: unknown }
        const next = new Map<string, CryptoKey>()
        for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
          if (jwk?.kty === 'OKP' && jwk.crv === 'Ed25519' && typeof jwk.kid === 'string') {
            const { kty, crv, x } = jwk
            next.set(
              jwk.kid,
              await crypto.subtle.importKey('jwk', { kty, crv, x }, 'Ed25519', false, ['verify'])
            )
          }
        }
        keys.clear()
        for (const [kid, key] of next) {
          keys.set(kid, key)
        }
      } finally {
        keysInFlight = null
      }
    })()
    return keysInFlight
  }

  /** The verified claims, or `null` for a token that is not this environment's. */
  async function verify(token: string): Promise<Record<string, unknown> | null> {
    const parts = token.split('.')
    if (parts.length !== 3) {
      return null
    }
    const [h, p, s] = parts as [string, string, string]
    let header: Record<string, unknown> | null
    let claims: Record<string, unknown> | null
    try {
      header = decodeJson(h)
      claims = decodeJson(p)
    } catch {
      return null
    }
    if (
      header?.alg !== 'EdDSA' ||
      header.typ !== 'JWT' ||
      typeof header.kid !== 'string' ||
      !claims
    ) {
      return null
    }
    let key = keys.get(header.kid)
    if (!key && (keysInFlight || Date.now() - keysFetchedAt >= JWKS_REFETCH_MS)) {
      await refreshKeys() // a failure here is the API being unreachable, not a bad token
      key = keys.get(header.kid)
    }
    if (!key) {
      return null
    }
    let signature: Uint8Array<ArrayBuffer>
    try {
      signature = decodePart(s)
    } catch {
      return null
    }
    const signed = new TextEncoder().encode(`${h}.${p}`)
    if (!(await crypto.subtle.verify('Ed25519', key, signature, signed))) {
      return null
    }
    const { iss, aud, exp } = claims
    if (
      iss !== issuer ||
      aud !== options.environmentId ||
      typeof exp !== 'number' ||
      exp + CLOCK_TOLERANCE_SECONDS < Date.now() / 1000
    ) {
      return null
    }
    return claims
  }

  function remember(key: string, permissions: Set<string>): void {
    let bytes = key.length * 2
    for (const permission of permissions) {
      bytes += permission.length * 2
    }
    cache.set(key, { permissions, bytes })
    cachedBytes += bytes
    for (const [oldest, entry] of cache) {
      if (cachedBytes <= maxBytes) {
        break
      }
      cache.delete(oldest)
      cachedBytes -= entry.bytes
    }
  }

  async function fetchList(token: string, hash: string): Promise<Set<string>> {
    const body = (await request(
      `${options.apiUrl.replace(/\/+$/, '')}/v1/client/me/organizations/active/permissions`,
      {
        authorization: `Bearer ${token}`,
        'x-tula-publishable-key': options.publishableKey,
      }
    )) as { hash?: unknown; permissions?: unknown } | null
    const list = body?.permissions
    if (
      body?.hash !== hash ||
      !Array.isArray(list) ||
      !list.every((k) => typeof k === 'string' && PERMISSION_KEY_PATTERN.test(k)) ||
      !(await verifyPermissionsHash(list, hash))
    ) {
      throw new AccessUnavailableError('The permission list is not the token’s.')
    }
    return new Set(list)
  }

  async function permissionsOf(token: string, hash: string): Promise<Set<string>> {
    const key = `${issuer}|${hash}`
    const hit = cache.get(key)
    if (hit) {
      cache.delete(key)
      cache.set(key, hit) // most recently used last
      return hit.permissions
    }
    let pending = inFlight.get(key)
    if (!pending) {
      pending = fetchList(token, hash)
        .then((set) => {
          remember(key, set)
          return set
        })
        .finally(() => inFlight.delete(key))
      inFlight.set(key, pending)
    }
    return pending
  }

  return {
    async check(token, permission) {
      const claims = await verify(token)
      if (!claims) {
        return { allowed: false, reason: 'invalid_token' }
      }
      const found = readOrganizationTokenClaims(claims)
      if (found.kind === 'none') {
        return { allowed: false, reason: 'no_organization' }
      }
      if (found.kind === 'inline') {
        const { orgId, orgRole, orgPermissions } = found.claims
        return orgPermissions.includes(permission)
          ? { allowed: true, orgId, role: orgRole, version: undefined }
          : { allowed: false, reason: 'not_granted' }
      }
      const granted = await permissionsOf(token, found.permissionsHash)
      return granted.has(permission)
        ? { allowed: true, orgId: found.orgId, role: found.orgRole, version: found.roleVersion }
        : { allowed: false, reason: 'not_granted' }
    },
  }
}
