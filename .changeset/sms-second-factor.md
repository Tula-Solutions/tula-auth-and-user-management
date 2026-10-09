---
'@tula/contract': minor
'@tula/core': minor
'@tula/react': minor
'@tula/admin': minor
'@tula/mcp': minor
'@tula/config': minor
---

A code texted to the account's proven phone number as the second step of a sign-in
(ADR 0025, "a texted code as the second factor"). Off by default. **Upgrade `@tula/core`
and `@tula/react` before switching it on**: an older client shows "not supported" at a
second step whose only option is a texted code.

- `@tula/contract`: the second-factor method `sms_code` (in `SecondFactorMethod`, in a
  step's `options` and its new `prepared` part, and among the step-up methods), the setting
  `mfa.smsCode.enabled` (default off) and `mfa.smsCode` in the client configuration,
  `Factors.sms` (`enabled`, `enabledAt`, `inUse`, `available`), the event types
  `user.sms_factor_enabled` and `user.sms_factor_removed`, the email template kinds
  `sms_factor_enabled` and `sms_factor_removed`, the text message template kind
  `second_factor` (one wording for the three texted second-step codes), and the error codes
  `mfa.needs_other_sign_in` (403), `mfa.sms_not_allowed` (409) and
  `mfa.phone_number_required` (409). `settingsWeakenings` lists `mfa.smsCode` when it is
  switched on where the policy is `required` after the change. A texted code records `sms`
  in `amr` and never `mfa`.
- `@tula/core`: `tula.mfa.startSms()`, `tula.mfa.confirmSms({ code })` and
  `tula.mfa.disableSms()`; `flow.prepareSecondFactor({ method: 'sms_code' })` on the
  sign-in and password-reset flows, and `submitSecondFactor({ method: 'sms_code', code })`;
  `session.prepareStepUp({ method: 'sms_code' })` and
  `session.stepUp({ method: 'sms_code', code })`. Three more messages in the error table.
- `@tula/react`: the second-step screen and the step-up dialog gain "Text me a code" (the
  message is asked for with a button, never sent on arrival), and `<UserProfile>` offers,
  confirms and turns off a texted code as the second step. New strings under `mfa`
  (`smsSubtitle`, `smsSend`, `smsOffer`, `smsTurnOn`, `smsStatusOn`, `smsNotInUse`,
  `smsWeaker`, `smsTurnOff`, `smsTurnedOn`, `smsTurnedOff`), `stepUp` (`smsSubtitle`) and
  `passkey` (`replacesTextedCode`: shown above "Add a passkey" to a user whose second step
  is a texted code, which the passkey replaces and which has no backup codes; `addChecking`
  and `addUnchecked`: read with that button, which is unavailable until the account's
  second step has been read, and stays so when the read fails). A texted
  code set aside by a stronger factor is said to come back when that factor is removed.
  Where the app has switched texted codes, text messages or the number's country off, the
  texted-code form shows the message of that refusal (`auth.method_disabled`,
  `sms.disabled`, `sms.country_not_allowed`) and removes its buttons.
- `@tula/admin`: the generated types know the routes, the setting, the method and the
  codes; a user's `authentication.factors` may hold `{ type: 'sms' }`.
- `@tula/mcp`: `get_settings` returns `mfa.smsCode`.
- `@tula/config`: a config accepts `mfa.smsCode`. An environment that leaves it off keeps
  the fingerprint it had: the key is hashed only when it is on.
