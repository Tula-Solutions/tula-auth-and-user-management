# ADR 0034 — Webhooks: endpoints, signing and the first delivery

- Status: accepted
- Date: 2026-10-08
- Amended: 2026-10-08, by the second step of 2.2 (TULA-42): [Retries, disabling and the delivery log](#retries-disabling-and-the-delivery-log-added-2026-10-08-tula-42).
  That section changes four decisions of this record (one attempt per delivery, when an event
  is settled, the insert-only delivery table, the cascade from an event to its deliveries);
  the paragraphs it supersedes are marked.
- Amended: 2026-10-08, by the third step of 2.2 (TULA-43): [Secret rotation](#secret-rotation-added-2026-10-08-tula-43).
  It adds to this record and supersedes one sentence of it (a delivery's header now carries
  two signatures during a rotation).

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
this step sends one entry, and the verifier already accepts any one of several. *(Since
[Secret rotation](#secret-rotation-added-2026-10-08-tula-43) a delivery carries two entries
while a rotation's overlap lasts.)*

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
  limit. **The price, measured in review:** a dead endpoint that is owed an event less often
  than about every two and a half days (one event's retry span, 27 h 35 min, plus the limit,
  34 h 6 min: 61 h 41 min) never has a run five days long and is **never switched off**. Each
  delivery to it is still retried and given up as usual, and stays in the log as `failed`.
  That is accepted: the rule exists to stop the server wasting requests on an endpoint and to
  tell its operator, and an endpoint that costs eight requests every few days is neither
  expensive nor, by this evidence alone, certainly dead. The guide says so and names the ways
  out (answer `410`, or switch it off or remove it). A test holds both sides: events every two
  days switch a dead endpoint off, every four days do not.

  *The write is a compare-and-set* (found in the second round of review). The lane computes
  the run from the endpoint row it read when it began. Meanwhile an administrator may have
  switched the endpoint on again or changed its address, or a delivery sent again may have
  got through; each ends the run. Written blindly, the lane's next failure brought the old
  run back, and could switch off an endpoint seconds after it was reset. `setHealth` now
  writes only if the row still holds what was read (both columns, compared in the `UPDATE`
  itself); on a miss the worker reads the row again and applies the rule to what is there,
  so a reset run is followed by a new one that begins at this failure. A success clears the
  run whatever it finds.

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

### What a lost answer costs

The new secret is in one HTTP answer and nowhere else. If that answer is lost, the server
holds a current secret nobody has, another rotation is refused for 24 hours, and at the end of
them that secret would be the only one signing. The way out is the two calls an emergency
uses, in this order: end the overlap (the receiver's secret stops; its deliveries now fail
verification and are retried), rotate again (the lost secret becomes the previous one, and
signs for nobody), deploy. **Deliveries are delayed by as long as that deployment takes, not
lost**, as long as it is inside the retry schedule. The guide has the steps. This is the price
of refusing a rotation during an overlap, and it is stated rather than designed away; the
alternative that would remove it is the first one below.

### Alternatives considered for this step

- **A rotation during an overlap replaces the *newer* secret and keeps the older one to its
  original end** ("roll again"). Still never three, it never drops the secret receivers are
  known to hold, and it would make both the leaked-new-secret case and the lost-answer case
  one call with no delay. Not chosen: a receiver that has already moved to the new secret
  alone is cut off by it without warning, the same call would then mean two different things
  depending on a clock, and the ticket's owner leaned towards refusing. It is the change to
  make if the lost answer turns out to happen in practice.

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

## Secret rotation (added 2026-10-08, TULA-43)

The third step of 2.2. An operator replaces an endpoint's signing secret **without dropping a
delivery**: the new secret signs beside the one it replaces for a fixed overlap, so the
receiver can be given the new one after the rotation and before the old one stops.

### What a rotation is

`POST /v1/admin/webhook-endpoints/:id/secret/rotate`, behind `secretKey()` like every admin
route. It takes no body and reads none: the server makes the secret, exactly as at
registration (32 bytes from the CSPRNG, `whsec_` + base64), and returns it **once**, in this
answer (`Cache-Control: no-store`), with `rotationOverlapEndsAt`: when the previous secret
stops signing. The previous secret is not returned (the receiver has it).

From the instant the rotation commits until `rotationOverlapEndsAt`, every delivery's
`webhook-signature` has **two entries, separated by a space: the current secret's first, then
the previous secret's.** A receiver on the old secret, on the new one, or on both verifies.
After that instant there is one entry, the current secret's.

*The order of work is rotate first, then deploy.* The server makes the secret, so there is
nothing to give a receiver until the rotation has answered; the overlap is what makes that
order safe. (A design where the operator supplies the next secret ahead of time would allow
"deploy both, then rotate", and was not chosen for the reason the first step gave: a
server-made secret is always 256 random bits and never one in use elsewhere.)

### The overlap: 24 hours, a constant

`WEBHOOK_SECRET_OVERLAP`. Long enough to get a secret into a receiver through an ordinary
deployment (a review, a release window, a colleague in another time zone); short enough that
a secret which is being replaced because it may have leaked stops being worth anything soon.
It is a constant and not a setting for the reason the retry schedule is: a receiver's operator
can be told what to expect, and a setting is a promise to support every value. An operator
for whom a day is too long ends the overlap by hand (below); one for whom it is too short has
no remedy in this step, which is accepted: a rotation is something the operator starts, at a
time of their choosing.

### Never more than two secrets

While a previous secret still signs, **another rotation is refused**: `webhook.rotation_refused`
(409), `params.reason: rotation_in_progress`. The two alternatives were considered and
rejected:

- *Keep three* (or more): a mistake, or a script in a loop, piles secrets up; the header
  grows towards the verifier's bound of eight entries; and "which secrets are valid" stops
  being something an operator can hold in their head.
- *Drop the oldest silently* and let the newest take the previous one's place: a receiver that
  still holds only the oldest secret is cut off at that instant, with no warning, by a call
  whose name says "without dropping a delivery".

Refusing makes the operator say what they mean. The case that needs a second rotation at once
(the **new** secret leaked) is served by ending the overlap first, an explicit and recorded
act, and then rotating: two calls instead of one, and nothing silent.

The rule is enforced twice: the service refuses before it opens anything, and
`WebhookEndpointStore.rotateSecret` is a compare-and-set in one statement (the row's current
ciphertext is still the one read, **and** no previous secret is still signing at the
rotation's instant). Of two rotations that arrive together, on one instance or two, one
writes and the other is refused; the previous slot can only ever receive the secret that was
signing. Two entries are 95 characters: far inside `verifyWebhook`'s bounds (8 entries, 1,024
characters).

### Ending the overlap early

`DELETE /v1/admin/webhook-endpoints/:id/secret/previous`: the previous secret stops signing
and its ciphertext is deleted, in one statement. It answers the endpoint
(`rotationOverlapEndsAt: null`). With no previous secret signing (never rotated, the overlap
already over, already ended) it is refused: `webhook.rotation_refused`,
`no_rotation_in_progress`. Refused rather than answered as a success: the caller is told that
nothing was revoked, and nothing is recorded for a call that changed nothing.

It exists for a leaked **previous** secret, which is the usual emergency ("the secret is in a
log somewhere: rotate"), and to make another rotation possible at once.

*What it does and does not buy.* The server signing with a leaked secret gives an attacker
nothing they did not have; what protects a receiver is the receiver no longer accepting it.
Ending the overlap takes the secret out of the database and tells the operator, in the audit
log, that from here on only one secret is good. The guide says to deploy the receiver without
the old secret first.

### Storage and binding (migration `0020`)

Two nullable columns on `webhook_endpoints`: `previous_secret` (sealed) and
`previous_secret_expires_at`, set and cleared together (a `CHECK`,
`webhook_endpoints_previous_secret_whole`): a previous secret with no end would sign for
ever, and an end with no secret would say a rotation is under way that nothing can sign for.
Both are `NULL` for every existing endpoint. The runtime role already holds `UPDATE` on the
table: **no grant changes.**

**The previous secret has its own binding.** The current secret is sealed, as it always was,
bound to `<environment>:<endpoint>`; nothing about it changes, so **every secret stored
before this step opens exactly as before** (a test seals one the old way and delivers and
rotates with it). The previous secret is sealed bound to `<environment>:<endpoint>:previous`.
A rotation therefore opens the current secret and seals it again for the previous slot. With
the slot in the binding, a ciphertext cannot be moved:

| Moved | Result |
| --- | --- |
| the current secret's ciphertext into `previous_secret` | does not open; deliveries are signed with the current secret alone |
| the previous secret's ciphertext into `secret` | does not open; `signing_failed`, nothing is sent |
| either, from another endpoint or another environment | does not open |

The first row matters most: without it, whoever can write the row could make a secret outlive
its own rotation by copying it into the previous slot with a far end date.

*Accepted residual.* Successive current secrets of one endpoint share a binding, so an **old
ciphertext of the same slot** put back into the same row opens. That takes write access to
the row and a copy of the old ciphertext (a backup): someone with both can do worse. A
generation number in the binding would close it at the price of a counter column and of
making existing rows a special case; not done.

**A secret the server cannot open cannot be rotated** (`secret_unreadable`, 409). The
replaced secret has to be opened to be sealed for its new slot; if it cannot, it could not be
kept signing, and "rotation" would cut off every receiver at once. That is a
`TULA_MASTER_KEY` to put right first. Rotating as a way *out* of a lost key was considered
(it would spare removing and re-registering the endpoint) and rejected: on a deployment where
one instance has the wrong key, a rotation that happened to reach that instance would seal
the new secret under a key the other instances do not have.

### When the previous secret stops, and when it is removed

Two different instants, on purpose.

- **It stops signing at `previous_secret_expires_at`, decided at each request.** The one
  function that builds the header (`signatures`) compares the instant the request is made,
  which is also where its `webhook-timestamp` comes from, with the stored end: strictly
  before, both sign; at it or after, the current secret alone. No job has to have run. A
  lane that opened its keys before the end and sends after it signs with one secret.
- **Its ciphertext is deleted by the worker's next round**: a new first pass of
  `deliverEnvironment`, one statement per environment
  (`clearExpiredPreviousSecrets(environment, now, limit)`), which runs whether the endpoint
  is on or off and whether or not anything is due. So an expired secret is in the database
  for one round's interval, five seconds, and not "until someone looks". The worker and not
  the retention job, because the worker already visits every environment's endpoints every
  few seconds and retention runs far less often. The delete is the worker's housekeeping and
  takes no `Activity` ([ADR 0012](0012-events-and-audit-log.md)): what changed who can sign
  was the rotation, which is recorded with the end it set.

A read (`GET`, the list) shows `rotationOverlapEndsAt` only while the overlap is under way by
the clock; a row whose previous secret has expired and not yet been cleared reads as having
one secret, and may be rotated again at once.

### One signing path

The worker, a test event and a delivery sent again all make their request through `request`,
which calls `signatures`. There is no second place that writes the header.

### What is guaranteed around a rotation

- **Before it commits**: one signature, the old secret's.
- **After it commits**: two signatures, new then old, on every delivery whose endpoint row was
  read after the commit. A round of the worker that was already serving the endpoint holds
  the row it read before and signs with the **old secret alone** until it ends (at most the
  round's cap: fifty deliveries, fifteen seconds).
- **So a delivery carries the old secret's signature alone, or both; never the new secret's
  alone** until the overlap ends or is ended. A receiver that has not been given the new
  secret yet always verifies. (A test holds the rotation committing from inside the
  receiver's handler, mid-lane.)
- **At the end of the overlap**: the old secret's signature is on no request made at or after
  that instant by this instance's clock. Instances are expected to keep their clocks together
  (as for everything else here): the end is written by the instance that took the rotation
  and judged by the one that holds the worker's lock.
- **A retry is signed when it is sent.** A delivery first tried during the overlap and retried
  after it has the new secret's signature only. The receiver must hold the new secret by the
  end of the overlap; that is what the overlap is for, and the guide says so.
- **When the overlap is ended early**: no request whose endpoint row is read after that
  commit carries the old signature. A round already serving the endpoint may still add it
  for the rest of that round. Accepted, for the reason above: it gives nothing away.

### A previous secret that cannot be opened

If the **current** secret opens and the **previous** one does not, the delivery is made,
signed with the current secret alone, and the server logs one line per endpoint per round
that sends something (ids only). The alternative, sending nothing (`signing_failed`), would
punish every receiver that has already moved to the new secret for a fault in a secret that
is on its way out. A receiver still on the old secret refuses these deliveries, which are
retried on the schedule; the operator's remedy is the key, or deploying the new secret.
This is the one case in which a delivery carries the new secret's signature alone before
the overlap has ended, and those refusals count as failed requests like any other, so they
feed the rule that switches a failing endpoint off. It takes a stored secret that no longer
opens (a damaged row, or a different `TULA_MASTER_KEY`), which is why it is accepted.

If the current secret does not open, nothing changes: `signing_failed`, nothing sent, no
attempt counted. **The previous secret never signs alone.**

### An endpoint that is switched off

Can be rotated, and its overlap ended. A suspected leak is a reason to switch an endpoint
off, and the secret is replaced before it is switched on again; pending deliveries are signed
when they are sent.

### Audit and events

Two new activity types, both the administrator's act, both with the endpoint as target:

| Type | `data` |
| --- | --- |
| `webhook_endpoint.secret_rotated` | `rotationOverlapEndsAt` |
| `webhook_endpoint.previous_secret_revoked` | nothing |

Two types rather than one with an `action` field, for the reason `webhook_endpoint.disabled`
is its own type: an operator subscribes to exactly the thing they want to be told. And
`secret_rotated` is worth subscribing to: a rotation hands a new signing secret to whoever
made the call, so **a rotation the operator did not make means a stolen secret key and a
forged-event path into the receiver**.

**Nothing of a secret is in either**, not a prefix and not a fingerprint. A fingerprint would
let an operator match a secret in hand against the log, which is convenient, and would also
be a value derived from the secret travelling to every other subscribed endpoint and sitting
in the audit log for as long as it is kept; the time is enough to tell two rotations apart.

*The field is named for the overlap, not for the secret* (`rotationOverlapEndsAt`, where the
column is `previous_secret_expires_at`). Anything that scrubs or flags by key name
(`secret`, `token`, `key`) would take a time under such a key for a credential; this
codebase's own canary test of the event payloads did, the first time it ran. No value that is
not a secret sits under a key that reads like one.

Additive: `EVENT_SCHEMA_VERSION` stays 1.

### The admin API, and its limit

| | |
| --- | --- |
| `POST /:id/secret/rotate` | Replace the secret. `200` with the endpoint, the new secret and `rotationOverlapEndsAt`. |
| `DELETE /:id/secret/previous` | End the overlap. `200` with the endpoint. |

One error code for both refusals, `webhook.rotation_refused`, with a fixed word in
`params.reason` (`WEBHOOK_ROTATION_REFUSALS`), as `webhook.cannot_redeliver` has: every
contract code is in `@tula/core`'s table, and this one leaves that bundle 42 bytes under its
budget.

An endpoint of another environment is `404` for both, with the body an unknown id gets.

*No rate limit of their own.* Like the other writes to an endpoint (`POST`, `PATCH`,
`DELETE`), they are behind the general admin limit and nothing else. The bucket that test
events and redelivery have exists because those calls make the server call an address;
these do not. What bounds them is the rule itself: one rotation per endpoint per overlap,
and each rotate-then-revoke cycle is two audited calls by someone who holds a secret key.

### The receiving side

`verifyWebhook(body, headers, secret, options?)` now takes **one secret or a list of at most
two** (`WEBHOOK_MAX_SECRETS`). It computes the signature each secret would have made, all of
them, and compares every entry of the header with every one, gathering the results without a
branch: neither which entry nor which secret was right can be read from how long it took.
The error codes are the ones it had, and an error names no secret and no position in the
list.

- *Two, not "a few".* The server never signs with more than two. A third secret in a
  receiver's list is one that should have been taken out, and a secret left in a list stays
  good for whoever holds it; refusing it makes that visible.
- *Every entry must be a signing secret.* An empty list, or a list with one malformed entry
  beside a good one, is `webhook.invalid_secret` on every delivery. A verifier that quietly
  used the entries it liked would hide a new secret pasted wrong until the day the old one
  stops signing.

### Conformance

`50-webhook-secret-rotated-with-an-overlap` (needs a receiver): one signature before; rotate;
a read shows the overlap and no secret; a second rotation is refused; a delivery and a test
event during the overlap verify with either secret and carry two signatures; the audit log
has the rotation and no secret; the overlap is ended; the next delivery has one signature,
which verifies with the new secret and not the old; a new rotation is then possible, and the
first secret never signs again. The `webhook` step's `expect` gains `alsoSecrets`,
`notSecrets` and `signatures`.

**What it does not stage is the overlap ending by itself**: 24 hours, which a `wait` step
would really sleep against a live server. That instant (one millisecond before and at it) and
the worker's deletion of the ciphertext are API tests on a controlled clock, and the
scenario's description says so. CI's `self-host` jobs skip this scenario for the reason they
skip `47` and `49`; their check is now the exact set of three names.

### Consequences of this step

- A secret can be replaced on a schedule or after a leak with no gap in deliveries.
- **During a rotation a delivery's `webhook-signature` has two entries.** A receiver that
  uses `verifyWebhook` or a Standard Webhooks library reads that; one that hand-rolled a
  comparison of the whole header value with a single signature breaks on the first delivery
  after a rotation. The guide has said "accept the delivery if any one is right" since the
  first step.
- Each round of the worker makes one more statement per environment, an `UPDATE` that
  usually matches nothing.
- An endpoint's row holds two secrets for up to 24 hours (and about five seconds).
- A deployment with a wrong `TULA_MASTER_KEY` cannot rotate.

### Alternatives considered for this step

- **A separate table of secrets per endpoint** (id, sealed secret, `not_after`). The general
  form, and what an asymmetric scheme would want. Rejected for now: it invites "more than
  two", every delivery would read a second table, and two columns say everything this step
  needs.
- **Letting the caller choose the overlap**, or pass zero for "now". One more thing whose safe
  range has to be argued; "now" is the second call.
- **Removing the expired secret in the retention job.** It would leave the ciphertext in the
  database for hours.
- **Removing it lazily, on the next write to the row.** An endpoint that is never touched
  again would keep it for good.
- **Stopping the old secret only when the cleanup has run** (no clock check at signing). Then
  "when does the old secret stop" depends on the worker's health, and an instance that cannot
  take the job lock extends a leaked secret's life.
- **Answering the early end with a success when there is nothing to end.** Either it records
  a revocation that revoked nothing, or it records nothing and answers two different outcomes
  alike.

## Not built yet

Each is a later step of 2.2 and is named so that its absence is not mistaken for a decision.
Struck out: built since, in the section above.

- ~~**Retries**, backoff and giving up; disabling an endpoint that keeps failing.~~
- ~~**The delivery log's admin routes**, "send a test event" and "redeliver".~~
- ~~**Secret rotation** with an overlap (the verifier already accepts either signature).~~
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
