# Conformance scenarios

Language-neutral descriptions of what a Tula server must do, as sequences of HTTP exchanges.
The same files are run:

- **in process**, by the API's own tests (`apps/api/src/conformance.test.ts`, part of
  `bun run verify`), against memory adapters and a controllable clock;
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

Use a development environment: every run creates users (with `@example.com` addresses) and
audit entries, and leaves them there. A full run takes about 15 seconds, most of it the wait
for the refresh grace period to pass.

The exit code is 0 when at least one scenario passed and none failed. A failing step prints the
status, the error code and short plain values that differed. Tokens, long strings, objects and
arrays are described (`a string of 52 characters`), never quoted, and a value the scenario
generated or captured appears as its placeholder (`{{password}}`), because the output ends up
in CI logs.

## Scenario format

A scenario is one JSON file in `scenarios/`, validated against
[`scenario.schema.json`](scenario.schema.json) (generated from
`packages/conformance/src/scenario.ts`; do not edit it by hand). The JSON Schema describes the
shape only. The loader also enforces two rules it cannot express: a scenario with an
`auth: "secret"` step must set `needsSecretKey: true`, and such a request cannot also carry an
`accessToken`.

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
      "capture": { "signUpId": "id" }
    },
    { "name": "read the emailed code", "emailCode": { "to": "{{email}}", "capture": "code" } },
    { "name": "let the grace period pass", "wait": "11s" }
  ]
}
```

- **Variables.** `{{name}}` in any string is replaced by a variable: a literal from `variables`,
  a generated value (`email`: a unique address; `password`: a long random password that passes
  every built-in policy), or a value an earlier step captured.
- **Request steps.** `auth` is `publishable` (the default), `secret` or `none`; `accessToken`
  adds `Authorization: Bearer …`; `client` sets `x-tula-client`. `times` repeats the request.
- **Expectations.** `status` must match exactly. `body` is matched as a subset: keys you leave
  out are not checked. Values compare literally, except `"$any"` (present and not null),
  `"$absent"` (missing or null), `{ "$not": value }` and `{ "$matches": "regex" }` (both need
  the value to be present). `bodyExcludes` lists strings the raw response must not contain.
- **Capture.** `{ "variable": "dot.path" }` stores a string from the response body.
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
| `06-lockout` | Backoff after repeated wrong passwords. |
| `07-admin-ban-and-audit` | Ban (a banned user with the right password is told so), unban, and an audit log without email addresses (needs a secret key). |

Scenarios assume the default settings (the `recommended` password policy and the default
session profile). Browser cookie delivery is not covered yet; scenarios use a native client
kind so tokens arrive in the response body.

## Adding a scenario

1. Add `scenarios/NN-name.json` and list its name in `apps/api/src/conformance.test.ts`.
2. `bun test apps/api/src/conformance.test.ts` runs it in process.
3. If you changed the format itself, run `bun run --filter @tula/conformance schema:generate`.
