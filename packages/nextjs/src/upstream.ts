import { CLIENT_HEADER, PUBLISHABLE_KEY_HEADER } from '@tula/contract/headers'
import { appOrigin, type TulaConfig } from './config'
import {
  type CookieNames,
  clearCookieLine,
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
  /**
   * The plain names, when the `__Host-` names were chosen only because a `__Host-` cookie
   * arrived (no app URL, no forwarded `https`); `null` otherwise. Cookies under them are never
   * read for this request, and go whenever one of the app's cookies changes
   * ({@link supersededCookieLines}).
   */
  superseded: CookieNames | null
  /** Every cookie of the request, by name. */
  all: Map<string, string>
  access: string | undefined
  refresh: string | undefined
  session: string | undefined
}

/** The SDK's cookie names over https. */
const HOST_PREFIXED: ReadonlySet<string> = new Set(Object.values(cookieNames(true)))

/**
 * What says the app is served over https for this request, as far as its cookies go, or
 * `null` when nothing does.
 *
 * In order: the configured app URL; a forwarded `https`; one of this package's `__Host-`
 * cookies on the request; and otherwise what {@link appOrigin} says (a forwarded `http`, or
 * the request's own URL).
 *
 * The cookie outranks a forwarded `http` because that header is not evidence where no proxy
 * sent it: Next.js fills it in from its own socket, which is plain http behind anything that
 * ends TLS. A browser stores a `__Host-` cookie only from an https response of this exact
 * host and sends it nowhere else, so its presence says how the page was loaded; a sibling
 * subdomain cannot plant one, and a hand-built `Cookie` header changes only the names read
 * for the sender's own request, whose token is verified all the same.
 *
 * This decides cookie names and the `Secure` attribute only. The app's origin (the handler's
 * same-origin check, the `Origin` a refresh carries) never follows a cookie.
 */
function httpsEvidence(
  request: Request,
  config: Pick<TulaConfig, 'appOrigin'>,
  cookies: Map<string, string>
): 'origin' | 'cookie' | null {
  if (appOrigin(request, config).startsWith('https://')) {
    return 'origin'
  }
  if (config.appOrigin) {
    return null
  }
  for (const name of cookies.keys()) {
    if (HOST_PREFIXED.has(name)) {
      return 'cookie'
    }
  }
  return null
}

/**
 * Read the app's cookies from a request.
 *
 * Only the names for the request's own scheme count: over https that is the `__Host-` name,
 * so an unprefixed cookie planted from a sibling subdomain is never taken for a session. One
 * name per cookie is read for a request, never both.
 *
 * The scheme is the configured app URL's. Without one it is https when the proxy's
 * `X-Forwarded-Proto` says so or when the request carries one of this package's `__Host-`
 * cookies (which a browser stores and sends over https only), even if the forwarded scheme
 * says `http`: Next.js writes that header itself when no proxy did. The interceptor, the
 * route handler and the server helpers all read cookies through here, so they agree. Where
 * the cookie decided, the plain names are reported as `superseded`.
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
  const all = parseCookieHeader(request.headers.get('cookie'))
  const evidence = httpsEvidence(request, config, all)
  const secure = evidence !== null
  const names = cookieNames(secure)
  return {
    secure,
    names,
    superseded: evidence === 'cookie' ? cookieNames(false) : null,
    all,
    access: all.get(names.access) || undefined,
    refresh: all.get(names.refresh) || undefined,
    session: all.get(names.session) || undefined,
  }
}

/**
 * The `Set-Cookie` lines that expire the plain-named cookies of a request whose `__Host-`
 * names were chosen by the cookie rule. Send them with every answer that sets or clears one
 * of the app's cookies.
 *
 * A browser holds one session. Where a `__Host-` cookie alone said https, the host may also
 * hold this app's own cookies under the plain names: `localhost` shares cookies across ports,
 * so an app run over http there is signed in under `tula_rt`, and another https app can leave
 * a `__Host-tula_rt` beside it. While that one is there the plain ones are not read; once it
 * is cleared (a sign-out, a refused refresh) they would be read again, and a session the
 * visitor had signed out of, or an earlier user's, would be back. So they do not outlive a
 * change.
 *
 * Empty when the scheme came from the app URL or a forwarded `https`: there the plain names
 * were never this app's, and what is under them is not its to expire.
 *
 * @param cookies - The request's cookies, from {@link readRequestCookies}.
 * @returns The lines, or none.
 *
 * @example
 * ```ts
 * const cookies = readRequestCookies(request, config)
 * for (const line of supersededCookieLines(cookies)) {
 *   headers.append('set-cookie', line)
 * }
 * ```
 */
