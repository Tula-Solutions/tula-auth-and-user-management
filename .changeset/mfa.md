---
'@tula/contract': minor
'@tula/react': minor
---

Two-step verification: an authenticator app (TOTP), backup codes, step-up and a policy per
environment.

- `@tula/contract`: new flow step `needs_factor_enrolment { methods }` and request shape
  `SecondFactorRequest`; `FlowAttempt` gains the optional `backupCodes` and
  `backupCodesRemaining`. New `Factors`, `TotpEnrolment`, `TotpConfirmRequest`, `BackupCodes`,
  `StepUpRequest` and `StepUpMethod`. Access-token claims gain `auth_time` (when the user last
  proved a factor for the session; refreshing does not move it) and `amr` (what they proved:
  a set, whose order is not part of the contract), with `AUTHENTICATION_METHODS` and
  `STEP_UP_MAX_AGE_SECONDS`. `EnvironmentSettings` gains `mfa.policy` (`off`, `optional` by
  default, `required`) and `notifications.mfaChanged`; `ClientConfig` gains the optional
  `mfa.policy`. New error codes `mfa.invalid_code`, `mfa.already_enabled`, `mfa.not_enabled`,
  `mfa.enrolment_expired`, `mfa.not_available`, `mfa.required_by_policy` and
  `auth.step_up_required` (its `params.methods` is a comma-separated list). New activity types
  `user.mfa_enabled`, `user.mfa_disabled`, `user.backup_codes_regenerated`,
  `user.backup_code_used` and `session.stepped_up`. All additive.
- `@tula/react`: `<SignIn>` (also after a password reset) and `<SignUp>` draw the second
  factor (authenticator code or a backup code) and, where the environment requires it, the
  enrolment inside the flow. `<UserProfile>` gains a "Two-step verification" section: turn on
  with a QR code and the setup key, backup codes with copy, download and an explicit
  confirmation, new codes, turn off. New hook `useStepUp()` runs a sensitive action and, when
  the API asks, opens the provider's step-up dialog and retries. `useSignIn`, `useSignUp` and
  `useResetPassword` gain `submitSecondFactor`, `startTotpEnrolment` and
  `confirmTotpEnrolment`. New element names (`modal`, `qrCode`, `secret`, `backupCodes`,
  `backupCode`, `checkbox`) and strings (`mfa`, `stepUp`). The QR code is drawn by the package
  itself, in a chunk loaded on demand; the build now emits that chunk beside `index.js`.
