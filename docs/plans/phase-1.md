# Tula Auth — Phase 1 plan

Social sign-in, passkeys, MFA, the web SDKs, the dashboard, config-as-code, the CLI and the MCP
server. Status: **accepted** (2026-10-03).

## Where Phase 0 left things

Merged to `develop`: email and password sign-up, sign-in and password reset as server-driven
flows; rotating refresh tokens with reuse detection; per-environment EdDSA keys and JWKS; user
admin; rate limits and lockout; the audit log and event outbox; ten conformance scenarios run in
process and against the packaged Docker image. `bun run verify` is the gate; coverage is above
99%.

What Phase 0 deliberately left open, and Phase 1 has to close:

| Gap | Why it matters now | Step |
| --- | --- | --- |
| Rate limits, lockout and the revoked-session list live in process memory | A second instance would not share them | 1.1 |
| No retention: audit entries, events, sessions and tokens accumulate | Tables grow without bound | 1.1 |
| `api_keys` has no composite tenant foreign key (review finding C5) | Deferred from the Phase 0 review | 1.1 |
| The API image is pinned by tag, not digest | Supply-chain hygiene before anything is published | 1.1 |
| `bun run test:harness` stalled twice locally (cause unknown) | A flaky gate erodes trust in the gate | 1.1 |
| One password policy and one session profile per deployment (env vars) | Config-as-code and the dashboard need per-environment settings | 1.2 |
| Emails do not name the app, and there is one fixed layout | Every new email (magic link, MFA, security notices) makes this worse | 1.2 |
| An attempt id alone identifies an attempt | Magic links and OAuth callbacks finish in another tab or on another device | 1.3 |
| `setPasswordHash` replaces a credential, never creates one | Social and passkey users have no password | 1.3 |
| No "your password was changed" or "new sign-in" email | Users cannot notice a takeover | 1.6 |

## How Phase 1 is built

The same loop as Phase 0, unchanged: one step per branch off `develop`, `bun run verify` green,
`/review-loop` with no blocking findings, a failing-first test for every fixed finding, a PR into
`develop`, merge when CI is green.

Three rules are new:

1. **Every sign-in method ships end to end.** Server, contract, conformance scenario,
   `@tula/core` support and the React component land together (or in back-to-back PRs), so a
   method is never "done on the server" with no client that can use it. This is why the first
   SDK slice (Milestone B) comes before the new methods (Milestone C).
2. **Each SDK runs the conformance scenarios.** `@tula/core` gets a runner target that drives
   the scenarios through the SDK instead of raw `fetch`. A scenario the SDK cannot express is a
   bug in the SDK or in the scenario.
3. **Browser behaviour is tested in a browser.** Components and the dashboard get Playwright
   tests against the in-process API; they run in CI as their own job, not inside `verify`.

Coverage targets stay: 80% everywhere, 95% on `flow`, `session`, `password`, `jwks`,
`verification`, and the new `oauth`, `passkey` and `mfa` modules.

## Milestones and order

```
A  Foundation   1.1 multi-instance + hardening → 1.2 environment settings → 1.3 flow engine v2
B  First SDK    1.4 release tooling → 1.5 @tula/core → 1.6 @tula/react (password flows)
C  Methods      1.7 magic link + email code → 1.8 TOTP + backup codes → 1.9 OAuth → 1.10 passkeys
D  Sessions     1.11 session profiles and rules → 1.12 @tula/nextjs
E  Tooling      1.13 @tula/config + tula apply → 1.14 CLI → 1.15 dashboard → 1.16 MCP
F  Exit         1.17 example app, docs, whole-phase review
```

Within Milestone C, MFA (1.8) must exist before OAuth and passkeys so that neither can skip a
second factor; 1.9 and 1.10 are independent of each other. D and E can overlap with C.

---

## Milestone A — Foundation

### 1.1 Multi-instance and hardening carry-overs

- **Redis adapters** for the three in-memory ports: `RateLimiter` (fixed window, one Lua
  script), `Lockout`, `RevokedSessions` (key with a TTL of the access-token lifetime).
  Signing-key cache invalidation on rotate goes through Redis pub/sub so every instance drops
  its cache. `REDIS_URL` becomes required in `staging` and `prod`; memory adapters stay for
  `local` and tests. Each adapter runs a shared behaviour suite against memory and Redis; the
  ports that have no suite yet get one.
