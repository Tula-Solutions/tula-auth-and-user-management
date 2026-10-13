---
'@tula/config': minor
'@tula/cli': minor
---

Webhook endpoints in the config file. An environment may list
`webhooks: [{ url, eventTypes, enabled? }]`; `tula diff` shows what would change and
`tula apply` makes it so.

- An endpoint is its address, compared exactly. A changed address is a new endpoint (with a
  new signing secret), and the old one is an endpoint the file no longer lists.
- No `webhooks` key: the endpoints are not read or touched. With a list, an endpoint it
  leaves out is shown as unmanaged and removed only with `--prune`.
- Event types are a set; `enabled` is managed only when written.
- There is no field for a secret, and a `secret` key is refused. The signing secret of an
  endpoint `apply` creates is never printed unless asked: the run needs `--secrets-file
  <path>` (a new file, mode 0600), `--show-secrets` or `--discard-secrets`, and is refused
  before any write without one of them.
- Under `--yes`, a plan that removes an endpoint (and with it its pending deliveries and its
  delivery log) needs `--allow-webhook-removal`.
- Webhook endpoints are written after the settings and the providers. A plan that names an
  address the server has more than once, or would leave more than ten endpoints, is refused
  whole, and `tula diff` exits 1 for it.

`tula diff --json` gains `webhooks` and `blockers`, and `applyRequires` gains
`allowWebhookRemoval` and `webhookSecrets`. A file without a `webhooks` list behaves, and
hashes, as before.
