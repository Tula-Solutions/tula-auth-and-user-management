# Self-hosting Tula Auth

Tula's API is one container image, a PostgreSQL database and, for more than one instance, a
Redis. This guide covers trying it locally with Docker Compose, and what to change for a real
deployment.

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

This starts PostgreSQL, Redis and Mailpit (a local inbox at http://localhost:8025), applies the
database migrations, and starts **two instances** of the API: http://localhost:3003 and
http://localhost:3004. They are the same image with the same settings, sharing the database and
Redis, so you can see for yourself that they behave as one server: sign in through one and the
other accepts the token; sign out through one and the other refuses it. Use either; a real
deployment puts a load balancer in front of them (see
[Redis and more than one instance](#running-it-for-real)). The APIs wait for the migrations to
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
pass `--profile app`: a plain `docker compose down` leaves the API containers running.

Compose also reads a `.env` file next to `docker-compose.yml`. These variables change the
packaged stack:

| Variable | Default | |
| --- | --- | --- |
| `TULA_MASTER_KEY` | none | Required. |
| `API_PORT` | `3003` | Host port of the first API instance. |
| `API_2_PORT` | `3004` | Host port of the second API instance. |
| `API_PUBLIC_URL` | `http://localhost:<API_PORT>` | The `PUBLIC_URL` of **both** instances: it is the issuer of every access token, so they must agree on it. A separate name, because `PUBLIC_URL` in a developer's `.env` describes `bun run dev`. |
| `API_REDIS_URL` | `redis://redis:6379` | The API's `REDIS_URL`: the stack's own Redis unless you point it elsewhere. A separate name for the same reason. |
| `API_SMTP_URL` | `smtp://mailpit:1025` | The mail relay **as seen from inside the container**. Required in `staging` and `prod`, where the bundled Mailpit is refused. `SMTP_URL` is deliberately not used here: in a developer's `.env` it points at `127.0.0.1`. |
| `ENVIRONMENT`, `MAIL_FROM`, `BREACH_CHECK`, `PASSWORD_POLICY`, `CORS_ORIGINS`, `TRUST_PROXY`, `LOG_LEVEL` | as in [Settings](#settings) | Passed through. |
| `POSTGRES_PORT`, `REDIS_PORT`, `MAILPIT_SMTP_PORT`, `MAILPIT_UI_PORT` | `5432`, `6379`, `1025`, `8025` | Host ports of the other services. |

The database addresses inside the stack are fixed; `DATABASE_URL` from `.env` is not used.

### Check it behaves like Tula

The conformance suite runs the same scenarios the project's own tests run, against your server.
The server has to be started with `TRUST_PROXY=true` for this (see
[`conformance/README.md`](../conformance/README.md)):

```bash
CONFORMANCE_PUBLISHABLE_KEY=tula_pk_dev_… CONFORMANCE_SECRET_KEY=tula_sk_dev_… CONFORMANCE_SECOND_BASE_URL=http://localhost:3004 bun run conformance
```

`CONFORMANCE_SECOND_BASE_URL` names the second instance. With it, the `two instances` scenario
signs in through one instance and out through the other, and spreads wrong passwords over both
to show one shared lockout; the summary line then ends `against http://localhost:3003 and
http://localhost:3004`. Without it every step goes to the first instance.

## Settings

The API reads its settings from the environment and refuses to start if one is invalid.

| Variable | Required | Default | |
| --- | --- | --- | --- |
| `ENVIRONMENT` | yes | | `local`, `dev`, `staging` or `prod`. `staging` and `prod` require https, a real mail relay and sender (not Mailpit), breach checks and Redis. |
| `DATABASE_URL` | yes | | PostgreSQL connection as the **non-owner** runtime role (see below). |
| `TULA_MASTER_KEY` | yes | | 64 hex characters (`openssl rand -hex 32`). Encrypts signing keys and keys the hashes of emailed codes. |
| `PUBLIC_URL` | | `http://localhost:3003` | Where clients reach the API. It is part of every access token's issuer. |
| `PORT` | | `3003` | |
| `SMTP_URL` | | `smtp://127.0.0.1:1025` | Your mail relay, e.g. `smtps://user:pass@smtp.example.com:465`. |
| `MAIL_FROM` | | `Tula Auth <no-reply@localhost>` | Sender of verification emails. |
| `BREACH_CHECK` | | `offline` | `hibp` checks new passwords against Have I Been Pwned (only a 5-character hash prefix leaves the server). |
| `PASSWORD_POLICY` | | `recommended` | `recommended`, `strict` or `legacy`. The **default** password policy: it applies to an environment until that environment saves its own settings (below). |
| `CORS_ORIGINS` | | none | Comma-separated browser origins. Allowed for `/v1/admin/*`, and the **default** allowed origins of an environment until it saves its own settings (below). |
| `TRUST_PROXY` | | `false` | Set `true` only behind a proxy that overwrites `X-Forwarded-For`. |
| `REDIS_URL` | in `staging` and `prod` | none | Redis (or Valkey) shared by every API instance, e.g. `rediss://user:pass@cache.example.com:6380`. Holds rate limits, the password lockout and revoked sessions. Without it they are kept in the process's memory, which is only correct for a single instance. |
| `LOG_LEVEL` | | `info` | `debug`, `info`, `warn`, `error` or `silent`. |

## Settings of an environment

What differs between tenants is not an environment variable: each environment (the thing an
API key belongs to) has a settings document, read and replaced with its secret key.

| Section | |
| --- | --- |
| `app.name`, `app.supportEmail` | The product's name and help address. Every email names the app; the default name is `Tula`. |
| `password` | The password policy. |
| `signIn.methods` | Which sign-in methods are offered: `password` (on by default), `emailCode` (a 6-digit code by email) and `emailLink` (a link in that email; needs `emailCode`). At least one must stay on. |
| `signUp.password` | `required` (default), or `optional`: a sign-up may then leave the password out and the account signs in by email (needs `emailCode`). |
| `urls.allowedOrigins` | Browser origins that may call the client API: exact origins such as `https://app.example.com`, no paths or wildcards, `http` only for localhost. |
| `urls.allowedRedirectUrls` | URLs a flow may send users to, matched **exactly**. An emailed sign-in link leads only to a URL listed here. |
| `audit.retentionDays` | How long audit entries are kept (`null`: for ever). Stored; nothing is deleted yet. |
| `notifications.passwordChanged` | Email a user when their password is changed, reset, set by an administrator or added. On by default. |
| `notifications.newSignIn` | Email a user when their account is signed in to from a browser and operating system (or a native app) none of their other sessions has. On by default. |

Read the document; the `ETag` is its revision:

```bash
curl -si http://localhost:3003/v1/admin/settings -H "Authorization: Bearer $TULA_SECRET_KEY"
# ETag: "0"
# {"revision":0,"settings":{"version":1,"app":{"name":"Tula","supportEmail":null},"password":{…},…}}
```

Replace it, naming the revision you read in `If-Match`. The body is the **whole** document:
anything you leave out goes back to its default, and an unknown key is refused. Two defaults
are your deployment's own: leave `password` out and it is `PASSWORD_POLICY`; leave
`urls.allowedOrigins` out and it is `CORS_ORIGINS`. Send `"allowedOrigins": []` to allow no
origin at all. `password.minLength` cannot be set below 8.

If the answer is 422 with an error on `urls.allowedOrigins` saying the deployment's default
origins include an entry settings cannot store, your `CORS_ORIGINS` holds something a settings
document does not accept (usually a plain `http://` origin that is not localhost). Nothing was
saved. Send the list yourself in the same request, `"urls": { "allowedOrigins": ["https://…"] }`,
or correct `CORS_ORIGINS` and restart. Until an environment saves settings, `CORS_ORIGINS`
keeps applying to it exactly as written.

If the API logs `stored environment settings held list entries that are not valid; they were
ignored`, a stored origin or redirect URL is one this version does not accept. The environment
keeps working without those entries; read the settings and `PUT` them back to clean the row.

```bash
curl -s -X PUT http://localhost:3003/v1/admin/settings \
  -H "Authorization: Bearer $TULA_SECRET_KEY" \
  -H 'Content-Type: application/json' -H 'If-Match: "0"' \
  -d '{
    "app": { "name": "Acme", "supportEmail": "help@acme.example" },
    "urls": { "allowedOrigins": ["https://app.acme.example"] }
  }'
```

Without `If-Match` the answer is 428 (`precondition.required`); with a revision that is no
longer current, 412 (`precondition.failed`): read again and retry. Each change is in the audit
log as `environment.settings_updated`, listing the keys that changed and never their values,
with `"weakened": true` when the change made the password policy weaker or switched a security
notice off.

**Security notices.** The two `notifications` switches control the emails that let a user
notice a takeover ([ADR 0023](adr/0023-security-notices.md)). They are sent after the change,
in the background: a mail relay that is slow or down never fails or delays a sign-in or a
password change, it only costs the notice, and the API logs `security notice not sent` with the
error's name and SMTP status (never the address). A user is sent at most three of each kind an
hour. The notices contain no link and no code. "A new device" is judged from the browser and
operating system in the `User-Agent` header, so it is a hint to the user, not a guarantee: it
does not replace the audit log. To turn one off, send it in the settings document:
`"notifications": { "newSignIn": false }` (the other keeps its default).

An environment that has never saved settings is at revision 0 and uses the defaults, including
`PASSWORD_POLICY` and `CORS_ORIGINS` from the table above. Once it saves a document, those two
variables no longer apply to it. A change takes effect at once on the instance that received
it and within 5 seconds on the others (30 if Redis is unreachable). Apps read the public part
(app name, sign-in methods, password policy) from `GET /v1/client/config`.

**Browsers.** An origin has to be in the environment's `urls.allowedOrigins` to read the
client API's responses, to use the refresh cookie, and to sign anyone in: a sign-up, sign-in or
password reset started as a browser client is refused with `request.origin_not_allowed` (403)
from any other origin, so that a foreign page cannot have a session cookie set. If your app
gets that error, add its origin (scheme, host and port, exactly as the browser sends it).
`/v1/admin/*` only ever allows the origins in `CORS_ORIGINS`. See
[ADR 0018](adr/0018-environment-settings.md) and [ADR 0019](adr/0019-flow-engine-v2.md).

**Signing in by email.** To let users sign in with an emailed code, and optionally a link
([ADR 0024](adr/0024-email-sign-in.md)), send the methods in the settings document (with the
rest of it: a `PUT` replaces the whole document):

```json
{
  "signIn": {
    "methods": {
      "password": { "enabled": true },
      "emailCode": { "enabled": true },
      "emailLink": { "enabled": true }
    }
  },
  "urls": { "allowedRedirectUrls": ["https://app.example.com/auth/link"] }
}
```

- `emailCode` alone needs nothing else. With it on, `password` may be switched off.
- `emailLink` also needs the page your links lead to in `urls.allowedRedirectUrls`: the whole
  URL, exactly as your app sends it. There is no prefix or wildcard matching, and a URL with a
  query or a trailing slash is a different URL. A request for a link to any other URL is
  refused with `request.redirect_not_allowed` (400). With `ENVIRONMENT=local`, `http://` URLs
  on `localhost`, `127.0.0.1` and `[::1]` are allowed without being listed.
- The link's page has to be on the same origin (scheme, host, port) as the page people sign in
  on: the browser ties the link to itself through that origin's storage.
- That page renders `<EmailLinkCallback>` from `@tula/react` (or calls
  `tula.signIn.handleEmailLink()`), and `<SignIn>` is told where it is with `emailLinkUrl`.
- **A link works only in the browser that asked for it.** Opened on another device it signs
  nobody in and tells the user to enter the code from the same email where they started. This
  is what stops a stranger who types your user's address from being signed in when the user
  clicks the genuine email. The link's token travels in the URL fragment, which browsers never
  send to a server.
- `"signUp": { "password": "optional" }` lets people sign up with only an email address. Such
  an account has no password: it signs in by email, and gets a password through "forgot
  password" if it wants one.
- An address with no account that asks to sign in by email is sent a short notice instead of a
  code, so the screens look the same for every address.

**Upgrading.** Signing in by email needs no migration. Migration `0008` adds the attempt secret. Sign-ups, sign-ins and resets that are
in flight while you upgrade (they live ten minutes) cannot be continued afterwards; the user
starts again.

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
docker run --rm -e ENVIRONMENT=prod -e DATABASE_URL=postgres://tula_api:…@db:5432/tula -e TULA_MASTER_KEY=… -e PUBLIC_URL=https://auth.example.com -e SMTP_URL=smtps://… -e MAIL_FROM='Example <no-reply@example.com>' -e BREACH_CHECK=hibp -e REDIS_URL=rediss://… tula-api bun run src/scripts/create-api-key.ts --environment <environment id> --kind secret
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

**Redis and more than one instance.** Set `REDIS_URL` and you can run as many API instances
as you like behind a load balancer: rate limits, the password lockout and the list of revoked
sessions are kept in Redis, so every instance counts the same attempts and a session revoked on
one is refused by all. `staging` and `prod` refuse to start without it. Use `rediss://` when
Redis is not on a private network. Nothing personal is stored there: keys are ids and keyed
hashes, never an email or IP address.

Treat Redis as part of the service. If the API cannot reach it, sign-in, sign-up and every
request that carries an access token are answered with 503 (`service.unavailable`) until it is
back; the API will not guess whether a limit was reached or a session revoked. Sessions
themselves survive: refreshing a token needs only the database and keeps working. Redis needs
no backup. If it loses its data, counters and lockouts start again and nothing else is lost.
See [ADR 0016](adr/0016-redis-and-multiple-instances.md).

Every instance needs the same `PUBLIC_URL`, `TULA_MASTER_KEY`, `DATABASE_URL` and `REDIS_URL`.
The Compose file shows the arrangement with two instances (`api` and `api-2`) built from one
set of settings; it publishes each on its own port only so that they can be compared. Publish
your load balancer instead, and keep the instances' clocks in sync (NTP).

Without `REDIS_URL` (allowed in `local` and `dev`) run a single instance: each one would count
separately, and a restart forgets all three.

**Retention.** The API cleans up after itself; there is nothing to schedule. On start-up and
every ten minutes one instance (whichever takes a PostgreSQL advisory lock first; the others
skip that round) deletes:

The lock needs `DATABASE_URL` to be a direct connection or a session-mode pooler. Behind a
transaction-mode pooler (PgBouncer in `transaction` mode) retention can stop without an error.

- sign-in and sign-up attempts that have expired;
- emailed codes and links one hour after they expire;
- sessions, with their refresh tokens, 30 days after they were revoked or expired.

It never deletes audit entries or outbox events (an environment's `audit.retentionDays`
setting is stored but not applied yet). Each run logs one line, `retention run
finished`, with counts only (at `debug` level when there was nothing to delete). The periods
are fixed for now. See [ADR 0017](adr/0017-retention.md).

**Health.** `GET /v1/status` answers while the process is up; `GET /v1/ready` also checks the
database, and Redis when it is configured, and is what the image's health check and a load
balancer should use.

**The image.** It runs as the unprivileged `bun` user, listens on 3003, and contains only the
API's sources and production dependencies. Its base image is pinned by digest, as are the
PostgreSQL, Redis and Mailpit images in the Compose file, so a rebuild next month starts from
the same bytes as today's; Dependabot proposes the updates. Build it from the repository root:

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
- Audit entries and outbox events are kept for ever: audit retention becomes a setting in a
  later step, and nothing delivers the event outbox yet (webhooks arrive in Phase 2), so no
  event is deleted until something has delivered it.
- A `TULA_MASTER_KEY` that does not match the stored signing keys does not stop the server. It
  logs `signing keys are unusable in some environments` at start-up, and sign-in fails in those
  environments until the right key is restored.
