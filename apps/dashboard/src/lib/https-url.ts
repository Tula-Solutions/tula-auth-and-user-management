/**
 * Whether a value is an absolute `https:` URL.
 *
 * The test pop-up is pointed at an address the server returned; `javascript:` or `data:` there
 * would run in a window the dashboard opened, so anything but https is refused.
 *
 * @param value - The address to check.
 * @returns `true` only for a parseable URL whose scheme is `https:`.
 */
export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}
