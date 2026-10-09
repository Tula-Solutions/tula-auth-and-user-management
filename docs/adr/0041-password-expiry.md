# ADR 0041: Password expiry

- **Status:** accepted
- **Date:** 2026-10-09
- **Ticket:** TULA-16 (phase 2, step 2.6)

## Context

The password policy has had an `expiryDays` field since Phase 0
([ADR 0006](0006-passwords.md)): validated, stored, shown in the dashboard, 90 in the
`legacy` preset, and enforced nowhere. [ADR 0038](0038-password-history.md) did the same
work for `history` and left expiry to this one.

Forced rotation is not a strength measure, and the `recommended` preset does not have it.
It exists because some operators' auditors require it. This ADR says what "expired" means,
where it is decided, what a user with an expired password can and cannot do, and what the
feature does not cover.

## Decision

### When a password was set

A password's age is counted from `credentials.secret_changed_at`, a column of its own:

- written when a password credential is created (a sign-up, an administrator's create, a
  first password by reset or set-password) and whenever `users.setPasswordHash` stores a
  password over another;
- **not** written by `upgradePasswordHash`, the rewrite of a hash with the server's current
  parameters after a sign-in. That is the same password, and `updated_at`, which it does
  move, is why `updated_at` could not be used.

**A replacement always moves it.** `setPasswordHash` stores the later of the writer's time
and the stored time plus one millisecond, in both adapters (the shared store suite holds
it). So "set at the same time" means "the same password" whatever a clock does: two writes
inside one millisecond, a clock put back, the fixed clock of a test. The step that replaces
an expired password rests on this (below). The price is that a password stored by a writer
whose clock is behind the stored time is stamped a millisecond after its predecessor, not
with the writer's time.

The column was added by migration `0029`. For the rows that existed, the true time was not
recorded anywhere, so the migration copies `updated_at`: the last time the row was written,
which is the last change **or** the last hash upgrade, whichever was later. So a backfilled
time is never earlier than the truth: no password is expired by the upgrade sooner than its
real age would have, and some are treated as newer than they are. The other choices were
`created_at` (wrong the other way for everyone who ever changed a password: they would be
locked into a renewal on a password set last week) and the time of the migration (everyone
gets a full period, and the operator cannot tell which passwords are how old).

### What "expired" means

`Passwords.expired(policy, changedAt, now)`: `expiryDays` is a whole number of days of at
least 1, and `now - changedAt >= expiryDays * 86,400,000 ms`. A password is good for exactly
that many days and expired from the instant they are over. `null` (the default) is no
expiry; a stored value that is not such a number expires nothing; an account with no
password has nothing that expires. The policy is the environment's as configured when the
password is typed.

### Where it is decided: after the password is proven, and nowhere else

`Flows.submitPassword` asks the question once, after `Passwords.verify` succeeded, the ban
check and the hash upgrade. A wrong password, an unknown address and a locked-out address
never reach it. Their answers (`auth.invalid_credentials`, `rate_limited`), their cost (one
argon2 verification) and what they leave behind are the same for an account whose password
has expired, one whose password is fresh and no account at all; a test puts the three side
by side and another asserts the question is not even asked. So expiry tells nobody anything
about an account they cannot already sign in to.

**Only a sign-in that proved the password is stopped.** An emailed code or link, a texted
code, a passkey and a provider sign in whatever the password's age: the user did not use the
password, and an environment that requires rotation of a credential nobody typed has asked
for nothing. An operator who wants every sign-in to pass through a fresh password has to
switch the other methods off; that is said in the docs.

### The step, and its order

The attempt stops at the existing `needs_new_password`, with a reason:

```json
{ "status": "needs_new_password", "destination": "m***@northline.app",
  "strategies": [], "reason": "expired" }
```

`reason` is new and optional (`NewPasswordReasonSchema`, a closed list of one). A password
reset's step is unchanged: no `reason`, and `strategies: ['email_code']`. `strategies` says
what accompanies the new password; for an expired password nothing does, so it is empty, and
the contract holds the two together (empty exactly when a reason is given). Reusing the
status and making the reset's emailed code optional by shape was preferred over a new
status: every client already has a "choose a new password" screen to route to, and a client
that does not know `reason` shows its "not supported" screen for a sign-in on this step,
which is what it did before.

