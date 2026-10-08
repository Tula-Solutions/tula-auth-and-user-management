---
'@tula/contract': patch
---

`audit.retentionDays` takes effect: the server's retention job now deletes an environment's
audit entries older than the period, permanently. The schema and its default (`null`: keep
entries for ever) are unchanged; only the setting's description is.
