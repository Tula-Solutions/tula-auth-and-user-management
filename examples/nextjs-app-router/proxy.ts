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
