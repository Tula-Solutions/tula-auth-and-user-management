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

### Other runtimes

| What | What was run instead |
| --- | --- |
| `verifyWebhook` on Node, Deno and edge runtimes | Bun, plus `typecheck:portable` (web platform types only: no `Buffer`, no `node:` import). It uses `crypto.subtle`, `TextDecoder`, `atob` and `btoa`. |
| `verifyWebhook` behind a real framework's body handling (Express, Fastify, Next.js route handlers) | Called with the text and with the bytes a `Request` gave. The warning about parsed bodies in [webhooks.md](../webhooks.md) is from how those frameworks are documented to behave, not from running them. |
| `@tula/contract/webhook-signature` in React Native | Not applicable in practice (a signing secret has no place on a device), but the entry point is exported to every consumer of the contract: it references `crypto.subtle`, `atob` and `btoa` only inside its functions, so importing it does not fail where they are missing. Not run there. |