- **Failure mode decided and tested:** with Redis down, rate limiting and lockout fail
  **closed** on credential routes (503), the revoked-session check fails closed, and refresh
  keeps working from Postgres. `/v1/ready` reports Redis.
- **Retention job** (`modules/retention`): deletes expired flow attempts (the existing purge
  moves here), consumed or expired verification tokens, sessions revoked or expired for more
  than 30 days with their refresh tokens, and delivered outbox events older than 30 days. Audit
  entries are kept (their retention becomes a per-environment setting in 1.2, default: keep).
  Runs on one instance at a time (Postgres advisory lock).
  *As built ([ADR 0017](../adr/0017-retention.md)):* outbox events are **not** deleted yet.
  Nothing marks an event delivered until the webhook worker (Phase 2), so there is no
  delivered event to delete; the purge, and the `DELETE` grant it needs, move to that step.
  Verification tokens are deleted one hour after they expire, which covers consumed ones.
- **Carry-overs:** composite tenant foreign key on `api_keys` (new migration); API image pinned
  by digest with an update rule; find or fence the harness-test stall (a per-test timeout so a
  hang fails in seconds and names the test).
- **Done when:** two API containers behind one Compose service pass the conformance suite,
  including a step that signs out on one and is refused on the other; the `self-host` CI job
  runs that.
  *As built:* two Compose services (`api`, `api-2`) on their own host ports rather than one
  scaled service, so that the suite can address each instance; the `two instances` scenario
  uses a new optional `instance` field ([ADR 0016](../adr/0016-redis-and-multiple-instances.md)).
  The harness stall was not reproduced (60 consecutive runs); it is fenced with a timeout on
  every spawned process, the only kind that can interrupt `Bun.spawnSync`.

### 1.2 Per-environment settings

Everything that is an env var today but belongs to a tenant.

- **Data:** `environment_settings` (one row per environment, RLS, a `revision` integer): app
  name and support email; password policy; enabled sign-in methods; allowed redirect URLs and
  web origins; session profiles (filled in 1.11); audit retention. `PASSWORD_POLICY` and
  `CORS_ORIGINS` become the defaults for environments with no row.
- **Admin API:** `GET` / `PUT /v1/admin/settings` (the whole document, `If-Match` on the
  revision so two writers cannot silently overwrite each other). Every change is audited with
  the keys that changed, never the values.
- **Client API:** `GET /v1/client/config` (publishable key) returns what a client needs to draw
  a sign-in screen: app name, enabled methods and providers, password policy.
  `/v1/client/password-policy` stays as an alias; removing it is a breaking change for later.
- **CORS and redirects** read the environment's allow-list (cached, invalidated on write).
- **Email:** a `templates` module renders every email from one layout with the app name; the
  copy for each message type lives in one place. No editor yet (Phase 2).
- **Done when:** two environments in one deployment enforce different password policies and
  CORS origins, covered by tests and one scenario.

### 1.3 Flow engine v2

The changes every new method needs, made once.

- **Attempt binding.** Starting an attempt returns an `attemptSecret` (256-bit, stored hashed);
  every later call on that attempt presents it (`x-tula-attempt` header). An attempt id seen in
  a URL, a log or an email is then useless on its own. Introduced additively (accepted but not
  required) until `@tula/core` sends it, then required; that second PR is the breaking change.
- **First-factor choice.** `needs_first_factor { strategies }` answers a sign-in start when
  more than one method is enabled; `needs_password` stays the answer when password is the only
  one, so Phase 0 clients keep working. Strategies: `password`, `email_code`, `email_link`,
  `passkey`, `oauth_<provider>`.
- **`needs_second_factor`** is wired into the transition table (table-tested with a fake
  factor), so 1.8 only adds factors. Password reset routes through it.
- **Users without a password.** Setting a password for the first time creates the credential;
  `password.not_set` is a new error code for "change my password" on a passwordless account.
