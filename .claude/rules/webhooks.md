---
paths:
  - "apps/api/src/modules/webhook/**"
  - "apps/api/src/worker*"
  - "apps/api/src/process*"
  - "apps/api/src/lib/signing-secret*"
  - "scripts/worker-check/**"
  - "docker/worker-check/**"
  - "packages/contract/src/webhook*"
  - "packages/admin/src/**"
---

# Webhooks

Moved here from `AGENTS.md`, word for word, and canonical for this area: `AGENTS.md` lists
this file under "Area rules" and does not repeat it. A section named in a sentence as
"above" or "below" is found through that list.

## Webhooks (`modules/webhook`, see ADR 0034)

A **webhook** is a signed notice of something that has already happened; its answer changes
nothing ([GLOSSARY.md](../../GLOSSARY.md)). Never call it a callback or a hook: a hook is a question
whose answer decides what happens next (step 2.3).

- **The signing secret is the server's to make, shown once, stored sealed.** 32 bytes from the
  CSPRNG as `whsec_` + base64 (the Standard Webhooks format), returned only in the `201` of
  the registration (`Cache-Control: no-store`), sealed with `~/lib/secret-box` (purpose
  `webhook-secrets`, bound to environment and endpoint id). Never a request field, never
  returned by a read, a list or an update, never in a log line, an audit entry, an event
  payload or an error. A secret that cannot be opened puts its endpoint's deliveries
  off (`signing_failed`, no attempt counted), and is never a failed round.
- **A secret is replaced with an overlap, and an endpoint never has three**
  (`Webhooks.rotateSecret`, `POST …/:id/secret/rotate`). The new secret is the server's to
  make and is returned once; the one it replaces moves to the **previous slot** and signs
  beside it for `WEBHOOK_SECRET_OVERLAP` (24 hours, a constant). A rotation while a previous
  secret still signs is refused (`webhook.rotation_refused`, `rotation_in_progress`), in the
  service and again in the store's statement (`rotateSecret` is a compare-and-set on the
  stored ciphertext and on "no previous secret still signs"): never keep a third, and never
  drop the oldest silently. `Webhooks.revokePreviousSecret` (`DELETE …/:id/secret/previous`)
  ends an overlap early and is what makes a second rotation possible at once.
- **The previous secret is sealed for its own slot** (`previousAad`: environment, endpoint id
  and the word `previous`), so a ciphertext cannot be moved between the two columns, and a
  rotation opens the current secret and seals it again. The current secret's binding is what
  it has always been: never change it, existing rows must keep opening (a test seals one the
  old way). A current secret that cannot be opened cannot be rotated (`secret_unreadable`).
- **A delivery is signed in one place, `signedHeaders` (`~/lib/signing-secret`, shared with
  hooks), reached only through `request`** (the
  worker, a test event and a delivery sent again): the current secret's signature first,
  then, separated by a space, the previous secret's while its overlap lasts. **Whether the
  previous secret signs is decided there, at each request, from its stored end and
  `deps.clock`** (strictly before the end), never from whether anything has cleared it away.
  Its ciphertext is deleted by the worker's first pass of the next round
  (`clearExpiredPreviousSecrets`, unrecorded: ADR 0012), on endpoints that are on or off.
  Never add a second place that writes the header, never more than two entries, and never
  let the previous secret sign alone: when the current one does not open nothing is sent,
  and when only the previous one does not open the delivery is made with one signature and
  said once per endpoint per round.
- **Nothing of a secret in the record of a rotation**: `webhook_endpoint.secret_rotated`
  carries `rotationOverlapEndsAt` and nothing else, `webhook_endpoint.previous_secret_revoked`
  nothing at all. Not a prefix, not a fingerprint. **No value that is not a secret goes under
  a key that reads like one** (`secret`, `token`, `key`): the time is named for the overlap,
  on the endpoint and in the event, because anything that scrubs or flags by key name (the
  event canary test among them) would take it for a credential.
- **An endpoint's address is not written anywhere it could travel.** Not in an audit entry,
  not in an event payload (they go to every other subscribed endpoint), not in a log line. A
  change is recorded as `changed: ['url']`.
