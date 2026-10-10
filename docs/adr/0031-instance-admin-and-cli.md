# ADR 0031 — The instance admin token, diagnostics, and the CLI (`create-tula`, `tula dev`, `tula doctor`, `tula policy test`)

- Status: accepted
- Date: 2026-10-04

## Context

Step 1.14 of the Phase 1 plan asks for the commands that take someone from nothing to a
running deployment and tell them what is wrong with one: `create-tula`, `tula dev`,
`tula doctor` and `tula policy test`. The plan also says the CLI talks to the API through the
generated admin client and touches the database only in `tula dev`'s bootstrap.

`tula doctor` checks things about a **deployment** (the database, the master key, the mail
relay), not about one environment. Every credential the API had so far belongs to an
environment: a secret key cannot be the credential of a route that reports on the whole
instance, and a deployment that is broken may not be able to resolve a key at all. The plan's
decision 3 already names the credential: an instance admin token, `TULA_ADMIN_TOKEN`, which
the dashboard (step 1.15) will also sign in with.

## Decision

### The instance admin token

- `TULA_ADMIN_TOKEN` is an optional environment variable of the API. **Without it the
  instance routes do not exist**: `/v1/instance/*` answers the same `resource.not_found` as a
  path that was never routed, before anything is counted, so a deployment that has not opted
  in does not advertise the route.
- At boot a value shorter than 32 characters, with fewer than 10 distinct characters, that is
  a block written out twice or more, that has a run of eight characters counting up or down,
  with a space, or that looks like a placeholder (`changeme`, `example`, `your-…`, a keyboard
  row) fails the start. The message never repeats the value. **This is a floor against
  accidents, not a measure of randomness**: no check of one value can tell a random token
  from a chosen one, and a value that passes may still be guessable. What the deployment
  relies on is how the token is made: `openssl rand -hex 32`, or the one `create-tula`
  generates. A generated value fails the check with a probability below one in a million.
- The configuration keeps only the token's SHA-256. `instanceAdmin()`
  (`~/middleware/instance-admin`) hashes what was presented and compares the two digests in
  constant time. A missing, malformed and wrong token get the **same** `auth.invalid_key`
  (401): with a token configured the operator has opted in, and a 401 is what tells them
  their token is wrong.
- Every request is counted per IP before the token is looked at (30 a minute), and the rule
  **refuses** when the limiter cannot count (`service.unavailable`): an uncounted guess at
  this credential is exactly what must not happen. `tula doctor` reports that answer as
  "the store behind the rate limits does not answer".
- The token is never logged, never in an error and never in the OpenAPI document's examples.
  Rotation is: change the variable, restart every instance.
- **CORS treats `/v1/instance/*` exactly like `/v1/admin/*`**: only the deployment's own
  `CORS_ORIGINS` gets a preflight or a readable response, never an origin an environment put
  in its settings. The dashboard (1.15) is a browser app served from a deployment origin; a
  tenant must not be able to make its own origin one that can call the instance routes.

**Threat model.** It is the most powerful credential of a deployment. In this step it
authorizes one thing, `GET /v1/instance/diagnostics`, which changes nothing and whose text is
fixed; from step 1.15 it will be exchanged for a dashboard session that manages projects,
environments and keys. So it is treated like the master key from the start: generated, never
defaulted, compared in constant time, rate limited, sent only over TLS or to this machine
(the client refuses plain http to another host), and absent unless the operator sets it.
It is not a secret key because a secret key is one environment's, is stored in the database
the diagnostics are about, and is what an application server holds; the instance token is the
operator's alone.

### `GET /v1/instance/diagnostics`

One route, one service function (`modules/instance`), one port (`ports/diagnostics.ts`, with a
memory adapter and `adapters/system/diagnostics.ts`). Each check answers
`{ id, status: 'ok' | 'warn' | 'fail' | 'skipped', summary, fix?, values? }` with **fixed
text**: a probe's failure reason goes to the log (`errorReason`) and never into the answer,
because a driver's message can name hosts, users and credentials. Tests seed failing probes
with canary strings and assert none reaches the response. All checks run concurrently, each
cut off after five seconds.

