---
paths:
  - "apps/api/src/modules/hook/**"
  - "apps/api/src/lib/signing-secret*"
  - "packages/contract/src/hook*"
  - "apps/dashboard/src/features/hooks/**"
---

# Hooks (the questions asked before a sign-up, a session and a token)

Moved here from `AGENTS.md`, word for word, and canonical for this area: `AGENTS.md` lists
this file under "Area rules" and does not repeat it. A section named in a sentence as
"above" or "below" is found through that list.

## Hooks (`modules/hook`, see ADR 0035)

A **hook** is a signed question whose answer decides what happens next
([GLOSSARY.md](../../GLOSSARY.md)). Never call it a webhook, and never call a webhook a hook.
There are three points (`HOOK_POINTS`): `before_sign_up` and `before_session` decide (allow
or deny), `before_token` adds claims and cannot deny. The first six rules below were written
for `before_sign_up` and hold for all three unless they name it.

- **The hook is asked only where a new account is about to be created**, which is for a
  proven address, or at the first sign-in with a provider of
  `OAUTH_PROVIDERS_WITHOUT_ADDRESS` (X, Facebook), where the question's `email` is `null`:
  in `Flows.verifyEmail` after `Verification.verifyCode` and the decoy check; on the "no
  user has that address" row of `OAuth.resolveAccount`; and on its "the identity is
  nobody's" branch for a provider that gives no address. Never at a start, never
  at a step a decoy attempt also reaches, never for an existing account, never from
  `Users.create` (an administrator's own act). Asked anywhere earlier, whether it was asked
  tells an observer whether an address has an account. A new way to create an account by a
  sign-up calls `Hooks.beforeSignUp` at that same point. A path that has an address gets the
  side-by-side test (an existing and a new address: same answers, and the receiver called
  for neither before the proof). A path with no address has nothing to put side by side;
  its test is that the receiver is called only at the exchange, after the binding is
  checked, never at the start or the callback, and never for a known identity
  (`modules/oauth/x-facebook.test.ts`).
- **A hook is not an authority.** `Hooks.beforeSignUp` and `Hooks.beforeSession` return
  `'clear'` or `'bypassed'` and throw otherwise; `Hooks.beforeToken` returns claims that
  passed every rule, or none. The parsed answer never leaves `call` in the service. Never return more
  of an answer, never widen the two-member verdict, and never let a key of the answer reach
  a user, an attempt's state or a session. Keep the test that answers `emailVerified`,
  `userId`, `amr` and compares the account with one made without a hook.
- **Anything but a 2xx whose body is exactly an answer is a failure**: another status
  whatever its body, a redirect, a body over `HOOK_MAX_RESPONSE_BYTES`, an unknown key, no
  answer in time, a guard refusal, a secret that does not open. A failure is never read as
  an allow or as a denial; the hook's `failureMode` decides (`deny` by default). Unknown
  keys are a failure on purpose: never make the answer's schema lenient.
- **The deadline is 100 to 5000 ms, held three times**: the contract's schema, the check
  `hooks_deadline_bounds`, and the service (`Math.min(…, HOOK_MAX_DEADLINE_MS)`). Never
  loosen one because another holds.
- **A refusal ends the attempt and leaves nothing**: no user, identity, credential, session
  or `user.created`. `hook.denied` (403, `params.code` is the operator's code) and
  `hook.unavailable` (503) are different codes on purpose. Any other error leaves the
  attempt alone.
- **What removes the check is a recorded weakening** (`hookWeakenings` in the contract,
  shared with the later `tula apply` and dashboard): `failureMode: 'allow'`, switching a
  hook off, removing one that is on. The store's `update` and `delete` are compare-and-sets
  on what the weakening was judged against. An account let through by a failed hook carries
  `hookBypassed: true` in `user.created`.
- **The secret and the signature are the webhooks' own code** (`~/lib/signing-secret`:
  `newSigningSecret`, `openSigningSecret`, `signedHeaders`), under a purpose of its own
  (`hook-secrets`, bound to environment and hook id). Never a second place that signs.
- **The question is an allow-list and is never stored**: the address (`null`, the key still
  there, for a first sign-in with X or Facebook, which give none), the method, the client
  kind and the IP address (`HookBeforeSignUpDataSchema`, strict), named field by field where
  the body is built. Never in the outbox, the audit log or a log line; the rule that an
  event payload holds no email or IP address is unchanged. Of an answer only the decision
  and the code are kept; `last_failure_reason` is one of `HOOK_FAILURE_REASONS`.
- **Calls are counted per environment** (`HOOK_CALLS_PER_MINUTE`, just before a call, only
  where a hook is on), and there is no route that asks a hook on demand.
- **What a call came to is counted, and nothing of the call is kept** (ADR 0035, "Recent
  outcomes"). Every call `ask` makes is counted under its hook, its UTC hour and one of
  the contract's `HOOK_OUTCOMES` (`allowed`, `denied`, `failed`, `timed_out`;
  `hookFailureOutcome` maps a failure) in `hook_call_counts`, through
  `HookStore.countCall`, which takes an outcome and a time and has no parameter for
  anything else. **Never add a column, a parameter or a row per call**: not the operator's
  code, a claim, a status, a reason, a duration, an id of who signed in. The word an
  answer is counted as comes from `Answering.counted` and is all of an answer that
  reaches the count. A failure is counted whatever the failure mode does with it; a call
  that was not made (no hook, off, over the ceiling) is not. **The write is bookkeeping,
  and detached** (`noteOutcome`, unrecorded like `noteFailure`): started once the decision
  is known and **never awaited by the request** (a write with no deadline must not sit on
  a sign-in), nothing it throws leaves it (fixed words, two ids and an error's name, never
  a message; also when the store throws at the call), and it is registered with
  `Hooks.settled()`, which tests await before they read a count and `closeApi` awaits
  after the listener stops and before the pool closes. Keep the tests that hold a count
  back and see each of the three points decide meanwhile, and the line in
  `server-close.test.ts`. So a count may land just after its answer and a process killed
  hard loses it: say both wherever the counts are documented, and never build a decision
  on a count. **A call is counted at the moment its question was asked** (the clock is
  read before `call`, never after): the hour and `lastCallAt` are the question's. Never
  put the counts on the `hooks` row (every sign-in reads it) or in the rate limiter. The
  answer's `recentOutcomes` is the current hour and the `HOOK_OUTCOME_WINDOW_HOURS` - 1
  before it (23 to 24 hours: never worded "the last 24 hours"), one read for a list.
  **What is said of a hook's health is that its last call failed, with when**
  (`hookLastCallFailed(lastOutcome)` beside `lastCallAt`), never `lastFailedAt` (it is
  never cleared), never a share of the counts, and **never "failing now"**: the call may
  be 23 hours old and the hook not asked since. `lastCallAt` is the time of the latest
  hooked sign-in, to the millisecond: it is answered by the admin API only, and the docs
  say so in those words. Rows go by cascade with their hook and by
  `HookStore.deleteCallCountsBefore` from the retention job
  (`HOOK_CALL_COUNT_RETENTION`).
- `verifyHook` (`@tula/admin`) and `verifyWebhook` share `verifySigned` and refuse each
  other's bodies: a question has a type from a closed list and no `actor` or `target`.
- The `hook` conformance step uses the `webhook` step's receiver; a scenario with one sets
  `needsWebhookReceiver` and is added, by name, to the skipped set in `.github/workflows/ci.yml`.
- **`before_session` is asked in one place: the flow service's `finish`**, after every factor
  is proven and the attempt has been moved to `complete`, immediately before
  `Sessions.create`. So it is asked for a sign-in, a sign-up (after `before_sign_up`, which
  is asked earlier, where the account is made) and a reset that signs in; never for a
  refresh, a step-up or anything an administrator does. A wrong password, a locked account
  and a missing second factor never reach it: keep the side-by-side tests
  (`modules/flow/session-hook.test.ts`). A denial or a failure under `deny` leaves no
  session, token, cookie, `session.created` or new-device notice, and the attempt is spent
  (the user starts again): that cost is stated in `docs/hooks.md`. Never move the question
  before the attempt's compare-and-set (a parallel submit would ask twice), and never after
  `Sessions.create` (a refused sign-in would leave a live session).
- **Neither later question holds an email address, and `before_token`'s holds no IP address
  either**: ids, the client kind, the profile's name and `amr` in both; `signUp` and the
  request's IP address in `before_session` only (`HookBeforeSessionDataSchema`,
  `HookBeforeTokenDataSchema`, strict). A claim is stored and issued with every later
  token, so it must not depend on the address of one request. Never a password, a code, a
  token, the attempt's id or the user agent in either.
