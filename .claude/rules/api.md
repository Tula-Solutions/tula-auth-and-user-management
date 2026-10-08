---
paths:
  - "apps/api/**/*.ts"
---

# API rules (apps/api)

- New feature = new folder `src/modules/<kebab-name>/` with `router.ts`, `service.ts`,
  `schema.ts`, `service.test.ts`. Use `/new-module` to scaffold it.
- Services take `deps` (or `Pick<Deps, ...>`) first. Never import a database client, Redis client,
  SMTP library or `fetch` into a service. Go through a port in `src/ports/`.
- New infrastructure means a port interface + a memory adapter + the real adapter. Wire it only in
  `src/container.ts` and `createTestDeps()`.
- Routers stay thin: `describeRoute()` → `validator()` → auth middleware → one service call →
  `c.json(Schema.parse(result), status)`.
- `/v1/client/*` routes require `publishableKey`; `/v1/admin/*` require `secretKey`. Session-scoped
  client routes also use `sessionAuth`.
- `secretKey()` is the only way in to an admin route: it takes a secret key **or** a dashboard
  session with `x-tula-environment` (ADR 0032). `admin-via-dashboard.test.ts` enumerates the
  app's admin routes and fails for one that is guarded any other way. Build the actor with
  `adminActor(c)`, never by hand: it is what marks a dashboard change as `instance_admin`.
- `/v1/instance/*` routes use `instanceAdmin()` (the admin token or a dashboard session),
  `instanceActor(c)`, and record their writes through `deps.controlPlane` with an
  `InstanceActivity` in the same transaction.
- A route that returns HTML sets a Content-Security-Policy that allows no script from another
  origin (`lib/api-docs.test.ts` walks the route table). Never load a page's script from a
  CDN: serve it from an installed, exactly pinned package.
- A cookie-authenticated request is checked against exact origins (`requireDashboardOrigin`),
  never `allowedOrigin`'s loopback rule.
- Whatever runs after a transaction has committed (first signing keys) logs its failure and
  lets the answer stand.
- A background job is a service function `server.ts` starts on boot and on a timer on every
  instance, under `deps.jobLock.runExclusive(<its own job name>, …)`; a new job gets a new id
  in `JOB_LOCK_IDS` (never renumber). It serves environments one at a time and a failure in
  one is logged and skipped (`modules/retention`, `modules/webhook`).
- A route that makes the server call an operator's address on demand (a webhook test event,
  a delivery sent again) has a per-environment rate limit of its own, mounted after
  `secretKey()`, and answers only the outcome, a status code and a duration.
- A route that hands out a secret (a webhook endpoint's registration, a secret rotation)
  takes none from the request, answers it once with `Cache-Control: no-store`, and no other
  route returns it or any part of it. A webhook delivery is signed only in the service's
  `signatures`, through `request`.
- The server calls an address an operator typed only through `~/lib/outbound`
  (`Outbound.check` when the address is saved, `Outbound.request` to call it), with
  `deps.outbound`. Never `fetch`.
- A hook (ADR 0035) is asked through `Hooks.beforeSignUp` only, and only where a sign-up is
  about to create an account for a proven address (after the emailed code in
  `Flows.verifyEmail`; the new-user row of `OAuth.resolveAccount`). The caller gets `'clear'`
  or `'bypassed'` and nothing of the answer. Never ask one from a start, from an admin route
  or on demand. `Hooks.beforeSession` is called from the flow service's `finish` only
  (after the attempt's move to `complete`, before `Sessions.create`), and
  `Hooks.beforeToken` from `Sessions.create` and `Sessions.recordAuthentication` only: a
  refresh reads the claims stored on the session and calls nobody.
- Return flow steps from `@tula/contract` for any sign-in/sign-up interaction. Never return UI
  hints like "show the password form".
- Throw `AuthError(code, params)` or `ServiceException` subclasses. Add new error codes to
  `@tula/contract` first.
- Read time from `deps.clock.now()` and ids from `deps.ids`, never `Date.now()` / `crypto.randomUUID()`
  directly in services, so tests are deterministic.
