import {
  hasOrganizationAccess,
  type OrganizationCheck,
  readOrganizationClaims,
} from '@tula-tech/contract/custom-claims'
import {
  PERMISSION_KEY_PATTERN,
  ROLE_KEY_PATTERN,
} from '@tula-tech/contract/organization-permissions'
import { type NextRequest, NextResponse } from 'next/server'
import { configFor, type TulaServerOptions } from './config'
import { REDIRECT_PARAM, safeRedirectPath } from './paths'
import { AUTH_HEADER, resolveSession } from './session'

// The request interceptor: `proxy.ts` in Next.js 16 (Node.js runtime), `middleware.ts` in
// Next.js 15 (Edge runtime by default). This module and everything it imports use web
// platform APIs only, so it runs in both.

export type { TulaServerOptions } from './config'
export { REDIRECT_PARAM, safeRedirectPath } from './paths'

/**
 * Which paths a rule applies to: an exact path, a pattern where `(.*)` or `*` stands for
 * anything (`'/dashboard(.*)'`), a regular expression, a function, or a list of those.
 *
 * @example
 * ```ts
 * const routes: RouteMatcher = ['/', '/pricing', '/docs(.*)', /^\/blog\/\d+$/]
 * ```
 */
export type RouteMatcher =
  | string
  | RegExp
  | ((pathname: string) => boolean)
  | ReadonlyArray<string | RegExp | ((pathname: string) => boolean)>

/**
 * A group of routes and what the active organization must grant to open them: one permission
 * key or one role key, checked offline on the verified claims (the rule of `auth().has()`).
 *
 * A route a rule matches needs a session, whatever `publicRoutes` / `protectedRoutes` say.
 * When several rules match a path, **all** of them must grant. The check is exact: no
 * wildcard, and no permission implies another.
 *
 * @example
 * ```ts
 * const rules: RouteAccessRule[] = [
 *   { routes: '/billing(.*)', permission: 'org:billing:read' },
 *   { routes: ['/admin(.*)', '/api/admin(.*)'], role: 'admin' },
 * ]
 * ```
 */
export type RouteAccessRule = { routes: RouteMatcher } & OrganizationCheck

/**
 * Options of {@link tulaMiddleware}: which routes need a session, which need a permission or
 * a role of the active organization, where sign-in lives, and the server configuration (read
 * from the environment when left out).
 *
 * @example
 * ```ts
 * const options: TulaMiddlewareOptions = {
 *   publicRoutes: ['/', '/sign-up'],
 *   signInUrl: '/sign-in',
 *   access: [{ routes: '/billing(.*)', permission: 'org:billing:read' }],
 *   forbiddenUrl: '/no-access',
 * }
 * ```
 */
export interface TulaMiddlewareOptions extends TulaServerOptions {
  /**
   * Routes anyone may open; **every other route needs a session**. Ignored when
   * `protectedRoutes` is given. The sign-in and sign-up pages and the route handler are always
   * public.
   */
  publicRoutes?: RouteMatcher
  /** Routes that need a session; every other route is public. */
  protectedRoutes?: RouteMatcher
  /**
   * Routes that answer `401` instead of redirecting when there is no session. Defaults to
   * `/api(.*)`. A request that is not a `GET` or `HEAD` always gets the `401`.
   */
  apiRoutes?: RouteMatcher
  /** The sign-in page: a path on this origin. Defaults to `/sign-in`. */
  signInUrl?: string
  /** The sign-up page, so that it is never protected. Defaults to `/sign-up`. */
  signUpUrl?: string
  /**
   * Routes that need a permission or a role of the session's active organization (ADR 0065),
   * checked on the verified claims with no call to the API. Without a session the visitor is
   * sent to sign in, as for any protected route. **With** a session that does not grant the
   * rule (no active organization, another role, a missing permission) the answer is a `403`:
   * JSON for `apiRoutes` and for anything but a `GET`, and for a page a redirect to
   * `forbiddenUrl` or, when there is none, a plain `403` page.
   */
  access?: ReadonlyArray<RouteAccessRule>
  /**
   * Where a signed-in visitor who lacks what a rule in `access` asks for is sent: a path on
   * this origin. Leave it out for a bare `403` response. Never matched by `access` itself.
   */
  forbiddenUrl?: string
}

