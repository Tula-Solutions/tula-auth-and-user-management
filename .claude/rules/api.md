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
- A background job is a service function `startJobs` (`src/jobs.ts`) starts on boot and on a
  timer, under `deps.jobLock.runExclusive(<its own job name>, …)`; a new job gets a new id
  in `JOB_LOCK_IDS` (never renumber) and a place in `planProcess` (`src/process.ts`) for the
  role that runs it. Never set a timer for one, or name one, in `server.ts` or `worker.ts`:
  both call `bootJobs(container)` and nothing else. It serves
  environments one at a time and a failure in one is logged and skipped
  (`modules/retention`, `modules/webhook`).
- Whether this process makes webhook deliveries is `deps.config.deliversWebhooks` (from
  `WEBHOOK_WORKER` and the process's role), never a second reading of the environment. Code
  that calls a webhook endpoint checks it first: with `WEBHOOK_WORKER=separate` an API
  instance makes no such request, and a request on demand is refused with `not_implemented`
  and `params.reason: 'worker_separate'`.
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
- A text message (ADR 0037) is sent through `Sms.sendCode` only, after `Settings.requireSms`
  for its number; it is made in `modules/sms/templates.ts` (the built-in sentence or the
  environment's own, judged by the contract's `smsTemplateProblems`, then the server's own
  last line; ADR 0042), and the caller names the kind. An SMS adapter
  (`adapters/sms/`) sends what it is given, unchanged, with one request and no retry, runs
  `smsSenderSuite`, throws only the port's `SmsSendError`, and logs a provider's own text
  only through `maskProviderMessage`: never a number, a credential or the message. What
  `send` is handed beside the message (`SmsSendContext`: when a detached send's code
  becomes usable) is for the development inbox, which lists such a message only then; an
  adapter that really sends never reads it, waits for it or passes it on. A user's phone number is
  written only by `users.setPhoneNumber` / `removePhoneNumber`, each with its `Activity`;
  `users.recordPhoneNumberProof` moves the time it was proven forward and nothing else, is
  called only from a sign-in with a texted code, and takes none (ADR 0012).
- An account is looked for by phone number only through `Phone.signInHolder`, and only from
  the `sms_code` prepare and attempt steps of the flow service
  (`modules/phone/lookup.test.ts` walks the sources). Never from a start, a sign-up, a
  reset, an OAuth exchange or an admin route. It returns a user only when exactly one
  account holds the number and proved it within `PHONE_SIGN_IN_PROOF_MAX_AGE`; every other
  case is "unknown" and is answered and limited like a number that signs in (the work
  differs by one statement: ADR 0037)
  (`Sms.sendCode` with a `DecoyMessage`; a sign-in's real message is `detached`).
- A hook (ADR 0035) is asked through `Hooks.beforeSignUp` only, and only where a sign-up is
  about to create an account: for a proven address (after the emailed code in
  `Flows.verifyEmail`; the new-user row of `OAuth.resolveAccount`), or at the first sign-in
  with a provider of `OAUTH_PROVIDERS_WITHOUT_ADDRESS` (the "identity is nobody's" branch of
  `OAuth.resolveAccount`, reached only from the exchange), where the question's `email` is
  `null`. The caller gets `'clear'`
  or `'bypassed'` and nothing of the answer. Never ask one from a start, from an admin route
  or on demand. `Hooks.beforeSession` is called from the flow service's `finish` only
  (after the attempt's move to `complete`, before `Sessions.create`), and
  `Hooks.beforeToken` from `Sessions.create` and `Sessions.recordAuthentication` only: a
  refresh reads the claims stored on the session and calls nobody.
- A password's age is read from `UserWithPassword.passwordChangedAt` (the credential's
  `secret_changed_at`) and judged by `Passwords.expired`, only in `Flows.submitPassword`
  after the password is verified (ADR 0041). A store method that writes a **new** password
  sets that time; `upgradePasswordHash` does not. A password that replaces an expired one
  goes through `Users.replaceExpiredPassword` with the time the password the sign-in
  proved was set. `setPasswordHash` always moves that time forward, in every adapter.
- Return flow steps from `@tula/contract` for any sign-in/sign-up interaction. Never return UI
  hints like "show the password form".
- Throw `AuthError(code, params)` or `ServiceException` subclasses. Add new error codes to
  `@tula/contract` first.
- Read time from `deps.clock.now()` and ids from `deps.ids`, never `Date.now()` / `crypto.randomUUID()`
  directly in services, so tests are deterministic.
- Redirect URLs (ADR 0044): `Settings.requireRedirectUrl(deps, tenant, url, use)` is the
  one judge, and every caller says what the URL is for (`{ client, provider? }`). A listed
  custom scheme is refused there for a provider without PKCE, a client that is not native
  and anything that is not a provider sign-in (`params.reason`, a fixed word); the OAuth
  callback asks again. An app link is an `https` entry: nothing ties it to a native app.
  A native app's `appLinkPaths` are exact paths, off by default, and a gained one is a
  weakening.
- Native apps (`modules/native-app`, ADR 0040): the two association files are served only
  under `/v1/environments/:environmentId/.well-known/`, for the environment in the path and
  never by `Host`; they are built only by the contract's `appleAppSiteAssociation` and
  `assetLinks`, and a request never brings a relation, a path or a section. The cap is
  counted under `deps.environmentLock` (`native_apps`), an update is a compare-and-set, and
  `weakened` is the contract's `nativeAppWeakenings`. No identifier, team or fingerprint in
  an event, an audit entry or a log line.
- A diagnostic check (`modules/instance`) reads stored data only inside `readStored`, the
  one bounded scan, answers fixed text and counts, and fetches nothing but the server's own
  `PUBLIC_URL` through `deps.diagnostics`. The native app checks (`native.ts`) never request
  an operator's domain, and their `ok` says what was not looked at.
- The message preview (`modules/message-preview`, ADR 0042) answers text, never HTML,
  renders with `renderTemplate` and `renderCodeText` and nothing of its own, writes and sends
  nothing, and takes no value from a request into the text but the draft.
- Device binding (ADR 0043): a route reads the `DPoP` header only where an attempt starts
  (the flow router's `clientContext` with the start's headers, which calls
  `DeviceBinding.atStart`) and on the refresh route, which hands `Sessions.refresh` the
  header, the method and the route's path. The address a proof must name is
  `deps.config.publicUrl` plus that path, never `Host`. A refusal is `device.proof_invalid`
  whatever was wrong; `device.nonce_required` carries a fresh nonce in `DPoP-Nonce` through
  `NonceRequiredError` and `~/handlers`. An answer that issues or refreshes a bound session
  sets `DPoP-Nonce` from `IssuedSession.proofNonce`. Used proof ids go through
  `deps.proofReplay` only, which fails closed. A refused proof never revokes anything.
  A profile's `deviceBinding` is judged only by `DeviceBinding.hold`, for the profile
  `resolveSessionProfile` gives, at the start, at the top of `finish`
  (`Sessions.requireBinding`) and in `Sessions.create`; a refresh never reads it, a `web`
  client is never refused by it, and the start's refusal never depends on the identifier.
  A session list says `deviceBound` and never a thumbprint; the thumbprint decides a
  refresh and, through `hasBoundSessionBefore`, the new-device notice, and nothing else.
  The session routes that end sessions take no `requireRecentAuth()` and no proof.
