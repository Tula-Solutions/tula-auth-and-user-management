---
'@tula/contract': minor
'@tula/core': minor
'@tula/react': minor
---

Step-up by emailed code, `hasPassword` on the signed-in user, and a colour-scheme fix.

- `@tula/contract`: `StepUpMethod` gains `email_code`, `StepUpRequest` accepts
  `{ method: 'email_code', code }`, and `StepUpEmailCode` is the receipt of
  `POST /v1/client/sessions/step-up/email-code`. `GET /v1/client/me` answers `CurrentUser`: a
  `User` plus `hasPassword`. All additive.
- `@tula/core`: `session.prepareStepUp({ method: 'email_code' })` emails the signed-in user a
  code (for a user with a verified address and no two-step verification) and
  `session.stepUp({ method: 'email_code', code })` proves it. `stepUpMethods(error)` now
  returns `email_code` when the server lists it. New type `StepUpPrepared`; `User` now has
  `hasPassword`.
- `@tula/react`: the step-up dialog offers the emailed code: next to the password as "Email
  me a code instead" (sent only when chosen), and at once when it is the user's only method,
  with resend and the server's cooldown. `<UserProfile>` tells a user without a password how
  to add one instead of showing the change-password form. Buttons no longer fade their
  background: when the colour scheme changed under an open page the label was unreadable for
  a few frames. New localization strings: `stepUp.emailSubtitle`, `stepUp.emailSubtitleSent`,
  `stepUp.emailSending`, `stepUp.emailSend`, `stepUp.emailInstead`, `stepUp.passwordInstead`
  and `userProfile.passwordNotSet`.
