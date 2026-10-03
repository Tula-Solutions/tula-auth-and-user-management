import { Scalar } from '@scalar/hono-api-reference'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { requestId } from 'hono/request-id'
import { secureHeaders } from 'hono/secure-headers'
import { openAPIRouteHandler } from 'hono-openapi'
import type { AppEnv, Deps } from '~/dependencies'
import { ServiceException } from '~/exceptions'
import { notFound, onError } from '~/handlers'
import { allowedOrigin } from '~/lib/cors'
import { PUBLISHABLE_KEY_HEADER } from '~/middleware/publishable-key'
import { clientRateLimit } from '~/middleware/rate-limit'
import { requestLog } from '~/middleware/request-log'
import { CLIENT_HEADER } from '~/modules/flow/schema'
import { documentation } from '~/openapi'

/**
 * Largest request body the API reads. Auth payloads are a few hundred bytes; the cap stops a
 * client streaming megabytes into JSON parsing or password normalization.
 */
export const MAX_BODY_BYTES = 64 * 1024

/** Where the OpenAPI document is served. */
export const OPENAPI_PATH = '/v1/openapi.json'

// Routers never capture deps (they read `c.get('deps')`), so they are loaded once here and shared
// by every app `createApp` builds. That keeps createApp synchronous for tests.
const routes: ReadonlyArray<readonly [path: string, router: Hono<AppEnv>]> = [
  ['/v1', (await import('~/modules/status/router')).default],
  ['/v1/admin', (await import('~/modules/project/router')).default],
  ['/v1', (await import('~/modules/jwks/router')).default],
  ['/v1/client', (await import('~/modules/password/router')).default],
  ['/v1/client', (await import('~/modules/session/router')).default],
  ['/v1/client', (await import('~/modules/flow/router')).default],
  ['/v1', (await import('~/modules/user/router')).default],
  ['/v1/admin/audit-logs', (await import('~/modules/audit/router')).default],
]

/**
 * Build the Tula API app without listening.
 *
 * `server.ts` serves it; tests call `createApp(createTestDeps()).request(...)`; embedded mode
 * mounts it inside a host app.
 *
 * @param deps - Adapters and config for this app instance.
 * @returns The Hono app.
 *
 * @example
 * ```ts
 * const res = await createApp(createTestDeps()).request('/v1/status')
 * ```
 */
export function createApp(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.use(requestId())
  app.use(requestLog())
  app.use(secureHeaders())
  app.use(
    cors({
      origin: (origin) => allowedOrigin(origin, deps.config),
      credentials: true,
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', PUBLISHABLE_KEY_HEADER, CLIENT_HEADER],
      exposeHeaders: ['Retry-After', 'X-Request-Id'],
      maxAge: 600,
    })
  )
  // After cors() so a 413 still carries CORS headers and browsers can read the error code.
  app.use(
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: () => {
        throw new ServiceException('request.too_large')
      },
    })
  )
  app.use(async (c, next) => {
    c.set('deps', deps)
    await next()
  })
  app.onError(onError)
  app.notFound(notFound)

  // One per-IP ceiling for every client route, counted before the publishable key is resolved
  // so key guessing is limited too. Mounted here so a new client router cannot forget it.
  app.use('/v1/client/*', clientRateLimit())

  for (const [path, router] of routes) {
    app.route(path, router)
  }

  app.get(
    OPENAPI_PATH,
    openAPIRouteHandler(app, { documentation, exclude: [OPENAPI_PATH, '/v1/docs'] })
  )
  app.get('/v1/docs', Scalar({ url: OPENAPI_PATH, pageTitle: 'Tula API' }))

  return app
}
