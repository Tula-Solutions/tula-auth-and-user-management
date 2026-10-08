---
'@tula/contract': minor
'@tula/admin': minor
'@tula/core': patch
'@tula/mcp': patch
---

Webhooks, first step: an environment's events are delivered, signed, to an endpoint an
operator registers (`/v1/admin/webhook-endpoints`; [ADR 0034](../docs/adr/0034-webhooks.md),
[docs/webhooks.md](../docs/webhooks.md)). One attempt per endpoint and event for now: a
failed delivery is recorded and not repeated.

**`@tula/contract`**

- A new Zod-free entry point, `@tula/contract/webhook-signature`: the Standard Webhooks header
  names (`WEBHOOK_ID_HEADER`, `WEBHOOK_TIMESTAMP_HEADER`, `WEBHOOK_SIGNATURE_HEADER`), the
  secret prefix, the five-minute tolerance, and `signWebhook`, `webhookSecretBytes` and
  `formatWebhookSecret`.
- The webhook endpoint schemas of the admin API (`WebhookEndpointSchema`,
  `CreatedWebhookEndpointSchema`, the create and update requests, `MAX_WEBHOOK_ENDPOINTS`).
- Three event types, each with a `data` schema and a fixture: `webhook_endpoint.created`,
  `webhook_endpoint.updated` and `webhook_endpoint.deleted`. Their target is a new target
  type, `webhook_endpoint`. An event never carries an endpoint's address or its secret.
- A new error code, `webhook.url_not_allowed` (422): the server may not call the address.
  `params.reason` is a fixed word, never the address.

A receiver or an SDK that switches on `type` or on `target.type` sees values it did not list
before; both lists only grow within `schemaVersion` 1, as documented.

**`@tula/admin`**

- `verifyWebhook(body, headers, secret, options?)`: verifies a delivery (the signature, in
  constant time, accepting any one of several; the headers; a timestamp within five minutes
  either way) and returns the typed event, `TulaWebhookEvent`. It throws `TulaAdminError`
  with one of five new client codes (`webhook.invalid_secret`, `webhook.invalid_headers`,
  `webhook.timestamp_out_of_tolerance`, `webhook.invalid_signature`,
  `webhook.invalid_payload`), never with the secret, a signature or the body in it. Zod-free,
  web platform APIs only.
- The five webhook endpoint operations (`createWebhookEndpoint`, `listWebhookEndpoints`,
  `getWebhookEndpoint`, `updateWebhookEndpoint`, `deleteWebhookEndpoint`), and the event
  types under `AdminSchemas['TulaEvent']`.

**`@tula/core`**: the generated `ErrorCode` type lists `webhook.url_not_allowed`. Nothing a
client calls changed.

**`@tula/mcp`**: a webhook signing secret (`whsec_…`) is redacted wherever it turns up in a
result, like the other secret shapes. There is no webhook tool.

**Before you upgrade the server**: migration `0018` adds a unique key and an index to the
outbox table (`events`), which locks it for writes while they build; and the first start of
the new version marks every event recorded so far as settled, without sending any
([docs/self-host.md](../docs/self-host.md#upgrading)).