- **Transitions stay one pure function**, now over `(kind, status, event, settings)`; the table
  test enumerates every combination, allowed or refused.
- **ADR** superseding parts of 0009. **Conformance:** existing scenarios unchanged; a new one
  for a bound attempt refused without its secret.

---

## Milestone B — First SDK slice

### 1.4 Release tooling

- `bunup` builds (ESM, `.d.ts`, nothing bundled), `exports` maps, and `publint` plus
  `@arethetypeswrong/cli` in `verify` for every publishable package.
- Changesets for versions and changelogs; a `release` workflow that publishes on merge to
  `main` with npm provenance. `@tula/contract` is the first published package
  (`0.1.0-alpha`).
- **Nothing is published in Phase 1** until the licence and the npm scope are settled (see
  Decisions); the release workflow is built and exercised with a dry run only.

### 1.5 `@tula/core` — headless TypeScript client

- A typed client generated from `openapi.json` (`*.gen.ts`, never edited), and a hand-written
  layer on top: `createTulaClient({ publishableKey, baseUrl, storage })`; `signUp`, `signIn`
  and `resetPassword` as flow objects that expose the current step and the calls valid at it;
  `session` (get a token, refresh, sign out, list and revoke sessions).
- **Single-flight refresh:** concurrent `getToken()` calls share one refresh, across tabs via
  Web Locks with a `BroadcastChannel` fallback. This is the highest-risk code in the SDK
  (business plan §5.7): fake-timer tests for every interleaving. The server's refresh grace
  period exists to forgive the cases this cannot prevent.
- Storage adapters: cookie mode for browsers (the refresh token is never visible to
  JavaScript), memory, and a pluggable async store for React Native (used in Phase 2).
- Errors are the contract's codes with typed params; messages come from a locale table
  (English only in Phase 1; the structure allows more).
- Runs in browsers, Node, Bun and edge runtimes: no Node-only APIs, checked by a build per
  target.
- **Conformance through the SDK** (rule 2 above).

### 1.6 `@tula/react` — components for the Phase 0 flows

- `<TulaProvider>`; hooks (`useAuth`, `useUser`, `useSession`, `useSignIn`, `useSignUp`);
  `<SignedIn>` / `<SignedOut>`; components `<SignUp>`, `<SignIn>` (including forgotten
  password), `<UserButton>`, `<UserProfile>` (profile, password, devices and sessions).
- Components render from the flow step and contain no flow logic. The live password checklist
  uses `evaluatePassword` from `@tula/contract`, so client and server agree.
- **Theming:** one tokens file (colors, radius, type, spacing, dark mode) becomes CSS
  variables; an `appearance` prop overrides per component. The same file feeds Swift and Kotlin
  constants in Phase 2, so its schema lives in `@tula/contract`.
- **Accessibility is part of done:** keyboard order, labels, error announcement, focus between
  steps, one-time-code autofill; checked with axe in the Playwright tests.
- **Security notices** (server side) land with this step, since the UI now gives users
  somewhere to act on them: emails for password changed, password reset completed, and a
  sign-in from a new device.
- **Done when:** a Vite example app signs up, verifies, signs in, resets a password and manages
  sessions using only the components, in Playwright, against the in-process API.

---

## Milestone C — Sign-in methods (each end to end)

### 1.7 Magic link and email code sign-in

- Email code (`email_code`) and magic link (`email_link`) as first factors, through the
  verification service that already issues and verifies both (ADR 0007).
- The link lands on the app's own URL (from the environment's redirect allow-list) carrying the
  link token; that page calls the API with it. The **tab that started the attempt** receives
  the session, which is safe only because of attempt binding (1.3). Opening the link on another
  device completes the original tab and shows "you can close this page" there.
- Passwordless sign-up (email only) when the environment enables it.
- Enumeration: starting an email sign-in for an unknown address behaves like the sign-up decoy.

### 1.8 MFA: TOTP and backup codes

- **Enrolment** under `/v1/client/me/factors`: create a TOTP secret (sealed with the secret
  box, bound to user and environment), confirm it with a code, receive ten single-use backup
  codes (stored as keyed hashes, shown once).
