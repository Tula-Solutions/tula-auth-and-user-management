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
- Return flow steps from `@tula/contract` for any sign-in/sign-up interaction. Never return UI
  hints like "show the password form".
- Throw `AuthError(code, params)` or `ServiceException` subclasses. Add new error codes to
  `@tula/contract` first.
- Read time from `deps.clock.now()` and ids from `deps.ids`, never `Date.now()` / `crypto.randomUUID()`
  directly in services, so tests are deterministic.