- **The outbound guard judges the address when it is saved and again at every delivery.**
  `Outbound.check(deps.outbound, url)` on a registration and on a change of address;
  `Outbound.request(deps.outbound, …)` for the delivery, never `fetch`. A refusal answers
  `webhook.url_not_allowed` with the guard's fixed word in `params.reason`, never the address
  or what its name resolved to. `deps.outbound` is built in `container.ts` as `{ tier }` and
  nothing else; never loosen the guard for a test, a scenario or a deployment.
- **Never store more of a receiver's answer than its status code and how long it took.**
  Neither `webhook_deliveries` nor `webhook_delivery_attempts` has a column for a header or a
  body and neither must get one; the one function that makes a request (`request` in the
  service) reads `answer.status` and drops the rest, `Retry-After` included. `failure_reason`
  is one of the server's own fixed words. An answer over the size cap is judged by its status
  (the guard's `response_too_large` carries the status code and nothing else): a 2xx is a
  delivery, anything else a failed request with that status. Never fail a delivery for the
  size of a body nobody reads. This is what keeps an endpoint from being a way to
  read whatever answers at its address. A new delivery path gets the canary test (a
  recognisable string in the answer's headers and body, absent from every store, log and
  answer of the admin API).
- **Signing is the contract's `signWebhook`** (`@tula-tech/contract/webhook-signature`, Zod-free,
  web platform APIs only): `v1,` + base64 HMAC-SHA256 over `<id>.<timestamp>.<body>`, the
  body being the exact text sent. The server, `@tula-tech/admin`'s `verifyWebhook` and the
  conformance runner all use it; the contract's tests hold the reference libraries' example.
- **Where deliveries are made is one variable, `WEBHOOK_WORKER`, and what a process is, is
  its command** (ADR 0034, "The worker as its own service"). `api` (the default): every API
  instance runs the delivery job. `separate`: only a worker process does (`src/worker.ts`,
  the same image; the Compose `worker` service, profile `worker`), and **an API instance
  makes no request to an endpoint**. `planProcess(role, mode)` (`~/process`) is the one place
  that decides, `container.ts` turns it into `config.deliversWebhooks`, and the webhook
  service reads nothing else: where it is false `Webhooks.run` returns before the job lock,
  `deliverPending` does nothing, and `sendTest` and `redeliver` are refused with
  `not_implemented` (501) and `params.reason: 'worker_separate'`. **The refusal has a fixed
  place on those two routes: after `secretKey()` (no key is still 401), before
  `sendRateLimit` and before any validator** (`deliveredHere` in the router), so a refused
  call is never a 429 or a 422 and spends nothing of the send bucket; the service refuses
  again (`requireDeliveryHere`, before any store is read). Keep both, and that order. A new
  path that calls an endpoint checks `deliversWebhooks` first
  and gets a test in `modules/webhook/worker-separate.test.ts`. A worker under `api` refuses
  to start (never let it run beside instances that deliver: the lock would keep it correct
  and the operator would believe traffic is separated). Never add a second variable, a
  per-container role or another code for the refusal (`@tula-tech/core`'s message table has every
  contract code, and its bundle budget has no room to give away).
- **The worker process serves health and nothing else** (`createWorkerApp`: `/v1/status`,
  `/v1/ready`, the contract's 404 for the rest), runs no migration, creates no signing key
  and imports no router: `worker.test.ts` walks `worker.ts`'s import graph and fails for a
  router, the API app, the JWKS bootstrap or a migration. The walk follows `~/` and
  relative specifiers through the API's own files (never into a package), by every way of
  loading a module Bun's parser reports (`import … from`, a bare `import '…'`,
  `export … from`, `require('…')`, `import('…')`; not an import of types only). It **fails**
  for a file with an `import(` or `require(` whose argument is anything but one string
  written out (a variable, a concatenation, a conditional, a template with a substitution),
  and for a file with `new Function(` or a bare `eval(`. Those two rules read the
  transpiled text, so a string that contains such a call fails the walk too: reword the
  string, never loosen the rule. Never load a module in the worker's graph by a name that
  is not written out. It is built by the same
  `createContainer`, so `deps.outbound` is `{ tier }` there too. **The Compose `worker`
  service is not given `TULA_ADMIN_TOKEN`**, nor anything else only the API reads and a
  process starts without (`compose.test.ts` holds its environment to the API's minus a
  named list): a new variable goes in `x-process-environment` only if the worker uses it or
  `env.ts` demands it of every process. On `SIGTERM` it lets the
  round under way record the requests it is making and exits; what was not sent waits for
  the next round of any worker.
