# ADR 0034 — Webhooks: endpoints, signing and the first delivery

- Status: accepted
- Date: 2026-10-08
- Amended: 2026-10-08, by the second step of 2.2 (TULA-42): [Retries, disabling and the delivery log](#retries-disabling-and-the-delivery-log-added-2026-10-08-tula-42).
  That section changes four decisions of this record (one attempt per delivery, when an event
  is settled, the insert-only delivery table, the cascade from an event to its deliveries);
  the paragraphs it supersedes are marked.

## Context

Every change to who can do what has been written to an outbox (`tula.events`) since Phase 0,
in the transaction of the change ([ADR 0012](0012-events-and-audit-log.md)), and nothing has
ever read it. Step 2.1 of [Phase 2](../plans/phase-2.md) gave each event a typed payload with
a schema version, and built the one way the server may call an address an operator typed
(`~/lib/outbound`). This step is the first thing that sends: an operator registers an endpoint
for an environment, picks event types, and the server posts each such event to it, signed.

A **webhook** is a signed notice of something that has already happened; its answer changes
nothing ([GLOSSARY](../../GLOSSARY.md)). A *hook*, whose answer decides what happens next, is
step 2.3 and not this.

This record began as the tracer bullet only: one endpoint, one signed delivery, one attempt.
What it deliberately left out is listed under [Not built yet](#not-built-yet). The next step
is recorded in this same file, in [Retries, disabling and the delivery log](#retries-disabling-and-the-delivery-log-added-2026-10-08-tula-42).

## Decision

### Data

Two tenant tables (migration `0018`), each with the usual mixins, the composite
environment/project foreign key and the fail-closed row-level-security policy, forced.

**`webhook_endpoints`**: `url`, `event_types` (a text array of names from the contract's
`ACTIVITY_TYPES`, validated by the API; the database does not know the list), `secret`
(sealed, below), `enabled`. The runtime role has `SELECT`, `INSERT`, `UPDATE` and `DELETE`: an
administrator removes an endpoint on the request path.

*Superseded in part by [Retries, disabling and the delivery log](#retries-disabling-and-the-delivery-log-added-2026-10-08-tula-42): the row now has a state and is updated, each request
is a row of a second table, and the reference to the event is no longer a foreign key.*

**`webhook_deliveries`**: one row per endpoint and event (a unique key on the pair):
`endpoint_id`, `event_id`, `attempted_at`, `outcome` (`delivered` or `failed`), `status_code`
(or null), `duration_ms`, `failure_reason` (or null), with an index on `(environment_id, event_id)` for
the worker's per-batch lookup and for the cascade from a deleted event. Both references are tenant foreign keys
(composite on `environment_id`, so a row cannot join one environment's endpoint to another's
event) and cascade. The runtime role has `SELECT` and `INSERT` and nothing else: what happened
to a delivery cannot be rewritten or removed by the API's role, and a row goes only with its
endpoint or its event.

**`events`** gains the unique `(environment_id, id)` that the delivery rows reference, and its
partial index of undelivered rows now leads with the environment
(`events_environment_undelivered_idx` on `(environment_id, occurred_at, id) where delivered_at
is null`, replacing `events_undelivered_idx`, which nothing read): the worker asks one
environment at a time, and an environment with nothing waiting should not scan the others'
backlog. The runtime role already held `UPDATE` on `events` (migration `0003`), which is what
setting `delivered_at` needs; it still has no `DELETE`. Deleting delivered events stays where
[ADR 0017](0017-retention.md) left it: a later step, with its own grant and policy.

### The signing secret

`whsec_` followed by the base64 of 32 bytes from the system's CSPRNG: the Standard Webhooks
secret format, 256 bits, inside the 24 to 64 bytes that specification allows.

- **The server generates it.** The create request is a strict object with no `secret` field,
  so a caller cannot choose a weak one or reuse one.
- **It is returned once**, in the `201` of the registration (`Cache-Control: no-store`), and
  by nothing afterwards: not the read, not the list, not an update's answer.
- **It is stored sealed** (`~/lib/secret-box`, purpose `webhook-secrets`, AES-256-GCM under a
  key derived from `TULA_MASTER_KEY`), bound to the environment and the endpoint's id, so a
  ciphertext copied to another row does not open. It has to be recoverable, because the
  server signs with it; that is the one reason it is sealed rather than hashed.
- It never reaches a log line, an audit entry, an event payload or an error. `@tula/mcp`'s
  `SECRET_SHAPES` has a pattern for it.

A secret that cannot be opened (most often a changed `TULA_MASTER_KEY`) is not an error of the
round: nothing is sent, the delivery is recorded as `failed` with `signing_failed`, and a line
is logged with the endpoint's id.

### Signing

[Standard Webhooks](https://www.standardwebhooks.com/), the symmetric scheme, so that a
receiver in a language Tula has no SDK for can use an existing verifier:

| | |
| --- | --- |
| `webhook-id` | The event's id, which is also its audit entry's. A delivery that is repeated carries the same id. |
| `webhook-timestamp` | When this attempt was sent: whole seconds since the Unix epoch. |
| `webhook-signature` | `v1,<base64>`: HMAC-SHA256 over `<id>.<timestamp>.<body>`, keyed with the base64-decoded part of the secret. |

The body is the stored payload written out once; exactly that text is signed and sent. The
header is defined as a space-separated list so that two secrets can sign during a rotation;
this step sends one entry, and the verifier already accepts any one of several.

The names, the prefix, the tolerance and the signing function are one Zod-free module of the
contract, `@tula/contract/webhook-signature` (web platform APIs only), used by the server to
sign, by `@tula/admin` to verify and by the conformance runner to check.

**What this was checked against.** The specification text
(`standard-webhooks/standard-webhooks`, `spec/standard-webhooks.md`) and the reference
JavaScript library's source, both read on 2026-10-08: the header names, `v1,` and standard
(not URL-safe) base64, the `whsec_` prefix and the 24 to 64 byte key, the signed content, the
space-separated list, and the five-minute tolerance in both directions. The contract's tests
hold the reference libraries' shared example (secret, id, timestamp, body and expected
signature) and `signWebhook` produces that signature. Once, by hand, a delivery signed here
was verified by the published `standardwebhooks` 1.1.1 package and its signature by
`verifyWebhook`; that check is not part of the repository.

**What it was not checked against** is in
[phase-2-unverified.md](../plans/phase-2-unverified.md): a verifier in a language other than
JavaScript, and a real public `https` receiver.

Two places where Tula's payload is not what the specification *recommends* (neither is a
requirement, and neither affects verification): the event's time is `occurredAt`, not
`timestamp`, and the envelope has `schemaVersion`, `actor` and `target` beside `type` and
`data`. The payload shape was fixed by step 2.1 and is a public contract.

### The admin API

`/v1/admin/webhook-endpoints`, behind `secretKey()` like every admin route (a secret key, or a
dashboard session with `x-tula-environment`):

| | |
| --- | --- |
| `POST /` | Register. `{ url, eventTypes, enabled? }`; answers `201` with the endpoint and its secret. |
| `GET /` | List, oldest first. Never a secret. |
| `GET /:id` | Read one. Never a secret. |
| `PATCH /:id` | Change `url`, `eventTypes` or `enabled`; a field left out keeps its value. |
| `DELETE /:id` | Remove, with the record of its deliveries. `204`. |

An environment holds at most ten endpoints (`MAX_WEBHOOK_ENDPOINTS`): every event is sent to
each subscribed endpoint, so the number bounds the requests one event causes. The count and
the insert happen under the environment's lock (`deps.environmentLock`, scope
`webhook_endpoints`, the advisory lock that `Settings.replace` and `OAuth.update` use for
their own invariant), so registrations that arrive together, on one instance or several,
cannot each see room for one more. The address is judged before the lock is taken: resolving
a name can take seconds.

Every write takes an `Activity`, in the port and both adapters (`ports/activity-log.test.ts`
holds the `@ts-expect-error` lines). Three new activity types, each with a schema and a
fixture in the contract:

| Type | `data` |
| --- | --- |
| `webhook_endpoint.created` | `eventTypes` (how many), `enabled` |
| `webhook_endpoint.updated` | `changed`: names from the closed list `url`, `eventTypes`, `enabled` |
| `webhook_endpoint.deleted` | nothing |

Their target is a new target type, `webhook_endpoint`, with the endpoint's id. The alternative
was `environment`, as an OAuth provider's credentials use; but a provider is one of three
fixed names per environment and is identified in `data`, while an endpoint is one of several
rows with an id of its own, like an API key. With its own target type, the audit log's
`targetId` filter finds everything that happened to one endpoint.

**The address is never in an audit entry or an event payload**, nor is the list of event
types by name. An address can carry a token in its path or query (many receivers are
registered that way), and an event payload goes to third parties: to every *other* endpoint
of the environment that subscribed to `webhook_endpoint.*`. `changed` says `url` when the
address changed, never what it is or was. An update that changes nothing writes and records
nothing.

### The outbound guard, when saved and when delivered

`lib/outbound.ts` gains `check(deps, url)`: the rules of `request` up to the point of
connecting (`https` only, `http` in the `local` tier; no credentials; the host resolved, and
every address it has must be public, loopback too in the `local` tier), and nothing is sent.
`request` and `check` share the two functions that hold those rules.

- **When saved.** A registration, and an update that changes the address, call `check`. A
  refusal is the contract error `webhook.url_not_allowed` (422) with `params.reason`, the
  guard's fixed word (`invalid_url`, `scheme_not_allowed`, `resolve_failed`,
  `address_not_allowed`, `timeout`). The answer never repeats the address or what its name
  resolved to.
- **When delivered.** Every delivery goes through `Outbound.request`, which resolves and
  judges again, connects to the address it judged, follows no redirect and takes no proxy
  from the environment. Passing the check when saved is not a licence: a name can be pointed
  at a private address afterwards, and that delivery is refused (`address_not_allowed`),
  recorded, and nothing is sent.

The guard's settings are one entry of `Deps`, `deps.outbound`, wired in `container.ts` (the
tier and nothing else: the system resolver, the system's certificate authorities) and in
`createTestDeps()` (a resolver that knows only the names a test gives it, so no test asks a
real name server).

*Accepted residual.* `params.reason`, and the same word on a delivery record, tell an
administrator whether a name resolves from the server and whether it resolves to an address
the server may call. That is one bit about the server's view of DNS, to someone who holds a
secret key; the alternative, one undifferentiated refusal, makes a mistyped host name
indistinguishable from a blocked one. No address is ever returned.

### Nothing of the receiver's answer is kept beyond its status and duration

An endpoint's address may lead anywhere the guard lets through. If an answer's headers or body
were stored, or shown, registering an endpoint would be a way to *read* whatever answers
there. So:

- the delivery row has columns for a status code, a duration and one of the server's own
  fixed words, and no column that could hold a header or a body (a test reads the table's
  column list);
- the worker reads `answer.status` and drops the rest in the function that made the request;
- nothing of an answer, an address or a secret is logged: a round's log line is counts, and a
  failure's is an environment id, an endpoint id and a fixed reason;
- the answer body is capped at 16 KiB (`WEBHOOK_MAX_RESPONSE_BYTES`). Nothing is done with
  it; the cap only bounds what a receiver can make the server take in. ~~A larger answer is a
  failed delivery (`response_too_large`) with no status.~~ *Superseded (2026-10-08, review of
  TULA-42): a larger answer is judged by its status code, which arrives before the body. See
  "An answer over the cap" in the section on retries.*

### The worker

`Webhooks.run(deps)`, started by `server.ts` on boot and every five seconds
(`WEBHOOK_DELIVERY_INTERVAL_MS`) **on every API instance**, under
`deps.jobLock.runExclusive('webhook_delivery', …)`: a Postgres advisory lock with its own id
(2; retention keeps 1), so one instance runs a round and the others skip it, and a round still
running when the next is due is not started twice. The two jobs do not exclude each other.
This is decision D9's default; running the worker as a separate service from the same image is
a later step, and there is no queue.

*Why five seconds.* Nothing wakes the worker when an event is written, so the interval is the
delay an operator's backend sees. An idle round costs one indexed query per environment on
the one instance that holds the lock. The interval is a constant, like retention's: the
codebase has no pattern for overriding a job's timer and this step does not start one.

One round (`Webhooks.deliverPending`), per environment:

0. **Settle in bulk what is owed to nobody.** Every event from before the earliest endpoint
   that is switched on was registered (or, with no endpoint on, from before this pass began)
   is marked delivered by one store call per batch (`settleBefore(environment, cutoff, at,
   limit)`: 5,000 events a statement, at most twenty a round), unread and with no delivery
   row. The comparison is strict: an event at the very instant the earliest endpoint was
   registered is owed to it and is left for step 1. **A switched-off endpoint's date does not
   count**, because "owed" is decided by the endpoints as they are when the worker looks, and
   an endpoint that is off is owed nothing; the per-event path would settle the same events
   one at a time. Without this step a deployment's first real delivery waits behind its whole
   history at 1,000 events a round. These events are counted in the round's report
   (`unowed`). Rows of the pre-contract shape among them are settled the same way and are not
   counted separately.
1. Read the undelivered events, oldest first, 100 at a time, at most ten batches (1,000
   events per environment per round; a larger backlog is finished by the following rounds).
2. For each event, the endpoints it is **owed to**: switched on, subscribed to the event's
   type, and registered no later than the event happened (`created_at <= occurred_at`; the
   endpoint's `created_at` is the instant of its own `webhook_endpoint.created` entry, so the
   comparison never depends on which of two clock readings came first). Without the last rule
   a new endpoint would be sent whatever happened to be waiting.
3. For each such endpoint that has no delivery row for the event yet: sign, post through the
   guard with a five-second deadline (`WEBHOOK_DELIVERY_TIMEOUT_MS`), and insert one row.
   `delivered` is a 2xx status; anything else, or no answer, is `failed`. A redirect is an
   answer like any other and is never followed.
4. Mark the event delivered once every endpoint it was owed to has a row, **which includes
   the event that was owed to nobody**. This is what stops the outbox growing.

*Superseded by [Retries, disabling and the delivery log](#retries-disabling-and-the-delivery-log-added-2026-10-08-tula-42): a failed request is retried, and steps 3 and 4 above are now
two passes (queue, then send).*

**At most one attempt per endpoint and event.** (Two cases below are settled with none.) A
failure is recorded and not repeated: retries, with
backoff and a point of giving up, are the next step. The row was shaped for them: it is keyed
by endpoint and event and already says when the attempt was made and how it ended, so a retry
adds an attempt count and a next-attempt time and updates the row (with an `UPDATE` grant the
role does not have today), and "settled" becomes "delivered or given up" in one function.

**Delivery is at least once.** The request is sent before its row is written. A round that
ends between the two (a crash, a database failure) sends again next time, with the same
`webhook-id`; a receiver drops the repeat by id. When recording fails, the events settled
before it in the batch are still marked, so only the one in flight is repeated. On shutdown
the server tells the round under way to stop (an `AbortSignal`): it finishes the one delivery
it is making, records it, sends nothing more and leaves the rest for the next start, and the
server waits for that before it closes the pool. One delivery's deadline (five seconds) is
inside the ten seconds a shutdown is given.

**Rows the worker never sends.** A row written before step 2.1 holds `{ actor, target, data }`
with no `schemaVersion`: a shape no receiver was promised. It is marked delivered without
being sent and counted in the round's report (`skipped`). So is a row whose payload does not
carry its own row's id and type.

**Isolation.** A failure in one environment is logged and the next is served, as in the
retention job. Environments are served one after another, so each has a time budget per round
(15 seconds, `WEBHOOK_ENVIRONMENT_BUDGET_MS`): an environment whose endpoint hangs stops when
its budget is spent and what it has left waits for the next round. The list of endpoints is
read again for every batch, so one switched off or removed stops being sent to; one removed
while its delivery is under way leaves no row (the foreign key) and does not fail the round.

*Superseded by [Retries, disabling and the delivery log](#retries-disabling-and-the-delivery-log-added-2026-10-08-tula-42): the rest of the round is put off for a minute, not settled,
and nothing is lost to it. The same holds for the secret that cannot be opened, below.*

**An endpoint that does not answer costs one deadline a round, and loses the rest of that
round.** Deliveries within an environment are made one after another, so an endpoint that
accepts the connection and never answers would otherwise take five seconds of the budget for
every event and leave the environment's healthy endpoints about three events a round. After
an endpoint lets one delivery run out its deadline, the rest of what it is owed **in that
round** is settled without being tried: a row with outcome `failed`, reason
`endpoint_unresponsive`, no status code and a duration of zero, and **no request was made**.
The next round tries the endpoint again. Only a timeout does this: an endpoint that answers
with an error, or refuses the connection, fails fast and is tried for every event.

This is a real loss and not only for an endpoint that is down. **A receiver that is slow
once, for one delivery, can lose up to a round's worth of events for that endpoint (at most
1,000), and nothing sends them again**: this step has no retries. They are not left
unsettled instead, because with no retry and no point of giving up, an endpoint that hangs
for good would then hold its environment's outbox for ever. The row says exactly what
happened (`endpoint_unresponsive` is never written for an event that was sent), so the next
ticket of step 2.2, retries, can pick these rows up first. Until then the guidance to a
receiver is to answer inside the deadline, always.

**A secret the server cannot open is the server's fault, and is said once.** When an
endpoint's sealed secret does not open (a `TULA_MASTER_KEY` that is not the one it was sealed
with, on one instance or on all), nothing is sent to that endpoint and each event it was owed
is settled with `signing_failed`. The receiver did nothing wrong and is told nothing; like
the case above, the events are not sent later. The log has one line per endpoint per round,
`webhook signing secret could not be opened; nothing was sent to the endpoint this round`,
with the environment's id, the endpoint's id and how many events it cost, not a line per
event. An operator who sees it checks that every instance runs with the same
`TULA_MASTER_KEY` and that it is the key the deployment has always had (`tula doctor`'s
`master_key` check); if the key is truly gone, the endpoint has to be removed and registered
again, which issues a new secret.

**Clocks.** "Registered no later than the event happened" compares two timestamps that may
come from two API instances. If the instance that recorded an event runs behind the one that
registered the endpoint, an event from just after the registration can be judged to predate
it: it is owed to nobody, marked delivered and never sent, with nothing recorded. The window
is the instances' clock skew, right after a registration. Instances are expected to keep
their clocks together (`tula doctor` has a clock check); no grace is applied, because a
grace would send an endpoint events from before it existed.

**A failure that is not the receiver's.** If recording a delivery fails (the database), or
anything throws that is not the guard's own error, the environment's round ends and the event
stays first in line. If that happened after the request was sent, the next round sends it
again; a cause that persists would repeat that every round and hold back the environment's
later events. No such cause is known, and nothing counts these failures yet: retries, which
need exactly that count, are where a limit belongs.

**Events while an endpoint is off are not sent later.** They are owed to nobody at the time
and are marked delivered. Switching an endpoint off is how an operator stops deliveries, not
how they pause them; a replay ("redeliver") is a later step.

Ordering is not guaranteed across rounds or endpoints; a payload carries `occurredAt`.

### The receiving side: `verifyWebhook` in `@tula/admin`

`verifyWebhook(body, headers, secret, options?)` takes the raw body (text or bytes), the
request's headers (a `Headers` object or a plain record, names in any case) and the endpoint's
secret, and returns the event typed from the package's generated types (the generator now
takes the `TulaEvent` component as a root for the admin half; no operation returns it). It
refuses, with a `TulaAdminError` of status 0:

