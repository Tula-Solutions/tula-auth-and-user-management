import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { requestId } from 'hono/request-id'
import { secureHeaders } from 'hono/secure-headers'
import { generateSpecs } from 'hono-openapi'
import type { AppEnv, Deps } from '~/dependencies'
import { ServiceException } from '~/exceptions'
import { notFound, onError } from '~/handlers'
import { API_DOCS_PATH, apiDocsRouter, findApiDocsBundle } from '~/lib/api-docs'
import { DASHBOARD_PATH, dashboardRouter, dashboardSecurityHeaders } from '~/lib/dashboard-files'
import { cors } from '~/middleware/cors'
import { clientRateLimit } from '~/middleware/rate-limit'
import { requestLog } from '~/middleware/request-log'
import { documentation, eventSchemas, hookSchemas } from '~/openapi'

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
  ['/v1/admin', (await import('~/modules/session/admin-router')).default],
  ['/v1/client', (await import('~/modules/flow/router')).default],
  ['/v1', (await import('~/modules/user/router')).default],
  ['/v1', (await import('~/modules/mfa/router')).default],
  ['/v1/admin/audit-logs', (await import('~/modules/audit/router')).default],
  ['/v1', (await import('~/modules/settings/router')).default],
  ['/v1', (await import('~/modules/oauth/router')).default],
  ['/v1', (await import('~/modules/passkey/router')).default],
  ['/v1', (await import('~/modules/phone/router')).default],
  ['/v1/admin/webhook-endpoints', (await import('~/modules/webhook/router')).default],
  ['/v1/admin/hooks', (await import('~/modules/hook/router')).default],
  ['/v1/admin/sms', (await import('~/modules/sms/router')).default],
  ['/v1/admin/message-preview', (await import('~/modules/message-preview/router')).default],
  ['/v1/instance', (await import('~/modules/instance/router')).default],
  ['/v1/instance', (await import('~/modules/control-plane/router')).default],
]

// Mounted only where the deployment runs the mock OAuth provider (`ENVIRONMENT=local` with
// `OAUTH_MOCK_PROVIDER=true`): in every other deployment the paths do not exist.
const devOAuthRouter = (await import('~/modules/oauth/dev-router')).default

// Mounted only where the deployment has the development SMS inbox (`ENVIRONMENT=local` with
// `SMS_PROVIDER=dev`): in every other deployment the path does not exist.
const devSmsRouter = (await import('~/modules/sms/dev-router')).default

// Looked up once: where the reference's bundle is in the installed package, if it is.
const docsBundle = findApiDocsBundle()

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
  if (deps.config.dashboardDir !== null) {
    // Before secureHeaders(), so that on the way out it runs after it and its stricter
    // values (the Content-Security-Policy above all) are the ones sent.
    app.use(DASHBOARD_PATH, dashboardSecurityHeaders())
    app.use(`${DASHBOARD_PATH}/*`, dashboardSecurityHeaders())
  }
  app.use(secureHeaders())
  app.use(cors(deps))
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
  // The dashboard's files, only where a build of it is present (the self-host image). Without
  // one the paths are not routed at all, so the API image without the app still works.
  if (deps.config.dashboardDir !== null) {
    app.route('/', dashboardRouter(deps.config.dashboardDir))
  }
  if (deps.config.oauthMock && deps.config.tier === 'local') {
    app.route('/v1/dev/oauth', devOAuthRouter)
  }
  if (deps.smsInbox !== null && deps.config.tier === 'local') {
    app.route('/v1/dev/sms', devSmsRouter)
  }

  // Built on the first request and kept: the routes, and beside them the schemas no route
  // refers to (the event payloads a webhook delivers, `eventSchemas`; the question and the
  // answer of a hook, `hookSchemas`). A failed build is not
  // kept, so the next request tries again.
  let specs: Awaited<ReturnType<typeof generateSpecs>> | undefined
  app.get(OPENAPI_PATH, async (c) => {
    specs ??= await generateSpecs(app, {
      documentation: {
        ...documentation,
        components: {
          ...documentation?.components,
          schemas: { ...(await eventSchemas()), ...(await hookSchemas()) },
        },
      },
      exclude: [OPENAPI_PATH, new RegExp(`^${API_DOCS_PATH}(/|$)`)],
    })
    return c.json(specs)
  })
  // The API reference: only where `API_DOCS` is on (by default, the `local` and `dev` tiers),
  // and only from the installed package. Nothing of it is loaded from another host (ADR 0032).
  if (deps.config.apiDocs && docsBundle !== null) {
    app.route('/', apiDocsRouter({ openApiPath: OPENAPI_PATH, bundle: docsBundle }))
  }

  return app
}
