/** Where the app goes when no destination was asked for. */
export const HOME = '/'

/**
 * The in-app path to return to after sign-in, or home.
 *
 * The value comes from the address bar, so it is treated as untrusted: only a path of this
 * app is accepted (one leading slash, no scheme, no host, no backslash a browser would read as
 * a slash), and never the sign-in page itself.
 *
 * @param value - The `redirect` search parameter.
 * @returns A path beginning with a single `/`.
 */
export function safeRedirect(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) {
    return HOME
  }
  const hasControl = [...value].some((character) => character.charCodeAt(0) < 0x20)
  if (value.includes('\\') || hasControl || value.startsWith('/sign-in')) {
    return HOME
  }
  return value
}
