---
'@tula/config': minor
---

`settings.sms` in `tula.config.ts`: whether an environment sends text messages
(`enabled`, default `false`) and the countries they may go to (`allowedCountries`, ISO 3166-1
alpha-2 codes; empty means nothing is sent). See ADR 0037. An environment that leaves it at
its default keeps the fingerprint it had.
