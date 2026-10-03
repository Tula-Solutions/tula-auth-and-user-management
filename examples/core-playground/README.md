# @tula/core playground

A static page for trying `@tula/core` by hand in a real browser against a running Tula API:
sign up, enter the emailed code, sign in, watch the access token count down, fire ten
concurrent `getToken()` calls (and see how many refresh requests they made), list and revoke
sessions, change and reset a password, sign out, open two tabs. Every call and every error code
is logged on the page. It is a test bench, not a product, and has no dependencies.

## Run it

From the repository root, with Docker running:

```bash
cp .env.example .env                 # once; set TULA_MASTER_KEY (openssl rand -hex 32)
docker compose up -d                 # Postgres, Redis, Mailpit (http://localhost:8025)
bun run db:migrate
bun run seed                         # prints the development environment's id
bun run api-key:create --environment <development environment id> --kind publishable
bun run dev                          # the API on http://localhost:3003
```

In a second terminal:

```bash
bun run playground                   # http://localhost:5173
```

Open <http://localhost:5173>, enter the API URL (`http://localhost:3003`) and the publishable
key that `api-key:create` printed, and press **Connect**. Both go into the page's address; no
key is stored in this directory, and none should be committed. The emailed codes arrive in
Mailpit at <http://localhost:8025>.

With `ENVIRONMENT=local` the API accepts any `http://localhost:<port>` origin. In another tier,
add `http://localhost:5173` to the environment's `urls.allowedOrigins` first.

## What to try

| Try | Expect |
| --- | --- |
| Sign up, then enter the code from Mailpit | State becomes `signed-in` with the user. |
| **getToken() ×10 concurrently** right after signing in | 1 distinct token, 0 refresh requests (the token is fresh). |
| Wait until the token shows under 10s left, then **getToken() ×10** | 1 distinct token, **1** refresh request. |
| Open the same address in a second tab | It restores the session from the cookie (one refresh). |
| **signOut()** in one tab | The other tab's state turns `signed-out` at once, without a request. |
| DevTools → Application → Cookies (the API's origin) | One `tula_rt_<environment>` cookie, `HttpOnly`, `SameSite=Lax`, path `/v1/client/sessions`. |
| DevTools → Application → Local/Session storage | Empty. |
| DevTools → Network → any response body | No `refreshToken`, nothing starting `tula_rt_`. |
| A wrong password six times | `auth.invalid_credentials`, then `rate_limited` with `retryAfterMs`. |
| A weak password in the sign-up form | The live checklist fails the same rules the server then reports. |

## How it is served

`serve.ts` serves `index.html` and `styles.css` and bundles `main.ts` for the browser on each
request (`Bun.build`), so editing the page or the SDK only needs a reload. The port is fixed
(5173) because the API decides by origin which pages may use its cookies.
