---
paths:
  - "apps/api/src/modules/mfa/**"
  - "apps/api/src/modules/factor/**"
  - "apps/api/src/lib/totp*"
  - "apps/api/src/middleware/recent-auth*"
  - "apps/api/src/modules/flow/**"
  - "apps/api/src/modules/session/router*"
---

# Two-step verification and step-up

Moved here from `AGENTS.md`, word for word, and canonical for this area: `AGENTS.md` lists
this file under "Area rules" and does not repeat it. A section named in a sentence as
"above" or "below" is found through that list.

## Security rules (non-negotiable)

- **TOTP secrets are sealed, backup codes are keyed hashes.** A TOTP secret is stored only
  sealed with `~/lib/secret-box` (purpose `totp-secrets`, bound to environment, user and factor
  id) and returned once, at enrolment. Backup codes are stored only as
  `~/lib/keyed-hash` HMACs bound to the user, returned once, and spent with a guarded update.
  Neither, nor a code or an `otpauth://` URI, ever reaches a log, an audit entry, an email or
  an error. Check codes only through `Mfa.verifyTotp` / `Mfa.verifyBackupCode`: they enforce
  "confirmed factors only" and the replay rule (a TOTP time step is accepted once, as a
  compare-and-set on `last_used_step`). A pending enrolment never counts as a factor.
