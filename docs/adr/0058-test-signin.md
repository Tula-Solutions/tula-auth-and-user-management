# ADR 0058 — `test_signin`: an agent checks that sign-up and sign-in work

- Status: accepted
- Date: 2026-10-12

## Context

An assistant that has set an integration up has no way to see whether it works. It can read
settings and users ([ADR 0033](0033-mcp-server.md)) and ask for a change
([ADR 0053](0053-proposals.md)); it cannot sign anyone up. TULA-41 asks for a tool that
does: it signs a throwaway user up and in **through the real flow** and reports each step.

A tool like that is the first thing an agent key does that changes live data without a
person in between: a user exists for a few seconds, the environment's hooks are asked, its
events are recorded and delivered. So everything below is about bounding that, and about
keeping what the flow handles (a code, an attempt's secret, a session's tokens) away from
the model.

## Decision

### The run happens in the server

One function of the server, `SignInTests.run`, runs the whole test in the API process and
answers a report. The MCP tool `test_signin` only asks for it. The emailed code, the
attempt's secrets, the password and the session's tokens are local variables of that
function: they are in no response, so "never returned to the model" is how the thing is
built and not a filter over a result. The MCP process never holds them either.

**One run, two routes, and neither key middleware gains an exception.**

| Route | Operation | Guard | Actor |
| --- | --- | --- | --- |
| `POST /v1/agent/sign-in-tests` | `runSignInTest` | `agentKey()` | `agent`, the key's id |
| `POST /v1/admin/sign-in-tests` | `runSignInTestAsAdmin` | `secretKey()` | `admin` for a secret key, `instance_admin` for a dashboard session |

Both hand `SignInTests.run` the same things and answer the same report. The first plan was
one route for both keys, behind a middleware of its own. That would have been a third way
a key is taken: `agentKey()` and `secretKey()` each have one rule, the generators and
`openapi.test.ts` hold every operation under `/v1/agent/` to "the agent key and no other",
and `secretKey()` judges an agent key by the method before the key is looked up
([ADR 0053](0053-proposals.md) turned down "reads, and this one path" for the proposal).
Two routes keep all of it as it was: an agent key is refused on the admin route
(`auth.invalid_key`, a `POST`), a secret key on the agent's, and no guard was changed.
What it costs is a second operation id, and that a dashboard session can run a test
(`secretKey()` admits one; there is no button for it).

This is the one thing an agent key does besides reading and proposing, and it changes live
data. It is on by the environment's choice (below). ADR 0053's key table says so, and so
does the rule "never add a route under `/v1/agent/` that changes data", which now names
this route as its one exception.

### It goes through the flow service

`SignInTests.run` calls the functions the client routes call, in process, as a `web` client
with no `Origin`: `Flows.signUp`, `Flows.verifyEmail`, `Sessions.signOut`, `Flows.signIn`,
`Flows.submitPassword`, `Sessions.revoke`, `Users.remove`. Nothing of the flow is skipped or replaced: the password
policy, the breach check, the environment's ceilings, the lockout, the hooks
(`before_sign_up`, `before_session`, `before_token`), the session profile and the
concurrent-session rule all run as for any user.

The steps of a report are a closed list (`SIGN_IN_TEST_STEPS`):

| Step | What runs | 
| --- | --- |
| `sign_up` | `Flows.signUp` for the marked address; with a password the server generates where the environment's password method is on, without one otherwise |
| `verify_email` | `Flows.verifyEmail` with the code of the email the server made. The account is created here, and the three hooks are asked here |
| `sign_out` | `Sessions.signOut` with the new session's token |
| `sign_in` | `Flows.signIn` for the same address |
| `first_factor` | `Flows.submitPassword`, where the run has a password and the sign-in offers it; not run otherwise (below) |
| `revoke_session` | `Sessions.revoke` of the second session |
| `delete_user` | `Users.remove` |

Each has an outcome, `passed`, `failed` or `not_run`. A failed step carries the contract's
error code (`hook.denied`, `auth.method_disabled`, …) or, where there is none, a fixed
reason (`timeout`, `cancelled`). A step that was not run carries a fixed reason
(`SIGN_IN_TEST_REASONS`), and **a step is never reported as passed that was not carried
out**:

- `earlier_step`: a step it depends on did not pass.
- `second_factor_required`: the attempt stopped at `needs_second_factor` or
  `needs_factor_enrolment` (`mfa.policy` is `required`). The run has no authenticator and
  does not enrol one: the factor was accepted, the session was not made, and the steps that
  need the session are not run.
- `email_cooldown`: the sign-in offers an emailed code and no password. The address was
  emailed its verification code seconds ago, and a second code to one address inside a
  minute is refused (`Verification`'s resend cooldown, per address, which is what stops an
  inbox being flooded). The run does not wait a minute and does not get an exemption from
  a limit every user is held to, so the step is not run, and says why.
