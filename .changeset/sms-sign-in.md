---
'@tula-tech/contract': minor
'@tula-tech/core': minor
'@tula-tech/react': minor
'@tula-tech/admin': minor
'@tula-tech/mcp': minor
'@tula-tech/config': patch
---

Signing in with a code texted to a phone number an account has proven (ADR 0037). Off by
default.

- `@tula-tech/contract`: the first-factor strategy `sms_code` (in `FirstFactorStrategy`, in the
  prepare and attempt requests, and as a step's `prepared.strategy`), the setting
  `signIn.methods.smsCode` (default off; never the only method, see
  `SIGN_IN_METHODS_WITHOUT_SIGN_UP`), the authentication method `sms` in `amr`, and the
  error code `mfa.enrolment_needs_other_sign_in` (403). `settingsWeakenings` lists
  `signIn.methods.smsCode` when a texted code can sign someone in after a change and could
  not before, and `sms.allowedCountries` when a country is added while one does. The client
  configuration lists `smsCode` among `signIn.methods` where it is offered.
- `@tula-tech/core`: `flow.prepareFirstFactor({ strategy: 'sms_code' })` and
  `flow.attemptFirstFactor({ strategy: 'sms_code', code })`, for a sign-in started with a
  phone number as its identifier. One more message in the error table.
- `@tula-tech/react`: `<SignIn>` takes a phone number in its first field where the environment
  lists the method, and gains the "Text me a code" and "Check your phone" screens. New
  strings under `signIn` in the localization table (`identifierLabel`, `identifierHint`,
  `smsCode`, `smsCodePrompt`, `smsTitle`, `smsCodeSubtitle`, `smsResend`, `smsResendIn`,
  `smsResent`, `smsCodeWrong`). A version from before this one leaves the strategy out.
- `@tula-tech/admin`: the generated types know the setting, the strategy and the error code.
- `@tula-tech/mcp`: `get_settings` returns `signIn.methods.smsCode`.
- `@tula-tech/config`: a config accepts `signIn.methods.smsCode`. An environment that leaves it
  off keeps the fingerprint it had: the key is hashed only when it is on.
