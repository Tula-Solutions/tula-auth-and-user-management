# Phase 2: what was not verified against the real thing

Kept from the first step of [Phase 2](phase-2.md), not collected at its end (the plan's rule
4). An item is here when the code was tested against a stand-in (a listener on loopback, a
resolver a test controls, an in-process fixture) or by a static check, and never against what
it stands for. Each step adds its own section; an item is struck out, with what was run, when
it is verified later.

## Step 2.2, first delivery: webhooks (TULA-26, [ADR 0034](../adr/0034-webhooks.md))

### External services

| What | What it was tested against instead |
| --- | --- |
| **A receiver on the public internet over `https`**: a certificate a public authority issued, real DNS, a real network path, and a receiver behind a CDN or a serverless platform | A `Bun.serve` listener on `127.0.0.1` over plain `http`, which the outbound guard allows in the `local` tier only. The guard's own TLS path (certificate checked against the host name, a certificate for another name refused) is tested in `lib/outbound.test.ts` against a listener with a throwaway certificate; no delivery of this step went over TLS. |
| **A Standard Webhooks verifier in a language other than JavaScript** (the reference Python, Go, Rust, Ruby, Java, PHP, C#, Elixir libraries) | The reference libraries' shared example (secret, id, timestamp, body, expected signature) is a test of `@tula/contract`, and `signWebhook` produces its signature. Once, by hand and outside the repository, a delivery signed by `signWebhook` was accepted by the published JavaScript package `standardwebhooks` 1.1.1 and its signature by `verifyWebhook`. No other language's library was run. |
| The specification itself, beyond what was read | `spec/standard-webhooks.md` and the JavaScript library's `index.ts` in `standard-webhooks/standard-webhooks`, as fetched on 2026-10-08. Nothing was checked against a conformance suite of that project; none is known to exist. |
| A slow or hostile receiver at scale: thousands of endpoints, slow-loris answers, an answer that streams for the whole deadline | Unit tests of each case one at a time (an answer over the cap, a redirect, a closed port, a status other than 2xx), and the guard's own deadline tests. |

### The server as it is deployed

| What | What was run instead |
| --- | --- |
| **The two new stores against a real PostgreSQL** | PGlite (real Postgres compiled to WASM, every migration applied, connected as the runtime role with row-level security on), where the shared suite and the privilege tests pass. The stores were added to `stores.integration.ts`, which was **not run**: this checkout has no database settings. |
| **Migration `0018` on a database with a large `events` table** | Applied to an empty PGlite database by the tests. It adds a unique constraint and a partial index to `events`, both of which take a lock on the table while they build; how long on millions of rows was not measured. |
| **Two real API instances and the worker's advisory lock** | The job-lock suite against the memory lock and a stand-in for the database's advisory locks; a test of two `Deps` sharing one lock. The lock itself against two real Postgres sessions is `job-lock.integration.ts` (written for retention, extended with the new job's suite test, **not run** here). |
| **The `server.ts` timer, and stopping the round under way at shutdown** | Nothing runs `server.ts` in a test. The round (`Webhooks.run`) is tested, including being told to stop through its signal; the lines of `server.ts` that start it on a timer, keep one round at a time and abort and await it on shutdown were read, not executed. |
| **Scenario `47-webhook-delivered-and-signed` against a live server** | In process, through the real outbound guard and a real socket on loopback (part of `bun run verify`). The live runner's waiting loop is tested against a fake server that delivers by itself after a delay. No live server ran it: CI's `self-host` jobs run the server in containers, which the runner's listener cannot be reached from without loosening the guard, so they skip it. It can run against `bun run dev` with `CONFORMANCE_WEBHOOK_RECEIVER_HOST=127.0.0.1`; that run was not made. |
| **The change to CI's `self-host` job** (it now expects exactly one skipped scenario, and that scenario `48` passed) | Read, not run: the workflow only runs on GitHub. |
| **Scenario `48-webhook-refused-address` against a live server** | In process only, for the same reason: no live server was started in this checkout. It needs no receiver and is expected to run in CI's `self-host` jobs. |
| **That an address which passed when saved is refused when delivered, over HTTP** | Not a scenario: a scenario cannot change what a name resolves to. Covered by `modules/webhook/service.test.ts` ("the outbound guard at delivery time") with a resolver the test controls, through the real guard. A real name server changing its answer between the save and a delivery was not staged. |
| **Settling the outbox of a deployment that has recorded events for a long time** | A test with 12,000 old events and one new endpoint, through the memory store (the first delivery arrives in the first round), and the store's `settleBefore` on PGlite. The time for a million rows in ADR 0034 is arithmetic (5,000 a statement, twenty statements per environment per round), not a measurement: how long one 5,000-row update of `events` takes on a real server, and what it does to concurrent inserts, was not measured. |
| **What a receiver loses when it is slow once** | By design, not by test against a real receiver: after one timeout in a round the rest of what that endpoint is owed in the round is settled as `endpoint_unresponsive` without being tried, and nothing re-sends it until retries exist. Tested with a stand-in that times out; how often a real receiver under load crosses five seconds, and so how many events this costs in practice, is unknown. |
| **A wrong `TULA_MASTER_KEY` on one of several instances** | A test that stores a secret that does not open: the deliveries are settled as `signing_failed` and the log has one line per endpoint per round with a count. Two real instances with different keys, taking turns at the job lock, were not run; in that arrangement the endpoint would lose the events of every round the wrong instance wins. |
| **The cap of ten endpoints under concurrent registrations, across instances** | Twelve concurrent registrations against the memory environment lock (ten succeed). The Postgres advisory lock behind `deps.environmentLock` is proved for its other scope by `environment-lock.integration.ts` (not run here); no test drives concurrent registrations against a real server. The `races.integration.ts` harness makes two store calls meet on a row lock and does not fit a service-level advisory lock. |

## Step 2.2, retries and the delivery log (TULA-42, [ADR 0034](../adr/0034-webhooks.md))

Three items of the first delivery's list are **closed by design**, not by a run against the
real thing: "what a receiver loses when it is slow once" (nothing now: the rest of the round
is put off, not settled) and "a wrong `TULA_MASTER_KEY` on one of several instances" (the
deliveries wait instead of being given up; two real instances with different keys were still
not run). They stay above as they were written.

### External services

| What | What it was tested against instead |
| --- | --- |
| **A real receiver that fails and recovers**: a backend behind a load balancer answering `502` during a deploy, a serverless function timing out cold, a receiver that rate-limits with `429` and `Retry-After` | A `Bun.serve` listener on loopback told which status to answer, and `Outbound.request` replaced by a stand-in that throws the guard's `timeout`. Every wait of the schedule was walked on the test's clock; no retry of this step waited in real time or crossed a network. |
| **The schedule against what receivers expect** | The waits are the ones the Standard Webhooks reference implementation documents (5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h), copied from its documentation as remembered and **not re-read for this step**; nothing was fetched. Whether a given receiver library assumes anything about retry timing was not checked. |
| **`410 Gone` from real infrastructure** (a CDN or a gateway answering `410` for a route that was removed, on the receiver's behalf) | A listener that answers `410`. That an intermediary can say it for a backend that did not mean it is a known way for the rule to misfire; it was reasoned about, not observed. |
| **A receiver's handling of `test: true`** in a Standard Webhooks library of another language | `verifyWebhook` (`@tula/admin`) only. The field is an extra top-level key of the payload, which that specification does not forbid; no other library was given a test event. |

### The server as it is deployed

| What | What was run instead |
| --- | --- |
| **The stores against a real PostgreSQL** | PGlite, where the shared suite (both stores), the privilege tests, the two restrictive delete policies and the column-level `UPDATE` grants pass. `stores.integration.ts` was given the new context and **not run**: this checkout has no database settings. In particular the "requests recorded at the same time each get their own number" test ran on PGlite's single session, where concurrent calls take turns; on a real server it is the row lock of the `UPDATE` that orders them, which was not exercised. |
| **Migration `0019` on a real database** | Applied to an empty PGlite database by every test, and to one holding six rows of the `0018` shape by `packages/db/src/migration-0019.test.ts`. **PGlite's role is a superuser**, which row-level security never binds, so the test does not show that the backfill reaches the rows when the migrating role is an ordinary owner under `FORCE ROW LEVEL SECURITY`; the migration lifts the force for the backfill for that case, and that it restores it is tested. How long the migration holds its locks on a large `events` table was not measured. |
| **A cascade from a removed endpoint past the restrictive delete policy** | A test on PGlite as the runtime role: removing an endpoint removes its pending and recent deliveries, which the policy would refuse a direct delete of. On a real server this rests on referential actions running as the table's owner without the forced policy; the same PGlite caveat as above does not apply here (the test's session is the runtime role), but no real server ran it. |
| **Two real API instances taking turns at retries** | Two `Deps` sharing the stores and the memory job lock, including two with different clocks. Not two processes and not the Postgres advisory lock. |
| **Clock skew between instances on a real deployment** | Two `Deps` with clocks thirty seconds apart. |
| **A crash between a request and its record** | A stand-in store whose `recordAttempt` throws once. The process was not killed. |
| **Five concurrent outbound requests through the real guard under load** | Ten loopback endpoints and forty deliveries in one round, counting requests in flight (never more than five, never two to one endpoint). No measurement of sockets, memory or time on a real deployment. |
| **The per-environment rate limit of test events and redelivery on Redis** | The memory limiter. The Redis limiter is the same port and is proved elsewhere; this bucket was not run against it. |
| **A test event or a redelivery on the request path behind a real proxy with its own timeout** | In process. Such a call can take up to five seconds; whether a deployment's proxy cuts it off sooner was not looked at. |
| **The retention job's two new purges on a large table** | The memory store and PGlite with a backlog a little over one batch. The purge of events uses a `NOT EXISTS` over `webhook_deliveries` per candidate; its plan and cost on millions of rows were not measured. |
| **Scenario `49-webhook-retried-after-a-500` against a live server** | In process, with the test clock for the wait and one round of the real worker per `webhook` step (part of `bun run verify`). It is written to run unchanged against `bun run dev` with `CONFORMANCE_WEBHOOK_RECEIVER_HOST=127.0.0.1` (its waits are real sleeps there, nine seconds in all); that run was **not made**. Against a live server the steps that read the log right after a delivery rely on a one-second wait for the server to have recorded the answer, which was chosen, not measured. |
| **The change to CI's `self-host` jobs** (the exact set of two skipped scenario names; `2 skipped` in the summary line) | The shell lines were extracted from `ci.yml` and run against six sample logs (both names, one name, another name in place of one, a third, none). The workflow itself only runs on GitHub and was not run. |

### After the review

| What | What was run instead |
| --- | --- |
| **The run-of-failures rule over real days** | The test clock: the review's case (eight failed requests, five quiet days, one failure), steady daily failures to the millisecond, and a silence exactly at and one millisecond over the limit. |
| **An answer over the cap from a real receiver** (a framework's default error page, a proxy's HTML) | A loopback listener answering a body over 16 KiB with a chosen status, declared and streamed, and a `node:http` server that streams without end, which sees its connection closed. Chunked answers from a real proxy were not tried. |
| **The capped count on a large table** | PGlite with five rows and a ceiling of three. That the planner reads the capped subquery through `webhook_deliveries_endpoint_log_idx` on millions of rows, and what a rare `state` or `eventType` filter costs inside one endpoint's log, was not measured. |
| **The cap on a delivery's attempts under concurrent calls** | One call after another. Calls already in flight when the limit is reached are still recorded; the per-environment rate limit bounds them, which was reasoned, not run. |

| **The compare-and-set of an endpoint's run against a concurrent administrator** | In the store suite (memory and PGlite) as a stale write after a reset, one call after the other, and in the service with the reset made from inside the receiver's handler while the request is in flight. Two real sessions meeting on the row were not run by this step; the comparison is in the `UPDATE`'s own `WHERE`, so the row lock orders them. |
| **Dates in the tests of other modules** | Bun's `toMatchObject` does not compare dates. The webhook tests and the shared webhook store suite now compare them (`comparable()`), and nothing that had passed turned out wrong but one boundary. **No other test file was checked.** |

### Not test-first

(Of the first pass of this step. The fixes after the review were each written test first and
seen to fail, with the exceptions named in the report: tests that confirm behaviour the
review asked to keep.)

The tests of the stores, the service, the router and the retention job were written **with**
the implementation, in the same sitting, and mostly passed on their first run; they were not
each seen to fail first. What was seen to fail first: the existing webhook tests (they stopped
compiling and then failed until the model was in place), the database's privilege tests, the
`@tula/core` bundle budget (three new error codes put it eight bytes over, which is why there
is one code with a reason), and the handful of assertions that were wrong on their first run.

### Other runtimes

| What | What was run instead |
| --- | --- |
| `verifyWebhook` on Node, Deno and edge runtimes | Bun, plus `typecheck:portable` (web platform types only: no `Buffer`, no `node:` import). It uses `crypto.subtle`, `TextDecoder`, `atob` and `btoa`. |
| `verifyWebhook` behind a real framework's body handling (Express, Fastify, Next.js route handlers) | Called with the text and with the bytes a `Request` gave. The warning about parsed bodies in [webhooks.md](../webhooks.md) is from how those frameworks are documented to behave, not from running them. |
| `@tula/contract/webhook-signature` in React Native | Not applicable in practice (a signing secret has no place on a device), but the entry point is exported to every consumer of the contract: it references `crypto.subtle`, `atob` and `btoa` only inside its functions, so importing it does not fail where they are missing. Not run there. |

## Step 2.2, secret rotation (TULA-43, [ADR 0034](../adr/0034-webhooks.md#secret-rotation-added-2026-10-08-tula-43))

### External services

| What | What it was tested against instead |
| --- | --- |
| **Two signatures in one header, read by a Standard Webhooks library** (any language, the JavaScript reference included) | `verifyWebhook` (`@tula/admin`) and the conformance runner's own check, both built on the contract's `signWebhook`. That the reference libraries split the header on spaces and accept any one right entry is from their source as read for the first step (2026-10-08); **no library was handed a two-signature delivery made by this server**, and the specification was not re-read for this step. |
| **A receiver that compares the whole header with one signature** (hand-rolled) | Nothing: it breaks on the first delivery after a rotation, by design of the scheme. The guide has said "accept the delivery if any one is right" since the first step; no real receiver was surveyed. |
| **A real rollout**: rotate, deploy a receiver with both secrets through a pipeline, wait a day, deploy again without the old one | The same sequence in one process on a clock the test moves (`rotation.test.ts`, `webhook-real-api.test.ts`), and over HTTP in scenario `50` with the overlap ended early instead of waited out. **Nobody waited 24 hours.** |

### The server as it is deployed

| What | What was run instead |
| --- | --- |
| **Migration `0020` on a real PostgreSQL with existing endpoints** | Applied on PGlite by every test that builds a database; a test inserts an endpoint with no previous secret and checks the pair constraint both ways, on insert and on update, as the runtime role. Not run against a real server, and not against a database that holds endpoints from before it (the columns are nullable and the check is trivially true of them). |
| **The three new store methods against a real PostgreSQL** | PGlite, where the shared suite passes for both adapters. `stores.integration.ts` runs the same suite and so has the new tests, and was **not run**: this checkout has no database settings. |
| **Two rotations meeting on one row from two sessions** | The suite's "two rotations at once" runs on PGlite's single session and on the memory store, where the calls take turns. On a real server it is the row lock of the `UPDATE` that orders them, and the second statement's `WHERE` (the stored secret is still the one read; no previous secret still signs) is then judged against the first one's row: reasoned from how `UPDATE … WHERE` re-checks under `READ COMMITTED`, not exercised. |
| **A rotation on one instance while another instance's worker is mid-round** | One process: the rotation is made from inside the receiver's handler while the lane's request is in flight, so the lane goes on with the row it read. Two processes were not run. |
| **Clock skew between the instance that takes a rotation and the one that signs** | Not run. The end of the overlap is written by one instance's clock and judged by another's; a skew of *s* seconds moves the instant the old secret stops by *s*, in either direction. |
| **The cleanup of an expired secret within five seconds, on a deployment** | One round of the worker on the test clock, a millisecond before the end and at it. The five seconds are the worker's timer in `server.ts`, which no test of this step runs. |
| **A wrong `TULA_MASTER_KEY` on one of several instances during a rotation** | A ciphertext that does not open, placed in the row by the test. Two real instances with different keys were not run: a rotation that reaches the instance with the wrong key is refused (`secret_unreadable`) only if that instance cannot open the current secret, which is the case tested. |
| **Scenario `50-webhook-secret-rotated-with-an-overlap` against a live server** | In process, one round of the real worker per `webhook` step (part of `bun run verify`). It is written to run unchanged against `bun run dev` with `CONFORMANCE_WEBHOOK_RECEIVER_HOST=127.0.0.1`; that run was **not made**. Against a live server its `webhook` steps wait for the server's own worker; a round that was already serving the endpoint when the rotation committed signs with the old secret alone, which the scenario's first delivery after the rotation would report as a missing signature. The scenario creates its event *after* the rotation has answered, and such an event is queued by a pass that precedes the round's read of the endpoints, so it cannot be served from a row read before the rotation: reasoned, not observed. |
| **The change to CI's `self-host` jobs** (the exact set of three skipped scenario names; `3 skipped` in the two summary lines) | The shell lines were copied from `ci.yml` and run against seven sample logs (all three names; the two older ones only; two of three; three with another name in place of one; a fourth; none; the three names with `2 skipped` in the summary). The workflow itself only runs on GitHub and was not run. |
| **The dashboard** | Its generated hooks changed (`api.gen.ts`); no hand-written dashboard source was touched and its Playwright project was not run. The dashboard has no webhooks screen. |

### What a test does not prove

| What | Why |
| --- | --- |
| **That `verifyWebhook` takes the same time whichever secret matched** | A test counts the HMACs made (one per secret, whether the first matched, the second, both or neither) and the code gathers the comparisons without a branch. No timing was measured, and JavaScript gives no guarantee about how a string comparison is compiled. |
| **That nothing of a secret is ever logged** | The logger is replaced by a spy in the tests that rotate, deliver, fail a delivery, end an overlap and hit an unreadable secret, and everything it was given is searched for both secrets and their base64 parts. That covers the log calls those paths make, not a driver or a framework logging on its own. |

### Not test-first

Every behaviour of this step had its test written and **seen to fail** before the code, with
these exceptions, each a test of something that already held or that the first test of its
group had already forced:

- `a secret stored before rotation existed still opens, signs and can be rotated`: its first
  half (an existing row opens and signs) passed before any change, as it must; that is the
  point of it. Its second half failed until rotation existed.
- The two real-API tests in `packages/admin/src/webhook-real-api.test.ts`: written after the
  routes and the verifier, as an end-to-end confirmation. They passed on their first run.
- `a delivery of the overlap verifies with either secret and has exactly two signatures`
  (conformance): passed before the step could check anything, because an unknown argument was
  ignored; the tests beside it, which expect a problem to be reported, failed first.
- Scenario `50`: passed on its first run in process (the server was built by then). It was
  then seen to fail with the server broken two ways (the previous secret never signing; the
  early end leaving it in place).
- The `@ts-expect-error` lines for the two new store methods compile only because the
  methods require an activity; they were seen to fail (as unused directives) with the
  parameter made optional.
- Each boundary in time (`<` against `<=`, in the service and in both stores) was mutated
  once and seen to fail a test, as were the slot binding, the header's order, the cleanup
  pass and the verifier's guards. Two mutations survive by construction and are said here:
  removing the service's own "a rotation is under way" check leaves every test passing,
  because the store's statement refuses the same thing; and removing the verifier's check of
  the `v1` label changes nothing, because an entry is compared whole, label included.


## Step 2.2, endpoints in the config file (TULA-44, [ADR 0030](../adr/0030-config-and-apply.md#webhook-endpoints-in-the-file-added-2026-10-08-tula-44))

### The server as it is deployed

- `tula diff` and `tula apply` were run against the API **in process** on memory adapters
  (`packages/cli/src/real-api.test.ts`), with the outbound guard's resolver faked. They were
  not run against a deployed server, a Postgres store or a real name server: an address the
  real guard refuses for a reason the fake cannot produce was not seen.
- A config with a `webhooks` list against a server **older than webhooks** (no
  `/v1/admin/webhook-endpoints`) was not run. It is expected to fail on the list request,
  with the API's 404 and nothing written; a file without the list asks nothing about
  endpoints and is unaffected.

### The secrets file

- `--secrets-file` was exercised through the real host on macOS (mode 0600, an existing
  file, a symbolic link). Not on Linux in this step, and not on Windows, where modes do not
  exist. A named pipe, a directory and a link to a pipe at the path are tested (host,
  `tula apply`, `tula dev`) since the review; on macOS only.
- `Host.readFile` has two defences against a named pipe (the `lstat` before the open, and a
  non-blocking open with the kind checked on the handle). Each alone refuses a pipe, so
  removing either leaves every test green: the tests pin the outcome (refused, at once), not
  each layer. The plain read they replaced was seen to hang.
- The rewrite of the secrets file is guarded by reading it back first. A file replaced
  between that read and the rename is overwritten; no test can hold that window open.
- The CI example in `docs/config.md` (the step that hands the file to a secret store) is
  prose: no workflow runs it.

### What is not guaranteed

- A change someone else makes to an endpoint between the run's second read and its writes is
  not detected (endpoints have no revision). The test changes an endpoint while the question
  is on screen, which the second read catches; the narrower race is not testable without a
  conditional write in the API.

### Not test-first

Every behaviour had its test written and seen to fail before the code, with these exceptions:

- `a secret written in the file is refused before any request, and not repeated` and
  `a file without a webhooks list does not read the endpoints, and --prune does not touch
  them` (real API): both passed on their first run, the first because the config package was
  already done, the second because not reading is what the CLI did before.
- `packages/cli/src/render-webhooks.test.ts` (the plan's wording for a re-enabled endpoint, a
  changed address, plurals, and what a server sent being made printable) was written after
  the renderer and passed on its first run.
- The rows of the `planWebhooks` table and of the write-order table failed together, for a
  missing export, not one by one; no single rule was mutated afterwards to see its own row
  fail.
- The last test of `real-api.test.ts` (nothing shaped like `whsec_…` in any run's output)
  cannot fail for the redaction alone: no line of the CLI prints a secret unasked with or
  without it. It holds the outcome, not the net.

## Step 2.3, the hook before sign-up (TULA-45, [ADR 0035](../adr/0035-hooks.md))

What was built is tested against a receiver in the test's own process, through the real
outbound guard in the `local` tier. Not verified:

| What | How far it was taken |
| --- | --- |
| The hook store on a real PostgreSQL server | The shared suite runs on the memory adapter and on PGlite (with every migration, as the runtime role). It is listed in `stores.integration.ts`, which was **not run**: the worktree has no database settings. Two registrations at once meeting the unique index on a real server is therefore unobserved. |
| The two conformance scenarios against a live server | Run in process only. A containerised target skips them by name (it cannot reach the runner's receiver); they were not run against a server on the same host either. |
| A real operator endpoint over `https` | Every call in the tests is plain `http` to loopback, which only the `local` tier allows. TLS, a real certificate chain and a real name server on this path are the outbound guard's own tests, not this step's. |
| Timing | The tests assert on responses and on whether the receiver was called, for an existing and a new address side by side. No test measures how long a request takes beyond "a hook that hangs is given up inside a second and a half with a 100 ms deadline". Nothing equalises the time of a request that asks the hook with one that does not; ADR 0035 says why that difference is only between requests that already answer differently. |
| The deadline under load | One request at a time. What many sign-ups waiting on a slow endpoint do to the API's own latency (each holds a request open for up to the deadline) was not measured; the ceiling of 600 calls a minute bounds how many can be waiting. |
| What a denied sign-up looks like in a browser | `@tula/react` was read, not run: the code screen shows the message of `hook.denied` / `hook.unavailable` from `@tula/core`'s table and keeps "start again". No component changed, so no Playwright project was run. |
| `verifyHook` behind a real framework's body handling | Called with text and with bytes, as `verifyWebhook` was. |

Tests seen to fail first, and the ones that were not, are listed in the step's report.

## Step 2.3, hooks before a session and before a token (TULA-53, [ADR 0035](../adr/0035-hooks.md#2026-10-08-hooks-before-a-session-and-before-a-token-tula-53))

What was built is tested against a receiver in the test's own process, through the real
outbound guard in the `local` tier. Not verified:

| What | How far it was taken |
| --- | --- |
| Migration `0022` on a real PostgreSQL server | Applied only to PGlite, by the package's own tests (the column, the check refusing a non-object and an oversized value, the runtime role writing it). `db:migrate` was **not run**, and neither was `packages/db/src/rls.integration.ts`. |
| The session store's new behaviour on a real server | The shared suite (claims stored at creation, replaced at a step-up, the compare-and-set on what the session had proven, a bad stored value read as none, another environment's row untouched) runs on the memory adapter and on PGlite. `apps/api/src/adapters/postgres/stores.integration.ts` was **not run**. Two step-ups of one session racing on a real server are therefore unobserved; the test of it interleaves them by hand on the memory adapter. |
| The three conformance scenarios against a live server | `54`, `55` and `56` ran in process only. A containerised target skips them by name; they were not run against a server on the same host. The change to `.github/workflows/ci.yml` (eight names, two counts) was edited and read, and **no workflow was run**. |
| A real operator endpoint over `https` | As for the first hook: every call in the tests is plain `http` to loopback. |
| How long a sign-in really waits | The bound (two calls, each inside its deadline) is asserted with 100 ms deadlines: a sign-in behind a hook that hangs ends within a second and a half. The worst case in `docs/hooks.md` (10 seconds, 15 for a sign-up) is arithmetic from the constants, not a measurement, and nothing was measured under load. A request that waits on a hook holds its place for that long; what many of them do to the API was not tried. |
| A sign-in refused by the concurrent-session rule or by the late second-factor check after the hooks were asked | Read in the code and stated in the ADR (the hooks may be asked about a session that is then not created); **no test** drives `refuse_newest` or that check behind a hook. |
| What a refused sign-in looks like in a browser | `@tula/react` and the example apps were not run. No component changed; the screens show the message `@tula/core` has for `hook.denied` / `hook.unavailable`, whose text became neutral ("This was not allowed.") because it is now shown at a sign-in too. No Playwright project was run. |
| `auth().customClaims` in a running Next.js app | Proven by `packages/nextjs/src/real-api.test.ts` against the real API in process (a token session through the middleware's refresh, a stateful session through the sealed header), not in `next start` and not in the `nextjs` Playwright project. |
| Rolling back past `0022` | Reasoned, not tried: an earlier version ignores the column, and may fail to list a hook registered for a point it does not know. `docs/self-host.md` says to remove those hooks first. |
| The dashboard | Its generated client was regenerated and its tests run by `verify`; no screen shows or edits a hook (TULA-59), and the app was not opened. |
| Review round 1: a template that outgrew stored hook claims | A refresh, its replay in the grace window, both ways through a stateful check and a grown address, on memory adapters. `POST /v1/admin/sessions/verify` and the Next.js helper go through the same `customClaims` and were **not** driven with an outgrown template. |

Tests seen to fail first, and the ones that were not, are listed in the step's report.

## Step 2.2, the worker as its own service (TULA-52, [ADR 0034](../adr/0034-webhooks.md#the-worker-as-its-own-service-added-2026-10-08-tula-52))

Run for real, once, by hand on one machine (Docker 29.8.1, macOS): the image built from this
tree, the Compose stack as an isolated project with `WEBHOOK_WORKER=separate` and no worker,
then `scripts/worker-check/check.ts` as CI's `self-host-worker` job runs it. It passed: no
delivery row and a failing `webhook_worker` after an owed event had waited over a minute,
`501 worker_separate` from both instances, then, with the worker started, one delivery
`delivered` (204, one request), received on the worker's loopback and signed with the
endpoint's secret, counted in the worker's log and in neither instance's. Also seen there:
an API container gets `ConnectionRefused` at the receiver's address; a worker given
`WEBHOOK_WORKER=api` prints its refusal and exits 1; `docker compose stop worker` ends the
worker with exit code 0. The check was run once more, the same way on a fresh stack, after
review round 1 (the refusal moved in front of the send limit; the worker given less of the
environment): it passed, and the running worker container had none of `TULA_ADMIN_TOKEN`,
`OAUTH_MOCK_PROVIDER`, `CORS_ORIGINS`, `TRUST_PROXY` and `PASSWORD_POLICY` set. Not verified:

| What | What was run instead |
| --- | --- |
| **The `self-host-worker` job on GitHub** | Its steps by hand, on macOS with Docker Desktop. The workflow itself only runs on GitHub; `.claude/hooks/ci.test.ts` holds its shape (the variable, the order, that the worker is not started by the job). Whether a Linux runner's Docker shares a network namespace the same way (`network_mode: service:worker`) is expected and was not seen. |
| **Several worker containers against one real PostgreSQL** | The job lock with several holders is tested on the memory lock and a stand-in for advisory locks (`modules/webhook/worker-separate.test.ts`, the job-lock suite); `job-lock.integration.ts` covers two real sessions and was not run for this step. Two worker containers were not started side by side: the check's receiver lives in one worker's namespace, so a second worker that wins a round cannot reach it. |
| **Shutdown in the middle of a round** | `startJobs` is tested with injected timers and a stand-in round: finishing aborts the round's signal and waits for the round. That a round told to stop records the requests it is making is a test of `Webhooks.run` from TULA-42. The two were not run together in a process that then exits, and the container was stopped while idle (exit code 0), not while a request to a slow receiver was open. |
| **The worker when the database goes away and returns** | The spawned worker with no database: it starts, `/v1/ready` answers 503, it does not exit (`worker.test.ts`). A database lost and restored under a running container was not staged. |
| **Egress separation itself** | Nothing was run with a network policy. What is shown is that an API instance makes no request to an endpoint (unit tests, and the check's log and delivery-log evidence), not that a firewall in front of the API instances breaks nothing: an API instance still resolves an endpoint's host when it is saved, and still calls hooks. |
| **`webhook_worker` with more than 200 environments, on a real database** | The memory stores with 201 environments. The read is one indexed lookup per environment (`oldestPendingEventAt(environment)`: one timestamp) inside the existing scan; its cost on a large outbox was not measured. |
| **Mixed values across API instances** | Not detected by anything, and said so in the docs. Not tested beyond each process following its own value. |
| **`tula doctor` printing the new check** | The check is a row of the server's answer, which the CLI prints as it prints the others; no CLI test names `webhook_worker`. |
| **Review round 1: `oldestPendingEventAt` on a real PostgreSQL server** | The shared suite on the memory adapter and on PGlite. `stores.integration.ts` was **not run**. |
| **Review round 1: a worker in a live tier with the reduced environment** | The Compose `worker` service no longer gets `TULA_ADMIN_TOKEN`, `OAUTH_MOCK_PROVIDER`, `CORS_ORIGINS`, `TRUST_PROXY` or `PASSWORD_POLICY`; it was started that way in the `local` tier only (the worker check). That the schema lets a process start without each in `staging` and `prod` is read from `env.ts` (each is optional or has a default, and no cross-field rule asks for one), not run. `PUBLIC_URL`, `SMTP_URL`, `MAIL_FROM`, `BREACH_CHECK` and `REDIS_URL` are still given to it although it uses none: the schema demands them of every process in a live tier, and it was not weakened. |
| **Review round 1: the order of the refusal against a real limiter** | Twelve refused calls, a malformed body, no key and the untouched send bucket are tested in process on the memory rate limiter, not on Redis. |

## JWT templates (TULA-10, [ADR 0036](../adr/0036-jwt-templates.md))

Custom claims are tested through the API in process (memory adapters), the conformance
scenario, the `@tula/core` journey, `@tula/nextjs` and the CLI against that API, and the
dashboard in a browser. Not verified:

| What | How far it was taken |
| --- | --- |
| A real PostgreSQL server | No table and no migration changed: templates are part of the settings document. The integration tests (`*.integration.ts`) were **not run**: they migrate the local development database, which a worktree must not do. That the stored JSON round-trips through the real `jsonb` column is therefore covered only by the lenient stored schema's own tests. |
| The conformance scenario against a live server | `jwt template custom claims` ran in process only. |
| Another instance's stale settings cache | Simulated with two caches over one store in one process (`modules/settings/jwt-templates.test.ts`), not with two API processes and Redis. |
| The cookie budget in a browser | The token and the `__Host-tula_at` cookie's name and value are measured in `packages/nextjs/src/real-api.test.ts` (2,097 bytes at the cap). No browser was asked to store a cookie of that size together with its attributes. |
| The Next.js example | It does not show a custom claim: `auth().customClaims` is tested against the real API in process, for a token and for a stateful session, not on a page in a browser. |
| `user.created_at` against `session.created_at` over HTTP | Told apart only in the API's own test, which moves the fixed clock between creating the user and signing in. Scenario 53 cannot: a scenario has no way to move a server's clock, its sign-up and sign-in fall in the same second, and the scenario format compares a claim with a value, not two claims with each other. |
| A third party's JWT library | The token with `ext` is verified by the API's own verifier and by `@tula/nextjs`. No other verifier was tried. |

## Step 2.5, Microsoft (TULA-12, [ADR 0026](../adr/0026-oauth.md))

| What | What it was tested against instead |
| --- | --- |
| **A real Microsoft tenant, app registration and ID token** (work, school and personal accounts) | ID tokens the tests sign with their own keys, published through a stubbed keys document (`adapters/oauth/microsoft.test.ts`), and the API's mock provider for the whole flow (the conformance scenarios, the SDK journeys, the browser tests). No request went to `login.microsoftonline.com`. |
| **That `xms_edov` arrives as a JSON boolean** | Microsoft's optional-claims reference ("Boolean value indicating whether the user's email domain owner has been verified"), as read on 2026-10-08. A token that carried the string `"true"` would be read as unverified. |
| **Whether a personal Microsoft account's token ever carries `xms_edov`** (tenant `consumers`, and the personal accounts `common` admits) | Nothing. The optional-claims reference describes the claim as the verification of the address's *domain owner* and does not say what a personal account gets; no personal-account token was looked at. If it never carries the claim, personal accounts cannot sign up with Microsoft at all (they can still be connected from a signed-in profile). `docs/providers/microsoft.md` says this at its top. |
| **That every signing key in Microsoft's keys document carries `issuer`**, templated for organizations and exact for the personal-account tenant | Microsoft's "Validate the signing key issuer" section, as read. The adapter refuses a key without one, so a keys document that differed would fail every sign-in, closed. |
| **The portal steps of `docs/providers/microsoft.md`**, among them adding `xms_edov` as an optional claim | Written from the documentation; not clicked through. |
| **Microsoft's token endpoint refusing a wrong PKCE verifier** | The requests the adapter builds (unit tests) and the mock provider, which refuses one. |
| **The button against Microsoft's branding guidelines** | Not checked against the guidelines' page in this change: the four-square logo and its colours are drawn from memory of them, and the button keeps the theme's surface, type and "Continue with …" wording. |

## Step 2.5, Discord and LinkedIn (TULA-13, [ADR 0026](../adr/0026-oauth.md))

| What | What it was tested against instead |
| --- | --- |
| **A real Discord application, token and user object** | The requests the adapter builds and answers the tests stub (`adapters/oauth/discord.test.ts`), and the API's mock provider for the whole flow (conformance scenarios 60 and 61, the SDK journeys, the browser tests). No request went to `discord.com`. |
| **Discord accepts PKCE: not observed against the real service** | Nothing. Discord's OAuth2 page (read 2026-10-08) does not mention PKCE, neither for nor against. The adapter sends an S256 challenge and the verifier because the rule is "a new provider sends PKCE unless its documentation rules it out" and silence does not; the source is `arctic`'s `Discord` client, not Discord's page. The mock provider refuses a wrong verifier. Whether Discord checks it, ignores it or will one day reject it was not observed. |
| **The `/api/v10` in the profile URL** | Written from memory of Discord's API reference; the user page read on 2026-10-08 names `GET /users/@me` and not the version prefix. |
| **That `verified` and `id` arrive as a JSON boolean and a string** | Discord's user resource page as read (`verified?` boolean, `id` snowflake, shown as a string in the example). A `"true"` or a numeric id is read as unverified and refused. |
| **A real LinkedIn app, token, keys document and userinfo answer** | ID tokens the tests sign with their own keys, published through a stubbed keys document, and userinfo answers the tests write (`adapters/oauth/linkedin.test.ts`); the mock provider for the whole flow (scenarios 62 and 63, the journeys, the browser tests), which carries a userinfo answer in its code and judges it with the real adapter's function but makes no request. No request went to `linkedin.com` or `api.linkedin.com`; LinkedIn's discovery document was fetched once, by hand, to read it. |
| **What a real LinkedIn userinfo answer looks like** | Nothing. The adapter verifies the ID token for `sub` and reads `email`, `email_verified` and the name from `GET https://api.linkedin.com/v2/userinfo` only, as LinkedIn's guide documents them. Not observed: that the answer's `sub` is the same value as the token's (if not, **every LinkedIn sign-in is refused**, `invalid_token`); that `email_verified` is a JSON boolean (if it is the string `"true"`, **nobody can sign up with LinkedIn**, `oauth.email_unverified`); that the access token of this flow is accepted there with the scopes `openid profile email`; and what status the endpoint answers for a token it refuses (every non-2xx is `unavailable`). `docs/providers/linkedin.md` lists them under "Limits". |
| **Which `iss` a real LinkedIn token carries** | The discovery document says `https://www.linkedin.com/oauth`, the guide `https://www.linkedin.com`. The adapter accepts exactly those two; neither was seen in a token. |
| **That LinkedIn has no PKCE and echoes no nonce for this flow** | LinkedIn's authorization-code flow page and discovery document, as read on 2026-10-08: no such parameter, no `code_challenge_methods_supported`, no `nonce` in `claims_supported`. LinkedIn's PKCE is a flow of its own for native clients (its page read on 2026-10-09): another authorization endpoint, a loopback redirect address only, no client secret, and switched on for one app by LinkedIn on request. Whether the server-side endpoint would accept a challenge it does not document was not tried. |
| **The portal steps of `docs/providers/discord.md` and `docs/providers/linkedin.md`** | Written from the documentation; not clicked through. |
| **The two buttons against Discord's and LinkedIn's brand guidelines** | Not checked. Both marks (the paths and the colours `#5865F2` and `#0A66C2`) were drawn from memory, without either brand page open. |

## Step 2.5, X and Facebook (TULA-14, [ADR 0026](../adr/0026-oauth.md#x-and-facebook-providers-without-an-address))

Everything read from a provider's site below was read on **2026-10-09**.

| What | What it was tested against instead, or what is known |
| --- | --- |
| **A real X app, token and `/2/users/me` answer** | The requests the adapter builds and answers the tests stub (`adapters/oauth/x.test.ts`), and the API's mock provider for the whole flow (conformance scenarios 66 and 67, the SDK journeys, the browser tests). No request went to `x.com` or `api.x.com`. Not observed: that the token endpoint takes the client id and secret as Basic credentials beside a PKCE verifier, and that the answer is `{ data: { id, name, username } }` with `id` a decimal string. Each fails closed. |
| **What X charges for a sign-in, and whether an app may use this at all: not confirmed** | [X's pricing page](https://docs.x.com/x-api/getting-started/pricing) says "pay-per-usage pricing", "no subscriptions", credits bought upfront; it names no free tier and lists reading a user at $0.010 per resource. It does not say whether that applies to `GET /2/users/me`, which is called once per sign-in. [The rate-limit page](https://docs.x.com/x-api/fundamentals/rate-limits) gives that endpoint 75 requests per 15 minutes per user and no per-app limit; [its reference](https://docs.x.com/x-api/users/get-my-user) names the scopes `users.read` and `tweet.read` and no plan. None of the three pages carries a date. **Nobody has looked at a real developer console.** If each sign-in is billed, a sign-in with X costs the operator a cent and fails when the credits are gone: `docs/providers/x.md` says so under "Limits". |
| **That X requires PKCE of a confidential client** | [X's authorization-code page](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code) lists `code_challenge` and `code_challenge_method` among the authorization parameters and `code_verifier` for the exchange; the text read did not say "required" in so many words. The adapter always sends S256. That X refuses a wrong verifier was not observed; the mock provider does. |
| **`arctic`'s own `Twitter` client is not used** | Its hosts are `twitter.com` and `api.twitter.com`; X's documentation now writes `x.com/i/oauth2/authorize` and `api.x.com/2/oauth2/token`. The adapter uses `arctic`'s generic `OAuth2Client` on the documented hosts. Whether the old hosts still answer was not tried. |
| **A real Facebook app, dialog, token and `/me` answer** | The requests the adapter builds and answers the tests stub (`adapters/oauth/facebook.test.ts`), and the mock provider for the whole flow (scenarios 68 and 69, the journeys, the browser tests). No request went to `facebook.com`. Not observed: that the Graph API takes the access token in the `Authorization` header beside `appsecret_proof` in the query (Meta's [securing requests](https://developers.facebook.com/docs/graph-api/guides/secure-requests) page documents the proof as a parameter and shows the token as one too), and that `id` arrives as a decimal string ([the user reference](https://developers.facebook.com/docs/graph-api/reference/user/) calls it a "numeric string"). Each fails closed. |
| **That Facebook Login has no PKCE in this flow** | Meta's [manual flow page](https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow): the dialog takes `client_id`, `redirect_uri`, `state`, `response_type`, `scope`; the exchange `client_id`, `redirect_uri`, `client_secret`, `code`. PKCE and a nonce are documented only for the [OIDC flow](https://developers.facebook.com/docs/facebook-login/guides/advanced/oidc-token) (the `openid` scope), which is not used. The adapter sends neither; the mock checks a challenge for Facebook all the same, which the real service cannot. |
| **The Graph versions** | The profile is read on `v25.0`, the version of the examples on Meta's pages as read. The dialog and the token endpoint are `arctic` 3.7.0's, on `v16.0`. Meta's [versioning page](https://developers.facebook.com/docs/graph-api/guides/versioning) says an API call to an unusable version is answered by the next oldest usable one; it says nothing of the dialog. Whether `v16.0` still answers was not tried: **not observed against the real service**, and `v16.0` (February 2023 as far as we know; Meta's changelog was not opened) is probably past Meta's two-year support window. If a real login fails on it, build the dialog and the token request by hand on the pinned `FACEBOOK_GRAPH_VERSION` with `arctic`'s generic `OAuth2Client`, as the X adapter does (`docs/providers/facebook.md` has the two addresses). |
| **A Graph-format error from Facebook's token endpoint** | Stubbed: it surfaces as the provider being unavailable, not as an invalid code (`arctic` reads OAuth's `error` string, Facebook sends an object). The user sees the same failed sign-in. |
| **An account with no email address, on a real PostgreSQL server** | The migration (`0025_user_without_address.sql`: `users.email` and `email_normalized` nullable, the check `users_email_whole`) was generated and read, and the user repository's suite ran on PGlite. `db:migrate` and `*.integration.ts` were **not run** from the worktree. |
| **Every place that assumed a user has an address** | Found by making `email` nullable in the port and the contract and following the compiler, then by tests: creation, the `email` identity row, password lookups, notices, TOTP and passkey labels, the `email` JWT-template source, the hook question, the React profile and user button, the dashboard's user screens, the MCP projection. A place that reads the address from somewhere the types do not reach (SQL written by hand, an operator's own webhook receiver or `before_sign_up` hook that calls a method on `email`) was not found by this. |
| **The portal steps of `docs/providers/x.md` and `docs/providers/facebook.md`** | Written from the documentation; not clicked through. Meta's app review, and what it requires before people without a role on the app can sign in, was not looked at. |
| **The two buttons against X's and Meta's brand guidelines** | Not checked. Both marks (the paths, X's in the text colour and Facebook's in `#0866FF`) were drawn from memory, without either brand page open. Meta has wording rules for a Facebook login button that "Continue with Facebook" was not held against. |

For the product's owner to decide:

- **A user with no email address cannot add one.** No route changes a user's address today,
  for anyone. Until one exists, an account made through X or Facebook gets no security
  notice, cannot use an emailed code, a link or a password, and is lost with the provider
  account unless it has a passkey. Whether to add "add an email address" (a verified one,
  through the existing code flow), and whether to ask for one at sign-up, is open.
- **Someone with an account who then chooses "Continue with X" gets a second account.**
  That is what "never links automatically" means in practice. Connecting from the profile
  avoids it; nothing merges two accounts afterwards.
- **Whether X's and Facebook's address should ever be asked for.** Not asking was chosen
  because neither can be taken as verified. Asking for it unverified, to pre-fill an
  "add your email" step that then proves it, would be a change to this decision.
- **Whether a sign-in with X is worth what X charges**, once someone has read a real
  developer console.

## A phone number on an account (TULA-11, [ADR 0037](../adr/0037-phone-numbers-and-sms.md))

Adding, confirming and removing a number are tested through the API in process (memory
adapters), the conformance scenario, the `@tula/core` journeys, the React components in
happy-dom and in a browser, and the dashboard's component tests. Not verified:

| What | How far it was taken |
| --- | --- |
| A real text message | There is no adapter for a provider: no message has ever left the server. The message's text is checked for its length in GSM-7 by counting characters, not by a carrier. |
| The origin-bound line on a phone | The format (`@host #code`) is written as specified. No phone or browser was asked to offer a code from it. |
| A real PostgreSQL server | The migration (`0023_phone_number.sql`) was generated and read, not applied: `db:migrate` and the integration tests (`*.integration.ts`, the user repository's new methods and the check `users_phone_number_whole` among them) were **not run** from the worktree. |
| The conformance scenario against a live server | `phone number on an account` ran in process only. The `self-host` CI jobs were changed to start the stack with `SMS_PROVIDER=dev` and to read both instances' inboxes; that workflow has not run. |
| The development inbox behind several instances | The runner's reading of several inboxes (the newest message across them) is unit-tested against fakes, not against two API processes. |
| The calling-code table | Hand-written. Not checked against a provider's own table, and it does not know number ranges inside a country (premium rates, satellite). |
| The dashboard in a browser | The "Text messages" section and the phone number on a user's screen are covered by component tests (happy-dom); the `dashboard` Playwright project has no scenario for them. |

## SMS send limits and the daily limit (TULA-28, [ADR 0037](../adr/0037-phone-numbers-and-sms.md))

The limits, the daily limit and the counts are tested through the API in process (memory
adapters), on PGlite (the usage store's shared suite, the table's checks, grants and both
policies), by two conformance scenarios and two `@tula/core` journeys. Not verified:

| What | How far it was taken |
| --- | --- |
| **The day's take on a real PostgreSQL server** | `apps/api/src/adapters/postgres/sms-usage.integration.ts` was run once, on 2026-10-09, against the local development server (PostgreSQL in Docker Compose), with the other integration files: 357 pass. It is what shows takes at once on real sessions: many environments on a pool of two connections, one environment at its last message from two pools, the wait behind a holder of the key, the lock timeout, and that a session-level lock of Tula's namespace is another lock. Not shown: the same under a production pool's load, or on a managed PostgreSQL with a connection pooler in front (a pooler in transaction mode keeps a transaction-level lock correct; that was reasoned, not run). |
| **That the pool can no longer be exhausted by sends** | Argued from the code (a take is one transaction on one connection) and held by the integration test above on a pool of two. The exhaustion the first version allowed was read from `withAdvisoryLock` and the pool's settings, never reproduced. A take that waits for its environment's turn still holds a connection for up to the lock wait (5 seconds): many sends at once in one environment can slow other requests for that long, and that was not measured. |
| The migration | `0024_sms_code_counts.sql` was regenerated with the delete floor, applied on PGlite by every test that opens a database, and applied once to the local development server by the integration run above. |
| The delete floor's day boundary | `day < (now() at time zone 'utc')::date - 7` is tested with rows from a day after today to 37 days before, at whatever time the tests run. The minutes around midnight UTC were not picked out. |
| A conformance run against a live server | The two scenarios ran in process only; the `self-host` CI jobs were changed to check that they **passed**, and that workflow had not run with them when this was written. |

## Step 2.4, Twilio (TULA-29, [ADR 0037](../adr/0037-phone-numbers-and-sms.md#twilio-added-2026-10-09-tula-29))

The Twilio sender is tested with `fetch` stubbed (`adapters/sms/twilio.test.ts`: the
port's suite, the request it builds, every answer that is not an acceptance, the deadline,
the canary), through `Sms.sendCode` in process (`modules/sms/twilio-path.test.ts`), and
its variables by `env.test.ts` and `container.test.ts`. **No request has ever gone to
Twilio from this code, from a test or by hand.** Not verified:

| What | How far it was taken |
| --- | --- |
| **Delivery to a real handset** | Nothing. No message has left the server: there was no Twilio account, no credentials and no phone in the work. The first real message is the owner's to send (`docs/providers/twilio.md`, the last step), and until then "it sends" rests on Twilio's reference and a stub written from it. |
| **A real answer from Twilio** | The stubbed answers are written from Twilio's message resource and response pages (read 2026-10-09): `201` with a JSON body whose `sid` is `SM` or `MM` and 32 hexadecimal characters; an error as `{ status, message, code, more_info }`. Not observed. Since the change to three outcomes (ADR 0037, "What counts as sent, and which way the count errs") nothing rests on the body of a 2xx: any 2xx is a sent message, and a `sid` of an unexpected shape, or none, is a warning in the log and no longer breaks sending. What still rests on Twilio's pages and not on an observation: that an accepted message is answered with a 2xx at all, and that a refusal is never a 2xx (a 2xx with an error in its body would be counted as sent). And since the review (ADR 0037, "A 4xx is a refusal; a 5xx is not"): that **no 4xx follows a message Twilio took** (every 4xx gives the message back to the day; no page read says otherwise, and none was found that rules it out in so many words), and what a real 5xx of Twilio's or of its edge looks like (any 5xx is `unconfirmed` whatever its body, so only the log depends on it). |
| **What Bun's `fetch` does when no answer comes** | The three outcomes are tested with `fetch` stubbed. What the runtime does with a redirect under `redirect: 'error'` was asked of Bun 1.4.2 against a local server and is asked again by a test on every run. What it rejects with for a refused connection, a failed lookup, a TLS failure or a reset was not catalogued, on purpose: all of them are `unconfirmed`. That the status line of a real answer arrives before `fetch` resolves (so that a body cut off afterwards is judged by its status) is how `fetch` is specified; it was exercised with stubbed streams only. |
| **An outage that spends the day** | Reasoned, and tested in process: with the sender answering nothing, each try keeps its message in the day's count, and the day's last message is spent by such a try. The same holds, and is tested, for an outage that answers: **while Twilio answers 5xx, each try spends one of the day's messages**, although most such answers follow nothing sent. How fast a real outage spends a real limit (the per-asker and per-number limits bound it) was not measured, and nothing alerts an operator to it beyond the log lines. |
| **The shape of a real API key secret and auth token** | Not documented on the pages read. `env.ts` accepts any printable ASCII of 1 to 256 characters for both; the SIDs are held to two letters and 32 hexadecimal characters (Twilio's SID glossary). A real secret outside that would stop the boot, naming the variable. |
| **The Console steps of `docs/providers/twilio.md`** | Written from the documentation; not clicked through. Menu names are Twilio's as its pages gave them on 2026-10-09. |
| **Sender registration in the United States** | Taken from Twilio's A2P 10DLC, direct standard onboarding and toll-free verification pages (2026-10-09): a 10-digit number must be registered (a Brand and a Campaign, on a Messaging Service) and a toll-free number verified before either reaches the United States or Canada; review takes days to weeks. The times and the Sole Proprietor allowance are Twilio's figures of that day. Fees were not read and are not stated. Other countries' sender rules (sender IDs, pre-registration) were not read at all. |
| **Geo permissions against `sms.allowedCountries`** | Twilio's page says a new account can send to its home country only and that the list is changed in the Console (error 21408 otherwise). That the two lists are independent is reasoned from that; nothing compares them, and the diagnostics cannot see Twilio's. |
| **SMS pumping protection** | Twilio's page says it must be enabled, and that a blocked message is error 30450. Whether it is on by default for a new account, and whether a message it blocks is refused at the API (a failed send here) or accepted and dropped later (a sent one here), was not established. |
| **A trial account** | Twilio's page: verified numbers only, the sign-up country, Twilio's own templates. So a trial account cannot send Tula's text; the wording a trial message is given was not seen. |
| **Error codes named in the docs from memory** | 21408, 21608, 30032, 30034 and 30450 were read on Twilio's pages. 20003 (authentication), 21211 (an invalid number) and 21614 (not a mobile number) are from memory of Twilio's error reference and were not opened. |
| **Whether Twilio rewrites the text** | The adapter sends `Body` as given and no option. Whether an account's Messaging Service has Smart Encoding or link shortening on (which change characters or links) is the account's setting; the origin-bound last line has no link Twilio's shortener is documented to touch, and that was not tried. |
| **The price of a message** | Not read. Whether the answer to a send carries a usable price was not confirmed (ADR 0037, "Twilio"). There is no ceiling in money. |
| **A proxy between the server and Twilio** | Bun's `fetch` takes a proxy from the environment whatever it is told (seen on 1.4.2 with a local proxy and a plain `http` address). For `https` that is a tunnel, and `tls: { rejectUnauthorized: true }` was seen to refuse a self-signed local server with `NODE_TLS_REJECT_UNAUTHORIZED=0` set; that it also holds **through** a proxy's tunnel was reasoned, not run. |
| **Twilio's regions** | Only `api.twilio.com` is called. That it is the United States region (US1), and that an API key made in another region is refused there, is from Twilio's regions and API key pages. |
| **A restricted API key** | Twilio's page describes Main, Standard and Restricted keys. Whether a Restricted key can be held to sending messages only was not read; the checklist says Standard. |
| **`sms_sender` on a real server** | Unit-tested on memory adapters, with a canary and a stuck store. Not run against PostgreSQL, not with more than 200 environments on one, and `tula doctor` was not run against a server that reports the row: the CLI and `@tula/mcp` print whatever rows the server sends, and no test of either names this one. |
| **The Compose stack with `SMS_PROVIDER=twilio`** | `compose.test.ts` holds that the API services pass the six variables through and the worker gets none. The stack was not started with them. `bun run test:integration` was not run in this work. |
| **The conformance scenarios** | Unchanged: they use the development inbox. No scenario can show a Twilio send, and none tries. |

## Step 2.4, signing in with a texted code (TULA-27, [ADR 0037](../adr/0037-phone-numbers-and-sms.md#signing-in-with-a-texted-code-added-2026-10-09-tula-27))

| What | How far it was taken |
| --- | --- |
| **A code texted to a real phone, typed into a real sign-in** | Nothing. Every message in the tests goes to the memory sender or the development inbox. With Twilio the sign-in's message is sent the same way as the one that adds a number, which has itself never reached a handset (above). |
| **That an unknown number and a known one cannot be told apart by time** | Reasoned, not measured. The send is not awaited for a sign-in, so a provider's latency is out of the answer; what differs is one write (the take from the day) against one read, on a path of a dozen statements. No timing was taken, in process or against a server, and nothing was measured against PostgreSQL. |
| **The counters a known and an unknown number leave** | Tested side by side on the memory limiter: the same keys counted, in the same order (`modules/flow/sms-sign-in.test.ts`). Not against Redis. |
| **The lookup by number on a real PostgreSQL** | The shared repository suite runs it on PGlite (the migration applied, row-level security on). `bun run test:integration` was not run in this work, and the partial index `users_environment_phone_number_idx` was not looked at with `EXPLAIN` on a table of any size. |
| **Migration `0027` on a large `users` table** | Applied to an empty PGlite database by the tests. It is a plain `CREATE INDEX` (not `CONCURRENTLY`): it holds a lock that blocks writes to `users` while it builds. |
| **Number recycling and SIM swaps** | The 365-day rule and the "exactly one holder" rule are tested as rules. How long a carrier in any country really waits before reassigning a number was not researched for this work; 365 days is a choice, not a finding. |
| **The three scenarios (71 to 73) against a live server** | In process, as part of `bun run verify`. They were not run against the packaged stack: the `not` option of the `smsCode` step exists because a live server sends a sign-in's message after it has answered, and that wait was exercised only by a unit test of the runner. The two-instance run (one inbox per instance, a detached send on whichever instance answered) is where it matters and was not run here. |
| **The change to CI's `self-host` jobs** (three more scenarios required to have passed) | Read, not run: the workflow only runs on GitHub. |
| **The browser test** | Chromium only, against the fixture with the memory sender, in both colour schemes with axe. No real phone's "from messages" code suggestion was seen for the sign-in field; the message's last line is the one the account screen's code uses. |
| **An older client** | A component test gives this version a strategy it has no form for and sees it skipped, and "not supported" where it is alone. A build of `@tula/react` from before this change was not run against a server that offers `sms_code`. |
| **The dashboard** | Its confirmation dialog draws the two new sentences from a table that is unit-tested. The dialog was not opened in a browser with them, and the dashboard has no switch for the method. |