function compile(matcher: RouteMatcher | undefined): (pathname: string) => boolean {
  if (matcher === undefined) {
    return () => false
  }
  const list = Array.isArray(matcher) ? matcher : [matcher]
  const tests = list.map((entry: string | RegExp | ((pathname: string) => boolean)) => {
    if (typeof entry === 'function') {
      return entry
    }
    if (entry instanceof RegExp) {
      return (pathname: string) =>
        new RegExp(entry.source, entry.flags.replace('g', '')).test(pathname)
    }
    // Everything in a string is literal except `(.*)` and `*`.
    const source = entry
      .split(/\(\.\*\)|\*/)
      .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')
    const pattern = new RegExp(`^${source}$`)
    return (pathname: string) => pattern.test(pathname)
  })
  return (pathname) => tests.some((test) => test(pathname))
}

/** One rule of `access`, validated and compiled: the same check as `auth().has()`. */
interface CompiledRule {
  matches(pathname: string): boolean
  check: OrganizationCheck
}

/**
 * Check the rules of `access` when the middleware is created: a typo in a permission key
 * would otherwise refuse everybody, silently, at run time.
 */
function compileAccess(rules: ReadonlyArray<RouteAccessRule> | undefined): CompiledRule[] {
  return (rules ?? []).map((rule, index) => {
    const { routes, permission, role } = rule as {
      routes: RouteMatcher
      permission?: unknown
      role?: unknown
    }
    const named = [permission, role].filter((value) => value !== undefined)
    const key = typeof permission === 'string' ? permission : role
    const valid =
      named.length === 1 &&
      typeof key === 'string' &&
      (permission !== undefined ? PERMISSION_KEY_PATTERN.test(key) : ROLE_KEY_PATTERN.test(key))
    if (routes === undefined || !valid) {
      throw new TypeError(
        `@tula-tech/nextjs: \`access[${index}]\` needs \`routes\` and exactly one of \`permission\` (an exact key like org:billing:read, no wildcard) or \`role\` (a role key like admin)`
      )
    }
    return {
      matches: compile(routes),
      check: (permission !== undefined ? { permission: key } : { role: key }) as OrganizationCheck,
    }
  })
}

function localPath(value: string, option: string): string {
  const path = safeRedirectPath(value, '')
  if (path === '') {
    throw new TypeError(
      `@tula-tech/nextjs: \`${option}\` must be a path on this origin, e.g. /sign-in`
    )
  }
  return path
}

/**
 * Create the request interceptor that knows who is signed in.
 *
 * For every request it matches, it verifies the access-token cookie **offline** against the
 * environment's published keys (`EdDSA`, `iss`, `aud`, `exp`, `kid`; no call to the API or a
 * database). When the token is missing, invalid or about to expire and the browser sent a
 * refresh cookie, it refreshes once through the API, sets the rotated cookies on the response
 * and hands the new token to the same request's server components. A refresh the API refuses
 * clears the cookies. A protected route without a session redirects to `signInUrl` with
 * `redirect_url` (a path on this origin; read it with `safeRedirectPath`), or answers `401`
 * for API routes and for anything but a `GET`.
 *
 * Requests that arrive together with one refresh token share one refresh; across server
 * instances the API's reuse grace window (10 seconds by default) hands each the same next
 * token. A request that still carries the old cookie **after** that window is a reuse: the
 * API ends the session.
 *
 * A session revoked on the API keeps working here until its access token expires (the token
 * is verified offline): at most one access-token lifetime, 60 seconds by default.
 *
 * A `stateful` session has no token to verify offline. With `secretKey` (`TULA_SECRET_KEY`)
 * the API is asked on **every matched request** (one network call each); without it such a
 * session counts as signed out on the server.
 *
 * In Next.js 16 the file is `proxy.ts` and the export `proxy`; in Next.js 15 it is
 * `middleware.ts` and `middleware`.
 *
 * Routes in `access` also need the active organization to grant a permission or a role
 * (`{ routes: '/billing(.*)', permission: 'org:billing:read' }`). That is decided from the
 * verified claims, offline, by the rule of `auth().has()`: false with no active organization,
 * and exact (no wildcard). A visitor without a session is sent to sign in; one with a session
 * that does not grant it gets a `403` (JSON for API routes and non-`GET` requests; for a page
 * a redirect to `forbiddenUrl`, or a bare `403` page). The claims are as old as the access
 * token, so a role changed a moment ago is seen at the next refresh; the code that changes
 * data still authorizes the change itself.
 *
 * @param options - The routes to protect and, optionally, the server configuration.
 * @returns The function to export from `proxy.ts` / `middleware.ts`.
 * @throws TypeError when `signInUrl`, `signUpUrl` or `forbiddenUrl` is not a path on this
 *   origin, or a rule of `access` names neither or both of `permission` and `role`, a
 *   permission that is not an exact key (`org:<feature>:<action>`) or a role key that is not
 *   one. The returned function rejects with a `TypeError` when the configuration is
 *   incomplete.
 *
 * @example
 * ```ts
 * // proxy.ts (Next.js 16)
 * import { tulaMiddleware } from '@tula-tech/nextjs/middleware'
 *
 * export const proxy = tulaMiddleware({
 *   publicRoutes: ['/', '/sign-up'],
 *   access: [{ routes: '/billing(.*)', permission: 'org:billing:read' }],
 *   forbiddenUrl: '/no-access',
 * })
 *
 * export const config = {
 *   matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
 * }
 * ```
 */
