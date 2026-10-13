---
paths:
  - "apps/api/src/modules/sign-in-test/**"
  - "apps/api/src/lib/captured-mail*"
  - "packages/mcp/src/testing-sign-in*"
  - "packages/contract/src/test-address*"
---

# Sign-in tests

Moved here from `AGENTS.md`, word for word, and canonical for this area: `AGENTS.md` lists
this file under "Area rules" and does not repeat it. A section named in a sentence as
"above" or "below" is found through that list.

## Sign-in tests (`modules/sign-in-test`, see ADR 0058)

A **sign-in test** is one run of the environment's real sign-up and sign-in for a throwaway
user, made by the server in its own process and reported step by step. The MCP tool
`test_signin` asks for one.

- **The run is one function, `SignInTests.run`, behind two routes, and no key middleware
  has an exception for it**: `POST /v1/agent/sign-in-tests` (`agentKey()`, actor `agent`)
  and `POST /v1/admin/sign-in-tests` (`secretKey()`, actor `admin` or `instance_admin`).
  Neither takes a body. Never one route for both keys, and never a third.
- **It runs only where `agents.testSignIn` allows it** (`testSignInAllowed`, the
  contract's: `null`, the default, is on for a development environment and off for a
  production one), **read past the settings cache** (`Settings.get(…, true)`: switched
  off through one instance, it is off on every instance at once; keep the test with two
  instances over one store). Refused, it is `auth.forbidden` with `params.reason:
  'test_sign_in_disabled'`, **before anything is counted or created**. Never add an error
  code for it (`@tula/core`'s table has every code). Writing `true`, and taking `false`
  back to `null`, is a weakening (`settingsWeakenings`: `agents.testSignIn`), in any kind
  of environment: the rule reads the two documents and never the kind.
- **The order is fixed**: the setting, the caller's hour
  (`SIGN_IN_TESTS_PER_KEY_PER_HOUR`), the environment's hour, the environment's minute
  (`SIGN_IN_TEST_RUN_WINDOW_MS`: what keeps two runs from being under way at once; a run
  answers inside 56 seconds), the `sign_in_test.started` entry, then the first step. Every
  limit fails closed (`service.unavailable`), and a `started` entry that cannot be written
  stops the run. Never raise a limit or shorten the window below the run's own bound.
  **A step's time limit is its own allowance plus the worst case of the hooks it asks**
  (`stepLimitMs`: `SIGN_IN_TEST_STEP_MS` and `SIGN_IN_TEST_HOOK_MS` for each hook of
  `SIGN_IN_TEST_HOOKS_ASKED`; `verify_email` asks three, `first_factor` two), never more
  than what the run's deadline has left. A hook asked on a new step is added to that
  table, and the sum (the deadline, two clean-up allowances, 56 s, below the MCP tool's
  timeout and the window) is redone in the constant's comment and ADR 0058; a test holds
  the inequalities.
- **The steps are the flow service's own functions**, with the run's context
  (`SIGN_IN_TEST_USER_AGENT`, no IP address, no cookie set): never a second path to an account or a
  session, and never a step reported `passed` that was not taken. What the run cannot
  prove is `not_run` with a word of `SIGN_IN_TEST_REASONS` (a required second factor, an
  emailed-code sign-in inside the resend cooldown, a method it has no proof for); a new
  reason is added there, to ADR 0058's coverage table and to `docs/mcp.md`. **The run is
  held to every limit a user is**: never exempt it from a cooldown, a lockout or a hook.
- **The secrets of a run are local variables of that function**: the emailed code, the
  attempts' secrets, the password, the tokens. The report (`SignInTestReportSchema`,
  strict) has closed words, durations, an API error code and the user's id, and nothing
  else: never an address, a message or an error's text. A step's failure is the code of a
  `ServiceException`, or the fixed word `internal`.
- **The address is `testAddress(hex)` and nothing else makes one** (`@tula/contract`'s
  `test-address.ts`, Zod-free: `tula-test-<32 hex>@test.tula.invalid`). **No person can
  claim one**: the one function every address goes through, `parseEmail` (`~/lib/email`),
  answers `null` for one, exactly as for a malformed address, unless it is handed the
  run's `TestAddressPermit` (a value only `SignInTests.run` makes, carried in the flow's
  `ClientContext` and read from no request). So a sign-up, an administrator's create, a
  reset, a sign-in email and a provider's profile with such an address are each refused
  as "not an address". Never accept an address by another function, and never build a
  permit anywhere else. A new path that takes an address gets a row in
  `modules/sign-in-test/test-address.test.ts`, which walks them.
- **No email for a test address leaves the server.** The run gives the flow a mailer of
  its own (`captureMail`, `~/lib/captured-mail`), which `Email.send` hands the message's
  kind and code and nothing rendered; any other `Email.send` to such an address (a notice,
  started with the deployment's `deps`) is dropped before the mailer and logged by kind:
  the verification code is read from the capture, a notice is never sent. Never give the
  capture to anything but the run, and never read a code from the store instead.
- **The user is deleted in a `finally`, with a time allowance of its own**
  (`SIGN_IN_TEST_CLEANUP_MS`), whatever a step did, the deadline included, and whether or
  not the caller is still there. A deletion that fails is `cleanup: 'failed'` with the
  user's id, an error line with fixed words and ids, and the outcome `failed`. **`cleanup:
  'none'` is never said while a step that can make the user is still at work**: such a
  step, left at its limit and not ended when the clean-up stops waiting, with no user
  found, is `failed` too (`delete_user` `timeout`, no id), because it may make the user
  afterwards. Which steps can is one set, `SIGN_IN_TEST_STEPS_THAT_CREATE` (`verify_email`
  and no other): a stuck `sign_up`, `sign_in` or `first_factor` is `timeout` with `cleanup:
  'none'`, and a step that comes to create the account is added there. Keep the tests of
  each. **A step left at its limit outlives the answer, so the run has a `settled()`**
  (bounded by `SIGN_IN_TEST_SETTLE_MS`, below the shutdown timeout and a step's limit),
  which `closeApi` awaits after the listener stops and before the pool closes
  (`server-close.test.ts`). The
  retention job then removes the user (`users.deleteTestUsersBefore`,
  `TEST_USER_RETENTION`, recorded as the `system`'s `user.deleted`). That purge selects by
  the reserved domain alone: never widen it, and never delete a user there by a flag. It
  has a `try` of its own in the job, so that no other purge's failure takes it along: keep
  it apart, and keep its log line to fixed words, the environment and the error's name.
- **Hooks are asked and events are delivered, as for anyone**; `user.created` carries
  `test: true` (derived from the address where the account is made) and nothing else
  marks the run's events. The audit log names the caller on `sign_in_test.started`,
  `sign_in_test.finished` (written through `users.reportSignInTest`), the session it ends
  and `user.deleted`; the flow's own `user.created` keeps the user as its actor.
- **Never word a `passed` report as more than it is**: no application page, SDK, mail
  relay or webhook receiver was exercised, and no passkey, emailed link, texted code or
  provider is ever run.