| Code | When |
| --- | --- |
| `webhook.invalid_secret` | The secret is not `whsec_` and base64 of 24 to 64 bytes. |
| `webhook.invalid_headers` | A header is missing, empty or malformed; `webhook-id` or `webhook-timestamp` was sent twice; the id has a full stop or a comma; more than eight signatures. |
| `webhook.timestamp_out_of_tolerance` | The timestamp is more than five minutes old, or more than five minutes ahead. |
| `webhook.invalid_signature` | No `v1` entry is the signature for the secret (compared in constant time, every entry). |
| `webhook.invalid_payload` | Signed correctly, but not an event whose `id` is the `webhook-id`. |

*Repeated headers.* A plain record keeps a repeated header as a list; a `Headers` object has
already joined the values with `, `. A `webhook-id` or `webhook-timestamp` sent twice is
refused either way (a value with a comma in it is refused, since neither has one). A
`webhook-signature` sent twice is **accepted when any entry is right**: the header is a list
by definition, the reference JavaScript library reads a joined value the same way (it splits
on spaces and takes what stands between the first and second comma of each entry), and a
second entry cannot make a wrong delivery verify.

It is Zod-free at run time (hand-written guards on the envelope; `data` is typed and not
validated, since the signature is what makes the body Tula's) and uses web platform APIs
only. An error never carries the secret, a signature or the body. An event of a type this
version does not list is returned, not refused: a later server may add one.

### Conformance

A new step type, `webhook`, in the runner: `captureUrl` starts a named receiver (an HTTP
listener the runner owns, answering `204`) and stores the URL to register; `expect` takes the
next delivery there and checks the headers, the signature for the secret the registration
returned, the timestamp, that the body is an event of the contract, and a subset match of the
event. In process the target runs one round of the real worker; against a live server the
step waits for the server's own, up to 30 seconds.

A scenario with such a step is marked `needsWebhookReceiver` and is skipped, with its reason,
by a target that offers no receiver. The server must be able to reach the runner's listener,
and the guard refuses private and loopback addresses outside the `local` tier, and private
ones in it: so against a live server the scenario runs only where the server is in the
`local` tier on the runner's own machine. CI's `self-host` jobs run the server in containers,
skip that one scenario and assert it is the only one skipped. **The guard is never loosened
to make a scenario run.**

- `47-webhook-delivered-and-signed` (needs a receiver): registered, secret once, delivered,
  signed, the event's id is the audit entry's, the audit log has no address and no secret.
- `48-webhook-refused-address` (runs everywhere): the guard's refusals when an address is
  saved, on a registration and on a change. That an address which passed when saved is
  refused **when delivered** cannot be shown over HTTP alone (a scenario cannot change what a
  name resolves to); it is covered by the API's tests with a resolver the test controls, and
  the scenario's description says so.

Neither has a `@tula/core` journey: both are listed as server-only, with the reason, and
`@tula/admin` is driven against the real API and worker in
`packages/admin/src/webhook-real-api.test.ts`.

## Retries, disabling and the delivery log (added 2026-10-08, TULA-42)

The second step of 2.2. It changes four things the first one decided, and each is said here
rather than rewritten above, so that the first decision can still be read: **a delivery is no
longer one attempt**; **an event is settled when its deliveries exist, not when they have been
tried**; **`webhook_deliveries` is no longer insert-only**; and **the delivery row no longer
cascades from its event**. Where a paragraph above says otherwise (one attempt, "settled
without being tried", "lost until retries exist", "no API to read these records"), this
section is what holds.

### The model: the delivery is the unit of work

The first step sent each event to each endpoint while it walked the outbox, and settled the
event when every endpoint had been tried. With retries that would let one failing endpoint
hold its environment's outbox for a day: the worker reads unsettled events oldest first, so an
event waiting for its eighth attempt would stand in front of everything that happened after
it. **Head-of-line blocking of an environment's outbox by one endpoint was the main risk of
this step**, and the model is chosen to make it impossible rather than unlikely.

A round, per environment, is now four passes:

1. **Settle what is owed to nobody**, in bulk, as before. "Owed" keeps its definition
   (switched on, subscribed, registered no later than the event), so the bulk settle is as
   correct as it was: it only ever marks events that would get no delivery row.
2. **Queue.** Every other waiting event becomes one `pending` delivery row per endpoint it is
   owed to, due at once, and the event is then marked settled. **No request is made in this
   pass.** `delivered_at` on an event therefore means "its deliveries exist" (or none was
   owed), not "it was received"; the column keeps its name because renaming it would touch an
   index and a grant for nothing. From here on the event is done with, and each delivery goes
   its own way: a failing endpoint holds nothing.
3. **Give up what is too old**: a delivery that has been `pending` for more than three days
   (`WEBHOOK_DELIVERY_MAX_AGE`), whatever kept it waiting, becomes `failed` with the word
   `expired`. One statement a batch.
4. **Send what is due.** For each endpoint that is on: its `pending` deliveries whose
   `next_attempt_at` has come, the most overdue first.

A delivery (`webhook_deliveries`) has a `state` and moves like this:

| From | What happened | To | Attempt counted |
| --- | --- | --- | --- |
| (none) | an event is owed to the endpoint | `pending`, due now | no |
| `pending` | a request was answered 2xx | `delivered` | yes |
| `pending` | a request was answered otherwise, or not at all, and attempts are left | `pending`, due by the schedule | yes |
| `pending` | the same, and it was the eighth request | `failed` | yes |
| `pending` | a request was answered `410` | `failed`, and the endpoint is switched off | yes |
| `pending` | the endpoint had just let another delivery time out | `pending`, due in a minute, word `endpoint_unresponsive` | **no** |
| `pending` | the endpoint's secret would not open | `pending`, due in five minutes, word `signing_failed` | **no** |
| `pending` | it was queued more than three days ago | `failed`, word `expired` | no |
| `pending` | its event's row no longer exists | `failed`, word `event_gone` | no |
| `delivered` or `failed` | an administrator sends it again, answered 2xx | `delivered` | yes |
| `delivered` or `failed` | the same, answered otherwise | unchanged | yes |

`delivered` and `failed` are final for the worker: it reads only `pending` rows. A test event
is a row that never was `pending`.

**Every request is a row of `webhook_delivery_attempts`**: the delivery, the attempt's number,
when, the status code or `null`, the duration, and the outbound guard's fixed word when there
was no answer. The delivery row keeps a count and the latest status and word, so a list does
not have to read the attempts. An attempt and the delivery's new state are written in one
transaction: the update takes the row's lock and counts, and the insert uses the number it
returned, so two writers never record the same number and the count is never off.

*What is an attempt.* A request the worker tried to make, including one the outbound guard
refused or that could not connect: those are the operator's address failing, and they use up
the schedule like any other. **`endpoint_unresponsive` and `signing_failed` are not attempts
and have no attempt row**, as the first step already insisted of its own rows: nothing was
sent. Neither counts against the eight. For `signing_failed` the receiver did nothing wrong (the
server could not open its own secret), and giving its deliveries up after eight rounds would
punish it for the server's key. For `endpoint_unresponsive` the request that did time out is
counted, on its own delivery; counting the ones that were only put off behind it would give
up a whole backlog in eight rounds, forty seconds, because one request was slow. What bounds
both is the age limit, not the count. This closes the two losses the first step had to
document: nothing is settled without being tried any more.

### The schedule

Eight requests: the first, and seven more after waits of **5 seconds, 5 minutes, 30 minutes,
2 hours, 5 hours, 10 hours and 10 hours** (`WEBHOOK_RETRY_DELAYS`; 27 hours 35 minutes in
all). It is the schedule of the Standard Webhooks reference implementation, which receivers
that have used another provider already expect. Each wait is stretched by up to a fifth
(`WEBHOOK_RETRY_JITTER`) and never shortened, so deliveries that failed together do not come
back together; with the most jitter the last request is made 33 hours after the first. They
are constants, not settings: a receiver can be told what to expect, and a setting would be one
more thing whose safe range has to be argued.

The jitter is drawn from `deps.jitter`, a new entry of `Deps`: the system's CSPRNG in
production (nothing depends on it being secret; it is simply the only source the codebase
allows), a fixed `0` in tests. The service clamps what it draws, so a source that misbehaves
can stretch a wait by a fifth and no more.

**`Retry-After` is not honoured.** It is part of the receiver's answer, and nothing of the
answer but its status code is read. A receiver that wants to be left alone for a while answers
`503`; the schedule backs off by itself.

**What counts as success is any 2xx.** A 3xx is a failure and is never followed, as before.

### Switching an endpoint off

Two rules, both applied by the worker as the `system` actor, both recorded with a new activity
type, `webhook_endpoint.disabled`, whose `data` is `{ reason }`:

- **`gone`: the endpoint answered `410`.** A receiver saying "stop" in the one way HTTP has
  for it. The delivery is given up and the endpoint is switched off at once. Included because
  the alternative is a day of retries against an address that has said it will never take
  them; a receiver that answers `410` by mistake finds the endpoint off, with the reason, and
  switches it back on.
- **`failing`: a run of failed requests five days long** (`WEBHOOK_DISABLE_AFTER`). Stated
  exactly: **failed requests for five days, with no success among them and no silence between
  two consecutive failed requests longer than `WEBHOOK_FAILURE_RUN_MAX_GAP_MS`.** That limit
  is the whole retry schedule with the most jitter plus a margin of one hour
  (`WEBHOOK_FAILURE_RUN_MARGIN`): 34 hours 6 minutes with today's schedule, and computed from
  the schedule's constants so that it cannot drift from them.

  The endpoint row has two columns for it. `failing_since` is when the current run began,
  `last_failed_at` when a request to it last failed. When a request fails: if there is no run,
  or the previous failure is longer ago than the limit, a run begins now; otherwise the run
  continues. Then `last_failed_at` becomes now, and if the run is five days old the endpoint
  is switched off. A success clears both.

  *Why the silence matters* (found in review; the first version of this rule compared only
  `failing_since` with the latest failure). One event fails all eight requests over a day;
  the operator fixes the receiver; nothing happens in the environment for five days, so
  nothing tells the server the receiver works; then one event meets a single `500`. By
  `failing_since` alone that is "failing for six days" and the endpoint was switched off
  after nine requests, on a hiccup, and every later event was dropped. An endpoint that was
  sent nothing has not been shown to be still broken. While an endpoint is failing *and being
  sent things*, its failures are never further apart than one delivery's schedule: hence the
  limit. A quiet environment whose endpoint really is broken is switched off only once
  events come often enough to keep a run going for five days, which is the price of not
  switching a working one off; a delivery to it is still retried and given up as usual.

  One bad hour, night or weekend does not trip it; one success starts the count again. **No
  scan**: the rule reads two columns of a row the worker already holds, and is looked at only
  when a request has just failed. It follows that an endpoint that is sent nothing is never
  switched off, which is right: nothing is being wasted on it.

A new type rather than `webhook_endpoint.updated` with a reason: an operator subscribes to
exactly this to be told ("your endpoint was switched off"), and an administrator's own change
should not look like it. The event goes to the environment's **other** endpoints that
subscribed (the one switched off is owed nothing from that instant). Its payload, like every
payload about an endpoint, has no address and no secret. Additive: `EVENT_SCHEMA_VERSION`
stays 1.

The endpoint as the admin API shows it gains two fields, both additive: `disabledReason`
(`failing`, `gone`, or `null` when it is on or an administrator switched it off),
`failingSince` and `lastFailedAt`.

**Switching it on again** is the existing `PATCH` with `enabled: true`. It clears
`failing_since`, `last_failed_at` and `disabled_reason`; so does a change of address (a new address is a fresh
start; a change of event types is not). It is recorded as any update is
(`webhook_endpoint.updated`, `changed: ['enabled']`).

**What happens to its pending deliveries.** While an endpoint is off, by the server or by an
administrator, nothing is sent to it: its `pending` deliveries are not tried and their count
does not move. They are not given up for its being off, either. When it is switched on again
they are due (their time has long come) and go on from the attempt they had reached. The one
thing that does not stop is their age: a delivery queued more than three days ago is given up
(`expired`) whether its endpoint is on or off, so nothing waits for ever. Events from the time
an endpoint is off are, as before, owed to nobody and never sent to it.

`failing_since` and `last_failed_at` are the worker's bookkeeping and are written with no
`Activity` (`setHealth`, a method of its own that takes none; [ADR 0012](0012-events-and-audit-log.md)
lists it). It changes nothing about who can do what; what it leads to, the endpoint being
switched off, is recorded.

### Fairness

- **A deadline per request**: five seconds, unchanged.
- **A cap per endpoint per round**: fifty deliveries (`WEBHOOK_ENDPOINT_ROUND_CAP`), the most
  overdue first. An endpoint with a backlog takes that much of a round; the rest is due in
  the next one, five seconds later, uncounted.
- **A cap on requests in flight**: five (`WEBHOOK_MAX_CONCURRENT_DELIVERIES`). The endpoints
  of an environment are served side by side, and **each endpoint has one request in flight at
  a time**: a receiver is never sent two events at once by the worker. So a hung endpoint
  costs its own lane one deadline and its neighbours nothing.
- **A budget per environment per round**: fifteen seconds, unchanged. Environments are still
  served one after another; with the lanes a slow endpoint now costs the environments after
  it about one deadline rather than the whole budget.
- After an endpoint lets a request run out its deadline, the rest of what it has due in the
  round is put off for a minute without being tried, as described above: one deadline a
  round, as in the first step, but nothing is lost to it.

**Order is not guaranteed, and now visibly so.** A retry of an older event arrives after
newer ones; endpoints are served side by side. A receiver orders by the event's `occurredAt`
and drops repeats by its id. The documentation says so in as many words.

### The admin API

All behind `secretKey()`, like the endpoint routes:

| | |
| --- | --- |
| `GET /:id/deliveries` | An endpoint's deliveries, newest first, paged like the other admin lists (`page`, `size`), filtered by `state` and `eventType`. |
| `GET /:id/deliveries/:deliveryId` | One delivery with its attempts, oldest first. |
| `POST /:id/test` | Send a test event of a chosen type, now. |
| `POST /:id/deliveries/:deliveryId/redeliver` | Send a past delivery again, now. |

A delivery is always addressed under its endpoint, and the store finds it only there: an id
from another endpoint, or another environment, is a `404` like an id nobody has.

**A test event** is the contract's example of the chosen type (`EVENT_FIXTURES`) with a new id,
the time of the call and one more field, **`test: true`**, signed and sent like any delivery.

- *How it is marked.* The envelope gains an optional top-level `test`, which is only ever
  `true` and only ever on a test event; a real event has no such key. It is inside the signed
  body, so it cannot be added to a real delivery or taken off a test on the way, and a
  receiver using `verifyWebhook` reads it as `event.test`. A header would have been outside
  the signature; an id with a prefix would not be a UUID; a type of its own (`test.ping`)
  would not exercise the receiver's handler for the type the operator wants to test. The
  field is additive (`schemaVersion` stays 1) and Standard Webhooks says nothing about the
  payload beyond recommending `type`, `timestamp` and `data`. `verifyWebhook` refuses a `test`
  that is anything but `true`.
- It goes through the outbound guard, is one request with no retry, and is recorded as a
  delivery flagged `test` with no event. **It never touches the outbox** and is not in the
  audit log.
- **It changes nothing about the endpoint, whichever way it ends.** A failed test does not
  start or continue a run of failures, a `410` to a test does not switch the endpoint off,
  and a test that gets through does **not** end a run. It is not the delivery of an event,
  and a receiver may answer tests without doing what it does for a real one; only a real
  event getting through says the endpoint works. An endpoint that is off **can** be tested:
  that is how an operator finds out whether to switch it back on.
- The caller chooses the type and nothing else: not the address, not the payload.

**Sending again** makes one more request for the event's stored payload, with the same
`webhook-id`, and **appends it to the existing delivery's attempts** as the next number. A
second delivery row for the same endpoint and event was the alternative; it would have needed
the unique key to go, and would split one event's history over two rows. A 2xx makes the
delivery `delivered`. A failure leaves its state as it was and is not retried: this is one
request an administrator asked for, not a new run of the schedule.

*What it does to the endpoint's run of failures* is not the same as a test, on purpose. **A
delivery sent again that gets through ends the run** (`failing_since` and `last_failed_at`
are cleared): the receiver took a real event, which is exactly what the run says it has not
been doing. One that fails moves nothing, and neither it nor a `410` switches the endpoint
off: a request made by hand is not the worker's evidence.

*A delivery has at most twenty requests in all* (`WEBHOOK_MAX_TOTAL_ATTEMPTS`: the worker's
eight and twelve by hand). Without a bound, ten a minute for ever would all land in one
delivery's log, and reading that delivery returns its whole log. The check is made before the
request; requests already in flight when the limit is reached are still recorded, and the
rate limit (ten a minute per environment) bounds how many those can be.

It is refused with
`webhook.cannot_redeliver` (409) and a fixed word in `params.reason`:

| `reason` | |
| --- | --- |
| `delivery_pending` | The worker still has it and will send it. |
| `endpoint_disabled` | Nothing is sent to an endpoint that is off (a test is the exception, above). |
| `event_gone` | The event is past its retention period, or the delivery is a test, which never had one. |
| `attempt_limit` | The delivery has had twenty requests. |

One code with a reason, as `webhook.url_not_allowed` has, rather than three codes: every
contract code and its message is in `@tula/core`'s table and so in every browser bundle, and
three more put it eight bytes over its budget.

**The answer of both** is the delivery's id, the outcome, the status code, the duration and,
when there was no answer, one of the server's fixed words. Nothing else of the receiver's
answer is read or kept, as everywhere.

**An answer over the cap** (16 KiB) is judged by its status code. The outbound guard knows
the status before it reads a body, so its `response_too_large` failure now carries the status
(a number, and nothing else of the answer; the socket is destroyed as before and nothing past
the cap is read). A 2xx whose body was too large **is a delivery**: the receiver took the
event. Any other status is an ordinary failed request with that status. Before this, such an
answer was a failure with no status, which with retries meant a healthy receiver with a
chatty answer was sent the same event eight times, had it given up, never had its run of
failures cleared and was in the end switched off.

**The list is a window, not the whole log.** `GET /:id/deliveries` pages through the newest
10,000 matching deliveries (`WEBHOOK_DELIVERY_LIST_WINDOW`: 500 pages of the default size). A
page past it (`page` × `size`) is refused with `validation.failed`, and `meta.totalCount` is
counted over at most that many rows, read through the same index as the page. An endpoint's
log can hold ninety days of deliveries; an offset or a count over millions of rows is not
something an admin call should be able to ask for, and what an operator wants from further
back is found with the filters.

**Their own rate limit.** Ten a minute per environment (`WEBHOOK_SEND_RATE_LIMIT`), one bucket
for both, mounted after `secretKey()` so that it is counted by the environment the key
resolved. Each such call makes the server call an address; the general admin limit (300 a
minute per IP) would let an administrator use them to hammer one. It refuses when the limiter
cannot count.

**Neither is audited.** [ADR 0012](0012-events-and-audit-log.md) records what changes who can
do what, and neither does; the delivery row and its attempt are the record of each. (An
endpoint being switched off, or on, is audited: that changes where events go.)

### Data and privileges (migration `0019`)

- **`webhook_delivery_attempts`** is new and **append-only** for the runtime role: `SELECT`
  and `INSERT`. No `UPDATE`, no `DELETE`: the log of what was tried cannot be rewritten. A row
  goes only with its delivery, by cascade.
- **`webhook_deliveries`** was `SELECT` and `INSERT`. It gains **`UPDATE` on eight columns and
  no others**: `state`, `attempts`, `next_attempt_at`, `last_attempt_at`, `status_code`,
  `failure_reason`, `completed_at`, `updated_at`. Not the endpoint, the event, the type, the
  test flag or `created_at`: a delivery cannot be pointed elsewhere or made to look older. And
  `DELETE`, for the retention job, bounded by a restrictive policy
  (`webhook_deliveries_retention_floor`): never a row that is `pending`, never one younger
  than seven days.
- **`events`**: the runtime role held `UPDATE` on the whole table since `0003`. Every writer
  was checked: the stores insert (`recordActivity`), and the only update anywhere is the
  delivery store setting `delivered_at`. So the grant is **narrowed to that one column**, and
  a payload, a type or a time can no longer be changed by the API's role. It gains `DELETE`,
  bounded by `events_retention_floor`: only an event that is settled (`delivered_at` set) and
  that happened more than a day ago. `occurred_at` is no longer updatable, so the floor cannot
  be got past by backdating.
- **`webhook_endpoints`** gains `failing_since`, `last_failed_at` and `disabled_reason`, all
  `NULL` for the endpoints that exist: no run is on record, and an endpoint's first failed
  request under this version begins one. The runtime role already holds `UPDATE` on the
  table (an administrator changes an endpoint on the request path): no grant changes.
- **`webhook_deliveries.event_id` is no longer a foreign key**, and may be `NULL` (a test
  event). A settled event is deleted after thirty days and the record of its deliveries is
  kept for ninety ([ADR 0017](0017-retention.md)); the cascade that tied the two would have
  deleted the log with the payload. What the foreign key guaranteed, that a row cannot join
  one environment's endpoint to another's event, is kept by how the column is used: it is
  written only by the worker, from an event it read in the same environment, and read back
  only inside that environment, under row-level security. The endpoint reference is still a
  tenant foreign key and still cascades. A delivery keeps the event's id and its type, so the
  log reads the same with the event gone.
- The rows `0018` wrote are carried over: each request becomes attempt 1; a `delivered` row
  stays delivered and a failed request stays given up (its receiver was never told to expect
  a retry). The exception is a row settled **without being tried** (`endpoint_unresponsive`,
  `signing_failed`) in the last three days, which is handed back to the worker: the first
  step promised that retries would pick those up.

### What the retention job now deletes

[ADR 0017](0017-retention.md) has the periods and their reasons: settled events after 30
days, ended deliveries (with their attempts) after 90. An event with a delivery still
`pending` is kept whatever its age, so what the worker will send is always there; and the
worker, should the row be gone all the same, gives the delivery up as `event_gone` rather than
fail.

### Conformance

`49-webhook-retried-after-a-500` (needs a receiver): the backend answers 500, the delivery is
`pending` with one attempt and cannot be sent again by hand, the server retries it with the
same id, the log has both requests, a test event arrives marked and is in the log and not in
the audit log, and a delivered delivery is sent again. The `webhook` step's receiver can now
be told the statuses of its next answers (`answers: [500]`); the wait for the retry is an
ordinary `wait` step, which is a real sleep against a live server and the test clock in
process, so the scenario needs no new mechanism and runs unchanged against `bun run dev`.
CI's `self-host` jobs run the server in containers and skip it for the reason they skip `47`;
their check is now the **exact set of the two names**, both ways, never a count alone.

### What is still lost, and what is no longer

No longer: a failed request (retried), a delivery behind an unresponsive endpoint (put off,
not settled), a secret the server could not open (put off until it can).

Still, and by design:

- **A delivery given up after eight requests or three days.** It stays in the log as `failed`
  and can be sent again by hand for as long as its event is kept.
- **Events from while an endpoint was off**, by an administrator or by the server.
- **A delivery whose endpoint is removed** goes with it.
- **The clock skew window right after a registration**, unchanged from the first step.

### Consequences of this step

- A missed notice is no longer final: a receiver that is down for a night gets what it missed.
  Webhooks can be relied on to the extent the schedule says, and the documentation now says
  what that extent is instead of "do not rely on them".
- **`webhook_deliveries` grows by one row per event and subscribed endpoint, and
  `webhook_delivery_attempts` by one per request**, where the first step wrote one row for
  both. Both end after ninety days.
- **Migration `0019` blocks writes to `events` while it runs**: it builds a partial index on
  the table and takes short exclusive locks for a policy and for lifting and restoring forced
  row-level security around its backfill, all held to the end of its transaction. Apply it in
  a quiet window. `webhook_deliveries` is rewritten in place; it has existed only since
  `0018`.
- **A round's requests are concurrent** (five at once), so the server holds up to five
  outbound connections where it held one.
- A test event and a delivery sent again are made **on the request path**, not by the worker:
  an admin call can take up to the five-second deadline, and such a request can be in flight
  to an endpoint at the same time as the worker's. Bounded by the rate limit.
- **A wrong `TULA_MASTER_KEY` no longer loses events**: deliveries wait, up to three days, and
  are sent once the key is right.
- An endpoint switched off by an administrator **while a round is sending to it** can still be
  sent the rest of that round's cap (at most fifty): the round read the endpoint before it
  began the lane. Nothing is sent from the next round on.
- If recording a request fails (the database), the delivery is still `pending` and due, and is
  sent again next round with nothing counted. A cause that persists would repeat that every
  round, as the first step noted; what bounds it now is the three-day age.

### Alternatives considered for this step

- **Keep delivering inside the walk of the outbox, with a retry count on the event.**
  Rejected: head-of-line blocking, as above.
- **A new delivery row per redelivery.** Rejected: the unique key is what makes the worker
  idempotent, and one event's history would be split.
- **Settings for the schedule and the caps.** Rejected for now: constants can be documented to
  a receiver; a setting is a promise to support every value.
- **Honouring `Retry-After`.** Rejected: it would mean reading a header of the answer.
- **Counting `signing_failed` as an attempt.** Rejected: it gives up a receiver's deliveries
  for the server's fault.
- **Keeping the foreign key to `events` with `ON DELETE SET NULL (event_id)`.** It would keep
  the log but lose the event's id from it, which is the first thing a reader of the log
  wants.
- **Deleting a delivery with its event (one period for both).** Simpler, and it would keep the
  cascade; rejected because the payload and the log have different reasons to be kept and
  different costs.
- **Judging a run by `failing_since` alone.** The first version; it switched off an endpoint
  that had one bad day and, a quiet week later, one hiccup.
- **A shorter limit on the silence** (the longest single wait, twelve hours). It would break
  a run between two requests of one delivery if a round were late; the whole schedule is the
  bound that needs no argument about timing.
- **Disabling after N consecutive given-up deliveries.** It trips on volume rather than time:
  a busy endpoint that is down for an hour gives up nothing, and a quiet one that is down for
  a month gives up two.

## Not built yet

Each is a later step of 2.2 and is named so that its absence is not mistaken for a decision.
Struck out: built since, in the section above.

- ~~**Retries**, backoff and giving up; disabling an endpoint that keeps failing.~~
- ~~**The delivery log's admin routes**, "send a test event" and "redeliver".~~
- **Secret rotation** with an overlap (the verifier already accepts either signature).
- **Endpoints in `tula.config.ts`**, `tula diff` and `tula apply`.
- **The dashboard's webhooks screen.**
- **The worker as its own service**, and more than one environment at a time. (A cap on
  concurrent deliveries exists now, within an environment.)
- ~~**Deleting delivered events** and old delivery rows (the retention job, with its grant).~~
- **A wake-up on write** (`LISTEN`/`NOTIFY`), so that a delivery does not wait for the timer.

## Consequences

Of the first step. Three of them no longer hold and are struck out; what replaced them is
under "Consequences of this step" above.

- An operator's backend can be told what happens in an environment, and can verify that it
  was Tula that said so, with a standard any verifier library speaks.
- The outbox stops growing without bound in the sense that matters first: every event is
  settled. ~~Rows are still never deleted; delivered events and delivery rows accumulate until
  the retention step.~~
- **A deployment upgraded from before this version has its whole outbox to settle, and does
  it in bulk.** No endpoint existed when those events happened, so they are owed to nobody
  and are marked 5,000 a statement, up to 100,000 per environment per round: a million rows
  in ten rounds, under a minute. (By arithmetic; not measured on a real database.) Nothing
  from before an endpoint was registered is ever sent to it, and the first event that is owed
  to a new endpoint does not wait behind the history.
- **Migration `0018` blocks writes to `events` while it runs.** It adds a unique constraint
  and builds an index on that table, and each takes a lock that blocks inserts until it is
  built. Every sign-in, sign-out and admin change inserts an event in its own transaction, so
  on a large outbox those requests wait (and may time out) for as long as the build takes.
  Apply it in a quiet window. It is not built `CONCURRENTLY`: the migrator runs each
  migration in a transaction, where that is not allowed.
- ~~A failed delivery is lost until retries exist. This step is not yet something to rely on
  for anything a missed notice would break; the docs say so.~~
- Rounds are sequential across environments. A deployment with many environments whose
  endpoints are slow sees a delay of up to the budget per such environment; and an idle round
  is one query per environment every five seconds. Both are what "the worker as its own
  service" and a wake-up on write are for.
- `TULA_MASTER_KEY` now also opens webhook secrets: changing it stops every endpoint's
  deliveries (`signing_failed`) until the key is right again or the endpoints are registered
  again. (Since the second step the deliveries wait for up to three days instead of being
  given up.)
- ~~`tula_app` holds `UPDATE` on the whole of `events`, as it has since `0003`, although the
  worker only needs `delivered_at`. Narrowing it to that column is possible and was left
  alone here: it changes a grant older than this step.~~ Narrowed by migration `0019`.

## Alternatives considered

- **Our own header names and signature format.** Rejected: every receiver would need Tula's
  verifier, and there is nothing to gain over a scheme with libraries in a dozen languages.
- **Asymmetric signatures (`v1a`, Ed25519).** The specification prefers them where producer
  and consumer are different parties, since a leaked verification key forges nothing. Left
  for later: it needs a key pair per endpoint or environment and its distribution, and the
  header already carries several signatures, so it can be added beside `v1` without breaking
  a receiver.
- **Hashing the secret.** Not possible: the server has to sign with it.
- **Letting the caller supply the secret.** Rejected: a server-generated secret is always 256
  random bits and is never one that is in use elsewhere.
- **Putting the address in the audit entry.** Rejected for the reason above: it can hold a
  credential, and event payloads leave the deployment.
- **Checking the address only when it is saved.** Rejected: that is the DNS-rebinding hole the
  guard exists to close.
- **Storing the answer's body "for debugging".** Rejected: it turns an endpoint into a way to
  read internal services through the delivery log.
- **A queue (Redis, a broker) instead of polling the outbox.** Rejected by D9: the outbox is
  already transactional with the change, and a second system would have to be made so.
- **`LISTEN`/`NOTIFY` to wake the worker.** A good later improvement to the delay and the idle
  cost; not needed for a first delivery, and the timer stays as the safety net either way.
- **Sending an event to an endpoint registered after it happened.** Rejected: an upgraded
  deployment would post years of backlog to the first endpoint anyone registers.
