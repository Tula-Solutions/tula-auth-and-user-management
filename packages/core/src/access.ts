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
/** How long a denial is kept: the longest an access token lives, so no token it names outlasts it. */
const DENY_MS = 15 * 60_000

/** The most entries one deny map (or the latest-version map) holds; the oldest go first. */
const MAX_ENTRIES = 10_000

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

  /**
   * Take in a webhook event so that a removal takes effect before the tokens it concerns expire.
   *
   * The caller verifies the webhook's signature first (`verifyWebhook`): this takes the event as
   * trusted. It can only narrow what `check` allows, never widen it: a removed membership, a
   * revoked session and a role change deny by id for 15 minutes, and a role's new version makes
   * `check` read that version and intersect it with the token's list. An added permission is
   * granted only by a refreshed token. Unknown, malformed and test events are ignored. Nothing is
   * kept but ids, a version and a time, and nothing is persisted: a restart forgets them, and
   * a lost event leaves a token valid until it expires.
   *
   * @param event - A verified event of any type.
   */
  apply(event: unknown): void
}

interface Entry {
  permissions: Set<string>
  bytes: number
}

interface LatestRole {
  version: number
  permissions: Set<string>
}

const asString = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

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
  // What `apply` learned. Ids and numbers only; a Map's insertion order is expiry order.
  const latestVersion = new Map<string, number>()
  const deniedSessions = new Map<string, number>() // session id -> expires at (ms)
  const deniedMembers = new Map<string, { until: number; before: number }>() // org|user -> ...
  const latestInFlight = new Map<string, Promise<LatestRole>>()

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
            try {
              next.set(
                jwk.kid,
                await crypto.subtle.importKey('jwk', { kty, crv, x }, 'Ed25519', false, ['verify'])
              )
            } catch {
              // One malformed key must not take the valid ones down with it.
            }
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
    let refetched = false
    if (!key && (keysInFlight || Date.now() - keysFetchedAt >= JWKS_REFETCH_MS)) {
      refetched = true
      await refreshKeys() // a failure here is the API being unreachable, not a bad token
      key = keys.get(header.kid)
    }
    if (!key) {
      if (!refetched) {
        // The cooldown stopped the lookup: a new key may be valid, so the answer is "try again".
        throw new AccessUnavailableError('The signing key is not known yet; retry shortly.')
      }
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
      (claims.nbf !== undefined &&
        (typeof claims.nbf !== 'number' ||
          claims.nbf - CLOCK_TOLERANCE_SECONDS > Date.now() / 1000)) ||
      typeof exp !== 'number' ||
      exp + CLOCK_TOLERANCE_SECONDS < Date.now() / 1000
    ) {
      return null
    }
    return claims
  }

  function remember(key: string, permissions: Set<string>): void {
    const previous = cache.get(key)
    if (previous) {
      cache.delete(key) // re-inserted last, and its bytes counted once
      cachedBytes -= previous.bytes
    }
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

  /** The newest version of the token's own role, read with the token and cached by version. */
  async function latestOf(token: string, role: string, known: number): Promise<LatestRole> {
    const hit = cache.get(`${issuer}|${role}|${known}`)
    if (hit) {
      return { version: known, permissions: hit.permissions }
    }
    const flight = `${role}|${known}`
    let pending = latestInFlight.get(flight)
    if (!pending) {
      pending = (async () => {
        const body = (await request(
          `${options.apiUrl.replace(/\/+$/, '')}/v1/client/me/organizations/active/permissions/latest`,
          {
            authorization: `Bearer ${token}`,
            'x-tula-publishable-key': options.publishableKey,
          }
        )) as { role?: unknown; version?: unknown; hash?: unknown; permissions?: unknown } | null
        const list = body?.permissions
        if (
          body?.role !== role ||
          typeof body.version !== 'number' ||
          !Number.isInteger(body.version) ||
          typeof body.hash !== 'string' ||
          !Array.isArray(list) ||
          !list.every((k) => typeof k === 'string' && PERMISSION_KEY_PATTERN.test(k)) ||
          !(await verifyPermissionsHash(list, body.hash))
        ) {
          throw new AccessUnavailableError('The latest permission list is not the role’s.')
        }
        const permissions = new Set<string>(list)
        remember(`${issuer}|${role}|${body.version}`, permissions)
        // The server's answer is the truth: it also repairs a version an event overstated.
        setLatest(role, body.version)
        return { version: body.version, permissions }
      })().finally(() => latestInFlight.delete(flight))
      latestInFlight.set(flight, pending)
    }
    return pending
  }

  /** Drop what expired, then the oldest past the cap: the maps never grow without bound. */
  function trim(): void {
    const now = Date.now()
    for (const map of [deniedSessions, deniedMembers]) {
      for (const [key, entry] of map) {
        if ((typeof entry === 'number' ? entry : entry.until) > now) {
          break
        }
        map.delete(key)
      }
    }
    for (const map of [deniedSessions, deniedMembers, latestVersion]) {
      for (const key of map.keys()) {
        if (map.size <= MAX_ENTRIES) {
          break
        }
        map.delete(key)
      }
    }
  }

  /** Record a role's latest version; the Map keeps the most recently touched role last. */
  function setLatest(role: string, version: number): void {
    latestVersion.delete(role)
    latestVersion.set(role, version)
  }

  function denied(claims: Record<string, unknown>, orgId: string | null): boolean {
    trim()
    const sid = asString(claims.sid)
    if (sid && deniedSessions.has(sid)) {
      return true
    }
    const sub = asString(claims.sub)
    const member = sub && orgId ? deniedMembers.get(`${orgId}|${sub}`) : undefined
    if (!member) {
      return false
    }
    const iat = typeof claims.iat === 'number' ? claims.iat * 1000 : 0
    return iat <= member.before
  }

  return {
    apply(event) {
      if (typeof event !== 'object' || event === null) {
        return
      }
      const { type, test, target, data, occurredAt } = event as Record<string, unknown>
      const d = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
      const until = Date.now() + DENY_MS
      if (test === true) {
        return // nothing it describes happened
      }
      if (type === 'session.revoked' || type === 'session.reuse_detected') {
        const sid = asString((target as { id?: unknown } | null)?.id)
        if (sid) {
          deniedSessions.delete(sid) // re-inserted last: the Map stays in expiry order
          deniedSessions.set(sid, Math.max(until, deniedSessions.get(sid) ?? 0))
        }
      } else if (
        type === 'organization_membership.removed' ||
        type === 'organization_membership.role_changed'
      ) {
        const orgId = asString(d.organizationId)
        const userId = asString(d.userId)
        if (orgId && userId) {
          // A removal denies every token; a role change only the ones issued before it.
          const at = Date.parse(String(occurredAt))
          const before =
            type === 'organization_membership.removed' || Number.isNaN(at)
              ? Number.POSITIVE_INFINITY
              : at
          const k = `${orgId}|${userId}`
          // Strictest wins: a late role change never lifts an earlier removal.
          const prev = deniedMembers.get(k)
          deniedMembers.delete(k)
          deniedMembers.set(k, {
            until: Math.max(until, prev?.until ?? 0),
            before: Math.max(before, prev?.before ?? 0),
          })
        }
      } else if (type === 'organization_role.updated') {
        const role = asString(d.role)
        const version = d.version
        if (role && typeof version === 'number' && Number.isInteger(version)) {
          setLatest(role, Math.max(version, latestVersion.get(role) ?? 0))
        }
      }
      trim()
    },
    async check(token, permission) {
      const claims = await verify(token)
      if (!claims) {
        return { allowed: false, reason: 'invalid_token' }
      }
      const found = readOrganizationTokenClaims(claims)
      if (found.kind === 'none') {
        return { allowed: false, reason: 'no_organization' }
      }
      if (denied(claims, found.kind === 'inline' ? found.claims.orgId : found.orgId)) {
        return { allowed: false, reason: 'not_granted' }
      }
      if (found.kind === 'inline') {
        const { orgId, orgRole, orgPermissions } = found.claims
        return orgPermissions.includes(permission)
          ? { allowed: true, orgId, role: orgRole, version: undefined }
          : { allowed: false, reason: 'not_granted' }
      }
      const granted = await permissionsOf(token, found.permissionsHash)
      const newest = latestVersion.get(found.orgRole) ?? 0
      // Only a removal takes effect early: the token's list intersected with the newest one.
      const narrowed =
        newest > found.roleVersion
          ? (await latestOf(token, found.orgRole, newest)).permissions
          : null
      return granted.has(permission) && (!narrowed || narrowed.has(permission))
        ? { allowed: true, orgId: found.orgId, role: found.orgRole, version: found.roleVersion }
        : { allowed: false, reason: 'not_granted' }
    },
  }
}
