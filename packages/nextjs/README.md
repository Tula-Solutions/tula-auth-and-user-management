# @tula/nextjs

Tula Auth for the Next.js App Router (15 and 16): the prebuilt components, a server that knows
who is signed in, and session cookies that belong to your own origin. See
[ADR 0029](../../docs/adr/0029-nextjs-sdk.md) for the design and
[`examples/nextjs-app-router`](../../examples/nextjs-app-router) for a complete app.

## Set up

```bash
TULA_API_URL=https://auth.example.com          # where the Next.js SERVER reaches the API
NEXT_PUBLIC_TULA_PUBLISHABLE_KEY=tula_pk_live_…
TULA_ENVIRONMENT_ID=<environment id>
# TULA_ISSUER=…       only if the API's public URL differs from TULA_API_URL
# TULA_APP_URL=…      only behind a proxy that rewrites Host
# TULA_SECRET_KEY=…   only for `stateful` session profiles; never NEXT_PUBLIC_
```

**1. The route handler.** The browser talks to this route, never to the API's host.

```ts
// app/api/tula/[...tula]/route.ts
import { createTulaHandlers } from '@tula/nextjs/handlers'

export const { GET, POST, PUT, PATCH, DELETE } = createTulaHandlers()
```

**2. The request interceptor.** `proxy.ts` in Next.js 16; in Next.js 15 name the file
`middleware.ts` and the export `middleware`.

```ts
// proxy.ts
import { tulaMiddleware } from '@tula/nextjs/middleware'

export const proxy = tulaMiddleware({ publicRoutes: ['/', '/pricing'] })

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] }
```

**3. The provider**, with what the server knows, so the first paint is right.

```tsx
// app/layout.tsx
import { TulaProvider } from '@tula/nextjs'
import { auth } from '@tula/nextjs/server'
import '@tula/react/styles.css'

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { sessionId } = await auth()
  return (
    <html lang='en'>
      <body>
        <TulaProvider
          publishableKey={process.env.NEXT_PUBLIC_TULA_PUBLISHABLE_KEY ?? ''}
          initialState={sessionId ? { sessionId } : null}
          signInUrl='/sign-in'
          afterSignOutUrl='/'
        >
          {children}
        </TulaProvider>
      </body>
    </html>
  )
}
```

**4. Pages.** Components come from `@tula/nextjs` (they are Client Components); the server
helpers from `@tula/nextjs/server`.

```tsx
// app/sign-in/page.tsx
import { SignIn } from '@tula/nextjs'
import { safeRedirectPath } from '@tula/nextjs/server'

export default async function Page(props: { searchParams: Promise<{ redirect_url?: string }> }) {
  const { redirect_url } = await props.searchParams
  return <SignIn afterSignInUrl={safeRedirectPath(redirect_url, '/dashboard')} />
}
```

```tsx
// app/dashboard/page.tsx
import { auth, currentUser } from '@tula/nextjs/server'

export default async function Dashboard() {
  const { userId } = await auth()
  const user = await currentUser()
  return <p>{user?.email} ({userId})</p>
}
```

## What you must configure on the API

- **Allowed origins.** Add the app's origin to the environment's `urls.allowedOrigins`. The
  handler forwards the browser's `Origin` unchanged, so the API's own origin rules decide.
- **`TRUST_PROXY=true`.** The handler sends the visitor's address in `X-Forwarded-For`; the
  API reads it only with `TRUST_PROXY=true`. **Without it every visitor shares the Next.js
  server's address, and therefore one per-IP rate limit: a few failed sign-ins by one person
  can lock everyone out.** The Next.js server must reach the API directly; if Next.js itself is
  exposed without a proxy in front, pass `clientIp` so a visitor cannot write their own
  address.

## How it behaves

- **Cookies** (`tula_rt`, `tula_at`, `tula_session`; `__Host-`-prefixed over https) are
  `HttpOnly`, `SameSite=Lax`, host-only. No script can read a token and nothing is in storage.
- **Access tokens are verified offline** against the environment's JWKS: no call per request.
  A session revoked on the API keeps working here until its token expires (60 seconds by
  default), then is signed out at the refresh. `currentUser()` asks the API and notices at once.
- **Clocks must agree.** Expiry is judged by the Next.js server's clock against the API's
  `exp` (five seconds of tolerance): keep both on NTP.
- **Refresh** happens in the interceptor when the token is missing or about to expire. Requests
  racing with one refresh token are covered by the API's reuse grace window (10 seconds by
  default); do not use a profile with `refresh.reuseGracePeriod: null` behind it.
- **`stateful` session profiles** have no token. With `TULA_SECRET_KEY` the server asks the API
  on every matched request (one network call each); without it the server treats such a
  session as signed out.
- **`redirect_url`** is written by the interceptor as a path and must be read through
  `safeRedirectPath`, which refuses anything that leaves the origin.
- `auth()` in the root layout makes every route dynamic. For static pages leave `initialState`
  out; the state is then `loading` until the browser has asked.
