---
"@tula-tech/contract": minor
"@tula-tech/admin": minor
"@tula-tech/cli": minor
"@tula-tech/core": patch
---

`POST /v1/admin/audit-logs/export` streams the audit log as NDJSON or CSV, oldest first, resumable from the cursor of the last entry written, and records an `audit.exported` entry. `tula audit export` writes it to standard output; `@tula-tech/admin` gains `stream()` for it.
