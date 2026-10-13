---
'@tula/contract': minor
'@tula/core': minor
'@tula/react': minor
'@tula/admin': minor
'@tula/cli': minor
'@tula/mcp': minor
---

A phone number on an account, proven with a texted code (ADR 0037).

- `@tula/contract`: phone numbers as plain data, exported from the index (`parsePhoneNumber`,
  `maskPhoneNumber`, `COUNTRY_CALLING_PREFIXES`, `SMS_COUNTRIES`, `isSmsCountry`,
  `phoneNumberCountries`, `isPhoneNumberAllowed`). A user gains `phoneNumber` and
  `phoneNumberVerifiedAt`. The settings gain `sms` (`enabled`, default `false`;
  `allowedCountries`, default `[]`, where empty means nothing is sent), and the client
  configuration `phone.enabled`. New error codes `phone.invalid`, `sms.disabled`,
  `sms.country_not_allowed` and `sms.unavailable`; new events `user.phone_number_added` and
  `user.phone_number_removed`, whose payload holds no number. New schemas
  `PhoneNumberRequestSchema`, `PhoneCodeSentSchema`, `PhoneNumberVerifyRequestSchema` and
  `SmsCountrySchema`.
- `@tula/core`: `client.user.phone.request({ phoneNumber })`, `.verify({ code })` and
  `.remove()` for the signed-in user, and the type `PhoneCodeSent`. The answers are checked
  before anything is built from them, and a user is installed only for the session that asked.
- `@tula/react`: `<UserProfile>` gains a "Phone number" section (add with a texted code,
  change, remove), shown where the environment can text a code or the user has a number.
  New strings under `phone` in the localization table.
- `@tula/admin`: the generated types know the three operations, the `sms` settings and a
  user's phone fields.
- `@tula/cli`: `tula diff` and `tula apply` compare `sms.allowedCountries` as a set.
- `@tula/mcp`: `get_settings` returns `sms`. A user's phone number is not returned by any
  tool.
