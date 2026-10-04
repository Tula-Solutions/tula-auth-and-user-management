import { CLIENT_HEADER, PUBLISHABLE_KEY_HEADER } from '@tula/contract/headers'
import { appOrigin, type TulaConfig } from './config'
import {
  type CookieNames,
  cookieNames,
  isCookieValue,
  parseCookieHeader,
  readUpstreamCookie,
  upstreamCookieHeader,
} from './cookies'

// Every request this package makes to the Tula API is built here, so that the things the
// API's own security depends on (the browser's Origin, the visitor's address, which cookies
// travel) are decided in one place.

/** What a request to the app says about the visitor's session. */
export interface RequestCookies {
  /** Whether the app is served over https for this request. */
  secure: boolean
  names: CookieNames
  /** Every cookie of the request, by name. */
  all: Map<string, string>
  access: string | undefined
  refresh: string | undefined
  session: string | undefined
}

/**
 * Read the app's cookies from a request.
 *
 * Only the names for the request's own scheme count: over https that is the `__Host-` name,
 * so an unprefixed cookie planted from a sibling subdomain is never taken for a session.
 *
 * @param request - The incoming request.
 * @param config - The configuration.
 * @returns The cookies and the names they were read under.
 *
 * @example
 * ```ts
 * readRequestCookies(request, config).refresh // the refresh token, if the browser sent one
 * ```
 */
export function readRequestCookies(
  request: Request,
  config: Pick<TulaConfig, 'appOrigin'>
): RequestCookies {
  const secure = appOrigin(request, config).startsWith('https://')
  const names = cookieNames(secure)
  const all = parseCookieHeader(request.headers.get('cookie'))
  return {
    secure,
    names,
    all,
    access: all.get(names.access) || undefined,
    refresh: all.get(names.refresh) || undefined,
    session: all.get(names.session) || undefined,
  }
}

/**
 * The headers of a call to the API's client routes made on behalf of a request to the app.
 *
 * Carries the app's publishable key, the visitor's address as the one `X-Forwarded-For` entry
 * when the configuration says how to know it (`trustedProxyHops` or `clientIp`; the API, with
 * `TRUST_PROXY`, reads the last entry; otherwise every visitor shares this server's address),
 * the visitor's user agent and the session cookies under the API's names. No forwarding header
 * of the request is ever copied.
 * `Origin` is copied only when the caller passes one: the API checks it against the
 * environment's allowed origins, so it must be the browser's own or the app's, never made up
 * for a request that had none.
 *
 * @param request - The request to the app.
 * @param config - The configuration.
 * @param cookies - The session cookies to send, if any.
 * @returns The headers.
 *
 * @example
 * ```ts
 * const headers = apiHeaders(request, config, { refresh })
 * headers.set('origin', appOrigin(request, config))
 * ```
 */
export function apiHeaders(
  request: Request,
  config: TulaConfig,
  cookies: { refresh?: string | undefined; session?: string | undefined } = {}
): Headers {
  const headers = new Headers()
  headers.set(PUBLISHABLE_KEY_HEADER, config.publishableKey)
  const ip = config.clientIp(request)
  if (ip) {
    headers.set('x-forwarded-for', ip)
  }
  const userAgent = request.headers.get('user-agent')
  if (userAgent) {
    headers.set('user-agent', userAgent)
  }
  const cookie = upstreamCookieHeader(config.environmentId, cookies)
  if (cookie) {
    headers.set('cookie', cookie)
  }
  return headers
}

/**
 * Send a request to the API: never following a redirect, never waiting for ever.
 *
 * @param config - The configuration.
 * @param request - The request to send.
 * @returns The API's response.
 * @throws Whatever `fetch` throws when the API cannot be reached or the timeout passes.
 *
 * @example
 * ```ts
 * const response = await callApi(config, new Request(`${config.apiUrl}/v1/client/me`, { headers }))
 * ```
 */
export function callApi(config: TulaConfig, request: Request): Promise<Response> {
  return config.fetch(
    new Request(request, { redirect: 'manual', signal: AbortSignal.timeout(config.timeoutMs) })
  )
}