export function tulaMiddleware(
  options: TulaMiddlewareOptions = {}
): (request: NextRequest) => Promise<NextResponse> {
  const signInPath = localPath(options.signInUrl ?? '/sign-in', 'signInUrl')
  const signUpPath = localPath(options.signUpUrl ?? '/sign-up', 'signUpUrl')
  const forbiddenPath =
    options.forbiddenUrl === undefined ? null : localPath(options.forbiddenUrl, 'forbiddenUrl')
  const rules = compileAccess(options.access)
  const always = new Set([signInPath, signUpPath].map((path) => new URL(path, 'http://x').pathname))
  const isProtected = compile(options.protectedRoutes)
  const isPublic = compile(options.publicRoutes)
  const isApi = compile(options.apiRoutes ?? '/api(.*)')
  // No rule applies to the page a refused visitor is sent to, or it could refuse them again.
  const exempt = new Set(always)
  if (forbiddenPath !== null) {
    exempt.add(new URL(forbiddenPath, 'http://x').pathname)
  }
  /** The rules that apply to a path: none for the sign-in, sign-up and forbidden pages. */
  const rulesFor = (pathname: string): CompiledRule[] =>
    exempt.has(pathname) ? [] : rules.filter((rule) => rule.matches(pathname))
  const needsSession = (pathname: string): boolean => {
    if (always.has(pathname)) {
      return false
    }
    if (rulesFor(pathname).length > 0) {
      return true
    }
    if (options.protectedRoutes !== undefined) {
      return isProtected(pathname)
    }
    return options.publicRoutes !== undefined && !isPublic(pathname)
  }

  return async function middleware(request: NextRequest): Promise<NextResponse> {
    const config = configFor(options)
    const { pathname, search } = request.nextUrl
    if (pathname === config.path || pathname.startsWith(`${config.path}/`)) {
      // The route handler does its own checks and talks to the API itself. The claims header
      // is still not the browser's to send, on this path as on any other.
      const headers = new Headers(request.headers)
      headers.delete(AUTH_HEADER)
      return NextResponse.next({ request: { headers } })
    }

    const { session, setCookies, requestHeaders } = await resolveSession(request, config)
    let response: NextResponse
    const applicable = session ? rulesFor(pathname) : []
    const organization = applicable.length > 0 ? readOrganizationClaims(session?.claims) : null
    const denied = applicable.some((rule) => !hasOrganizationAccess(organization, rule.check))
    if (session && denied) {
      if (isApi(pathname) || (request.method !== 'GET' && request.method !== 'HEAD')) {
        response = NextResponse.json(
          {
            status: 403,
            code: 'auth.forbidden',
            detail: 'You do not have permission to do that.',
          },
          { status: 403, headers: { 'cache-control': 'no-store' } }
        )
      } else if (forbiddenPath !== null) {
        const target = request.nextUrl.clone()
        const destination = new URL(forbiddenPath, 'http://x')
        target.pathname = destination.pathname
        target.search = destination.search
        target.hash = ''
        response = NextResponse.redirect(target)
      } else {
        response = new NextResponse('Forbidden', {
          status: 403,
          headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
        })
      }
    } else if (session || !needsSession(pathname)) {
      response = NextResponse.next({ request: { headers: requestHeaders } })
    } else if (isApi(pathname) || (request.method !== 'GET' && request.method !== 'HEAD')) {
      response = NextResponse.json(
        { status: 401, code: 'auth.unauthenticated', detail: 'You need to sign in to do that.' },
        { status: 401, headers: { 'cache-control': 'no-store' } }
      )
    } else {
      const target = request.nextUrl.clone()
      const destination = new URL(signInPath, 'http://x')
      target.pathname = destination.pathname
      target.search = destination.search
      target.hash = ''
      // Where the visitor was going, as a path: the sign-in page checks it again before use.
      target.searchParams.set(REDIRECT_PARAM, safeRedirectPath(`${pathname}${search}`))
      response = NextResponse.redirect(target)
    }
    for (const line of setCookies) {
      response.headers.append('set-cookie', line)
    }
    return response
  }
}
