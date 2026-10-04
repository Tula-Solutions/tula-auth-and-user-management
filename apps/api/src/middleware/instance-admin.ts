import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '~/dependencies'
import { AuthError, NotFoundError } from '~/exceptions'
import { sha256Hex, timingSafeEqual } from '~/lib/crypto'
import { bearerToken } from '~/middleware/api-key'
import { byIp, rateLimit } from '~/middleware/rate-limit'

/** Longer values are refused before hashing, so a huge header costs nothing. */
const MAX_TOKEN_LENGTH = 256

/**
 * Requests per minute one IP may make to `/v1/instance/*`, counted before the token is checked
 * so that guesses count. The routes are costly (diagnostics connects to every dependency) and
 * only ever called by an operator, so the ceiling is low.
 */
export const INSTANCE_RATE_LIMIT = 30

/**
 * Guard `/v1/instance/*` with the instance admin token (`TULA_ADMIN_TOKEN`, ADR 0031).
 *
 * In order:
 *
 * 1. A deployment that sets no token has no instance routes: the answer is the 404 of a path
 *    that was never routed, before anything is counted, so their existence is not advertised.
 * 2. The request is counted per IP. When the limiter cannot count, it is refused
 *    (`service.unavailable`): an uncounted guess at the most powerful credential of a
 *    deployment is exactly what must not happen.
 * 3. The presented bearer token is compared with the configured one as SHA-256 digests, in
 *    constant time. Missing, malformed and wrong get the same `auth.invalid_key`.
 *
 * The token is never logged, and the configuration holds only its digest.
 *
 * @returns The middleware.
 * @throws NotFoundError when the deployment has no admin token.
 * @throws RateLimitError (429) past {@link INSTANCE_RATE_LIMIT} a minute from one IP.
 * @throws AuthError `auth.invalid_key` when the token is missing or wrong.
 */
export function instanceAdmin() {
  const limit = rateLimit({
    name: 'instance',
    limit: INSTANCE_RATE_LIMIT,
    window: '1m',
    key: byIp,
    whenUnavailable: 'refuse',
  })
  return createMiddleware<AppEnv>(async (c, next) => {
    const expected = c.get('deps').config.instanceAdminTokenHash
    if (expected === null) {
      throw new NotFoundError()
    }
    await limit(c, async () => {
      const presented = bearerToken(c.req.header('authorization'))
      // Hashing first makes both sides the same length whatever was presented.
      const digest = sha256Hex(
        presented !== undefined && presented.length <= MAX_TOKEN_LENGTH ? presented : ''
      )
      if (presented === undefined || !timingSafeEqual(digest, expected)) {
        throw new AuthError('auth.invalid_key')
      }
      await next()
    })
  })
}