/** Tokens the API issued, as far as this package reads them. */
export interface IssuedSession {
  sessionId: string
  /** Absent for a `stateful` session. */
  accessToken: string | undefined
  /** Seconds until the access token expires, from the API's own statement of it. */
  accessTokenMaxAge: number
}

/** How long an access-token cookie lives when the API did not say when the token expires. */
const DEFAULT_ACCESS_MAX_AGE = 60

/**
 * Find the session a JSON answer of the API carries: at the top level (a refresh, a step-up)
 * or under `session` (a completed flow).
 *
 * @param body - The parsed body.
 * @returns The session, or `null` when the body has none.
 *
 * @example
 * ```ts
 * issuedSession({ session: { sessionId: 's1', accessToken: 'eyJ…' } })?.sessionId // 's1'
 * ```
 */
export function issuedSession(body: unknown): IssuedSession | null {
  if (typeof body !== 'object' || body === null) {
    return null
  }
  const nested = Object.hasOwn(body, 'session') ? (body as { session: unknown }).session : null
  const candidate = (typeof nested === 'object' && nested !== null ? nested : body) as Record<
    string,
    unknown
  >
  const read = (key: string) => (Object.hasOwn(candidate, key) ? candidate[key] : undefined)
  const sessionId = read('sessionId')
  if (typeof sessionId !== 'string') {
    return null
  }
  const accessToken = read('accessToken')
  const expiresAt = read('accessTokenExpiresAt')
  const expires = typeof expiresAt === 'string' ? Date.parse(expiresAt) : Number.NaN
  const seconds = Number.isFinite(expires)
    ? Math.floor((expires - Date.now()) / 1000)
    : DEFAULT_ACCESS_MAX_AGE
  return {
    sessionId,
    accessToken: typeof accessToken === 'string' ? accessToken : undefined,
    // An hour at most: a cookie must not outlive a token by a mistaken clock.
    accessTokenMaxAge: Math.min(3600, Math.max(1, seconds)),
  }
}

/** What a refresh through the API came to. */
export type RefreshOutcome =
  | {
      status: 'refreshed'
      session: IssuedSession & { accessToken: string }
      /** The rotated refresh token and how long the browser keeps it. */
      refresh: { value: string; maxAge: number | undefined } | null
    }
  /** The API says the session is over (see {@link endsSession}): its cookies should go. */
  | { status: 'refused' }
  /**
   * No answer, or one that says nothing about the session (429, 5xx, a refusal of the request
   * itself: its origin, its key): keep the cookies.
   */
  | { status: 'unavailable' }

/**
 * Whether an error code of the API means the session is over.
 *
 * `session.*` and `auth.user_banned` are answers about the session the refresh token belongs
 * to. `auth.unauthenticated` is not one of them here, unlike in the browser's client: the
 * refresh this package makes always presents the cookie, and the API answers that code only
 * when it did not take the cookie into account at all (the request's origin is not one the
 * environment allows). `auth.invalid_key` and `request.origin_not_allowed` are about the
 * request too. Treating any of those as the end of a session would let one wrong setting of
 * the app delete every visitor's cookies.
 */
function endsSession(code: string | null): boolean {
  return code !== null && (code.startsWith('session.') || code === 'auth.user_banned')
}

/** The `code` of an error in the contract's envelope, if the body is one. */
async function errorCode(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json()
    const code =
      typeof body === 'object' && body !== null && Object.hasOwn(body, 'code')
        ? (body as { code: unknown }).code
        : null
    // Shaped like a contract code, or not repeated anywhere.
    return typeof code === 'string' && /^[a-z0-9_.]{1,64}$/.test(code) ? code : null
  } catch {
    return null
  }
}

/** What a refusal that is not about the session most likely means, for the server's log. */
function refusalHint(status: number, code: string | null, origin: string): string {
  const said = `the Tula API answered a session refresh with ${status}${code ? ` ${code}` : ''}`
  const kept = "The visitor's cookies were kept and this request was treated as signed out."
  if (code === 'auth.invalid_key') {
    return `${said}: it does not accept this app's publishable key. Check NEXT_PUBLIC_TULA_PUBLISHABLE_KEY and TULA_ENVIRONMENT_ID. ${kept}`
  }
  if (code === 'auth.unauthenticated' || code === 'request.origin_not_allowed') {
    return `${said}: it did not honour the refresh cookie for the origin ${origin}. Check that this origin is among the environment's allowed origins (urls.allowedOrigins) and that TULA_APP_URL, if set, is the app's public origin. ${kept}`
  }
  return `${said}, which does not say the session is over. ${kept}`
}

