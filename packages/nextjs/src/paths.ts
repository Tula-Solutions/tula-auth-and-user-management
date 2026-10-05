// Names shared by the browser and the server halves of the package. Nothing here is secret and
// nothing here reads the environment: the client entry point may import it.

/**
 * Where the route handler is mounted unless the app says otherwise: the browser's `@tula/core`
 * client sends every call to this path on the app's own origin.
 *
 * @example
 * ```ts
 * // app/api/tula/[...tula]/route.ts answers `${DEFAULT_HANDLER_PATH}/v1/client/*`
 * ```
 */
export const DEFAULT_HANDLER_PATH = '/api/tula'

/**
 * The query parameter the middleware puts on the sign-in URL: where the visitor was going.
 *
 * @example
 * ```ts
 * // /sign-in?redirect_url=%2Fdashboard
 * new URL(request.url).searchParams.get(REDIRECT_PARAM)
 * ```
 */
export const REDIRECT_PARAM = 'redirect_url'

/** A base no real URL has: resolving against it shows whether a value leaves the origin. */
const PROBE_ORIGIN = 'http://tula.invalid'

/** Browsers drop tabs and newlines from a URL, so `/\t/host` would read as `//host`. */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) {
      return true
    }
  }
  return false
}

/** A path that starts with one `/` and then neither a slash nor a backslash, raw or encoded. */
const SINGLE_SLASH = /^\/(?![/\\]|%5c|%2f)/i

/**
 * Turn an untrusted "where to go next" value into a path on this origin, or a fallback.
 *
 * A `redirect_url` comes from the address bar, so anyone can write one. Only a path that
 * starts with a single `/` is accepted: an absolute URL, a protocol-relative one (`//host`), a
 * backslash trick (`/\host`) or anything with a control character gets the fallback. This is
 * what keeps a sign-in link from being used to send people to another site.
 *
 * The rule is applied to the value that is **returned**, not only to the one that came in: the
 * URL parser removes dot segments, so `/.//host`, `/a/..//host` and `/%2e//host` all normalise
 * to `//host`, which a browser and a router read as another origin.
 *
 * @param value - The untrusted value, e.g. a `redirect_url` search parameter.
 * @param fallback - Where to go when the value is refused. Defaults to `/`.
 * @returns A path (with its query and fragment) on this origin.
 *
 * @example
 * ```ts
 * safeRedirectPath('/dashboard?tab=1') // '/dashboard?tab=1'
 * safeRedirectPath('https://evil.example') // '/'
 * safeRedirectPath('//evil.example', '/home') // '/home'
 * safeRedirectPath('/.//evil.example') // '/'
 * ```
 */
export function safeRedirectPath(value: unknown, fallback = '/'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    return fallback
  }
  if (!SINGLE_SLASH.test(value) || value.includes('\\') || hasControlCharacter(value)) {
    return fallback
  }
  const path = normalizedPath(value)
  // What is returned is what a router is given, so it is what must be a path: the parser
  // turns `/.//host` into `//host`. Parsing it once more must also change nothing.
  if (path === null || !SINGLE_SLASH.test(path) || normalizedPath(path) !== path) {
    return fallback
  }
  return path
}

/** The path, query and fragment a value resolves to on the probe origin; `null` when it leaves it. */
function normalizedPath(value: string): string | null {
  let url: URL
  try {
    url = new URL(value, PROBE_ORIGIN)
  } catch {
    return null
  }
  if (url.origin !== PROBE_ORIGIN) {
    return null
  }
  return `${url.pathname}${url.search}${url.hash}`
}
