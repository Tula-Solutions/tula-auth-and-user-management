import { type NextRequest, NextResponse } from 'next/server'
import { configFor, type TulaServerOptions } from './config'
import { REDIRECT_PARAM, safeRedirectPath } from './paths'
import { resolveSession } from './session'

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
 * Options of {@link tulaMiddleware}: which routes need a session, where sign-in lives, and
 * the server configuration (read from the environment when left out).
 *
 * @example
 * ```ts
 * const options: TulaMiddlewareOptions = {
 *   publicRoutes: ['/', '/sign-up'],
 *   signInUrl: '/sign-in',
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

function localPath(value: string, option: string): string {
  const path = safeRedirectPath(value, '')
  if (path === '') {
    throw new TypeError(`@tula/nextjs: \`${option}\` must be a path on this origin, e.g. /sign-in`)
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
 * @param options - The routes to protect and, optionally, the server configuration.
 * @returns The function to export from `proxy.ts` / `middleware.ts`.
 * @throws TypeError when `signInUrl` or `signUpUrl` is not a path on this origin. The
 *   returned function rejects with a `TypeError` when the configuration is incomplete.
 *
 * @example
 * ```ts
 * // proxy.ts (Next.js 16)
 * import { tulaMiddleware } from '@tula/nextjs/middleware'
 *
 * export const proxy = tulaMiddleware({ publicRoutes: ['/', '/sign-up'] })
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
  const always = new Set([signInPath, signUpPath].map((path) => new URL(path, 'http://x').pathname))
  const isProtected = compile(options.protectedRoutes)
  const isPublic = compile(options.publicRoutes)
  const isApi = compile(options.apiRoutes ?? '/api(.*)')
  const needsSession = (pathname: string): boolean => {
    if (always.has(pathname)) {
      return false
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
      // The route handler does its own checks and talks to the API itself.
      return NextResponse.next()
    }

    const { session, setCookies, requestHeaders } = await resolveSession(request, config)
    let response: NextResponse
    if (session || !needsSession(pathname)) {
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
