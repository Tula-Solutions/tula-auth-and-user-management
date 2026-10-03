# Conformance scenarios

Language-neutral descriptions of what a Tula server must do, as sequences of HTTP exchanges.
The same files are run:

- **in process**, by the API's own tests (`apps/api/src/conformance.test.ts`, part of
  `bun run verify`), against memory adapters and a controllable clock (the second instance is a
  second app over the same stores);
- **against a live server**, with `bun run conformance`;
- later, by each SDK's test suite (TypeScript, Swift, Kotlin), so every client is checked
  against the same behaviour.

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
audit entries, and leaves them there. A full run takes about two and a half minutes, most of it
waiting: 61 seconds for an address's email cooldown (twice), 11 for the refresh grace period
and 6 for a settings change to reach the second instance.

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
- **Capture.** `capture: { "variable": "dot.path" }` stores a string from the response body.
  `captureHeaders: { "variable": "ETag" }` stores a response header. `captureJson:
  { "variable": "dot.path" }` stores any value, objects included, as JSON text; a later body
  sends it back with `{ "$json": "{{variable}}" }` in place of the value.
- **Email steps** read the 6-digit code from the newest email to an address. `captureWrong`
  also stores a code that is guaranteed not to be the right one. Right after a resend the
  newest email can still be the previous one; no scenario resends yet.
- **Wait steps** let time pass: a real sleep against a live server, a clock advance in process.

Steps run in order and a scenario stops at its first failing step.

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

Scenarios assume the default settings (the `recommended` password policy and the default
session profile). `12-environment-settings` changes the environment's settings while it runs
(the app name, and a 14-character minimum password that every generated password still meets)
and puts the original document back in its last steps; if it fails before that, the changed
settings stay until you restore them with `PUT /v1/admin/settings`. An environment that had
never saved settings ends the run with a saved copy of its defaults (the same behaviour, but
`PASSWORD_POLICY` and `CORS_ORIGINS` no longer apply to it). Browser cookie delivery is not covered yet; scenarios use a native client
kind so tokens arrive in the response body. For the same reason the origin rule for browser
attempts (`request.origin_not_allowed`) is covered by the API's own tests, not by a scenario:
which origins a deployment allows is not something a scenario can assume. `needs_first_factor`
and `needs_second_factor` cannot be reached over HTTP until a second sign-in method or factor
exists (steps 1.7 and 1.8).

## Adding a scenario

1. Add `scenarios/NN-name.json` and list its name in `apps/api/src/conformance.test.ts`.
2. `bun test apps/api/src/conformance.test.ts` runs it in process.
3. If you changed the format itself, run `bun run --filter @tula/conformance schema:generate`.
