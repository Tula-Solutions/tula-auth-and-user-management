---
paths:
  - "apps/api/src/modules/mfa/**"
  - "apps/api/src/modules/factor/**"
  - "apps/api/src/lib/totp*"
  - "apps/api/src/middleware/recent-auth*"
  - "apps/api/src/modules/flow/**"
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
