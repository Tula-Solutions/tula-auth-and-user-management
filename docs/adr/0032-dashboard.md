# ADR 0032 — The dashboard: its session, the admin API through it, the control plane, and how it is served

- Status: accepted
- Date: 2026-10-04

## Context

Step 1.15 of the Phase 1 plan is the dashboard: a single-page app for the operator of a
deployment, served by the API itself at `/dashboard`. The plan's decision 3 says the operator
signs in with the instance admin token (`TULA_ADMIN_TOKEN`, ADR 0031) "exchanged for a short
dashboard session", and that the workspace- and project-level routes it needs are part of the
step. This ADR covers the server side: everything the app needs from the API.

A browser is a different caller from a server. It must not hold the admin token, it attaches
cookies by itself whoever wrote the page, and what it is allowed to load is decided by the
headers its page is served with.

## Decision

### The dashboard session

`POST /v1/instance/session` takes the admin token **once**, in a JSON body, and answers with a
cookie. The app keeps the token only as long as the sign-in form is open; it never reaches
storage or a URL.

- **Stateless and signed.** The cookie's value is
  `v1.<base64url JSON { sid, iat, exp }>.<HMAC-SHA256 hex>`. The key is derived from
  `TULA_MASTER_KEY` (`~/lib/keyed-hash`, purpose `dashboard-sessions`), and the MAC covers the
  payload **and the digest of the current admin token**. Nothing is stored, so every instance
  of a deployment honours it at once (same master key, same token).
- **Rotation ends every session.** Changing `TULA_ADMIN_TOKEN` or `TULA_MASTER_KEY` changes
  what the MAC is computed over, so every cookie made before stops verifying. The token's
  digest is an input of the MAC only: no fingerprint of it is in the cookie. (The plan put a
  fingerprint in the payload; in the MAC it does the same job and nothing derived from the
  token leaves the server.)
- **Eight hours, absolute.** `exp = iat + 8 h`; nothing refreshes or extends it, and the
  verifier refuses a payload that claims more, even correctly signed.
- **Accepted trade-off: no revocation of one session.** Signing out clears the cookie in that
  browser; a copy made elsewhere stays valid until it expires. It is bounded by the eight
  hours and by rotating the token, which is the response to a stolen session. A server-side
  session list would need a store every instance shares and would make the dashboard depend on
  it; with one operator credential per deployment, rotation is the revocation that matters.
- **The cookie.** `tula_dashboard` (`__Secure-tula_dashboard` over https), `HttpOnly`,
  `Secure` over https, `SameSite=Strict`, no `Domain`, `Max-Age` eight hours. A cookie has one
  `Path`, and the narrowest single path that covers `/v1/instance` and `/v1/admin` is `/v1`,
  which would also send it to `/v1/client/*` and the API reference. So it is set **twice**,
  with the same name and value: `Path=/v1/instance` and `Path=/v1/admin`. The browser sends it
  to those two route groups and to nothing else, not even to the dashboard's own files.
- **Sign-in is guarded like the token.** The route does not exist without `TULA_ADMIN_TOKEN`
  (404 before anything is counted); every request is counted before the token is looked at,
  in a bucket of its own (`instance_session`: 10 a minute per IP, refused when the limiter
  cannot count), so that guesses at the form cannot stop the CLI's instance calls and a busy
  CLI cannot lock the operator out; the comparison is of SHA-256 digests in constant time; a
  wrong token, a missing one, a body that is not the expected shape and a body that cannot
  be read at all (empty, not JSON, not sent as JSON) get the same `auth.invalid_key`, never
  a 400 or a 422: the body is read in the handler, not by a validator. The token is not
  accepted from the `Authorization` header or the query on this route.
- **`TRUST_PROXY` decides what "per IP" means.** Behind a proxy without it, every client is
  the proxy's address and shares one bucket (and one audit sample, below).