- **Step-up:** a signed-in user proves a factor again; the session records when, and the access
  token carries it as a claim so apps can require it too. Required for: change password, MFA
  changes, passkey changes, delete account.
- **Flow:** after the first factor an enrolled user gets `needs_second_factor { options }`.
  TOTP verification allows one step of clock drift, refuses a code already used in its window,
  and counts failures through `deps.lockout`.
- **Recovery:** backup codes; an admin "reset MFA" (audited, ends sessions). A password reset
  never bypasses the second factor.
- **Policy** per environment: `off | optional | required`; `required` forces enrolment at the
  next sign-in through a `needs_factor_enrolment` step.
- React: the second-factor screen, enrolment with a QR code, backup-code download.

### 1.9 OAuth: Google, GitHub, Apple

- **Port and adapters:** `OAuthProvider` (authorization URL, code exchange, profile), built on
  a proven library rather than hand-written OAuth (business plan §10.6).
- **Credentials per environment:** client id and secret set through the admin API, sealed with
  the secret box, never returned. Apple's key and team id included.
- **Flow (web):** the client starts an attempt and gets the provider URL; the server holds
  `state`, the PKCE verifier and the `nonce` on the attempt; the provider returns to
  `/v1/oauth/callback/:provider` on the API; the API redirects to the app's allow-listed URL
  with a single-use, 60-second ticket; the client exchanges the ticket plus the attempt secret
  for the next step (`complete` or `needs_second_factor`). No token ever appears in a URL.
- **Account linking** (where takeovers happen): link to an existing account only when the
  provider asserts the email is verified **and** the Tula account's email is verified;
  otherwise the user signs in to the existing account first and links from the profile.
  Removing the last sign-in method is refused.
- **Strict redirects:** exact-match allow-list, no wildcards in `prod`.
- Each provider gets a setup checklist with the exact redirect URI to paste (it feeds
  `tula doctor` in 1.14). Tests run against a fake provider adapter, and against a local OIDC
  mock in the Playwright job.
- Native Google and Apple sign-in (ID-token exchange) is Phase 2; the port is shaped for it.

### 1.10 Passkeys

- `@simplewebauthn/server` in the API, `@simplewebauthn/browser` inside `@tula/core`.
- **Data:** a `passkeys` table (credential id, public key, counter, transports, AAGUID,
  backup flags, name, last used) rather than the generic `credentials` table: a user has many,
  and lookups are by credential id.
- **Registration** under `/v1/client/me/passkeys` (step-up required). **Sign-in** as a first
  factor with discoverable credentials and autofill, and as a second factor. A passkey with
  user verification satisfies MFA on its own.
- Relying-party id and origins per environment (1.2); challenges are single-use and stored on
  the attempt; a counter that goes backwards is logged and refused.
- Works on `localhost`; testing on physical devices needs the tunnel in Phase 2.

---

## Milestone D — Sessions

### 1.11 Session profiles and rules

- Named profiles per environment (`web`, `mobile`, `admin`, …), chosen by client kind, each
  with access-token lifetime, idle and absolute timeouts, refresh grace, and type: `hybrid`
  (today's) or `stateful` (an opaque cookie checked against the store on every request, for
  instant revocation). The other types in the business plan stay later.
- Rules: maximum concurrent sessions per user (oldest ends, or newest refused); step-up
  required after N minutes for a profile.
- JWT templates are **not** in Phase 1: custom claims are a hook surface that needs its own
  design (Phase 2, with webhooks).

### 1.12 `@tula/nextjs`

- Middleware that verifies the access token against the environment's JWKS at the edge (no
  database call), refreshes through a route handler, and protects routes by matcher.
- Server helpers (`auth()`, `currentUser()`) and the React components re-exported for the App
  Router with the server and client boundaries marked.
- An App Router example app with Playwright coverage of protected routes, expiry and refresh.

---

## Milestone E — Tooling

### 1.13 `@tula/config` and `tula apply`

- `defineConfig()` in `tula.config.ts`: typed, validated with the contract's schemas, covering
  environment settings (1.2), providers (1.9; secrets by env-var reference only, never inline),
  MFA policy and session profiles.
