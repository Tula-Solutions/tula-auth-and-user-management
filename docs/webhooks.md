# Webhooks

A webhook is a signed notice, sent to your backend, of something that has already happened in
an environment: a user was created, a session was revoked, a setting changed. Its answer
changes nothing in Tula. You register an address, pick the event types, and the server posts
each such event to it. The design and its reasons are in
[ADR 0034](adr/0034-webhooks.md).

A delivery your backend does not take is **tried again**: eight requests over a day and a few
hours, on a [fixed schedule](#retries). After that the server gives the delivery up, and an
endpoint that takes nothing for five days is [switched off](#when-an-endpoint-is-switched-off).
Every delivery and every request made for it can be [read](#the-delivery-log), a
[test event](#send-a-test-event) can be sent at any time, and a past delivery can be
[sent again](#send-a-delivery-again) by hand. What is still missing is listed
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
| `DELETE /v1/admin/webhook-endpoints/:id` | Remove it, with its delivery log. |
| `GET /v1/admin/webhook-endpoints/:id/deliveries` | [Its deliveries](#the-delivery-log), newest first. |
| `GET /v1/admin/webhook-endpoints/:id/deliveries/:deliveryId` | One delivery with every request made for it. |
| `POST /v1/admin/webhook-endpoints/:id/test` | [Send a test event](#send-a-test-event). |
| `POST /v1/admin/webhook-endpoints/:id/deliveries/:deliveryId/redeliver` | [Send a delivery again](#send-a-delivery-again). |

An endpoint also says how it is doing: `failingSince` is the time of the first failed request
since its last success (`null` when the last one got through), and `disabledReason` says why
the **server** switched it off, if it did.

While an endpoint is switched off nothing is sent to it, and the events of that time are
**not** sent when it is switched on again. Every registration, change and removal is in the
audit log (`webhook_endpoint.created`, `.updated`, `.deleted`), by count and field name: never
with the address or the secret. So is the server switching one off
(`webhook_endpoint.disabled`).

## What a delivery looks like

A `POST` to your address, with `content-type: application/json`, a body that is the event,
and three headers ([Standard Webhooks](https://www.standardwebhooks.com/)):

| Header | |
| --- | --- |
| `webhook-id` | The event's id. The same id as the event's audit log entry, and the same on every retry and when a delivery is sent again. |
| `webhook-timestamp` | When this request was sent, in seconds since the Unix epoch. A retry has a new one. |
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

One more top-level field exists, on a [test event](#send-a-test-event) only: `"test": true`.
A real event never has it.

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
  // A test event an administrator sent: an example, nothing in it happened.
  // And delivery is at least once: the same event id can arrive again.
  if (event.test || (await alreadyHandled(event.id))) {
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
  // Answer quickly, with a 2xx and a small body. Anything else is a failed request, which
  // the server retries.
  return new Response(null, { status: 204 })
}
```
<!-- /snippet -->

`verifyWebhook` (from `@tula/admin`, on any server runtime) refuses a delivery whose signature
is not right for the secret, whose headers are missing or malformed (a `webhook-id` or
`webhook-timestamp` sent twice is malformed; a `webhook-signature` sent twice is read as one
list, of which any right entry is enough), or whose timestamp is
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
  16 KiB is a failed request, and the server [tries again](#retries). Do the work the event
  causes after you have answered.
- **Expect the same event more than once.** A retry carries the same `webhook-id` as the
  request before it, and so does a delivery an administrator sends again. Delivery is also at
  least once in the strict sense: if the server sent a request and could not record that it
  did, it sends it again. Keep the ids you have handled for at least **31 days**: an event
  can be sent again for as long as the server keeps it, which is 30. Answer a repeat with a
  2xx.
- **Do not rely on order.** A retry of an older event arrives after newer ones, and your
  endpoints are served side by side. Order events by `occurredAt` and tell them apart by
  `id`; when the order matters, fetch the current state.
- **Check `test` before you act.** A [test event](#send-a-test-event) is signed and verifies
  like any other; `"test": true` is how you know that nothing in it happened.
- **Expect a delay of a few seconds.** The worker looks for new events every five seconds.
- **`Retry-After` is not read.** The server reads nothing of your answer but its status code.
  Answer `503` when you are overloaded: the schedule backs off by itself.
- **`410 Gone` means "stop".** The server gives that delivery up and
  [switches the endpoint off](#when-an-endpoint-is-switched-off) at once.

## Retries

A delivery is given **eight requests**: the first as soon as the worker sees the event, and
seven more, each this long after the one before failed:

| After request | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| The server waits | 5 seconds | 5 minutes | 30 minutes | 2 hours | 5 hours | 10 hours | 10 hours |

That is 27 hours 35 minutes from the first request to the last. Each wait is stretched by a
random amount of up to a fifth (never shortened), so that deliveries which failed together do
not all come back in the same second; with the most of it the last request is made 33 hours
after the first. The worker runs every five seconds, so a request can be up to that much later
again. These are fixed: there is nothing to configure.

After the eighth failed request the delivery is **given up**: it stays in the
[log](#the-delivery-log) as `failed`, and can still be [sent again](#send-a-delivery-again) by
hand. A 2xx at any point ends it as `delivered`.

What counts as a failed request: any status that is not 2xx (a redirect included), no answer
within five seconds, a connection that could not be made, an address the server
[may not call](#how-the-server-calls-you), and an answer over 16 KiB.

Two things can make a delivery wait **without a request being made**. Neither counts as one of
the eight, and the log says which it was:

- **`endpoint_unresponsive`.** Your endpoint let a request run into the five-second deadline
  while more deliveries were due. The server does not wait five seconds again for each of
  them in the same round: the one that timed out is retried on the schedule, and the rest are
  put off for a minute. Nothing is lost to this; it only costs a minute.
- **`signing_failed`.** The server could not open your endpoint's signing secret. This is a
  fault on the server's side, nothing your endpoint did: the deliveries wait (five minutes at
  a time) until it can. The operator sees one log line per endpoint per round, `webhook
  signing secret could not be opened; nothing was sent to the endpoint this round`, with the
  endpoint's id and a count, and should check that every API instance has the same
  `TULA_MASTER_KEY`, the one the deployment has always had (`tula doctor`). If the key is
  gone for good, remove the endpoint and register it again: that issues a new secret.

Whatever keeps it waiting, a delivery that has been pending for **three days** is given up
(`expired`). Nothing waits for ever.

## When an endpoint is switched off

The server switches an endpoint off by itself in two cases, and says which in the endpoint's
`disabledReason`:

| `disabledReason` | When |
| --- | --- |
| `failing` | **Every request to it has failed for five days.** Counted from the first failure after its last success (`failingSince`) to a later failure. An hour, a night or a weekend of failures does not do it, and one success starts the count again. |
| `gone` | **It answered `410 Gone`.** At once. |

It is recorded in the audit log as `webhook_endpoint.disabled`, done by the `system`, with the
reason. That is also an event: subscribe **another** endpoint, or watch the audit log, to be
told when one of yours is switched off.

**To switch it on again**, set `enabled` to `true` with the same `PATCH` as always. That
forgets why it was off and since when it was failing: it has five days again. Changing its
address does the same.

**What happens to what was waiting.** While an endpoint is off, by the server or by you,
nothing is sent to it, and its pending deliveries are neither tried nor counted. When you
switch it on they are sent, from the attempt they had reached. The one thing that does not
stop is their age: a delivery that has been pending for three days is given up whether the
endpoint is on or off. Events that happen **while** it is off are never sent to it.

[Send a test event](#send-a-test-event) before switching it back on: a test can be sent to an
endpoint that is off.

## The delivery log

<!-- snippet: examples/docs-snippets/admin.ts#webhook-deliveries -->
```ts
// What the server gave up on, newest first.
const { data: failed } = await admin.call('listWebhookDeliveries', {
  params: { id: endpointId },
  query: { state: 'failed' },
})
for (const delivery of failed.data) {
  // Every request made for it: when, the status code (or why there was none), how long.
  const { data: detail } = await admin.call('getWebhookDelivery', {
    params: { id: endpointId, deliveryId: delivery.id },
  })
  show(
    delivery.eventType,
    detail.attempts.map((attempt) => attempt.statusCode)
  )
}
```
<!-- /snippet -->

`GET /v1/admin/webhook-endpoints/:id/deliveries` lists an endpoint's deliveries, newest first,
in pages (`page`, `size`, like the other admin lists), filtered by `state` and `eventType`.
There is one delivery per event the endpoint was owed, and one per test event:

| Field | |
| --- | --- |
| `state` | `pending` (the server will try, or try again), `delivered` (answered 2xx) or `failed` (given up). |
| `eventId`, `eventType` | The event. `eventId` is the delivery's `webhook-id`; `null` for a test event. |
| `test` | `true` for a test event. |
| `attemptCount` | Requests made so far. |
| `nextAttemptAt` | When the server tries next; `null` unless `pending`. |
| `statusCode`, `failureReason`, `lastAttemptAt` | How the latest step ended: your status code, or one of the server's fixed words. |
| `completedAt` | When it was delivered or given up. |

`GET …/deliveries/:deliveryId` adds `attempts`: every request, oldest first, each with its
number, when it was made, your **status code**, how long it took, and, when there was no
answer, a fixed word for why:

| `failureReason` | |
| --- | --- |
| `timeout` | No answer in five seconds. |
| `connection_failed` | The connection could not be made, or broke. |
| `resolve_failed`, `address_not_allowed`, `scheme_not_allowed`, `invalid_url` | The outbound guard refused the address as it is now. |
| `response_too_large` | The answer was over 16 KiB. |
| `endpoint_unresponsive`, `signing_failed` | On the delivery only, never on an attempt: [no request was made](#retries). |
| `expired` | Given up after three days pending. |
| `event_gone` | Given up because the event no longer exists. |

## Send a test event

<!-- snippet: examples/docs-snippets/admin.ts#webhook-test -->
```ts
// One signed example event, now. Your receiver sees `event.test === true`.
const { data: test } = await admin.call('sendTestWebhook', {
  params: { id: endpointId },
  body: { eventType: 'user.created' },
})
if (test.outcome === 'failed') {
  // `statusCode` is what your endpoint answered; without an answer, `failureReason` says why.
  show(test.statusCode ?? test.failureReason)
}
```
<!-- /snippet -->

`POST /v1/admin/webhook-endpoints/:id/test` with `{ "eventType": "user.created" }` sends one
event of that type to the endpoint, now. It is a real delivery: the same headers, signed with
the endpoint's secret, through the same guard. Its body is the contract's example of the type
(`EVENT_FIXTURES`) with a new id, the current time and one more field:

```json
{
  "id": "0199c2f5-9a41-7000-8000-0000000000aa",
  "type": "user.created",
  "schemaVersion": 1,
  "occurredAt": "2026-10-08T09:30:00.000Z",
  "actor": { "type": "user", "id": "0199c2f4-7a10-7c3e-9b1a-5d2e8f4a6c01" },
  "target": { "type": "user", "id": "0199c2f4-7a10-7c3e-9b1a-5d2e8f4a6c01" },
  "data": { "method": "sign_up", "emailVerified": true },
  "test": true
}
```

**`"test": true` is how your receiver knows.** It is inside the signed body, so it cannot be
added to a real event or removed from a test on the way, and `verifyWebhook` returns it as
`event.test`. Nothing the event describes happened: the ids in it are the examples'. A real
event never has the field.

- You choose the type and nothing else: any type, whether or not the endpoint subscribed to
  it. Not the address and not the payload.
- The answer is `{ deliveryId, outcome, statusCode, durationMs, failureReason }`: whether your
  endpoint answered 2xx, its status code, how long it took, or the fixed word for why there
  was no answer. **Nothing else of your answer is read or kept.**
- It is one request, never retried, recorded in the [delivery log](#the-delivery-log) with
  `test: true`. It is not in the audit log and is not an event anyone else receives.
- It changes nothing about the endpoint: a failed test does not count towards
  [switching it off](#when-an-endpoint-is-switched-off), and it can be sent to an endpoint
  that is off.
- The call waits for your endpoint, up to five seconds.
- Test events and deliveries sent again share a limit of **ten a minute per environment**
  (`429`, `rate_limited`).

## Send a delivery again

<!-- snippet: examples/docs-snippets/admin.ts#webhook-redeliver -->
```ts
// After fixing the receiver: send what it missed once more, with the same `webhook-id`.
for (const delivery of failed.data) {
  try {
    await admin.call('redeliverWebhook', {
      params: { id: endpointId, deliveryId: delivery.id },
    })
  } catch (error) {
    // 409 `webhook.cannot_redeliver`: `params.reason` is `event_gone` (older than 30 days),
    // `endpoint_disabled` or `delivery_pending`.
    if (!isTulaAdminError(error) || error.code !== 'webhook.cannot_redeliver') {
      throw error
    }
  }
}
```
<!-- /snippet -->

`POST /v1/admin/webhook-endpoints/:id/deliveries/:deliveryId/redeliver` makes one more request
for a past delivery, now: the event exactly as it was stored, to the endpoint it was owed to,
with the **same `webhook-id`** and a new timestamp. A receiver that has already handled the
event drops it by its id, as it would a retry.

- The request is added to the delivery's own attempts, as the next number. A 2xx makes the
  delivery `delivered`. A failure leaves its state as it was and is **not** retried.
- The answer is the same as a test event's: the outcome, a status code, a duration.
- It is refused with `webhook.cannot_redeliver` (409), and `params.reason` says why:

  | `reason` | |
  | --- | --- |
  | `delivery_pending` | The server is still retrying it and will send it. |
  | `endpoint_disabled` | The endpoint is switched off. Switch it on first. |
  | `event_gone` | The event is no longer kept (older than 30 days), or the delivery is a test event. |

- It is not in the audit log; the attempt is its record.

## What the server keeps

| | For how long |
| --- | --- |
| **An event** (its payload) | 30 days after the worker has queued its deliveries. Until then a delivery of it can be sent again. An event with a delivery still pending is kept regardless. |
| **A delivery and the requests made for it** | 90 days after it was queued, once it is no longer pending. |

A delivery holds which endpoint and which event (its id and type), its state, when it was
queued and ended, and how its latest step went. A request holds when it was made, your
answer's **status code**, how long it took, and, when there was no answer, one of the fixed
words above. **Nothing else of your answer is kept or logged**: no header and no body. The
server's log never holds an endpoint's address or its secret.

The record of a delivery outlives its event on purpose: for sixty days you can still read what
happened to it, though there is nothing left to send again. Removing an endpoint removes its
deliveries at once. An environment's audit log has its own, separate period
([`audit.retentionDays`](self-host.md)).

## What can still be lost

A failed request is retried, a delivery behind a slow endpoint waits, and a secret the server
cannot open costs time and not events. What is left:

- **A delivery the server gave up**: eight failed requests, or three days pending. It is in
  the log as `failed` and can be [sent again](#send-a-delivery-again) for as long as its event
  is kept.
- **Events from while an endpoint was off**, whether you switched it off or the server did.
  They are never sent to it.
- **The deliveries of an endpoint you remove.**
- **An event from the instant right after a registration**, when the deployment's instances
  disagree about the time: an event recorded by an instance whose clock is behind the one that
  registered the endpoint can be judged to predate it. The window is the clock difference.

If you cannot afford a gap, reconcile from the admin API as well: the audit log lists every
event by the same id.

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
- The endpoints' secrets are encrypted with `TULA_MASTER_KEY`. If the key changes, nothing is
  sent (`signing_failed`, with a line in the log naming the endpoint's id) until the key is
  right again or the endpoints are registered again. Deliveries wait for up to three days.
- A round sends to an environment's endpoints side by side, **five requests at a time**, one
  per endpoint, **fifty deliveries per endpoint per round**, each with a five-second deadline,
  within fifteen seconds per environment. Environments are served one after another.
- A test event and a delivery sent again are made by the API instance that takes the call,
  not by the worker, and wait for the receiver for up to five seconds.
- The retention job deletes settled events after 30 days and ended deliveries after 90
  ([ADR 0017](adr/0017-retention.md)). Its log line counts them (`events`,
  `webhookDeliveries`).
- The first start of a version with webhooks settles the whole outbox, which has recorded
  every event since the deployment began: nothing of it is sent (no endpoint existed), the
  events are only marked, in bulk, up to 100,000 per environment every five seconds. The
  migration before it blocks writes to the outbox table while it runs, and so does the one
  that brought retries: see [Upgrading](self-host.md#upgrading), migrations `0018` and `0019`.

## Not built yet

- **Rotating a secret** without a gap (the verifier already accepts either of two signatures).
- **Endpoints in `tula.config.ts`** (`tula diff`, `tula apply`).
- **A dashboard screen** for endpoints and their delivery log.
- **Settings for the schedule**: the waits, the number of requests and the periods are fixed.
- **Sending again in bulk**: one delivery per call.

What of these steps was not verified against the real thing (a public `https` receiver, a
verifier in another language) is in
[plans/phase-2-unverified.md](plans/phase-2-unverified.md).
