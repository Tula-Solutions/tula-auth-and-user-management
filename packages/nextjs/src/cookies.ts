// The app's own cookies, and the translation between them and the API's.
//
// The API scopes its cookies to its own host and names them per environment
// (`tula_rt_<environment id>`, `tula_session_<environment id>`). Behind the route handler the
// browser only ever talks to the app's origin, so the same values are kept in first-party
// cookies with fixed names, and a third one holds the access token for the server side.

/** The names of the app's three cookies, for one scheme. */
export interface CookieNames {
  /** The access token (a JWT): what the middleware and `auth()` verify. */
  access: string
  /** The refresh token. */
  refresh: string
  /** A `stateful` session's token. */
  session: string
}

/**
 * The names of the app's cookies.
 *
 * Over https they carry the `__Host-` prefix: a browser accepts such a cookie only from a
 * secure origin, with `Path=/` and no `Domain`, so a sibling subdomain can neither set nor
 * overwrite it. Only the name for the request's own scheme is ever read.
 *
 * @param secure - Whether the app is served over https.
 * @returns The three names.
 *
 * @example
 * ```ts
 * cookieNames(true).access // '__Host-tula_at'
 * cookieNames(false).refresh // 'tula_rt'
 * ```
 */
export function cookieNames(secure: boolean): CookieNames {
  const prefix = secure ? '__Host-' : ''
  return {
    access: `${prefix}tula_at`,
    refresh: `${prefix}tula_rt`,
    session: `${prefix}tula_session`,
  }
}

/** The characters RFC 6265 allows in a cookie value: nothing that could start an attribute. */
const COOKIE_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/

/**
 * Whether a string can be written as a cookie value as it is.
 *
 * @param value - The candidate value.
 * @returns Whether it is non-empty and free of separators, quotes and control characters.
 *
 * @example
 * ```ts
 * isCookieValue('abc.def') // true
 * isCookieValue('a; Domain=evil.example') // false
 * ```
 */
export function isCookieValue(value: string): boolean {
  return value.length <= 4096 && COOKIE_VALUE.test(value)
}

/**
 * Read a `Cookie` request header.
 *
 * @param header - The header's value, or `null`.
 * @returns The cookies by name; the first value wins when a name is repeated.
 *
 * @example
 * ```ts
 * parseCookieHeader('a=1; b=2').get('b') // '2'
 * ```
 */
export function parseCookieHeader(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>()
  for (const part of header?.split(';') ?? []) {
    const at = part.indexOf('=')
    if (at <= 0) {
      continue
    }
    const name = part.slice(0, at).trim()
    if (!cookies.has(name)) {
      cookies.set(name, part.slice(at + 1).trim())
    }
  }
  return cookies
}

/**
 * Write a `Cookie` header from a map.
 *
 * @param cookies - Cookies by name.
 * @returns The header's value, or `null` when there is none.
 *
 * @example
 * ```ts
 * formatCookieHeader(new Map([['a', '1']])) // 'a=1'
 * ```
 */
export function formatCookieHeader(cookies: ReadonlyMap<string, string>): string | null {
  const parts = [...cookies].map(([name, value]) => `${name}=${value}`)
  return parts.length > 0 ? parts.join('; ') : null
}

/**
 * A `Set-Cookie` line for one of the app's cookies.
 *
 * Always `HttpOnly` (no script reads a token), `SameSite=Lax` (not sent on a cross-site POST),
 * `Path=/` (the middleware needs it on every page) and host-only; `Secure` over https.
 *
 * @param name - The cookie's name, from {@link cookieNames}.
 * @param value - Its value.
 * @param options - Whether the app is on https, and how long the browser keeps the cookie.
 * @returns The header's value.
 *
 * @example
 * ```ts
 * setCookieLine('tula_at', token, { secure: false, maxAge: 60 })
 * // 'tula_at=…; Path=/; HttpOnly; SameSite=Lax; Max-Age=60'
 * ```
 */