- **Audited.** `instance.signed_in` (actor id = the new session's id), `instance.sign_in_failed`
  (no actor id) and `instance.signed_out` go to the instance audit log (below), with the IP and
  user agent and nothing of what was presented. The sign-in is recorded **before** the cookie
  is set: no session without its entry.
- **Failed sign-ins are sampled.** The log is append-only and anyone who can reach the API can
  fail a sign-in, so one entry per failure would let them grow the table. The first failure
  of a minute from an address is written, with `data.suppressedInPreviousMinute`: how many
  failures from that address in the minute before were not written one by one (a count that
  reaches back one minute, no further). The tally lives in the rate limiter, so instances
  share it, under a keyed hash of the address (`~/lib/keyed-hash`), never the address. A
  limiter that cannot count means the entry is written. Successful sign-ins and sign-outs
  are always recorded.
- `GET /v1/instance/session` answers `{ expiresAt }` or `auth.unauthenticated` (the app's
  start). `DELETE` clears both cookies; it is idempotent and needs no valid session.

### Cross-site request forgery

Every request authenticated by the cookie must satisfy all of these, checked before the cookie
is read (`~/middleware/dashboard-session`):

1. **The custom header `x-tula-dashboard: 1`.** A form cannot send it, and a cross-origin
   `fetch` may send it only after a preflight, which the API answers for the deployment's own
   origins alone (`/v1/admin/*` and `/v1/instance/*` follow `CORS_ORIGINS`, never an origin a
   tenant put in its settings; ADR 0031). Without the header the cookie is **ignored**: the
   request is simply not signed in. This is required on reads too, which is stricter than the
   plan asked and costs the app nothing.
2. **`Origin`**, when present, is the API's own (`PUBLIC_URL`: the dashboard is served by the
   API) or on the deployment's `CORS_ORIGINS`, **in every tier**. The `local` tier's "any
   loopback origin" rule, which the rest of the API applies, is not applied here: cookies are
   not scoped by port, so any other web app on the developer's machine could otherwise use a
   signed-in session. `bun run dashboard:dev` still works out of the box: Vite's dev proxy
   presents the API's origin for calls from the dev page's own origin and passes any other
   origin on untouched (`apps/dashboard/src/lib/dev-proxy.ts`). A request that changes state **must have** an
   `Origin`: browsers send one on every such request, so one without it is not a page's fetch.
3. **`Sec-Fetch-Site` is not `cross-site`.**

A refusal is `request.origin_not_allowed` (403) and happens before any state changes and
before any `Set-Cookie`. Each leg alone stops a forged request: `SameSite=Strict` keeps the
cookie off requests another site started; the header cannot be sent cross-origin without a
preflight the API refuses; the `Origin` check does not depend on the browser honouring either.
A sibling subdomain of the same site (which `SameSite` does not stop) fails legs 1 and 2. The
sign-in route applies the same three legs before the token is looked at, so a foreign page
cannot make a browser the operator of its choosing.

### The admin API through the session

`/v1/admin/*` is not duplicated. `secretKey()` (the one middleware every admin route already
uses) now accepts either credential:

- a **secret key**, exactly as before; or
- a **dashboard session** plus `x-tula-environment: <environment id>`: the tenant is that
  environment and the project of its own row. The operator's authority covers every
  environment of the deployment, so any that exists resolves. A malformed id and an unknown
  one are the same 404, and never reach a store; without a valid session nothing is told
  about environments at all (401 first).

A request that carries `x-tula-dashboard` is the dashboard's and is authenticated by the
cookie or not at all. **The two are never mixed:** the dashboard header or the environment
header together with an `Authorization` header is refused (400 `request.malformed`), so a key
can never act on an environment a header chose and a session never lends itself to a key.

**Changed from the plan:** "both present" is decided by the dashboard's *headers*, not by the
cookie. A browser attaches the cookie to every same-site request under its path by itself, so
refusing a secret key whenever a cookie happens to be present would break any same-origin tool
that uses a key (the API reference at `/v1/docs`) while an operator is signed in, and would
make an ambient cookie change the meaning of a key's request. A bare cookie beside a secret key
is ignored; the key alone decides.

**The actor.** `adminActor(c)` answers `{ type: 'instance_admin', id: <session id> }` for a
dashboard request, so every audit entry in an environment's log shows that the dashboard did
it, and which sign-in. `GET /v1/admin/audit-logs` gains `actorType` (and `from` / `to`).
`Tenant.apiKeyId` is empty for such a request, so "a key cannot revoke itself" does not apply:
the dashboard can revoke any key of an environment, including its last secret key.

**One meaning per credential.** The admin token itself is not accepted on `/v1/admin/*`
(`auth.invalid_key`); a secret key is not accepted on `/v1/instance/*`. The token authorizes
the instance routes and the sign-in; an environment is reached with its key or through a
session.

`instanceAdmin()` accepts the bearer token (as in ADR 0031, counted in the instance bucket) or
a dashboard session (counted in the admin bucket: 300 a minute, since a UI makes several calls
per page and the cookie is not a guessable secret).