- `no_provable_method`: the sign-in offers neither a password nor an emailed code: only a
  passkey, an emailed link, a texted code or a provider.
- `timeout`, `cancelled`: the run's deadline passed, or the caller went away, before the
  step.
- `no_session`: there is no session to end.

**What is covered.**

| Environment | What a run shows |
| --- | --- |
| Password on (the default), with or without an emailed code beside it | Every step. The sign-in is by password. |
| Emailed code and no password (`signUp.password: 'optional'`) | The sign-up, the emailed code, the session, the sign-out and the start of a sign-in. `first_factor` is `not_run` (`email_cooldown`), and with it `revoke_session`. The outcome is `incomplete`. |
| `mfa.policy: 'required'` | The sign-up to the point the account exists, and the first factor of the sign-in. No session is made (`second_factor_required`). |
| Only a passkey, an emailed link, a texted code or a provider | The sign-up is refused (`auth.method_disabled`, reported as the failure it is), or the sign-in is `no_provable_method`. |

A texted code, a passkey, an emailed link and a provider are never run. The outcome of a
run is `passed` when every step passed, `failed` when a step failed (a deletion that did
not go through among them), and `incomplete` when none failed and one was not run.

### The email is captured, never sent

The run gives the flow a mailer of its own for the call (`captureMail()` in
`~/lib/captured-mail`), by handing the flow service a copy of `Deps` with that mailer in
it. `Email.send` hands such a mailer the message as it was asked for (its kind and its
code, before any wording is applied) and nothing reaches the real sender. The security
notices of the throwaway user take the same copy of `Deps` and are captured too.

**A real sender is never handed a marked address**, and that is held apart from the run:
`Email.send` drops a message for a marked address when the mailer is not a capture, with a
fixed log line. So a sign-in code, a reset code or a notice somebody asks for at such an
address is answered as for any address and sent nowhere.

### The marked address

`tula-test-<32 hex characters>@test.tula.invalid`. `.invalid` is reserved (RFC 2606, RFC
6761): no such domain can be registered and no mail can be delivered there. The contract
has the one rule (`isTestAddress`, `TEST_ADDRESS_DOMAIN`, Zod-free).

**No person can claim one.** `parseEmail` (`~/lib/email`), which every path that takes an
address for an account goes through, refuses a marked address (`email.invalid`, the answer
any malformed address gets, decided from the address alone and never from whether it has an
account): a sign-up, a password reset, asking for a sign-in email, an administrator's
create, a provider's profile. The run passes a permit that only `SignInTests` can make
(`ClientContext.testAddress`, a value branded with a symbol `~/lib/email` does not export;
a test reads the sources for any other caller). A sign-in **start** looks nothing up and
answers a marked address as it answers every identifier; nothing can be proven for it
(nobody was given its password, its mail goes nowhere).

### It is deleted at the end, whatever happened

The deletion is in a `finally`: after a step failed, after the deadline, after the caller
went away, after a hook refused. The user is looked for **by the marked address**, not by
an id a step returned, so a step that was abandoned at its time limit and created the
account afterwards is still found (the run waits for an abandoned step for a bounded time
before it looks). `Users.remove` does it: sessions ended and denylisted, credentials and
identities gone with the row.

