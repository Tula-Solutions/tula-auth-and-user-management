# Next.js App Router example

A Next.js 16 app whose authentication is [`@tula/nextjs`](../../packages/nextjs): a public home
page, sign-in and sign-up, a protected dashboard rendered on the server, a protected route
handler, a server action and the account page.

| | |
| --- | --- |
| ![The dashboard, rendered on the server](docs/dashboard.png) | ![A protected page, signed out: sent to sign-in](docs/sign-in-redirect.png) |
| ![The account page](docs/profile.png) | ![The dashboard on a phone, dark](docs/mobile-dashboard-dark.png) |

## What is where

| File | What it shows |
| --- | --- |
| `app/api/tula/[...tula]/route.ts` | The route handler: the browser talks to this origin, never to the API. |
| `proxy.ts` | Verifies the session offline, refreshes it, protects everything but `/`. |
| `app/layout.tsx` | `<TulaProvider>` with the server's `initialState`; a header that is right at first paint. |
| `app/dashboard/page.tsx` | A server component using `auth()` and `currentUser()`. |
| `app/dashboard/actions.ts` | A server action that checks the session itself. |
| `app/api/whoami/route.ts` | A protected route handler (401 when signed out). |
| `app/sign-in/page.tsx` | `<SignIn>` with a `redirect_url` checked by `safeRedirectPath`. |
| `app/profile/page.tsx` | `<UserProfile>`. |

## Run it

It is configured by environment variables only ([`.env.example`](.env.example) lists them).

```bash
# from the repository root, with the API running (bun run dev, or the Compose stack)
bun run seed                      # prints the environment id; then mint a publishable key:
bun run api-key:create --environment <id> --kind publishable

cd examples/nextjs-app-router
TULA_API_URL=http://localhost:3003 \
NEXT_PUBLIC_TULA_PUBLISHABLE_KEY=tula_pk_dev_… \
TULA_ENVIRONMENT_ID=<id> \
PORT=3100 bun run dev
```

- A local API (`ENVIRONMENT=local`) allows any loopback origin. Anywhere else, add this app's
  origin to the environment's `urls.allowedOrigins`.
- Start the API with `TRUST_PROXY=true`: otherwise it sees every visitor at this server's
  address, and they all share one per-IP rate limit.
- For a `stateful` session profile also set `TULA_SECRET_KEY`.
- The example has no page for emailed sign-in links or OAuth callbacks; leave those methods
  off, or add pages with `<EmailLinkCallback>` and `<OAuthCallback>`.

## Tests

`bun run e2e` builds this app once and drives it with Playwright against the real API in
process (`e2e/tests/nextjs/`). `bun run e2e:screenshots` regenerates the screenshots above.