export function supersededCookieLines(cookies: Pick<RequestCookies, 'superseded'>): string[] {
  // Without `Secure`: these are the cookies an http response wrote.
  return Object.values(cookies.superseded ?? {}).map((name) => clearCookieLine(name, false))
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
 * The longest a session refresh waits for the API, whatever `timeoutSeconds` says.
 *
 * A refresh whose answer is lost may already have rotated the token. Presenting the same
 * token again is forgiven only inside the profile's reuse grace window (10 seconds at the
 * least, `MIN_REUSE_GRACE_PERIOD` in `@tula/contract`) and is treated as theft after it: the
 * whole session is revoked. Giving up after 8 seconds leaves room for the one repeat below and
 * for the browser's next request; with the general 15-second timeout every lost answer would
 * have ended the session. The same number as `@tula/core`'s `REFRESH_TIMEOUT_MS`; a test holds
 * both, and that it stays below the floor.
 *
 * @example
 * ```ts
 * REFRESH_TIMEOUT_MS // 8_000
 * ```
 */
export const REFRESH_TIMEOUT_MS = 8_000

/**
 * How long, from the start of a refresh, its one repeat may still be running: the smallest
 * reuse grace window a session profile may set.
 *
 * @example
 * ```ts
 * // The first try gives up after 8s; the repeat then has the remaining 2s.
 * REFRESH_RETRY_WINDOW_MS // 10_000
 * ```
 */
export const REFRESH_RETRY_WINDOW_MS = 10_000

/** The least time the repeat of a refresh is given, however long the first try took. */
const MIN_REFRESH_RETRY_TIMEOUT_MS = 1_000

/**
 * Send a request to the API: never following a redirect, never waiting for ever.
 *
 * It takes the URL and the request's parts, not a `Request`, and builds the one `Request` that
 * is sent. A `Request` must never be built from another here: the Edge runtime of Next.js 15,
 * where the middleware runs, keeps only the URL of the one it is given, so a copied `POST`
 * with its headers and body would reach the API as a bare `GET`.
 *
 * @param config - The configuration.
 * @param url - The API URL to call.
 * @param init - The method, headers and body. Its `redirect` and `signal` are replaced.
 * @param timeoutMs - How long to wait for the answer. Defaults to the configured timeout.
 * @returns The API's response.
 * @throws Whatever `fetch` throws when the API cannot be reached or the timeout passes.
 *
 * @example
 * ```ts
 * const response = await callApi(config, `${config.apiUrl}/v1/client/me`, { headers })
 * ```
 */
export function callApi(
  config: TulaConfig,
  url: string,
  init: RequestInit,
  timeoutMs = config.timeoutMs
): Promise<Response> {
  return config.fetch(
    new Request(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
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
 * The call waits at most {@link REFRESH_TIMEOUT_MS} (or the configured timeout, if smaller)
 * and, when it got no answer at all, is sent once more at once, inside
 * {@link REFRESH_RETRY_WINDOW_MS}; requests sharing the refresh share the repeat.
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
  const send = (timeoutMs: number) =>
    callApi(
      config,
      `${config.apiUrl}/v1/client/sessions/refresh`,
      { method: 'POST', headers, body: '{}' },
      timeoutMs
    )
  const timeoutMs = Math.min(config.timeoutMs, REFRESH_TIMEOUT_MS)
  const sentAt = Date.now()
  let response: Response
  try {
    try {
      response = await send(timeoutMs)
    } catch {
      // The one repeat, as in `@tula/core`: no answer came (a timeout, a dropped connection),
      // so the API may or may not have rotated the token. Presenting the same token again at
      // once is answered with the same next token if it did, and is an ordinary refresh if it
      // did not. Left to the browser's next request, which may come after the grace window,
      // it would be reuse and end the session on every device. An HTTP answer of any status
      // never gets here. The repeat has what is left of the window, inside the same single
      // flight.
      const left = REFRESH_RETRY_WINDOW_MS - (Date.now() - sentAt)
      response = await send(Math.min(timeoutMs, Math.max(MIN_REFRESH_RETRY_TIMEOUT_MS, left)))
    }
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
