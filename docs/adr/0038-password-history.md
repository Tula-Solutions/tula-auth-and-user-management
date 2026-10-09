# ADR 0038: Password history

- **Status:** accepted
- **Date:** 2026-10-09
- **Ticket:** TULA-15 (phase 2, step 2.6)

## Context

The password policy has had a `history` field since Phase 0 ([ADR 0006](0006-passwords.md)):
validated, stored, shown in the dashboard, and enforced nowhere. An operator who set it to 5
had a policy that said "the last five passwords cannot be used again" and a server that kept
one hash per user and compared with none.

Enforcing it means keeping hashes of passwords a user no longer has. That is a new kind of
row with a cost on both sides: a hash of an old password is still a hash of something the
user may use elsewhere, and comparing a candidate with N argon2id hashes costs N times what a
sign-in costs. This ADR says what is kept, when it is compared, what it costs and what bounds
that. Expiry (`expiryDays`, TULA-16) is not part of it.

## Decision

### What the number means

`password.history: N` refuses, as a user's new password, **their current password and the
N − 1 before it**. So `1` means "not the one you have now", `0` means the rule is off, and
the server keeps `max(N − 1, 0)` previous hashes per user (`Passwords.previousKept`). The
ceiling is 24 (`MAX_PASSWORD_HISTORY` in `@tula/contract`).

With `history: 0` nothing is read, compared or kept: a password change is what it was before
this ADR, except for the lock described under "Two changes at once".

### One place compares, one place writes

`Users.replacePassword` is the only function that stores a password over another one, and it
is where the rule lives. Every path that stores a password hash, and what the history is for
it:

| Path | Compared with the history | What the store keeps |
| --- | --- | --- |
| A signed-in user's change (`POST /v1/client/me/password`, `Users.changePassword`) | Yes | The hash that stops being current. |
| A reset (`…/password-resets/:id/password`, `Users.resetPassword`), also for an account an administrator made: "sign-up after admin create" is the owner's reset | Yes, with whatever is stored: the password the administrator set is one of the last N | The hash that stops being current. |
| An administrator's set-password (`PUT /v1/admin/users/:id/password`, `Users.setPassword`) | **No** | The hash that stops being current. |
| A first password: a sign-up with a password, an administrator's create with one, a reset or a set-password on an account that has none | Nothing to compare with | Nothing: there was no password before it. |
| The hash upgrade after a sign-in (`upgradePasswordHash`) | No: it is the same password | Nothing, and no second copy: the current hash is rewritten in place. |
| The removal of a password nobody proved (`markEmailVerified` with `removePassword`, [ADR 0024](0024-email-sign-in.md)) | No | **The history is deleted** in the same transaction. |
| Deleting a user | No | The rows go with the user (`ON DELETE CASCADE`). |

Three of those rows are decisions and not consequences.

*An administrator's password is recorded and never refused.* An administrator does not know
a user's old passwords, and a refusal would tell them that a candidate is one of them: an
oracle on someone else's password, for the holder of a secret key. What they set does enter
the history, so the user cannot change straight back to the one before it.

*The removed password takes its history with it.* That password was put on an unverified
account by someone other than the address's proven owner. Keeping it, or anything before it,
would let whoever made the account decide which passwords the owner may not choose, and
learn from a refusal that the owner tried one.

*An account with no password is compared with nothing.* A user who signed up with a provider
or an emailed code has no current password: their first one is never refused, nothing is
counted for them and nothing is kept until they replace it.

### Where the comparison sits

Last. `replacePassword` runs the policy's own rules first (`Passwords.assess`: length,
classes, the breach check), and its callers have by then proven what their route asks for:
the current password under the lockout for a change, the emailed code for a reset. Only
then is the candidate compared, so that an unauthenticated request never reaches N
verifications, a wrong guess is never amplified, and a candidate the policy would refuse
anyway costs nothing more. The new password is hashed after the comparison, and a reset's
code is spent after that: **a reset refused for reuse has not spent its code**.

### A reset's proof is the inbox alone

For a change the proof is the current password. For a reset it is the emailed code and
nothing else, **also for a user with a second factor**: `Flows.resetPassword` stores the
new password and only then moves the attempt to `needs_second_factor`
([ADR 0025](0025-mfa.md): the factor gates the session, not the reset). So whoever holds
only the inbox of an account that has a second factor reaches the comparison, and
`password.reused` tells them that a candidate is one of the owner's last N passwords. They
can ask again with the same code, which a refusal does not spend.

That is accepted, and bounded:

- Ten comparisons an hour for the account, whoever asks (`PASSWORD_HISTORY_CHECKS_PER_HOUR`),
  within an attempt that lives ten minutes.
- One code asks at most five times. `Verification.verifyCode` counts every submission of a
  code before it compares it, a right code included (`MAX_ATTEMPTS`), so a refusal, and a
  `rate_limited` answer from the allowance above, leaves the code unspent but one try
  poorer.
