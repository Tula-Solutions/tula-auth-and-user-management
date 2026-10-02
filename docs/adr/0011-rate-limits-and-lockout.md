# ADR 0011 — Rate limits and lockout

- Status: accepted
- Date: 2026-10-01

## Context

Auth endpoints are the part of an app attackers hammer: guessing passwords, flooding inboxes,
and burning CPU on password hashing. One kind of limit does not cover all of that. A per-IP
limit does nothing against a botnet; a per-account limit lets anyone inconvenience that account.

## Decision

Three layers, each answering `rate_limited` (429) with `params.retryAfter` and a `Retry-After`
header.

**1. Per IP** (`rateLimit` + `byIp`), counted before any key is resolved, so key guessing is
limited too.

| Where | Per minute |
| --- | --- |
| Every `/v1/client/*` route (shared bucket) | 600 |
| Every `/v1/admin/*` route (shared bucket) | 300 |
| Sign-up, resend code | 10 |
| Sign-in start, password, verify code | 30 |
| Refresh | 300 |
| Change my password | 10 |
| Public JWKS | 600 |

**2. Per environment**, across all callers, on steps that cost an argon2id hash or an email:
sign-up and resend 600, password 3,000, verify code 3,000 per minute. This bounds what a
distributed attack on one tenant can make the server do. The ceiling is counted **inside the
flow service**, after the request is validated and its attempt found and just before the
expensive work, so malformed requests and made-up attempt ids, which cost nothing, can't use it
up. Refresh has no ceiling:
every active user refreshes about once a minute, so one would throttle a large app in normal
use, and refresh tokens are 256-bit, so per-IP limits are enough.

**3. Per secret being guessed.**

- *Passwords* use the `Lockout` port with `CREDENTIAL_LOCKOUT`: 5 free tries, then each further
  failure imposes a wait of 30s, 1m, 2m… capped at 15 minutes, forgotten after an hour of quiet.
  Sign-in is keyed by environment + a hash of the identifier; changing your own password by
  environment + user id. An attacker gets 5 guesses at once, 5 more within the first 15 minutes
  and 4 an hour after that.
- The attempt is **counted as a failure before the password is compared and cleared on
  success**. Counting first is atomic, so parallel guesses can't all slip through while
  unlocked (at most free tries + 1 are answered). Only failures accumulate; a refused attempt
  is not counted, so retrying never extends a wait.
- Sign-in counts before looking the identifier up, so unknown identifiers lock out exactly like
  real ones and lockout reveals nothing about which accounts exist.
- *Verification codes* have their own counter: 5 guesses per code, and sends are limited to one
  a minute and five an hour per address (ADR 0007).
- *API keys and refresh tokens* are 256-bit; they need no per-secret limit.

## Consequences

- **Lockout is a lever for annoyance.** Someone who knows an email can fail on purpose and make
  that address wait (up to 15 minutes at a time) before signing in with a password. The
  alternative, limiting only per IP, gives a botnet unlimited guesses. Backoff keeps the first
  waits short, and only wrong guesses count, so a user who knows their password is delayed, not
  blocked. Keying by identifier *and* IP, or a CAPTCHA step, can soften this later.
- **A per-environment ceiling can be hit by an attack**, at which point real users of that
  environment are throttled on that step too. That is the intended trade: one tenant's attack
  must not take the server down for every tenant.
- **All of it is in process memory in Phase 0.** With several API instances each counts
  separately, which multiplies every limit by the instance count, and a restart forgets
  lockouts. The Redis adapters (Phase 1) fix both; the ports are already in place.
- Limits are constants in code for now; per-project configuration arrives with the dashboard.
