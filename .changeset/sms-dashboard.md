---
'@tula/contract': minor
'@tula/cli': minor
---

Text messages in the dashboard, and a wider reach of a required texted second step is a
weakening ([ADR 0025](../docs/adr/0025-mfa.md), [ADR 0037](../docs/adr/0037-phone-numbers-and-sms.md),
[docs/phone-numbers.md](../docs/phone-numbers.md)).

**`@tula/contract`**

- `settingsWeakenings` lists two more changes, both only where `mfa.smsCode` is on and
  `mfa.policy` is `required` after the change: text messages switched on or a first country
  allowed (`mfa.smsCode`), and a country added where a texted code could already be that
  second step (`sms.allowedCountries`). A save that makes either is recorded with
  `weakened: true`, asked about by the dashboard and refused by `tula apply --yes` without
  `--allow-weaker`. Nothing that was listed before is listed differently.
- `smsCostLimits(dailyMessageLimit)`, `SMS_PREFIX_HOURLY_SHARE`,
  `SMS_ENVIRONMENT_HOURLY_SHARE` and `SmsCostLimits`: what a daily limit allows in an hour
  in all and to one destination prefix. The server holds a send to this function; it was
  the server's own before.
- `smsPrefixCountries(prefix)`: every country of the table that a destination prefix covers.

**`@tula/cli`**

- `tula diff` and `tula apply` say in words, under the plan, when it switches off the
  texted code as the second step (`mfa.smsCode` off in the file, or left out of it): users
  whose only second step is a texted code cannot sign in until it is on again or an
  administrator resets them. The plan is as before and is still not a weakening.
- The same for a plan that takes a country out of `sms.allowedCountries` (the countries are
  named) and for one that switches `sms.enabled` off: users there can no longer receive a
  code. Neither changes the plan or needs a flag.
- The two new weakenings are in `plan.weakened`.

The dashboard (not published) has a **Text messages** screen: the SMS settings and both
uses of a texted code on the one save model, whether the deployment has a sender, and the
codes sent and never used by destination prefix.
