# ADR 0034 — Webhooks: endpoints, signing and the first delivery

- Status: accepted
- Date: 2026-10-08

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

This record covers the tracer bullet only: one endpoint, one signed delivery, one attempt.
What it deliberately leaves out is listed under [Not built yet](#not-built-yet); each of those
is a later step of 2.2 and none of them needs what is decided here to be undone.

## Decision

### Data

Two tenant tables (migration `0018`), each with the usual mixins, the composite
environment/project foreign key and the fail-closed row-level-security policy, forced.

**`webhook_endpoints`**: `url`, `event_types` (a text array of names from the contract's
`ACTIVITY_TYPES`, validated by the API; the database does not know the list), `secret`
(sealed, below), `enabled`. The runtime role has `SELECT`, `INSERT`, `UPDATE` and `DELETE`: an
administrator removes an endpoint on the request path.

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
each subscribed endpoint, so the number bounds the requests one event causes. Like the API-key
caps it is checked before the insert and two concurrent registrations at the limit can both
pass.

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
  it; the cap only bounds what a receiver can make the server take in. A larger answer is a
  failed delivery (`response_too_large`) with no status.

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

**One attempt per endpoint and event.** A failure is recorded and not repeated: retries, with
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

**An endpoint that does not answer costs one deadline a round.** Deliveries within an
environment are made one after another, so an endpoint that accepts the connection and never
answers would otherwise take five seconds of the budget for every event and leave the
environment's healthy endpoints about three events a round. After an endpoint lets one
delivery run out its deadline, the rest of what it is owed **in that round** is recorded as
`failed` with `endpoint_unresponsive` and no request is made; the next round tries it again.
Only a timeout does this: an endpoint that answers with an error, or refuses the connection,
fails fast and is tried for every event. Under one attempt per event those deliveries would
have failed anyway; when retries exist they are the first candidates for one.

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
| `webhook.invalid_headers` | A header is missing, empty, sent twice or malformed; the id has a full stop; more than eight signatures. |
| `webhook.timestamp_out_of_tolerance` | The timestamp is more than five minutes old, or more than five minutes ahead. |
| `webhook.invalid_signature` | No `v1` entry is the signature for the secret (compared in constant time, every entry). |
| `webhook.invalid_payload` | Signed correctly, but not an event whose `id` is the `webhook-id`. |

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

## Not built yet

Each is a later step of 2.2 and is named so that its absence is not mistaken for a decision:

- **Retries**, backoff and giving up; disabling an endpoint that keeps failing.
- **The delivery log's admin routes**, "send a test event" and "redeliver".
- **Secret rotation** with an overlap (the verifier already accepts either signature).
- **Endpoints in `tula.config.ts`**, `tula diff` and `tula apply`.
- **The dashboard's webhooks screen.**
- **The worker as its own service**, a cap on concurrent deliveries, more than one environment
  at a time.
- **Deleting delivered events** and old delivery rows (the retention job, with its grant).

## Consequences

- An operator's backend can be told what happens in an environment, and can verify that it
  was Tula that said so, with a standard any verifier library speaks.
- The outbox stops growing without bound in the sense that matters first: every event is
  settled. Rows are still never deleted; delivered events and delivery rows accumulate until
  the retention step.
- **A deployment upgraded from before this version has its whole outbox to settle.** Events
  from before step 2.1 are marked delivered without being sent; events from after it are owed
  to no endpoint (none existed) and are marked too. At 1,000 events per environment per round
  and a round every five seconds, a million rows take about an hour and a half. Nothing from
  before an endpoint was registered is ever sent to it.
- A failed delivery is lost until retries exist. This step is not yet something to rely on
  for anything a missed notice would break; the docs say so.
- Rounds are sequential across environments. A deployment with many environments whose
  endpoints are slow sees a delay of up to the budget per such environment; and an idle round
  is one query per environment every five seconds. Both are what "the worker as its own
  service" and a wake-up on write are for.
- `TULA_MASTER_KEY` now also opens webhook secrets: changing it makes every endpoint's
  deliveries fail with `signing_failed` until the endpoints are registered again.
- `tula_app` holds `UPDATE` on the whole of `events`, as it has since `0003`, although the
  worker only needs `delivered_at`. Narrowing it to that column is possible and was left
  alone here: it changes a grant older than this step.

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