One thing follows another (added 2026-10-09, TULA-35): the fetch of the native apps'
association files asks for what the scan of stored data found, so it starts when the scan
has answered and has five seconds of its own. A run therefore takes at most ten seconds,
inside the 30 a client waits. It is the second thing the server requests over HTTP, and like
the first it is its own `PUBLIC_URL` and nothing else: at most two requests a run
(`NATIVE_APP_FILES_FETCHED`), to the server's own route, for an environment id the server
made, never to a loopback address, never following a redirect, and never to an address an
operator typed (their domain, a relying-party id, an allowed origin). The body is read up to
256 KiB, compared with what was built, and dropped. `PUBLIC_URL` itself holds no user name
and no password (`env.ts` refuses one at boot, with a query and a fragment), so neither
request carries a credential.

A check never reports from a partial read as if it were whole (added 2026-10-09, TULA-35
review). When the native apps of one environment cannot be read, the three native checks
are `skipped` for that run, and that includes a failure already found in an environment
read before it: a malformed app there is not said. That loss is accepted. The other choice
is a `fail` whose count is of some environments and reads as of all, or an `ok` beside it
for a deployment nobody finished looking at. The log still names the malformed row, and the
next run that reads every environment says it.

A scan cut short at `MAX_ENVIRONMENTS_CHECKED` is said first (added 2026-10-09, TULA-35
review). Every answer of the three native checks then begins "Only the first N of M
environments were read; the other K were not." and is never `ok`. It was first written
around the finding ("Only … were looked at. … The other K were not read."), and with every
passkey state present the summary passed the 512 characters `@tula/mcp` keeps of a string:
what was cut was the closing half, the one sentence that keeps a check from claiming more
than it looked at. So it is one sentence, at the start, put there by one function every
answer passes through, and the counts in the findings are not qualified a second time. The
test of the cap builds every answer the checks can give at the largest counts instead of a
chosen few. `master_key`'s own notice predates this and was not changed.

A deadline stops the wait, not the work, and the route may be asked 30 times a minute. So:
the scan of stored secrets is given the deadline as an `AbortSignal` and looks at it before
every environment; it is never started while an earlier scan is still running (a query that
never answers holds one connection, not one per request: the check is then `skipped`); and
callers that arrive while a run is in flight share that run (single flight per process).
Nothing is kept once a run has answered.