- **"Nobody delivers" is said by the diagnostics, from the outbox** (`webhook_worker`, ADR
  0031): an event that has waited a minute to be queued is `fail` under `separate` and `warn`
  under `api`, read inside the one bounded scan `master_key` makes (never a second scan),
  fixed text, counts only. It looks at what waits, not at a worker, and its `ok` says so:
  never reword it to claim a worker is running. There is no heartbeat, on purpose.
- **The worker is `Webhooks.run`, on every process that delivers, under its own job lock**
  (`'webhook_delivery'`, advisory lock id 2: never renumber). Per environment, four passes in
  this order: settle in bulk what is owed to nobody; **queue** (every other waiting event
  becomes one `pending` delivery per endpoint it is **owed** to: switched on, subscribed to
  its type, registered no later than it happened; then the event is settled); give up what
  has been pending longer than `WEBHOOK_DELIVERY_MAX_AGE`; **send** what is due. A row with
  no `schemaVersion` (recorded before the event contract) is never queued: it is settled and
  counted. One environment's failure is logged and skipped, and each has a time budget per
  round.
- **The delivery is the unit of work, and an event is settled when its deliveries exist.**
  Never make a request while walking the outbox, and never leave an event unsettled because
  an endpoint is failing: that is head-of-line blocking of the environment's outbox by one
  endpoint, the thing the model exists to rule out. `events.delivered_at` means "queued", not
  "received". The worker reads only `pending` deliveries; `delivered` and `failed` are final
  for it.
- **A request is an attempt; what was not sent is not.** Every request the worker tried to
  make is a row of `webhook_delivery_attempts` (append-only: the runtime role has no `UPDATE`
  and no `DELETE` on it), written with the delivery's new state in one transaction
  (`recordAttempt`: the update counts under the row's lock and the insert uses the number it
  returned). `endpoint_unresponsive` (the endpoint had just let a request time out: the rest
  of what it has due is put off a minute) and `signing_failed` (its secret would not open:
  put off five minutes, logged **once per endpoint per round with a count**) go through
  `defer`: no attempt row, no attempt counted, never against the limit. Never write either
  word for a request that was made, and never count one. What bounds them is the age limit.
- **The schedule, the caps and the periods are constants** (`WEBHOOK_RETRY_DELAYS`,
  `WEBHOOK_MAX_ATTEMPTS`, `WEBHOOK_ENDPOINT_ROUND_CAP`, `WEBHOOK_MAX_CONCURRENT_DELIVERIES`,
  `WEBHOOK_DISABLE_AFTER`, …), in the service, and every one is stated in `docs/webhooks.md`:
  change both together. Jitter comes from `deps.jitter` (never `Math.random`), is clamped by
  the service, and only ever lengthens a wait. `Retry-After` is never read.
- **One request in flight per endpoint; endpoints side by side.** `serveEndpoint` is one
  endpoint's lane and makes its requests one after another; `sideBySide` runs at most
  `WEBHOOK_MAX_CONCURRENT_DELIVERIES` lanes. Never send two events to one endpoint at once
  from the worker, and never let one lane's failure stop the others.
- **The server switches an endpoint off for two reasons, as the `system` actor, recorded as
  `webhook_endpoint.disabled`**: it answered `410` (`gone`), or it has a **run** of failed
  requests `WEBHOOK_DISABLE_AFTER` long (`failing`). A run is failed requests with no success
  among them **and no silence between two of them longer than
  `WEBHOOK_FAILURE_RUN_MAX_GAP_MS`** (the whole retry schedule with the most jitter, plus
  `WEBHOOK_FAILURE_RUN_MARGIN`: about 34 hours; computed from the schedule's constants, never
  a number of its own). `failing_since` is when the run began and `last_failed_at` when a
  request last failed: a failure after a longer silence begins a new run instead of
  continuing the old one, because an endpoint that was sent nothing has not been shown to be
  still broken. Never judge by `failing_since` alone (one bad day, a fix and a hiccup a week
  later must not switch an endpoint off). A success clears both. The rule reads the endpoint
  row the lane already holds and is looked at only when a request has just failed: never add
  a scan. Both columns are written by `setHealth`, the one endpoint write with no `Activity`
  (ADR 0012), and **a failure writes them only over what the lane read** (`setHealth` is a
  compare-and-set; on a miss the worker reads the row again and applies the rule to it):
  an administrator's reset, or a delivery sent again that got through, during a round must
  never be undone by the lane's next failure. Only a success writes blindly. A dead endpoint
  that is owed an event less often than the retry span plus that limit (about two and a half
  days) is never switched off: accepted, and said in `docs/webhooks.md`. Switching an endpoint on, or changing its address, resets them and the reason
  (`resetHealth`). Pending
  deliveries of an endpoint that is off are neither tried nor counted, and are given up only
  by age.
