/**
 * Whether a request may use the fixture's test routes (`/__test/*`), which publish every email
 * the API "sent" and reset its rate limits.
 *
 * Only the test process may. A web page must not, including one that reaches this port by DNS
 * rebinding: such a page is same-origin with itself, so its GET carries no `Origin`. What it
 * cannot fake is the `Host` header (it names the attacker's domain) or, in current browsers,
 * `Sec-Fetch-Site`.
 *
 * @param request - The incoming request.
 * @param boundHost - `host:port` the server listens on, e.g. `localhost:4318`.
 * @returns Why the request is refused, or `null` when it is allowed.
 */
export function testRouteRefusal(request: Request, boundHost: string): string | null {
  if (request.headers.has('origin')) {
    return 'test routes are not for pages'
  }
  if (request.headers.get('host') !== boundHost) {
    return 'test routes answer only on the address the fixture bound to'
  }
  const site = request.headers.get('sec-fetch-site')
  if (site !== null && site !== 'none' && site !== 'same-origin') {
    return 'test routes are not for pages'
  }
  return null
}