### The control plane

New routes under `/v1/instance/*`, on a new port (`ports/control-plane.ts`, memory and
Postgres adapters, one behaviour suite):

| Route | What |
| --- | --- |
| `GET /workspaces`, `POST /workspaces` | List (oldest first), create. |
| `GET /projects?workspaceId=`, `POST /projects`, `PATCH /projects/:projectId` | List, create, rename. |
| `GET /environments?projectId=`, `POST /projects/:projectId/environments` | List, add the missing kind. |
| `GET /audit-logs` | The instance audit log. |

- Lists page with `page` and `size` and answer `{ meta, data }`, as every list of the API.
  (The plan said cursor pagination for the audit log; the API's lists are all page-based and
  one more convention was not worth it. A cursor can be added without breaking `page`.)
- **A new project gets a development and a production environment** in the same transaction,
  as the seed does, and each environment its first signing keys right after it
  (`Jwks.ensureKeys`; they are the one unrecorded write of ADR 0012, and an environment without
  them gets them on first use or at the next boot). That step runs after the commit, so a
  failure in it is logged and the answer is still 201: a 500 for a project that exists would
  make the caller create a second one. A
  project holds one environment of each kind (a unique constraint), so
  `POST …/environments` only ever adds the kind a project lacks, and a second one is
  `resource.conflict`. No API key is minted: the dashboard creates one with
  `POST /v1/admin/api-keys` for the environment, where it is shown once.
- **Creating a workspace** was not in the plan. It is here because a deployment that was never
  seeded has none, and a project needs one: without it the dashboard would be a dead end.
- **The instance audit log** (`tula.instance_audit_logs`, migration `0015`) records what has no
  environment: the session events above, `workspace.created`, `project.created`,
  `project.renamed` (the key that changed, never the name), `environment.created`. Control
  plane: no tenant columns and no RLS, like `workspaces`; the runtime role may `SELECT`,
  `INSERT` and, for the retention job only, `DELETE` (migration `0016`), never `UPDATE`.
  Entries are kept for `INSTANCE_AUDIT_RETENTION_DAYS` (default 365, at least 30) and then
  deleted in batches by the retention job (ADR 0017). An environment's audit log has no such
  period and is never deleted. Each entry is written in the same transaction as its change. Names are free
  text an operator typed and never go into an entry.
- **Left out:** deleting or archiving a workspace, project or environment; renaming a
  workspace; moving a project. Deletion cascades through every tenant table and needs its own
  design (confirmation, retention, what happens to live sessions).

### What the dashboard's screens use

Already there and reachable through the session: users (list with `q`, a substring of the
email or a name; detail; create; delete; ban and unban; set a password; reset factors), API
keys (list without the key, create shown once, revoke), signing keys (list with status,
rotate, which respects `NEXT_KEY_MIN_AGE_MS`), settings (with `managedBy`), OAuth providers,
the audit log.

