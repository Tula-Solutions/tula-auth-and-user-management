---
'@tula/contract': minor
'@tula/admin': minor
'@tula/core': patch
---

Webhook secret rotation: an endpoint's signing secret is replaced without dropping a delivery.

- `@tula/contract`:
  - A webhook endpoint gains `rotationOverlapEndsAt`: when the previous secret stops signing,
    or `null` when one secret signs. Until then every delivery carries two signatures in
    `webhook-signature`, the new secret's first.
  - `RotatedWebhookSecretSchema`: the answer of a rotation, the endpoint with its new secret
    (shown once) and `rotationOverlapEndsAt`.
  - Two new event types: `webhook_endpoint.secret_rotated` (`data.rotationOverlapEndsAt`) and
    `webhook_endpoint.previous_secret_revoked` (no data). Neither carries anything of a
    secret. `EVENT_SCHEMA_VERSION` stays 1.
  - A new error code, `webhook.rotation_refused` (409), whose `params.reason` is one of
    `WEBHOOK_ROTATION_REFUSALS`: `rotation_in_progress`, `no_rotation_in_progress` or
    `secret_unreadable`.
- `@tula/admin`:
  - The admin client gains `rotateWebhookSecret` and `revokePreviousWebhookSecret`.
  - `verifyWebhook` takes one secret **or a list of at most two** (`WEBHOOK_MAX_SECRETS`,
    `WebhookSecrets`): the delivery is accepted when any signature is right for any secret
    given. Every secret listed must be a signing secret; an empty list, a third secret or a
    malformed entry is `webhook.invalid_secret`. A single secret behaves as before.
- `@tula/core`: the generated types and the error-message table follow the contract (one new
  code).
