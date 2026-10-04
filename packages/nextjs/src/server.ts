import 'server-only'
import type { User } from '@tula/core'
import { headers } from 'next/headers'
import { cache } from 'react'
import { type Auth, authenticate, fetchCurrentUser, requestFromHeaders } from './helpers'

/**
 * `@tula/nextjs/server`: who is signed in, for Server Components, Route Handlers and Server
 * Actions. Importing this from a Client Component is a build error (`server-only`).
 *
 * Configuration comes from the environment: `TULA_API_URL`,
 * `NEXT_PUBLIC_TULA_PUBLISHABLE_KEY`, `TULA_ENVIRONMENT_ID`, and optionally `TULA_ISSUER`,
 * `TULA_APP_URL` and `TULA_SECRET_KEY` (for `stateful` session profiles).
 *
 * Set `TULA_APP_URL` to the app's public origin: it then decides, here as in the middleware
 * and the route handler, whether the `__Host-` cookie names are read. Without it the proxy's
 * `X-Forwarded-Proto` decides, and without that the presence of a `__Host-` cookie.
 */

export type { User } from '@tula/core'
export type { Auth } from './helpers'
export { REDIRECT_PARAM, safeRedirectPath } from './paths'
export type { SessionClaims } from './verify'

/** One options object for the process: the configuration is resolved from it once. */
const OPTIONS = {}

/**
 * The current request as the helpers need it: its headers (cookies included), and the scheme
 * {@link requestFromHeaders} works out for them.
 */
async function currentRequest(): Promise<Request> {
  return requestFromHeaders(new Headers(await headers()))
}

/**
 * Who is signed in for the current request.
 *
 * The session is verified here, not taken from the middleware: the access-token cookie is
 * checked against the environment's published keys (offline; `EdDSA`, `iss`, `aud`, `exp`,
 * `kid`). The middleware's part is to refresh an expired token before the request gets here;
 * without it, a session whose token has expired reads as signed out. Verified once per
 * request, however often it is called. Reading it makes the route dynamic.
 *
 * @returns `{ isSignedIn: true, userId, sessionId, claims, getToken }`, or the signed-out
 *   shape with `null`s.
 * @throws TypeError when the configuration is incomplete.
 *
 * @example
 * ```tsx
 * // app/dashboard/page.tsx
 * import { auth } from '@tula/nextjs/server'
 * import { redirect } from 'next/navigation'
 *
 * export default async function Dashboard() {
 *   const { isSignedIn, userId } = await auth()
 *   if (!isSignedIn) {
 *     redirect('/sign-in')
 *   }
 *   return <p>Signed in as {userId}</p>
 * }
 * ```
 */
export const auth: () => Promise<Auth> = cache(async () =>
  authenticate(await currentRequest(), OPTIONS)
)

/**
 * The signed-in user's profile, fetched from the API (`GET /v1/client/me`) with the request's
 * session. One call per request, however often it is used.
 *
 * Unlike {@link auth}, this asks the API, so it also notices a session that was revoked a
 * moment ago.
 *
 * @returns The user, or `null` when nobody is signed in or the API does not answer with one.
 * @throws TypeError when the configuration is incomplete.
 *
 * @example
 * ```tsx
 * import { currentUser } from '@tula/nextjs/server'
 *
 * export default async function Greeting() {
 *   const user = await currentUser()
 *   return <p>Hello {user?.firstName ?? 'there'}</p>
 * }
 * ```
 */
export const currentUser: () => Promise<User | null> = cache(async () =>
  fetchCurrentUser(await currentRequest(), OPTIONS)
)

/**
 * The current request's access token, for calling your own backend from the server.
 *
 * @returns The token, or `null` when nobody is signed in or the session is `stateful` (it has
 *   no token).
 * @throws TypeError when the configuration is incomplete.
 *
 * @example
 * ```ts
 * import { getToken } from '@tula/nextjs/server'
 *
 * const token = await getToken()
 * await fetch('https://api.example.com/orders', { headers: { authorization: `Bearer ${token}` } })
 * ```
 */
export async function getToken(): Promise<string | null> {
  return (await auth()).getToken()
}