Added: `GET /v1/admin/users/:userId/sessions` (a user's active sessions, no token material,
`current` always false) and `DELETE /v1/admin/users/:userId/sessions/:sessionId` (end one,
reason `revoked_by_admin`, through the session service so the id is denylisted); the
audit log's `actorType`, `from` and `to`; and `GET /v1/admin/users/:userId/authentication`
(how a user signs in: `hasPassword`, `emailVerified`, linked providers, confirmed factors,
backup codes left, passkeys, all read through the modules that own them and never a secret,
a credential id or a provider's account id; `no-store`). Its `canSignInWithoutPasskeys` is
the answer the factor reset would give now, so the dashboard warns **before** a reset that
would lock the user out; the reset's `x-tula-can-still-sign-in` header is still what it
reports afterwards.

Not added: an "email a password reset" action for an admin. What exists is
`PUT /v1/admin/users/:userId/password` (ADR 0010); the user's own "Forgot password" is the
other path. An admin never sees a password.

### Serving the app

`~/lib/dashboard-files` serves a build directory at `/dashboard` (`GET` and `HEAD`).

- **Only where a build is present.** `DASHBOARD_DIR`, or `apps/dashboard/dist` next to the API
  when unset. A directory that does not exist or has no `index.html` means no dashboard: the
  paths are not routed and answer the API's own 404. The image without the app works as
  before, and tests need no build.
- **A path never leaves the directory.** The raw path is decoded once; a NUL, a backslash, an
  absolute path or a segment starting with a dot is refused; the path is resolved and must stay
  under the root; then its real path (links followed) must stay under it too. Refused means
  404, never the app.
- **Fallback.** A path that is not a file and whose last segment has no extension is a route
  of the app and gets `index.html`. A missing file **with** an extension is a 404: a missing
  script must not be answered with HTML.
- **Caching.** `index.html`: `no-store`. `assets/*` (hashed names): `public, max-age=31536000,
  immutable`. Anything else: `no-cache`.
- **Headers on every response under `/dashboard`, errors included:**
  `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self';
  img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none';
  frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Cross-Origin-Opener-Policy: same-origin`, `X-Frame-Options: DENY`. No inline script or
  style and no `eval`: an injected script could neither run from markup nor send what it read
  to another origin. A type the table does not know is `application/octet-stream`.

The app must therefore be built with `base: '/dashboard/'`, no inline scripts or `<style>`
tags, and call the API on its own origin.

### The API reference page

`/v1/docs` is HTML on the same origin as the dashboard, and the session cookie's path
(`/v1/admin`, `/v1/instance`) does not stop a script running in that page from calling those
routes. So the page is held to the dashboard's standard:

- **No third-party script.** The reference (Scalar) is no longer loaded from a CDN. Its
  single-file browser bundle is served by the API from the installed, lockfile-pinned npm
  package (`@scalar/api-reference`, an exact version in `apps/api/package.json`) at
  `/v1/docs/assets/api-reference-<version>.js`, cacheable for good because the path names the
  version. The page's two small scripts (settings before the bundle, the call that starts it)
  are files too.
- **A policy.** `default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self'
  data:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action
  'none'; frame-ancestors 'none'`, with `nosniff`. Inline *style* is allowed because the
  bundle injects its stylesheet at run time; script never is. Scalar runs under it: the
  browser test loads the page with a dashboard session in the same browser and fails on one
  violation, one console error or one request to another host. Two things made that true:
  the hosted fonts, proxy, telemetry, assistant and developer toolbar are switched off, and
  `jitless` is set on Zod's global settings before the bundle loads (its own copy of Zod
  otherwise probes `new Function`).
- **A switch.** `API_DOCS` (`on` | `off`) defaults to on in the `local` and `dev` tiers and
  off in `staging` and `prod`. Off, the page and its scripts are unknown paths (404);
  `/v1/openapi.json` is served either way.
- **Every HTML answer of the API has a policy.** The pages are the dashboard, this one, the
  mock provider's consent page and the "sign-in could not be completed" page of an OAuth
  callback. A test walks the route table with everything mounted and fails for an HTML
  response without a Content-Security-Policy, with one that allows script from another
  origin, or without `nosniff`.

### What the app remounts

TanStack Router keeps a route's component when only a path parameter changes. Local state
would then survive a switch: a settings draft made in development saved to production (with
development's `If-Match`, which passes when the revisions happen to match), a provider secret
typed for one environment written to another, a confirmation opened for one user acting on
the next.

- Everything under the environment route is keyed by the environment id
  (`EnvironmentGate`), the workspace screen by the workspace id and the user screen by the
  user id. A project switch is always an environment switch.
- Keys of items that hold form state include the environment id (`ProviderCard`).
- The settings editor's document and draft carry the environment they were loaded for; the
  query is keyed by it; shown for another environment they are dropped, and a save is refused
  when the selection (where the request would go) is not that environment. This holds without
  the remount.
- The shell is never remounted, so its dialogs ("create project", "add environment") are
  bound to the workspace or project they were opened in and close when it changes.

## Consequences

- A deployment that sets `TULA_ADMIN_TOKEN` gains a browser sign-in for it. The token's
  strength (ADR 0031) and the instance rate limit are what stand in front of it.
- `@tula/admin` is unchanged in meaning: the generator leaves the three session operations out
  by name, and any other instance operation without the token still fails the generation.
- `AUDIT_ACTOR_TYPES` gains `instance_admin` (a text column: no migration).
- The dashboard's session works across instances without Redis.

## Not done here

- Conformance scenarios for the session and the control-plane routes: they need the
  deployment's admin token and a cookie carried between steps, which the scenario format does
  not have (no `instance` credential kind was added). Scenarios 44 and 45 cover what is
  observable without it (the new admin session routes, the audit filters, and the credential
  rules of a dashboard request that has no session); the rest is covered by route tests and
  the live checks of this step.
- Operator accounts, roles and per-workspace permissions (the V2 control plane).
- The Dockerfile's dashboard build stage: it arrives with the app.
