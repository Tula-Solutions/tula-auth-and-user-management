# Sessions

How a signed-in user stays signed in: session profiles (lifetimes, and whether the browser
holds tokens at all), the list of devices and signing them out, the limit on concurrent
sessions, and what your server sees.
The reasoning is in [ADR 0008](../adr/0008-sessions.md) and
[ADR 0028](../adr/0028-session-profiles.md); the Next.js cookies in
[ADR 0029](../adr/0029-nextjs-sdk.md).

## Switch it on

Sessions need no switching on. Left alone, every session has a 60-second access token, a
rotating refresh token, 7 days idle and 30 days in all.

| Where | How |
| --- | --- |
| Dashboard | **Session profiles**: lifetimes per profile, custom profiles, the concurrent-session limit. A user's page: revoke one session or all. |
| `tula.config.ts` | `sessions`. |
| Admin API | `PUT /v1/admin/settings`; `DELETE /v1/admin/users/<id>/sessions`; `POST /v1/admin/sessions/verify` for a stateful cookie. |

<!-- snippet: examples/tula-config/tula.config.ts#sessions -->
```ts
sessions: {
  maxPerUser: 10,
  onLimit: 'end_oldest',
  profiles: {
    web: { idleTimeout: '7d', absoluteTimeout: '30d' },
    mobile: { idleTimeout: '30d', absoluteTimeout: '90d' },
  },
},
```
<!-- /snippet -->

<!-- snippet: examples/docs-snippets/admin.ts#settings-sessions -->
```ts
const { data } = await admin.call('getEnvironmentSettings')
await admin.call('replaceEnvironmentSettings', {
  headers: { 'If-Match': ifMatch(data.revision) },
  body: {
    ...data.settings,
    sessions: {
      ...data.settings.sessions,
      profiles: {
        ...data.settings.sessions?.profiles,
        web: { idleTimeout: '1d', absoluteTimeout: '14d' },
        'back-office': {
          type: 'hybrid',
          idleTimeout: '15m',
          absoluteTimeout: '8h',
          stepUpAfter: '5m',
          clientSelectable: true,
        },
      },
      maxPerUser: 5,
      onLimit: 'end_oldest',
    },
  },
})
```
<!-- /snippet -->

<!-- snippet: examples/docs-snippets/admin.ts#revoke-sessions -->
```ts
await admin.call('revokeUserSessions', { params: { userId } })
```
<!-- /snippet -->

- A browser gets the `web` profile, every other client `mobile`. A client may ask for another
  profile and gets it only if the environment marks it `clientSelectable`.
- **`type: 'hybrid'`** (default): a short access token verified offline, and a refresh token.
- **`type: 'stateful'`** (browsers only): one httpOnly cookie and no token; every request is
  checked against the database, so a sign-out elsewhere takes effect on the very next request.
  It costs a database read per request.
- **`maxPerUser`** with `onLimit: 'end_oldest'` (default) lets the new device in and ends the
  oldest session; `'refuse_newest'` refuses the new sign-in.

Each field's range is in [self-host.md](../self-host.md#sessions).

## What the user sees

- The account page lists their devices (browser and operating system, and which one is this
  device), with **Sign out** per device and **Sign out of all other devices**.
- A device signed out elsewhere is signed out at its next refresh (within a minute) on a
  hybrid profile, and at its next request on a stateful one.
- At the session limit with `refuse_newest`: "You are signed in on too many devices", and no
  session is created.
- A sign-in from a browser and operating system none of their sessions has is announced by
  email (`notifications.newSignIn`).

## Security properties and limits

- A refresh token is single use and rotates; presenting a used one ends the whole session
  family (`session.reuse_detected`). The one exception is the profile's grace window (10
  seconds by default): a token re-presented within it gets the same successor, never a new one.
- Access tokens are EdDSA JWTs issued per environment; keys are published at the issuer's
  `/.well-known/jwks.json`. A revoked session's token is refused by the API at once (a shared
  denylist), but **your own backend, verifying offline, accepts it until it expires**: keep
  `accessTokenTtl` short, or use a stateful profile where that matters.
- Tightening a profile reaches sessions that already exist; loosening never extends one past
  the absolute limit it was created with.
- With `@tula/nextjs` the tokens are this app's own httpOnly cookies and no script can read
  them. With `@tula/react` alone the refresh token is the API's httpOnly cookie and the access
  token lives in memory.
