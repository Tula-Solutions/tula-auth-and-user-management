# Conformance scenarios

Language-neutral descriptions of what a Tula server must do, as sequences of HTTP exchanges.
The same files are run:

- **in process**, by the API's own tests (`apps/api/src/conformance.test.ts`, part of
  `bun run verify`), against memory adapters and a controllable clock (the second instance is a
  second app over the same stores);
- **against a live server**, with `bun run conformance`;
- later, by each native SDK's test suite (Swift, Kotlin), so every client is checked against
  the same behaviour.

The TypeScript SDK does not run the JSON files: they describe HTTP exchanges, which
`@tula/core` exists to hide. Instead `apps/api/src/sdk-journeys.test.ts` drives the SDK's
public API against the same in-process server, and a guard there requires every scenario in
`scenarios/` to be covered by a named journey or listed as server-only with the reason
([ADR 0021](../docs/adr/0021-core-sdk.md)). **Adding a scenario means adding its journey.**

## Running against a live server

The server has to run with `TRUST_PROXY=true` (each scenario presents its own client address in
`X-Forwarded-For`, so per-IP limits don't couple scenarios) and has to send mail to a
[Mailpit](https://mailpit.axllent.org) the runner can read. `docker compose up -d` provides both
Postgres and Mailpit.

```bash
CONFORMANCE_PUBLISHABLE_KEY=tula_pk_dev_… \
CONFORMANCE_SECRET_KEY=tula_sk_dev_… \
bun run conformance
```

| Variable | Default | |
| --- | --- | --- |
| `CONFORMANCE_PUBLISHABLE_KEY` | required | A publishable key of the environment under test. |
| `CONFORMANCE_SECRET_KEY` | none | A secret key of the same environment. Without it, scenarios marked `needsSecretKey` are skipped. |
| `CONFORMANCE_BASE_URL` | `http://localhost:3003` | Origin of the API. |
| `CONFORMANCE_MAILPIT_URL` | `http://localhost:8025` | Mailpit's web address. |
| `CONFORMANCE_SECOND_BASE_URL` | none | Origin of a second instance of the same deployment (same database, Redis and keys), e.g. `http://localhost:3004` for the packaged stack. Steps marked `"instance": "second"` go there. Without it they go to `CONFORMANCE_BASE_URL`, and the run's last line says `(one instance)`. |

Use a development environment: every run creates users (with `@example.com` addresses) and
audit entries, and leaves them there. A full run takes about seven minutes, most of
it waiting: 61 seconds for an address's email cooldown (four times), 30 for an authenticator to
move to its next code (twice), 11 for the refresh grace period and 6 for a settings change to
reach the second instance. The runner computes authenticator codes from its own clock, so it
must agree with the server's to within a 30-second step.

The exit code is 0 when at least one scenario passed and none failed. A failing step prints the
status, the error code and short plain values that differed. Tokens, long strings, objects and
arrays are described (`a string of 52 characters`), never quoted, and a value the scenario
generated or captured appears as its placeholder (`{{password}}`), because the output ends up
in CI logs.

## Scenario format

A scenario is one JSON file in `scenarios/`, validated against
[`scenario.schema.json`](scenario.schema.json) (generated from
`packages/conformance/src/scenario.ts`; do not edit it by hand). The JSON Schema describes the
shape only. The loader also enforces three rules it cannot express: a scenario with an
`auth: "secret"` step must set `needsSecretKey: true`, such a request cannot also carry an
`accessToken`, and `headers` cannot name a header the runner sets itself (`x-tula-attempt`
included: use `attempt`).

```json
{
  "name": "sign-out",
  "description": "What the scenario shows, in a sentence.",
  "variables": { "email": { "generate": "email" }, "password": { "generate": "password" } },
  "steps": [
    {
      "name": "start a sign-up",
      "request": {
        "method": "POST",
        "path": "/v1/client/sign-ups",
        "client": "ios",
        "body": { "email": "{{email}}", "password": "{{password}}" }
      },
      "expect": { "status": 200, "body": { "step": { "status": "needs_email_verification" } } },
      "capture": { "signUpId": "id", "signUpSecret": "attemptSecret" }
    },
    { "name": "read the emailed code", "emailCode": { "to": "{{email}}", "capture": "code" } },
    {
      "name": "verify the address",
      "request": {
        "method": "POST",
        "path": "/v1/client/sign-ups/{{signUpId}}/verify-email",
        "attempt": "{{signUpSecret}}",
        "body": { "code": "{{code}}" }
      },
      "expect": { "status": 200, "body": { "step": { "status": "complete" } } }
    },
    { "name": "let the grace period pass", "wait": "11s" }
  ]
}
```

- **Variables.** `{{name}}` in any string is replaced by a variable: a literal from `variables`,
  a generated value (`email`: a unique address; `password`: a long random password that passes
  every built-in policy), or a value an earlier step captured.
- **Request steps.** `auth` is `publishable` (the default), `secret` or `none`; `accessToken`
  adds `Authorization: Bearer …`; `client` sets `x-tula-client`; `attempt` sets
  `x-tula-attempt`, the secret of the attempt the request continues (capture `attemptSecret`
  from the step that starts the attempt and send `"attempt": "{{signInSecret}}"` on every later
  call for it; without it the server answers `flow.not_found`). `headers` adds any other
  header (`{ "If-Match": "{{etag}}" }`); the ones the runner sets itself cannot be replaced.
  `times` repeats the request.
  `instance` is `first` (the default) or `second`: which API instance of the deployment gets
  the request. A runner with only one instance sends both to it, so a scenario that uses
  `second` must also be true of a single server.
- **Expectations.** `status` must match exactly. `body` is matched as a subset: keys you leave
  out are not checked. Values compare literally, except `"$any"` (present and not null),
  `"$absent"` (missing or null), `{ "$not": value }` and `{ "$matches": "regex" }` (both need
  the value to be present). `bodyExcludes` lists strings the raw response must not contain.
  `claims` checks what a JWT in the body says: each key is the dot path of a token, each value
  is matched like `body` (a subset, with the same matchers) against the token's decoded payload:
  `"claims": { "session.accessToken": { "amr": { "$set": ["pwd", "otp", "mfa"] }, "auth_time": "$any" } }`.
  `{ "$set": [...] }` matches an array with exactly those members **in any order**: `amr` is a
  set, and its order is not part of the contract.
  The signature is not verified; an array, as everywhere, must match item by item.
- **Capture.** `capture: { "variable": "dot.path" }` stores a string from the response body;
  a path can index an array (`codes[0]`).
  `captureHeaders: { "variable": "ETag" }` stores a response header. `captureJson:
  { "variable": "dot.path" }` stores any value, objects included, as JSON text; a later body
  sends it back with `{ "$json": "{{variable}}" }` in place of the value.
- **Email steps** read the 6-digit code from the newest email to an address. `captureWrong`
  also stores a code that is guaranteed not to be the right one. Right after a resend the
  newest email can still be the previous one; no scenario resends yet.
- **Email-link steps** (`emailLink: { to, captureToken, captureAttempt?, url? }`) read the
  sign-in link from the newest email to an address that carries a code, and take it apart as
  the page it leads to does: the link token and the attempt id come from the URL's **fragment**
  (`#tula_link=…&tula_attempt=…`). `url`, when given, is what the link must be without its
  fragment, exactly: it shows that the link leads to the redirect URL that was asked for and
  has nothing in its query. Against a live server the link is read from Mailpit (the one
  message is fetched, since a link is not in a subject). A runner for another language needs a
  way to read an email's text to run these steps.
- **TOTP steps** (`totp: { secret, capture, captureWrong? }`) compute the 6-digit code an
  authenticator app shows **now** for a Base32 secret the API returned (RFC 6238: HMAC-SHA-1,
  30-second steps), e.g. `{ "name": "compute the code", "totp": { "secret": "{{secret}}",
  "capture": "code", "captureWrong": "wrongCode" } }`. "Now" is the wall clock against a live
  server and the test clock in process (the clock `wait` steps advance; a `Target` gives it as
  `now`). `captureWrong` also stores a code that is not the right one for the current step or
  the two either side. A server accepts a step's code once, the code that confirms an enrolment
  included, so a second use of the same secret needs a `wait` of `30s` before its `totp` step.
- **Wait steps** let time pass: a real sleep against a live server, a clock advance in process.
- **`cleanup`** (optional, beside `steps`) lists steps that run after the scenario's steps
  **whether or not they passed**, with whatever was captured before the failure. A scenario
  that changes the environment's settings puts them back there, so a failure half-way cannot
  break the scenarios after it. A cleanup step that fails fails the scenario.

Steps run in order and a scenario stops at its first failing step (its cleanup still runs).

## What is covered

| File | Shows |
| --- | --- |
| `01-sign-up` | The account is created only when the emailed code is verified. |
| `02-sign-in` | A wrong password and an unknown address get the same status, code and message. Timing is not compared. |
| `03-refresh-rotation-and-reuse` | Single-use refresh tokens, the grace period, reuse revoking the session. |
| `04-sign-out` | Sign-out ends the refresh token and the unexpired access token. |
| `05-password-policy` | The published policy and stable `password.*` errors. |
| `06-lockout` | Backoff after repeated wrong passwords, identical for an address with no account. |
| `07-admin-ban-and-audit` | Ban (a banned user with the right password is told so), unban, and an audit log without email addresses (needs a secret key). |
| `08-sign-up-existing-address` | Signing up with a taken address looks the same and changes nothing about the account. (That no usable code is sent for it is covered by the API's own tests; the runner cannot assert an email's absence.) |
| `09-verification-attempts` | A code dies after five wrong guesses. |
| `10-password-reset` | A forgotten password is replaced with an emailed code, and the old sessions end. |
| `11-two-instances` | Two instances behave as one server: a token from one is accepted by the other, a sign-out on one is refused by the other at once, and wrong passwords sent to either share one lockout. |
| `12-environment-settings` | Settings are replaced through the admin API, guarded by `If-Match` (428 without it, 412 when stale); the new password policy is enforced at sign-up and shown by `/v1/client/config` on both instances; the audit entry lists keys, not values (needs a secret key). |
| `13-attempt-binding` | An attempt id alone does nothing: a call without the attempt's secret, with a wrong one or with another attempt's is answered exactly like an unknown attempt and uses up nothing; the right secret then completes it, and no later response repeats the secret. |
| `14-email-code-sign-in` | With the email code enabled, a sign-in offers it whatever the address; asking for a code answers the same for an address with and without an account (and is rate limited the same); a wrong code is refused with the guesses left; a password-reset code is not a sign-in code; the right code signs in and proves the address; a user with no password gets the generic failure for any password (needs a secret key). |
| `15-email-link-sign-in` | A link leads only to an allowed redirect URL, matched exactly, with its token in the fragment; without the asking client's binding it is refused and not used up; with it, it is accepted and returns no tokens; only the client holding the attempt's secret completes; a used link is dead; an address with no account looks the same (needs a secret key). |
| `16-passwordless-sign-up` | A sign-up without a password is a validation error where one is required; where it is optional the account is created without one, signs in with an emailed code and never with a password; a sign-up that chooses a password works as before (needs a secret key). |
| `17-mfa-enrolment-and-sign-in` | A user enrols an authenticator: the secret and `otpauth://` URI are returned once, an unconfirmed enrolment counts for nothing, a wrong code does not confirm it, the right one returns ten backup codes. The password alone then yields `needs_second_factor` and no tokens; the authenticator's code completes, and the access token's `amr` is `pwd`, `otp`, `mfa`. |
| `18-mfa-lockout` | Six wrong second-factor codes are checked; after that every try is `rate_limited` with `Retry-After`, a correct backup code and a new sign-in attempt included: one count per user for both methods. |
| `19-mfa-code-replay` | An authenticator code is accepted once: the code that confirmed the enrolment does not sign in, the next step's code does, and it is refused on a second attempt. |
| `20-mfa-backup-codes` | A backup code completes a sign-in once (typed with spaces around it) and says how many are left; used again it is refused; a new set replaces the old codes. |
| `21-mfa-password-reset` | A password reset stops at `needs_second_factor` with no tokens, completes with the authenticator's code, ends the old sessions and keeps the factor. |
| `22-step-up` | A user without a factor steps up with the password (a fresh access token, no refresh token). With a factor, a token that does not say it was proven is refused on sensitive actions with `auth.step_up_required` and `params.methods`; the password alone does not step up, a backup code does, and the repeated action succeeds. |
| `23-mfa-admin-reset` | An operator removes a user's second factor: the user's access and refresh tokens are refused at once, and the next sign-in completes with the password alone (needs a secret key). |
| `24-mfa-required-policy` | Under `mfa.policy: required` a sign-in and a sign-up of a user without a factor stop at `needs_factor_enrolment`, enrol inside the attempt and complete with tokens and ten backup codes; the factor cannot be turned off (`mfa.required_by_policy`); the next sign-in asks for it (needs a secret key). |
| `25-oauth-sign-up-and-sign-in` | A sign-in through an OAuth provider: the start answers the provider's URL and a binding; the callback's state works once and hands the page a single-use, 60-second ticket in the fragment, never a token; the ticket is exchanged only with the starting browser's binding. A verified provider address creates an account and signs the same user in afterwards; an unverified one is refused (needs a secret key and the mock provider). |
| `26-oauth-account-linking` | Which account a provider identity signs in to: connected automatically only when both the provider's and the account's address are verified (`oauth.account_exists` otherwise); a signed-in user connects one from their profile unless it belongs to someone else; disconnecting the last way to sign in is refused (needs a secret key and the mock provider). |
| `27-oauth-second-factor` | A provider is a first factor: for a user with an authenticator the ticket exchange answers `needs_second_factor`, no tokens and a fresh attempt secret; the session exists only once the second factor is proven, and its `amr` names both (needs a secret key and the mock provider). |
| `28-step-up-email-code` | A user with no password and no second factor steps up with a 6-digit code emailed on request: the receipt never holds the code; asking again within a minute is `rate_limited`; a wrong code and a method the user does not have are refused; the right code returns a fresh access token (no refresh token) whose `amr` gains `email`, and works once. With a second factor, asking for a code and presenting one both answer `auth.step_up_required` naming the factor (needs a secret key and the mock provider). |

Scenarios assume the default settings (the `recommended` password policy and the default
session profile). `12-environment-settings` changes the environment's settings while it runs
(the app name, and a 14-character minimum password that every generated password still meets)
and puts the original document back in its last steps; if it fails before that, the changed
settings stay until you restore them with `PUT /v1/admin/settings`. Scenarios 14 to 16 enable
the email methods (and, in 16, an optional sign-up password) and 24 requires two-step
verification; each restores the original document in `cleanup` steps, which run even when a
step fails. The other two-step scenarios (17 to 23) assume the default `mfa.policy`, `optional`. An environment that had
never saved settings ends the run with a saved copy of its defaults (the same behaviour, but
`PASSWORD_POLICY` and `CORS_ORIGINS` no longer apply to it). Browser cookie delivery is not covered yet; scenarios use a native client
kind so tokens arrive in the response body. For the same reason the origin rule for browser
attempts (`request.origin_not_allowed`) is covered by the API's own tests, not by a scenario:
which origins a deployment allows is not something a scenario can assume. That a session older
than ten minutes is asked to step up is covered by the API's own tests, not by a scenario: a
live run would have to wait those ten minutes. `22-step-up` shows the same refusal through a
token that lacks the second factor. A backup code typed in another case or with a space for
its dash is covered there too; a scenario can only add spaces around a captured value. The email-link scenario
uses the redirect URL `https://app.conformance.example/auth/link`, which it adds to the
allow-list itself; nothing is ever fetched from it. That an address with no account is sent a
notice with no code and no link is covered by the API's own tests: the runner cannot assert
what an email does not contain.

### OAuth scenarios need the mock provider

Scenarios 25 to 28 sign in through an OAuth provider (28 to get a user with no password). They use the server's **mock provider**:
start the server with `OAUTH_MOCK_PROVIDER=true` (accepted only with `ENVIRONMENT=local`). An
`oauth` step plays the user at the provider: it posts the consent form to the path of the
`authorizationUrl` a start answered (`email`, `subject`, `unverified`, `deny`), calls the
callback the answer redirects to, and reads the ticket (`captureTicket`, `captureAttempt`) or
the error (`expectError`) from the fragment of the URL the callback redirects to. Nothing is
followed automatically, and every request goes to the target's base URL. `captureCallback`
keeps the callback's path so a later step can replay it (`callback`). The scenarios set the
`google` provider's credentials at the start and remove them in `cleanup`: do not run them
against an environment whose Google credentials you want to keep. They add about 95 seconds
(a 61-second wait for a ticket to expire and a 31-second one for the next authenticator code).

## Adding a scenario

1. Add `scenarios/NN-name.json` and list its name in `apps/api/src/conformance.test.ts`.
2. `bun test apps/api/src/conformance.test.ts` runs it in process.
3. If you changed the format itself, run `bun run --filter @tula/conformance schema:generate`.
