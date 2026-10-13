---
'@tula/contract': patch
---

The OpenAPI document lists a `501` for `sendTestWebhook` and `redeliverWebhook`.

A server can now run its webhook worker as a service of its own (`WEBHOOK_WORKER=separate`;
docs/self-host.md, "The webhook worker as its own service"). Its API instances then make no
request to an endpoint, so a test event and a delivery sent again are refused there:
`not_implemented` (501) with `params.reason: "worker_separate"`. The code is an existing one
and no schema changed; a deployment that leaves the variable alone answers as before.
