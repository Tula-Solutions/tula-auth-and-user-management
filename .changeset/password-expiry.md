---
'@tula/contract': minor
'@tula/core': minor
'@tula/react': minor
'@tula/nextjs': minor
---

`password.expiryDays` takes effect: where it is set, a user who signs in with a password
that was set that many days ago or longer has to choose a new one before the sign-in
completes.

**Check the setting in every environment, and `PASSWORD_POLICY`, before you upgrade the
server.** Until now the number was stored and did nothing, and the `legacy` preset has it at
90. Age is counted from when a password was last set; for the passwords that already exist
that is the last time their row was written (migration `0029`). A user whose password is
older than the period is asked for a new one at their next sign-in with it. Nobody is signed
out and no email is sent. Only a sign-in with the password is affected: an emailed or texted
code, a link, a passkey and a provider sign in whatever the password's age.

**Upgrade clients before the server.** An app built on a `@tula/react` or `@tula/core` older
than this release shows "This step is not supported" where the new password is asked for,
so a user with an expired password cannot sign in through it. Or set `expiryDays` to `null`
until every client is upgraded.

- `@tula/contract`: the `needs_new_password` step gains an optional `reason`
  (`NewPasswordReasonSchema`: `expired`). With a reason its `strategies` is empty; a
  password reset's step is unchanged. A new operation,
  `POST /v1/client/sign-ins/{attemptId}/new-password` (`submitSignInNewPassword`).
- `@tula/core`: a sign-in flow gains `submitNewPassword({ password })`, for the step
  `needs_new_password` with `reason: 'expired'`. A refused password (`password.*`) leaves the
  flow on the step.
- `@tula/react`: `<SignIn>` draws a "Your password has expired" screen for that step, with
  the policy's checklist. Four new strings, under `expiredPassword` in the localization
  table (`title`, `subtitle`, `newPasswordLabel`, `submit`): an app with a complete
  localization of its own adds them.
- `@tula/nextjs`: its `<SignIn>` is `@tula/react`'s and gains the screen; the route handler
  forwards the new operation like every `/v1/client/*` call.
