# Exporting the audit log

`POST /v1/admin/audit-logs/export` streams an environment's audit log as NDJSON or CSV, oldest
entry first, in pages of 1,000 so that nothing is held in memory. The same rows as the list
(`GET /v1/admin/audit-logs`) are exported, with the same fields. From a terminal use
[`tula audit export`](cli.md#tula-audit-export); in code, `stream('exportAuditLogs', …)` of
`@tula-tech/admin` returns the raw response.

It is a `POST` on purpose: a secret key and a dashboard session may call it, an agent key may
not (an agent key is accepted for `GET` and `HEAD` only, and this route is neither).

<!-- tabs -->
```sh
curl -sN -X POST "$TULA_API_URL/v1/admin/audit-logs/export" \
  -H "Authorization: Bearer $TULA_SECRET_KEY" -H 'content-type: application/json' \
  -d '{ "format": "csv", "from": "2026-01-01T00:00:00Z" }'
```

<!-- snippet: examples/docs-snippets/audit-export.ts#audit-export-since -->
```ts
const response = await admin.stream('exportAuditLogs', {
  body: { format: 'csv', from: '2026-01-01T00:00:00Z' },
})
const csv = await response.text()
```
<!-- /snippet -->

<!-- snippet: examples/docs-snippets/python/audit_export.py#audit-export-since -->
```python
request = urllib.request.Request(
    f"{API_URL}/v1/admin/audit-logs/export",
    data=json.dumps({"format": "csv", "from": "2026-01-01T00:00:00Z"}).encode(),
    headers={
        "Authorization": f"Bearer {SECRET_KEY}",
        "content-type": "application/json",
    },
    method="POST",
)
with urllib.request.urlopen(request) as response:
    csv = response.read().decode()
```
<!-- /snippet -->
<!-- /tabs -->

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

Each export is two `audit.exported` entries with the filters. The first (`phase: "started"`,
`rowCount: 0`) is written **before the first byte**, so an export that fails or is never read to the
end is still on record. The second (`phase: "finished"`) is written as the call ends, **also when
the reader stops early**, with the number of rows written. (A streamed response cannot carry a
trailer, and the log is append-only, so the end is an entry of its own.) The entries hold no row
content. An export leaves its own started entry out of its stream; the next export includes both.

## Single sign-on and provisioning events

Everything an enterprise administrator needs to answer "who changed our sign-in" is in the same log, so an
export filtered by `action` (or by `organizationId`) is the audit trail of the feature
([Enterprise single sign-on: the guide](enterprise-sso.md)):

| `action` | Recorded when |
| --- | --- |
| `sso_connection.created`, `sso_connection.updated`, `sso_connection.deleted` | A connection is made, changed or removed. An update lists the **names** of the fields that changed (`changed`) and never a value, and says `weakened: true` for a weakening: activating, switching enforcement off, trusting the provider's MFA, setting a break-glass role. A change of the group-to-role mapping is `changed: ['groupRoles']`, never the groups. |
| `setup_link.created`, `setup_link.revoked` | A setup link is made or revoked. |
| `scim_token.created`, `scim_token.revoked` | A SCIM token is made or revoked. |
| `user.scim_provisioned` | The directory created or changed a user. |

The actor of a change is the operator or administrator who made it, `setup_link` for one made through a
[setup portal](enterprise-sso.md#the-setup-portal), and `directory` (with the SCIM token's id) for
provisioning. No entry holds a secret, an email address, a certificate or a group name. For example, the
events of one organization's connections for a quarter:

<!-- tabs -->
```sh
curl -sN -X POST "$TULA_API_URL/v1/admin/audit-logs/export" \
  -H "Authorization: Bearer $TULA_SECRET_KEY" -H 'content-type: application/json' \
  -d '{ "format": "csv", "organizationId": "<org id>", "action": "sso_connection.updated",
        "from": "2026-07-01T00:00:00Z", "to": "2026-10-01T00:00:00Z" }'
```

<!-- snippet: examples/docs-snippets/audit-export.ts#audit-export-organization -->
```ts
const response = await admin.stream('exportAuditLogs', {
  body: {
    format: 'csv',
    organizationId: '<org id>',
    action: 'sso_connection.updated',
    from: '2026-07-01T00:00:00Z',
    to: '2026-10-01T00:00:00Z',
  },
})
const csv = await response.text()
```
<!-- /snippet -->

<!-- snippet: examples/docs-snippets/python/audit_export.py#audit-export-organization -->
```python
body = {
    "format": "csv",
    "organizationId": "<org id>",
    "action": "sso_connection.updated",
    "from": "2026-07-01T00:00:00Z",
    "to": "2026-10-01T00:00:00Z",
}
request = urllib.request.Request(
    f"{API_URL}/v1/admin/audit-logs/export",
    data=json.dumps(body).encode(),
    headers={
        "Authorization": f"Bearer {SECRET_KEY}",
        "content-type": "application/json",
    },
    method="POST",
)
with urllib.request.urlopen(request) as response:
    csv = response.read().decode()
```
<!-- /snippet -->
<!-- /tabs -->

> [!NOTE]
> `action` takes one entry type; run one export per type, or export the organization's entries unfiltered
> and filter the file. Entries older than the environment's `audit.retentionDays` have been deleted for good.