- With more than one API instance, rate limits, lockouts and revocations are shared through
  Redis, and a change of settings reaches the other instances within 5 seconds
  ([self-host.md](../self-host.md#running-it-for-real)).

## SDK calls

`@tula/nextjs`: the interceptor verifies the session offline and refreshes it; server code
asks `auth()` and `currentUser()`. The example app's interceptor, a server component, a route
handler and a server action:

<!-- snippet: examples/nextjs-app-router/proxy.ts -->
```ts
import { tulaMiddleware } from '@tula/nextjs/middleware'

// Next.js 16 calls this file `proxy.ts` (it was `middleware.ts` up to Next.js 15). It runs
// before every matched request: verifies the session cookie offline, refreshes it when the
// access token has expired, and sends signed-out visitors of protected routes to /sign-in.
export const proxy = tulaMiddleware({
  // Everything else needs a session. /sign-in, /sign-up and /api/tula are always public.
  // The two callback pages are where a visitor arrives while still signed out.
  publicRoutes: ['/', '/auth/link', '/oauth/callback'],
})

export const config = {
  // Every route except Next.js's own assets.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
```
<!-- /snippet -->

<!-- snippet: examples/nextjs-app-router/app/dashboard/page.tsx -->
```tsx
import { auth, currentUser } from '@tula/nextjs/server'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { SessionCheckForm } from './session-check'

/**
 * A protected page, rendered on the server. The proxy lets only signed-in requests through;
 * the page checks again, because a page must not depend on the proxy's matcher covering it.
 */
export default async function Dashboard() {
  const { isSignedIn, userId, sessionId, claims } = await auth()
  if (!isSignedIn) {
    redirect('/sign-in?redirect_url=%2Fdashboard')
  }
  const user = await currentUser()
  return (
    <section className='panel' aria-labelledby='dashboard-title'>
      <h1 id='dashboard-title'>Hello{user ? `, ${user.firstName ?? user.email}` : ''}</h1>
      <p>This page was rendered on the server, which verified your session offline.</p>
      <dl className='facts'>
        <dt>Email</dt>
        <dd data-testid='server-email'>{user?.email ?? 'unknown'}</dd>
        <dt>User id</dt>
        <dd data-testid='server-user-id'>{userId}</dd>
        <dt>Session id</dt>
        <dd data-testid='server-session-id'>{sessionId}</dd>
        <dt>Token expires</dt>
        <dd data-testid='server-token-expiry'>{new Date(claims.exp * 1000).toISOString()}</dd>
      </dl>
      <SessionCheckForm />
      <p className='row'>
        <Link href='/profile' className='button-link'>
          Manage your account
        </Link>
      </p>
    </section>
  )
}
```
<!-- /snippet -->

<!-- snippet: examples/nextjs-app-router/app/api/whoami/route.ts -->
```ts
import { auth } from '@tula/nextjs/server'

/** A protected route handler: the proxy answers 401 before this runs when nobody is signed in. */
export async function GET(): Promise<Response> {
  const { isSignedIn, userId, sessionId } = await auth()
  if (!isSignedIn) {
    return Response.json({ status: 401, code: 'auth.unauthenticated' }, { status: 401 })
  }
  return Response.json({ userId, sessionId }, { headers: { 'cache-control': 'no-store' } })
}
```
<!-- /snippet -->

<!-- snippet: examples/nextjs-app-router/app/dashboard/actions.ts -->
```ts
'use server'

import { auth, currentUser } from '@tula/nextjs/server'

/** What the server action answers. */
export interface SessionCheck {
  /** Who the server says is signed in, or `null`. */
  email: string | null
  /** When the server looked. */
  checkedAt: string
}

/**
 * A server action that needs a session. The proxy has already refreshed the token for this
 * request; the action still asks `auth()` itself, because an action is a public endpoint.
 */
export async function checkSession(): Promise<SessionCheck> {
  const { isSignedIn } = await auth()
  const user = isSignedIn ? await currentUser() : null
  return { email: user?.email ?? null, checkedAt: new Date().toISOString() }
}
```
<!-- /snippet -->

`@tula/core`:

<!-- snippet: examples/docs-snippets/core.ts#sessions -->
```ts
const token = await tula.session.getToken() // refreshed first if needed; null when signed out
const devices = await tula.session.list() // `current` marks this one
const other = devices.find((device) => !device.current)
if (other) {
  await tula.session.revoke(other.id)
}
await tula.session.revokeOthers()
await tula.session.signOut()
```
<!-- /snippet -->

<!-- snippet: examples/docs-snippets/core.ts#session-profile -->
```ts
// Ask for a named profile; granted only if the environment marks it `clientSelectable`.
const backOffice = createTulaClient({
  publishableKey: 'tula_pk_dev_…',
  baseUrl: 'https://auth.example.com',
  sessionProfile: 'back-office',
})
```
<!-- /snippet -->

Reference: [`@tula/nextjs`](../reference/nextjs.md), [`@tula/core`](../reference/core.md),
[`@tula/react`](../reference/react.md).

## Troubleshooting

| Code | What it means and what to do |
| --- | --- |
| `session.expired` | The session passed its idle or absolute timeout. The user signs in again. |
| `session.revoked` | It was signed out: by the user, from another device, by an administrator or by the session limit. |
| `session.reuse_detected` | A refresh token was used twice outside the grace window; the session is ended. Two clients sharing one token, or a restored backup of an app's storage. |
| `session.invalid_token` | The refresh token or cookie is not one the API issued. |
| `session.limit_reached` | `maxPerUser` with `refuse_newest`: the user signs out elsewhere or resets their password. |
| `auth.unauthenticated` | No valid access token. Through `@tula/nextjs` it can also mean the app's origin is not in `urls.allowedOrigins`. |
| `auth.user_banned` | The user was banned; every session is over. |
| `request.origin_not_allowed` | A browser request from an origin the environment does not allow: cookies are not honoured for it. |
| `service.unavailable` | The API cannot reach Redis and will not guess whether a session was revoked. |

Every visitor of a Next.js app sharing one rate limit means the visitor's address is not
reaching the API: set `TULA_TRUSTED_PROXY_HOPS` on the Next.js server and `TRUST_PROXY=true`
on the API ([self-host.md](../self-host.md#running-it-for-real)).
