# ADR 0013 — Conformance scenarios

- Status: accepted
- Date: 2026-10-03

## Context

Tula will have clients in three languages (TypeScript, Swift, Kotlin) and can be self-hosted.
Each of them has to agree with the server on the same flows, error codes and token rules. Tests
written separately in each codebase drift apart; the business plan calls for one
language-neutral suite every server and SDK must pass.

## Decision

- **Scenarios are data.** Each one is a JSON file in `conformance/scenarios/`: named steps that
  send an HTTP request and state what the response must be, read an emailed code, or let time
  pass. The format is defined once in Zod (`packages/conformance/src/scenario.ts`) and published
  as `conformance/scenario.schema.json` for other languages and editors; a test fails when the
  two differ.
- **Responses are matched as subsets.** A scenario states the fields that matter; new fields in
  a response do not break it. Four matchers cover what literals cannot: `$any`, `$absent`,
  `$not` and `$matches`.
- **One runner, two targets.** `@tula/conformance` runs a scenario against a `Target`: a
  `fetch`, a way to read emailed codes and a way to let time pass. In process, those are
  `app.request`, the memory mailer's outbox and the test clock, so the suite runs in
  `bun test` in milliseconds. Against a live server they are real `fetch`, Mailpit and a real
  sleep.
- **Scenarios are independent.** Each run generates its own email address and password and
  presents its own client address (from a range of 62,500, starting at a random point in each
  process), so neither per-address nor per-IP limits couple one scenario to another, and a live
  run can normally be repeated at once.
- **A run that checks nothing fails.** The CLI exits non-zero when a scenario fails or when
  none passed.
- **Failures never quote secrets.** A failing step reports the status, the error code and the
  fields that differed. Short plain values are quoted; long or token-shaped strings, objects and
  arrays are only described, and anything the scenario generated or captured is shown as its
  placeholder. Bodies hold tokens, and CI logs are widely readable.
- **The in-process run is part of the quality gate.** It is an ordinary test file in
  `apps/api`, so `bun run verify` and CI run every scenario on every change.

## Consequences

- A live run needs the server to trust `X-Forwarded-For` (`TRUST_PROXY=true`). That is a test
  deployment setting; a server that ignores the header still passes unless a run exceeds a
  per-IP limit (ten sign-ups a minute).
- A live run leaves its users and audit entries behind and takes about five and a half
  minutes, because scenarios really wait: 61 seconds for an address's email cooldown (several
  times), 11 for the refresh grace period, and, since the two-step verification scenarios
  ([ADR 0025](0025-mfa.md)), 30 seconds between two uses of one authenticator (121 seconds in
  all), because the server accepts a time step once.
- **The target tells the runner the time.** A `totp` step computes the code an authenticator
  app would show from a captured secret and `Target.now()`: the test clock in process (which
  `wait` steps advance), the wall clock against a live server. A live run therefore needs the
  runner's clock and the server's to agree to within the 30 seconds either side that the
  server tolerates; it passed against the two-instance Compose stack on its first runs.
- **Sets are matched as sets.** `{ "$set": [...] }` matches an array with exactly the given
  members in any order. It exists for a token's `amr`, whose order is not part of the
  contract, so that a server which emits another order still conforms.
- Scenarios assume the default password policy and session profile. A deployment with other
  settings may fail the lockout or reuse scenario for reasons that are not bugs.
- Browser cookie delivery, concurrent refresh and the SDK-side behaviour (single-flight refresh)
  are not expressible yet; the runner has no cookie jar and no parallel steps. They are needed
  before the web SDK ships (Phase 1).
- CI runs the scenarios in process in the `verify` job, and against the packaged server
  (Docker Compose) in the `self-host` job.
