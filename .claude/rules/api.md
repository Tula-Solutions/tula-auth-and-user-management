---
paths:
  - "apps/api/**/*.ts"
---

# API rules (apps/api)

The module shape, the ports, the background jobs, the route groups, errors and OpenAPI are in
`AGENTS.md` ("API module pattern", "Route groups & keys", "Errors", "OpenAPI"). This file adds
what those sections do not say; the rules of one area are in that area's file ("Area rules").

- New feature = new folder `src/modules/<kebab-name>/` with `router.ts`, `service.ts`,
  `schema.ts`, `service.test.ts`. Use `/new-module` to scaffold it.
- Never import a database client, Redis client, SMTP library or `fetch` into a service. Go
  through a port in `src/ports/`.
- New infrastructure means a port interface + a memory adapter + the real adapter. Wire it only in
  `src/container.ts` and `createTestDeps()`.
- A router makes one service call and answers `c.json(Schema.parse(result), status)`.
- Session-scoped client routes also use `sessionAuth`.
- `admin-via-dashboard.test.ts` enumerates the app's admin routes and fails for one that is
  guarded any other way than `secretKey()`. Build the actor with `adminActor(c)`, never by
  hand: it is what marks a dashboard change as `instance_admin`.
- Never refuse an agent key inside a route or a service as the only defence (`proposals.md`).
- A background job serves environments one at a time, and a failure in one is logged and
  skipped (`modules/retention`, `modules/webhook`). A new job also gets a place in
  `planProcess` (`src/process.ts`) for the role that runs it.
- A route that makes the server call an operator's address on demand (a webhook test event,
  a delivery sent again) has a per-environment rate limit of its own, mounted after
  `secretKey()`, and answers only the outcome, a status code and a duration.
- A route that hands out a secret (a webhook endpoint's registration, a secret rotation)
  takes none from the request, answers it once with `Cache-Control: no-store`, and no other
  route returns it or any part of it.
- Whether this process makes webhook deliveries is `deps.config.deliversWebhooks`, never a
  second reading of the environment (`webhooks.md`).
- Never return UI hints like "show the password form" from a sign-in or sign-up route.
- Add new error codes to `@tula/contract` first.
- Read time from `deps.clock.now()` and ids from `deps.ids`, never `Date.now()` / `crypto.randomUUID()`
  directly in services, so tests are deterministic.

## Names an area's rules do not give

Each of these is a detail of a rule that is stated in the area's file.

- **SMS adapters** (`phone-and-sms.md`): an adapter in `adapters/sms/` sends what it is
  given, unchanged, and throws only the port's `SmsSendError`.
- **Password age** (`passwords.md`, "Password expiry"): the age is read from
  `UserWithPassword.passwordChangedAt`.
- **Diagnostics** (`control-plane.md`): the one bounded scan is `readStored`
  (`modules/instance/service.ts`); a check reads stored data only inside it.
- **Device binding** (`device-binding.md`): a route reads the `DPoP` header only where an
  attempt starts and on the refresh route; `device.nonce_required` reaches the client
  through `NonceRequiredError` and `~/handlers`.
- **A provider's ID token** (`oauth.md`): the adapter verifies a handed-over token with
  `handedOver: true`; the exchange's `givenName` / `familyName` reach the adapter as
  `exchange.user`; a provider's `additionalClientIds` are written only by `OAuth.update`.
