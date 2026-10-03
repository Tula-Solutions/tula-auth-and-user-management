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

Create the first project and its environments, then an API key for each kind:

```bash
docker compose --profile app run --rm api bun run ../../packages/db/src/scripts/seed.ts
```

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

To stop it: `docker compose --profile app down`. Adding `-v` also deletes the database.

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
| `ENVIRONMENT` | yes | | `local`, `dev`, `staging` or `prod`. `staging` and `prod` require https, a real mail sender and breach checks. |
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

**HTTPS and the proxy.** Put the API behind a TLS-terminating reverse proxy and set
`PUBLIC_URL` to the public https address. Refresh cookies are `Secure` when `PUBLIC_URL` is
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

## Not there yet

- No published image; build it from source.
- No retention job: audit entries, outbox events, and expired or revoked sessions accumulate.
- Nothing delivers the event outbox (webhooks arrive in Phase 2).
- No self-service "forgot password"; an administrator resets passwords with a secret key.
- The API does not check at start-up that `TULA_MASTER_KEY` matches the stored signing keys. If
  the key was changed, the first sign-in or refresh fails with a 500.
