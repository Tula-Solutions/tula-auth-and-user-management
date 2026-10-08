---
'@tula/contract': minor
'@tula/cli': patch
---

`audit.retentionDays` takes effect: the server's retention job now deletes an environment's
audit entries older than the period, permanently. The schema and its default (`null`: keep
entries for ever) are unchanged.

**Check the setting in every environment before you upgrade the server.** Until now the
setting was stored and did nothing. An environment that already holds a number starts
deleting its older audit entries, for good, within ten minutes of the new version starting
(migration `0017`). `null`, the default, keeps everything, as before. Saving a period, or a
shorter one, deletes the older entries within ten minutes of the save: export first
(`GET /v1/admin/audit-logs`).

`settingsWeakenings` now lists `audit.retentionDays` when a period is set where there was
none or is made shorter (not when it is lengthened or removed). So the server's audit entry
for such a change carries `weakened: true`, `tula diff` warns about it and
`tula apply --yes` refuses it without `--allow-weaker`.
