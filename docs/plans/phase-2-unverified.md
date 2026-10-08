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