- `tula apply` diffs the file against `GET /v1/admin/settings`, prints the plan, applies on
  confirmation (`--yes` in CI) and uses the revision check so it never overwrites a change made
  elsewhere. `tula diff` is the dry run. The dashboard shows when settings are managed by a
  config file.

### 1.14 CLI

- `create-tula`: scaffolds a project (Compose file, `.env` with a generated master key,
  `tula.config.ts`, an example app for the chosen framework).
- `tula dev`: starts Compose, migrates, seeds, mints dev keys, prints the URLs.
- `tula doctor` v0: checks what actually goes wrong (database reachable and migrated, master
  key matches the stored keys, SMTP reachable, clock skew, `PUBLIC_URL` reachable, each enabled
  provider's redirect URI), each with its fix.
- `tula policy test "<password>"`: shows which rules a password passes for an environment.
- The CLI talks to the API through the generated admin client; it touches the database only in
  `tula dev`'s bootstrap.

### 1.15 Dashboard (`apps/dashboard`)

- The payhub-portal stack: Vite, React 19, TanStack Router and Query, Tailwind v4, shadcn,
  Zustand, Orval-generated hooks from `openapi.json`. Layout from `Design.pdf` page 6:
  workspace → project → environment switcher.
- Screens: users (search, detail, ban, reset password, reset MFA, sessions), sign-in methods
  and providers, password policy, session profiles, API keys, signing keys, audit log,
  settings.
- Served by the API as static files at `/dashboard` in the self-host image.
- An operator signs in with the instance admin token (see Decisions). The workspace- and
  project-level admin routes this needs do not exist yet and are part of this step.

### 1.16 MCP server (`packages/mcp`)

- A local stdio server (`npx tula mcp`). Read tools: users, sessions, audit entries, settings,
  `doctor` results. Scaffold tools: the provider wrapper, a protected route, a sign-in page for
  the detected framework. No tools that change live data in Phase 1.
- The server never returns secrets or key material.

---

## Milestone F — Exit

### 1.17 Example, docs and the whole-phase review

- One example app (Next.js) using every Phase 1 method; it is the end-to-end test bed.
- Docs: quickstart, one page per method, the SDK reference generated from JSDoc, and self-host
  updates (Redis, multiple instances, providers).
- A four-pass review of the whole phase, as at the end of Phase 0, plus a focused threat review
  of OAuth linking, attempt binding, step-up and passkeys.

### Exit criteria

- Conformance passes in process, against two packaged instances behind one address, and through
  `@tula/core`.
- `bun run verify` and the Playwright job are green; coverage targets are met.
- A new project goes from `npx create-tula` to a working sign-in page with Google and a passkey
  without editing server code.
- The whole-phase review reports no blocking findings.

---

## Not in Phase 1

Native SDKs and Expo, native Google and Apple, device binding, the tunnel, webhook delivery,
JWT templates and server hooks, SMS codes, the email template editor, more providers
(Microsoft, Discord, X, Facebook, LinkedIn) and MCP write tools are Phase 2. Organizations,
RBAC, invitations and importers are Phase 3.

## Decisions

Settled on 2026-10-03, when the plan was approved to start.

| # | Decision | Outcome |
| --- | --- | --- |
| 1 | Licence | **Deferred.** Step 1.4 builds and checks the packages but publishes nothing. |
| 2 | The `@tula` npm scope | **Deferred** with the licence. Packages keep the `@tula/*` names inside the workspace. |
| 3 | Dashboard sign-in and instance-level authority | An instance admin token from the server's environment (`TULA_ADMIN_TOKEN`), exchanged for a short dashboard session. Operator accounts wait for the V2 control plane. |
| 4 | OAuth library | `arctic` for the protocol and `jose` for ID tokens. |
| 5 | Build order | The SDK slice comes before the new methods, so each method is proven through a real client. |
| 6 | Redis in production | Required in `staging` and `prod`; memory adapters remain for `local` and tests. |
| 7 | SMS codes | Phase 2, with the SMS port and a Twilio adapter. |

Components and SDKs are also checked by hand in a real browser as they are built, in addition
to the Playwright job.
