import { durationToMs } from '@tula/contract'
import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { AppEnv, TenantVariables } from '~/dependencies'
import { RateLimitError, ServiceUnavailableError } from '~/exceptions'
import { clientIp, ipBucket } from '~/lib/client-ip'
import * as logger from '~/lib/logger'
import type { RateLimitDecision } from '~/ports/rate-limiter'

/** One rate-limit bucket family. */
export interface RateLimitRule {
  /** Namespace for the bucket, e.g. `sign_in`. */
  name: string
  /** Maximum requests per window. */
  limit: number
  /** Window length, e.g. `'1m'`. */
  window: string
  /**
   * The bucket key for this request, e.g. the client IP. Return `null` to skip the rule.
   */
  key: (c: Context<AppEnv>) => string | null
  /**
   * What to do when the limiter itself cannot answer (its shared store is unreachable).
   *
   * - `'refuse'` (the default): the request fails with `service.unavailable`. Required for
   *   anything that accepts a guessable secret or does costly work, where an uncounted request
   *   is exactly what an attacker wants.
   * - `'allow'`: the request goes on uncounted. Only for routes whose own protection does not
   *   depend on the count (unguessable tokens, public data, the readiness check) and which
   *   should keep working through an outage of the store. See ADR 0016.
   */
  whenUnavailable?: 'refuse' | 'allow'
}

/**
 * Bucket by client IP: the address for IPv4, the /64 for IPv6 (see `ipBucket`).
 *
 * @param c - The request context.
 * @returns `ip:<bucket>`.
 */
export function byIp(c: Context<AppEnv>): string {
  return `ip:${ipBucket(clientIp(c, c.get('deps').config.trustProxy))}`
}

/**
 * Bucket by the resolved environment (mount after a key middleware).
 *
 * @param c - The request context.
 * @returns `env:<id>`, or `null` when no tenant is resolved.
 */
export function byEnvironment(c: Context<AppEnv>): string | null {
  const { tenant } = c.var as Partial<TenantVariables>
  return tenant ? `env:${tenant.environmentId}` : null
}

/** Count the request; `null` when the limiter is unavailable and the rule lets requests through. */
async function count(
  c: Context<AppEnv>,
  rule: RateLimitRule,
  bucket: string,
  windowMs: number
): Promise<RateLimitDecision | null> {
  try {
    return await c.get('deps').rateLimiter.hit(bucket, rule.limit, windowMs)
  } catch (error) {
    if (rule.whenUnavailable === 'allow' && error instanceof ServiceUnavailableError) {
      logger.warn('rate limiter unavailable; request allowed uncounted', {
        requestId: c.get('requestId'),
        rule: rule.name,
      })
      return null
    }
    throw error
  }
}

/**
 * Enforce a fixed-window rate limit. Stack one per dimension (IP, environment, …); per-identifier
 * limits need the parsed body and are applied in services through `deps.rateLimiter`.
 *
 * @param rule - Name, limit, window and key function.
 * @returns The middleware.
 * @throws RateLimitError (429 with `Retry-After`) once the limit is exceeded.
 * @throws ServiceUnavailableError (503) when the limiter cannot answer, unless the rule's
 *   `whenUnavailable` is `'allow'`.
 */
export function rateLimit(rule: RateLimitRule) {
  const windowMs = durationToMs(rule.window)
  return createMiddleware<AppEnv>(async (c, next) => {
    const key = rule.key(c)
    if (key !== null) {
      const decision = await count(c, rule, `${rule.name}:${key}`, windowMs)
      if (decision && !decision.allowed) {
        throw new RateLimitError(decision.retryAfterMs)
      }
    }
    await next()
  })
}

/** Requests per minute one IP may make to admin routes, counted before the key is checked. */
export const ADMIN_RATE_LIMIT = 300

/**
 * Per-IP limit for `/v1/admin/*`. Mount it **before** `secretKey()` so failed key guesses count
 * too: key resolution is an unauthenticated database lookup.
 *
 * @returns The middleware (one shared `admin` bucket per IP across all admin routes).
 */
export function adminRateLimit() {
  return rateLimit({ name: 'admin', limit: ADMIN_RATE_LIMIT, window: '1m', key: byIp })
}

/** Requests per minute one IP may make to client routes, counted before the key is checked. */
export const CLIENT_RATE_LIMIT = 600

/**
 * Per-IP limit for `/v1/client/*`, mounted once for the whole group in `createApp` so it runs
 * before any route's `publishableKey()` and failed key guesses count too. It is a coarse ceiling (higher than admin because many users can share one NAT'd
 * IP); credential endpoints add tighter per-route, per-identifier limits.
 *
 * @returns The middleware (one shared `client` bucket per IP across all client routes).
 */
export function clientRateLimit() {
  return rateLimit({
    name: 'client',
    limit: CLIENT_RATE_LIMIT,
    window: '1m',
    key: byIp,
    // This ceiling sits in front of every client route, refresh included. Refusing here would
    // turn an outage of the limiter's store into an outage of all of them; the routes that
    // take a guessable secret have their own limits, which do refuse.
    whenUnavailable: 'allow',
  })
}