| Check | What it can tell | What it cannot |
| --- | --- | --- |
| `database` | The API's role reaches Postgres. | Why not (the reason is in the log). |
| `migrations` | Applied migrations against the ones this build ships: behind (`fail`), ahead (`warn`). | Whether a migration was edited after it was applied. |
| `master_key` | `TULA_MASTER_KEY` opens the active signing key and every provider credential of the 200 oldest environments. With more than 200 it is `warn` and says "the first 200 of N environments": it never reports ok for what it did not open. | Anything about values it does not open: only a count. The environments past the 200th. |
| `smtp` | The relay accepts a connection, a greeting and the credentials. No message is sent. | Deliverability (SPF, DKIM, the relay accepting the sender). |
| `redis` | Redis answers a ping; `skipped` when the deployment runs without it. | |
| `clock` | The API's clock against the database's, measured when the database answers: 5 s warns, 30 s fails. | Skew between API instances (each reports its own). |
| `public_url` | The server fetches its own `PUBLIC_URL/v1/status`, no redirects, no credentials. Only that URL, never one from a request. | A loopback `PUBLIC_URL`: unreachable from inside a container, so it is `skipped` and the CLI checks it from the operator's machine. |
| `oauth_redirect_uris` | Lists the exact redirect URI each enabled provider must have registered. `warn` when `OAUTH_MOCK_PROVIDER` is on. | Whether the provider has it: that cannot be verified remotely, so the status is `skipped` with the values. |
| `webhook_worker` (added 2026-10-08, TULA-52, [ADR 0034](0034-webhooks.md#the-worker-as-its-own-service-added-2026-10-08-tula-52)) | Whether an event has waited a minute or more to be queued for delivery, read as the time of the oldest waiting event of each of the 200 oldest environments (`oldestPendingEventAt`: one timestamp, never the event or its payload), inside the same scan as `master_key`. `fail` where `WEBHOOK_WORKER=separate`, worded for what was looked at (the worker is not running, or it cannot keep up or cannot work: the outbox looks the same for all three), `warn` where the API instances deliver (the job is behind or failing), `warn` past 200 environments when none of those looked at has one. A count of environments, never an id, an event or an address. | Whether a worker process exists: an API instance cannot see one. With nothing waiting it is `ok` with or without a worker, and its text says it looked at the outbox. Deliveries that are queued and failing (that is the delivery log's business). |
| `sms_sender` (added 2026-10-09, TULA-29, [ADR 0037](0037-phone-numbers-and-sms.md#twilio-added-2026-10-09-tula-29)) | Whether an environment was told to send text messages in a deployment with nothing to send them: with `SMS_PROVIDER=none`, how many of the 200 oldest environments have `sms.enabled` and at least one allowed country (two fields of the settings, read through the settings cache, one read per environment, inside the same scan as `master_key`). `warn` when there is one and none of them signs in with a texted code (not `fail`: the client configuration already hides the phone number where there is no sender, so nothing a user can reach is broken). **`fail` when one of them also has `signIn.methods.smsCode` on** (TULA-27, the same read): its operator switched on a way to sign in that is offered to nobody. `warn` past 200 environments when none of those looked at has one, `skipped` when none has. With a sender it is `ok` and reads no settings. A count of environments, never an id, a country or a number. | Whether the sender works: no message is sent and the provider is not asked, so `ok` says a sender is configured and nothing about its credentials, its registration or delivery. An environment past the 200th. |
| `native_app_identities` (added 2026-10-09, TULA-35, [ADR 0040](0040-native-app-identity.md#what-tula-doctor-checks-added-2026-10-09-tula-35)) | Whether every stored native app of the 200 oldest environments is one this version would register: its identifiers against the contract's own schemas, only the fields of its platform, an Android app's fingerprints in the stored form (`NativeApps.wellFormed`; one `list` per environment, inside the same scan as `master_key`). `fail` with a count for a row that is not (the association files name an app as it is stored, so a platform is told something it refuses). `warn` for an environment over the cap of 20: its files are served and only a further registration is refused. `skipped` when no environment has an app. The log names the rows by the ids the server made. A count, never an identifier, a team, a fingerprint or an environment's id. | Whether an identifier is the **right** one: the server has never seen the app, so a well-formed bundle ID with a typing mistake is `ok`, and the text says so. An environment past the 200th. |
| `native_app_files` (added 2026-10-09, TULA-35, [ADR 0040](0040-native-app-identity.md#what-tula-doctor-checks-added-2026-10-09-tula-35)) | Two halves, and the text says which was looked at. In process, for each of those environments: the two files built by the function the public routes serve (`NativeApps.associationFiles`) name exactly the stored apps and pass the schema the route answers with. Over HTTP, for a sample (`NATIVE_APP_FILES_FETCHED`: one file per platform, of the oldest environment that has such an app): the route answers at the server's own `PUBLIC_URL` with 200, `application/json`, no redirect and the body that was built. `fail` when a file is built wrong, redirected, answered with another status or not as JSON: a platform gets the same answer through the operator's domain and accepts none of them. `warn` for a `401` or a `403` (the routes take no key, so that is an access wall or a firewall in front of the API's own host, which says nothing about what the apps' domain serves; any `fail` of the sample is said first), when the body differs (the route lets a cache keep a copy for five minutes, so a difference just after a change is expected) and when there is no answer (nothing was seen to be wrong, and `public_url` says why the address is silent). A loopback `PUBLIC_URL` is not fetched, and the text says so. Every sentence about a fetch says it was made at "PUBLIC_URL, the server's own address". | **Whether Apple or Android can reach the files at the apps' own domain.** That address is the operator's and the server never requests it: `ok` says the server's own copies were checked and that this was not. Whether either platform accepts the files. Over HTTP, the files of the environments that were not sampled. |
| `native_app_passkeys` (added 2026-10-09, TULA-35, [ADR 0040](0040-native-app-identity.md#what-tula-doctor-checks-added-2026-10-09-tula-35)) | For each of those environments that has an app (one read of its settings through the cache, the same read `sms_sender` uses): passkeys are on and `passkeys.rpId` is a domain a platform can associate an app with (a relying-party id by the contract's `isRelyingPartyId`, and not `localhost` or a loopback name). `warn`, never `fail`, where passkeys are on and the relying party cannot be associated: nothing that worked is broken, the apps only cannot use passkeys there. Two states are `ok` and are said with their counts: **passkeys off** (the files serve saved-password autofill too, so it is a state an operator may mean to be in, and `tula doctor --strict` does not fail it), and **a loopback relying party in the `local` tier** (`ENVIRONMENT`, never `NODE_ENV`: what a developer's machine has). In every other tier a loopback relying party is the warning, and one that is not set or is no domain name is the warning in every tier. **Also `warn` (added 2026-10-09, TULA-31)**: passkeys on, a relying party that can be associated, an iOS app registered, and the relying party's own origin (`https://` and the id) not among the environment's allowed origins, where the server refuses every passkey request of an iOS app ([ADR 0027](0027-passkeys.md#native-apps-added-2026-10-09-tula-31)); asked of the function that decides a request. Counts of environments, never a relying-party id or an origin. | Whether the relying party's domain serves the association files: `ok` says that it was not checked. Whether that domain is the one the app's own entitlement or manifest names. Whether an app whose environment has passkeys off was meant to use them. |

"Migrated" needs the migration history, which lives in the `drizzle` schema the API's role
deliberately cannot read. That boundary stays: migration `0014` adds
`tula.applied_migrations()`, a `SECURITY DEFINER` function with a fixed `search_path` that
returns one column (when each applied migration was generated), executable by `tula_app`.

### The clients

`@tula/admin`'s generator now renders the `/v1/instance/*` operations beside the admin ones
(`InstanceOperations`, `INSTANCE_OPERATIONS`; an instance operation that does not take the
instance token fails the generation), and `createInstanceClient({ baseUrl, adminToken })`
shares the admin client's transport: no redirect followed, plain http refused except to this
machine, the token last among the headers and never in an error.

### `tula doctor`

The CLI checks what it can see (the API answers, the versions match, this machine's clock
against the server's, a loopback `PUBLIC_URL`), then asks the API for the rest. The
`PUBLIC_URL` it checks is the server's word, so it is requested only when it has no
credentials and its origin is the origin of the API URL the operator gave, and then only as
`<origin>/v1/status`; anything else is reported `skipped` with a fixed explanation. A server
cannot make the operator's machine request a port or a path of its choosing. It never
connects to the database. Exit code 1 when a check fails, or warns under `--strict`. Text
from the server is stripped of control characters before it reaches the terminal, and of what
a reader cannot see: format characters (bidi overrides and isolates, zero-width characters),
private-use and unassigned code points and lone surrogates, by Unicode class. The token
comes from `TULA_ADMIN_TOKEN` or `--admin-token-file`, never from the command line.

### `tula policy test`

The policy is read with the environment's secret key (`GET /v1/admin/settings`) and evaluated
**on the operator's machine** with `@tula/contract/password-rules`, the code the server and
the SDKs use. The password is asked for with the terminal's echo off, or read from standard
input when piped. The plan's literal form, `tula policy test "<password>"`, is accepted with
a warning, because a command line is recorded in shell history. The password is never sent,
printed or logged; it is registered with the output's redaction for the error stream only
(on the result stream it would garble fixed text such as `password.too_short`). The breach
check is reported as **not run**: no route checks a password without setting it, and adding
one would create an oracle that takes arbitrary passwords. Exit 0 accepted, 2 refused, 1 an
error.

### `tula dev`

Runs in a project (a directory with a Compose file that has `api` and `migrate` services).
It runs `docker compose run --rm migrate`, the seed (`docker compose run --rm --no-deps api
bun run …/seed.ts`), `up -d api`, waits for `/v1/ready`, and mints keys with
`docker compose exec -T api bun run src/scripts/create-api-key.ts`: the commands the API
image already ships. That is the one place the CLI reaches the database, and only through
them.

- Keys go to a marked block of `.env.local` (mode 0600), which Bun, Vite and Next.js all
  read and the scaffold's `.gitignore` covers. The mode is enforced on every run, also one
  that changes nothing (with a warning when it was wider). The file is written through a
  temporary file created exclusively under a random name, and a symbolic link at `.env.local`
  is refused: nothing is written or re-moded through one. So is anything else there that is
  not a regular file (a named pipe, a directory, a device): opening a pipe to change its mode
  would wait for a writer for ever, so the kind is asked with `lstat` before anything is
  opened. The block's end marker is looked
  for after its start marker, and a marker is a whole line: a line of the user's that
  mentions one never hides the block. Lines outside the block are never changed; a
  `TULA_SECRET_KEY` of the user's own is used as it is. A second run verifies the stored
  secret key against the stack and mints nothing. Keys the stack refuses are reported with
  the fix (`--rotate-keys`), not replaced. The secret key is printed only with `--show-keys`.
- `tula dev down` stops the stack; `--volumes` deletes the database after a confirmation
  (`--yes` without a terminal) and removes the block.
- Everything that spawns goes through an injectable `Host`; every spawn has a timeout, is an
  argument vector (never a shell line) and is killed on Ctrl-C.

### `create-tula`

Writes `compose.yaml` (Postgres, Redis and Mailpit pinned by the digests of the repository's
own Compose file, which a test holds equal; the API by `TULA_API_IMAGE`), `.env` (mode 0600)
with a master key, an admin token and two database passwords from `crypto.getRandomValues`,
`.gitignore`, `.env.example`, `tula.config.ts`, a README and the example app.

- **No default password.** The scaffold's Postgres init script creates the API's role with
  the generated password; Postgres and Redis are not published on the host.
- **No invented registry.** Nothing is published, so the default image reference is the local
  tag the repository builds (`tula-api:local`), overridable with `--api-image`, and
  `--tula-packages <dir>` installs every `@tula/*` package from packed tarballs (with
  `overrides`, so transitive ones resolve there too).
- **One source for the app.** `scripts/sync-templates.ts` copies the example apps into
  `templates/<framework>/app` and derives the template's `package.json` from the example's;
  `generate:check` and a test fail when they drift. Only files ending in `.tmpl` have
  `{{name}}` placeholders: no template engine.
- It refuses a directory that is not empty (`--force`), validates the name (it is a
  directory, a package name and a Compose project name, so no path can be smuggled in), and
  never replaces an existing `.env` or `.env.local`.
- `.gitignore` is written first and `.env` last. With `--force` an existing `.gitignore` is
  kept and gains the patterns it lacks (once; an exception such as `!.env.example` is
  repeated after a pattern that would undo it).
- Existence is asked with `lstat`, and a symbolic link at the project directory, at a file to
  be written or at a directory above one is refused before anything is written: a write
  follows a link, so a dangling `.env` link would put the new secrets wherever it points.

## Consequences

- A deployment gains a route that connects to every dependency on request. It is behind the
  token, rate limited, and absent by default.
- `tula doctor` without a token still tells the operator whether the API is reachable and how
  to turn the rest on.
- The dashboard (1.15) builds on `instanceAdmin()`; it must add its own session exchange and
  must not send the token from a browser on every request.
- `create-tula` and `@tula/cli` join the packages released together (ADR 0020).

## Not done here

- A server-side breach check for `tula policy test` (see above).
- A conformance scenario for the instance route: its answer depends on whether the deployment
  under test sets `TULA_ADMIN_TOKEN`, which the scenario format cannot express yet. It is
  covered by the API's route tests and by the CLI's tests against the API in process.
- `tula doctor` cannot verify a provider's registered redirect URI, mail deliverability, or
  skew between API instances.
