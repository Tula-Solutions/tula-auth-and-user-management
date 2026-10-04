import {
  CAN_STILL_SIGN_IN_HEADER,
  CLIENT_HEADER,
  FLOW_ATTEMPT_HEADER,
  SESSION_PROFILE_HEADER,
} from '@tula/contract/headers'
import { appOrigin, resolveConfig, type TulaConfig, type TulaServerOptions } from './config'
import { clearCookieLine, isCookieValue, readUpstreamCookie, setCookieLine } from './cookies'
import { apiHeaders, callApi, issuedSession, readRequestCookies } from './upstream'

// The route handler: the app's own origin answering for the API's client routes.
//
// The browser's `@tula/core` client talks to this path and never to the API's host. That
// makes every session cookie first-party to the app (no cookie `Domain`, no third-party
// cookie), lets the server side see who is signed in, and keeps the API's own rules intact:
// the browser's Origin, its Sec-Fetch-Site and the visitor's address are passed on as they
// are. Nothing here is logged: requests and responses carry tokens, codes and passwords.

/** The largest request body passed on, by its declared length. The API has its own limit. */
const MAX_BODY_BYTES = 1024 * 1024

/** Request headers passed on to the API. Everything else stays behind, cookies included. */
const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'authorization',
  'content-type',
  'if-match',
  'origin',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  CLIENT_HEADER,
  FLOW_ATTEMPT_HEADER,
  SESSION_PROFILE_HEADER,
] as const

/** Response headers passed back to the browser. CORS headers are not: this is one origin. */
const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'cache-control',
  'etag',
  'retry-after',
  'www-authenticate',
  'x-request-id',
  CAN_STILL_SIGN_IN_HEADER,
] as const

/** A request handler for one HTTP method, as a `route.ts` exports it. */
export type TulaRouteHandler = (request: Request) => Promise<Response>

/**
 * The handlers of the catch-all route.
 *
 * @example
 * ```ts
 * // app/api/tula/[...tula]/route.ts
 * import { createTulaHandlers } from '@tula/nextjs/handlers'
 *
 * export const { GET, POST, PUT, PATCH, DELETE } = createTulaHandlers()
 * ```
 */
export interface TulaHandlers {
  GET: TulaRouteHandler
  POST: TulaRouteHandler
  PUT: TulaRouteHandler
  PATCH: TulaRouteHandler
  DELETE: TulaRouteHandler
}

/** An error in the contract's envelope, for what the handler itself refuses. */
function refusal(status: number, code: string, detail: string): Response {
  return Response.json(
    { status, code, detail },
    { status, headers: { 'cache-control': 'no-store' } }
  )
}

/**
 * The API path a request to the handler stands for, or `null` when it is not a client route.
 *
 * Only `/v1/client/…` is ever forwarded: the admin API takes a secret key and has no business
 * behind a route a browser can reach. The path is taken from the parsed URL (dot segments are
 * already resolved), and anything that could mean a different path to the next hop (an
 * encoded slash or backslash, an empty segment) is refused rather than normalised.
 */
function clientPath(url: URL, mount: string): string | null {
  if (!url.pathname.startsWith(`${mount}/`)) {
    return null
  }
  const path = url.pathname.slice(mount.length)
  if (!path.startsWith('/v1/client/') || /\/\/|\\|%2f|%5c|%00/i.test(path)) {
    return null
  }
  if (path.split('/').some((segment) => segment === '..' || segment === '.')) {
    return null
  }
  return path
}

/**
 * Whether the request was made by the app's own pages.
 *
 * A browser attaches the app's cookies to a request from any page, so the handler would be a
 * way to act as the visitor from another site (CSRF). A request that names an `Origin` must
 * name the app's; one that changes state must name one; and a request the browser marks
 * cross-site is refused whatever it claims. Decided before anything is forwarded.
 */
function fromThisApp(request: Request, config: TulaConfig): boolean {
  if (request.headers.get('sec-fetch-site') === 'cross-site') {
    return false
  }
  const origin = request.headers.get('origin')
  if (origin === null) {
    return request.method === 'GET' || request.method === 'HEAD'
  }
  return origin === appOrigin(request, config)
}

