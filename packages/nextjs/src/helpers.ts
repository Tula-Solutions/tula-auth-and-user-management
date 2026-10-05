import { CLIENT_HEADER } from '@tula/contract/headers'
import type { User } from '@tula/core'
import { configFor, type TulaServerOptions } from './config'
import { cookieNames, parseCookieHeader } from './cookies'
import { readSession } from './session'
import { apiHeaders, callApi, readRequestCookies } from './upstream'
import type { SessionClaims } from './verify'

// The server helpers without Next.js: they take the request. `server.ts` binds them to
// `next/headers`; tests call them directly.

/**
 * Who is signed in for the current request.
 *
 * @example
 * ```ts
 * const { isSignedIn, userId } = await auth()
 * if (!isSignedIn) {
 *   redirect('/sign-in')
 * }
 * ```
 */
export type Auth =
  | {
      isSignedIn: true
      /** The user's id (the token's `sub`). */
      userId: string
      /** The session's id (the token's `sid`). */
      sessionId: string
      /** Every verified claim: `auth_time`, `amr` and the rest. */
      claims: SessionClaims
      /**
       * The access token, for calling your own backend. `null` for a `stateful` session,
       * which has none.
       */
      getToken(): Promise<string | null>
    }
  | {
      isSignedIn: false
      userId: null
      sessionId: null
      claims: null
      getToken(): Promise<null>
    }

/** The SDK's cookie names over https: a browser stores a `__Host-` cookie over https only. */
const HOST_PREFIXED = new Set(Object.values(cookieNames(true)))

/**
 * The current request as the server helpers need it, built from its headers alone: a Server
 * Component is given no URL, so the scheme the middleware and the route handler saw has to be
 * worked out again.
 *
 * In order: the configured app URL (`TULA_APP_URL`, the recommended way: nothing is guessed);
 * the proxy's `X-Forwarded-Proto` (both are read by `appOrigin`, which this only feeds); and
 * otherwise https exactly when the request carries one of this package's `__Host-` cookies,
 * because a browser accepts and stores those over https only. Without this last rule an app
 * served over https with neither of the first two would read the unprefixed names here while
 * the middleware wrote the `__Host-` ones: signed in for the middleware, signed out in every
 * Server Component. One name per cookie is read for a request, never both.
 *
 * @param headers - The request's headers, cookies included.
 * @returns A stand-in request whose URL carries only that scheme.
 *
 * @example
 * ```ts
 * const request = requestFromHeaders(new Headers(await headers()))
 * const { isSignedIn } = await authenticate(request, {})
 * ```
 */
export function requestFromHeaders(headers: Headers): Request {
  let secure = false
  for (const name of parseCookieHeader(headers.get('cookie')).keys()) {
    if (HOST_PREFIXED.has(name)) {
      secure = true
      break
    }
  }
  return new Request(`${secure ? 'https' : 'http'}://localhost/`, { headers })
}

const SIGNED_OUT: Auth = Object.freeze({
  isSignedIn: false,
  userId: null,
  sessionId: null,
  claims: null,
  getToken: () => Promise.resolve(null),
})

/**
 * Work out who a request is from, verifying its session again here.
 *
 * Nothing the middleware says is taken on trust: the access token is verified against the
 * environment's keys (offline; the keys are cached), and a `stateful` session's claims are
 * accepted only with this app's signature or from the API itself.
 *
 * @param request - The request, or a stand-in with its headers.
 * @param options - The server configuration; read from the environment when left out.
 * @returns The signed-in or signed-out shape.
 * @throws TypeError when the configuration is incomplete.
 *
 * @example
 * ```ts
 * const auth = await authenticate(request, {})
 * auth.userId // string | null
 * ```
 */
export async function authenticate(request: Request, options: TulaServerOptions): Promise<Auth> {
  const session = await readSession(request, configFor(options))
  if (!session) {
    return SIGNED_OUT
  }
  const { claims, token } = session
  return {
    isSignedIn: true,
    userId: claims.sub,
    sessionId: claims.sid,
    claims,
    getToken: () => Promise.resolve(token),
  }
}

/**
 * Fetch the signed-in user's profile from the API (`GET /v1/client/me`).
 *
 * Called with the request's access token, or with a `stateful` session's cookie. Unlike the
 * offline check, this asks the API: a session revoked a moment ago answers `null` here.
 *
 * @param request - The request, or a stand-in with its headers.
 * @param options - The server configuration.
 * @returns The user, or `null` when nobody is signed in or the API does not answer with one.
 * @throws TypeError when the configuration is incomplete.
 *
 * @example
 * ```ts
 * const user = await fetchCurrentUser(request, {})
 * user?.email
 * ```
 */
export async function fetchCurrentUser(
  request: Request,
  options: TulaServerOptions
): Promise<User | null> {
  const config = configFor(options)
  const session = await readSession(request, config)
  if (!session) {
    return null
  }
  const cookies = readRequestCookies(request, config)
  const headers = apiHeaders(request, config, session.token ? {} : { session: cookies.session })
  if (session.token) {
    headers.set('authorization', `Bearer ${session.token}`)
    headers.set(CLIENT_HEADER, 'server')
  } else {
    headers.set(CLIENT_HEADER, 'web')
  }
  headers.set('accept', 'application/json')
  try {
    const response = await callApi(
      config,
      new Request(`${config.apiUrl}/v1/client/me`, { headers })
    )
    if (response.status !== 200) {
      return null
    }
    const user: unknown = await response.json()
    return typeof user === 'object' && user !== null && typeof (user as User).id === 'string'
      ? (user as User)
      : null
  } catch {
    return null
  }
}
