---
'@tula/contract': minor
'@tula/config': minor
'@tula/admin': minor
'@tula/cli': minor
'@tula/mcp': minor
---

SMS send limits and a daily limit per environment (ADR 0037).

- `@tula/contract`: the settings gain `sms.dailyMessageLimit` (default `500`, 1 to
  1,000,000, no value switches it off): the most text messages an environment sends in one
  UTC day. Raising it is a weakening (`settingsWeakenings` lists `sms.dailyMessageLimit`).
  New: `DEFAULT_SMS_DAILY_MESSAGE_LIMIT`, `MAX_SMS_DAILY_MESSAGE_LIMIT`,
  `phoneNumberPrefix` (a number's destination prefix: the calling prefix the country list
  matched) and `SMS_PREFIX_MAX_DIGITS`; `SmsUsageSchema` and `SmsPrefixUsageSchema` with
  `SMS_USAGE_MAX_DAYS`, `SMS_USAGE_DEFAULT_DAYS` and `SMS_USAGE_MAX_PREFIXES`, for the new
  operation `getSmsUsage` (`GET /v1/admin/sms/usage`): codes texted and used, by destination
  prefix. No new error code: a limit answers `rate_limited`.
- `@tula/config`: `settings.sms.dailyMessageLimit` in `tula.config.ts`. An environment that
  leaves it at the default keeps the fingerprint it had.
- `@tula/admin`: the generated types know `getSmsUsage` and the new setting.
- `@tula/cli`: `tula diff` flags a higher `sms.dailyMessageLimit` as a weakening, and
  `tula apply --yes` refuses it without `--allow-weaker`. A file that leaves the limit out
  asks for the default.
- `@tula/mcp`: `get_settings` returns `sms.dailyMessageLimit`.
