# Phase 1: what was not verified against the real thing

Collected for the whole-phase review from the "Not tested" and "Not confirmed" notes of the
Phase 1 pull requests (#14 to #31, and the MCP step on `feat/mcp`), and from step 1.17. An
item is here when the code was tested against a stand-in (a mock, a virtual device, an
in-process fixture) or by a static check, and never against what it stands for. What 1.17
itself ran is in the [exit-criteria evidence](phase-1.md#exit-criteria--evidence).

## External services and devices

| What | What it was tested against instead | Where it was noted |
| --- | --- | --- |
| **Real Google, GitHub and Apple sign-in** | The API's mock provider (`OAUTH_MOCK_PROVIDER`), including in the scaffolded-project run of 1.17. No real credentials exist here. The adapters' token and profile handling, Apple's form-post callback and client-secret signing were never run against the providers. | #25, 1.17 |
| The provider consoles' steps in [providers/](../providers/google.md) and [methods/oauth.md](../methods/oauth.md) | Written from the providers' documentation; never clicked through. The redirect URI and the scopes are what the code sends. | 1.17 |
| Apple's private relay addresses and "name only on first authorization" | Unit tests on fixtures. | #25 |
| **A physical passkey authenticator** (Touch ID, Windows Hello, a security key, a phone) and a platform passkey manager's sync | Chromium's virtual authenticator through the DevTools protocol, in the browser tests and in the 1.17 run. | #26, 1.17 |
| Passkey credentials using EdDSA or RS256 | The software authenticators are ES256 only. | #26 |
| A physical phone and authenticator app for TOTP | Codes computed in the tests from the setup key the page shows. | #24 |
| A real mail relay and real inboxes (deliverability, how clients render the emails, link scanners that open links) | Mailpit locally; an in-memory outbox in tests. | 1.17 |
| Have I Been Pwned (`BREACH_CHECK=hibp`) from a deployed server | Unit tests with a fake `fetch`; local runs use `offline`. | 1.17 |

## Runtimes and browsers

| What | What was run instead | Where it was noted |
| --- | --- | --- |
| React 18 in a browser, React 18.2.0 (the floor of the peer range), and the types against `@types/react` 18 | The component tests ran on React 18.3.1 in happy-dom ([below](#verified-after-phase-1)); the example apps and the browser tests are React 19 only. | #21 |
| Browsers other than Chromium: Safari, Firefox, mobile browsers. Includes the backup-code download, WebAuthn autofill and third-party-cookie behaviour. | Chromium in Playwright. | #20, #21, #24 |
| A real screen reader | axe on every screen, in light and dark, with no rule disabled. | #21 |
| `@tula/core` on edge runtimes and in Node | Type and bundle checks; tests run under Bun. | #20 |
| `@tula/config`'s `loadConfig` under Node; `@tula/admin`'s `browser` export condition under a real bundler | Bun; a resolution test. | #29 |
| **The MCP server connected to Claude Code or Claude Desktop** | The official SDK's client over stdio in tests, and spawned-process tests of `tula mcp`. The configuration snippets in [mcp.md](../mcp.md) were not tried in either client. | 1.16 |

## Deployment

| What | What was run instead | Where it was noted |
| --- | --- | --- |
| https with a certificate a browser trusts by itself, on a registrable domain; WebAuthn on such a domain | https was observed with a throwaway certificate on `*.localhost` names ([below](#verified-after-phase-1)), which Chromium treats as trustworthy on their own. | #27, #28 |
| A production-tier deployment with a real relay, `hibp` being called and `rediss://` | The packaged image booted with `ENVIRONMENT=staging` ([below](#verified-after-phase-1)), with Redis over plain `redis://`, Mailpit reached under another host name, and no password set, so Have I Been Pwned was never called. `prod` was not booted. | 1.17 |
| A real load balancer in front of several instances | The Compose stack's nginx on one machine (1.17). No instance was stopped or restarted during a run. | 1.17 |
| A transaction-mode pooler (PgBouncer) in front of Postgres, managed Postgres, Postgres versions other than 17, Redis other than 7, Redis failover | Not run. | #14 |
| `release.yml` on GitHub, and publishing anything | Never run; nothing is published. `bun run release:dry-run` only. | #20 |
| **Valkey** as the shared store | `REDIS_URL` accepts `valkey://` and `valkeys://` URLs, and no test or run has ever used a Valkey server: every Redis test and every live run was Redis 7. Not run on 2026-10-04 either: no Valkey image was on the machine and none was pulled. | whole-phase review |
| The CI workflow as changed by 1.17 (the `self-host` matrix and its `one-address` mode) | Its commands were run by hand on macOS against an isolated Compose project; the workflow itself has not run on GitHub. | 1.17 |
| The dashboard's last round of fixes on a live stack | `verify` and the browser tests. | #31 |

## Tests that exist but prove less than they seem

| What | Detail | Where it was noted |
| --- | --- | --- |
| The control-plane store's behaviour suite | It runs on PGlite only: it counts every workspace of the deployment, so it needs a database of its own. The other nine store suites now also run on a Postgres server ([below](#verified-after-phase-1)). | #31 |
| Tests written after the code | "Most server and core tests" of passkeys, and some step-up tests of the OAuth step, were not seen failing first. The review-fix tests were. | #25, #26 |
| A `verify` run that failed once with a missing bunup output for `@tula/nextjs` | It did not reproduce. | #28 |
| The conformance run behind one address | It needs two concessions that a real deployment does not make: the proxy passes the runner's `X-Forwarded-For` through, and the runner waits 6 seconds after each settings change ([why](../../conformance/README.md#behind-one-address)). | 1.17 |

## Verified after Phase 1

Run on 2026-10-04 on macOS (Docker Desktop, Postgres 17.11, Redis 7, Bun 1.4.2), against an
isolated Compose project (`docker compose -p tula-verify`, its own ports, a fresh
`TULA_MASTER_KEY` and `TULA_ADMIN_TOKEN` on the command line, the image built from this tree as
`tula-api:verify`). Each entry says what was run and what was seen, and nothing more.

### Found and fixed

- **On Next.js 15 the interceptor never refreshed a session, and a `stateful` session was never
  signed in on the server.** Next.js 15 runs `middleware.ts` in its Edge runtime, whose
  `Request`, built from another `Request`, keeps only the URL. `@tula/nextjs` sent every call to
  the API through such a copy, so in the middleware the refresh reached the API as
  `GET /v1/client/sessions/refresh` (404, seen in the API's log). Pages still looked signed in
  because the browser's client refreshed through the route handler; a request with only the
  refresh cookie was signed out for server components and route handlers. The repository's own
  `nextjs` browser specs, run against a Next.js 15.5.27 build of the example: 30 passed and 3
  failed before the fix, 33 passed after (1 skipped: the screenshots). Regression tests:
  `packages/nextjs/src/middleware.test.ts`, "where a Request built from a Request keeps only
  its URL". Next.js 16 was not affected.
- **The dashboard's 30-second test timeout never applied.** `apps/dashboard/bunfig.toml` set
  `timeout = 30000` under `[test]`, and the standards described it as the one package allowed
  a longer timeout. Bun 1.4.2 does not read that key: in a scratch directory a six-second test
  under it failed with "timed out after 5000ms", and passed with `bun test --timeout 30000`.
  So the package's tests always ran on the five-second default, and CI failed three tests of
  `src/environment-switch.test.tsx` at 5000 ms. The 30 seconds are now `--timeout 30000` in the
  package's `test` and `test:coverage` scripts and the key is gone; a harness test
  (`.claude/hooks/hooks.test.ts`) fails for any `bunfig.toml` that sets one and for a
  dashboard script without the flag. Seen afterwards: `bun run test:coverage` there, 142
  passed, and a `findByText` for text that is never rendered failed after 10 s with Testing
  Library's "Unable to find an element", where a bare `bun test` still says "timed out after
  5000ms". No other package had the key.

### Found, not fixed

- **`appUrl` given only as an option leaves `auth()` signed out over https behind a proxy that
  sends no `X-Forwarded-Proto`.** Next.js (15.5.27 and 16.3.8, `base-server.js`) adds
  `x-forwarded-proto` itself when the proxy sent none: `http`. So the third rule of
  `requestFromHeaders` (https when the request carries a `__Host-` cookie and there is no
  forwarded scheme) never applies under a real Next.js server: the header is never absent.
  Seen on Next.js 15 with `appUrl` passed to `tulaMiddleware` and `createTulaHandlers` and no
  `TULA_APP_URL`: the middleware let `/dashboard` through, the page's `auth()` read the
  unprefixed cookie names and redirected to `/sign-in`, which sent the signed-in browser back,
  without end. Setting `TULA_APP_URL`, or a proxy that sends `X-Forwarded-Proto`, avoids it
  (both seen working). Deciding whether a `__Host-` cookie should outrank a forwarded `http`
  is a change to how cookie names are chosen, so it was left for a decision.
- With neither `TULA_APP_URL` nor `X-Forwarded-Proto`, the route handler refuses every write
  with `request.origin_not_allowed` and nobody can sign in. That is the handler failing closed,
  but nothing on the server says why.
- Next.js 15 started with `-H 127.0.0.1` answers the interceptor's redirect with an absolute
  `Location` on `localhost:<port>` (it builds the middleware's URL from its own host name).
  With the default bind or `-H localhost` the `Location` is relative. This is Next.js, not the
  SDK; the SDK redirects with `request.nextUrl.clone()`.
- A Next.js 15 build warns that `jose` references `CompressionStream` (its JWE code, which the
  SDK never calls). The build and the middleware work.
- The `staging` tier refuses `mailpit`, `localhost` and `127.0.0.1` as the relay by host name
  only: the same Mailpit under its container name was accepted.

### What was run

| What | How | Result |
| --- | --- | --- |
| The integration tests on real servers | `bun run test:integration` with `DATABASE_URL`, `DATABASE_MIGRATION_URL` and `REDIS_TEST_URL` on the command line | The five files of Phase 1: 45 passed. With the two new files below: 247 passed (7 in `@tula/db`, 240 in `@tula/api`), on each of seven runs. |
| Nine store suites on a Postgres server | `apps/api/src/adapters/postgres/stores.integration.ts`: the user, session, factor, flow-attempt, passkey, verification-token, OAuth-provider, settings and activity suites over a pool of four connections as the runtime login | 195 passed. Nothing differed from PGlite. |
| `markEmailVerified(…, removePassword)` against a concurrent password set, two connections | `races.integration.ts`, 40 rounds a case, the first caller alternating | Every round ended in a documented outcome with matching audit entries: the address verified, the old password never kept, the new one kept only when it was set after the verification. Both orders occurred (11 to 24 of 40 rounds had the password set last, over three runs). |
| Two verifications, two authenticator enrolment starts, a start against a confirmation, two sign-ins at the session limit (with and without an oldest session to end), two connections each | the same file | 7 tests passed. With the user-row lock taken out of the session store's `create`, the unverified guard out of `markEmailVerified`, or the confirmed guard out of `startTotp`, the matching test failed. Taking the `FOR SHARE` out of `setPasswordHash` failed none: the credential row and the verification's own update already order the two. |
| https: the API's cookies | nginx (the pinned image) terminating TLS in front of both instances, `PUBLIC_URL=https://api.tula.localhost:54443`, a throwaway CA trusted with `curl --cacert` | `__Secure-tula_rt_<environment>` with `Secure; HttpOnly; SameSite=Lax; Path=/v1/client/sessions`; `__Secure-tula_dashboard` twice (`Path=/v1/instance`, `Path=/v1/admin`) with `Secure; HttpOnly; SameSite=Strict`. |
| https: the dashboard | Chromium (Playwright, trusting the certificate by its key hash, not `ignoreHTTPSErrors`) | Signed in with the admin token, opened Diagnostics and Users, signed out. No policy violation, no console error; the two cookies as above and none for `/dashboard/`. |
| https: the Next.js example (16.3.8), four arrangements | proxy with or without `X-Forwarded-Proto`, server with or without `TULA_APP_URL` | With either or both: redirect to sign-in, sign-up, a server component, a route handler and a server action see the session, the interceptor refreshes a request that has only the refresh cookie, sign-out, sign-in. Cookies `__Host-tula_at` and `__Host-tula_rt` (and the cleared `__Host-tula_session`): `Secure; HttpOnly; SameSite=Lax; Path=/`, no `Domain`. With neither: see above. |
| A passkey on an https origin | `passkeys.rpId: app.tula.localhost`, Chromium's virtual authenticator, on Next.js 16 and 15 | Registered from the profile and used to sign in. A physical authenticator and a registrable domain: still not. |
| The visitor's address through a proxy and Next.js | two containers with their own addresses, through nginx, the example with `TULA_TRUSTED_PROXY_HOPS`, the API with `TRUST_PROXY=true`; sign-in starts until refused | Hops 1: the first client got 30 answers and then 429 (`Retry-After: 59`), the second was answered 200 at that moment, also when it sent an `X-Forwarded-For` naming the first, and the first stayed at 429. Hops 0: after the first client's 30, the second got 429 at once. |
| A `staging` boot of the packaged image | `docker run` with `ENVIRONMENT=staging` on the isolated Postgres and Redis | With the local stack's settings it refused to start (exit 1), naming `OAUTH_MOCK_PROVIDER`, `SMTP_URL`, `MAIL_FROM`, `BREACH_CHECK`, `REDIS_URL` and `PUBLIC_URL`; with only the mock provider left on, that one. With an https `PUBLIC_URL`, a relay host name that is not Mailpit's, a real sender, `hibp` and `redis://`: `/v1/ready` 200 (`database` and `redis` ok), `/v1/docs` 404, `/v1/dev/oauth/authorize` 404, `/v1/openapi.json` 200, and the diagnostics all `ok` or `skipped`. |
| Next.js 15 and the Edge runtime | a copy of the example outside the repository on `next@15.5.27`, `middleware.ts`, the `@tula/*` packages installed from the tarballs of `bun run packages:check`, built and served by `next start` under Node | Every answer of the middleware carried a marker set from `typeof EdgeRuntime` (`edge-runtime`). After the fix above: the https journey and the repository's `nextjs` Playwright project (33 passed, 1 skipped). |
| React 18 | a copy of the repository with `react` and `react-dom` overridden to 18.3.1, `bun test` in `packages/react` | 420 passed. One describe cannot load there and was skipped: it imports `<Activity>`, which React 18 does not have. No test failed and React printed no warning. |
| The upgrade from Phase 0 | a database migrated to `0005` by the last Phase 0 commit (`055db6d`), filled through that commit's own API (its seed, four keys, its 10 conformance scenarios, two more sign-ups: 185 rows in 14 tables), then `bun run db:migrate` from this tree with the old API still running | 17 migrations applied. Every Phase 0 column of every row was byte-identical before and after. The Phase 0 API then passed its 10 scenarios on the new schema and completed a sign-in started before the migration. The current image on that database: diagnostics `ok` (the master key opens the two signing keys), both users signed in with their passwords, a wrong password was `auth.invalid_credentials`, a Phase 0 refresh token was rotated, an attempt started by the old version was `flow.not_found`, each environment's secret key listed only its own users (9 and 1), and as the runtime login a query without a tenant saw no user and an update across environments changed no row. The [upgrade notes](../self-host.md#upgrading) matched what happened. |

Not finished: the current conformance scenarios against the upgraded database. A first run was
spoiled by a second runner started by mistake on the same environment; the clean run had 408
steps passed and none failed when Docker Desktop restarted itself for an update and took the
database with it.

## Known trade-offs recorded by the whole-phase threat review

These are not gaps in testing. They are how Phase 1 behaves, on purpose or for now, and what
that costs.

- **Automatic linking trusts a provider's "verified" flag indefinitely.** If a provider hands
  an email address to a new person (a recycled address), that person's provider account is
  linked into the verified Tula account of whoever owns the address there.
- **Under `mfa.policy: required`, the first factor alone enrols the second.** Whoever holds
  only the password (or other first factor) of a user who has not enrolled yet enrols their
  own authenticator.
- **A passkey without an authenticator app does not count as a second factor for step-up.**
- **The per-identifier lockout is shared by the password and the emailed code.** Anyone who
  knows an address can keep it locked out of both.
- **The `verify` ceiling is one bucket per environment**, shared by all of its users.
- **The `local` tier accepts any loopback origin and any loopback redirect URL.**
- **GitHub sign-in has no PKCE.** The library's GitHub client does not send it, so a stolen
  authorization code is not bound to the attempt, unlike with Google.
- **Revoking a user's other sessions needs no recent authentication.**
- **The audit entry is an optional parameter of the store methods.** "Every change is
  recorded" is held by tests and review, not by the compiler. Deferred to Phase 2.
