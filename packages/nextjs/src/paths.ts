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

/**
 * Turn an untrusted "where to go next" value into a path on this origin, or a fallback.
 *
 * A `redirect_url` comes from the address bar, so anyone can write one. Only a path that
 * starts with a single `/` is accepted: an absolute URL, a protocol-relative one (`//host`), a
 * backslash trick (`/\host`) or anything with a control character gets the fallback. This is
 * what keeps a sign-in link from being used to send people to another site.
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
 * ```
 */
export function safeRedirectPath(value: unknown, fallback = '/'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    return fallback
  }
  // A single leading slash, then no slash or backslash: browsers read `//` and `/\` as a host.
  if (!/^\/(?![/\\])/.test(value) || value.includes('\\') || hasControlCharacter(value)) {
    return fallback
  }
  let url: URL
  try {
    url = new URL(value, PROBE_ORIGIN)
  } catch {
    return fallback
  }
  if (url.origin !== PROBE_ORIGIN) {
    return fallback
  }
  return `${url.pathname}${url.search}${url.hash}`
}