- **A test event and a delivery sent again are requests on demand** (`Webhooks.sendTest`,
  `Webhooks.redeliver`): through the outbound guard, one request, no retry, behind
  `sendRateLimit` (its own per-environment bucket, mounted after `secretKey()`), answering
  only `{ deliveryId, outcome, statusCode, durationMs, failureReason }`. Neither is audited,
  neither ever switches an endpoint off, and a **failed** one of either moves nothing. What
  a success does differs, on purpose: a delivery sent again that gets through **ends the
  endpoint's run of failures** (`clearHealth`: the receiver took a real event), and a test
  event that gets through does **not** (it is no delivery of an event, and a receiver may
  answer tests without doing what it does for a real one). A test event is the
  contract's fixture with a new id and **`test: true` inside the signed body**; it never
  touches the outbox, and the caller chooses the type and nothing else. Sending again appends
  an attempt to the **existing** delivery (never a second row) and is refused with
  `webhook.cannot_redeliver` and a fixed `params.reason` (`WEBHOOK_REDELIVER_REFUSALS`), one
  of which is `attempt_limit`: a delivery never has more than `WEBHOOK_MAX_TOTAL_ATTEMPTS`
  requests, so its log and the answer that returns it are bounded. The delivery list pages
  and counts no further than `WEBHOOK_DELIVERY_LIST_WINDOW` rows (the query schema refuses a
  page past it; the store's count takes `maxCount`): never an offset or a count over the
  whole log. A delivery is always looked up under
  its endpoint and its environment (`find(environment, endpoint, id)`): keep the
  cross-environment tests.
- **What is owed to nobody is settled in bulk, by one store call a batch**
  (`WebhookDeliveryStore.settleBefore(environment, cutoff, at, limit)`): events from strictly
  before the earliest endpoint that is **switched on** was registered, or before the pass
  began when none is on. An event at the same instant as that registration is owed and is
  left for the per-event path. A switched-off endpoint's date does not count: "owed" is
  decided by the endpoints as they are when the worker looks. Keep the boundary and the
  isolation tests in the shared suite.
- **The cap on endpoints is counted and inserted under the environment's lock**
  (`deps.environmentLock`, scope `webhook_endpoints`); the address is judged before the lock.
- **Delivery is at least once and says so**: a request is sent before its attempt is written,
  and one that was sent and not recorded is sent again and **not counted**; the unique
  `(endpoint_id, event_id)` makes a second delivery row a no-op. Order is not guaranteed.
  Docs and the verifier's JSDoc tell a receiver to drop repeats by id, to order by
  `occurredAt` and to check `test`.
- **`verifyWebhook` (`@tula-tech/admin`) is Zod-free and web-platform only**, takes one secret or
  a list of at most `WEBHOOK_MAX_SECRETS` (two: what the server ever signs with; an empty
  list, a third or a malformed entry beside a good one is `webhook.invalid_secret`), computes
  every secret's signature before comparing anything and compares every entry with every one
  without a branch, refuses a wrong or
  missing signature (constant-time, every entry compared), a malformed header, a
  `webhook-id` or `webhook-timestamp` sent twice (as a list in a plain record, or joined with
  a comma by a `Headers` object) and a timestamp more than five minutes away in either
  direction. A `webhook-signature` sent twice is one list, as the reference library reads it:
  it accepts any one right entry of however many, and never puts the secret, a signature or the body in an error.
- **The `webhook` conformance step needs a receiver the server can reach.** A scenario with
  one is marked `needsWebhookReceiver` and skipped by a target without one; a live server in
  a container cannot reach the runner's loopback, and the answer to that is the skip, never a
  looser guard. CI's `self-host` jobs check the **exact set of skipped scenarios by name**
  (`.github/workflows/ci.yml`): a new scenario with a receiver is added to that list (and
  to the count in the two summary lines beside it), never covered by a count alone. What cannot be shown over HTTP (a name re-pointed between save and delivery)
  is an API test, and the scenario's description says so.
- **The one delivery CI makes from a container is the worker check's** (the
  `self-host-worker` job, `scripts/worker-check/check.ts`), and it keeps to the guard: its
  receiver runs in the **worker's network namespace** (`docker/worker-check/compose.yml`,
  `network_mode: service:worker`) and listens on 127.0.0.1, which the `local` tier allows
  and which no API container can reach. Never give the receiver a port, a network of its
  own or a private address, never set `ENVIRONMENT` or anything else in that job to make an
  address pass, and keep the job starting the stack **without** the worker: the check has to
  see an owed event wait before it starts the worker itself.
  `.claude/hooks/{ci,compose,worker-check}.test.ts` hold all of it.
