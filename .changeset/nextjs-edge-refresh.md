---
'@tula/nextjs': patch
---

The interceptor refreshes sessions on Next.js 15.

Next.js 15 runs `middleware.ts` in its Edge runtime, whose `Request`, built from another
`Request`, keeps only the URL. The server-side refresh and the check of a `stateful` session
were sent through such a copy, so they reached the API as a bare `GET` (answered 404): an
expired access token was never replaced by the interceptor, a request with only the refresh
cookie was signed out for server components and route handlers, and a `stateful` session was
never signed in on the server. Every call to the API is now built once, from its URL and parts.
Next.js 16 (`proxy.ts`, Node.js runtime) was not affected.