If the deletion fails the report says `cleanup: 'failed'` with the user's id, an error line
is logged (fixed words, the environment, the user id, the error's name), and the retention
job removes it: `UserRepository.deleteTestUsersBefore(environment, cutoff, limit, …)`
deletes marked users older than `TEST_USER_RETENTION` (15 minutes), each with a
`user.deleted` entry by the `system` actor ([ADR 0017](0017-retention.md)). The same purge
is what a crashed process leaves to.

### The setting, and its default by kind of environment

`agents.testSignIn` in the environment's settings: `true`, `false` or `null` (the default).
`null` means "what this kind of environment does": **on in a development environment, off
in a production one**. "Production" is the environment's own kind as the control plane
stores it (the one the dashboard's production confirmations and the refusal of proposals
use), never `ENVIRONMENT` or `NODE_ENV`. One function resolves it
(`SignInTests.allowed`, over the contract's `testSignInAllowed(setting, kind)`).

A settings document does not know which kind of environment it belongs to, which is why
the default is a third value and not a boolean: a boolean default would be wrong for one of
the two kinds, and `{}` must stay a valid document everywhere.

Off answers `403 auth.forbidden` with `params.reason: 'test_sign_in_disabled'`. No new
error code (`@tula/core`'s table and bundle budget are untouched).

**Writing `true` is a weakening** (`settingsWeakenings`: `agents.testSignIn`), wherever it
was not `true` before. In a production environment that is the switch from off to on. In a
development environment written over `null` it changes nothing and is listed all the same:
the rule reads two documents and cannot know the kind, and it errs towards asking.
`false`, and `null` again, are not weakenings.

### Limits

Checked in this order, before anything is created; a refusal at one is counted by none of
the later ones. All fail closed (a limiter that cannot count is `service.unavailable`).

1. the setting (`auth.forbidden`): refused here, a run has counted nothing;
2. `SIGN_IN_TESTS_PER_KEY_PER_HOUR` (4) per caller: the actor's type and id, which is the
   key's id for an agent key and a secret key, and the session's for the dashboard;
3. `SIGN_IN_TESTS_PER_ENVIRONMENT_PER_HOUR` (8) per environment;
4. **one run at a time per environment**: one per `SIGN_IN_TEST_RUN_WINDOW_MS` (a minute),
   counted in the shared limiter, which is longer than a run can last (below). It is a
   window and not a lock: a second run is refused for the rest of the minute also when the
   first took a second. A lock that waits holds a database connection, and one that
   releases needs a holder that cannot crash.

A run has one deadline, `SIGN_IN_TEST_DEADLINE_MS` (40 s), and each step
`SIGN_IN_TEST_STEP_MS` (16 s: a sign-up waits for up to three hooks of five seconds). A
step that runs out of time is `failed` with `timeout` and the rest is `not_run`. The
deletion has its own `SIGN_IN_TEST_CLEANUP_MS` (8 s) after the deadline, and so does the
wait for a step that was abandoned at its time limit: a run answers inside 56 seconds, and
the window of a minute is longer than that. The MCP tool gives the request 60 s
(`SIGN_IN_TEST_TIMEOUT_MS`), four times what a read gets. A request that is given up, or
cancelled, ends nothing on the server but the steps not yet started: the deletion runs
whether or not anyone is listening.

Both routes are also behind `adminRateLimit()`, as every admin route is.

### What a receiver sees

The run is a real sign-up, so the environment's hooks are asked and its events go to its
webhook endpoints. That is the point, and a receiver must be able to tell:

- **`user.created` carries `test: true`** for an account with a marked address, and is
  absent otherwise. One optional boolean on one event: a receiver learns the user's id
  there, and every later event of the run names that id. It is derived from the address
  where the account is made, so no path can forget it.
- **`before_sign_up`'s question holds the address**, in the reserved domain. The other two
  questions hold the user's id. The questions' schemas are not widened: they are strict on
  purpose and a receiver may hold them so.
- `sign_in_test.started` and `sign_in_test.finished` are events like any other (below).

### What is recorded

| Entry | Actor | Target | Data |
| --- | --- | --- | --- |
| `sign_in_test.started` | `agent` (the key's id); `admin` for a secret key, `instance_admin` for the dashboard | the environment | none |
| `user.created` | the user (the flow's own entry) | the user | as for any sign-up, and `test: true` |
| the flow's and the sessions' own entries | as always | | |
| `session.revoked` (the second session) | the caller | the session | as for an administrator's revocation |
| `user.deleted` | the caller | the user | none |
| `sign_in_test.finished` | the caller | the environment | `outcome`, `cleanup`, and `userId` when an account was made |

The flow's own entries keep their own actors: the account was created by the flow's rules,
and rewriting the actor of `user.created` would mean a second way to create a user. The
agent is named on the run (`started`, `finished`, which carries the user's id), on the
session it ends and on the deletion. So the ticket's "the user's creation and deletion are
audited with the agent actor type" is met for the deletion by the entry itself, and for the
creation by the run's entries, which name the agent and the user's id; `user.created`
itself says the user. A `started` entry that cannot be written stops the run before
anything is created. A `finished` entry that cannot be written is logged and the report is
still answered: the user is gone by then, and a 500 would say the run did not happen. `started` and `finished` are written by `UserRepository.reportSignInTest`, which
writes an activity and nothing else, as `reportRefusedProof` does for a session
([ADR 0012](0012-events-and-audit-log.md)). The flow's entries hold no address of the
agent's request (the context's IP address is `null` and its user agent a fixed string):
an agent's address under a user's id would be two origins under one actor.

### The MCP server: a third facade

`packages/mcp/src/testing-sign-in.ts`: `TEST_OPERATIONS` is `{ agent: 'runSignInTest',
admin: 'runSignInTestAsAdmin' }`, one operation a kind of client, checked by type, on
every call and at construction (a `POST` at exactly `/v1/agent/sign-in-tests` or
`/v1/admin/sign-in-tests`). `SignInTester` has one function, `run({ signal })`, with no
body, header, path or timeout of the caller's. It shares nothing with `ReadOnlyAdmin`
(unchanged, `GET` only) or `ProposingAdmin` (unchanged). The server wraps the agent's
client where there is one, and the run is then the agent's in the audit log; the admin
client otherwise.

**"No tool changes live data" is no longer true of the MCP server, and nothing says it
any more.** `test_signin` is the one tool that does, for the seconds a run lasts, and its
description, the server's instructions, `tula mcp`'s first line and `docs/mcp.md` say so
in those words. It is a group of its own (`test`), with a name that starts `test_`.

The tool `test_signin` takes no input (`z.strictObject({})`), answers the report through
`project(value, shape)` and the sanitizer like every other result, and its annotations say
it is not read-only and not idempotent.

## What this does and does not prove

- A `passed` report says the server's own flow, with this environment's settings and hooks,
  signed a new user up and in. It says nothing about the application's pages, its SDK
  setup, the real mailer (no mail was sent) or a receiver's handling of the events.
- The captured email is not rendered: an environment's own wording of the verification
  email is not exercised.
- An agent that can call this can make the environment's hooks and webhook receivers see a
  sign-up a few times an hour. That is why it is a setting, off in production by default.

## Not verified

- No MCP client was connected (as in ADR 0033 and 0053): the tool was called through the
  SDK's in-memory transport, against the real API in process.
- The Postgres side of `deleteTestUsersBefore` and `reportSignInTest` runs in the shared
  store suite on PGlite. The `*.integration.ts` files, which need a real server, were not
  run for this change.
- The conformance scenario ("a sign-in test runs where the environment allows it") was run
  in process only, not against a packaged server.

## Alternatives considered

- **The flow driven from the MCP process over `/v1/client/*`.** The code would have to be
  read from somewhere (an inbox route for agents) and the tokens would be in the process
  the model talks to.
- **A shortcut that creates the user and a session directly.** It would check nothing an
  integration depends on (the hooks, the policy, the flow's steps).
- **One route for both keys, behind a middleware of its own**, and **`secretKey()` taught
  one path.** See "The run happens in the server".
- **An emailed-code sign-in, by waiting out the cooldown or by exempting the run from it.**
  A minute of waiting is longer than a tool call should hold a turn, and an exemption is a
  way round a send limit that would exist for one caller. `not_run` with a reason is the
  honest answer; an environment without passwords gets `incomplete`.
- **A client-reachable conformance scenario for "a marked address cannot sign up".** It
  needs a journey in every client's suite, the Swift one among them, for an answer that is
  the one every malformed address gets (`email.invalid`). It is an API test
  (`modules/sign-in-test/test-address.test.ts`), which walks every path an address reaches
  an account or a mailbox by.
- **A lock for "one at a time".** See "Limits".
- **A `test` field on every event of the run, or on the hooks' questions.** It would have
  to be threaded through every store call of the flow, or widen strict schemas; one field
  where the user's id is first said is enough to tell.

## After review (2026-10-12)

- **A step still at work when the clean-up stops waiting is `cleanup: 'failed'`, never
  `none`.** The clean-up waits `SIGN_IN_TEST_CLEANUP_MS` for a step that was left at its
  time limit, then looks for the user by its address. A step that finishes after that look
  (a hook that takes its five seconds, a slow store) makes the account afterwards. The
  first version reported `none` there, which said no user existed while one was about to.
  Now, when the wait ran out and no user was found, `delete_user` is `failed` with
  `timeout`, `cleanup` is `failed` and `userId` is `null` (the server has no id to give):
  the retention job removes the user by its address. `cleanup: 'none'` is said only when
  every step the run started had ended.
- **`false` taken back to `null` is listed as a weakening too.** In a development
  environment that turns the test on (the default there is yes), also when a `PUT` or a
  config file simply leaves `agents` out over a server that says `false`. The rule is still
  about the documents alone; it lists `true` written where it was not, and `null` written
  over `false`.
- **A run refused by the one-a-minute window has spent one of the caller's four and one of
  the environment's eight**, because narrow limits are counted before wide ones (as for
  text messages, ADR 0037): the window first would let one caller's refused tries hold
  the environment's minute without spending anything of its own. So a caller that retries
  three times inside a minute has no run left that hour, and a caller can spend the
  environment's hour with refused calls (it could with real runs as well). `rate_limited`
  says when to try again, and the tool's description says to wait.
- **"Two never run at once" rests on a run ending inside the window, and the bound is on
  the steps, the wait and the deletion (56 s), not on every store call around them**: the
  `started` entry, the read of the settings and the look for the user by address have no
  time limit of their own. A database slow enough to stretch those past four seconds
  together could let a second run start while the first is ending. Accepted: two runs at
  once use two different addresses and harm nothing but the load the window is there to
  bound.
- **A dashboard session's own limit is per session**, so signing in again gives four more;
  the environment's eight an hour bound it.
