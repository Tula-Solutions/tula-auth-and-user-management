import { durationToMs } from '@tula/contract'
import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { AppEnv, TenantVariables } from '~/dependencies'
import { RateLimitError } from '~/exceptions'
import { clientIp } from '~/lib/client-ip'

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
}

/**
 * Bucket by client IP.
 *
 * @param c - The request context.
 * @returns `ip:<address>`.
 */
export function byIp(c: Context<AppEnv>): string {
  return `ip:${clientIp(c, c.get('deps').config.trustProxy)}`
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

/**
 * Enforce a fixed-window rate limit. Stack one per dimension (IP, environment, …); per-identifier
 * limits need the parsed body and are applied in services through `deps.rateLimiter`.
 *
 * @param rule - Name, limit, window and key function.
 * @returns The middleware.
 * @throws RateLimitError (429 with `Retry-After`) once the limit is exceeded.
 */
export function rateLimit(rule: RateLimitRule) {
  const windowMs = durationToMs(rule.window)
  return createMiddleware<AppEnv>(async (c, next) => {
    const key = rule.key(c)
    if (key !== null) {
      const decision = await c
        .get('deps')
        .rateLimiter.hit(`${rule.name}:${key}`, rule.limit, windowMs)
      if (!decision.allowed) {
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
  return rateLimit({ name: 'client', limit: CLIENT_RATE_LIMIT, window: '1m', key: byIp })
}

/**
 * A ceiling for one environment across every IP, for steps that cost real resources (an
 * argon2id hash, an email). It bounds what a distributed attack on one tenant can make the
 * server do. Mount it **after** a key middleware, which resolves the environment.
 *
 * @param name - The step, e.g. `sign_up`.
 * @param limit - Requests per minute for the whole environment.
 * @returns The middleware.
 */
export function environmentRateLimit(name: string, limit: number) {
  return rateLimit({ name: `environment_${name}`, limit, window: '1m', key: byEnvironment })
}
