# Webhooks

A webhook is a signed notice, sent to your backend, of something that has already happened in
an environment: a user was created, a session was revoked, a setting changed. Its answer
changes nothing in Tula. You register an address, pick the event types, and the server posts
each such event to it. The design and its reasons are in
[ADR 0034](adr/0034-webhooks.md).

**This is the first step of webhooks.** A delivery is tried **once**: there are no retries
yet, so an event your endpoint did not answer with a 2xx is not sent again. Do not yet build
anything on them that a missed notice would break. What else is missing is listed
[at the end](#not-built-yet).

## Register an endpoint

With a secret key, on the admin API (the dashboard screen and `tula.config.ts` support come
later):

<!-- snippet: examples/docs-snippets/admin.ts#webhook-register -->
```ts
const { data: endpoint } = await admin.call('createWebhookEndpoint', {
  body: {
    url: 'https://api.example.com/webhooks/tula',
    eventTypes: ['user.created', 'user.deleted', 'session.reuse_detected'],
  },
})
// The only time the secret is returned: put it in your secret manager now.
await storeSecret(endpoint.secret)
```
<!-- /snippet -->

or without the SDK:

```bash
curl -X POST https://auth.example.com/v1/admin/webhook-endpoints \
  -H "Authorization: Bearer $TULA_SECRET_KEY" -H 'content-type: application/json' \
  -d '{ "url": "https://api.example.com/webhooks/tula", "eventTypes": ["user.created"] }'
```

- **`url`** must be one the server may call: `https`, no user name or password in it, and a
  host that resolves to public addresses only. Anything else is refused with
  `webhook.url_not_allowed` (422), and `params.reason` says which rule (`scheme_not_allowed`,
  `address_not_allowed`, `resolve_failed`, `invalid_url`, `timeout`). A development server
  (`ENVIRONMENT=local`) also accepts plain `http` and loopback addresses, so a receiver on
  `http://localhost:4000` works with `bun run dev` and with nothing else.
- **`eventTypes`** is one or more of the [event types](reference/contract.md) (`ACTIVITY_TYPES`
  in `@tula/contract/event-types`). There is no "all events": name the ones you handle.
- **`enabled`** defaults to `true`.

The answer (`201`) is the endpoint and its **signing secret**, `whsec_…`. **It is shown once.**
The server keeps it encrypted and no call returns it again; if you lose it, remove the
endpoint and register a new one. An environment holds at most ten endpoints.

Only events that happen **after** the endpoint was registered are sent to it.

<!-- snippet: examples/docs-snippets/admin.ts#webhook-manage -->
```ts
// Stop deliveries (events from while it is off are not sent later), then remove it.
await admin.call('updateWebhookEndpoint', {
  params: { id: endpoint.id },
  body: { enabled: false },
})
await admin.call('deleteWebhookEndpoint', { params: { id: endpoint.id } })
```
<!-- /snippet -->

| | |
| --- | --- |
| `GET /v1/admin/webhook-endpoints` | List, oldest first. |
| `GET /v1/admin/webhook-endpoints/:id` | Read one. |
| `PATCH /v1/admin/webhook-endpoints/:id` | Change `url`, `eventTypes` or `enabled`. |
| `DELETE /v1/admin/webhook-endpoints/:id` | Remove it. |

While an endpoint is switched off nothing is sent to it, and the events of that time are
**not** sent when it is switched on again. Every registration, change and removal is in the
audit log (`webhook_endpoint.created`, `.updated`, `.deleted`), by count and field name: never
with the address or the secret.

## What a delivery looks like

A `POST` to your address, with `content-type: application/json`, a body that is the event,
and three headers ([Standard Webhooks](https://www.standardwebhooks.com/)):

| Header | |
| --- | --- |
| `webhook-id` | The event's id. The same id as the event's audit log entry, and the same on a repeated delivery. |
| `webhook-timestamp` | When this delivery was sent, in seconds since the Unix epoch. |
| `webhook-signature` | `v1,<base64>`: HMAC-SHA256 over `<webhook-id>.<webhook-timestamp>.<body>`, keyed with the base64-decoded part of the secret after `whsec_`. More than one entry, separated by spaces, may be present: accept the delivery if any one is right. |

```json
{
  "id": "0199c2f5-0000-7000-8000-000000000001",
  "type": "user.created",
  "schemaVersion": 1,
  "occurredAt": "2026-10-08T09:30:00.000Z",
  "actor": { "type": "user", "id": "0199c2f4-7a10-7c3e-9b1a-5d2e8f4a6c01" },
  "target": { "type": "user", "id": "0199c2f4-7a10-7c3e-9b1a-5d2e8f4a6c01" },
  "data": { "method": "sign_up", "emailVerified": true }
}
```

An event names people and things **by id**. It never holds an email address, a name, an IP
address, a token or a key: read the current state from the admin API when you need more. Each
type's `data` is in the [contract reference](reference/contract.md) (`EVENT_DATA_SCHEMAS`),
with an example of every event in `EVENT_FIXTURES`. Within `schemaVersion` 1 an event only
grows: a later server may add a type, a field or an enum value, so ignore what you do not
know.

## Verify it

Anyone can post to your address. **Do not act on a delivery you have not verified.**

<!-- snippet: examples/docs-snippets/admin.ts#webhook-verify -->
```ts
// The route your endpoint's address leads to, on any server that gives you a `Request`.
export async function receiveWebhook(request: Request): Promise<Response> {
  let event: TulaWebhookEvent
  try {
    // The body exactly as it arrived: the signature is over these bytes.
    event = await verifyWebhook(await request.text(), request.headers, webhookSecret)
  } catch (error) {
    // Not from Tula, changed on the way, or older than five minutes.
    return new Response(null, { status: isTulaAdminError(error) ? 400 : 500 })
  }
  // Delivery is at least once: the same event id can arrive again.
  if (await alreadyHandled(event.id)) {
    return new Response(null, { status: 204 })
  }
  switch (event.type) {
    case 'user.created':
      await provisionWorkspace(event.target.id)
      break
    case 'session.reuse_detected':
      await alertSecurity(event.data.userId)
      break
    default:
    // A type this code does not handle, or one a later server added: nothing to do.
  }
  // Answer quickly, with a 2xx and a small body. Anything else counts as a failed delivery.
  return new Response(null, { status: 204 })
}
```
<!-- /snippet -->

`verifyWebhook` (from `@tula/admin`, on any server runtime) refuses a delivery whose signature
is not right for the secret, whose headers are missing or malformed, or whose timestamp is
more than five minutes old or more than five minutes ahead of your server's clock, and returns
the typed event otherwise. Its errors are `TulaAdminError`s with a `code`
(`webhook.invalid_signature`, `webhook.timestamp_out_of_tolerance`, `webhook.invalid_headers`,
`webhook.invalid_secret`, `webhook.invalid_payload`) and never contain the secret, a signature
or the body.

- **Give it the body exactly as it arrived.** The signature is over the bytes. A framework
  that parses JSON for you and hands you an object has already lost them: read the raw text
  (`await request.text()`, `express.raw({ type: 'application/json' })`, …).
- **Keep your server's clock right.** The five minutes are measured against it.
- **In another language**, use any Standard Webhooks library with the `whsec_…` secret as it
  is, or compute the HMAC yourself as the table above says and compare in constant time.

## Answer it

- **Answer with a 2xx, quickly, and with a small body.** The server waits five seconds. Any
  other status, no answer in time, a redirect (never followed) or an answer larger than
  16 KiB counts as a failed delivery. Do the work the event causes after you have answered.
- **Expect the same event twice.** Delivery is at least once: if the server sent a delivery
  and could not record that it did, it sends it again, with the same `webhook-id`. Keep the
  ids you have handled (for at least the five-minute window) and answer a repeat with a 2xx.
- **Do not rely on order.** Events are sent oldest first, but nothing guarantees they arrive
  that way. Each carries `occurredAt`; when order matters, fetch the current state.
- **Expect a delay of a few seconds.** The worker looks for new events every five seconds.

## What the server keeps

For each delivery: which endpoint and event, when it was tried, whether it was delivered, your
answer's **status code**, how long it took, and, when there was no answer, a fixed word for
why (`timeout`, `connection_failed`, `address_not_allowed`, …). **Nothing else of your answer
is kept or logged**: no header and no body. The server's log never holds an endpoint's address
or its secret.

There is no API to read these records yet. Removing an endpoint removes its records.

## How the server calls you

Every delivery goes through the same guard that judged the address when you registered it,
and it judges again each time: the host is resolved, every address it has must be public, and
the connection is made to exactly the address that was checked. So an endpoint whose name is
later pointed at a private address stops being delivered to (`address_not_allowed`). The
certificate is always verified against the host name, redirects are never followed, and the
server uses no proxy from its environment. The request's `User-Agent` is `tula-auth`.

For the operator of the server:

- Deliveries are made by a worker inside each API instance; with several instances one of
  them does a round and the others skip it (the same lock arrangement as the retention job).
  There is nothing to configure.
- The endpoints' secrets are encrypted with `TULA_MASTER_KEY`. If the key changes, every
  delivery fails (`signing_failed`, with a line in the log naming the endpoint's id) until
  the endpoints are registered again.
- The first start of a version with webhooks settles the whole outbox, which has recorded
  every event since the deployment began: nothing of it is sent (no endpoint existed), each
  event is only marked. That takes a round every five seconds at up to 1,000 events per
  environment, with a log line per round. See
  [Upgrading](self-host.md#upgrading), migration `0018`.

## Not built yet

- **Retries.** One attempt per endpoint and event; a failed delivery is not repeated.
- **Reading the delivery log**, sending a test event, redelivering.
- **Rotating a secret** without a gap (the verifier already accepts either of two signatures).
- **Endpoints in `tula.config.ts`** (`tula diff`, `tula apply`).
- **A dashboard screen.**
- **Deleting old events and delivery records**: both are kept for now.

What of this step was not verified against the real thing (a public `https` receiver, a
verifier in another language) is in
[plans/phase-2-unverified.md](plans/phase-2-unverified.md).