- The allowance is the account's, so whoever can reach the comparison can also use it up:
  for the rest of that hour the owner's own reset or change answers `rate_limited`. That
  takes the inbox (a reset) or the current password (a change), and the same person could
  replace the password instead.
- An answer other than a refusal is not free: a candidate that is not one of the last N
  **replaces the password**. That ends every session of the user and is announced to the
  owner by email, so the question cannot be asked quietly about a password the owner never
  had; a refusal itself changes and announces nothing.
- The same person already has the larger power: with the inbox alone they can replace the
  password outright.

The alternative was not to compare for a user with a second factor. It was not taken: those
users, and only those, could then reuse any password through a reset, and the rule would be
weakest for the accounts whose owners did the most to protect them. Proving the second
factor before the password is stored would be a change to the reset itself (ADR 0025), not
to this rule. A test pins what happens (`modules/password/history.test.ts`, "a reset proves
the inbox and nothing more").

`Passwords.assertNotReused` verifies the candidate against every hash it read, the current
one and the previous ones, one after another, **with no early exit**: a match must not
answer sooner than no match. The verifications are not padded to N. A user who has had two
passwords under a history of 24 costs two verifications, so the time an answer takes says
how many passwords the server keeps for the caller's own account (which they know), never
which one matched.

### The refusal

`password.reused`, 422, with a field error on the password field and `params.history: N`
(the policy's number, which `GET /v1/client/config` already publishes). Nothing says which
password matched or how many did: no index in the error, no log line, no audit entry, no
event. A refused change is not recorded at all, and a change that goes through records what
it always did (`user.password_changed` with `method`): the event's payload is unchanged.

### What is stored

`tula.password_history` (migration `0026`): a tenant table (`project_id`, `environment_id`,
the composite keys, fail-closed row-level security, forced), one row per previous hash, with
a foreign key to the user that cascades. A row holds the argon2id hash exactly as the
credential held it, and a `position`: 1 is the password before the current one, 2 the one
before that.

The position is written out, not derived from a time, for the sake of the purge below:
"everything beyond what the policy keeps" is then `position > keep`, a range of one index
on `(environment_id, position)`, where an ordering by time would need a window over every
user's rows.

The store's `setPasswordHash` does all of it in the transaction that stores the new hash and
the audit entry: it deletes the rows at `position >= keep`, moves the rest one place down
and inserts the hash that stops being current at position 1. So the table never holds more
than the policy keeps for a user who has changed their password since the policy was set,
and a failed write leaves the credential and the history as they were.

A user has one row at a position, and the database holds that itself:
`password_history_user_position_unique`, a `UNIQUE (user_id, position)` constraint that is
`DEFERRABLE INITIALLY IMMEDIATE`. The store keeps it true already (it moves a user's rows
under the lock of the user's row); the constraint is the backstop for a writer that does
not. It is deferrable because the move is one statement (`position = position + 1`): a
plain unique index is judged row by row and would refuse it as soon as the row at 1 landed
on the row still at 2, where a deferrable constraint is judged when the statement ends.
Drizzle cannot declare one, so it is written by hand in the migration, and its index is
what a user's rows are read by.

`storedPasswords` reads the current hash and the previous ones in two statements: it is not
a snapshot, and does not need to be. What covers a change that lands between or after them
is the compare-and-set of the write ("Two changes at once").

The runtime role may `SELECT`, `INSERT` and `DELETE`, and `UPDATE` only `position` and
`updated_at`: no statement of the API can rewrite a stored hash or move a row to another
user. Nothing reads the table but `storedPasswords`, and no route, event, log line or
`@tula/mcp` projection returns a row of it.

### Lowering and raising the number

*Lowering* it (to 0 too) deletes hashes, at two moments. A user's next password change trims
their rows to the new number in its own transaction. For everyone else the retention job
does it ([ADR 0017](0017-retention.md)): `purgePasswordHistory` reads each environment's
`password.history` **past the settings cache** (a stale, lower number would delete what the
operator still wants) and drains `users.deletePasswordHistoryBeyond(environment, keep,
limit)` in batches. A batch is picked `FOR UPDATE SKIP LOCKED`: the purge never waits for a
row a password change holds (the two lock rows in different orders, and the victim of a
deadlock could be the user's request), and what it passes over goes in a later round. A stored number that is not an integer from 0 to 24 deletes nothing. The
job logs the environment, the number and the count, never a user or a hash.

*Raising* it cannot bring anything back: what was never kept, or was deleted, cannot be
compared with. After a raise from 2 to 10 a user is held to ten passwords only once they have
had ten. The docs say so.

Lowering `password.history` is a weakening (`settingsWeakenings`, as it has been since the
field existed): the audit entry says `weakened: true`, `tula apply --yes` needs
`--allow-weaker` and the dashboard asks first.

### Two changes at once

Two requests that change one user's password at the same moment could each compare with the
same snapshot and each store: the second would then be stored without having been compared
with the first. Two things rule that out.

- The store takes the user's row `FOR NO KEY UPDATE` (it was `FOR SHARE`), so password
  writes of one user happen one after another, and the history's positions are never moved
  by two transactions at once.
- The write is a compare-and-set: `setPasswordHash` is told the current hash the comparison
  was made against (`ifCurrent`) and answers `'stale'`, storing nothing, when that is no
  longer the current one. `replacePassword` then compares again with what is stored now
  (not counted a second time) and tries again, three times in all, and after that answers
  503 with nothing stored.

A hash upgrade at sign-in changes the current hash too, so it also makes a concurrent change
compare again: correct, and rare.

Two costs are accepted, both a reset's. What a reset spends (`claim`: its code) and ends
(every session of the user) happens once, after the first comparison and the hash and
**before the first write**, and is not undone by what follows:

- Where another change of the same user lands between a reset's comparison and its write,
  and the second comparison then refuses (`password.reused`), the code is spent, the
  sessions are ended and the password is unchanged. It takes two simultaneous changes of
  one account to the same password.
- Where the write is still stale after `PASSWORD_STORE_ATTEMPTS` passes (503), the same:
  code spent, sessions ended, nothing stored by this request. It takes a password that
  another request changes three times while this one is being written.

In both the user asks for another code and signs in again. The order is kept: spending the
proof after the write would let one code store two passwords, and ending the sessions after
it would leave a moment with the new password and the old sessions alive, which is the
state a reset exists to prevent (ADR 0015). The tests of "a password that moved while it
was being compared" assert the claim and the ended sessions, so that a reordering is a
decision.

### What 24 verifications cost, and what bounds it

Measured on an Apple M4 Pro (14 cores), Bun 1.4.2, with the server's argon2id parameters
(64 MiB, 2 passes):

| What | Time |
| --- | --- |
| One hash | about 60 ms |
| 24 verifications, one after another (a full history) | 1.43 to 1.47 s, about 59 ms each |
| The same, 4 callers at once | 1.57 s each |
| The same, 10 callers at once | 1.90 s each |

Each verification holds 64 MiB for its duration; because they run one after another a
comparison holds one such block at a time, not 24.

The limits that already stood in front of the two routes are per address and per
environment: a password change is 10 a minute per IP address (`PASSWORD_CHANGE_RATE_LIMIT`),
a reset's submit 30 a minute per IP address (`CREDENTIAL_RATE_LIMIT`) and 3,000 a minute per
environment (`verify`), and a reset's code allows five guesses. None of them is per account.
A change with a history of 24 costs about 25 times a change without one, and someone with one
account and many addresses could have asked for that as often as their addresses allowed.

So the comparison has a limit of its own, **per user**: `PASSWORD_HISTORY_CHECKS_PER_HOUR`,
10 an hour, counted just before the verifications and only for a user who has a password
(key `password_history:<environment>:<user>`; it fails closed like every limit). Over it the
answer is `rate_limited` with `Retry-After`. One account can therefore cost at most ten
comparisons an hour whoever asks and from wherever: at the ceiling, about 15 seconds of one
core an hour. An attacker needs an account per ten comparisons, and making accounts is
bounded by the sign-up limits.

With that in place the ceiling stays at 24, the number common compliance rules ask for.
Lowering it instead would have been the other answer (it is one constant); it was not taken
because the cost per account is bounded either way and an operator under such a rule needs
the number.

The limit is also the rule's own guard: cycling through passwords to push an old one out of
the history is ten changes an hour at most.

## Consequences

- An environment with `history` above 0 keeps hashes of passwords its users no longer have.
  They are argon2id, per user, reachable only through the store, deleted with the user, with
  an unproven password, and when the policy no longer keeps them. A database leak exposes
  them as it exposes the current hashes.
- A deployment that had set `history` and never saw it enforced sees it enforced from this
  version on, starting with an empty history: nothing from before was kept. That includes
  every environment on the `strict` preset, whose `history` has always been 5. The upgrade
  notes say so.
- A change of password is at most ten an hour per user where a history is on. A user who is
  refused eleven times in an hour waits.
- A reset refused for reuse can be retried with the same code, like one refused by any other
  rule.
- The React components list the rule where a password replaces one (the account page and the
  reset), as waiting for the server or refused by it, never as met: a browser cannot judge
  it. A sign-up does not list it: a first password has no history.

## Alternatives considered

- **Comparing in the store, in one transaction with the write.** It would need no
  compare-and-set, and would hold a row lock and a database connection for a second and a
  half of argon2id. The comparison stays in the service.
- **Padding to N verifications.** It hides how many passwords the caller's own account has
  had, which the caller knows, at the price of the full cost for every change.
- **A time instead of a position.** Simpler writes, and a purge that has to rank every
  user's rows to find the ones beyond N.
- **Refusing an administrator's password too.** See "One place compares, one place writes".
