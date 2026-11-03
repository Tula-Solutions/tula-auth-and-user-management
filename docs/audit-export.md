# Exporting the audit log

`POST /v1/admin/audit-logs/export` streams an environment's audit log as NDJSON or CSV, oldest
entry first, in pages of 1,000 so that nothing is held in memory. The same rows as the list
(`GET /v1/admin/audit-logs`) are exported, with the same fields. From a terminal use
[`tula audit export`](cli.md#tula-audit-export); in code, `stream('exportAuditLogs', …)` of
`@tula-tech/admin` returns the raw response.

It is a `POST` on purpose: a secret key and a dashboard session may call it, an agent key may
not (an agent key is accepted for `GET` and `HEAD` only, and this route is neither).

```sh
curl -sN -X POST "$TULA_API_URL/v1/admin/audit-logs/export" \
  -H "Authorization: Bearer $TULA_SECRET_KEY" -H 'content-type: application/json' \
  -d '{ "format": "csv", "from": "2026-01-01T00:00:00Z" }'
```

## Request

| Field | |
| --- | --- |
| `format` | `ndjson` (default) or `csv`. |
| `from`, `to` | Entries at or after `from` and before `to`. |
| `action` | One entry type, for example `user.banned`. |
| `organizationId` | Entries about the organization, or recorded with its id. |
| `after` | A resume cursor (below). A malformed one is a `422`. |

## Response

- NDJSON: one JSON object per line, ending `\n`. CSV: a header row, then one row per entry,
  each ending `\r\n`, quoted as RFC 4180 says.
- **A spreadsheet runs a formula.** A CSV cell that starts with `=`, `+`, `-`, `@`, a tab or a
  carriage return is written with a leading `'`, so that an actor-supplied name cannot execute
  when the file is opened.
- At most 100,000 entries a call. Past that the stream ends; resume from the last entry.
- `Cache-Control: no-store`.

## Resuming

An entry's cursor is `<occurredAt>~<id>`. The export is ordered by exactly that pair, so
resuming with the last entry's cursor gives no gap and no repeat, even when entries are
recorded during the export. Bun and browsers cannot read HTTP trailers, so the server sends no
cursor at the end: read it from the last row (`tula audit export` does and prints it).

## What it records

Each export is one `audit.exported` entry with the filters and the number of rows written, as
the call ends, **also when the reader stops early**. The entry holds no row content. It is
itself in the log, so the next export includes the one before it.
