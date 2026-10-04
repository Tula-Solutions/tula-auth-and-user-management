import { CAN_STILL_SIGN_IN_HEADER } from '@tula/contract'
import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { AppEnv, Deps, Tenant, TenantVariables } from '~/dependencies'
import { allowedOrigin } from '~/lib/cors'
import * as logger from '~/lib/logger'
import { PUBLISHABLE_KEY_HEADER } from '~/middleware/publishable-key'
import { CLIENT_HEADER, FLOW_ATTEMPT_HEADER, SESSION_PROFILE_HEADER } from '~/modules/flow/schema'
import * as Settings from '~/modules/settings/service'

/** Methods a browser may use. Every method the API has routes for. */
export const CORS_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const

/** Request headers a browser may send. */
export const CORS_REQUEST_HEADERS = [
  'Content-Type',
  'Authorization',
  'If-Match',
  PUBLISHABLE_KEY_HEADER,
  CLIENT_HEADER,
  FLOW_ATTEMPT_HEADER,
  SESSION_PROFILE_HEADER,
] as const

/**
 * Response headers a browser's JavaScript may read. The last one is how an admin reset says
 * whether the user can still sign in: without it the dashboard, a browser caller, could not.
 */
export const CORS_EXPOSED_HEADERS = [
  'Retry-After',
  'X-Request-Id',
  'ETag',
  CAN_STILL_SIGN_IN_HEADER,
] as const

/** How long a browser may reuse a preflight answer, in seconds. */
export const CORS_PREFLIGHT_MAX_AGE_SECONDS = 600

type OriginDeps = Pick<Deps, 'config' | 'environmentSettings'>

/**
 * Whether an origin may call the client API of one environment and read its responses.
 *
 * True for an origin in the environment's `urls.allowedOrigins`, for the API's own origin, and
 * in the `local` tier for any loopback origin. The match is exact, never a pattern.
 *
 * @param deps - Settings store and config.
 * @param tenant - The environment the request's key resolved to.
 * @param origin - The request's `Origin` header.
 * @returns Whether the origin is allowed for that environment.
 */
export async function environmentAllowsOrigin(
  deps: OriginDeps,
  tenant: Pick<Tenant, 'environmentId'>,
  origin: string
): Promise<boolean> {
  if (origin === new URL(deps.config.publicUrl).origin) {
    return true
  }
  const { urls } = await Settings.current(deps, tenant)
  return (
    allowedOrigin(origin, { tier: deps.config.tier, corsOrigins: urls.allowedOrigins }) !== null
  )
}

/**
 * Whether an origin is allowed by the deployment's own list or by **any** environment.
 *
 * This is the question a preflight can be answered with: it carries no API key, so the
 * environment it is for is not known. It decides only whether the browser may send the real
 * request; whether that request's response is readable is decided again, per environment.
 *
 * @param deps - Settings store and config.
 * @param origin - The request's `Origin` header.
 * @returns Whether some environment, or the deployment default, allows the origin.
 */
export async function anyEnvironmentAllowsOrigin(
  deps: OriginDeps,
  origin: string
): Promise<boolean> {
  if (allowedOrigin(origin, deps.config) !== null) {
    return true
  }
  return (await deps.environmentSettings.allowedOrigins()).includes(origin)
}

/**
 * Whether a request may use the refresh cookie: be authenticated by it, or have it set.
 *
 * A browser attaches cookies by itself, so a page on another origin of the same site could make
 * a signed-in user's browser refresh or sign out without asking (`SameSite=Lax` only stops
 * other *sites*). The cookie is therefore honoured only when the request has no `Origin` (not a
 * cross-origin browser request) or an origin the environment allows. A token in the request
 * body is never affected: JavaScript had to hold it.
 *
 * The flow routes apply the same rule to *setting* the cookie: a browser attempt is refused
 * from any other origin, so a foreign page cannot sign the browser in to an account of its
 * choosing (login CSRF; ADR 0019).
 *
 * @param c - A context `publishableKey()` has run on.
 * @returns `false` when the cookie must be ignored.
 */