// Requests that arrive together with the same refresh token share one call. The server's
// reuse grace window would also cover them (it hands the same child token to each), but one
// call is cheaper, and it keeps a burst of prefetches from each rotating in turn. Only the
// promise of a call in flight is held, keyed by the token, and dropped when it settles.
const refreshing = new WeakMap<TulaConfig['fetch'], Map<string, Promise<RefreshOutcome>>>()

/**
 * Exchange the browser's refresh cookie for new tokens, server to server.
 *
 * The call carries the app's own `Origin` (the API honours a refresh cookie only from an
 * origin the environment allows) and the visitor's address when it is known. An answer that
 * says the session is over (`session.*`, `auth.user_banned`) ends it; any other leaves it
 * alone, and a refusal of the request itself (its origin, its key) is reported once through
 * the configuration's `warn`.
 *
 * @param request - The request to the app that needs a session.
 * @param config - The configuration.
 * @param refreshToken - The refresh cookie's value.
 * @returns The outcome.
 *
 * @example
 * ```ts
 * const outcome = await refreshSession(request, config, cookies.refresh)
 * if (outcome.status === 'refreshed') {
 *   outcome.session.accessToken
 * }
 * ```
 */
export function refreshSession(
  request: Request,
  config: TulaConfig,
  refreshToken: string
): Promise<RefreshOutcome> {
  let inFlight = refreshing.get(config.fetch)
  if (!inFlight) {
    inFlight = new Map()
    refreshing.set(config.fetch, inFlight)
  }
  const flights = inFlight
  const key = `${config.apiUrl}|${config.environmentId}|${refreshToken}`
  const pending = flights.get(key)
  if (pending) {
    return pending
  }
  const call = requestRefresh(request, config, refreshToken).finally(() => flights.delete(key))
  flights.set(key, call)
  return call
}

async function requestRefresh(
  request: Request,
  config: TulaConfig,
  refreshToken: string
): Promise<RefreshOutcome> {
  if (!isCookieValue(refreshToken)) {
    // It could not be sent as a cookie, so the API would answer as if there were none. No
    // token the API issued looks like this: it can never work.
    return { status: 'refused' }
  }
  const origin = appOrigin(request, config)
  const headers = apiHeaders(request, config, { refresh: refreshToken })
  headers.set('origin', origin)
  headers.set(CLIENT_HEADER, 'web')
  headers.set('content-type', 'application/json')
  let response: Response
  try {
    response = await callApi(
      config,
      new Request(`${config.apiUrl}/v1/client/sessions/refresh`, {
        method: 'POST',
        headers,
        body: '{}',
      })
    )
  } catch {
    return { status: 'unavailable' }
  }
  if (response.status === 401 || response.status === 403) {
    const code = await errorCode(response)
    if (endsSession(code)) {
      return { status: 'refused' }
    }
    config.warn(
      `refresh-refused:${response.status}:${code}`,
      refusalHint(response.status, code, origin)
    )
    return { status: 'unavailable' }
  }
  if (response.status !== 200) {
    return { status: 'unavailable' }
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { status: 'unavailable' }
  }
  const session = issuedSession(body)
  if (!session?.accessToken) {
    return { status: 'unavailable' }
  }
  let refresh: { value: string; maxAge: number | undefined } | null = null
  for (const line of response.headers.getSetCookie()) {
    const cookie = readUpstreamCookie(line, config.environmentId)
    if (cookie?.kind === 'refresh' && cookie.value) {
      refresh = { value: cookie.value, maxAge: cookie.maxAge }
    }
  }
  return {
    status: 'refreshed',
    session: { ...session, accessToken: session.accessToken },
    refresh,
  }
}
