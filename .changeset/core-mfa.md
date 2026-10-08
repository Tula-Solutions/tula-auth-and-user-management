---
'@tula/core': minor
---

Two-step verification and step-up in the headless client.

- `tula.mfa`: `get()`, `startTotp()`, `confirmTotp({ code })`, `disableTotp()` and
  `regenerateBackupCodes()` for the signed-in user. `confirmTotp` refreshes the session
  afterwards, so its next access token says the second factor was proven; the backup codes are
  returned whether or not that refresh could be made.
- `tula.session.stepUp(proof)`: proves a password, an authenticator code or a backup code again
  and installs the fresh access token for the same session (the refresh token is untouched).
  New helpers `isStepUpRequired(error)` and `stepUpMethods(error)` read an
  `auth.step_up_required` error; the client never prompts or retries by itself.
- Flows: `submitSecondFactor({ method, code })` on sign-in and password-reset flows, and
  `startTotpEnrolment()` / `confirmTotpEnrolment({ code })` on all three for the new
  `needs_factor_enrolment` step. They resolve with `{ step, backupCodesRemaining? }` and
  `{ step, backupCodes, failure? }`.
- The TOTP secret, its URI and backup codes are handed to the caller once and stored nowhere
  in the client. Every new 200 is checked before anything is built from it (`response.invalid`).
- A session token another tab announces late no longer replaces a newer one for the same
  session.
- New types: `Factors`, `TotpEnrolment`, `BackupCodes`, `SecondFactorProof`, `StepUpProof`,
  `StepUpMethod`, `MfaPolicy`, `FactorEnrolmentMethod`, `SecondFactorResult`,
  `FactorEnrolmentResult`. `ClientConfig` gains the optional `mfa.policy`.