export async function originMayUseCookies<E extends AppEnv & { Variables: TenantVariables }>(
  c: Context<E>
): Promise<boolean> {
  const origin = c.req.header('origin')
  return !origin || environmentAllowsOrigin(c.get('deps'), c.get('tenant'), origin)
}

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Whether a request may be authenticated by a `stateful` session's cookie (ADR 0028).
 *
 * That cookie signs every `/v1/client/*` request, so each of them is a target for cross-site
 * request forgery in a way a Bearer token never is: the browser attaches a cookie whoever
 * wrote the page. The cookie counts only when all of these hold:
 *
 * - the browser does not mark the request `Sec-Fetch-Site: cross-site`;
 * - its `Origin` is one the environment allows (`urls.allowedOrigins`); and
 * - a request that changes state (anything but `GET`, `HEAD`, `OPTIONS`) **has** an `Origin`.
 *   Browsers send one on every such request; one without it is not a page's `fetch`.
 *
 * A read with no `Origin` is served: a same-origin `GET` carries none, and its response is
 * readable only where CORS allows. Underneath these checks, `SameSite=Lax` keeps the cookie
 * off cross-site subrequests, and every client route requires the `x-tula-publishable-key`
 * header, which a form cannot send and a cross-origin `fetch` may send only after a preflight
 * this middleware answers for allowed origins alone.
 *
 * When this says no, the cookie is **ignored**, not refused: the request is simply not signed
 * in, and nothing tells the page whether a cookie was there.
 *
 * @param c - A context `publishableKey()` has run on.
 * @returns `false` when the session cookie must be ignored.
 */
export async function requestMayUseSessionCookie<E extends AppEnv & { Variables: TenantVariables }>(
  c: Context<E>
): Promise<boolean> {
  if (c.req.header('sec-fetch-site') === 'cross-site') {
    return false
  }
  const origin = c.req.header('origin')
  if (!origin) {
    return SAFE_METHODS.has(c.req.method)
  }
  return environmentAllowsOrigin(c.get('deps'), c.get('tenant'), origin)
}

function isAdminPath(path: string): boolean {
  return path.startsWith('/v1/admin/')
}

/**
 * CORS, decided per request (ADR 0018).
 *
 * - **Preflight** (`OPTIONS`): allowed when the origin is on the deployment's list
 *   (`CORS_ORIGINS`) or allowed by any environment; for `/v1/admin/*`, by the deployment's list
 *   only. Always answered here with 204.
 * - **Any other request** runs first. Its response then gets `Access-Control-Allow-Origin`
 *   (with credentials) only when the origin is allowed for the environment its publishable key
 *   resolved to. A response made before a key was resolved (an invalid key, the per-IP limit,
 *   an unknown path, the public routes) holds nothing of any tenant and is readable by an origin
 *   any environment allows, so a browser can show the error code. Admin responses follow the
 *   deployment's list: secret keys do not belong in browsers.
 * - Origins are echoed on an exact match and never as `*`; `Vary: Origin` is always set, so a
 *   cache cannot serve one origin's answer to another.
 *
 * @param deps - Settings store and config.
 * @returns The middleware.
 */
export function cors(deps: OriginDeps) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const origin = c.req.header('origin') ?? ''
    const admin = isAdminPath(c.req.path)

    if (c.req.method === 'OPTIONS') {
      const allowed =
        origin !== '' &&
        (admin
          ? allowedOrigin(origin, deps.config) !== null
          : await anyEnvironmentAllowsOrigin(deps, origin))
      c.header('Vary', 'Origin')
      if (allowed) {
        c.header('Access-Control-Allow-Origin', origin)
        c.header('Access-Control-Allow-Credentials', 'true')
        c.header('Access-Control-Allow-Methods', CORS_METHODS.join(','))
        c.header('Access-Control-Allow-Headers', CORS_REQUEST_HEADERS.join(','))
        c.header('Access-Control-Max-Age', String(CORS_PREFLIGHT_MAX_AGE_SECONDS))
      }
      return c.body(null, 204)
    }

    await next()

    c.header('Vary', 'Origin', { append: true })
    if (origin === '') {
      return
    }
    const { tenant } = c.var as Partial<TenantVariables>
    let allowed = false
    try {
      allowed = admin
        ? allowedOrigin(origin, deps.config) !== null
        : tenant
          ? await environmentAllowsOrigin(deps, tenant, origin)
          : await anyEnvironmentAllowsOrigin(deps, origin)
    } catch (error) {
      // The request itself has already been handled; failing here would replace its response
      // with a 500 after the fact. Without the headers the browser refuses the response, which
      // is the safe side.
      logger.warn('could not read the allowed origins; response sent without CORS headers', {
        requestId: c.get('requestId'),
        // The name only: a connection error's message can quote a host or a user.
        reason: error instanceof Error ? error.name : 'NonError',
      })
    }
    if (allowed) {
      c.header('Access-Control-Allow-Origin', origin)
      c.header('Access-Control-Allow-Credentials', 'true')
      c.header('Access-Control-Expose-Headers', CORS_EXPOSED_HEADERS.join(','))
    }
  })
}