- A new event type, a new store method that changes an endpoint, or a new kind of secret
  follows the existing rules: a schema and a fixture in the contract, an `Activity` and a
  `@ts-expect-error` line, a pattern in `@tula-tech/mcp`'s `SECRET_SHAPES`.

## What to test

The failure paths a change here is held to (moved from the checklist of `security.md`; the
rules themselves are above and are not repeated).

- **The secret's binding:** a ciphertext copied to another endpoint's and another
  environment's row does not open. An existing row sealed the old way still opens; the
  current ciphertext in the previous slot and the previous one in the current slot do not.
- **The guard at delivery:** a name that passed when saved and resolves to a private address
  at delivery, and that nothing was sent.
- **A receiver's answer:** a canary in the answer's headers and body, against the delivery
  row, the logs and every store. For an answer over the size cap: a 2xx (delivered, once) and
  a non-2xx, with a canary in the oversized body.
- **Isolation:** one endpoint's failure, slowness or removal mid-round must not fail the
  round or another environment's deliveries.
- **Bulk settling** is strict at its cutoff: the event at the very instant of the earliest
  switched-on endpoint's registration (owed, not settled), a switched-off endpoint, and
  another environment.
- **The cap:** keep the concurrent-registrations test.
- **Retries:** the whole schedule on the test clock (a millisecond early is too early), the
  eighth failure, and that a request sent and not recorded is sent again and not counted.
  For `endpoint_unresponsive` and `signing_failed`: many more rounds than there are attempts,
  never an attempt row, never counted.
- **Switching an endpoint off:** `410` at once; a run of failures five days long and not a
  millisecond less; the silence exactly at `WEBHOOK_FAILURE_RUN_MAX_GAP_MS` and a millisecond
  over; one failed delivery, five quiet days, one failure (still on); one success resets it
  and re-enabling resets it; a reset made while a round is sending is not undone by that
  round's next failure (the stale write in the store suite and the round in the service); the
  `webhook_endpoint.disabled` entry is the `system`'s, with no address or secret.
- **A test event** writes no outbox row and no audit entry, goes through the guard (a name
  re-pointed at a private address), and its answer has five named fields and no canary.
- **Sending again:** the stored payload only, refused while pending, for an endpoint that is
  off and for an event that is gone, and **impossible across environments** (their key with
  our endpoint id, with their own, and a sibling endpoint: 404, nothing sent). The send
  limit refuses when it cannot count.
- **Rotation:** nothing of either secret in a read, an audit entry, an event payload, a log
  line or an error (test with both secrets and their base64 parts, and that no response field
  is even named like a secret). The end of the overlap one millisecond before and at it **on
  the clock alone** (no round has cleared the row), a previous secret that expires mid-round,
  and that a test event and a delivery sent again sign the same way. Never three: a rotation
  during an overlap (409, `rotation_in_progress`, nothing changed or recorded), two at once
  (one wins, in the service and in the store suite), and the instant the overlap ends
  (allowed). The early end: with and without an overlap under way, and at the instant it
  ended by itself. Both are impossible across environments, with the answer an unknown id
  gets. The expired ciphertext is deleted on an endpoint that is off too, without moving
  `updatedAt`.
- **`verifyWebhook` with a list:** either secret, both orders, an empty list, a third secret,
  a malformed entry beside a good one, and one HMAC per secret whichever matched.
- **Retention:** a recent event, an unsettled one, a pending delivery and a recent one
  against the store on PGlite, and that `created_at` and `occurred_at` cannot be updated to
  get past the floor.