The order is: first factor (the password), an unverified address's emailed code, the second
factor or the enrolment a `required` policy asks for, **then** the new password, then
`finish`. `nextStatus` takes `passwordExpired` in its context, and only a sign-in whose
first factor was the password reads it. The new password comes last on purpose:

- someone who holds only the old password of an account with a second factor never reaches
  the step that replaces it, and learns nothing from it;
- by the time a password is stored, everything a session would need has been proven, so
  storing it and creating the session are one request.

The state of the attempt keeps one new thing, `expiredPasswordSetAt`: when the password it
proved was set. Nothing of the hash, and not the age.

### Replacing it

`POST /v1/client/sign-ins/:attemptId/new-password` with `{ password }`
(`Flows.replaceExpiredPassword`). In order: `load` (the attempt's secret, the origin of a
browser attempt), the step, `requireProvenMethod` (the password method still on), the
environment's ceiling, then:

1. **The stored password is still the one the attempt proved.** The credential's
   `secret_changed_at` must equal `expiredPasswordSetAt`; the hash read with that time is
   handed to `Passwords.assertNotReused` (`proven`), which refuses, before anything is
   counted or verified, when the stored hash is another; and the write is a compare-and-set
   on it. Otherwise `flow.invalid_step` (409): the attempt has proven nothing about the
   password the account has now. Without this an attempt left on the step by whoever knew
   the old password could, for the ten minutes it lives, overwrite a password the owner set
   meanwhile by reset, or ask through `password.reused` whether a candidate is the new one.

   **The time says which password; the hash says nothing moved since it was read.** The
   hash of one password changes (the upgrade after a sign-in in another tab), so a hash
   that moved is not by itself a replacement. When either hash check misses, the time is
   read again with the hash: still the attempt's time means the same password under a new
   hash, and the step carries on with that hash (at most three passes, the comparison
   counted once); any other time is a replacement and ends in `flow.invalid_step`. The
   time alone would not be enough (a replacement could land between its read and the
   write), and neither would the hash alone (it cannot tell an upgrade from a
   replacement): each pass needs the time to be the attempt's **and** the store's
   compare-and-set on the hash read with it to hold. That the time cannot be the same for
   another password is the store's rule above, not an assumption about clocks.
2. The user is not banned (`auth.user_banned`), and has not confirmed a second factor since
   the attempt passed that point (`flow.invalid_step`: the attempt would otherwise get a
   session past a factor it never proved).
3. `Users.replaceExpiredPassword`, which is `Users.replacePassword` with two differences
   (below), then every session of the user ends, then `finish`.

A refused password (a `password.*` code, `password.reused`, `rate_limited`) leaves the
attempt on the step: the user tries another. It is the user's own change in every respect:
compared with the history, counted against `PASSWORD_HISTORY_CHECKS_PER_HOUR`, recorded as
`user.password_changed` with `method: 'self'`, announced by `notifications.passwordChanged`
as changed by the user. No event field was added; the contract's `method` already says who.

**The expired password is always refused as its own replacement**, with `password.reused`,
also where `password.history` is 0: otherwise the user types the old password again and the
expiry has asked for nothing. The comparison is made for `max(history, 1)` passwords and the
error's `params.history` is that number (1 with no history: "not the one you have now").
What the store *keeps* is still the policy's own number, so with `history: 0` nothing of the
expired password is kept and the user can change back to it the next day through the account
page. An operator who wants that closed sets a history; the docs say so.

**Every session of the user ends, after the password is stored.** Not "every other": the
sign-in that asked has none yet. After, not before as a reset does: of two requests at once
only the one whose password was stored ends anything, so the loser cannot end the session
the winner's sign-in was just given.

### When the request fails after the password is stored

The store cannot be taken back, and two things still follow it.

**The sweep.** If ending the sessions fails it is tried again: three tries in all, 20 ms
and then 40 ms apart (60 ms of waiting at most; a user is waiting, and a session store that
is away for longer is not waited out by a request). If the third fails:

- the answer is `service.unavailable` (503) and nobody is signed in;
- the password **is** the new one, recorded and announced;
- the sessions made under the old password are still alive, and stay so until they end by
  their profile's limits, the user signs out of them, or an administrator ends them;
