# Self-hosting Tula Auth

Tula's API is one container and one PostgreSQL database. This guide covers trying it locally
with Docker Compose, and what to change for a real deployment.

Phase 0 status: email and password sign-up and sign-in, sessions, user administration and the
audit log. No dashboard yet; administration is through the HTTP API (`/v1/docs` lists it).

## Try it locally

You need Docker and a checkout of this repository.

```bash
export TULA_MASTER_KEY=$(openssl rand -hex 32)
```

```bash
docker compose --profile app up -d --build
```

This starts PostgreSQL, Mailpit (a local inbox at http://localhost:8025), applies the database
migrations, and starts the API on http://localhost:3003. The API waits for the migrations to
finish. Keep the same `TULA_MASTER_KEY` for every later start: put it in a `.env` file next to
`docker-compose.yml` (`TULA_MASTER_KEY=…`) rather than exporting it each time.

Create the first workspace (named `Local`), its default project and a development and a
production environment. The command prints their ids; copy the development environment's:

```bash
docker compose --profile app run --rm api bun run ../../packages/db/src/scripts/seed.ts
```

Then create an API key of each kind for that environment:

```bash
docker compose --profile app run --rm api bun run src/scripts/create-api-key.ts --environment <development environment id> --kind publishable
```

```bash
docker compose --profile app run --rm api bun run src/scripts/create-api-key.ts --environment <development environment id> --kind secret
```

Each key is printed once. The publishable key (`tula_pk_…`) goes in your app; the secret key
(`tula_sk_…`) stays on your server.

Check it:

```bash
curl http://localhost:3003/v1/ready
```

The API reference is at http://localhost:3003/v1/docs. Verification emails land in Mailpit.

To stop it: `docker compose --profile app down`. Adding `-v` also deletes the database. Always
pass `--profile app`: a plain `docker compose down` leaves the API container running.

Compose also reads a `.env` file next to `docker-compose.yml`. These variables change the
packaged stack:

| Variable | Default | |
| --- | --- | --- |
| `TULA_MASTER_KEY` | none | Required. |
| `API_PORT` | `3003` | Host port of the API. |
| `API_PUBLIC_URL` | `http://localhost:<API_PORT>` | The API's `PUBLIC_URL`. A separate name, because `PUBLIC_URL` in a developer's `.env` describes `bun run dev`. |
| `API_SMTP_URL` | `smtp://mailpit:1025` | The mail relay **as seen from inside the container**. Required in `staging` and `prod`, where the bundled Mailpit is refused. `SMTP_URL` is deliberately not used here: in a developer's `.env` it points at `127.0.0.1`. |
| `ENVIRONMENT`, `MAIL_FROM`, `BREACH_CHECK`, `PASSWORD_POLICY`, `CORS_ORIGINS`, `TRUST_PROXY`, `LOG_LEVEL` | as in [Settings](#settings) | Passed through. |
| `POSTGRES_PORT`, `REDIS_PORT`, `MAILPIT_SMTP_PORT`, `MAILPIT_UI_PORT` | `5432`, `6379`, `1025`, `8025` | Host ports of the other services. |

The database addresses inside the stack are fixed; `DATABASE_URL` from `.env` is not used.

### Check it behaves like Tula

The conformance suite runs the same scenarios the project's own tests run, against your server.
The server has to be started with `TRUST_PROXY=true` for this (see
[`conformance/README.md`](../conformance/README.md)):

```bash
CONFORMANCE_PUBLISHABLE_KEY=tula_pk_dev_… CONFORMANCE_SECRET_KEY=tula_sk_dev_… bun run conformance
```

## Settings

The API reads its settings from the environment and refuses to start if one is invalid.

| Variable | Required | Default | |
| --- | --- | --- | --- |
| `ENVIRONMENT` | yes | | `local`, `dev`, `staging` or `prod`. `staging` and `prod` require https, a real mail relay and sender (not Mailpit) and breach checks. |
| `DATABASE_URL` | yes | | PostgreSQL connection as the **non-owner** runtime role (see below). |
| `TULA_MASTER_KEY` | yes | | 64 hex characters (`openssl rand -hex 32`). Encrypts signing keys and keys the hashes of emailed codes. |
| `PUBLIC_URL` | | `http://localhost:3003` | Where clients reach the API. It is part of every access token's issuer. |
| `PORT` | | `3003` | |
| `SMTP_URL` | | `smtp://127.0.0.1:1025` | Your mail relay, e.g. `smtps://user:pass@smtp.example.com:465`. |
| `MAIL_FROM` | | `Tula Auth <no-reply@localhost>` | Sender of verification emails. |
| `BREACH_CHECK` | | `offline` | `hibp` checks new passwords against Have I Been Pwned (only a 5-character hash prefix leaves the server). |
| `PASSWORD_POLICY` | | `recommended` | `recommended`, `strict` or `legacy`. |
| `CORS_ORIGINS` | | none | Comma-separated browser origins allowed to call the API with credentials. |
| `TRUST_PROXY` | | `false` | Set `true` only behind a proxy that overwrites `X-Forwarded-For`. |
| `LOG_LEVEL` | | `info` | `debug`, `info`, `warn`, `error` or `silent`. |

## Running it for real

**The master key.** `TULA_MASTER_KEY` cannot be recovered or changed afterwards. Without it the
stored signing keys cannot be decrypted, and every sign-in fails until the signing keys are
recreated, which signs every user out. Store it in a secret manager and back it up separately
from the database.

**The database.** Tula is developed and tested against PostgreSQL 17. Two roles are needed, and they must be different:

- an **owner** that runs the migrations (`DATABASE_MIGRATION_URL`);
- a **runtime** login for the API (`DATABASE_URL`) that is a member of `tula_app` and owns
  nothing. Tenant isolation is enforced by row-level security, which PostgreSQL does not apply
  to table owners or superusers. An API connected as the owner has no isolation between
  projects.

```sql
CREATE ROLE tula_app NOLOGIN;
CREATE ROLE tula_api LOGIN PASSWORD '<a strong password>' IN ROLE tula_app;
```

The Compose file's passwords (`tula` / `tula_api`) are for local use only.

**Migrations.** Run them before starting a new version, as the owner:

```bash
docker run --rm -e DATABASE_MIGRATION_URL=postgres://owner:…@db:5432/tula tula-api bun run ../../packages/db/src/scripts/migrate.ts
```

Migrations only move forward. Back up the database before upgrading.

**First project and keys.** With your own database there is no Compose service to run the
bootstrap scripts in; run them in the image with the runtime settings. The seed prints the
environment ids, and each key is printed once:

```bash
docker run --rm -e DATABASE_URL=postgres://tula_api:…@db:5432/tula tula-api bun run ../../packages/db/src/scripts/seed.ts
```

```bash
docker run --rm -e ENVIRONMENT=prod -e DATABASE_URL=postgres://tula_api:…@db:5432/tula -e TULA_MASTER_KEY=… -e PUBLIC_URL=https://auth.example.com -e SMTP_URL=smtps://… -e MAIL_FROM='Example <no-reply@example.com>' -e BREACH_CHECK=hibp tula-api bun run src/scripts/create-api-key.ts --environment <environment id> --kind secret
```

The key script validates the same settings as the server, so give it the ones your deployment
uses. Create the roles first, then run the migrations, then these.

The commands above spell the settings out for clarity. In practice keep them out of your shell
history and the process list: put them in a file only you can read and pass
`--env-file tula.env` instead of `-e NAME=value`. Add `--network <name>` when the database is
only reachable on a Docker network.

**HTTPS and the proxy.** Put the API behind a TLS-terminating reverse proxy and set
`PUBLIC_URL` to the public https address (with the Compose file, set `API_PUBLIC_URL`). Refresh cookies are `Secure` when `PUBLIC_URL` is
https. Set `TRUST_PROXY=true` so rate limits and the audit log see the client's address, and
make sure the proxy **overwrites** `X-Forwarded-For`; if the API is also reachable without the
proxy, clients can forge their address.

**One instance.** Run a single API instance for now. Rate limits, the password lockout and the
list of revoked sessions are held in the process's memory. With several instances each counts
separately, and a session revoked on one instance keeps working on the others until its access
token expires (up to 60 seconds). A restart forgets all three. Shared storage (Redis) for them
is planned for Phase 1.

**Health.** `GET /v1/status` answers while the process is up; `GET /v1/ready` also checks the
database and is what the image's health check and a load balancer should use.

**The image.** It runs as the unprivileged `bun` user, listens on 3003, and contains only the
API's sources and production dependencies. Build it from the repository root:

```bash
docker build -f apps/api/Dockerfile -t tula-api .
```

## Housekeeping

**Old API keys.** An environment holds at most 100 active keys and 1,000 in total, revoked ones
included, because the API cannot delete keys. If you reach the total, remove revoked keys as the
schema owner (nothing else refers to them):

```sql
DELETE FROM tula.api_keys WHERE environment_id = '<environment id>' AND revoked_at IS NOT NULL;
```

## Not there yet

- No published image; build it from source.
- No retention job: audit entries, outbox events, and expired or revoked sessions accumulate.
- Nothing delivers the event outbox (webhooks arrive in Phase 2).
- No self-service "forgot password"; an administrator resets passwords with a secret key.
- A `TULA_MASTER_KEY` that does not match the stored signing keys does not stop the server. It
  logs `signing keys are unusable in some environments` at start-up, and sign-in fails in those
  environments until the right key is restored.
