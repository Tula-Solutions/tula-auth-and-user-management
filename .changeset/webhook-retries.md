---
'@tula/contract': minor
'@tula/admin': minor
'@tula/core': patch
---

Webhook retries, the delivery log, test events and sending a delivery again.

- `@tula/contract`:
  - A webhook endpoint gains `disabledReason` (`failing`, `gone`, or `null`) and
    `failingSince`.
  - A new event type, `webhook_endpoint.disabled`, with `data.reason`
    (`WEBHOOK_DISABLED_REASONS`): the server switched an endpoint off because every request to
    it failed for five days, or because it answered `410 Gone`.
  - Every event envelope gains an optional `test`, which is `true` on a test event and absent
    on a real one. `EVENT_SCHEMA_VERSION` stays 1.
  - `WebhookDeliverySchema`, `WebhookDeliveryDetailSchema`, `WebhookDeliveryAttemptSchema`,
    `WebhookDeliveryListSchema`, `SendTestWebhookRequestSchema`, `WebhookSendResultSchema`,
    `WEBHOOK_DELIVERY_STATES` and `WEBHOOK_REDELIVER_REFUSALS`.
  - A new error code, `webhook.cannot_redeliver` (409), whose `params.reason` is
    `delivery_pending`, `endpoint_disabled` or `event_gone`.
- `@tula/admin`: the admin client gains `listWebhookDeliveries`, `getWebhookDelivery`,
  `sendTestWebhook` and `redeliverWebhook`. `verifyWebhook` returns a test event with
  `event.test === true` and refuses a `test` that is anything else; its documentation now says
  that a delivery is retried, that order is not guaranteed, and to check `test` before acting.
- `@tula/core`: the generated types and the error-message table follow the contract (one new
  code).
