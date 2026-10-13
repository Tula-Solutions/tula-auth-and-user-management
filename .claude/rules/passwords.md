---
paths:
  - "apps/api/src/modules/password/**"
  - "apps/api/src/modules/flow/**"
  - "apps/api/src/modules/user/**"
---

# Password history and password expiry

Moved here from `AGENTS.md`, word for word, and canonical for this area: `AGENTS.md` lists
this file under "Area rules" and does not repeat it. A section named in a sentence as
"above" or "below" is found through that list.

## Password history (`modules/password`, see ADR 0038)

`password.history: N` refuses, as a user's new password, their current one and the N − 1
before it; `0` is off. The server keeps `Passwords.previousKept(N)` previous hashes per user
in `password_history`.

- **One place compares and one place writes.** `Users.replacePassword` is the only caller of
  `Passwords.assertNotReused` and of `users.setPasswordHash`. A user's own password (a
  change, a reset) is compared; **an administrator's is recorded and never refused** (a
  refusal would tell them a candidate is one of the user's old passwords). A first password
  is compared with nothing and keeps nothing. A new path that stores a password over another
  goes through `replacePassword` and gets a row in ADR 0038's table.
- **The comparison is the last check**: after the caller proved what its route asks for (the
  current password for a change, the emailed code for a reset) and after `Passwords.assess`,
  before the hash and before a reset's code is spent. Never move it earlier (an
  unauthenticated request must not reach N verifications) or later (a refusal must not spend
  the proof).
- **A reset's proof is the inbox alone, and that is accepted.** A reset stores its password
  before a second factor is asked for, so the holder of only the inbox of an account with a
  second factor reaches the comparison and learns from `password.reused` that a candidate is
  one of the last N. What bounds it: ten comparisons an hour per user, and a candidate that
  is not refused really replaces the password (every session ends, the owner is told).
  Never skip the comparison for users with a second factor (they alone could then reuse a
  password through a reset); ADR 0038 has the argument and a test pins it.
- **What a reset spends and ends happens once, before the first write** (`beforeStore`: the
  code, every session). A refusal on a later pass and the 503 leave the code spent and the
  sessions ended with the password unchanged: stated in ADR 0038, asserted by the tests of
  "a password that moved while it was being compared". Never move either after the write.
- **Every stored hash is verified, one after another, with no early exit**, and the
  verifications are never run side by side (each holds 64 MiB). They are not padded to N.
- **`password.reused` carries the policy's number and nothing else.** Never which password
  matched, how many did or an index: not in the error, a log line, an audit entry or an
  event. A refused change is not recorded.
- **The comparison is counted per user** (`PASSWORD_HISTORY_CHECKS_PER_HOUR`, just before
  the verifications, only for a user who has a password). It is what bounds the cost of a
  history of `MAX_PASSWORD_HISTORY` (24): the routes' own limits are per address. Never
  raise the ceiling or drop the limit without measuring again (ADR 0038 has the numbers).
