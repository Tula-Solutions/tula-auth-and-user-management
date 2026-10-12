/**
 * A request as a browser or a tool on this machine sends it: with a `Host` header that names
 * this machine.
 *
 * `app.request` hands the app a `Request` that never crossed a connection, so it has no
 * `Host` at all, where every real client sends one. The development-only routes (the mock
 * provider's, the SMS inbox) answer a loopback `Host` and nothing else: a test that plays a
 * local browser or tool says so here, as a live run reaches the server at a loopback address.
 * A `Host` the request already carries is kept: a test of a tunnel's or a rebinding page's
 * request sets its own.
 *
 * @param request - The request about to be handed to the app.
 * @returns The request, with `Host: localhost` when it had none.
 */
export function fromThisMachine(request: Request): Request {
  if (request.headers.has('host')) {
    return request
  }
  const headers = new Headers(request.headers)
  headers.set('host', 'localhost')
  return new Request(request, { headers })
}