- **A texted code is the weakest second factor, and one function says so**
  (`Mfa.isStrongSecondFactor`, with `Mfa.meetsSecondFactor` built on it; ADR 0025, "a texted
  code as the second factor"). Never compare a method with `'sms_code'` anywhere else to
  decide what a user is asked for. `Mfa.secondFactors` lists `sms_code` **alone or not at
  all**: beside an authenticator app or a passkey in force it is dormant, neither offered
  nor accepted, at a sign-in, a reset and a step-up. A texted code records `sms` in `amr`
  and **never `mfa`**; where it is a user's only second factor a session must hold `sms`
  and something that is not `sms` (two texted codes are one phone). It never removes or
  resets a factor and is never a recovery path; the admin reset removes it too.
- **`mfa.smsCode` is off by default and is asked on every step that sends or accepts such a
  code** (`Mfa.requireSmsFactor`: the switch, then `Settings.requireSms`, then
  `Sms.requireSender`), before anything is counted, spent or sent. **Off means refused,
  never skipped**: `secondFactors` keeps listing an enrolled texted code when the switch,
  text messages or the number's country go away, so its user is locked out rather than let
  in with one factor. Switching it on is a weakening only where the policy is `required`
  after the change (`settingsWeakenings`: `mfa.smsCode`).
- **A texted second-factor code is issued in one place, `Mfa.textSecondFactorCode`**, for
  its three purposes (`sms_factor_enrolment`, `sms_second_factor`, `sms_step_up`): through
  `Sms.sendCode` with the asker `second_factor`, `Verification.LIMITED_BY_DELIVERY`, a
  keyed hash that covers what asked (the session or the attempt) and the number, the send
  awaited, and no token stored for a message that was not taken. Nothing texts a code by
  arriving at a step: a client asks (`second-factor/prepare`, `step-up/sms-code`,
  `me/factors/sms`). Keep the cross-purpose tests in `modules/mfa/sms-factor.test.ts`.
- **The texted factor is the account's proven number and nothing else**
  (`users.sms_factor_enabled_at`, on only with a number: `users_sms_factor_needs_number`).
  No request names a number for it, and `setPhoneNumber` / `removePhoneNumber` clear it in
  their own transaction with its activity (`user.sms_factor_removed`). It is enrolled only
  by a signed-in user with no strong factor, after a step-up, never inside a sign-in
  (`ENROLMENT_METHODS` stays `['totp']`).
- **"No stronger factor" is one rule, asked inside the write that turns a texted code on**
  (`Mfa.smsFactorAllowedBeside`: no confirmed authenticator, no usable passkey).
  `users.enableSmsFactor` takes it, reads what the user holds under the user's row lock in
  its own transaction and answers `'stronger_factor'` with nothing written or recorded;
  the service's earlier look is a courtesy. Never guard that write on the number alone,
  and never state the rule a second time. A write that gives a user a stronger factor
  takes the same row lock (`PasskeyStore.create`, `FactorStore.confirmTotp`): a new one
  does too, with a row in the shared user-repository suite.
- **A texted code beside a stronger factor is dormant, and live again when the stronger
  factor goes.** Confirming an authenticator or adding a passkey does not remove an
  enrolled texted code; removing the stronger factor (its owner, after a step-up with it)
  makes the next sign-in ask for `sms_code` again, with no new entry and no notice. Never
  clear `sms_factor_enabled_at` when a stronger factor arrives, and never add a notice
  kind for the revival. A passkey that takes the second step over has no backup codes:
  `<UserProfile>` says so before the ceremony, and that string and its test stay. Tests
  pin both orders in `modules/mfa/sms-factor.test.ts`.
- **Every route that checks a TOTP, backup or texted second-factor code counts the guess** under the one per-user key
  `Mfa.secondFactorLockKey` (`CREDENTIAL_LOCKOUT`), before the check, and clears it on success.
- **Sensitive account changes need a recent authentication.** Put `requireRecentAuth()`
  (`~/middleware/recent-auth`) after `sessionAuth()` on any route that changes how an account
  is protected (MFA changes; a password change by a user who has a second factor; passkey
  changes and account deletion when they arrive). It reads `auth_time` and `amr` from the
  verified access token and answers `auth.step_up_required` with `params.methods`. A user with
  a second factor steps up with it, never with the password alone
  (`POST /v1/client/sessions/step-up`).
- **A user without a second factor may step up with an emailed code; a user with one never.**
  `Mfa.stepUpMethods` is the only place that decides what a user can step up with:
  `email_code` is listed exactly for a verified address and no confirmed second factor (next
  to `password` when there is one). The code (`POST /v1/client/sessions/step-up/email-code`,
  `Mfa.prepareStepUp`) is a verification token of purpose `step_up`, stored as a keyed hash
  that also covers the asking session's id, so it steps up no other session and is honoured
  for no other purpose; it carries no link. Guesses count under the non-MFA step-up key
  (`step_up:<environment>:<user>`, shared with the password) before the check, and success
  records `email` in `amr`. Never offer it beside a second factor, and never let it satisfy
  `mfa` (ADR 0025, "Step-up by emailed code").
- **Nothing removes a second factor except its owner (after a step-up) or an admin reset.** A
  password reset stops at `needs_second_factor`; there is no emailed MFA bypass; the policy
  `off` still asks enrolled users for their factor.

## What to test

The failure paths a change here is held to (moved from the checklist of `security.md`; the
rules themselves are above and are not repeated).

- **TOTP:** RFC 6238, SHA-1, 6 digits, 30 s; the current step ± 1 only, every candidate
  compared in constant time. A step is accepted once through `FactorStore.useTotpStep`
  (strictly greater than the last used step): test the same code twice in sequence and at
  once, and an earlier step's code after a later one. Test that a sealed secret copied to
  another user's or another environment's row does not verify, and that a pending
  (unconfirmed) or lapsed enrolment never satisfies a sign-in or a step-up.
- **Backup codes:** input normalised (case, spaces, dashes); single use under concurrency;
  another user's code refused; all replaced on regeneration and deleted when two-step
  verification is turned off or reset.
- **Second-factor guesses:** one budget across methods and routes (sign-in, reset, enrolment
  confirmation, step-up). No tokens and no session exist at `needs_second_factor` or
  `needs_factor_enrolment`.
- **Step-up:** a stale `auth_time` (refused), a fresh one (accepted), a refreshed token
  (claims unchanged: `auth_time` and `amr` come from the session row, never from the
  request), and that a user with a second factor cannot step up with the password alone.
  Guesses at the password on one route (a password step-up, the current password of a
  change) use up the other's budget.
- **Step-up by emailed code:** a user with a second factor is refused both the send and the
  code; a code asked by another session, another user or for another purpose
  (`email_verification`, `password_reset`, `sign_in`) steps up nothing, and a `step_up` code
  is honoured nowhere else; expired, reused, replaced and out-of-guesses codes; the guess
  counted before the check; the send limits; and neither the code nor the address in a log
  line, an audit entry or a limiter key.
- **Secrets never leak:** no Base32 secret, `otpauth://` URI, backup code or TOTP code in a
  log line, an audit entry, an email or an error body. Only the responses that return them
  (start, confirm, regenerate, in-flow confirm) carry them, with `Cache-Control: no-store`.
- **Recovery:** a password reset neither removes nor bypasses a second factor, and the admin
  reset ends every session. The admin reset (`modules/mfa/router.ts`) removes every passkey
  too, is never refused as "the last way in", and says what that left:
  `x-tula-can-still-sign-in` on its 204 and `canStillSignIn` on the audit entry, by
  `OAuth.canStillSignIn` (test a passkey-only user: `false`).
- **Step-up:** a route that changes how an account is protected has `requireRecentAuth()`.
- **A texted code as the second factor,** for every change to it: a user with an
  authenticator app or a passkey in force is neither offered nor accepted a texted code at a
  sign-in, a reset and a step-up; a texted code records `sms` and never `mfa`; a texted
  sign-in code plus a texted second step is refused before the code is spent
  (`mfa.needs_other_sign_in`); a code of another purpose (`sms_factor_enrolment`,
  `sms_second_factor`, `sms_step_up`, `phone_verification`, `sms_sign_in`), another
  session's or another attempt's, or one texted to a number the account no longer holds, is
  refused everywhere else; the guess is counted before the check; a failed send stores no
  token; removing or replacing the number removes the factor in the same transaction,
  recorded and announced; and no number, masked or not, is in an event, an audit entry or a
  log line. Keep the tests that confirm an authenticator and add a passkey between the look
  and the write of `users.enableSmsFactor` (refused, nothing recorded), the suite's rows, and
  the tests of both orders of a dormant code.
