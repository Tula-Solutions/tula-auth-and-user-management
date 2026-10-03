# ADR 0014 — Self-host packaging

- Status: accepted
- Date: 2026-10-03

## Context

"Data you own" means anyone can run Tula themselves. Phase 0 needs one supported way to do
that, and a check that the packaged server behaves like the one the tests exercise.

## Decision

- **One image, run from source.** `apps/api/Dockerfile` installs production dependencies from
  the frozen lockfile and copies the sources of the API and the two packages it imports. Bun
  runs TypeScript directly, so there is no compile step and no second artefact to keep in sync.
  The image runs as the unprivileged `bun` user and has a health check on `/v1/ready`.
- **Migrations are a separate, explicit step** run as the schema owner, never by the API at
  start-up. The API's database role cannot alter the schema, and must not be able to: owners
  bypass row-level security. In Compose a one-shot `migrate` service runs first and the API
  waits for it.
- **Compose profile `app`.** `docker compose up -d` stays the development stack (Postgres,
  Redis, Mailpit); `--profile app` adds the migrations and the API. Host ports are
  configurable so a second stack can run beside the first.
- **No default master key.** Compose passes `TULA_MASTER_KEY` through and the API refuses to
  start without a valid one. A built-in default would be a shared secret in every careless
  deployment.
- **Bootstrap by script.** The first project, environments and API keys are created with the
  seed and `api-key:create` scripts inside the container; there is no unauthenticated setup
  endpoint.
- **CI proves the package.** The `self-host` job builds the image, starts the Compose stack and
  runs the conformance scenarios against it over HTTP.

## Consequences

- The image carries TypeScript sources and Bun's transpile cost at start-up (well under a
  second). A bundled build can replace it later without changing how it is run.
- A deployment is a single API instance until rate limits, lockout and the session denylist
  move to Redis (Phase 1); `docs/self-host.md` says so.
- Without the master key the Compose `api` service restarts in a loop with a clear error in its
  log, rather than failing `docker compose up` itself: a required-variable check in the Compose
  file would also break the development stack, which does not need the key.
- There is no published image and no Helm chart or other orchestrator packaging yet.
