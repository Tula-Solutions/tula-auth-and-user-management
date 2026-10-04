import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '~/dependencies'
import { AuthError, NotFoundError } from '~/exceptions'
import { sha256Hex, timingSafeEqual } from '~/lib/crypto'
import { bearerToken } from '~/middleware/api-key'
import { isDashboardRequest, requireDashboardSession } from '~/middleware/dashboard-session'
import { adminRateLimit, byIp, rateLimit } from '~/middleware/rate-limit'

/** Longer values are refused before hashing, so a huge header costs nothing. */
const MAX_TOKEN_LENGTH = 256

/**
 * Requests per minute one IP may make to `/v1/instance/*`, counted before the token is checked
 * so that guesses count. The routes are costly (diagnostics connects to every dependency) and
 * only ever called by an operator, so the ceiling is low.
 */
export const INSTANCE_RATE_LIMIT = 30

/**
 * The per-IP limit of every request that presents the instance admin token, counted before
 * the token is looked at. It refuses when the limiter cannot count (`service.unavailable`): an
 * uncounted guess at the most powerful credential of a deployment is exactly what must not
 * happen.
 *
 * @returns The middleware (one shared `instance` bucket per IP).
 */
export function instanceTokenRateLimit() {
  return rateLimit({
    name: 'instance',
    limit: INSTANCE_RATE_LIMIT,
    window: '1m',
    key: byIp,
    whenUnavailable: 'refuse',
  })
}

/**
 * Whether a presented value is the instance admin token. Both sides are compared as SHA-256
 * digests, in constant time, whatever the length of what was presented.
 *
 * @param expected - The configured token's digest (`config.instanceAdminTokenHash`).
 * @param presented - What the request carried, if anything.
 * @returns Whether they match.
 */
export function isInstanceAdminToken(expected: string, presented: string | undefined): boolean {
  // Hashing first makes both sides the same length whatever was presented.
  const digest = sha256Hex(
    presented !== undefined && presented.length <= MAX_TOKEN_LENGTH ? presented : ''
  )
  return timingSafeEqual(digest, expected) && presented !== undefined
}

/**
 * Answer the 404 of a path that was never routed where the deployment sets no admin token,
 * before anything is counted, so the instance routes are not advertised.
 *
 * @returns The middleware.
 * @throws NotFoundError when the deployment has no admin token.
 */
export function instanceRoutesExist() {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (c.get('deps').config.instanceAdminTokenHash === null) {
      throw new NotFoundError()
    }
    await next()
  })
}

/**
 * Guard `/v1/instance/*` with the instance admin token (`TULA_ADMIN_TOKEN`, ADR 0031) or a
 * dashboard session made from it (ADR 0032).
 *
 * In order:
 *
 * 1. A deployment that sets no token has no instance routes: the answer is the 404 of a path
 *    that was never routed, before anything is counted, so their existence is not advertised.
 * 2. A request that carries `x-tula-dashboard` is the dashboard's: it is counted in the admin
 *    bucket and must have a valid session cookie and pass the CSRF rules
 *    (`~/middleware/dashboard-session`). It must not carry an `Authorization` header.
 * 3. Any other request is counted per IP ({@link instanceTokenRateLimit}), then its bearer
 *    token is compared with the configured one. Missing, malformed and wrong get the same
 *    `auth.invalid_key`.
 *
 * The token is never logged, and the configuration holds only its digest.
 *
 * @returns The middleware.
 * @throws NotFoundError when the deployment has no admin token.
 * @throws RateLimitError (429) past the limit of the bucket the request counts in.
 * @throws AuthError `auth.invalid_key` when the token is missing or wrong.
 * @throws UnauthorizedError `auth.unauthenticated` when a dashboard request has no valid session.
 * @throws AuthError `request.origin_not_allowed` when a dashboard request breaks the CSRF rules.
 */
export function instanceAdmin() {
  const tokenLimit = instanceTokenRateLimit()
  const sessionLimit = adminRateLimit()
  return createMiddleware<AppEnv>(async (c, next) => {
    const expected = c.get('deps').config.instanceAdminTokenHash
    if (expected === null) {
      throw new NotFoundError()
    }
    if (isDashboardRequest(c)) {
      await sessionLimit(c, async () => {
        await requireDashboardSession(c)
        await next()
      })
      return
    }
    await tokenLimit(c, async () => {
      if (!isInstanceAdminToken(expected, bearerToken(c.req.header('authorization')))) {
        throw new AuthError('auth.invalid_key')
      }
      await next()
    })
  })
}
