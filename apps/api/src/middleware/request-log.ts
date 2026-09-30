import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '~/dependencies'
import * as logger from '~/lib/logger'

/**
 * Log one line per request: id, method, path, status and duration.
 *
 * Logs `c.req.path`, which excludes the query string: magic-link and OAuth callbacks carry
 * secrets there.
 *
 * @returns The middleware.
 */
export function requestLog() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const started = performance.now()
    await next()
    logger.info('request', {
      requestId: c.get('requestId'),
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Math.round(performance.now() - started),
    })
  })
}