export function setCookieLine(
  name: string,
  value: string,
  options: { secure: boolean; maxAge?: number }
): string {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax']
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`)
  }
  if (options.secure) {
    parts.push('Secure')
  }
  return parts.join('; ')
}

/**
 * A `Set-Cookie` line that removes one of the app's cookies.
 *
 * @param name - The cookie's name.
 * @param secure - Whether the app is on https.
 * @returns The header's value.
 *
 * @example
 * ```ts
 * clearCookieLine('tula_at', false) // 'tula_at=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
 * ```
 */
export function clearCookieLine(name: string, secure: boolean): string {
  return setCookieLine(name, '', { secure, maxAge: 0 })
}

/** Which of the API's cookies a `Set-Cookie` line is about, and what it does. */
export interface UpstreamCookie {
  kind: 'refresh' | 'session'
  /** The value, or `null` when the line removes the cookie. */
  value: string | null
  /** `Max-Age` in seconds, when the line has one. */
  maxAge: number | undefined
}

/**
 * Read one `Set-Cookie` line from the API.
 *
 * Only the environment's refresh and session cookies are recognised; anything else is
 * dropped by the caller, and none of the API's attributes (`Domain`, `Path`, the name's
 * prefix) is copied: the app's cookie is written afresh by {@link setCookieLine}.
 *
 * @param line - The header's value.
 * @param environmentId - The environment whose cookies count.
 * @returns What the line says, or `null` when it is not one of the two cookies.
 *
 * @example
 * ```ts
 * readUpstreamCookie('tula_rt_env1=abc; Max-Age=600; Path=/v1/client/sessions', 'env1')
 * // { kind: 'refresh', value: 'abc', maxAge: 600 }
 * ```
 */
export function readUpstreamCookie(line: string, environmentId: string): UpstreamCookie | null {
  const [pair = '', ...attributes] = line.split(';')
  const at = pair.indexOf('=')
  if (at <= 0) {
    return null
  }
  const name = pair.slice(0, at).trim()
  const value = pair.slice(at + 1).trim()
  let kind: UpstreamCookie['kind']
  if (name === `tula_rt_${environmentId}` || name === `__Secure-tula_rt_${environmentId}`) {
    kind = 'refresh'
  } else if (
    name === `tula_session_${environmentId}` ||
    name === `__Host-tula_session_${environmentId}`
  ) {
    kind = 'session'
  } else {
    return null
  }
  let maxAge: number | undefined
  let expired = false
  for (const attribute of attributes) {
    const [key = '', raw = ''] = attribute.split('=')
    const lower = key.trim().toLowerCase()
    if (lower === 'max-age' && /^-?\d+$/.test(raw.trim())) {
      maxAge = Number(raw.trim())
    } else if (lower === 'expires') {
      const when = Date.parse(attribute.slice(attribute.indexOf('=') + 1))
      expired = Number.isFinite(when) && when <= Date.now()
    }
  }
  const removed = value === '' || expired || (maxAge !== undefined && maxAge <= 0)
  if (removed || !isCookieValue(value)) {
    return { kind, value: null, maxAge: undefined }
  }
  return { kind, value, maxAge }
}

/**
 * The `Cookie` header for a call to the API: the app's refresh and session cookies under the
 * API's own names.
 *
 * The API's names depend on its public URL's scheme, which this server may not know (it can
 * reach the API on an internal address), so both spellings are sent; the API reads the one it
 * uses.
 *
 * @param environmentId - The environment id.
 * @param values - The refresh token and the session token, as far as the browser sent them.
 * @returns The header's value, or `null` when there is nothing to send.
 *
 * @example
 * ```ts
 * upstreamCookieHeader('env1', { refresh: 'abc' })
 * // '__Secure-tula_rt_env1=abc; tula_rt_env1=abc'
 * ```
 */
export function upstreamCookieHeader(
  environmentId: string,
  values: { refresh?: string | undefined; session?: string | undefined }
): string | null {
  const cookies = new Map<string, string>()
  if (values.refresh && isCookieValue(values.refresh)) {
    cookies.set(`__Secure-tula_rt_${environmentId}`, values.refresh)
    cookies.set(`tula_rt_${environmentId}`, values.refresh)
  }
  if (values.session && isCookieValue(values.session)) {
    cookies.set(`__Host-tula_session_${environmentId}`, values.session)
    cookies.set(`tula_session_${environmentId}`, values.session)
  }
  return formatCookieHeader(cookies)
}
