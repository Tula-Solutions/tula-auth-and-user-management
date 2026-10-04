import { DASHBOARD_HEADER, DASHBOARD_HEADER_VALUE, DASHBOARD_SESSION_COOKIE } from '@tula/contract'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { AppConfig, AppEnv, DashboardSession } from '~/dependencies'
import { AuthError, BadRequestError, UnauthorizedError } from '~/exceptions'
import { isDeploymentOrigin } from '~/lib/cors'
import {
  DASHBOARD_SESSION_TTL_MS,
  mintDashboardSession,
  verifyDashboardSession,
} from '~/lib/dashboard-session'

/**
 * The paths the dashboard session cookie is sent to. A cookie has one `Path`, so the session is
 * set as two cookies with the same name and value: the browser then sends it to the instance
 * routes and the admin routes and to nothing else (not `/v1/client/*`, the API reference, or
 * the dashboard's own files).
 */
export const DASHBOARD_COOKIE_PATHS = ['/v1/instance', '/v1/admin'] as const

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])

type CookieConfig = Pick<AppConfig, 'publicUrl'>

function isSecure(config: CookieConfig): boolean {
  return new URL(config.publicUrl).protocol === 'https:'
}

/**
 * Name of the dashboard session cookie. Over https it carries the `__Secure-` prefix, which
 * browsers only accept from secure origins, so a plain-http sibling cannot overwrite it.
 *
 * @param config - Public URL of the API.
 * @returns The cookie name.
 */
export function dashboardCookieName(config: CookieConfig): string {
  return `${isSecure(config) ? '__Secure-' : ''}${DASHBOARD_SESSION_COOKIE}`
}

/**
 * Whether the request says it comes from the dashboard: it carries `x-tula-dashboard`, with
 * any value. Such a request is authenticated by the session cookie or not at all.
 *
 * @param c - The request context.
 * @returns Whether the header is present.
 */
export function isDashboardRequest(c: Context): boolean {
  return c.req.header(DASHBOARD_HEADER) !== undefined
}

/**
 * Refuse a request that mixes the two credentials: the dashboard header (or an environment
 * selector) together with an `Authorization` header. One request has one credential, so that
 * neither can lend its authority to the other's meaning.
 *
 * @param c - The request context.
 * @throws BadRequestError when both are present.
 */
export function refuseMixedCredentials(c: Context): void {
  if (c.req.header('authorization') !== undefined) {
    throw new BadRequestError({
      message:
        'Send either an Authorization header or a dashboard session (x-tula-dashboard), not both.',
    })
  }
}

/**
 * The cross-site request forgery rules of a cookie-authenticated request (ADR 0032). A browser
 * attaches the cookie whoever wrote the page, so before the cookie is even read:
 *
 * - the browser must not mark the request `Sec-Fetch-Site: cross-site`;
 * - an `Origin`, when present, must be the API's own (`PUBLIC_URL`: the dashboard is served by
 *   the API) or on the deployment's `CORS_ORIGINS` (the dashboard under `vite dev`); never an
 *   origin an environment put in its settings; and
 * - a request that changes state must **have** an `Origin`: browsers send one on every such
 *   request, so one without it is not a page's `fetch`.
 *
 * The third leg, the custom header that forces a preflight, is checked by the caller: it also
 * selects the credential.
 *
 * @param c - The request context.
 * @throws AuthError `request.origin_not_allowed` when a rule is broken.
 */
export function requireDashboardOrigin<E extends AppEnv>(c: Context<E>): void {
  const { config } = c.get('deps')
  if (c.req.header('sec-fetch-site') === 'cross-site') {
    throw new AuthError('request.origin_not_allowed')
  }
  const origin = c.req.header('origin')
  if (origin === undefined || origin === '') {
    if (!SAFE_METHODS.has(c.req.method)) {
      throw new AuthError('request.origin_not_allowed')
    }
    return
  }
  // Exact origins only, in every tier (no "any loopback origin" in `local`): the same rule
  // the CORS preflight of these routes is answered with.
  if (!isDeploymentOrigin(origin, config)) {
    throw new AuthError('request.origin_not_allowed')
  }
}

/**
 * Read and verify the dashboard session of a request.
 *
 * In order: the custom header must have its one value (otherwise the cookie is ignored: the
 * request is simply not signed in), the request must pass {@link requireDashboardOrigin}, and
 * only then is the cookie read and verified.
 *
 * @param c - The request context.
 * @returns The session, or `null` when the request has no valid one.
 * @throws AuthError `request.origin_not_allowed` when the request breaks the CSRF rules.
 */
export async function readDashboardSession<E extends AppEnv>(
  c: Context<E>
): Promise<DashboardSession | null> {
  if (c.req.header(DASHBOARD_HEADER) !== DASHBOARD_HEADER_VALUE) {
    return null
  }
  requireDashboardOrigin(c)
  const deps = c.get('deps')
  return verifyDashboardSession(deps, getCookie(c, dashboardCookieName(deps.config)))
}

/**
 * Require a dashboard session and put it on the context (`c.var.dashboard`).
 *
 * @param c - The request context.
 * @returns The session.
 * @throws BadRequestError when the request also carries an `Authorization` header.
 * @throws AuthError `request.origin_not_allowed` when the request breaks the CSRF rules.
 * @throws UnauthorizedError `auth.unauthenticated` without a valid session.
 */
export async function requireDashboardSession<E extends AppEnv>(
  c: Context<E>
): Promise<DashboardSession> {
  refuseMixedCredentials(c)
  const session = await readDashboardSession(c)
  if (!session) {
    throw new UnauthorizedError()
  }
  c.set('dashboard', session)
  return session
}

/**
 * Start a dashboard session: mint it and set its cookies.
 *
 * `HttpOnly` (no script reads it), `Secure` over https, `SameSite=Strict` (never sent on a
 * request another site started, navigation included), no `Domain` (this host only), and gone
 * from the browser when the session ends.
 *
 * @param c - The request context.
 * @param id - The new session's random id.
 * @returns The session.
 */
export async function startDashboardSession<E extends AppEnv>(
  c: Context<E>,
  id: string
): Promise<DashboardSession> {
  const deps = c.get('deps')
  const { value, session } = await mintDashboardSession(deps, id)
  for (const path of DASHBOARD_COOKIE_PATHS) {
    setCookie(c, dashboardCookieName(deps.config), value, {
      httpOnly: true,
      secure: isSecure(deps.config),
      sameSite: 'Strict',
      path,
      maxAge: DASHBOARD_SESSION_TTL_MS / 1000,
    })
  }
  return session
}

/**
 * Remove the dashboard session's cookies from the browser.
 *
 * @param c - The request context.
 */
export function clearDashboardSession<E extends AppEnv>(c: Context<E>): void {
  const { config } = c.get('deps')
  for (const path of DASHBOARD_COOKIE_PATHS) {
    deleteCookie(c, dashboardCookieName(config), { secure: isSecure(config), path })
  }
}
