# ADR 0019 — Flow engine v2: bound attempts, first-factor choice, second-factor wiring

- Status: accepted
- Date: 2026-10-03
- Supersedes parts of [ADR 0009](0009-flows.md) (what identifies an attempt; what a sign-in
  start answers; the transition function's inputs) and one consequence of
  [ADR 0015](0015-password-reset.md) (passwordless users and resets).

## Context

Phase 1 adds magic links, email codes, TOTP, OAuth and passkeys. With the Phase 0 engine each
of them would have been a rewrite:

- **An attempt id was a credential on its own.** It travels in URL paths (which are logged) and,
  with magic links and OAuth callbacks, an attempt is finished from another tab or device. ADR
  0009 deferred magic links for exactly this reason.
- **A sign-in start always answered `needs_password`.** There was no way to offer a choice.
- **Nothing could stand between a first factor and a session.** `needs_second_factor` existed
  in the contract but no transition led to it, and a password reset signed the user straight in.
- **A password could be replaced but never created**, so a user who signs up with Google or a
  passkey could never get one.
- **A browser flow set the session cookie whoever made the request.** Step 1.2 gated *using*
  the refresh cookie by origin; *setting* it on flow completion was not gated.

## Decision

### Attempts are bound to a client-held secret

- Starting any attempt (sign-up, sign-in, password reset) generates a 256-bit secret from the
  CSPRNG, prefixed `tula_at_`. Only its SHA-256 is stored (`flow_attempts.secret_hash`). The
  secret is returned **once**, as `attemptSecret` in the response that starts the attempt, and
  never again: not in a later response, a log line, an audit entry or an email.
- Every later call on the attempt presents it in the `x-tula-attempt` header
  (`FLOW_ATTEMPT_HEADER` in `@tula/contract`). The check lives in the flow service's `load`,
  which every step calls first, so no step can forget it.
- **No oracle.** A missing secret, a wrong one and another attempt's secret all answer the same
  `flow.not_found` as an attempt that does not exist, before anything is counted, spent or
  sent. Hashes are compared in constant time, and a comparison is made even when the attempt
  does not exist. The header is optional in the request schema for the same reason: a missing
  one must not be a validation error that tells a real attempt id from a made-up one.
- **Required now, not phased.** The plan staged this as "accepted but not required" until
  `@tula/core` sends it. No client has been released, so there is nobody to break, and a
  period in which the secret is optional is a period in which it protects nothing. It is
  required from this step.
- **Attempts stored before the migration** have no hash. A missing hash matches no secret: such
  an attempt can never be continued. It is never read as "no secret needed". Attempts live ten
  minutes, so this affects only attempts in flight during the upgrade.
- CORS allows the header; the logger's redaction list names it (and `attemptSecret`), although
  nothing passes either to the logger.

### A browser flow is refused from an origin the environment does not allow

A browser stores the cookie a completed flow sets, whoever wrote the page that made the
request. An attacker could start a sign-in to *their own* account outside a browser and have a
page on another origin finish it in the victim's browser, leaving the victim signed in as the
attacker (login CSRF). The preflight does not prevent this when the attacker's origin is
allowed by another environment of the same deployment.

- For an attempt started as a `web` client, a request is accepted only when it has no `Origin`
  header or an origin the environment allows: the rule the refresh cookie is already read under
  (`originMayUseCookies`, ADR 0018).
- It is checked **when the attempt starts** and **on every later step**, completing or not, in
  the same `load` as the secret (after it, so the answer says nothing to someone who does not
  hold the attempt), and always before any state changes: no guess is counted, no code is
  consumed, no email is sent and no session is created.
- The error is a new code, `request.origin_not_allowed` (403). `auth.forbidden` would have told
  an app developer nothing about what to fix (add the origin to `urls.allowedOrigins`).
- The client kind is the one the attempt was **started** with. A later request cannot escape
  the rule by sending another `x-tula-client`.
- Other client kinds are not bound to an origin: their tokens are returned in a response body a
  foreign page cannot read, and no cookie is set for them.

The router computes whether the origin is allowed once, where it builds the request's context,
and passes it to the service as `originAllowed`; the service enforces it. That keeps the rule in
one place for every present and future flow route instead of in each handler.

### Sign-in offers the first factors the environment has enabled

- The contract gains `FirstFactorStrategy` (`password`, `email_code`, `email_link`, `passkey`,
  `oauth_google`, `oauth_github`, `oauth_apple`) and a step `needs_first_factor { strategies }`.
- A sign-in start answers `needs_password` when the password is the only enabled method, so the
  simplest client stays simple, and `needs_first_factor` with the enabled strategies otherwise.
  With no method enabled it is refused with `auth.method_disabled` (without a `method`
  parameter: none is enabled at all).
- **The strategies depend only on the environment's settings, never on the identifier.** The
  start does not look the identifier up. A list that depended on the account would tell a
  stranger whether an address exists, and whether it has a password or a passkey.
- The strategies are stored on the attempt, and a step accepts exactly what the start offered:
  a password is accepted on `needs_password`, or on `needs_first_factor` when `password` is
  among the attempt's strategies. The method's own switch is still checked on every step
  (ADR 0018), so a method switched off mid-attempt stops working at once.
- One registry maps settings to strategies: `FIRST_FACTORS` in `modules/factor/service.ts`.
  Steps 1.7 to 1.10 add a strategy by adding an entry there and the route that proves it.
  Only `password` can be enabled today, so `needs_first_factor` is reachable only in tests.

### A second factor stands between the first factor and the session

- After every accepted first factor, and after a password reset's code and new password are
  accepted, the engine asks `Factors.requiredFor(deps, tenant, userId)` which second factors
  the user must prove one of. It returns none today; step 1.8 fills it in. A non-empty answer
  moves the attempt to `needs_second_factor { options }` instead of `complete`: **no session is
  created and no tokens are returned** until one is proven.
- **Order:** first factor → email verification (if the email is unverified) → second factor →
  complete. A ban is still revealed only after the first factor.
- **The entry point is `Flows.submitSecondFactor(deps, tenant, kind, ref, proof, context)`.**
  The engine owns everything around the proof: the attempt's secret and origin, the step, that
  the method is one the attempt offered, a per-user lockout (`CREDENTIAL_LOCKOUT`, counted
  first and cleared on success), the environment's ceiling, the ban check and the
  compare-and-set that lets exactly one request create the session. The proof itself is checked
  by the verifier registered for its method (`SECOND_FACTOR_VERIFIERS`, through
  `Factors.verify`). Step 1.8 registers the TOTP and backup-code verifiers and adds the route;
  the engine does not change. A wrong proof is `verification.invalid_code`.
- **There is no HTTP route for it yet.** No user can have a second factor until 1.8, so nothing
  reaches `needs_second_factor` outside tests, and a route with no verifier behind it would be
  dead surface.
- **Password reset.** The code and the new password are accepted and stored and every session
  ends, exactly as before; then the attempt moves to `needs_second_factor` if one is required.
  The stored password is **not** rolled back if the second factor is never proven: the user
  proved control of the inbox, which is what a reset requires. The second factor gates the
  *session*, not the reset. The attempt cannot set a password again: its code is spent and it
  has left `needs_new_password`. The required factors are read before the code is spent, so a
  failure to read them leaves the reset retryable.

### Transitions stay one pure function

`nextStatus(kind, status, event, context)`; `context` carries the strategies the attempt was
offered, whether the email is verified, and the required second factors. Events are
`first_factor_verified { strategy }`, `email_verified`, `password_reset` and
`second_factor_verified`. The table test generates every kind × step × event (and, for each,
every combination of offered strategies and kind of user) and asserts each one either allowed
with its result or refused with `flow.invalid_step`. A new step or event cannot be added
without the test classifying it.

A sign-up completes without asking for a second factor: the account is created at that moment
and cannot have one.

### Users without a password

- `UserRepository.setPasswordHash` creates the password credential when the user has none and
  replaces it otherwise, in one atomic upsert with its audit entry. It returns `created` or
  `replaced` (`null` when the user does not exist), and a first password's audit entry carries
  `created: true`. Only the store knows which happened at the moment it happens, so the store
  marks the entry.
- An admin "set password" and a password reset therefore work for a user who has no password.
  This supersedes the last consequence of ADR 0015.
- **"Change my password" on an account with no password answers `password.not_set` (409)**, and
  only to the signed-in user about their own account (the user id comes from their access
  token), so it is no oracle. A first password is **not** set through that route: an access
  token alone would then be enough to add a credential to the account. A first password is set
  through the reset flow, which proves the inbox, or by an admin.
- Signing in with a password to an account that has none is the same generic
  `auth.invalid_credentials`, at the cost of one dummy argon2id verify, as before.
- `POST /v1/admin/users` accepts a request without `password` and creates a user with no
  password credential (audit `data.passwordless: true`).

## Consequences

- **Breaking for anything that called the Phase 0 flow routes**: every call after a start needs
  `x-tula-attempt`. No client had been released. The conformance scenarios all capture the
  secret and send it (the scenario format gained an `attempt` request field), and
  `13-attempt-binding` shows the refusals.
- An attempt is tied to the client that started it. A client that loses the secret (a page
  reload that keeps only the URL) starts again. Step 1.7's magic links rely on exactly this:
  the tab that started the attempt, not the device that opened the link, receives the session.
- A browser app must be served from an origin in `urls.allowedOrigins` (or `CORS_ORIGINS`, or
  any loopback origin in the `local` tier) to sign anyone in. It already had to be, to read the
  responses.
- A reset by a user with a second factor who then abandons the attempt leaves the new password
  in place and the old sessions ended, with nobody signed in. Their next sign-in asks for the
  new password and the second factor.
- `Factors.requiredFor` is called on every successful first factor. It is a constant today; 1.8
  makes it a read, on the path that already reads the user.
- `needs_first_factor` and `needs_second_factor` are in the contract and the engine before any
  client can reach them. SDKs written against this contract (1.5, 1.6) must handle both steps
  from the start.
