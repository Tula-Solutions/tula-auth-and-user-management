import { testRouteRefusal } from './guard'

/** The port of the receiver the dashboard's webhook tests register as an endpoint. */
export const RECEIVER_PORT = 4320

/**
 * The address the receiver is bound to and answers on, as a `Host` header says it.
 *
 * The loopback **address**, not `localhost`: the fixture's outbound guard is the API's own,
 * in the `local` tier, with a resolver that knows no name, so the one address it lets a
 * delivery reach is a literal loopback one. Nothing about the guard is changed for it.
 */
export const RECEIVER_HOST = `127.0.0.1:${RECEIVER_PORT}`

/**
 * Answer one request to the fixture's webhook receiver: with the status code its path names
 * (`POST /receive/204`, `/receive/410`) and nothing else.
 *
 * It reads no body, keeps nothing and answers with no body, and it is behind the same guard
 * as the fixture's test routes: a page, which sends an `Origin` with every `POST`, is refused
 * (403), and so is a request under any other name than the address it is bound to.
 *
 * This module starts nothing when it is imported: `e2e/server.ts` (which refuses to start
 * without `E2E=1`) is what serves it, and `guard.test.ts` calls it directly.
 *
 * @param request - The incoming request.
 * @param boundHost - `host:port` the receiver listens on.
 * @returns The answer: 403 for a request the guard refuses, 404 for anything that is not a
 *   `POST` to `/receive/<status>` with a status from 200 to 599, else that status.
 */
export function receiverResponse(request: Request, boundHost: string = RECEIVER_HOST): Response {
  if (testRouteRefusal(request, boundHost) !== null) {
    return new Response(null, { status: 403 })
  }
  const status = /^\/receive\/([2-5]\d\d)$/.exec(new URL(request.url).pathname)?.[1]
  return new Response(null, {
    status: request.method === 'POST' && status ? Number(status) : 404,
  })
}
