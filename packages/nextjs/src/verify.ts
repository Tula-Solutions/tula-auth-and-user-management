import { createRemoteJWKSet, customFetch, decodeProtectedHeader, jwtVerify } from 'jose'
import type { FetchLike, TulaConfig } from './config'

// Verifying an access token without asking the API: its signature against the environment's
// published keys, and every claim that says where it came from and whom it is for.

/**
 * The claims of a verified session: what an access token carries, or what the API answered
 * for a `stateful` session.
 *
 * @example
 * ```ts
 * const { claims } = await auth()
 * claims?.amr // e.g. ['pwd', 'totp']: a set, the order means nothing
 * ```
 */
export interface SessionClaims {
  /** The issuer: the environment's URL under the API. */
  iss: string
  /** The user id. */
  sub: string
  /** The audience: the environment id. */
  aud: string
  /** The session id. */
  sid: string
  /** When the claims stop being valid, in seconds since the epoch. */
  exp: number
  /** When the user last proved a factor for this session, in seconds since the epoch. */
  auth_time?: number
  /** The methods the session was authenticated with. */
  amr?: string[]
  [claim: string]: unknown
}

/** Seconds of clock difference tolerated between this server and the API. */
export const CLOCK_TOLERANCE_SECONDS = 5

/**
 * A token this close to its expiry is treated as expired: the request it authenticates still
 * has work to do with it (render, call the API), and a refresh now is cheaper than a 401 then.
 */
export const EXPIRY_MARGIN_SECONDS = 10

type KeySet = ReturnType<typeof createRemoteJWKSet>

// One key set per JWKS URL and `fetch`: keys are fetched once and kept in memory (jose
// re-fetches on an unknown `kid`, at most every 30 seconds, and after ten minutes).
const keySets = new WeakMap<FetchLike, Map<string, KeySet>>()

function keySetFor(config: Pick<TulaConfig, 'jwksUrl' | 'fetch' | 'timeoutMs'>): KeySet {
  let byUrl = keySets.get(config.fetch)
  if (!byUrl) {
    byUrl = new Map()
    keySets.set(config.fetch, byUrl)
  }
  let keys = byUrl.get(config.jwksUrl)
  if (!keys) {
    keys = createRemoteJWKSet(new URL(config.jwksUrl), {
      timeoutDuration: Math.min(config.timeoutMs, 5000),
      [customFetch]: (url, init) => config.fetch(new Request(url, init as RequestInit)),
    })
    byUrl.set(config.jwksUrl, keys)
  }
  return keys
}

/**
 * Whether claims are a session of this environment: issued by it, for it, naming a user and a
 * session, and not expired.
 *
 * @param claims - The candidate claims.
 * @param config - The configuration.
 * @returns Whether they can be relied on.
 *
 * @example
 * ```ts
 * isSessionOf({ iss, sub: 'u1', aud: environmentId, sid: 's1', exp: later }, config) // true
 * ```
 */
export function isSessionOf(
  claims: unknown,
  config: Pick<TulaConfig, 'issuer' | 'environmentId'>
): claims is SessionClaims {
  if (typeof claims !== 'object' || claims === null) {
    return false
  }
  const { iss, sub, aud, sid, exp } = claims as Record<string, unknown>
  return (
    iss === config.issuer &&
    aud === config.environmentId &&
    typeof sub === 'string' &&
    sub !== '' &&
    typeof sid === 'string' &&
    sid !== '' &&
    typeof exp === 'number' &&
    exp * 1000 > Date.now() - CLOCK_TOLERANCE_SECONDS * 1000
  )
}

/**
 * Verify an access token offline.
 *
 * Accepted only when it is signed with `EdDSA` by a key the environment publishes under the
 * token's `kid` (a token without one is refused), its `iss` is the environment's issuer, its
 * `aud` the environment's id, it has not expired, and it names a user and a session. `alg:
 * none`, another algorithm, another environment's token and a tampered one all fail the same
 * way: `null`, and nothing about why.
 *
 * @param token - The token, as the cookie holds it.
 * @param config - The configuration.
 * @returns The claims, or `null` when the token cannot be relied on (also when the keys
 *   cannot be fetched).
 *
 * @example
 * ```ts
 * const claims = await verifyAccessToken(token, config)
 * if (claims) {
 *   claims.sub // the user id
 * }
 * ```
 */
export async function verifyAccessToken(
  token: string,
  config: TulaConfig
): Promise<SessionClaims | null> {
  try {
    const header = decodeProtectedHeader(token)
    if (header.alg !== 'EdDSA' || typeof header.kid !== 'string' || header.kid === '') {
      return null
    }
    const { payload } = await jwtVerify(token, keySetFor(config), {
      algorithms: ['EdDSA'],
      issuer: config.issuer,
      audience: config.environmentId,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ['sub', 'sid', 'exp', 'iss', 'aud'],
    })
    return isSessionOf(payload, config) ? payload : null
  } catch {
    return null
  }
}

/**
 * Whether verified claims are still good for a whole request.
 *
 * @param claims - Verified claims.
 * @returns `false` within {@link EXPIRY_MARGIN_SECONDS} of their expiry.
 *
 * @example
 * ```ts
 * hasTimeLeft({ ...claims, exp: Date.now() / 1000 + 3 }) // false: refresh first
 * ```
 */
export function hasTimeLeft(claims: Pick<SessionClaims, 'exp'>): boolean {
  return claims.exp * 1000 - Date.now() > EXPIRY_MARGIN_SECONDS * 1000
}
