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
| **GitHub accepting and enforcing PKCE** (`code_challenge`, `code_verifier`) | Unit tests of the two requests the adapter builds, and the mock provider, which refuses another verifier. That github.com rejects a wrong or missing verifier is from its documentation. | Phase 1 deferred items |
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
| **Next.js 15 and its Edge runtime** (`middleware.ts`) | Next.js 16 only (`proxy.ts`, Node.js runtime). Edge safety is a static check that the middleware imports no Node API. | #28 |
| React 18 (the peer range allows it) | React 19 only. | #21 |
| Browsers other than Chromium: Safari, Firefox, mobile browsers. Includes the backup-code download, WebAuthn autofill and third-party-cookie behaviour. | Chromium in Playwright. | #20, #21, #24 |
| A real screen reader | axe on every screen, in light and dark, with no rule disabled. | #21 |
| `@tula/core` on edge runtimes and in Node | Type and bundle checks; tests run under Bun. | #20 |
| `@tula/config`'s `loadConfig` under Node; `@tula/admin`'s `browser` export condition under a real bundler | Bun; a resolution test. | #29 |
| **The MCP server connected to Claude Code or Claude Desktop** | The official SDK's client over stdio in tests, and spawned-process tests of `tula mcp`. The configuration snippets in [mcp.md](../mcp.md) were not tried in either client. | 1.16 |

## Deployment

| What | What was run instead | Where it was noted |
| --- | --- | --- |
| https anywhere: `Secure` and `__Host-`/`__Secure-` cookie names, the dashboard's cookie over https, WebAuthn outside `localhost` | Unit tests of the cookie lines; every live run was http on `localhost`. | #27, #28 |
| A production-tier boot (`ENVIRONMENT=staging` or `prod`) with a real relay, `hibp` and `rediss://` | The environment schema's tests. | 1.17 |
| The visitor's address reaching the API's rate limiter through a Next.js server and a proxy (`TULA_TRUSTED_PROXY_HOPS` with `TRUST_PROXY`) | Unit tests on both sides; not observed live. | #28 |
| A real load balancer in front of several instances | The Compose stack's nginx on one machine (1.17). No instance was stopped or restarted during a run. | 1.17 |
| A transaction-mode pooler (PgBouncer) in front of Postgres, managed Postgres, Postgres versions other than 17, Redis other than 7, Redis failover | Not run. | #14 |
| `release.yml` on GitHub, and publishing anything | Never run; nothing is published. `bun run release:dry-run` only. | #20 |
| **Valkey** as the shared store | `REDIS_URL` accepts `valkey://` and `valkeys://` URLs, and no test or run has ever used a Valkey server: every Redis test and every live run was Redis 7. | whole-phase review |
| The CI workflow as changed by 1.17 (the `self-host` matrix and its `one-address` mode) | Its commands were run by hand on macOS against an isolated Compose project; the workflow itself has not run on GitHub. | 1.17 |
| The dashboard's last round of fixes on a live stack | `verify` and the browser tests. | #31 |
| An upgrade of a database with real data across migrations `0006` to `0016` | Migrations are applied to an empty database in every run; the upgrade notes in [self-host.md](../self-host.md#upgrading) are written from the SQL. | 1.17 |

## Tests that exist but prove less than they seem

| What | Detail | Where it was noted |
| --- | --- | --- |
| The Postgres stores' behaviour suites | They run on PGlite in `bun test`, not on a Postgres server. The five `*.integration.ts` files (row-level security, advisory locks, the job and environment locks, the Redis adapters) are the only tests on real servers. 1.17 ran all five (45 tests) against Postgres 17 and Redis 7. | #25, #27, #29, #31 |
| The race-safe TOTP enrolment start, and the concurrent-session limit's lost-race fix | Tested on the memory adapter and PGlite; not with two real Postgres connections. | #24, #27 |
| Tests written after the code | "Most server and core tests" of passkeys, and some step-up tests of the OAuth step, were not seen failing first. The review-fix tests were. | #25, #26 |
| A `verify` run that failed once with a missing bunup output for `@tula/nextjs` | It did not reproduce. | #28 |
| The conformance run behind one address | It needs two concessions that a real deployment does not make: the proxy passes the runner's `X-Forwarded-For` through, and the runner waits 6 seconds after each settings change ([why](../../conformance/README.md#behind-one-address)). | 1.17 |

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
