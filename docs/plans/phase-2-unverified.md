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

## Password history (TULA-15, [ADR 0038](../adr/0038-password-history.md))

The rule is tested through the API in process (memory adapters), on PGlite (the user
repository's shared suite, the table's checks, grants and policy), by a conformance scenario,
a `@tula/core` journey, the React components in happy-dom and in a browser. Not verified:

| What | How far it was taken |
| --- | --- |
| A real PostgreSQL server | The migration (`0026_password_history.sql`) was generated, read and applied on PGlite by every test that opens a database, never by `db:migrate`. The integration tests were **not run** from the worktree: `races.integration.ts` has a new case (two instances change one user's password at once) that has never executed. |
| Two changes at once | The compare-and-set and the retry are tested on the memory adapter and on PGlite with the second change made between the comparison and the write. PGlite has one connection: that the row lock (`FOR NO KEY UPDATE`) makes two real sessions wait for each other was reasoned, and is what the unrun integration case would show. |
| The cost of 24 verifications | Measured once, on one machine (an Apple M4 Pro), in a script outside the API: 1.43 to 1.47 s alone, 1.90 s with ten callers at once. Not measured on a small container, where one verification can take several times as long and 24 of them could pass a proxy's timeout. |
| The retention purge at size | `deletePasswordHistoryBeyond` is tested for what it deletes and that it is bounded by a limit; its plan on a table of millions of rows was not looked at. |
| The purge beside a password change | The batch is picked `FOR UPDATE SKIP LOCKED`. That it passes over rows another session holds, without waiting, is a case of `races.integration.ts` written with the fix and not run from the worktree; PGlite has one connection and cannot show it. |
| The deferrable unique constraint | `password_history_user_position_unique` is tested on PGlite (a duplicate refused, the one-statement shift passing, a colliding statement refused where it ends). Not applied to a real PostgreSQL server from the worktree. |
| The conformance scenario against a live server | `password history` ran in process only, not through the packaged stack or the proxy in front of two instances. |
| A deployment that already had `history` set | Nothing was tested against a database from before this change; there is nothing to migrate (the history starts empty), and the `strict` preset's `history: 5` is enforced from this version on. |

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
| **The three scenarios (72 to 74) against a live server** | In process, as part of `bun run verify`. They were not run against the packaged stack: the `not` option of the `smsCode` step exists because a live server sends a sign-in's message after it has answered, and that wait was exercised only by a unit test of the runner. The two-instance run (one inbox per instance, a detached send on whichever instance answered) is where it matters and was not run here. |
| **The change to CI's `self-host` jobs** (three more scenarios required to have passed) | Read, not run: the workflow only runs on GitHub. |
| **The browser test** | Chromium only, against the fixture with the memory sender, in both colour schemes with axe. No real phone's "from messages" code suggestion was seen for the sign-in field; the message's last line is the one the account screen's code uses. |
| **An older client** | A component test gives this version a strategy it has no form for and sees it skipped, and "not supported" where it is alone. A build of `@tula/react` from before this change was not run against a server that offers `sms_code`. |
| **The dashboard** | Its confirmation dialog draws the two new sentences from a table that is unit-tested. The dialog was not opened in a browser with them, and the dashboard has no switch for the method. |

## Step 2.7, email templates (TULA-17, [ADR 0039](../adr/0039-email-templates.md))

The renderer, the rules and the settings are unit-tested; scenario `71-email-wording` runs
in process, under the event canary and as an SDK journey. Not verified:

| What | How far it was taken |
| --- | --- |
| **Scenario 71 against a live server** | Not run. In process the `emailMessage` step reads the memory outbox; against a live server it reads Mailpit (`mailpitMessages`), which is tested with `fetch` stubbed from Mailpit's API as the other readers use it, not against a running Mailpit. Through one address in front of two instances it depends, like every scenario that changes settings, on `CONFORMANCE_SETTLE_MS`: without it the other instance may send the built-in wording for the settings cache's 5 seconds, and the step fails on its subject marker. The self-host jobs of CI have not run it yet; they will on the pull request. |
| **How a mail client shows a template** | Nothing. The HTML part is the built-in layout with escaped text in it; no client (Gmail, Outlook, Apple Mail) was opened. Whether a given client turns something the link rule lets through into a link (a telephone number, an address written with spaces) was not tried: the rule was written from what clients are known to link, not observed. |
| **The link rule against real text** | `readsAsLink` has a table of what it refuses and what it lets through. It was not run over a corpus of real notices in other languages; how often it refuses an innocent sentence (an abbreviation with full stops and no spaces, a file name) is unmeasured. |
| **A 40 KiB settings document on PostgreSQL** | The cap is tested on the memory adapter and the schema. `bun run test:integration` was not run in this work: the Postgres adapter's read of a full section, and the cost of the all-environments origin scan with large rows, were not measured. |
| **Right-to-left and combining text in a template** | Accepted as any text, with the text-direction controls refused at save and the joiners delivered unchanged (tested as strings). Not looked at in a mail client: how a right-to-left body reads beside the server's English facts and last sentence, and whether a client shapes a joiner sequence as written, were not seen. Which code points the runtime calls unassigned is its Unicode version's; a character newer than Bun's tables would be refused, and none was tried. |
| **The browser tests** | They read codes by the built-in subjects and save no template; unchanged. No browser test words an email. |

## Step 2.12, `tula doctor` native checks (TULA-35, [ADR 0040](../adr/0040-native-app-identity.md#what-tula-doctor-checks-added-2026-10-09-tula-35))

The three checks are unit-tested on memory adapters, with canaries, a stuck store and more
than 200 environments, and `tula doctor` and the MCP doctor are run against the API in
process. Not verified:

| What | How far it was taken |
| --- | --- |
| **The fetch of a file at a real `PUBLIC_URL`** | The probe (`httpDocument`) is tested with `fetch` stubbed, and the check with the probe answered by the app's own routes in process. No server fetched its own association file over a network, through a proxy or a CDN, so what a real cache, a real redirect or a hairpin route does to the check was reasoned and not seen. |
| **That a failure here is a failure for Apple or Android** | Assumed from their documentation (no redirect followed, `application/json`). No device and no vendor tool was used, as for the files themselves (ADR 0040, "What could not be verified"). |
| **A `401` or a `403` at `PUBLIC_URL`** | A warning by decision (an access wall or a firewall in front of the API's own host). No deployment behind such a wall was run: that the wall is what answers, and not something the platforms meet too, is the reasoning of ADR 0040 and was not seen. |
| **A deployment whose `PUBLIC_URL` held credentials, a query or a fragment** | Refused at boot from this change on. None is known (no test, example or document had one), but nobody's running deployment was looked at. |
| **The operator's domain** | Never requested, on purpose. Nothing in this work shows that a domain proxies the two paths; `ok` says so. |
| **A wrong identifier of the right shape** | Not detectable from the server and not detected: a bundle ID with a typing mistake is `ok`. The ticket's "finds a wrong bundle id" holds for a malformed one only. |
| **The checks on PostgreSQL** | `bun run test:integration` was not run in this work. A row the table's own checks would refuse was stored in the memory adapter only; that such a row can exist in PostgreSQL at all takes a write by the schema owner. |
| **`tula doctor` against a packaged stack with apps registered** | Not run. The CLI test runs the real command against the API in process. |
| **The dashboard's Diagnostics screen in a browser, with a native check failing** | A component test draws the three rows. The browser tests render the screen with what the fixture's API answers, where no app is registered. |

## Step 2.8, passkeys from a native app (TULA-31, [ADR 0027](../adr/0027-passkeys.md#native-apps-added-2026-10-09-tula-31))

The rule (`Passkeys.relyingParty`), the verifier and every route that accepts a passkey
response are unit-tested with a software authenticator; scenarios 92 to 95 run in process
and under the event canary. **No passkey ceremony was run on a device or an emulator; the
Android origin string and the iOS origin are from the platforms' documentation**, and the
iOS one from less than that. Not verified:

| What | How far it was taken |
| --- | --- |
| **The origin an Android app's response carries** | Read from Google's "Create passkeys" page (`android:apk-key-hash:` and the certificate's SHA-256 as base64url without padding). The encoding is tested against values computed with the Python lines of that page, outside the code. No Credential Manager response was looked at: a different spelling from a real device (padding, standard base64) would be refused, as `auth.invalid_credentials` or `passkey.registration_failed`. |
| **The origin an iOS app's response carries** | **Not confirmed by any Apple page.** "Supporting passkeys" says the relying party is the domain and that a `webcredentials` associated domain is needed, and nothing about the client data's origin. `https://<rpId>` is from developers' reports (Apple's forums, third-party guides) and from what the WebAuthn origin of that id would be. Two forum threads that were opened did not state it. No `ASAuthorization` response was looked at. |
| **That a platform runs the ceremony at all with the files as served** | Nothing. Whether Android accepts `get_login_creds` as a statement's only relation and Apple the `webcredentials` section alone is still as ADR 0040 left it: stated, not proven. |
| **Play App Signing, several certificates, key rotation** | Reasoned from the documentation ("accept all the origins as valid"): one origin per registered fingerprint. Which certificate Credential Manager hashes for an app with a rotated key (the current signer, or the oldest in its lineage) was not found in the documentation and not tried. |
| **A browser on Android or iOS** | Assumed to be a browser to this server: it sends the page's `Origin` and writes the page's origin (Google's "privileged apps" page says so for Android). Not tried on a device. |
| **That a browser always sends `Origin` on the ceremony routes** | The argument that a page cannot pass as a native app rests on it: every route that starts or finishes a ceremony is a `POST`, and the Fetch standard has a browser send `Origin` with every `POST`. Not tried in a browser for this work; the browser tests send it and were not run here. |
| **Scenarios 92 to 95 against a live server** | In process only, as part of `bun run verify`. They need no receiver, inbox or clock and should run against a packaged stack; they were not. Through one address in front of two instances they depend, like every scenario that changes settings, on `CONFORMANCE_SETTLE_MS`. |
| **A scenario that fails half way** | A cleanup stops at its first failed step. The settings are restored first; an app the scenario registered can be left behind in the environment if the restore fails. |
| **The read of an environment's apps on PostgreSQL** | `bun run test:integration` was not run in this work. A native passkey step makes one `nativeApps.list`; its cost on a real server was not measured. |
| **The native SDKs** | None existed when this was written. `@tula/core` asks a browser's `navigator.credentials` and cannot make a native response; the four scenarios are `SERVER_ONLY` in `sdk-journeys.test.ts`. Since TULA-56 the Swift client has journeys for the iOS half of them, with a software authenticator behind its passkey sheet and no device ("Step 2.14, the Swift client: passkeys, providers, a device key", below); Kotlin has none. |
| **That allowing `https://<rpId>` is what an iOS app needs** | The rule added in review (an iOS app's origin is accepted only where the environment allows it as a page's) rests on the same unconfirmed string: if Apple's API writes something else, allowing the origin does nothing for an app and still lets the page use the client API. Shown with a software authenticator only. |
| **`tula doctor`** | `native_app_passkeys` gained one finding (an iOS app, passkeys on, the relying party's own origin not allowed), unit-tested on memory adapters and in the enumeration of every answer's length; not run against a deployment. It reads the settings through the cache, so it can lag a change by the cache's 5 to 30 seconds. None of the three says that an environment with passkeys on has apps of one platform only, or that a registered fingerprint is the one a build is signed with: neither can be known from the server. |

## Native Google sign-in (TULA-33, [ADR 0045](../adr/0045-native-id-token-exchange.md))

The exchange is tested against the mock provider, whose tokens are sealed by the server
and not signed by Google. What ADR 0045 lists under "What could not be verified", in its
words:

| What | State |
| --- | --- |
| **Anything against Google** | Which client ID is `aud` and which is `azp` on Android and on iOS, how the nonce arrives, and whether Google's keys endpoint behaves under the verifier's deadline as the code flow's tests assume. |
| **`email_verified` in a native token** | That it is always a JSON boolean (the code flow has taken it so since ADR 0026). |
| **The console steps in `docs/providers/google.md`** | Written from the documentation, not clicked through. |
| **Through `@tula/expo`** | `signIn.withIdToken` is `@tula/core`'s and is on the client the package builds; its four journeys run for that client against the API in process with the mock's tokens. No Google sheet is wrapped and none was opened; no token Google signed was exchanged; nothing ran in Expo Go, a simulator or on a device (TULA-55). *Since TULA-55 the package has a hook and an adapter for a Google sheet; the sheet was still never shown: the section "Step 2.13, native Google and Apple, and a device key" below.* |

## Step 2.9, native Sign in with Apple (TULA-47, [ADR 0047](../adr/0047-native-apple-sign-in.md))

The adapter's `verifyIdToken` is unit-tested with tokens the tests sign with their own RSA
keys, published through a stubbed `fetch` (`adapters/oauth/apple-id-token.test.ts`); the
whole sign-in with the mock provider's Apple-shaped tokens (`modules/flow/apple-id-token.test.ts`,
scenarios 104 to 107 in process and under the event canary, and their `@tula/core`
and `@tula/expo` journeys). **No token Apple signed was ever verified, no request went to Apple from a
test, and no iOS app, device or simulator was involved.** Real Apple is unverified:

| What | How far it was taken |
| --- | --- |
| **A real Apple identity token from the native sheet** | Nothing. Apple's documentation, its discovery document and its key set were read on 2026-10-10 (the last two fetched by hand, once): the issuer, `RS256`, the keys' address and the claims' names and types are from them. |
| **That a native token's `aud` is the app's bundle ID** | Inferred from two documented sentences (`aud` is the `client_id`; the `client_id` is the App ID or Services ID without the team prefix) and from every third-party guide. Not stated by Apple in one sentence, and not observed. If it is anything else (the full App ID with the team prefix, for one), **every native Apple sign-in is refused** with `auth.invalid_credentials`. |
| **That Apple echoes the request's nonce unchanged** | Documented ("a string value to pass to the identity provider"); not observed. The server accepts only the lowercase hexadecimal SHA-256 of its nonce, which is **a convention of other backends and not Apple's**: an app that passes the raw nonce, or a library that hashes a second time, is refused. Which of the common React Native and Expo libraries hash by themselves was not checked. |
| **`nonce_supported`** | Read as documented (a Boolean; the string is refused too). What a real token carries on which system versions was not seen. A token with `false` is refused; one without the claim is accepted when its nonce matches. |
| **`email_verified` and `is_private_email` in a native token** | Documented as "a string or Boolean". The address is verified for `true` and `"true"`, as the web flow has read it since ADR 0026. `is_private_email` is read by nothing. |
| **Whether a later token carries the address** | Apple's page says it does; third parties report that it sometimes does not. Both are handled (a known account signs in either way) and neither was observed. |
| **The name** | That the sheet gives `fullName` on the first authorization only, and that the token never has one, is documented. The app's side (reading `fullName`, sending it) did not exist when this was written. Since TULA-56 the Swift client's `SystemAppleSheet` reads it and `signInWithApple()` sends it; that adapter has never been handed a real credential. |
| **Apple's keys endpoint under the verifier's deadline, and a key rotation** | A stubbed `fetch`: a failing request, a status that is not 200, a body that is no key set, no answer in time, an unknown `kid`. |
| **The Swift lines in `docs/providers/apple.md`** | Written from the AuthenticationServices and CryptoKit references. **Not compiled and not run.** |
| **The console steps** (an App ID with Sign in with Apple, grouping a Services ID with it) | From Apple's documentation, not clicked through; the repository has no Apple developer account. |
| **One user across the web flow and an app** | That `sub` is per developer team is documented. A Services ID and an app of one team giving the same `sub` was not observed; with two teams they are two accounts here, which the docs say. |
| **Scenarios 104 to 107 against a live server** | In process only, as part of `bun run verify`. They need the mock provider and a secret key, change no environment setting, and should run in CI's `self-host` jobs; that run was not made here. Each registers an iOS app and removes it in its cleanup: a run that fails half way can leave the app (or Apple's credentials) behind, and the next run of scenario 104 then does not see "no iOS app". |
| **The read of an environment's apps on PostgreSQL** | `bun run test:integration` was not run. The start and the exchange each make one `nativeApps.list`. |
| **The dashboard's two changed sentences in a browser** | Component tests hold the words. The `dashboard` Playwright project was run once for this change, before develop (the Expo SDK) was merged into the branch (48 passed, 1 skipped), and not again after; nothing in it opens the registration question for an environment with Apple enabled. |
| **An environment that already had an iOS app and Apple enabled** | Reasoned: after this change it accepts identity tokens for that bundle ID with no new act by its operator (ADR 0047, "Accepted risks"). No deployment was upgraded. |
| **Through `@tula/expo`** | `signIn.withIdToken` is `@tula/core`'s and is on the client the package builds; the four Apple journeys run for that client (an `ios` client, the name passed beside the token) against the API in process with the mock's tokens. The package wraps no Apple sheet and does not hash the nonce: an app does both, with a library of its own choosing that nobody here ran. Nothing ran in Expo Go, a simulator or on a device (TULA-55). *Since TULA-55 the package has an adapter for Apple's sheet and hashes the nonce itself; the sheet was still never shown: the section "Step 2.13, native Google and Apple, and a device key" below.* |
| **The native SDKs** | Swift and Kotlin did not exist when this was written. `@tula/core` passes the nonce and the name through and does not hash. Since TULA-56 the Swift client hashes the nonce for Apple's sheet and its four Apple journeys pass against the mock's tokens; no token of Apple's was ever seen by it. |

## Step 2.13, `@tula/expo` (TULA-36, [ADR 0046](../adr/0046-expo-sdk.md))

The package is unit-tested under Bun with a stand-in for `expo-secure-store`, and its
journeys run against the real API in process. On 2026-10-10 the example app was copied
out of the repository and, on Expo 57.0.27, `expo-secure-store` 57.0.4, React Native 0.86.3
and React 19.2.3: installed with the packed `@tula/{contract,core,expo}`, type-checked
against the real declarations (`tsc --noEmit`, no error) and bundled by Metro for iOS and
Android (`expo export`: 595 and 593 modules). On 2026-10-12, on one Mac, the app as it
then was (with its setup screen, `react-native-passkey` and `expo-web-browser`) was
installed from the packed packages, type-checked the same way (no error) and bundled
again (607 and 605 modules); `pod install` succeeded (CocoaPods 1.17.0) and the iOS build
failed under Xcode 16.4 (the row "A development or release build" below). **The app was
never started: not in Expo Go, not in a simulator or an emulator, not on a device.** The
ticket's "the basic path works in Expo Go" is therefore **not shown**. Not verified:

| What | How far it was taken |
| --- | --- |
| **The app in Expo Go, on the iOS simulator, an Android emulator or a phone** | Not run. No screen of the example has been seen; no sign-up, sign-in or refresh was made from a JavaScript engine of React Native (Hermes). Bundling shows that every import resolves and compiles, not that anything runs. |
| **A value in a real Keychain or Keystore** | Nothing. The adapter was tested against a fake with `expo-secure-store`'s three functions and two constants, written from the package's declarations (57.0.4, `build/SecureStore.d.ts`). That a read returns what a write stored, across an app restart, on either platform, was not observed. |
| **The Keychain classes** | `WHEN_UNLOCKED_THIS_DEVICE_ONLY` and `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` are passed as the module's own constants. That an entry is not synced and not in a backup, and that a read while the phone is locked rejects (rather than resolving `null`, which the client would read as "no session"), is from Apple's and Expo's documentation only. **If a locked read resolves `null`, a locked phone looks signed out to the app** until it is started again (a client reads the store once): this is the item most worth a device. What the client does with such a read is tested with a store that answers nothing (no request, the entry left alone, the next start signed in); which of the two a phone does is not known. |
| **A refused write after a refresh** | The adapter tries a write three times (after 50 ms and 200 ms) and, when all three fail, offers the value twice more by itself (1 s and 5 s later). Whether a real Keychain or Keystore ever refuses a write that it takes a moment later, and whether any of those four waits is the right one, was not observed: the numbers are a guess at "a store that is busy", not a measurement. That a timer of 5 s set by a React Native app fires while the app is in the background was not observed either (the tests move time by hand); if it does not, the later tries happen when the app is in front again or not at all. A later try that is already inside the store when a newer write is asked is not recalled, and the adapter adds nothing: which of two `setItemAsync` calls in flight a Keychain or a Keystore completes last was not observed, and the test of it pins the fake store's order (the held call last, so the older token stays until the next refresh). After a sign-out in that position the adapter deletes the entry once more; that a delete issued right after a late write is completed after it on a device was not observed either. When all three fail the store holds a token the server has replaced; an app ended then and started after the grace window is signed out by the server (`session.reuse_detected`). That path is tested against the real API in process with a fake store, and never happened on a device. |
| **What `expo-secure-store` rejects with** | The adapter treats every rejection alike and keeps no message of it. The errors a real store raises (a full Keychain, a Keystore key lost after a screen-lock change on Android, which Expo documents as making values unreadable) were not provoked. |
| **The 2,048-byte limit** | Taken from the module's documentation ("some iOS releases"). The adapter refuses a larger value itself; no real store was given one. |
| **The secure-store key encoding** | Unit-tested for being one to one and inside the documented key grammar (`[A-Za-z0-9._-]`). No real store was given such a key; a length limit of a key, if one exists, is not documented and was not looked for. |
| **React Native's `fetch`, `AbortSignal`, `URL` and timers** | `@tula/core` is checked against web platform types and run under Bun. React Native's own `fetch` (its handling of an aborted request, of a redirect, of `Set-Cookie` on a native client) and Hermes' `URL` were not exercised. The journeys run with the DOM's globals removed, which shows no dependence on `window`, `document` or web storage, not that Hermes has everything else. |
| **`TextEncoder`, `crypto.getRandomValues`, `crypto.subtle` in Hermes** | The package's own code uses none (it encodes UTF-8 itself). Whether a path of `@tula/core` this version reaches needs one that Hermes lacks was not checked on an engine; device binding, which needs `crypto.subtle`, is not offered. |
| **Offline and backgrounding on a phone** | "A session is kept through a failed refresh" and "concurrent refreshes share one flight" are the behaviours of the client-journey list, shown with a `fetch` that fails or stalls. Airplane mode, a suspended app whose timers stop, and a request cut by the system when the app is backgrounded were not staged. |
| **A reinstall on iOS** | A Keychain entry can outlive the app. The documented behaviour (the token is refreshed like any other) is reasoned, not observed. |
| **Other Expo SDKs** | Only SDK 57 was installed. The peer range `expo-secure-store >=57.0.0` admits later majors nobody ran; SDK 56 and earlier are outside it and were not tried. |
| **React Native 0.87** | With `react-native` 0.87.1 (the registry's `latest` on the day) the same app failed to bundle under Expo 57 (`Cannot find module 'react-native/rn-get-polyfills'`), which is Expo's pin being enforced, not a fault of this package. Recorded so that nobody reads "React Native `*`" in the peer range as tested. |
| **The example's setup screen, and its "Still trying" line** | Added after the install, `tsc` and bundle of 2026-10-10; those three were run again with it on 2026-10-12 and passed. What decides the first screen (`app/src/setup.ts`) is tested without Expo; the screen was not drawn, and that Expo leaves `process.env.EXPO_PUBLIC_…` `undefined` for a variable `.env.local` does not set (rather than failing the bundle) is from Expo's documentation. |
| **The example against React Native's real types, in CI** | Twice, by hand, as above. Expo SDK 57 pins TypeScript `~6.0.3` and the example asks for `^5.9.0`: the typecheck passed, and the pin was left. What every `verify` runs is the app's sources against `@tula/expo`'s sources and `examples/expo/shims.d.ts`, which declares the handful of React Native members the app uses and can drift from the real ones. |
| **The published package installed from a registry** | Nothing is published. The app installs the packed tarballs with `overrides` for the nested `@tula/core` and `@tula/contract`; `publint` and `attw` pass on the tarball (`bun run packages:check`). An install by npm, yarn or pnpm, and Expo's own `expo install` and `expo-doctor` on an app with the package, were not run. |
| **A development or release build** (`expo prebuild`, EAS, Xcode, Gradle) | **Tried for iOS on 2026-10-12 and not completed.** `bunx expo run:ios` in the example wrote `ios/` and `pod install` succeeded (CocoaPods 1.17.0; the generated Podfile and the JSI build script call `node`, which has to be on `PATH`). The build then failed under Xcode 16.4 (Swift 6.1.2) in the phase `[CP-User] Build ExpoModulesJSI xcframework`: `package 'apple' is using Swift tools version 6.2.0 but the installed version is 6.1.0`. `expo-modules-jsi` 57.1.2 is compiled from source (its `apple/Package.swift` declares Swift tools 6.2; the xcframework in the npm package is a stub), so the build needs Swift 6.2, which Xcode 26 is said to ship; Xcode 26 was not tried. Nothing for Android (no Gradle run), no EAS, no release build. iOS's refusal of plain `http` in a release build, mentioned in the docs, is Apple's documented default and was not observed. |
| **The texted code, the second step and the password reset through the hooks, on a screen** | The hooks are tested in happy-dom with React's DOM renderer, and the flows as journeys. The example app has screens for sign-up, password and emailed-code sign-in and the signed-in state only; nothing was drawn for the rest. |
| **Accessibility of the example's screens** | Labels and roles are set from React Native's documented props; VoiceOver and TalkBack were not run. |

## Step 2.12, `tula dev --tunnel` (TULA-21, [ADR 0049](../adr/0049-dev-tunnel.md))

**No tunnel was opened, and nothing was reached from a phone.** The command is unit-tested
on a fake host (a fake Docker and a fake `tailscale`); the API's refusal of a request that
does not name this machine is tested in process. On 2026-10-12, by hand: `docker compose
config --format json` on a copy of the scaffold's Compose file (Docker Compose 5.5.1), with
and without `TULA_PUBLIC_URL` in the process's environment, which showed that the variable
reaches the API's `PUBLIC_URL` and that the process's environment wins over `.env`; and, of
the Tailscale client installed on the machine (1.102.2), `tailscale version`, `tailscale
funnel --help` and `tailscale funnel status --json` (which printed `{}`: nothing was
served). Opening a funnel would have used a sign-in that was not given for this work and
put a port of the machine on the internet, so it was not done. Not verified:

| What | How far it was taken |
| --- | --- |
| **`tula dev --tunnel` against a real stack and a real Tailscale client** | Not run. Every argument vector the command builds is asserted in tests; none was ever given to `tailscale`. |
| **That `tailscale funnel --bg --yes --https=443 [--set-path=…] <target>` is accepted as written** | The flags are in `tailscale funnel --help` of 1.102.2. The command was not run with them. |
| **The shape of `tailscale funnel status --json` with something served** | Only `{}` was seen. The fields the adapter reads (`TCP`, `Web["<host>:443"].Handlers[<path>].Proxy`, `AllowFunnel`) are from Tailscale's source (`ipn.ServeConfig`), not from an output. An output the adapter cannot read is "no address in time", with the tunnel it opened closed again; it is never taken for an address. |
| **That the tunnel keeps the `Host` header** | Read in Tailscale's source (`ipn/ipnlocal/serve.go`, `main`), not observed. It is what makes the development-only routes refuse a request through a tunnel a developer opens by hand; `tula dev --tunnel` does not rest on it (it refuses to start beside the mock provider or the development inbox). |
| **That a path mounted with `--set-path` reaches the target's own path** | Read in the same source. So that `https://<name>/.well-known/apple-app-site-association` answers the development environment's file was not seen. |
| **That Apple or Android fetch the two files through the tunnel** | Not tried, and not claimed: Apple fetches through its own CDN, and neither platform was asked. |
| **What `tailscale funnel` does on a tailnet where Funnel, MagicDNS or HTTPS certificates are not switched on** | Not seen. The command's timeout (90 seconds) ends a tool that waits for an answer at a terminal, and the fixed words say what a tailnet needs; whether the tool prints something more useful first is not known. |
| **That `tailscale funnel --yes --https=443 off` removes every handler of the port and nothing else** | Read in the source (`cmd/tailscale/cli/serve_v2.go`). The command is only ever built for a port whose every handler is this project's. |
| **An interrupt at a real terminal (Ctrl-C: `SIGINT`; `kill`: `SIGTERM`; a closed window: `SIGHUP`) during `tula dev --tunnel`** | Not tried. The command's reaction is tested on a fake host, and the real host's listener and its `shielded` spawn with signals the test process sends itself (`process.emit`). That a `detached` child really is outside the terminal's foreground group and survives the terminal's own Ctrl-C, and what Docker Compose does with the same Ctrl-C, was not observed. |
| **What a `SIGKILL`, a `SIGQUIT`, a crash or a power loss leaves** | By design the tunnel stays open and `TULA_TUNNEL_TARGET` stays in the block; that `tula dev down` then closes a real funnel by it was not run. |
| **That `docker compose stop api` before the tunnel is opened leaves no moment where the address reaches an earlier API** | The order of the commands is asserted on the fake host. No real container was stopped, and a container Docker restarts by policy was not tried. |
| **That the tunnel survives a restart of the machine or of the Tailscale client, and what the block of `.env.local` then says** | Not tried. A run reads the status before it trusts the block. |
| **A passkey, an app link or a native sign-in on a device through the address** | Nothing. The command prints the settings to write (`passkeys.rpId`, the allowed origin, the redirect URLs); none was saved under a tunnel's address and no device used one. |
| **Tailscale's limits** | "Non-configurable bandwidth limits" are stated and not numbered; whether Funnel is in the free plan's feature table was not readable (the Funnel page says "all plans"). |
| **The API started by a real `docker compose up` under a public `PUBLIC_URL`** | `env.ts`'s refusal of the mock provider and the development inbox there is its own unit tests'; the packaged image was not started that way. |
| **The live conformance run after the consent page's `Host` check** | Not run (the integration tests were out of scope for this change). The browser tests were run on the first version of this change (the `chromium` and `nextjs` Playwright projects: 137 passed, 8 skipped), so the check holds in a real browser; they were not run again after the later changes, which are the CLI's alone. A browser and the conformance runner send the loopback `Host` of the address they were given, and the Compose proxy passes it on (`proxy_set_header Host $host`); the in-process suites, which hand the app a request with no `Host`, were run and say so through `~/testing/local-host`. |

## Step 2.13, passkeys and provider sign-in in `@tula/expo` (TULA-48, [ADR 0048](../adr/0048-expo-passkeys-and-providers.md))

Unit-tested under Bun with a stand-in for the passkey sheet and for the browser session,
and run as journeys against the real API in process, with a software authenticator behind
the sheet and the journey itself as the browser. **Neither native module was installed for that
work** (both were, in the example, on 2026-10-12: the row "The example app with the two
modules" below).
No passkey sheet and no system browser was opened, on any platform; nothing ran in Expo Go,
a simulator, an emulator or on a device.** The ticket's "work through the platform's
passkey sheet" and "opens an authentication session in the system browser" are therefore
**shown in tests only**. Not verified:

| What | How far it was taken |
| --- | --- |
| **A physical passkey on a device, through the tunnel** | Not done. It needs a public `https` address for the association files (the tunnel of step 2.12), a domain as `passkeys.rpId`, the app registered and built with its Associated Domains or signing certificate, and a phone. None was available. This is the ticket's own open item and stays here until someone does it. |
| **The passkey sheet on iOS** (`ASAuthorizationController` through `react-native-passkey`) | Never opened. That the module takes the server's creation and request options as they are (every member, `excludeCredentials`, `authenticatorSelection`, a `timeout`) and returns a credential `@tula/core`'s check accepts is from the module's declarations (3.6.2) and README only. |
| **The passkey sheet on Android** (Credential Manager through the same module) | Never opened, as above. Whether the JSON Credential Manager returns has every member the check wants (`clientExtensionResults`, `type`, `transports`) was not observed; the adapter fills in a missing `type` and nothing else, so a response without another required member would be `passkey.failed` on every try. |
| **The words `react-native-passkey` rejects with** | Read from the module's tarball (3.6.2), never seen arriving: the objects in `lib/module/PasskeyError.js` (`error: 'UserCancelled'`, `'Interrupted'`, `'TimedOut'`, `'CredentialAlreadyExists'`, `'NotSupported'`, …), the native codes in `ios/PasskeyErrors.swift` and `ios/Passkey.swift` (no `Interrupted` on iOS) and in `android/…/PasskeyModule.kt`. The adapter's table (`FAILURE_NAMES` in `packages/expo/src/adapters.ts`) is those five words. **If a real dismissal arrives as anything else, it is shown as an error (`passkey.failed`) and not as `dismissed`**: a native code the module does not map is rejected as `{ error: 'Native error' }`, one with no code as `{ error: 'Unknown error' }`, and the adapter reads both as a failure. The module's iOS source notes that the system reports "no passkey for this site" with the same code as a cancellation (`ASAuthorizationError.canceled`, 1001) and tries to tell the two apart; which word a user without a passkey gets (`UserCancelled`, so `dismissed`, or `NoCredentials`, so `passkey.failed`) was not observed. This is the item most worth a device. |
| **`Passkey.isSupported()`** | Taken to answer from the OS version without a native round trip, and to be callable in a build that lacks the module's native half (the package catches a throw and reads it as "no passkeys"). Not called anywhere. That importing `react-native-passkey` in Expo Go fails at import rather than at the first call was not tried: the docs tell an app for Expo Go to leave the import out. |
| **The native origin either platform writes** | Unchanged from step 2.8: `android:apk-key-hash:…` from Google's documentation, `https://<rpId>` for iOS from reports and not from Apple. The journeys register an app and use a software authenticator that writes those strings; no response from a platform was looked at. |
| **That the association files, as served, make either platform run a ceremony** | Nothing, as in steps 2.8 and 2.12. |
| **One sheet at a time on the platform** | The package refuses a second request itself. What iOS or Android does with a second request while a sheet is open was not provoked. |
| **A passkey request that never settles** | The package gives the place up after five minutes (`PASSKEY_SHEET_CEILING_MS`, the challenge's lifetime), tested with a promise that never settles and time moved by hand. Whether a real module ever leaves a request unsettled (the app backgrounded with the sheet up, the system dismissing it), whether a timer of five minutes set by a React Native app fires while the app is in the background (if not, the place is freed when the app is in front again, or not until then), and what a platform does when a new sheet is asked for while the abandoned one is somehow still on screen, were not observed. |
| **That a platform returns the redirect URL character for character** | **Not observed, and the package depends on it.** A returned URL is read only when the part before `#` equals the redirect URL that was asked for, exactly. Whether `ASWebAuthenticationSession` and Android's `Linking` hand a custom-scheme URL back in the form it was redirected to (`com.example.app:/oauth/callback`, not `com.example.app:///oauth/callback` or with a trailing slash), and an `https` app link with its host's case and its path untouched, is from nothing but reading. **A platform that normalises turns every real provider sign-in into `refused: unexpected_return`**, with no request made. Any tolerance is a decision for ADR 0048 (another app can register the same scheme), not a fix. |
| **The system browser round trip on iOS** (`ASWebAuthenticationSession` through `expo-web-browser` 57.0.3) | Never opened. That a `303` from the API's callback to `com.example.app:/oauth/callback#tula_ticket=…` ends the session with `{ type: 'success', url }` **and that the URL still has its fragment** is from the module's sources and Apple's documentation. Without the fragment every sign-in ends as `refused` (`no_answer`). |
| **The system browser round trip on Android** (a Custom Tab, `AppState` and `Linking`) | Never opened. The polyfill resolves with the first URL that starts with the redirect URL; whether a Custom Tab follows a `303` to a custom scheme into the app at all (Chrome is reported to want a user gesture for some of them), and whether the fragment arrives, was not observed. |
| **An `https` app link as the return** | `preferUniversalLinks` (iOS 17.4 and later) is set from the module's declaration; that iOS then hands the callback to the session, and what iOS before 17.4 does with the option, was not observed. On Android, whether a redirect inside a Custom Tab to a verified app link opens the app, or stays in the tab as a page, was not observed: Chrome is documented to keep some same-tab navigations in the browser. **An app link return may not work on Android at all**; the docs say the custom scheme is the likelier path. |
| **A closed browser** | The four result types that are not a success (`cancel`, `dismiss`, `opened`, `locked`) are from the module's declarations. Which one each platform gives when the user closes the tab, and that `locked` (a session already open) is safely "nothing happened", was not observed. |
| **Another app registering the same custom scheme** | Nothing on a device. The design's answer is that a ticket completes nothing without the binding, which only this client's memory holds; that is tested (a returned URL with a ticket and no binding makes no request). What the platforms do when two apps claim one scheme is theirs. |
| **The binding across the app being suspended** | The binding is in the JavaScript heap. That iOS and Android keep the process alive while the browser session is in front, long enough for a provider's page and a second factor there, was not observed; where the process is ended, the round trip is lost and the user starts again (stated in the docs). |
| **The mock provider through a phone's browser** | Not possible as built: the mock's consent page is served on a loopback address only. The journeys call the callback as the browser would. A provider sign-in from a device needs a real provider's credentials, which were not used. |
| **A real provider** | None. Every provider's journey runs against the mock, as for the browser SDKs. |
| **The two modules' real declarations** | `packages/expo/src/native-modules.d.ts` declares the members the adapters call, copied by hand from `expo-web-browser` 57.0.3 and `react-native-passkey` 3.6.2. No compiler has compared them with the installed packages; a difference shows only when an app compiles. |
| **The example app with the two modules** | `examples/expo/app` gained `src/ways.tsx`, two dependencies and a `scheme`. It is compiled by the repository against `@tula/expo`'s sources and the shim. On 2026-10-12 the install with both modules, `tsc` against the real declarations and the Metro bundle for each platform were run and passed; a development build (`expo run:ios`, `expo run:android`: the app no longer runs in Expo Go as it is) was tried for iOS only and **did not complete** (the first section's row "A development or release build"), so the app with the modules has never been launched. That `scheme` in `app.json` is all a development build needs to receive `com.example.tula:/…` is from Expo's documentation. |
| **The built entry points under Metro** | `bun run packages:check` builds `dist/passkeys.js` and `dist/browser.js` and `package.test.ts` checks what each imports. That Metro resolves the `exports` subpaths `@tula/expo/passkeys` and `@tula/expo/browser` (Metro is documented to honour package exports by default in the React Native of Expo SDK 57) was not tried by itself: the example, which imports both from the packed package, was bundled by Metro for each platform on 2026-10-12, and nothing of the bundle was loaded. |
| **The emailed link** | Refused before any request, by a test. That a link tapped in a mail app on a phone shows the user something sensible (it opens the web page the environment's redirect URL names, if any) was not looked at; the docs name the code as the way. |
| **Accessibility of the new example controls** | Roles and labels from React Native's documented props; VoiceOver and TalkBack were not run. |
| **The integration tests and the browser tests** | `bun run test:integration` and Playwright were not run for this work (the server's code is unchanged; the shared journeys' file was restructured and both suites that use it pass in process). |

## Steps 2.14 and 2.15, the generated types (TULA-22, [ADR 0050](../adr/0050-native-type-generation.md))

The generator is unit-tested in TypeScript on fixtures and on the real `openapi.json`, with
assertions on the text it emits, and `bun run native:check` (part of `verify`) holds the
committed Swift and Kotlin files to its output. **Nothing in `verify` or in CI compiles
Swift or Kotlin.** On 2026-10-12, by hand, on one Mac (arm64, macOS 26.6), the generated
files **as commit `c35a0fb` has them** were put through the two compilers that were
already on the machine. No later commit of this change touches a generated file
(`bun run native:generate` on each wrote nothing); a commit that does change one is not
covered by what follows until someone compiles again:

- **Swift**: Apple Swift 6.1.2 (`swiftlang-6.1.2.1.2`, from Xcode). `swiftc -typecheck` of
  the five generated files, with `-warnings-as-errors`, in `-swift-version 5` and in
  `-swift-version 6`: no diagnostic. `swift test --package-path native/swift`: 19 XCTest
  tests, 0 failures (`Tests/TulaAuthTests/GeneratedTypesTests.swift`: a flow step of every
  shape the test names, an unknown `status` kept and written back, an unknown enum member,
  an unknown key ignored, a missing required key refused, optional against nullable, the
  error codes, the theme).
- **Kotlin**: kotlinc-jvm 2.3.10 with its serialization compiler plugin, both as bundled
  with Android Studio (no compiler was installed for this), on Java 25.0.4 (Temurin). The
  five generated files compiled with `-Werror` against `kotlinx-serialization-core-jvm` and
  `kotlinx-serialization-json-jvm` 1.9.0, and again against 1.6.3 (the four jars were
  fetched from Maven Central into a scratch directory outside the repository; nothing was
  added to it). A scratch program of 24 checks (the same ground as the Swift tests) passed
  on both versions. That program is **not in the repository**: there is no Gradle build to
  run it.
- The output of the generator for the unit tests' sample document (a keyword as a property,
  an object with no property, an enum member named `unknown`, one that starts with a
  digit, a closed union) was also type-checked by Swift 6.1.2 (Swift 6 mode, warnings as
  errors) and compiled by kotlinc 2.3.10 (`-Werror`, serialization 1.9.0).

Not verified:

| What | How far it was taken |
| --- | --- |
| **That a later change to the generator still compiles** | Nothing automatic. `native:check` compares bytes. A renderer change that emits invalid Swift or Kotlin is green in `verify` until someone runs a compiler. A CI job with a toolchain is TULA-37's and TULA-38's. |
| **Any other Swift compiler** | Only 6.1.2. `Package.swift` says tools version 5.9; no 5.9, 5.10 or 6.0 compiler was run, and none on Linux. |
| **iOS, a simulator, a device, Xcode's build of the package** | Nothing. The tests ran as a macOS command-line test bundle (`arm64e-apple-macos14.0`). The types use Foundation's `JSONDecoder` only, which is the same API on iOS; that is reasoning, not a run. |
| **Any other Kotlin compiler, and K1** | Only 2.3.10 (K2). Kotlin 1.9 and 2.0 to 2.2 were not run; the stated minimum of the serialization library (1.6.3) was compiled by a much newer compiler than its own, never by a contemporary one. |
| **A Gradle build, the Android Gradle Plugin, R8** | None exists. Whether the serializers survive minification without keep rules (the library ships its own rules for `@Serializable` classes; the hand-shaped `KSerializer` objects are referenced from annotations) was not looked at. |
| **Android, ART, an emulator or a device** | Nothing. The checks ran on a desktop JVM (Java 25). API 28's runtime was not involved. |
| **`kotlinx.serialization` between 1.6.3 and 1.9.0, and after** | Two versions. `@EncodeDefault` is experimental in both; a later release that changes it changes the generated files' opt-in. |
| **Every generated type decoding a real answer** | The Swift and Kotlin checks decode hand-written JSON for a flow attempt, a step of several statuses, an error envelope and two request bodies: a handful of the 111 generated declarations, and never a recorded answer of the API. That each generated type decodes what the server really sends is a job for the SDKs' conformance suites (the client-journey list), which do not exist. |
| **A round trip of every request type through the API** | Nothing was sent. That the API accepts what an encoder of these types writes (a key left out for "no value", a constant always written) is from the contract's schemas, by reading. |
| **Kotlin Multiplatform, Kotlin/Native** | Not tried. The files import `kotlinx.serialization` only and nothing of the JVM, which is necessary and not sufficient. |
| **Swift 6 strict concurrency in a consumer** | The generated module type-checks in Swift 6 mode and every type is `Sendable`. No client that uses the types from an actor was compiled against it. |
| **The theme constants on a screen** | They are the contract's CSS strings (`"#5b4cf0"`, `"0.9375rem"`, a font stack, a `rgba(…)`, a two-layer shadow). Nothing parses one into a SwiftUI or Compose value yet, and several have no direct equivalent (`rem`, a CSS font stack, a shadow list): that conversion is hand-written work of 2.14 and 2.15 and may show that a token needs a native form in the contract. *(Swift's is written since TULA-49, `TulaThemeValues.swift`: what it draws and what it refuses is in ADR 0057, and what was not drawn in "Step 2.14, the SwiftUI screens" below. Compose's is not.)* |
| **The names** | `TulaAuth`, the module `tula-auth` and the package `dev.tula.auth.generated` are placeholders until decision D2; no registry, Maven group or Swift package index was checked. |

## Step 2.13, native Google and Apple, and a device key, in `@tula/expo` (TULA-55, [ADR 0052](../adr/0052-expo-native-providers-and-device-keys.md))

Unit-tested under Bun with stand-ins for the three native modules, and run as journeys
against the real API in process, with the mock provider's tokens behind the sheets and a
software key behind the key store's interface. **Nothing of this work was run on a phone, a
simulator, an emulator or in Expo Go. None of the three native modules
(`expo-apple-authentication`, `react-native-nitro-google-signin`,
`@pagopa/io-react-native-crypto`) was installed, imported or called, by the repository or
by the example; no provider's sheet was shown; no key was made, found, used or lost in
secure hardware; the config plugin was never given to Expo.** The ticket's native Google
and Apple sign-in, its "non-exportable key" and its "losing the key (a reinstall)" are
therefore **shown in tests only**. Not verified:

| What | How far it was taken |
| --- | --- |
| **Sign in with Apple's sheet** (`expo-apple-authentication` 57.0.2) | Never shown. That `signInAsync({ requestedScopes, nonce })` puts the given string into the token's `nonce` claim unchanged (the package hands it the SHA-256 it took, and the server compares that), that `identityToken` is the token the server accepts, that `fullName` arrives at the first sign-in only, and that a dismissal rejects with `code: 'ERR_REQUEST_CANCELED'`, are from the module's declarations and sources. A dismissal that arrives as anything else is shown as an error, not as `dismissed`. |
| **Google's sheet** (`react-native-nitro-google-signin` 2.3.0) | Never shown. That `configure({ webClientId, iosClientId, nonce })` followed by `presentExplicitSignIn()` yields an ID token whose audience is the web client id and whose `nonce` is the string given, on both platforms; the three result types; the rejection code `SIGN_IN_CANCELLED`; and `checkPlayServices`: from the module's declarations, README and native sources. **Whether Google's iOS SDK or Credential Manager alters or hashes the nonce was not observed**; if either does, every native Google sign-in is `auth.invalid_credentials`. `noSavedCredentialFound` is read as a dismissal. |
| **That importing `@tula/expo/google` in Expo Go throws** | Read from the module's source (it makes its native object when imported). Not tried. The docs tell an app for Expo Go to leave the import out. |
| **The package's own SHA-256** | Held to WebCrypto's digest and to the server's `appleNonceClaim` under Bun. Not run on Hermes or JavaScriptCore. |
| **A key in secure hardware** (`@pagopa/io-react-native-crypto` 1.2.5) | Never made. That the iOS key is in the Secure Enclave and `WhenUnlockedThisDeviceOnly`, that the Android key is in the Keystore (StrongBox where there is one) and hardware-backed, and that neither can be exported, is from the module's native sources, not from a device. |
| **The module's public key** | The adapter takes a JWK with `kty`, `crv`, `x` and `y`, the coordinates as base64url of 32 bytes without padding, and refuses anything else. Whether `getPublicKeyFixed` writes exactly that on both platforms (padding, base64 instead of base64url, a leading zero byte) was read and not observed. **A different spelling fails every start with `device.key_failed`.** |
| **The module's signature** | Taken to be base64 of a DER ECDSA signature with SHA-256 over the UTF-8 bytes of the string it is given, and converted to the 64 bytes a proof carries. Tested against DER made in the test from WebCrypto signatures (short and high-bit `r` and `s`), verified by the server's own verifier. No signature from a device was ever verified. |
| **The module's words for a failure** | `PUBLIC_KEY_NOT_FOUND`, `KEY_ALREADY_EXISTS`, `WRONG_KEY_CONFIGURATION`, `UNSUPPORTED_DEVICE`, `API_LEVEL_NOT_SUPPORTED`, `KEYSTORE_LOAD_FAILED`, `UNKNOWN_EXCEPTION`: read from the sources, never seen arriving. Two readings carry weight. **"The key is gone" rests on `generate` resolving only after a lookup that answered "no such item"**: if a locked iPhone's Keychain answers that for an item that is there and `generate` then succeeds, a locked phone would be read as a lost key and the user signed out. The adapter asks the lookup twice, at once, before it calls `generate`, and makes nothing unless both said "not found" (tested with a stand-in: twice not found, not found then found, not found then another rejection); **whether a second look ever differs from the first on a device, and so whether this helps at all, was not observed**. And **"this device cannot keep the key" rests on `WRONG_KEY_CONFIGURATION`**: if a device that can keep one answers it for a passing reason, that run signs in unbound where the profile allows it. |
| **Losing the key by a reinstall** | Not done on either platform. On Android an uninstall is documented to remove the app's data and its Keystore keys together, which leaves nothing to find. On iOS a Keychain item may survive an uninstall, the stored token and the key alike; which of them does, for these two modules' items, was not observed. Tested is what the package does for each thing a key store can say (the same key, a new one, another one, none, a rejection). |
| **Reading the server's answer for the mark** | A stored token is marked as bound only when the answer that issued it carries an access token whose `cnf.jkt` is this device's key; the package reads that from a copy of the response (`response.clone().json()`) before the client reads its own. Tested under Bun against the real API in process. **That React Native's `fetch` gives a response that can be cloned and read twice was not run**; where it cannot, nothing is marked: the session works and is refreshed with its proof, but **a lost key is then not noticed when the app starts**, and every refresh is refused by the server (`device.proof_invalid`, which signs nobody out) until the user signs out and in again. That is the outcome the mark exists to prevent, so this is worth a device before anything else here. |
| **A key store call that never settles** | The client's deadline ends the wait (`network.timeout`, nothing sent), tested with promises that never settle. Whether the module ever leaves a call unsettled, and what the native side does with the abandoned call, was not observed. |
| **A locked phone** | That a refresh while the phone is locked is a rejection of the key store (so `storage.failed` or `device.key_failed`, session kept) and not "no such key" is from the Keychain class in the module's source. Not provoked. |
| **A simulator or an emulator** | Not run. Whether the iOS simulator can make the key at all (it has no Secure Enclave), and what the module answers there, was not observed; the package's answer for `WRONG_KEY_CONFIGURATION` is a sign-in that is not bound. |
| **A bound session from a phone against a deployed server** | The journeys run the bound refresh against the API in process, with a software key. Clock skew between a phone and a server (`iat` is the phone's), and the proof's `htu` for a real `PUBLIC_URL`, were not exercised from a device. |
| **The config plugin through Expo** | `withTula` is tested on plain objects. **No prebuild was run**: that `ios.associatedDomains`, `ios.usesAppleSignIn`, `ios.entitlements`, `ios.infoPlist` and `android.intentFilters` as it writes them become the entitlements file, the `Info.plist` and the manifest was read from Expo's documentation. That Expo resolves `@tula/expo/plugin` (an `exports` subpath, `plugin.cjs` under `require`) as a config plugin, and that `app.config.ts` can import it, was not tried. |
| **The Google module's own plugin with the example's configuration** | Not run. That `iosUrlScheme` is the option it wants and that the reversed client id is its value is from its source. |
| **The example app with the three modules** | `examples/expo/app` gained `app.config.ts`, four dependencies, a screen section and three optional variables. It is compiled by the repository against `@tula/expo`'s sources and the shim. **The install, `tsc` against the modules' real declarations, the Metro bundle and a development build were not run for this work**; the version ranges in its `package.json` are the registry's on 2026-10-12 and were not resolved together. |
| **The three modules' real declarations** | `packages/expo/src/native-modules.d.ts` declares the members the adapters call, copied by hand from the tarballs. No compiler has compared them with installed packages. |
| **The built entry points under Metro** | `bun run packages:check` builds `dist/apple.js`, `dist/google.js`, `dist/device-key.js` and the plugin in both formats, and `package.test.ts` checks what each imports. Metro was not run over them. |
| **Accessibility of the new example controls** | Roles and labels from React Native's documented props; VoiceOver and TalkBack were not run. |
| **The integration tests and the browser tests** | `bun run test:integration` and Playwright were not run for this work (the server's code is unchanged). |

## Step 2.13, an emailed link opened in `@tula/expo` (TULA-73, [ADR 0055](../adr/0055-expo-emailed-link.md))

Unit-tested under Bun and run as journeys against the real API in process. The test hands
the package the URL from the email's text, as an operating system would hand an app the
link it was opened with. **No emailed link ever opened an app: not on a phone, not in a
simulator or an emulator, not in Expo Go. No association file was fetched by Apple or
Android for it, no mail app was used, and the example app was not installed, bundled or
built with this change.** The ticket's "an emailed link opened on the device that asked
completes the sign-in in the app" is therefore **shown in tests only**. Not verified:

| What | How far it was taken |
| --- | --- |
| **That the operating system opens the app for the link** | Not tried. It needs the domain's association files to name the app with the link's path (`appLinkPaths`, [ADR 0040](../adr/0040-native-app-identity.md), whose files no platform has fetched either), `applinks:<domain>` on iOS and a verified intent filter on Android (the config plugin's `appLinks`, never run by Expo). |
| **That the app is handed the whole URL, fragment included** | The package reads the link's token from the fragment of the URL it is given. That a universal link on iOS and an app link on Android reach React Native's `Linking` (`getInitialURL`, the `url` event) with the fragment intact was not observed. **If a platform drops the fragment, every link is refused as `no_link`** (the hook resolves `null`: nothing is sent or spent, and the code still works). |
| **That the URL arrives spelled as it was sent** | The package compares the URL with `emailLinkUrl` character for character. Whether a mail app, a mail provider's link rewriting or the platform changes the spelling (the host's case, a trailing slash, percent-encoding, a tracking parameter) was not observed. A changed spelling is refused without a request, by design; how often it happens decides how useful the link is. |
| **Mail apps that open links in a browser of their own** | Not looked at: which do, and whether a universal link is followed from each. There the app is never opened and the link lands on the operator's page; nothing is spent. |
| **Link scanners and click tracking** | A scanner that fetches the link gets the operator's page and never the token (it is in the fragment). A mail provider that wraps links in a redirect of its own was not tried: the fragment survives a redirect in a browser, and whether the platform still treats the redirected address as the app's link was not observed. |
| **How often a phone ends the app while the email is read** | Not measured. When it does, the link opens nothing (no binding and no sign-in are left in the new run of the app), without a request, and the user asks again. This is the cost of keeping the binding and the attempt's secret in memory (ADR 0055), and only a device can say how much it is. |
| **`Linking` in the example** | `examples/expo/app` reads the launch URL once and listens for the `url` event. Compiled against the shim's hand-written declaration of `Linking`, never against React Native's own, and never run: whether the event fires for a link that brings a backgrounded app to the front, on each platform, was not observed. |
| **The device's clock** | The binding is dropped fifteen minutes from when it was written, by the device's clock in either direction. Tested on a fake clock. What a phone's clock does across sleep was not observed. |
| **The zero-length wait inside `@tula/core`** | Opening a link passes through one zero-length timer of the client's runtime (`handleEmailLink({ waitMs: 0 })`). Tested under Bun. Not run on Hermes or JavaScriptCore. |
| **The example app with this change** | It gained an optional variable (`EXPO_PUBLIC_TULA_EMAIL_LINK_URL`), a hook over `Linking`, a button and the plugin's `appLinks`. It is compiled by the repository against `@tula/expo`'s sources and the shim. No install, no `tsc` against real declarations, no Metro bundle, no prebuild and no build was run for it. |
| **Accessibility of the new example controls** | A button and two sentences, with React Native's documented props; VoiceOver and TalkBack were not run. |
| **The integration tests and the browser tests** | `bun run test:integration` and Playwright were not run for this work (the server, `@tula/core` and `@tula/react` are unchanged). |

## Step 2.14, the Swift client (TULA-37, [ADR 0051](../adr/0051-swift-client.md))

The client is tested in Swift, on one Mac, from the command line. **`verify` runs none of
it**: no job of `ci.yml` has a Swift toolchain. What `verify` holds is that the journey
tests the Swift sources declare and the `swift` column of
`conformance/client-journeys.json` agree (`.claude/hooks/swift-journeys.test.ts`), and that
the fixture typechecks. Whether the tests pass is `swift test`, by hand or in the `Swift`
workflow.

Run on 2026-10-12, by hand, on one Mac (arm64, macOS 26.6.2), Apple Swift 6.1.2
(`swiftlang-6.1.2.1.2`, Xcode 16.4, build 16F6), bun 1.4.2:

- `swift test --package-path native/swift`: 132 XCTest tests, 0 failures, as a macOS
  command-line test bundle. 92 of them are unit tests on a fake transport and a fake
  Keychain (19 are the generated types' own, from TULA-22). 40 are the journey target: 39
  tests that drive the client, through a real `URLSession`, against the real API
  (`createApp` on memory adapters) served by `native/swift/fixture/server.ts` on a loopback
  port the tests start themselves, and the guard that runs `fixture/journeys.ts`.
- `swift test --package-path native/swift --enable-code-coverage`, then
  `bun run native/swift/fixture/coverage.ts`: 95.30% of lines and 89.70% of functions of the
  six hand-written sources (thresholds 90% and 85%).
- One mutation, once: with the one repeat of a refresh that got no answer taken out
  (`TulaSession.gotNoAnswer` answering `false`), both `refresh_without_answer` journeys and
  the unit test of the repeat failed. The change was put back.
- The package compiles with strict concurrency checking switched on
  (`StrictConcurrency`) in Swift 5 language mode. Swift 6 language mode was not tried.

Not verified:

| What | How far it was taken |
| --- | --- |
| **iOS, a simulator, a device, Xcode's build of the package** | Nothing. No `xcodebuild`, no iOS SDK build, no app that links the package. That the code compiles for iOS is not shown: `Package.swift` says iOS 16, and the sources use Foundation, `URLSession` and the Security framework, which exist there; that is reasoning, not a build. |
| **A real Keychain** | Never asked. `KeychainTokenStorage`'s logic (update, then add; what each status becomes; that a failure is thrown and never `nil`) is tested on a fake of the internal `KeychainItems`. The four calls into `SecItem*` (`SystemKeychainItems`) have run in no test: a command-line test bundle has no entitlement for the data-protection Keychain (`kSecUseDataProtectionKeychain`), and what the real calls answer there, on macOS or iOS, was not looked at. Whether the attributes are accepted, whether an item written by one build is read by the next, and what a locked device answers are all unobserved. This is the item most worth a device. |
| **The `Swift` workflow** | `.github/workflows/swift.yml` has never run. `macos-15`, the toolchain that image selects, `oven-sh/setup-bun` on a macOS runner, whether `bun install` and the journeys fit the 30 minutes, and whether a loopback server can be started there are all unobserved. The nightly `schedule` runs on the default branch only, which is `main`: until this is released there, nothing runs nightly. |
| **Any other Swift compiler** | Only 6.1.2. `Package.swift` says tools version 5.9; no 5.9, 5.10 or 6.0 compiler was run, and none on Linux (the client imports `Security` only where it can be imported, but no Linux build was tried). |
| **A real server, a real network** | The journeys talk to the API in memory over 127.0.0.1 and plain `http`. No Postgres, no Redis, no TLS, no proxy, no packaged image. App Transport Security, which refuses plain `http` in an app, was not met. `URLSession`'s behaviour on a real loss of network (the journeys' "offline" is a transport that refuses, and a "lost response" one that drops the answer after the server gave it) was not observed. |
| **Time** | The client's clock is a parameter and the journeys move it and the server's together. No test waited for a real access token to expire, and none ran a refresh against a real 8-second silence. |
| **An app's life cycle** | Backgrounding, a refresh while the device is locked, two processes of one app (an extension) sharing a Keychain item, and a reinstall that finds an old item were not tried. "An app restarted" in the journeys is a second client object over the same storage. |
| **The decisions `not_built` rests on** | When this was written 63 scenarios were `not_built` for `swift` (53 under TULA-56, 10 under TULA-60). After TULA-56, 11 are: the 10 texted-code and phone scenarios (TULA-60) and "email link sign-in" (TULA-56), each under the nearest ticket and not one that names its client call. The two passkey scenarios this row said might turn out `not_applicable` did not: the client awaits the app's passkey sheet between an attempt's start and its submit, so both are journeys, with a sheet that switches the method off while it is up and one that answers with an earlier assertion. |

## Step 2.14, the Swift client: passkeys, providers, a device key (TULA-56, [ADR 0051](../adr/0051-swift-client.md))

Everything of the section above still holds: one Mac, the command line, and `verify` runs
no Swift. **Nothing here was run on iOS, in a simulator or on a device. No passkey sheet,
no Sign in with Apple sheet and no browser session was shown, no key was made in or signed
by a Secure Enclave, no Keychain was asked, and no real provider (Apple, Google or any
other) was asked.**

Run on 2026-10-12, by hand, on the same Mac (arm64), Apple Swift 6.1.2 (Xcode 16.4),
bun 1.4.2:

- `swift test --package-path native/swift`: 262 XCTest tests, 0 failures, as a macOS
  command-line test bundle. 170 are unit tests (fakes of the transport, the Keychain, the
  device key store, the three sheets). 92 are the journey target: 91 tests that drive the
  client against the real API in memory on a loopback port, and the guard. Of those, 52
  came with this ticket: 8 of device binding, 10 of the second step and step-up, 19 of a
  provider round trip, 8 of an ID token, 7 of passkeys.
- `swift test --package-path native/swift --enable-code-coverage`, then
  `bun run native/swift/fixture/coverage.ts`: 94.87% of lines and 88.83% of functions of
  the eleven hand-written sources (thresholds 90% and 85%, unchanged).
- Each fix made after the review was seen failing first: the three tests of a key store or
  a key that never answers ended only when the test's own wait gave up (about 5.7 seconds
  each), and passed once the looks and the signing were put inside the call's deadline.
- The run prints `CoreData: error: Failed to create NSXPCConnection` several times, from
  the tests that make AuthenticationServices' objects in a command-line bundle. It was not
  looked into; the tests pass with it.

What stood in for the system in those tests:

| The real thing | What the tests used |
| --- | --- |
| The passkey sheet and an authenticator | `SoftwareSheet` over a software WebAuthn authenticator written in the test target (P-256, `none` attestation, user verification always set), with the origin `https://<rpId>` the server expects of an iOS app (ADR 0027) written by the test. |
| Sign in with Apple | A scripted sheet that asks the fixture for one of the API's mock ID tokens, with the nonce the client handed it. |
| Google's ID token | The same mock, asked by the journey as an app would ask Google's SDK. |
| The browser session | The journey itself: it requests the mock provider's consent page with `URLSession`, follows nothing by itself and hands back the address the API redirected to (or another one, to be refused). |
| The Secure Enclave | `SoftwareDeviceKeyStore` (a CryptoKit P-256 key in memory); in unit tests a fake of the internal `DeviceKeyEnclave` and of `KeychainItems`. |

Not verified:

| What | How far it was taken |
| --- | --- |
| **`SystemPasskeySheet`, `SystemAppleSheet`** | The requests they hand the system are built and read in unit tests (the relying party, the challenge, the user, the excluded and allowed credentials, user verification, the hashed nonce, the scopes), and what a failure of the system becomes is tested for each `ASAuthorizationError` code the adapter reads. **`performRequests()` was never called**: the step that shows the sheet is stood in for. So that the system accepts those requests, shows a sheet, and what its credential objects hold (`rawClientDataJSON`, `rawAttestationObject`, the signature, the user handle, `identityToken`, `fullName`) is unobserved; the code that turns a credential into the API's JSON has run on no credential, which is most of what the coverage figure does not cover in that file. An `ASPresentationAnchor()` is made by the tests and never shown. |
| **The origin of an iOS passkey response** | The journeys' authenticator writes `https://<rpId>` because ADR 0027 says the server expects it. What Apple's API writes was not seen here either, and Apple documents none. The Associated Domains entitlement and the association file were not part of any run. |
| **`SystemBrowserSession`** | What it does with the system's answer (an address, a cancellation, another error, an answer that comes twice, a session that would not start) is tested with the start stood in for. **`ASWebAuthenticationSession.start()` was never called.** The callback forms it asks for (`.https(host:path:)` from iOS 17.4 and macOS 14.4, `.customScheme`) were built on macOS 26 and never matched against a real return; the `provider.unsupported` branch for an app link on an older system was not run on an older system. Whether iOS returns the fragment of an app link to the session, which the exact-return rule needs, is unobserved. |
| **`KeychainDeviceKeyStore` and the Secure Enclave** | Its logic (find, make, store, what each Keychain status becomes, that "cannot tell" is thrown and only "no such item" is `nil`) is tested on fakes. `SecureEnclave.P256.Signing.PrivateKey` was never made; the calls into `SecItem*` for the key's item never ran. That the stored representation opens again after a restart, what a locked device answers, what a restored backup or a new device answers (the case the "key is gone" rule exists for), and whether the enclave's signature is the raw `r‖s` the proof needs are all unobserved. The simulator branch (`#if targetEnvironment(simulator)`: a software key) was never compiled. |
| **The lost-key rule on a device** | Shown with a store whose key was forgotten by the test (`existing()` then answers `nil`), against the real API: the refresh is refused, the client signs out and the server's session is ended. That a real key store ever answers `nil` for a key that is truly gone, and throws for one it cannot reach, is the adapter's untested half above. **The second look narrows the case and does not close it**: the client ends a session only after two looks that both say "no such item", shown on a fake `KeychainItems` (missing then found, missing then an error, missing twice). Whether a real Keychain ever answers "no such item" for an item that is there, once or twice in a row, was not observed; if it does so twice, a session that could have lived is ended. |
| **A key store that stalls** | That a look or a signature that never returns ends the call at its deadline is shown with fakes that never return. Whether `SecItemCopyMatching` or the Secure Enclave ever stalls, and for how long, was not observed. The client asks the store one thing at a time: a look or a making still out is joined, not started again (shown with stores that count: one look across three refreshes that gave up, one making across three starts). So a call that truly never returns is the last the client makes of that kind until the key is removed through the client, and every call that needs the key ends at its deadline meanwhile; whether a real Keychain call that hung ever comes back was not observed. A caller that gave up leaves no task waiting for the store (shown with a fake whose look never returns: the waiter ends when its task is cancelled, with one look out). A removal through the client while a look is out is shown with a fake that answers late with the removed key: the call that had joined ends with `device.key_failed`, the next start looks again and is bound to a new key. A removal that did not answer in time, and one whose caller was cancelled, drop the look as well (shown with a fake whose removal is held past the deadline and then removes, and one that removes and then notices the cancellation); a removal the fake refuses drops nothing. After a drop the call from before it is not stopped, so two calls of a store can run at once: that a stale answer arriving while a newer look is out is given to nobody is shown with a fake that holds both; that `KeychainDeviceKeyStore` ends with one key when two makings overlap is read from its source (`errSecDuplicateItem` returns the stored key) and was not run against a Keychain. A start that already holds the key when `removeDeviceKey()` runs binds its session to the removed key: stated, not defended against. A `remove()` called on the store directly is not seen by the client, and what a real Keychain does with a delete beside a read that is still out was not observed. |
| **A key made after its caller gave up** | A making that answers after the start's deadline has made a key, in the Secure Enclave on a device, with nothing sent. It is not undone: the next start finds and uses it. Not shown beyond the fake that never answers; how long the enclave takes to make a key, against the client's timeout, was not measured. |
| **A stored key that never opens again** | Shown with a fake enclave whose earlier blobs stop opening: every refresh and every later start is `device.key_failed`, the session is kept, **`signOut()` leaves the item**, and the app's `removeDeviceKey()` lets the next sign-in make a new key. `KeychainDeviceKeyStore` calls no failure permanent (`TulaDeviceKeyStoreError.unusable` is thrown for none), because no Keychain status or CryptoKit error is documented to mean it; a sign-out removes a key only for a store that throws that error, shown with a fake, and not when its task is cancelled while the store is being asked (shown with a fake held at a gate). Which error a restored or reset device really gives, whether it differs from a locked device's, and whether the delete is allowed while locked, are unobserved: no device was asked. |
| **An app link with a port** | Refused by `SystemBrowserSession` from reading the redirect URL, with the session's start stood in for. That the system's matcher really ignores a port, a query and a trailing full stop is taken from its API (a host and a path), not from a run. |
| **A real provider** | None. Every provider is the API's mock: its consent page, its codes, its sealed ID tokens (not JWTs; the signature check is the server adapters' own tests'). Apple's and Google's sheets, consoles, client ids and tokens were never involved. |
| **App links and custom schemes** | The redirect URLs of the journeys are strings the environment lists. No app was registered for a scheme or a domain, and the system never routed a return to anything. |
| **Timing of a sheet** | The five-minute ceiling of a ceremony and the one-minute hold of a ticket are tested with a clock the test moves and a short ceiling, not by waiting. |
| **iOS at all** | As above: no `xcodebuild`, no iOS SDK build. That `TulaSystemSheets.swift` compiles for iOS is not shown; it compiles for macOS 13 with Swift 6.1.2, where UIKit's presentation anchor is AppKit's window. *(Since TULA-49 it has been compiled for the iOS simulator, and still never run: "Step 2.14, the SwiftUI screens" below.)* |
| **The `Swift` workflow** | Still never run; with these tests it is longer (about 20 seconds of tests locally, after the build). |
| **What was left out** | An emailed link (no call; ADR 0051, "Not built"), a texted code and a phone number (TULA-60), and the Android halves of the native-app passkey scenarios, which an `ios` client cannot reach. |

## Step 2.14, the SwiftUI screens (TULA-49, [ADR 0057](../adr/0057-swiftui-screens.md))

The screens (`TulaAuthUI`) are tested in two places, both by hand, on one Mac. **`verify`
runs neither.** What `verify` holds is the two scripts' own logic
(`.claude/hooks/swift-journeys.test.ts`: which simulator is picked, the `xcodebuild`
arguments, that every process has a timeout, that the fixture keeps its guard, what the
coverage check counts) and that the fixture typechecks.

**This is the first time anything of the package ran on iOS, and it was a simulator. No
device was used. VoiceOver was never turned on.**

Run on 2026-10-12, by hand, on one Mac (arm64, macOS 26.6.2), Xcode 16.4 (build 16F6),
Apple Swift 6.1.2, bun 1.4.2:

- `swift test --package-path native/swift`: 330 XCTest tests, 0 failures, as a macOS
  command-line test bundle. 53 of them are the new target `TulaAuthUITests`: 35 of the
  model (the real client on a transport that is a table of answers, tokens in memory) and
  18 of the strings and the theme. **None makes a view**: no SwiftUI `body` ran in them.
- `swift test --package-path native/swift --enable-code-coverage`, then
  `bun run native/swift/fixture/coverage.ts`: `TulaAuth` 95.53% of lines and 90.27% of
  functions (its figures moved from one run to the next: lines between 95.42% and 95.53%,
  functions between 90.05% and 90.27%);
  `TulaAuthUI` 97.38% of lines and 97.97% of functions, over the three files
  directly in `Sources/TulaAuthUI` (thresholds 90% and 85%, unchanged, each library
  alone). **The two files of `Sources/TulaAuthUI/Views` are not counted**, by decision
  (ADR 0057, "Coverage counts what decides"): no figure says how much of the views the
  simulator run drew.
- `bun run native/swift/fixture/ui-tests.ts`: `xcodebuild test` of
  `examples/swiftui/TulaExample.xcodeproj`, scheme `TulaExample`, on the simulator
  **iPhone 16, iOS 18.5** (the script's own pick), one test at a time. The ten tests of
  `TulaExampleUITests/AuthScreensUITests` passed:
  `Executed 10 tests, with 0 failures (0 unexpected) in 189.063 (189.065) seconds`,
  `** TEST SUCCEEDED **`. They are: a sign-up that proves its address and signs in, then a
  sign-out; a sign-in with a password; a wrong password said at the field; a sign-in with
  an emailed code beside a password; one where the code is the only way; a password reset;
  a step with no screen (a required second factor's enrolment) shown as "not supported";
  a left screen that keeps no password; an empty field said without a request; and the
  screens in the dark scheme. Each test made an API of its own on the fixture
  (`native/swift/fixture/server.ts`: `createApp` on memory adapters, over 127.0.0.1 and
  plain `http`) and read the codes from the emails that API sent.
- The system's accessibility audit (`performAccessibilityAudit`, every audit type) ran on
  each screen those tests reach: the three starts, the password, the emailed code, the
  code of an address, the reset's code and new password, "not supported", and the states
  with a problem under a field; in the dark scheme, the sign-in start (with and without a
  problem), the password (with and without one), the reset's start and the sign-up's.

What that run shows beyond the screens, and no more than this:

- **`TulaAuth` and `TulaAuthUI` compile for the iOS simulator** (arm64, the iOS 18.5 SDK of
  Xcode 16.4, an app with a deployment target of iOS 16), `TulaSystemSheets.swift` and the
  simulator branch of `KeychainDeviceKeyStore` among the sources compiled. Neither was
  built for a device, and neither file's code ran: the example passes no sheet and no key
  store.
- **The client signed in, in an app, in a simulator, with the default
  `KeychainTokenStorage`**, and signed out again. Nothing was asserted about the Keychain:
  no test checked that the write succeeded, read the item back, restarted the app to find
  it, or looked at its attributes; and a simulator's Keychain is not a device's.

Not verified:

| What | How far it was taken |
| --- | --- |
| **A device** | Nothing. One simulator, one iPhone model, one iOS version, one Xcode. No iPad, no other size, no iOS 16 or 17 (the package's floor is iOS 16: the app was built for it and run on 18.5 only). |
| **VoiceOver** | Never turned on, in a simulator or anywhere. What a field is read as is asserted from the accessibility tree (its `label`), that a problem is announced and where the focus is asked to go are asserted on the model with a recording announcer. That VoiceOver reads the announcement, that `AccessibilityFocusState` moves its cursor to the title, and that the reading order is the drawn order were not heard or seen. Switch Control, Voice Control and a hardware keyboard were not tried either. |
| **The accessibility audit's two exclusions** | The audit's handler drops two findings, each for one kind of issue on one kind of element (`Support.swift`, `auditIssues`): "text clipped" on a text field or secure field (reported for a field whose 25-character address is drawn whole in a field 320 points wide, and for no empty field), and the contrast of the last line, "Secured by Tula", in the dark scheme (reported on the password screen after a refused password and passed for the same line and the same two colours, #a9a9b4 on #17171c, 7.6:1 by the WCAG formula, on every other dark screen). **Neither finding was shown to be wrong**: no screen reader, no person with low vision and no second tool looked. They are excluded because the test could not otherwise pass, and the reason is beside each. A real clipping of a field's text at a large text size would now go unreported. |
| **Dynamic Type** | The text sizes are `ScaledMetric` values. No test ran at a text size other than the simulator's default; the largest accessibility sizes, where a form has to scroll and a button's label has to wrap, were not looked at. |
| **Right to left, another language** | The table is English and no other table was drawn. No right-to-left layout was run. |
| **The theme, drawn** | The grammar and every conversion (a colour to channels, a length to points, a font stack to a family) are tested as values. On the simulator only the default theme was drawn, in both schemes. A custom colour, a custom radius, a named font the device lacks and a refused value's fallback were never on a screen. That the Swift grammar equals the contract's is by reading: **no test runs the two against one table of cases**. |
| **The slots** | The four modifiers compile and the default parts are what every test drew. No test replaced a header, a footer, a button style or a field style; that a custom field style keeps the field's label and focus is the design of `TulaAuthFieldConfiguration`, not a run. |
| **Secure fields** | A sign-in's password is typed into the secure field. A new password (the sign-up's and the reset's) is typed after the screens' own "Show password", because the simulator covers a new-password secure field with the system's strong-password suggestion and what a test types there does not reach the field. What a person meets with that suggestion, and AutoFill of a saved password or of an emailed code, were not tried. |
| **An expired password, a passwordless sign-up, a wait** | The screen of an expired password, a sign-up without a password (`signUp.password: 'optional'`), the `rate_limited` wait in words and "Send a new email" are tested on the model against a table of answers. None was reached on the simulator. |
| **A flow left with an answer on its way** | That a late answer signs nobody in is three tests of the model with a transport that is held. On the simulator one test leaves a screen and comes back to an empty field; none leaves while a request is out. |
| **A real server, a real network** | The fixture: the API in memory, loopback, plain `http` (the example's `Info.plist` allows that for the local network only). No TLS, no deployed API, no loss of network. |
| **The `Swift` workflow, and the UI tests anywhere but this Mac** | `swift.yml` has still never run; it now also builds `TulaAuthUI` and holds its coverage. **The simulator run is in no workflow** (ADR 0057): which simulator runtimes a GitHub macOS image has, how long the build takes there, and whether the audit answers the same were not observed. The run above took about three minutes of tests after a build. |
| **Xcode's own run of the tests** | The tests were run through the script. Started from Xcode they have no fixture and fail in set-up, by design (`World.create`); a run from Xcode's test navigator was not attempted. |
| **A crash this run avoids** | With an `async` `setUp` or `tearDown` on the main-actor test class, the test runner ended in `swift_task_dealloc` (Xcode 16.4, iOS 18.5), reported as "TulaExampleUITests-Runner quit unexpectedly". The seam is synchronous for that reason. Why the runtime does that was not found; it is avoided, not understood. |
| **What the screens leave out** | A second step, an enrolment, a passkey, a provider, a texted code and the account's own screens (TULA-60): each is the "not supported" screen here, although the client has calls for the first four. |

## The `device_binding` check of `tula doctor` (TULA-72, [ADR 0043](../adr/0043-device-binding.md#a-deployment-that-cannot-bind-and-a-profile-that-requires-a-key-added-2026-10-12-tula-72))

| Not verified | What was and was not done |
| --- | --- |
| **The check on a real server** | Unit-tested on memory adapters, with a canary (a failing read's text, a profile's name, the value of `PUBLIC_URL`) and every sentence held to 512 characters. Not run against PostgreSQL, not with more than 200 environments on one, and no API was booted with a `PUBLIC_URL` no proof can name (a path with a space, a host with a `~`). |
| **`tula doctor` and `@tula/mcp` showing the row** | Neither was run against a server that reports it. Both print whatever rows the server sends, and no test of either names this one. |
| **A native app in that state** | The two answers of a start (`device.binding_required`, `device.binding_not_supported`) are pinned at `DeviceBinding.atStart` with a software key. No SDK and no device was pointed at such a deployment. |

## Step 2.17, the first proposal: banning a user (TULA-23, [ADR 0053](../adr/0053-proposals.md))

What was run: the unit and route tests of the API on memory adapters and PGlite, the
proposal store's suite in both adapters, `@tula/mcp`'s tests against a fake API and, through
`@tula/cli`, against the real API in process, `tula approve` against the real API in
process, and the conformance scenario in process. Nothing else.

| What | How far it was taken |
| --- | --- |
| **A real MCP client** | **Not connected, to the read-only server or to this one.** The ticket asks for the read-only server to be connected to a real client once, and for a note of how it presents a tool result, before this ships: that was not done (no client was available to the run that built this). So it is not known whether a client shows `structuredContent`, the text, or both; whether a person sees the proposal's `summary` and `nextStep` or only what the model says about them; or whether a client asks before calling a tool whose `readOnlyHint` is `false`. The tests use the MCP SDK's own client in memory, which shows nothing to anybody. **A second try, after the security review:** the Claude Code command line is installed on the machine this was built on. The API was started in process on memory adapters with made-up test keys, on a loopback port, and answered a read with the agent key; starting `claude -p` against it from the agent that built this was refused by that agent's own permissions (it may not start another agent), so nothing was observed. No other client was installed and none was downloaded. What a person runs is below the table. |
| **What a model does with a proposal** | Not observed. The tool's description, the server's instructions and the result's `nextStep` all say that nothing was changed and that a person has to approve. Whether a model then says "I have asked for a ban" and not "I have banned the user" is a property of the model, and no model was run. |
| **Injection** | A test puts an instruction in a user's name and shows that no tool exists for what it asks, and that the most any tool sends is the one `POST` that asks. That is the structure. That a real model, having read such a name, does not *propose* a ban it was told to is not something a test here can show; the person approving is the defence. |
| **A person who approves without reading** | Nothing defends against it, and nothing can. `tula approve --yes` exists. |
| **An assistant with a shell and the secret key on the same machine** | Not defended: it can run `tula approve --yes` or call the admin API. ADR 0053 and `docs/proposals.md` say so; no test pretends otherwise. |
| **The dashboard** | The API keys screen makes and lists an agent key (component tests in happy-dom). It was not opened in a browser, and the `dashboard` Playwright project was not run for it. There is no screen for proposals (TULA-40). |
| **Postgres** | **Run on a real server, 2026-10-12** (PostgreSQL 17 of `docker compose`, the runtime login, migration 0033 applied; `stores.integration.ts` and `races.integration.ts`, 391 tests passing): the proposal store's suite; row-level security (another environment's proposal invisible, and unchanged by a write); the column grants (an `UPDATE` of the operation, the target, the proposer, the expiry or the creation time is `permission denied`); two approvals at once on separate connections (one wins, one entry); an approval at the expiry, refused without waiting beside one in time; an approval against the revocation of its agent key in both orders, and a round that fails unless the revocation is seen waiting behind the approval's `FOR SHARE` lock. **Not run:** two API instances (the races are two pools of one test process, at the store, not two servers through the service and its routes), any PostgreSQL version but that one, and a database that already held proposals when the migration was applied (there is none). |
| **A deployed server, two instances** | The scenario was not run with `bun run conformance` against a live server, nor through the two-instance Compose profile. Two approvals at once are shown at the store, on two pools of a real PostgreSQL (the row above), not by two servers. |
| **A ban whose sessions could not be ended** | The `incomplete` outcome is tested with the session store's read rejecting once after the ban committed, on memory adapters. It was not produced with a real Redis going away between the two steps. |

**Connecting a real client, for a person** (ten minutes; a development environment only):

1. `docker compose up -d`, `bun run db:migrate`, `bun run seed`, `bun run dev`.
2. `bun run api-key:create --environment <the dev environment's id> --kind agent`, and keep the key
   it prints. Keep the secret key **out** of the shell the client is started from.
3. From the repository's root:
   `claude mcp add tula-dev --env TULA_API_URL=http://localhost:3003 --env TULA_AGENT_KEY=<the key> -- bun run packages/cli/src/bin.ts mcp`
4. In `claude`: `/mcp` (is `tula-dev` connected, are its tools listed, which are marked read-only?),
   then ask it to list the users, and then to ban one of them.
5. Write down, here: whether the client asks before `list_users` and before `propose_ban_user`
   (`readOnlyHint` is `true` and `false`); what of a result a person sees (the JSON text, the
   `structuredContent`, or only the model's account); whether `summary` and `nextStep` reach the
   screen; and whether the model says it *asked for* a ban or that it *banned* the user.
6. In another terminal, with the secret key: `bun run tula -- approve <proposal id>`, and read what
   it prints. Then `claude mcp remove tula-dev` and revoke the agent key.
| **Production** | Refused, by a test. The opt-in is TULA-39 and does not exist. |

## Recent outcomes of a hook (TULA-67)

Counts of what a hook's calls came to, by the hour ([ADR 0035](../adr/0035-hooks.md),
"Recent outcomes"). What ran: the store suite on the memory adapter and on PGlite (Postgres
with every migration, as the runtime role), the service's tests against a listener in
process, and the dashboard's browser test, where a real sign-up asks a hook that answers 500
and the screen then shows one failed call and "Last call failed" with its time.

Not verified:

| What | How far it was taken |
| --- | --- |
| **Contention on a count's row under load** | Reasoned, not measured. Calls of one hook and one outcome in one hour update one row; twelve at once are counted right on PGlite. No run against a real Postgres at the ceiling (3,000 calls a minute), and no measurement of what the extra statement adds to a sign-in. |
| **A real Postgres server** | PGlite only. There is no `*.integration.ts` for the counts; the statement is an `INSERT … SELECT … ON CONFLICT DO UPDATE`, which is the same SQL on both. |
| **The dashboard's committed screenshots** | Not regenerated (`bun run e2e:screenshots`): the Hooks screen in `apps/dashboard/docs` is the one from before the counts. |

## Step 2.17, a settings change as an edit to the config file (TULA-24, [ADR 0056](../adr/0056-mcp-settings-config-diff.md))

What was run: `@tula/mcp`'s tests of `draft_settings_change` against a fake API, and one
test through `@tula/cli` against the real API in process on memory adapters (the drafted
provider entries are taken by `@tula/config`'s `parseConfig`, and the server's settings and
providers are the same before and after). Nothing else.

| What | How far it was taken |
| --- | --- |
| **A real MCP client** | Not connected. Whether a client shows `nextStep`, `weakened` and the edits to a person, or only the model's account of them, is not known. |
| **What a model does with the edits** | Not observed. The result is edits by key, not file text: whether a model places them correctly in a real `tula.config.ts` (in the right environment, without dropping the settings the file already has, writing `env('NAME')` and not a value) was not tried with any model. |
| **The edit, applied** | No drafted edit was written into a config file and run through `tula diff` or `tula apply`. That the entries load is tested; that a plan made from them is the change that was asked for is not. |
| **A settings document from another version** | `settings.unreadable` is tested with one made-up value on a fake API. No older or newer API was asked. |
| **Postgres, a deployed server** | Not run against either: the tool makes two `GET`s that the read tools already make. |