- **The store keeps the old hash and trims in the transaction that stores the new one**
  (`setPasswordHash`'s `history.keep`), under the user's row lock (`FOR NO KEY UPDATE`), and
  the write is a compare-and-set on the hash the comparison was made against (`ifCurrent`):
  on `'stale'` the service compares again, uncounted, and after `PASSWORD_STORE_ATTEMPTS`
  answers 503 with nothing stored. Never store a password on a comparison that no longer
  holds.
- **`upgradePasswordHash` adds no history row** (it is the same password), **and
  `markEmailVerified` with `removePassword` deletes the user's history** in its transaction
  (the removed password was never the owner's). Rows go with their user by cascade.
- **A user has one row at a position, and the database says so**
  (`password_history_user_position_unique`, `DEFERRABLE INITIALLY IMMEDIATE`, hand-written
  in migration 0026 because Drizzle cannot declare it). Never replace it with a plain unique
  index: the shift `position = position + 1` is one statement and a plain index refuses it.
- **The purge never waits for a row a password change holds** (`FOR UPDATE SKIP LOCKED`, the
  batch built once as an array): rows it passes over go in a later round, so a return below
  the limit does not mean nothing is left. `storedPasswords` is two reads and no snapshot;
  the compare-and-set of the write is what covers a change between them.
- **A row is its `position`** (1 is the password before the current one). The purge of what
  a lowered number no longer keeps is `users.deletePasswordHistoryBeyond(environment, keep,
  limit)`, called from the retention job only, with the number read **past the settings
  cache**; a stored number that is not an integer from 0 to 24 deletes nothing. Raising the
  number brings nothing back, and the docs say so.
- **The React checklist never draws the rule as met** (`passwordHistoryRule`,
  `PasswordField`'s `history`): waiting for the server, or refused by it, on the account
  page and the reset; not at a sign-up. A refusal is about the password that was sent: the
  line waits again once the field is edited.

## Password expiry (`modules/flow`, `modules/password`, see ADR 0041)

`password.expiryDays: N` stops a sign-in **with the password** whose password was set N days
ago or longer: the attempt waits on `needs_new_password` with `reason: 'expired'` until a
new one is stored. `null` is off.

- **A password's age is `credentials.secret_changed_at` and nothing else.** It is written
  when a password is created or stored over another (`users.create`, `setPasswordHash`) and
  **never by `upgradePasswordHash`**: a re-hash is the same password. Never read
  `updated_at` for an age, and never write the column from a path that does not store a new
  password. **A replacement always moves it**: `setPasswordHash` stores the later of the
  writer's time and the stored time plus a millisecond, so the same time means the same
  password whatever a clock does. Never write the writer's time over it unconditionally.
  The shared store suite holds both in both adapters.
- **Whether a password has expired is asked in one place, `Flows.submitPassword`, after the
  password is verified** (and after the ban check and the hash upgrade), through
  `Passwords.expired`. Never before the verification, never for a wrong password, an unknown
  address or a locked-out one, and never at a start: their answers and their cost must stay
  the same whatever the age. Keep the side-by-side test (an expired account, a fresh one and
  no account) and the one that the question is not asked
  (`modules/flow/password-expiry.test.ts`).
- **Only a sign-in that proved the password is stopped.** An emailed code or link, a texted
  code, a passkey and a provider are not, and a reset is never sent to a second
  new-password step. `nextStatus` reads `passwordExpired` only for kind `sign_in`. Asking
  the other methods is a decision in ADR 0041, not an addition.
- **The new password comes last: after the emailed code of an unverified address and after
  the second factor or the enrolment.** Never move it before a second factor: the holder of
  an old password alone would then replace it, or probe it through `password.reused`.
  `Flows.submitSecondFactor` and `confirmFactorEnrolment` go through `nextStatus` for that
  reason; a new step that can be the last before `complete` does too.
- **The step is `needs_new_password` with `reason`, and `strategies` is empty exactly when a
  reason is given** (the contract's refinement). A reset's step has no reason. A new reason
  is an entry of `NewPasswordReasonSchema` and a screen; a client draws "not supported" for
  one it does not know.
- **`Flows.replaceExpiredPassword` stores nothing unless the stored password is still the
  one the attempt proved**: the credential's changed-at equals the attempt's
  `expiredPasswordSetAt`, `Passwords.assertNotReused` gets the hash read with that time
  (`proven`) and refuses **before anything is counted or verified** when the stored hash is
  another, and the write is a compare-and-set on it. Otherwise `flow.invalid_step`. Never
  drop one of the three: an attempt parked by whoever knew the old password must not
  overwrite a password the owner set meanwhile, nor ask whether a candidate is the new one.
  **The time says which password it is, the hash that nothing moved since it was read**: a
  hash that moved (another tab's sign-in upgrading it) is asked about again by the time,
  never taken for a replacement and never waved through (`compare` in
  `Users.replacePassword`; at most `PASSWORD_STORE_ATTEMPTS` passes, counted once). It also
  refuses a banned user and an attempt whose user confirmed a second factor it never proved.
- **The expired password is never its own replacement**, whatever `password.history` says:
  the comparison is made for `max(history, 1)` and `password.reused` carries that number.
  What the store keeps is the policy's own number (nothing, with a history of 0).
- **It is the user's own change** (`Users.replaceExpiredPassword` → `replacePassword`,
  `method: 'self'`): the policy, the history, the hourly allowance, the notice. Every session
  of the user ends **after** the store, never before it (the loser of two requests at once
  must not end the winner's new session). A refusal leaves the attempt on its step.
- **A sweep that fails after the store is tried three times, then said, and nothing
  remembers it** (`EXPIRED_PASSWORD_SWEEP_ATTEMPTS`, 20 and 40 ms apart). Then: 503
  `service.unavailable`, nobody signed in, the password is the new one, the sessions made
  under the old one alive until they end or an administrator ends them
  (`DELETE /v1/admin/users/:userId/sessions`), and an error logged with fixed words, the
  environment and the user id. That line is the only trace: never drop or quieten it, and
  never put the failure's own text in it. A retry answers `flow.invalid_step`; the user
  signs in again with the new password. The same holds, with the sessions ended, when
  `finish` fails after the store (a hook that refuses, a session limit). A stored "sweep
  owed" marker was decided against (ADR 0041); adding one is a decision. Tests pin the cost.
- **The step calls `requireProvenMethod`** like every parked step, and the hooks are asked
  where they always are (`finish`, `Sessions.create`): after the password is stored.
- **`expiryDays` is not a weakening**, set, shortened or removed (`settingsWeakenings`).
  Changing that is a decision.
- **A scenario that needs more than ten minutes to pass sets `needsTestClock`** and runs in
  process only; a live target skips it and CI's `self-host` jobs list it by name. Never add
  a route or a setting that ages a password on a running server.
