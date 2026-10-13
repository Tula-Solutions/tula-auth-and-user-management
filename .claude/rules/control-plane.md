---
paths:
  - "apps/api/src/modules/control-plane/**"
  - "apps/api/src/modules/instance/**"
  - "apps/api/src/middleware/instance-admin*"
  - "apps/api/src/middleware/dashboard-session*"
  - "apps/api/src/lib/dashboard-*"
  - "apps/api/src/lib/api-docs*"
---

# The dashboard's session, the control plane and the instance

Moved here from `AGENTS.md`, word for word, and canonical for this area: `AGENTS.md` lists
this file under "Area rules" and does not repeat it. A section named in a sentence as
"above" or "below" is found through that list.

## The dashboard's session and the control plane (see ADR 0032)

- **The browser never keeps `TULA_ADMIN_TOKEN`.** `POST /v1/instance/session` exchanges it
  once for a stateless signed cookie (`~/lib/dashboard-session`: HMAC over the payload and the
  admin token's digest, key from `TULA_MASTER_KEY`; 8 hours, never extended). Rotating the
  token or the master key ends every session; one session cannot be revoked alone.
- **Cookies only through `~/middleware/dashboard-session`**: `HttpOnly`, `SameSite=Strict`,
  `Secure` and `__Secure-` over https, set twice (`Path=/v1/instance` and `Path=/v1/admin`),
  never `/` or `/v1`.
- **A dashboard request is one that carries `x-tula-dashboard`.** It is authenticated by the
  cookie or not at all, under the three CSRF rules (`requireDashboardOrigin` plus the header:
  the API's own origin or `CORS_ORIGINS`, an `Origin` on anything but a read, not
  `Sec-Fetch-Site: cross-site`), checked before the cookie is read. It never carries
  `Authorization`: the two credentials are refused together. Without the header a cookie
  means nothing. The origin rule is exact in **every** tier: never apply the `local` tier's
  "any loopback origin" rule (`allowedOrigin`) to a cookie-authenticated request, because
  cookies are not scoped by port. `vite dev` works through its proxy
  (`apps/dashboard/src/lib/dev-proxy.ts`).
- **The actor is `instance_admin`** with the session's id (`adminActor(c)` on admin routes,
  `instanceActor(c)` on instance routes; a `null` id for the bearer token itself).
- **What has no environment is recorded in the instance audit log** (`deps.controlPlane`,
  `tula.instance_audit_logs`): every control-plane write takes its `InstanceActivity`
  (`ControlPlane.entry`) and stores both or neither. Never a name, a token or an email in one.
- **A new instance operation takes the instance token** (`openapi.security.instance`); the
  admin client's generator fails otherwise. Only the three session operations are a browser's
  alone, by name (`BROWSER_ONLY_INSTANCE_OPERATIONS`).
- **The sign-in answers one way and is counted by itself.** `POST /v1/instance/session` reads
  its body in the handler: wrong, missing, malformed and unreadable are the same 401
  `auth.invalid_key`. It has its own per-IP bucket (`dashboardSignInRateLimit`), apart from the
  bearer token's. Failed sign-ins are recorded through `ControlPlane.recordFailedSignIn`: one
  entry a minute per address with a count, tallied in the rate limiter under a keyed hash of
  the address. Never write one entry per failure to an append-only table from a route anyone
  can call.
- **The instance audit log has a retention period** (`INSTANCE_AUDIT_RETENTION_DAYS`, default
  365; `ControlPlane.deleteAuditBefore` from the retention job). An environment's audit log
  has the period the environment set (`audit.retentionDays`; see "Data & tenancy").
- **Every HTML response has a Content-Security-Policy that allows no script from another
  origin, and `nosniff`.** The API reference (`/v1/docs`, `~/lib/api-docs`) is served only
  where `API_DOCS` is on (default: `local` and `dev`), from the installed, exactly pinned
  `@scalar/api-reference` package, under `API_DOCS_CSP`: never a CDN, an inline script or
  `unsafe-eval`. `lib/api-docs.test.ts` walks the route table and fails for an HTML response
  without such a policy; a new page must pass it.
- **Work after a commit must not fail the answer.** `Jwks.ensureKeys` for a new environment
  runs after the transaction: a failure is logged and the creation is still answered 201
  (the keys are made on first use and at boot). A 500 there makes the caller create a second
  project.
- **Static files**: every path is decided by `resolveDashboardFile` (resolve, prefix check,
  real path, prefix check again). Never serve a file by any other route, and never loosen
  `DASHBOARD_CSP` to allow inline script, `eval` or another origin.

## Security rules (non-negotiable)

- **The instance admin token is the most powerful credential of a deployment.** The
  configuration holds only its SHA-256 (`config.instanceAdminTokenHash`); `instanceAdmin()`
  answers 404 when none is configured (before anything is counted), counts every request per
  IP and refuses when the limiter cannot count, then compares digests in constant time and
  answers the same `auth.invalid_key` for missing and wrong. A new instance route goes behind
  it and nothing else. `env.ts` refuses a short, repeated, sequential or placeholder value at
  boot (`looksTyped`): a floor against accidents, not a measure of randomness, so the token
  is always generated (`openssl rand -hex 32`). CORS treats `/v1/instance/*` like
  `/v1/admin/*`: the deployment's `CORS_ORIGINS` only, never an environment's origins.
- **A diagnostic check answers with fixed text.** `modules/instance` logs a probe's failure
  reason (`errorReason`) and returns only `ok`/`warn`/`fail`/`skipped`, a fixed summary and a
  fixed fix: never a connection string, a host with credentials, key material or a driver's
  message. A new check gets a canary test (a failing probe whose error carries a recognisable
  string that must not reach the response) and a row in ADR 0031's table. The only origin
  the server fetches is its own `PUBLIC_URL` (its `/v1/status`, and the association files of
  at most `NATIVE_APP_FILES_FETCHED` of its own environments, on a path built from an id the
  server made), never an address from a request, a setting or a stored row. A check never claims more
  than it looked at (the `master_key` check warns past `MAX_ENVIRONMENTS_CHECKED`). A check
  that makes many store calls takes the deadline's `AbortSignal` and looks at it between
  them, the scan is never started on top of one still running, and concurrent callers share
  one run (`Instance.diagnostics`): keep all three.