- **A hook that refuses an enrolling sign-in costs the user their other sessions, and that
  is kept.** `Mfa.confirmTotp` ends the sessions that did not prove the factor before it
  turns the factor on (ADR 0025), inside an attempt too; a refusal after that undoes the
  factor, not the sweep. Never move the sweep after the session exists to spare it: tests
  pin the cost, and ADR 0035 has the alternative and why it was taken out.
- **A proof is spent before a hook is asked and is never given back**: a backup code, a time
  step, an emailed code, a passkey's counter. Never reorder to save one, and never un-spend
  one. A test pins the backup code (nine left after a refused sign-in).
- **`before_token` is asked when a session is created and when it proves a factor again, and
  never at a refresh.** `Sessions.create` and `Sessions.recordAuthentication` are the only
  callers of `Hooks.beforeToken`; the answer is stored on the session (`sessions.hook_claims`)
  and every issue after that reads the row: a refresh, a refresh inside the grace window and
  a stateful session's request make **no** call (a test counts them, and that the hook store
  is not even read). The inputs are the user, the session, the client kind, the profile's
  name and `amr`; a new input is a decision recorded in ADR 0035, with the place that asks
  again when it changes.
- **A claims answer is exactly `{ claims }`, judged whole.** A reserved name, a malformed key
  (`__proto__` among them), a value that is not a scalar, a key beside `claims`, or claims
  that with the profile's template exceed `MAX_CUSTOM_CLAIMS_BYTES` (`CustomClaims.fits`) is a
  **failure** (`claims_invalid`, `claims_too_large`): never partly applied, never trimmed.
  Under `deny` the sign-in or the step-up fails with `hook.unavailable` and nothing changes;
  under `allow` the session carries no hook claims and its event says
  `claimsHookBypassed: true`. **Where the hook and the template set the same key the hook
  wins.** Stored claims are judged again on every read (`CustomClaims.stored`): a row that
  no longer passes is issued without them and logged, never a 500.
- **A step-up replaces the stored claims, with a compare-and-set on what the session had
  proven** (`ifAuthMethods`), so two step-ups at once cannot store claims that describe
  neither; a miss is retried (`STEP_UP_ATTEMPTS`) and then answers 503. Never write
  `hook_claims` by another path.
- **A sign-in waits for at most two hooks** (`before_session`, `before_token`), a sign-up
  for three: at most 5 seconds each, one after another. `docs/hooks.md` states the worst
  case; a fourth call on that path is a decision, not an addition. The two later points are
  counted apart from sign-ups (`HOOK_SESSION_CALLS_PER_MINUTE`, per point).
- **What a hook let through is said with a boolean and nothing else**: `hookBypassed` and
  `claimsHookBypassed` on `session.created`, `claimsHookBypassed` on `session.stepped_up`.
  Never a claim's key or value, the operator's code or a reason in an event or an audit
  entry.