- an error is logged, with fixed words, the environment's id and the user's id and nothing
  else: "a password that replaced an expired one was stored, and the user's earlier
  sessions could not be ended". An operator who sees it ends that user's sessions with
  `DELETE /v1/admin/users/{userId}/sessions`.

Nothing remembers that the sweep is owed: no marker is stored and no later sign-in does it.
A marker would be a second piece of state to keep true for a failure that needs the session
store to be away for three tries right after the user store answered; the log line and the
503 were preferred. A retry of the request does not do it either: the attempt proved the
old password, the account has the new one, and the answer is `flow.invalid_step`.

**The session.** `finish` then spends the attempt, asks `before_session` and creates the
session (`before_token` inside it). A hook that refuses or fails, a session limit that
refuses the newest, or a store that is away leaves the new password in place, the earlier
sessions ended and no session.

In both cases the user signs in again with the new password, which is not expired. That is
the same shape as a reset refused by a hook.

### What clears an expiry

Any stored password is new: the step above, a signed-in user's change (whose current-password
check does not look at the age: a signed-in user with an expired password can simply change
it), a reset, an administrator's set-password. A reset is never sent to a second
new-password step.

### The path through `Users.replacePassword`

The row this ADR adds to the table of [ADR 0038](0038-password-history.md):

| Path | Compared with the history | What the store keeps |
| --- | --- | --- |
| Replacing an expired password at a sign-in (`…/sign-ins/:id/new-password`, `Users.replaceExpiredPassword`) | Yes, and with the current password also where `history` is 0 | The hash that stops being current, as far as `history` keeps any. |

## Consequences

- **An environment that already has a number in `password.expiryDays` sees it enforced from
  this version on.** That is every environment on the `legacy` preset (90), a deployment
  with `PASSWORD_POLICY=legacy` for the environments that saved nothing, and any custom
  policy that set it. Counted from each password's backfilled time: users whose password
  row was last written longer ago than the period are asked for a new password at their
  next sign-in with it. The upgrade notes say so and tell operators to check before
  upgrading.
- Setting or shortening `expiryDays` is **not** a recorded weakening, and neither is
  removing it (`settingsWeakenings` does not list it: rotation is not a strength measure,
  and this ADR did not change that). The dashboard saves it without a confirmation.
- There is no warning before a password expires, no grace period and no "expires in N days"
  in any answer. A user finds out at the sign-in.
- A user who never signs in with the password is never asked. Sessions that exist when a
  password expires go on: expiry is a rule about signing in, not about being signed in.
- `expiryDays` has no upper bound in the contract. This ADR did not add one.
- Of two requests at once on one attempt, one stores its password and gets the session.
  The other's write misses the compare-and-set on the hash, reads the time again, finds the
  stored password is no longer the one the attempt proved and is refused
  (`flow.invalid_step`) with nothing stored and no session ended.
- **A client older than this release cannot finish a sign-in with an expired password.** An
  older `@tula/react` shows "This step is not supported" for the step, and an app on an
  older `@tula/core` has no call for it. Upgrade the clients before the server, or keep
  `expiryDays` at `null` until they are.
- The conformance scenario "password expiry" needs a day to pass, and a live server's clock
  cannot be moved over HTTP. The scenario format gained `needsTestClock`: a scenario with a
  `wait` longer than ten minutes must set it, and a target whose `wait` is a real sleep
  skips it. It runs in process as part of `verify`; CI's `self-host` jobs skip it by name.
  No test-only route and no sub-day setting was added to make it run live.

## Alternatives considered

- **A new step status** (`needs_password_change`). Cleaner on paper, and every client that
  does not know it shows nothing useful. The existing status with a reason degrades to the
  same "not supported" screen and lets clients share the screen.
- **The new password before the second factor.** One screen earlier for most users, and the
  holder of an old password alone could then replace it, or probe it, without the factor.
- **Refusing the sign-in and sending the user to the reset.** No new route, and it asks a
  user who just proved the password to prove the inbox too, and makes expiry a reason to
  start an email flow nobody asked for.
- **Expiring sessions when a password expires.** A different feature (a session's absolute
  lifetime already exists, [ADR 0028](0028-session-profiles.md)).
- **Asking every sign-in method.** See "Only a sign-in that proved the password is stopped".
- **A test-only way to age a password** (a route, or `expiryDays` in seconds outside
  production). Either is a way to make every user's password expire at once that exists in
  the shipped server.