async function forward(request: Request, config: TulaConfig): Promise<Response> {
  const url = new URL(request.url)
  const path = clientPath(url, config.path)
  if (path === null) {
    return refusal(404, 'resource.not_found', 'The requested resource does not exist.')
  }
  if (!fromThisApp(request, config)) {
    return refusal(
      403,
      'request.origin_not_allowed',
      'This origin is not allowed to sign in to this app.'
    )
  }
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
    return refusal(413, 'request.too_large', 'The request body is too large.')
  }

  const cookies = readRequestCookies(request, config)
  const headers = apiHeaders(request, config, cookies)
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name)
    if (value !== null) {
      headers.set(name, value)
    }
  }
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD' && request.body !== null

  let upstream: Response
  try {
    upstream = await callApi(
      config,
      new Request(`${config.apiUrl}${path}${url.search}`, {
        method: request.method,
        headers,
        // The body is streamed through, not read: it may hold a password.
        ...(hasBody && { body: request.body, duplex: 'half' }),
      } as RequestInit)
    )
  } catch {
    return refusal(503, 'service.unavailable', 'The service is temporarily unavailable.')
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    // No client route answers a `fetch` with a redirect; one would send the browser wherever
    // the answer says.
    await upstream.body?.cancel()
    return refusal(502, 'service.unavailable', 'The service is temporarily unavailable.')
  }

  const out = new Headers()
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name)
    if (value !== null) {
      out.set(name, value)
    }
  }
  if (!out.has('cache-control')) {
    out.set('cache-control', 'no-store')
  }

  const { names, secure } = cookies
  let ended = false
  for (const line of upstream.headers.getSetCookie()) {
    const cookie = readUpstreamCookie(line, config.environmentId)
    if (!cookie) {
      continue
    }
    const name = cookie.kind === 'refresh' ? names.refresh : names.session
    if (cookie.value === null) {
      ended = true
      out.append('set-cookie', clearCookieLine(name, secure))
    } else {
      out.append('set-cookie', setCookieLine(name, cookie.value, { secure, maxAge: cookie.maxAge }))
    }
  }
  const ok = upstream.status >= 200 && upstream.status < 300
  if (ok && path === '/v1/client/sessions/sign-out') {
    // Whatever the API cleared, nothing of the session stays in this browser.
    out.delete('set-cookie')
    for (const name of [names.access, names.refresh, names.session]) {
      out.append('set-cookie', clearCookieLine(name, secure))
    }
    ended = false
  }
  if (ended) {
    out.append('set-cookie', clearCookieLine(names.access, secure))
  }

  const json = upstream.headers.get('content-type')?.includes('application/json') ?? false
  if (!json || upstream.body === null) {
    return new Response(upstream.body, { status: upstream.status, headers: out })
  }
  // A JSON answer is read whole: a completed flow, a refresh and a step-up carry the access
  // token, which the server side needs in a cookie of its own.
  const text = await upstream.text()
  if (ok) {
    let session: ReturnType<typeof issuedSession> = null
    try {
      session = issuedSession(JSON.parse(text))
    } catch {
      session = null
    }
    if (session?.accessToken && isCookieValue(session.accessToken)) {
      out.append(
        'set-cookie',
        setCookieLine(names.access, session.accessToken, {
          secure,
          maxAge: session.accessTokenMaxAge,
        })
      )
    }
  }
  return new Response(text, { status: upstream.status, headers: out })
}

/**
 * Create the handlers of the catch-all route that stands in for the Tula API on the app's
 * own origin.
 *
 * Mount them at `app/api/tula/[...tula]/route.ts` (or elsewhere, with `path`). They forward
 * `/v1/client/*` and nothing else, refuse a request that does not come from the app's own
 * pages, keep the API's refresh and session cookies as first-party cookies of the app, and
 * put the access token in an `HttpOnly` cookie so that the middleware and `auth()` can tell
 * who is signed in.
 *
 * The API sees this server's address unless it trusts the `X-Forwarded-For` this handler
 * sends: **run the API with `TRUST_PROXY=true`**, or every visitor shares one per-IP rate
 * limit. The app's origin must be among the environment's allowed origins.
 *
 * Configuration is read when the first request arrives, not when the module loads, so a
 * build without the environment variables does not fail.
 *
 * @param options - The API's URL, the publishable key and the environment id, or nothing to
 *   read them from `TULA_API_URL`, `NEXT_PUBLIC_TULA_PUBLISHABLE_KEY` and
 *   `TULA_ENVIRONMENT_ID`.
 * @returns One handler per HTTP method. Each rejects with a `TypeError` when the
 *   configuration is incomplete.
 *
 * @example
 * ```ts
 * // app/api/tula/[...tula]/route.ts
 * import { createTulaHandlers } from '@tula/nextjs/handlers'
 *
 * export const { GET, POST, PUT, PATCH, DELETE } = createTulaHandlers()
 * ```
 */
export function createTulaHandlers(options: TulaServerOptions = {}): TulaHandlers {
  let config: TulaConfig | undefined
  const handle: TulaRouteHandler = async (request) => {
    config ??= resolveConfig(options)
    return forward(request, config)
  }
  return { GET: handle, POST: handle, PUT: handle, PATCH: handle, DELETE: handle }
}
