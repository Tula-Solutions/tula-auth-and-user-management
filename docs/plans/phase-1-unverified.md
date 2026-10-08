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
| **That Apple's authorization server offers no PKCE** | Not a test against Apple. Taken from `arctic` 3.7.0's Apple client, which sends none, and from Apple's discovery document (`appleid.apple.com/.well-known/openid-configuration`) as fetched on 2026-10-04, which lists no `code_challenge_methods_supported`. Apple sign-in therefore sends no PKCE and relies on the `nonce` in the signed ID token, the single-use `state` and the client-secret JWT to bind a code to its attempt. | Phase 1 deferred items |
| **GitHub accepting and enforcing PKCE** (`code_challenge`, `code_verifier`) | Unit tests of the two requests the adapter builds, and the mock provider, which refuses another verifier. That github.com rejects a wrong or missing verifier is from its documentation. What it does with a verifier sent for a code that was asked for without a challenge (an attempt started before the upgrade and finished after it) is not known: at worst that sign-in fails once ([ADR 0026](../adr/0026-oauth.md)). | Phase 1 deferred items |
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
- **`appUrl` given only as an option left `auth()` signed out over https behind a proxy that
  sends no `X-Forwarded-Proto`.** Next.js (15.5.27 and 16.3.8, `base-server.js`) adds
  `x-forwarded-proto` itself when the proxy sent none: `http`. So the third rule of
  `requestFromHeaders` (https when the request carries a `__Host-` cookie and there is no
  forwarded scheme) never applied under a real Next.js server: the header is never absent.
  Seen on Next.js 15 with `appUrl` passed to `tulaMiddleware` and `createTulaHandlers` and no
  `TULA_APP_URL`: the middleware let `/dashboard` through, the page's `auth()` read the
  unprefixed cookie names and redirected to `/sign-in`, which sent the signed-in browser back,
  without end. Decided and changed: with no app URL, one of the SDK's `__Host-` cookies on the
  request means https even where the forwarded scheme says `http`, and the interceptor, the
  handler and `auth()` choose cookie names in one function
  ([ADR 0029](../adr/0029-nextjs-sdk.md), "The scheme cookies are read under"). The tests of
  this now use the header sets Next.js produces. A review then found what the rule left
  behind on `localhost`, where cookies are shared across ports: plain-named cookies of an
  earlier http sign-in, read again once the `__Host-` ones were cleared, so that a session
  came back after a sign-out. Where the cookie rule chose the names, an answer that sets or
  clears a cookie now expires the plain-named ones too (handler and interceptor).
  **Both verified by unit tests only**: the https arrangement that found the first has not
  been run again with either change, and the second was never seen in a browser.
