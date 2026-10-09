# Self-hosting Tula Auth

Tula's API is one container image, a PostgreSQL database and, for more than one instance, a
Redis. This guide covers trying it locally with Docker Compose, and what to change for a real
deployment.

Phase 1 status: passwords, emailed codes and links, Google, GitHub, Apple, Microsoft, Discord, LinkedIn, X and Facebook, passkeys,
two-step verification, session profiles, user administration and the audit log (one page per
method under [methods/](README.md#sign-in-methods)). Administration is through the dashboard at
`/dashboard` ([dashboard.md](dashboard.md)), settings as code (`tula apply`,
[config.md](config.md)) or the HTTP API (`/v1/docs` lists it). **No image and no package is
published yet**: the image is built from this repository. What has only been tested against a
stand-in (real providers, a physical passkey authenticator, and more) is listed in
[plans/phase-1-unverified.md](plans/phase-1-unverified.md).

Contents: [try it locally](#try-it-locally) · [the server's settings](#settings) ·
[an environment's settings](#settings-of-an-environment) ·
[providers](#signing-in-with-a-provider) · [sessions](#sessions) ·
[passkeys](#passkeys) · [`tula doctor`](#checking-a-deployment-tula-doctor) ·
[the dashboard](#the-dashboard) · [running it for real](#running-it-for-real) (the database,
https and the proxy, Redis and several instances, retention) · [upgrading](#upgrading).

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
other accepts the token; sign out through one and the other refuses it. A third address,
http://localhost:3005, is a small proxy (`lb`) that sends each request to whichever instance is
next, which is how a real deployment is reached (see
[Redis and more than one instance](#running-it-for-real)). Use any of the three. The APIs wait for the migrations to
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
| `LB_PORT` | `3005` | Host port of the proxy in front of both instances. |
| `LB_CLIENT_ADDRESS` | `peer` | What the proxy tells the API the client's address is: `peer` is the address it saw. `client` passes the caller's `X-Forwarded-For` through and is for the conformance run only (below); with it any caller chooses its own rate-limit bucket. |
| `API_IMAGE` | `tula-api:local` | The tag the image is built as, so that a second stack (`docker compose -p <name>`) does not overwrite the first one's. |
| `API_PUBLIC_URL` | `http://localhost:<API_PORT>` | The `PUBLIC_URL` of **both** instances: it is the issuer of every access token, so they must agree on it. When clients come through the proxy, set it to the proxy's address (`http://localhost:3005`). A separate name, because `PUBLIC_URL` in a developer's `.env` describes `bun run dev`. |
| `API_REDIS_URL` | `redis://redis:6379` | The API's `REDIS_URL`: the stack's own Redis unless you point it elsewhere. A separate name for the same reason. |
| `API_SMTP_URL` | `smtp://mailpit:1025` | The mail relay **as seen from inside the container**. Required in `staging` and `prod`, where the bundled Mailpit is refused. `SMTP_URL` is deliberately not used here: in a developer's `.env` it points at `127.0.0.1`. |
| `ENVIRONMENT`, `MAIL_FROM`, `BREACH_CHECK`, `PASSWORD_POLICY`, `CORS_ORIGINS`, `TRUST_PROXY`, `TULA_ADMIN_TOKEN`, `OAUTH_MOCK_PROVIDER`, `SMS_PROVIDER`, the six `TWILIO_*` variables, `LOG_LEVEL` | as in [Settings](#settings) | Passed through. Set `TRUST_PROXY=true` only when every request comes through the proxy: the instances' own ports are published here too, and on those a client could then write its own address. |
| `WEBHOOK_WORKER` | `api` | Passed to every container of the stack. With `separate` the two instances make no webhook delivery and the `worker` service has to be started with them: `--profile app --profile worker` ([The webhook worker as its own service](#the-webhook-worker-as-its-own-service)). |
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

To run every scenario **through the one address**, so that each request lands on whichever
instance is next, start the stack with `TRUST_PROXY=true`, `LB_CLIENT_ADDRESS=client` and
`API_PUBLIC_URL=http://localhost:3005`, and run:

```bash
CONFORMANCE_BASE_URL=http://localhost:3005 CONFORMANCE_SETTLE_MS=6000 CONFORMANCE_PUBLISHABLE_KEY=tula_pk_dev_… CONFORMANCE_SECRET_KEY=tula_sk_dev_… bun run conformance
```

`CONFORMANCE_SETTLE_MS` makes the runner wait after each change of the environment's settings:
an instance may serve the settings it had cached for up to 5 seconds after another instance
changed them, and without the wait the next step can land on that instance. The summary line
ends `(one address, 6000 ms after each settings change)`, and
`docker compose --profile app logs lb` shows which instance answered each request. See
[`conformance/README.md`](../conformance/README.md#behind-one-address).

## Settings

The API reads its settings from the environment and refuses to start if one is invalid.

| Variable | Required | Default | |
| --- | --- | --- | --- |
| `ENVIRONMENT` | yes | | `local`, `dev`, `staging` or `prod`. `staging` and `prod` require https, a real mail relay and sender (not Mailpit), breach checks and Redis. |
| `DATABASE_URL` | yes | | PostgreSQL connection as the **non-owner** runtime role (see below). |
| `TULA_MASTER_KEY` | yes | | 64 hex characters (`openssl rand -hex 32`). Encrypts signing keys, provider credentials and authenticator secrets, and keys the hashes of emailed codes and backup codes. |
| `TULA_ADMIN_TOKEN` | | none | The instance admin token: the dashboard and `tula doctor` sign in with it. Unset, `/v1/instance/*` does not exist and the dashboard has no sign-in. At least 32 characters, generated (`openssl rand -hex 32`); the same on every instance. With it set, the server refuses to start, in any tier, when `PUBLIC_URL` is plain `http:` on a host that is not loopback: the token and the dashboard's session would cross the network unencrypted. See [`tula doctor`](#checking-a-deployment-tula-doctor) and [the dashboard](#the-dashboard). |
| `DASHBOARD_DIR` | | `apps/dashboard/dist` next to the API | Directory of the dashboard's build output, served at `/dashboard`. The image ships it; a directory with no `index.html` means no dashboard. |
| `PUBLIC_URL` | | `http://localhost:3003` | Where clients reach the API. It is part of every access token's issuer. |
| `PORT` | | `3003` | |
| `SMTP_URL` | | `smtp://127.0.0.1:1025` | Your mail relay, e.g. `smtps://user:pass@smtp.example.com:465`. |
| `MAIL_FROM` | | `Tula Auth <no-reply@localhost>` | Sender of verification emails. |
| `BREACH_CHECK` | | `offline` | `hibp` checks new passwords against Have I Been Pwned (only a 5-character hash prefix leaves the server). |
| `PASSWORD_POLICY` | | `recommended` | `recommended`, `strict` or `legacy`. The **default** password policy: it applies to an environment until that environment saves its own settings (below). |
| `CORS_ORIGINS` | | none | Comma-separated browser origins. Allowed for `/v1/admin/*`, and the **default** allowed origins of an environment until it saves its own settings (below). |
| `TRUST_PROXY` | | `false` | Set `true` only behind a proxy that overwrites `X-Forwarded-For`. **Behind a proxy it must be set**: without it every client has the proxy's address, so they all share one rate-limit bucket (one visitor's guesses lock everyone out, the dashboard's sign-in included) and one audit sample. Without a proxy it must stay `false`, or a client picks its own bucket with a header. |
| `API_DOCS` | | `on` in `local` and `dev`, `off` in `staging` and `prod` | `on` or `off`: whether the API reference page is served at `/v1/docs`. The page is on the same origin as the dashboard; it loads no script from another host (the reference's bundle is served by the API from its own installed package) and has its own Content-Security-Policy, and a deployment that does not need it should leave it off. `/v1/openapi.json` is served either way. |
| `INSTANCE_AUDIT_RETENTION_DAYS` | | `365` | Days an entry of the **instance** audit log (dashboard sign-ins, workspaces, projects) is kept before the retention job deletes it; at least 30. An environment's audit log has its own period, the `audit.retentionDays` setting. |
| `OAUTH_MOCK_PROVIDER` | | `false` | **Development and tests only.** `true` serves every OAuth provider from a built-in mock provider whose consent page signs in as any address typed into it. The server refuses to start with it unless `ENVIRONMENT=local` **and** `PUBLIC_URL` is a loopback address (`localhost`, `127.0.0.1`, `[::1]` or a `*.localhost` name), and logs a warning at every start while it is on. |
| `SMS_PROVIDER` | | `none` | How text messages are sent ([ADR 0037](adr/0037-phone-numbers-and-sms.md)). `none`: there is no sender, and a request that would send a message is answered `sms.unavailable` (503). `dev`: **development and tests only.** Nothing is sent; the newest 50 messages are kept in the server's memory and read at `GET /v1/dev/sms/messages` (`?to=` narrows to one number), codes included. The server refuses to start with `dev` unless `ENVIRONMENT=local` **and** `PUBLIC_URL` is a loopback address, and logs a warning at every start while it is on. Each instance has its own inbox. `twilio`: messages are really sent, through Twilio, with the `TWILIO_*` variables below; allowed in every tier ([Text messages with Twilio](#text-messages-with-twilio)). Whether an environment sends text messages, and to which countries, is its [`sms` setting](phone-numbers.md), off by default. |
| `TWILIO_ACCOUNT_SID` | with `SMS_PROVIDER=twilio` | none | The Twilio account messages are sent from: `AC` and 32 hexadecimal characters. **Every `TWILIO_*` variable is read only when `SMS_PROVIDER` is `twilio`, and ignored otherwise**, whatever it holds. With `twilio` the server refuses to start unless there is an account, exactly one way to authenticate and exactly one sender, each of the shape Twilio shows it in; the refusal names the variable and never repeats a value. |
| `TWILIO_API_KEY_SID` | one way to authenticate | none | An API key of that account (`SK` and 32 hexadecimal characters), with its secret in `TWILIO_API_KEY_SECRET`. **Preferred**: a key can be revoked by itself and is not the account's master credential. |
| `TWILIO_API_KEY_SECRET` | with `TWILIO_API_KEY_SID` | none | That key's secret. A secret: Twilio shows it once. Never logged, returned or put in an error. |
| `TWILIO_AUTH_TOKEN` | the other way to authenticate | none | The account's auth token, **instead of** the API key: setting both is refused. It can do everything the account can; prefer the key. A secret. |
| `TWILIO_MESSAGING_SERVICE_SID` | one sender | none | A Messaging Service (`MG` and 32 hexadecimal characters): Twilio picks the sender from its pool. What a registered United States campaign needs. |
| `TWILIO_FROM_NUMBER` | the other sender | none | One Twilio number in E.164 form (`+14155550100`), **instead of** the Messaging Service: setting both is refused. A short code or an alphanumeric sender goes in a Messaging Service. |
| `REDIS_URL` | in `staging` and `prod` | none | Redis shared by every API instance, e.g. `rediss://user:pass@cache.example.com:6380`. A `valkey://` or `valkeys://` URL is accepted too, but only Redis (7 and 8) has been tested; Valkey has never been run. Holds rate limits, the password lockout and revoked sessions. Without it they are kept in the process's memory, which is only correct for a single instance. |
| `WEBHOOK_WORKER` | | `api` | `api` or `separate`: where webhook deliveries are made. `api`: inside the API instances. `separate`: only in a worker process (the same image, `bun run src/worker.ts`), and an API instance makes none. **Every process gets the same value**, and with `separate` a worker has to be running or nothing is delivered. See [The webhook worker as its own service](#the-webhook-worker-as-its-own-service). |
| `LOG_LEVEL` | | `info` | `debug`, `info`, `warn`, `error` or `silent`. |

## Settings of an environment

What differs between tenants is not an environment variable: each environment (the thing an
API key belongs to) has a settings document, read and replaced with its secret key.

| Section | |
| --- | --- |
| `app.name`, `app.supportEmail` | The product's name and help address. Every email names the app; the default name is `Tula`. A name is refused when it holds a text-direction control (such as U+202E), a private-use or unassigned character or half a surrogate pair; one saved before that rule is still read, and has to be corrected at the next save. |
| `password` | The password policy. `password.history` (0 to 24) is how many of a user's last passwords, the current one included, cannot be chosen again; lowering it deletes the stored hashes it no longer covers and raising it cannot bring them back. `password.expiryDays` (days, at least 1; `null` is off) is how old a password may be when it signs in: an older one has to be replaced before the sign-in completes ([methods/password.md](methods/password.md#security-properties-and-limits)). |
| `signIn.methods` | Which sign-in methods are offered: `password` (on by default), `emailCode` (a 6-digit code by email), `emailLink` (a link in that email; needs `emailCode`) and `passkey` (needs `passkeys.rpId`; see [Passkeys](#passkeys)). At least one must stay on. |
| `passkeys.rpId` | The WebAuthn relying-party id: the domain every passkey of this environment belongs to, e.g. `example.com`. `null` by default. A host name only (or `localhost`): no scheme, port, path or IP address. |
| `signUp.password` | `required` (default), or `optional`: a sign-up may then leave the password out and the account signs in by email (needs `emailCode`). |
| `urls.allowedOrigins` | Browser origins that may call the client API: exact origins such as `https://app.example.com`, no paths or wildcards, `http` only for localhost. |
| `urls.allowedRedirectUrls` | URLs a flow may send users to, matched **exactly**. An emailed sign-in link leads only to a URL listed here. |
| `audit.retentionDays` | How many days this environment's audit entries are kept: 1 to 3650, or `null` (the default) for ever. With a number set, the retention job, which runs on start-up and every ten minutes, deletes the entries older than that; an entry is never deleted in its first day. **Saving a period, or a shorter one, deletes the older entries for good**, starting with the next retention run (a large backlog takes several runs): there is no undo, so export what you need to keep longer (`GET /v1/admin/audit-logs`) first. Because of that it counts as a weakening: the dashboard asks before saving it and `tula apply --yes` needs `--allow-weaker`. Keep the API's server logs: the audit entry that records who changed the period is itself deleted once it is older than the new period, and the log line of each deletion is then the only trace. See "Retention" under [Running it for real](#running-it-for-real). |
| `notifications.passwordChanged` | Email a user when their password is changed, reset, set by an administrator or added. On by default. |
| `sessions.profiles` | Named session profiles. `web` (browsers) and `mobile` (every other client) always exist; add up to ten more. Each has `type` (`hybrid` or `stateful`), `accessTokenTtl` (30s to 15m, never longer than `idleTimeout`), `idleTimeout` (1m to 365d), `absoluteTimeout` (at least the idle timeout, or `null`), `refresh.reuseGracePeriod` (10s to 60s, or `null` for none), `stepUpAfter` (1m to 24h, or `null` for ten minutes) and `clientSelectable`. See [Sessions](#sessions). |
| `sessions.jwtTemplates`, `sessions.profiles.<name>.jwtTemplate` | Named sets of custom claims (at most 10 templates, 16 claims each, 1,024 bytes of JSON), issued under the `ext` claim of the access token to the sessions of the profile that names one (`null`, the default: none). A profile cannot name a template that does not exist. See [JWT templates](jwt-templates.md). |
| `sessions.maxPerUser`, `sessions.onLimit` | The most live sessions one user may have (`null`: no limit), and what a sign-in at the limit does: `end_oldest` (default) or `refuse_newest`. |
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
with `"weakened": true` when the change made the password policy weaker, switched a security
notice off, moved the MFA policy towards `off`, let sessions live longer, or set or shortened
the audit retention period.

**Security notices.** The `notifications` switches control the emails that let a user
notice a takeover ([ADR 0023](adr/0023-security-notices.md)). They are sent after the change,
in the background: a mail relay that is slow or down never fails or delays a sign-in or a
password change, it only costs the notice, and the API logs `security notice not sent` with the
error's name and SMTP status (never the address). A user is sent at most three of each kind an
hour. The notices contain no link and no code. "A new device" is judged from the browser and
operating system in the `User-Agent` header, so it is a hint to the user, not a guarantee: it
does not replace the audit log. To turn one off, send it in the settings document:
`"notifications": { "newSignIn": false }` (the others keep their defaults). The third switch,
`mfaChanged`, covers two-step verification being turned on, turned off or reset, new backup
codes, and a backup code being used to sign in.

**Two-step verification.** Users can protect their account with an authenticator app (TOTP)
and ten single-use backup codes ([ADR 0025](adr/0025-mfa.md)). `"mfa": { "policy": … }` in the
settings document says who must:

| `mfa.policy` | Meaning |
| --- | --- |
| `optional` (default) | A user may turn it on in their profile. |
| `required` | A user without it must set it up before a sign-in, sign-up or password reset completes, and cannot turn it off. |
| `off` | Nobody can set it up. **Users who already have it are still asked for their code** until they turn it off or you reset them. |

A user who has lost both their authenticator and their backup codes cannot get in by email:
that would turn two factors back into one. Reset them with the secret key, which also signs
them out everywhere and emails them:

```bash
curl -i -X DELETE "$TULA_URL/v1/admin/users/$USER_ID/factors" \
  -H "Authorization: Bearer $TULA_SECRET_KEY"
```

The reset removes the user's passkeys too, even one that was their only way to sign in. The
answer is `204` with the header `x-tula-can-still-sign-in`: on `false` nothing the environment
accepts is left on the account, and you have to give it a way in (the user's own "Forgot
password" where the password method is on, or a method you switch on). The same boolean is on
the `user.passkey_removed` audit entry.

The authenticator secrets are encrypted with `TULA_MASTER_KEY` and the backup codes are hashed
with a key derived from it: **changing the master key makes every user's second factor stop
working** (reset them afterwards). Keep the servers' clocks in sync (NTP): a code is accepted
for the current 30 seconds and the 30 on either side.

Access tokens carry `auth_time` (when the user last proved a factor for the session, in epoch
seconds) and `amr` (what they proved, e.g. `["pwd","otp","mfa"]`), so your backend can demand a
recent or a two-factor sign-in for its own sensitive actions without calling Tula.

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

Switching a sign-in method or an OAuth provider off takes up to 5 seconds to reach every
instance with Redis and up to 30 without: settings are cached per instance. What each migration
needs from you is under [Upgrading](#upgrading).

## Signing in with a provider

Each environment uses **its own** OAuth credentials; none ship with Tula
([ADR 0026](adr/0026-oauth.md)). For each provider: register an app with the provider using the
redirect URI `GET /v1/admin/oauth-providers` lists as `callbackUrl`
(`PUBLIC_URL/v1/oauth/callback/<provider>`), store the credentials with
`PUT /v1/admin/oauth-providers/<provider>`, and add your app's landing page to
`urls.allowedRedirectUrls`. Step-by-step: [Google](providers/google.md),
[GitHub](providers/github.md), [Apple](providers/apple.md),
[Microsoft](providers/microsoft.md) (which also takes a `tenant`: which Microsoft accounts
may sign in), [Discord](providers/discord.md), [LinkedIn](providers/linkedin.md), [X](providers/x.md),
[Facebook](providers/facebook.md) (an account made through either of the last two has no
email address). The secret is stored encrypted
with `TULA_MASTER_KEY` and never returned; no provider token is stored at all.
`DELETE /v1/admin/oauth-providers/<provider>` removes the credentials (users keep their
connected accounts). To try the flow without credentials, see `OAUTH_MOCK_PROVIDER` above.

## Text messages with Twilio

A text message (the code that proves a [phone number](phone-numbers.md)) is sent only when
the **deployment** has a sender and the **environment** has text messages switched on. The
sender is `SMS_PROVIDER`: `none` (the default, nothing is sent), `dev` (a local inbox, refused
outside `ENVIRONMENT=local`) or `twilio`, the one that really sends
([ADR 0037](adr/0037-phone-numbers-and-sms.md)). The step-by-step is the
[Twilio checklist](providers/twilio.md); in short:

1. **Register your sender with Twilio first**: it takes days to weeks, and without it a
   carrier blocks what Twilio accepted. For the United States that is A2P 10DLC (a Brand and
   a Campaign, on a Messaging Service) for a 10-digit number, or toll-free verification for a
   toll-free number. A trial account cannot send Tula's messages at all.
2. **Enable in Twilio exactly the countries your environments allow** (Twilio's *geo
   permissions*; a new account can send to its home country only). Tula's
   `sms.allowedCountries` and Twilio's list are separate, and both must allow a number.
3. **Turn on Twilio's SMS pumping protection.** It is a second net under Tula's own
   [send limits and daily limit](phone-numbers.md#send-limits-and-the-daily-limit).
4. **Create an API key** and set, on every API instance:

   ```sh
   SMS_PROVIDER=twilio
   TWILIO_ACCOUNT_SID=AC…
   TWILIO_API_KEY_SID=SK…
   TWILIO_API_KEY_SECRET=…             # or TWILIO_AUTH_TOKEN, never both
   TWILIO_MESSAGING_SERVICE_SID=MG…    # or TWILIO_FROM_NUMBER, never both
   ```

5. **Switch text messages on in the environment** (`sms.enabled`, the countries, a daily
   limit you can afford), run `tula doctor`, and send one message to your own phone.

What to know before relying on it:

- **Accepted is not delivered.** A message is "sent" when Twilio takes it into its queue.
  Tula asks for no delivery receipt: a message a carrier drops afterwards looks sent, and the
  user waits for a code that does not come. Twilio's message log has what happened to it.
- **A failed send is `sms.unavailable`** (503) for the user, with nothing of Twilio's answer.
  The reason is in the API's log (`twilio did not take a text message`: a fixed word, the
  HTTP status, Twilio's error number and its text with numbers and credentials taken out).
  Nothing is retried.
- **A send Twilio did not refuse stays in the day's count.** A message Twilio refused (a
  4xx) is given back to the [daily limit](phone-numbers.md#send-limits-and-the-daily-limit);
  one that timed out, whose connection failed, or that Twilio answered with a 5xx is not,
  because Twilio may have taken and billed it (`twilio gave no answer for a text message`,
  or `twilio answered without saying whether it took a text message` with the status, in
  the log). While Twilio cannot be reached, or answers 5xx, every try uses one of the
  day's messages.
- **The credentials are the API's alone.** They are never logged, returned or put in an
  error, and the [webhook worker](#the-webhook-worker-as-its-own-service) is not given them.
- **`staging` and `prod` refuse to start with `SMS_PROVIDER=dev`** (and so does `dev`): the
  development inbox shows every code to whoever can reach the API. What the start cannot
  see is an environment's own setting, so the other half is `tula doctor`: its `sms_sender`
  line warns when an environment has text messages switched on and the deployment has no
  sender (`SMS_PROVIDER=none`), in which case nothing is sent and nobody is told. It fails
  when that environment also signs in with a texted code: the method is offered to nobody.
- **Only Twilio's default region (US1, `api.twilio.com`)** is supported.
- **No message has been delivered to a real phone from this code**: it is tested against a
  stubbed network only. Do step 5 before you tell users it works.

## Sessions

How long a session lives, and how it is held, is set per environment in `sessions`
([ADR 0028](adr/0028-session-profiles.md)). Left alone, every session is what it always was:
60-second access tokens, a rotating refresh token, 7 days idle, 30 days in all.

```json
{
  "sessions": {
    "profiles": {
      "web": { "idleTimeout": "1d", "absoluteTimeout": "14d" },
      "mobile": { "idleTimeout": "30d", "absoluteTimeout": null },
      "back-office": { "idleTimeout": "15m", "absoluteTimeout": "8h", "stepUpAfter": "5m", "clientSelectable": true }
    },
    "maxPerUser": 5,
    "onLimit": "end_oldest"
  }
}
```

- A browser gets `web`, every other client `mobile`. An app asks for another profile with
  `createTulaClient({ sessionProfile: 'back-office' })` (the `x-tula-session-profile` header)
  and gets it only if you set `clientSelectable`; otherwise it silently gets its default.
- Changing a profile reaches sessions that already exist: tighten a timeout and an over-age
  session ends at its next refresh. Loosening never extends a session past the absolute limit
  it was created with.
- **`"type": "stateful"`** (browsers only) gives the browser one httpOnly cookie and no token
  at all; every request is checked against the database, so signing a session out takes
  effect on its very next request. The cookie is host-only (`__Host-…`, `SameSite=Lax`): the
  app and the API must be on the same site, and a backend of yours sees the cookie only when
  the API is served under the app's own host (a reverse proxy). It checks it with:

  ```bash
  curl -s -X POST http://localhost:3003/v1/admin/sessions/verify \
    -H "Authorization: Bearer $TULA_SECRET_KEY" -H 'Content-Type: application/json' \
    -d '{"token":"<the cookie\'s value>"}'
  ```

  which answers with the claims an access token would carry (`sub`, `sid`, `auth_time`,
  `amr`, `sp`), or 401. It costs one database read per request; keep `hybrid` unless you need
  instant revocation or no token in the browser.
- **`maxPerUser`** limits a user's live sessions. With `refuse_newest` a user at the limit is
  told to sign out elsewhere or reset their password; you can end their sessions yourself:

  ```bash
  curl -s -X DELETE http://localhost:3003/v1/admin/users/<user id>/sessions \
    -H "Authorization: Bearer $TULA_SECRET_KEY"
  ```
- A longer timeout, token lifetime or step-up window, a raised limit and a profile opened to
  clients are recorded in the audit log with `weakened: true`.

## Passkeys

A passkey lets a user sign in with a fingerprint, face or screen lock, with no address typed and
no second step ([ADR 0027](adr/0027-passkeys.md)). Passkeys are off until an environment
switches them on, and switching them on takes three settings in the same document:

```json
{
  "signIn": { "methods": { "password": { "enabled": true }, "passkey": { "enabled": true } } },
  "passkeys": { "rpId": "example.com" },
  "urls": { "allowedOrigins": ["https://app.example.com"] }
}
```

(with the rest of your settings: the `PUT` replaces the whole document).

- **`passkeys.rpId`** is the *relying party*: the domain a passkey is bound to. Choose the
  registrable domain your sign-in pages share (`example.com` covers `app.example.com` and
  `admin.example.com`), or `localhost` for local development. There is no default: the method
  cannot be switched on without it (422).
- **Every origin that uses passkeys must be listed in `urls.allowedOrigins` and be the `rpId`
  or a subdomain of it.** The API checks each passkey response against the request's own
  `Origin` header. A page on another domain, or on an origin that is not listed, gets
  `request.origin_not_allowed` when it starts. This applies in the `local` tier too: the rule
  that lets any `http://localhost:<port>` page call a local API does not extend to passkeys, so
  list `http://localhost:5174` (or your port) explicitly. A page opened at `http://127.0.0.1:…`
  cannot use an `rpId` of `localhost`: open it at `http://localhost:…`.
- **Changing `rpId` orphans every passkey made under the old one.** A browser offers a passkey
  only to the domain it was created for, so those passkeys can no longer sign in. Their rows
  stay, and users can remove them from their account page and add new ones. Decide the domain
  before you switch the method on, and prefer the registrable domain over a subdomain you may
  rename.
- **Https is required** outside `localhost`: browsers offer WebAuthn only in a secure context.
- A passkey sign-in satisfies two-step verification by itself. After a password, a user's
  passkey is asked for as the second step only where a second step is in force anyway (they
  have an authenticator app, or `mfa.policy` is `required`).
- A user who has lost every passkey and has no other way in is helped with the factor reset
  (`DELETE /v1/admin/users/<id>/factors`), which removes their passkeys as well; they then sign
  in another way or reset their password. The reset's `x-tula-can-still-sign-in` header is
  `false` when that left the account with no way in at all: nothing signs it in until you give
  it one. A user removing their own last way to sign in is refused
  (`passkey.last_sign_in_method`), and a user may hold at most ten passkeys.
- Native apps cannot use passkeys yet (they have no `Origin`); that arrives with the native
  SDKs.

Switching the method off again keeps the passkeys: users can still list and remove them through
the API, and they work again when it is switched back on with the same `rpId`.

## Checking a deployment: `tula doctor`

`tula doctor` checks what actually goes wrong, each with its fix: the database and its
migrations, `TULA_MASTER_KEY` against the stored secrets, the mail relay, Redis, the clocks,
`PUBLIC_URL`, the redirect URI each enabled OAuth provider needs, whether webhook events
are waiting with nothing delivering them, whether an environment has text messages
switched on in a deployment with nothing to send them, and whether the native apps an
environment registered are well formed and their association files served
([cli.md](cli.md#tula-doctor)). The checks run inside the API, behind
`GET /v1/instance/diagnostics`, and that route takes the **instance admin token**:

```sh
TULA_ADMIN_TOKEN=$(openssl rand -hex 32)     # in the API's environment, on every instance
```

```sh
export TULA_API_URL=https://auth.example.com
export TULA_ADMIN_TOKEN=…                     # the same value, where you run tula
tula doctor
```

- Without `TULA_ADMIN_TOKEN` in the API's environment the route does not exist (404), and
  `tula doctor` runs only the checks it can make from your machine.
- The token is the most powerful credential of the deployment (the dashboard signs in
  with it too): keep it in a secret manager, never in a file that is committed, and send it
  only over https. The API refuses to start with one shorter than 32 characters, that repeats
  a block, that counts up or down (`abcdefgh`), or that looks like a placeholder. That check
  is a floor against accidents, not a measure of randomness: a value that passes it is not
  thereby strong. Generate the token (`openssl rand -hex 32`, or the one `create-tula` writes). To rotate it, change the variable and restart every instance.
- A check never returns a connection string, a key or a driver's error message: the reason a
  check failed is in the API's log, next to `diagnostic check failed`.
- The route is rate limited (30 requests a minute per IP) and refuses when the rate limiter's
  store is down; `tula doctor` then reports Redis as the problem.

## The dashboard

The API serves the dashboard at `/dashboard` when its build output is present: the directory
named by `DASHBOARD_DIR`, or `apps/dashboard/dist` next to the API. Without one, `/dashboard`
is an unknown path and everything else works as before. The image ships the build, so a
deployment from the image has it at `https://<your API>/dashboard/`; what it can do is in
[dashboard.md](dashboard.md).

You sign in with the **instance admin token** (`TULA_ADMIN_TOKEN`, as for `tula doctor`); a
deployment that sets none has no dashboard sign-in. The token is sent once and exchanged for a
session cookie; the browser does not keep it.

- The session lasts **8 hours** from sign-in and is not extended. It is signed, not stored, so
  it works on every instance without Redis, and one session cannot be ended by itself:
  signing out clears it in that browser only. **To end every session, rotate the token**
  (change `TULA_ADMIN_TOKEN`, restart every instance). Changing `TULA_MASTER_KEY` ends them
  too.
- The cookie is `HttpOnly`, `SameSite=Strict` and, over https, `Secure`. It is sent to
  `/v1/instance` and `/v1/admin` only.
- Requests made with it are accepted from the API's own origin (`PUBLIC_URL`) and from
  `CORS_ORIGINS`, never from an origin an environment allows in its settings, and, unlike
  the rest of the API in the `local` tier, never from "any localhost port". If the dashboard
  answers `request.origin_not_allowed`, the address in your browser is not the `PUBLIC_URL`
  the API was started with (a proxy in front of it must present the same origin).
- Everything done in the dashboard is in the audit log with the actor `instance_admin` and
  the id of the sign-in: inside an environment in that environment's log
  (`GET /v1/admin/audit-logs?actorType=instance_admin`), and what has no environment
  (sign-ins, failed sign-ins, new projects and environments) in the instance audit log
  (`GET /v1/instance/audit-logs`).
- Sign-in attempts are limited to 10 a minute per IP (their own allowance, apart from the
  CLI's instance calls) and refused while the rate limiter's store is down. "Per IP" needs
  `TRUST_PROXY=true` behind a proxy: without it every operator and every guesser share the
  proxy's address and one allowance.
- Failed sign-ins are recorded at most once a minute per address, with the number of
  failures in the minute before that were not recorded one by one
  (`suppressedInPreviousMinute`). The instance audit log is kept for
  `INSTANCE_AUDIT_RETENTION_DAYS` (default 365).
- The API reference at `/v1/docs` shares the dashboard's origin. It is off by default in
  `staging` and `prod` (`API_DOCS=on` serves it), loads nothing from another host and has
  its own Content-Security-Policy.
- The pages are served with a strict Content-Security-Policy (this origin only, no inline
  script, not frameable). A proxy must not weaken or replace it.

See [ADR 0032](adr/0032-dashboard.md).

## Running it for real

**The master key.** `TULA_MASTER_KEY` cannot be recovered or changed afterwards. Without it the
stored signing keys cannot be decrypted, and every sign-in fails until the signing keys are
recreated, which signs every user out. Store it in a secret manager and back it up separately
from the database.

**The database.** Tula is developed and tested against PostgreSQL 18 (its migrations and
integration tests also passed on 17). The bundled Compose file pins the `postgres:18` image,
which keeps its data under `/var/lib/postgresql` and refuses to start on a volume that an
earlier major version wrote: a database made with the 17 image is moved with `pg_dump` and
`pg_restore` (or `pg_upgrade`), never by changing the image tag. Two roles are needed, and they must be different:

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

**A Next.js app in front (`@tula/nextjs`).** With the Next.js SDK the browser talks to the
app's own origin, and the app's server forwards to the API
([ADR 0029](adr/0029-nextjs-sdk.md)). Two settings follow. Add the **app's** origin to the
environment's `urls.allowedOrigins`: the browser's `Origin` is forwarded unchanged (and list
the app's callback pages for emailed links and OAuth in `urls.allowedRedirectUrls`). And tell
the API who the visitor is, which takes a setting on each side. On the Next.js server set
`TULA_TRUSTED_PROXY_HOPS` to the number of proxies in front of it that append to
`X-Forwarded-For` (`1` behind one load balancer); it defaults to `0`, which believes no
forwarding header and sends no address, because a server reachable without its proxy would
otherwise let a visitor write their own. On the API set `TRUST_PROXY=true`, reached by the
Next.js server directly. **With either missing every visitor shares the Next.js server's
address and one per-IP rate limit**, so one person's failed sign-ins can lock everyone out; set
the hops too high and a visitor chooses the address the rate limits, the lockout and the audit
log see. A `stateful` session profile also needs a secret key on the Next.js server
(`TULA_SECRET_KEY`), and costs one call to the API per request.

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

Every instance needs the same `PUBLIC_URL`, `TULA_MASTER_KEY`, `TULA_ADMIN_TOKEN`,
`DATABASE_URL` and `REDIS_URL`. The Compose file shows the arrangement with two instances (`api`
and `api-2`) built from one set of settings, behind a proxy (`lb`, `docker/lb/nginx.conf`); it
also publishes each instance on its own port, only so that they can be compared. Publish your
load balancer alone, and keep the instances' clocks in sync (NTP).

What the load balancer has to do:

- **No stickiness is needed.** Any request may go to any instance: sessions and attempts are in
  the database, limits and revocations in Redis.
- **Overwrite `X-Forwarded-For`** with the address it saw (or append to a header it has
  cleaned), and set `TRUST_PROXY=true` on the API. The API takes the last entry. That holds
  for the edge proxy, the one clients connect to: a proxy that itself sits behind another
  (a CDN, a cloud load balancer) sees only that one's address and scheme, so there use its
  real-IP handling (in nginx, `set_real_ip_from` with the outer proxy's address and
  `real_ip_header`) and pass the original scheme through instead of its own.
- **Do not replay a failed request** on another instance (`proxy_next_upstream off` in nginx): a
  repeated `POST` would spend a code or count a guess twice.
- Health-check `GET /v1/ready`.
- `PUBLIC_URL` is the load balancer's public address, the same on every instance.

**What is not instant across instances.** An environment's settings, and the signing keys, are
cached in each instance. The instance that receives a change applies it at once; the others
within 5 seconds (30 if Redis is unreachable). So for a few seconds after you switch a method
off, another instance may still offer it, and a `GET /v1/client/config` right after a `PUT` of
the settings may show the previous document. Nothing whose safety depends on taking effect
everywhere at once is a setting: revoking a session, a lockout and a rate limit are shared
through Redis and are immediate.

Without `REDIS_URL` (allowed in `local` and `dev`) run a single instance: each one would count
separately, and a restart forgets all three.

### The webhook worker as its own service

By default webhook deliveries are made inside the API instances (`WEBHOOK_WORKER=api`): one
instance does a round every five seconds, the others skip it, and there is nothing to
configure. `WEBHOOK_WORKER=separate` moves them into a **worker**: a second process from the
same image that does nothing else.

```sh
# The API instances, as before, and the worker: the same image, another command.
docker run … -e WEBHOOK_WORKER=separate tula-api                          # each API instance
docker run … -e WEBHOOK_WORKER=separate tula-api bun run src/worker.ts    # the worker
```

With the Compose file: `WEBHOOK_WORKER=separate docker compose --profile app --profile worker
up -d` (and stop with both profiles). `--profile app` alone is unchanged: no worker, and the
instances deliver.

**When to separate it.** A delivery is a request to an address one of your tenants typed.
Separate the worker when you want those requests to leave from somewhere else than the
machines that take sign-in traffic:

- **Egress rules.** The worker's containers get the route to the internet (or to the egress
  proxy's network, the allow-list, the fixed outbound address your customers put in their
  firewalls). The API instances need none of that for webhooks.
- **Load.** A burst of events, or receivers that answer slowly, then takes CPU, sockets and
  database connections from the worker, not from the instances answering sign-ins.
- **Restarts and scaling of their own.** You can deploy, stop or resize the worker without
  touching the API, and the other way round.

A deployment with one or two instances and no such requirement gains nothing from it: leave
the default.

**What the worker is.**

- **The same image, and less of the environment than the API.** What it uses: `DATABASE_URL`
  (the runtime role), the same `TULA_MASTER_KEY` (it opens the endpoints' signing secrets),
  the same `ENVIRONMENT` (the tier the address guard judges by), `WEBHOOK_WORKER` and
  `LOG_LEVEL`. It checks its variables under the same rules as the API, so in `staging` and
  `prod` it also has to be given what those rules demand of every process, though it never
  uses them: `REDIS_URL`, `SMTP_URL`, `MAIL_FROM`, `BREACH_CHECK=hibp` and an https
  `PUBLIC_URL`. **Do not give it `TULA_ADMIN_TOKEN`**: it serves no instance route, and the
  deployment's most powerful credential should be in no container that has no use for it.
  It has no use for `OAUTH_MOCK_PROVIDER`, `SMS_PROVIDER` or the `TWILIO_*` variables (it sends no text message: **do not give it Twilio's credentials**), `CORS_ORIGINS`, `TRUST_PROXY`, `PASSWORD_POLICY`,
  `API_DOCS`, `DASHBOARD_DIR` or `INSTANCE_AUDIT_RETENTION_DAYS` either. The Compose file's
  `worker` service is given exactly the first two lists.
- **It takes no traffic.** It listens on `PORT` for `GET /v1/status` and `GET /v1/ready` and
  answers 404 to everything else: no sign-in route, no admin route, no dashboard. Do not
  publish the port and put no load balancer in front of it. `/v1/ready` checks the database
  and is what the image's health check asks.
- **It never runs migrations** and creates no signing keys. Run migrations as before, and
  start the worker after them.
- **It makes the same rounds, under the same lock.** The schedule, the retries, the guard on
  every address and the log lines (`webhook delivery round finished`) are the ones described
  in [webhooks.md](webhooks.md#how-the-server-calls-you). Like retention, the lock needs
  `DATABASE_URL` to be a direct connection or a session-mode pooler.
- **You may run several.** Each tries the lock every five seconds; one is let through and the
  others skip that round. A second worker is for availability, not for throughput.
- **Stopping it is safe.** On `SIGTERM` it starts no new round, lets the round under way
  finish the requests it is making and record them, and exits (within ten seconds, or it
  exits anyway). What it had not sent stays where it was and is sent by the next round of
  any worker. A request that was sent and not recorded is sent again: delivery is at least
  once, as always. It keeps running when the database is away: rounds fail, `/v1/ready`
  answers 503, and it carries on when the database is back.

**What does not move.**

- **Hooks stay in the API.** A [hook](hooks.md) is asked inside the sign-in or sign-up
  request that waits for its answer, by the instance serving that request. If you use hooks,
  the API instances still call your hook addresses, and their egress has to allow those.
- **Saving an endpoint still looks its address up** from the API instance (a DNS lookup of
  the host, to refuse a private address at once). No request is made to it.
- **A test event and a delivery sent again are refused.** Both are requests the API instance
  that takes the call would make itself. With `WEBHOOK_WORKER=separate` they answer
  `501 not_implemented` with `params.reason: "worker_separate"`, and nothing is sent. The
  endpoints, the delivery log and secret rotation work as before
  ([webhooks.md](webhooks.md#send-a-test-event)).
- **Retention stays in the API**, the deletion of old events and delivery records included.

**Give every process the same value, and run the worker.** The variable says where the
deployment delivers; the command says what a process is.

| `WEBHOOK_WORKER` on | Worker running? | What happens |
| --- | --- | --- |
| every process: `api` (or unset) | no | The API instances deliver. The default. |
| every process: `separate` | yes | The worker delivers; no API instance makes a request to an endpoint. |
| every process: `separate` | **no** | **Nothing is delivered.** Events wait in the outbox and are delivered, late, once a worker runs. Each API instance says at start-up `WEBHOOK_WORKER=separate: this API instance makes no webhook delivery`, and `tula doctor` fails `webhook_worker` once an event has waited a minute. The same failure is what a worker that runs and cannot keep up, or cannot work, looks like: the check reads the outbox and says so. |
| the worker: `api` (or unset) | it refuses to start | It exits with a message naming the variable: the API instances already deliver, and a worker beside them would separate nothing. |
| API instances with different values | | Not detected. The instances with `api` deliver, so the separation is not in force. Set it in one place for all of them. |

`tula doctor` ([above](#checking-a-deployment-tula-doctor)) is the check to run after the
change. Its `webhook_worker` line looks at what is waiting, not at the worker: with nothing
waiting it is `ok` whether or not a worker runs, so create an event (a test user) and run it
again a minute later, or look for `webhook delivery round finished` in the worker's log.

To go back, set `WEBHOOK_WORKER=api` everywhere (or remove it), restart the API instances and
stop the worker. Nothing is lost either way: what waits is in the database.

**Retention.** The API cleans up after itself; there is nothing to schedule. On start-up and
every ten minutes one instance (whichever takes a PostgreSQL advisory lock first; the others
skip that round) deletes:

The lock needs `DATABASE_URL` to be a direct connection or a session-mode pooler. Behind a
transaction-mode pooler (PgBouncer in `transaction` mode) retention can stop without an error.

- sign-in and sign-up attempts that have expired;
- emailed codes and links one hour after they expire;
- sessions, with their refresh tokens, 30 days after they were revoked or expired;
- authenticator enrolments that were started and never confirmed, and expired passkey
  challenges;
- entries of the **instance** audit log older than `INSTANCE_AUDIT_RETENTION_DAYS`;
- an environment's audit entries older than its `audit.retentionDays` setting, **only where
  the environment has set one**. The default is `null`: keep them for ever;
- hashes of users' previous passwords beyond what the environment's `password.history`
  keeps, after the number was lowered.

Audit entries are the one thing in this list an operator chooses to end, and their deletion
is permanent: there is no archive and nothing brings an entry back. A new or shorter period
takes effect with the next run. One run deletes at most 100,000 entries of an environment,
and a run is skipped on an instance that does not hold the lock, so a large backlog is
finished over several runs; only "for good" is certain, not how soon. Export first if you
need the older entries. The database itself refuses to delete an entry of the last day, and the API's
database role can still not change one. When entries are deleted the log has a line,
`audit entries past the retention period deleted`, with the environment's id, the period
and the count. **Keep those logs.** The audit entry that says who set or shortened the
period (`environment.settings_updated`, `weakened: true`) is deleted like any other once it
is older than the period, so after that the server's log is the only record that entries
were deleted and under which period. The entries' outbox events are not deleted.

It also deletes what the webhook worker leaves behind, on fixed periods: an outbox event 30
days after the worker settled it, and the record of a delivery (with every request made for
it) 90 days after it was queued, once it has ended. An event that a delivery still pending is
of is kept. See [webhooks.md](webhooks.md#what-the-server-keeps). The counts of text messages by destination
([phone-numbers.md](phone-numbers.md#what-was-sent-and-what-was-never-used)) go 90 days after their day. Each run logs one line, `retention run finished`, with
counts only (at `debug` level when there was nothing to delete). The other periods are fixed
for now. See [ADR 0017](adr/0017-retention.md).

**Health.** `GET /v1/status` answers while the process is up; `GET /v1/ready` also checks the
database, and Redis when it is configured, and is what the image's health check and a load
balancer should use. A [webhook worker](#the-webhook-worker-as-its-own-service) answers the
same two paths and nothing else; its `/v1/ready` checks the database.

**The image.** It runs as the unprivileged `bun` user and listens on 3003. It contains the
API's sources, the two workspace packages the API imports (`packages/db`, with the migrations
and the seed, and `packages/contract`), the built dashboard (`apps/dashboard/dist` only), the
migration, seed and key scripts, and the production dependencies of those; no tests, no
browser-test fixture (`e2e/`), no browser package (React, Next.js, the SDKs' components or
the examples) and nothing of the dashboard's toolchain. Its base image is pinned by digest, as are the
PostgreSQL, Redis and Mailpit images in the Compose file, so a rebuild next month starts from
the same bytes as today's; Dependabot proposes the updates. Build it from the repository root:

```bash
docker build -f apps/api/Dockerfile -t tula-api .
```

## Upgrading

Back up the database, apply the migrations as the **owner** (`DATABASE_MIGRATION_URL`, see
[Migrations](#running-it-for-real)), then start the new version. Migrations only move forward.
Every migration from `0006` on is additive (new tables, new columns with defaults, a
constraint, a function, a grant), so with several instances the old version keeps running
while they are applied and the instances can then be replaced one at a time. `tula doctor`
reports whether the database is at the version the running image ships.

| Migration | What it does | What you do |
| --- | --- | --- |
| `0006` API keys | Ties each API key's project to its environment with a foreign key. | Nothing. It fails only if a key row was written by hand with a project that is not its environment's. |
| `0007` environment settings | The table behind `GET`/`PUT /v1/admin/settings`. | Nothing. Every environment starts at revision 0 with the defaults, including your `PASSWORD_POLICY` and `CORS_ORIGINS`, until it saves a document. |
| `0008` attempt secret | Every sign-up, sign-in and reset attempt now has a secret its client must present. | Nothing. Attempts in flight during the upgrade (they live ten minutes) cannot be continued: the user starts again. Clients must be on an SDK that sends `x-tula-attempt`. |
| `0009` two-step verification | Tables for authenticator secrets and backup codes. | Decide the policy: `mfa.policy` is `optional` unless you set it, which lets users turn it on. From here on, **changing `TULA_MASTER_KEY` breaks every user's second factor**. |
| `0010` OAuth | The provider credentials table, and a unique key on `identities (user_id, provider)`. | It stops with an error if a user already has two identities of one provider. Tula never created such rows; if the table was ever written by hand, check as the owner first and remove the extras: `select user_id, provider, count(*) from tula.identities group by 1, 2 having count(*) > 1;` (no rows means it will apply). |
| `0011` passkeys | Tables for passkeys and their challenges. | Nothing. Passkeys stay off until an environment sets `passkeys.rpId` and switches the method on. |
| `0012` session profiles | A `type` on every session (`hybrid` for the existing ones). | Nothing. Existing sessions keep their lifetimes; the `sessions` settings start at the previous fixed values (60 seconds, 7 days idle, 30 days in all). |
| `0013` managed by | Records which config file last applied an environment's settings (`tula apply`). | Nothing. |
| `0014` diagnostics | A function, owned by the schema owner, that tells the API which migrations are applied (for `tula doctor`). | Nothing, as long as migrations run as the owner and the API as a member of `tula_app`: the function is how the non-owner role reads that one fact. |
| `0015` instance audit log | The log of dashboard sign-ins and of workspaces, projects and environments being created. | Nothing. It is written only where `TULA_ADMIN_TOKEN` is set. |
| `0016` instance audit retention | Lets the API delete instance audit entries older than `INSTANCE_AUDIT_RETENTION_DAYS` (default 365, at least 30). | Set the variable if a year is not what you want. |
| `0028` native apps | A table for an environment's iOS and Android apps ([native-apps.md](native-apps.md)). Empty after the migration. | Nothing to do, and no quiet window needed: one new, empty table with its own grants; no existing table is touched. Two public routes exist from this version on (`/v1/environments/<id>/.well-known/apple-app-site-association` and `…/assetlinks.json`); until an app is registered they answer `{}` and `[]`. Three event types exist that a webhook endpoint can subscribe to (`native_app.created`, `native_app.updated`, `native_app.deleted`). |
| `0027` phone number lookup | An index on `users` by phone number, for [signing in with a texted code](methods/sms-code.md). No data changes and nothing is on by default. | The index is built inside the migration's transaction (a plain `CREATE INDEX`), which takes a write lock on `users` while it builds: sign-ups and profile changes wait for it. It covers only the rows that have a phone number, so it is quick on most deployments; on a very large `users` table run the migration in a quiet window. |
| `0029` password age | `credentials` gains `secret_changed_at`: when the password was last set, which the server's re-hashing of a password does not move. Existing rows get the time their row was last written. Password expiry ([methods/password.md](methods/password.md#security-properties-and-limits)) is counted from it. | **Check `password.expiryDays` of each environment, and `PASSWORD_POLICY`, before you upgrade: the number is enforced from this version on.** It was stored and ignored before, and the `legacy` preset has it at 90. A user whose password row was last written longer ago than the period is asked for a new password at their next sign-in with it; nobody is signed out and no email is sent. Set it to `null` first if that is not what you want. **Upgrade your clients before the server**: an app built on a `@tula/react` or `@tula/core` older than this release shows "This step is not supported" where the new password is asked for, so a user with an expired password cannot sign in through it; or keep `expiryDays` at `null` until every client is upgraded. The migration rewrites every row of `credentials` once, under a lock on the table: sign-ins with a password wait for it. |
| `0026` password history | A table for the hashes of users' previous passwords ([methods/password.md](methods/password.md#security-properties-and-limits)). | Check `password.history` of each environment, and `PASSWORD_POLICY`: **the number is enforced from this version on**. It was stored and ignored before, and the `strict` preset has it at 5. The history starts empty: only passwords changed after the upgrade are remembered. |
| `0022` session hook claims | Where the claims of a `before_token` hook are kept ([hooks.md](hooks.md)): `sessions` gains `hook_claims` (JSON, empty for every existing session) and a check that it is an object of at most 4,096 bytes. No grant changes: the API's role already reads and writes that table. | Nothing to do, and no quiet window needed: one nullable column is added without rewriting the table, and the check passes for every existing row (they hold nothing). Sessions that exist keep working and carry no hook claims; they get them, where a `before_token` hook is registered, at their next sign-in or step-up, not at a refresh. From this version on two more hooks can be registered (`before_session`, `before_token`), `session.created` events and audit entries may carry `hookBypassed: true` and `claimsHookBypassed: true`, and `session.stepped_up` may carry `claimsHookBypassed: true`. **Roll back with care**: an earlier version ignores the column, so a session's hook claims silently stop being issued; and a hook registered for one of the two new points is a row an earlier version does not know, and its list of hooks may fail on it (remove those hooks before rolling back; this was reasoned from the code, not tried). |
| `0021` hooks | A table for hooks ([hooks.md](hooks.md)): the endpoint an environment has the server ask before a sign-up creates an account. Empty after the migration: nothing is asked until an operator registers one. | Nothing to do, and no quiet window needed: one new, empty table with its own grants; no existing table is touched. Sign-up behaves exactly as before until a hook is registered. From this version on `user.created` events and audit entries may carry `hookBypassed: true`, and three event types exist that a webhook endpoint can subscribe to (`hook.created`, `hook.updated`, `hook.deleted`). |
| `0020` webhook secret rotation | An endpoint's signing secret can be replaced with an overlap ([webhooks.md](webhooks.md#rotate-a-secret)): `webhook_endpoints` gains `previous_secret` and `previous_secret_expires_at`, both empty for every existing endpoint, and a check that the two are set or empty together. No grant changes: the API's role already updates that table. | Nothing to do, and no quiet window needed: two nullable columns are added without rewriting the table, and the check is validated against a table of at most ten rows per environment. **Existing secrets are untouched and keep signing**: a secret sealed by an earlier version opens exactly as before. Until an endpoint is rotated for the first time, nothing about its deliveries changes. From this version on a delivery may carry **two** signatures in `webhook-signature` (during a rotation's 24 hours); a receiver that uses `verifyWebhook` or a Standard Webhooks library already reads that. `verifyWebhook` now also takes a list of two secrets. |
| `0019` webhook retries | Webhook deliveries are retried and logged ([webhooks.md](webhooks.md#retries)): the delivery table gains a state and a schedule, a new table holds every request made, and endpoints gain `failing_since`, `last_failed_at` and `disabled_reason` (empty for existing endpoints). The API's role loses `UPDATE` on `events` but for one column, and gains two bounded `DELETE`s for the retention job. | **Apply it in a quiet window if the outbox is large.** It builds one more index on `events` and takes short exclusive locks on that table (a policy, and lifting and restoring forced row-level security around a backfill), all held until the migration commits; inserts into `events`, which every sign-in, sign-out and admin change makes, wait until then. Nothing is built `CONCURRENTLY` (migrations run in a transaction). `webhook_deliveries` is rewritten in place: existing rows keep their outcome, and each request becomes the first entry of the new log. **From this version on the retention job deletes**: an event 30 days after the worker settled it, and an ended delivery 90 days after it was queued. The 30 days count from when an event was settled, not from when it happened: the backlog a deployment had when it first ran the worker (`0018`) was settled then, and goes 30 days after that, up to 100,000 events per environment per run. Those events were never sent to anyone (no endpoint existed). Their audit entries are separate and are not touched. |
| `0018` webhooks | Tables for webhook endpoints and the record of their deliveries; a unique key and a different index on `events`, the outbox. Starts the delivery worker ([webhooks.md](webhooks.md)). | **Apply it in a quiet window if the outbox is large.** The unique key and the index are each built under a lock that blocks inserts into `events`, and every sign-in, sign-out and admin change inserts an event: those requests wait until both are built (they are not built `CONCURRENTLY`; migrations run in a transaction). The first start of the new version then marks every event recorded so far as settled, in bulk (up to 100,000 per environment every five seconds), sending none of them: no endpoint existed when they happened. |
| `0017` audit retention | Lets the API delete an environment's audit entries older than its `audit.retentionDays` setting, and adds a database rule that no entry of the last day can be deleted. Until this version the setting was stored and did nothing. | **Check the setting in every environment before you upgrade.** One that already holds a number starts deleting older entries, for good, with the first retention run of the new version (at start-up; a large backlog takes several runs). `null` (the default) keeps everything, as before. |

Settings added since Phase 0 that a deployment behind a proxy or with several instances should
look at: `REDIS_URL` (required in `staging` and `prod`), `TRUST_PROXY`, `TULA_ADMIN_TOKEN`,
`API_DOCS` (off by default in `staging` and `prod`), and for a Next.js app in front,
`TULA_TRUSTED_PROXY_HOPS` on the app's server.

## Housekeeping

**Old API keys.** An environment holds at most 100 active keys and 1,000 in total, revoked ones
included, because the API cannot delete keys. If you reach the total, remove revoked keys as the
schema owner (nothing else refers to them):

```sql
DELETE FROM tula.api_keys WHERE environment_id = '<environment id>' AND revoked_at IS NOT NULL;
```

## Not there yet

- No published image; build it from source.
- Text messages through Twilio have never been delivered to a real phone from this code, and
  there is no delivery receipt: "sent" means Twilio accepted the message
  ([Text messages with Twilio](#text-messages-with-twilio)). Twilio is the only provider.
- Audit entries are kept for ever unless an environment sets `audit.retentionDays`. (Outbox
  events and the record of webhook deliveries have fixed periods: 30 and 90 days.)
- The periods and the schedule of webhooks are fixed, not settings: eight requests over a day
  and a few hours, then the delivery is given up; an endpoint that takes nothing for five
  days is switched off ([webhooks.md](webhooks.md#what-can-still-be-lost)).
- A `TULA_MASTER_KEY` that does not match the stored signing keys does not stop the server. It
  logs `signing keys are unusable in some environments` at start-up, and sign-in fails in those
  environments until the right key is restored.
