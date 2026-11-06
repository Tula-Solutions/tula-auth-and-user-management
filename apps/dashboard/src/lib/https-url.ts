const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Whether a value is an absolute `https:` URL, or an `http:` one on this machine.
 *
 * The test pop-up is pointed at an address the server returned; `javascript:` or `data:` there
 * would run in a window the dashboard opened, so anything else is refused. Plain http is allowed
 * on loopback only, where a local stack's identity provider runs (the server allows it in the
 * `local` tier alone, as the SDKs do).
 *
 * @param value - The address to check.
 * @returns `true` only for a parseable `https:` URL, or an `http:` URL whose host is loopback.
 */
export function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))
    )
  } catch {
    return false
  }
}