- **With neither `TULA_APP_URL` nor `X-Forwarded-Proto`, the route handler refused every write
  with `request.origin_not_allowed` and nothing on the server said why.** It still refuses
  (that is the handler failing closed: the app's origin never follows a cookie), and now
  reports the likely cause once through `onWarning`. Also unit tests only.

### Found, not fixed

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
| The integration tests on real servers | `bun run test:integration` with `DATABASE_URL`, `DATABASE_MIGRATION_URL` and `REDIS_TEST_URL` on the command line | The five files of Phase 1: 45 passed. With the two new files below: 247 passed (7 in `@tula/db`, 240 in `@tula/api`), on each of seven runs, and again after the race tests were rewritten (below), on a second isolated project (`tula-verify2`). |
| Nine store suites on a Postgres server | `apps/api/src/adapters/postgres/stores.integration.ts`: the user, session, factor, flow-attempt, passkey, verification-token, OAuth-provider, settings and activity suites over a pool of four connections as the runtime login | 195 passed: the same suites that pass on PGlite. That is the whole claim, not that the two runs are equivalent. Here the nine suites share two tenants across all of them in one file; in process each suite's file makes its own two. So a suite here also runs among the other suites' rows, and a failure that needed a clean tenant, or one that only another suite's leftovers cause, would show in one arrangement and not in the other. No comparison finer than pass or fail was made. |
| `markEmailVerified(…, removePassword)` against a concurrent password set, two connections and a third that holds the lock | `races.integration.ts`, 40 rounds a case. Each round a third session locks the user's row, the two calls are started one after the other, **both are seen waiting on that lock** (`pg_locks`, at most five seconds), and it is released. The call started first runs first, and the rounds alternate which that is | The tests no longer count what happened to occur; they assert the outcome for the order they arranged, with its audit entries. Verification first (20 rounds): the old password is removed, the new one is stored after it and stays. Password first (20 rounds): it replaces the old one and the verification removes it. On an account without a password: verification first removes nothing and the password stays; password first, the verification removes it. A round in which either call did not wait fails. |
| Two verifications, two authenticator enrolment starts, a start against a confirmation, two sign-ins at the session limit (with and without an oldest session to end), two connections each | the same file and the same technique: the user's row for the verifications and the sign-ins, the pending factor's row for the start against the confirmation. Two starts have no row to wait on, so the third session holds the key they collide on (a start of its own that is rolled back), which lets both go at once | 7 tests passed, on each of 22 runs. Asserted per arranged order: the verification that ran first removes the password and the other changes nothing; the confirmation that ran first makes the start refuse, and the start that ran first leaves nothing to confirm and no backup code; the sign-in that ran first takes the place. For the two starts either may be the one left, and the test requires that each was, at least once in its 40 rounds (seen: 11 to 20 of 40 for the first instance's). |
| That those tests can fail | each change made alone, the file run, the change undone | With the two calls run one after the other instead of held: all 7 failed ("expected 2 session(s) waiting on the held lock, saw 0"). Without the user-row lock (`FOR UPDATE`) in the session store's `create`: "with one place left" failed (both sign-ins got a session). Without the unverified guard in `markEmailVerified`: "of two verifications" failed. Without the confirmed guard in `startTotp`: "a start that meets a confirmation" failed. Without the `FOR SHARE` in `setPasswordHash`: both password tests failed. The earlier version of these tests failed for none of that last change, and this page said the lock was not needed for the ordering. It is: without it, on an account with no password, a password stored while the address was being verified was kept (`passwordRemoved: false`); with a password already there, the call did not wait at all. |
| https: the API's cookies | nginx (the pinned image) terminating TLS in front of both instances, `PUBLIC_URL=https://api.tula.localhost:54443`, a throwaway CA trusted with `curl --cacert` | `__Secure-tula_rt_<environment>` with `Secure; HttpOnly; SameSite=Lax; Path=/v1/client/sessions`; `__Secure-tula_dashboard` twice (`Path=/v1/instance`, `Path=/v1/admin`) with `Secure; HttpOnly; SameSite=Strict`. |
| https: the dashboard | Chromium (Playwright, trusting the certificate by its key hash, not `ignoreHTTPSErrors`) | Signed in with the admin token, opened Diagnostics and Users, signed out. No policy violation, no console error; the two cookies as above and none for `/dashboard/`. |
| https: the Next.js example (16.3.8), four arrangements | proxy with or without `X-Forwarded-Proto`, server with or without `TULA_APP_URL` | With either or both: redirect to sign-in, sign-up, a server component, a route handler and a server action see the session, the interceptor refreshes a request that has only the refresh cookie, sign-out, sign-in. Cookies `__Host-tula_at` and `__Host-tula_rt` (and the cleared `__Host-tula_session`): `Secure; HttpOnly; SameSite=Lax; Path=/`, no `Domain`. With neither: see above. |
| A passkey on an https origin | `passkeys.rpId: app.tula.localhost`, Chromium's virtual authenticator, on Next.js 16 and 15 | Registered from the profile and used to sign in. A physical authenticator and a registrable domain: still not. |
| The visitor's address through a proxy and Next.js | two containers with their own addresses, through nginx, the example with `TULA_TRUSTED_PROXY_HOPS`, the API with `TRUST_PROXY=true`; sign-in starts until refused | Hops 1: the first client got 30 answers and then 429 (`Retry-After: 59`), the second was answered 200 at that moment, also when it sent an `X-Forwarded-For` naming the first, and the first stayed at 429. Hops 0: after the first client's 30, the second got 429 at once. |
| A `staging` boot of the packaged image | `docker run` with `ENVIRONMENT=staging` on the isolated Postgres and Redis | With the local stack's settings it refused to start (exit 1), naming `OAUTH_MOCK_PROVIDER`, `SMTP_URL`, `MAIL_FROM`, `BREACH_CHECK`, `REDIS_URL` and `PUBLIC_URL`; with only the mock provider left on, that one. With an https `PUBLIC_URL`, a relay host name that is not Mailpit's, a real sender, `hibp` and `redis://`: `/v1/ready` 200 (`database` and `redis` ok), `/v1/docs` 404, `/v1/dev/oauth/authorize` 404, `/v1/openapi.json` 200, and the diagnostics all `ok` or `skipped`. |
| Next.js 15 and the Edge runtime | a copy of the example outside the repository on `next@15.5.27`, `middleware.ts`, the `@tula/*` packages installed from the tarballs of `bun run packages:check`, built and served by `next start` under Node | Every answer of the middleware carried a marker set from `typeof EdgeRuntime` (`edge-runtime`). After the fix above: the https journey and the repository's `nextjs` Playwright project (33 passed, 1 skipped). Both runs were of the code with that fix and **before** the cookie-scheme change (a `__Host-` cookie outranking a forwarded `http`, and the plain-named cookies expiring with it): since that change only unit tests have run, on either version of Next.js. |
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
- **Revoking a user's other sessions needs no recent authentication.**
