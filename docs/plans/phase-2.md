# Tula Auth — Phase 2 plan

Webhooks, hooks and JWT templates, SMS, more providers, then the native clients: Expo, Swift
and Kotlin with prebuilt UI, native Google and Apple, device binding, the tunnel, and MCP tools
that change things. Status: **approved to start** (2026-10-08). Drafted on 2026-10-04; the
[decisions](#decisions) it needed were settled on 2026-10-08.

## Goal

At the end of Phase 2 an app on iOS, Android or Expo signs a user in with the same server, the
same flow protocol and the same rules as the web SDKs, using native screens it did not write;
and a backend learns what happened through signed webhooks and shapes what a token says. The
business plan's first positioning point is "native-first mobile"
([business plan](../business-plan.md), section 3). Phase 1 shipped none of it.

## Where Phase 1 left things

Merged to `develop`: everything in the [Phase 1 plan](phase-1.md). Forty-six conformance
scenarios, three web SDKs, the dashboard, settings as code, the CLI and a read-only MCP server.
Nothing is published.

What Phase 1 deliberately left open, and Phase 2 has to close:

| Gap | Where it is today | Step |
| --- | --- | --- |
| Nothing reads the event outbox; `delivered_at` is never set; events are never deleted | [`events.ts`](../../packages/db/src/schema/events.ts), [`retention/service.ts`](../../apps/api/src/modules/retention/service.ts), [ADR 0012](../adr/0012-events-and-audit-log.md), [ADR 0017](../adr/0017-retention.md) | 2.2 |
| Event payloads are not a typed contract per event type | [ADR 0012](../adr/0012-events-and-audit-log.md), "Consequences" | 2.1 |
| `audit.retentionDays` is stored and validated but nothing acts on it | [ADR 0017](../adr/0017-retention.md) | 2.1 |
| Access-token claims are fixed; no custom claims | [`tokens.ts`](../../packages/contract/src/tokens.ts), [ADR 0028](../adr/0028-session-profiles.md), "Deferred" | 2.3 |
| There is no phone number anywhere in the schema or the contract, and one mail port with one adapter | [`ports/mailer.ts`](../../apps/api/src/ports/mailer.ts) | 2.4 |
| Three providers: `google`, `github`, `apple` | [`oauth.ts`](../../packages/contract/src/oauth.ts) | 2.5 |
| `password.history` and `password.expiryDays` are in the policy schema and not enforced | [`password-policy.ts`](../../packages/contract/src/password-policy.ts) | 2.6 |
| One email layout, copy fixed in code (the wording is editable since TULA-17, [ADR 0039](../adr/0039-email-templates.md); the editor is TULA-30) | [`email/templates.ts`](../../apps/api/src/modules/email/templates.ts), [ADR 0018](../adr/0018-environment-settings.md) | 2.7 |
| A request with no `Origin` cannot use passkeys | [ADR 0027](../adr/0027-passkeys.md): native apps prove "a different kind of origin" | 2.8 |
| Redirect URLs are `https` (or loopback `http`) only; no custom scheme | [`environment-settings.ts`](../../packages/contract/src/environment-settings.ts) | 2.8 |
| `OAuthProvider` has no `verifyIdToken`; the comment says where it goes | [`ports/oauth-provider.ts`](../../apps/api/src/ports/oauth-provider.ts), [ADR 0026](../adr/0026-oauth.md) | 2.9 |
| A session knows a user agent and an address, nothing about the device | [`sessions.ts`](../../packages/db/src/schema/sessions.ts), [ADR 0023](../adr/0023-security-notices.md) | 2.10 |
| The native SDKs are promised a conformance suite whose files describe HTTP, which an SDK hides | [conformance README](../../conformance/README.md), [ADR 0021](../adr/0021-core-sdk.md) | 2.11 |
| `@tula/core` has a storage interface for native clients and only a memory adapter; its passkey code reads `navigator.credentials` | [`storage.ts`](../../packages/core/src/storage.ts), [`passkey.ts`](../../packages/core/src/passkey.ts) | 2.13 |
| `packages/expo` and `native/` are named in `AGENTS.md` and do not exist | the repository | 2.13 to 2.16 |
| The theme tokens are plain data with a CSS generator and no Swift or Kotlin output; an environment's settings hold no theme | [`theme.ts`](../../packages/contract/src/theme.ts), [ADR 0022](../adr/0022-react-sdk.md) | 2.14, 2.15 |
| The MCP server can only read; the audit actor type `agent` is reserved and unused | [`read-only.ts`](../../packages/mcp/src/read-only.ts), [`audit.ts`](../../packages/contract/src/audit.ts), [ADR 0033](../adr/0033-mcp-server.md) | 2.17 |
| Everything on the [unverified list](phase-1-unverified.md) that needs the owner | real providers, a physical authenticator, https, publishing | 2.18, and earlier where a step depends on it |

## What Phase 2 contains, and where the documents disagree

The scope below is the "Not in Phase 1" paragraph of the [Phase 1 plan](phase-1.md#not-in-phase-1),
checked against every "Build order" paragraph of the [business plan](../business-plan.md).
They do not agree everywhere. Each disagreement, and what this plan does about it:

| # | The documents | This plan |
| --- | --- | --- |
| 1 | The business plan's roadmap (section 8) gives Phase 2 four things: the Expo SDK with native SwiftUI and Compose components, native Google and Apple, `tula doctor`, webhooks. The Phase 1 plan adds device binding, the tunnel, JWT templates and server hooks, SMS codes, the email template editor, five more providers and MCP write tools. The README's roadmap line names native SDKs and Expo, webhooks, SMS and more providers. | Follows the Phase 1 plan: it is the later document and each item has a source elsewhere in the business plan (rows below). The README line is short, not wrong; it now links here. |
| 2 | `tula doctor` is a Phase 2 deliverable in the roadmap. A first version shipped in Phase 1 (step 1.14). | What is left is the native part of section 4.4: bundle id, SHA-256 fingerprints, associated domains. Step 2.12. |
| 3 | Section 4.1 lists eight providers under "MVP". The roadmap names three for Phase 1 and none later. | The other five are step 2.5, as the Phase 1 plan says. |
| 4 | SMS is "MVP" in 4.1 and "logged to console in dev, optional Twilio adapter" in 5.8, and appears in no roadmap phase. Phase 1's decision 7 put it in Phase 2. | Step 2.4. Whether SMS may be a second factor at all is decision D5. |
| 5 | SDK order. Section 5.7: "TypeScript SDKs first, then native Swift and Kotlin, then the Expo wrapper around the native components", and `@tula/expo` is a "thin wrapper". Section 4.4: "Works in Expo Go for the basic path; full native via a config plugin". [ADR 0021](../adr/0021-core-sdk.md) and [`storage.ts`](../../packages/core/src/storage.ts) expect React Native to run `@tula/core` with a secure-store adapter. | Both, in two steps: a headless `@tula/expo` on `@tula/core` first (2.13), the wrappers of the native components after the native SDKs exist (2.16). Decision D8. This is a recommendation of this plan, not something the business plan says. |
| 6 | Section 5.3's build order gives Phase 2 "device binding, org-level overrides, risk rules and custom store adapters". Organizations are Phase 3 in the roadmap; risk rules are the fraud engine of 4.3 and Phase 5. | Only device binding. An org-level override cannot exist before organizations; risk rules stay in Phase 5. Custom session-store adapters are not planned: `AGENTS.md` adds a port only for two real implementations, and the session store has them. |
| 7 | Section 4.7: "org and role overrides, history and expiry, and the custom validator hook in Phase 2 and 3", with no split. The contract says `history` is "enforced from Phase 2". `minStrengthScore` and `onPolicyTightened` are in the business plan's example and in no schema and no phase. | History and expiry in 2.6. The custom validator is one of the hooks of 2.3. Org and role overrides are Phase 3. The strength score and "what happens to existing users" are not planned; see [Not in Phase 2](#not-in-phase-2). |
| 8 | Section 4.6 puts the dashboard theme editor in Phase 1 and native theming "with the shared token file" in Phase 2. No theme editor was built, and an environment's settings hold no theme: a web app passes its theme as a prop. | Native themes are generated constants and a theme object in code, like the web (2.14, 2.15). A theme stored per environment, the editor and live preview on a device are not in this phase; decision D12 can pull them in. |
| 9 | Section 4.5: the MCP token "is scoped to the dev environment" and production changes are "a plan and diff that a human must approve". As built, the server holds a secret key of whichever environment the operator gives it ([ADR 0033](../adr/0033-mcp-server.md)). Section 4.5's tool table also lists organization and migration tools. | 2.17 designs the approval. Organization and migration tools wait for Phase 3. |
| 10 | "Server hooks". Section 5.2 says "plugin hooks on the server … written in TypeScript"; the Phase 1 plan says "JWT templates and server hooks" and that custom claims are "a hook surface that needs its own design". Neither says whether a hook is code loaded into the API or an HTTP call. | HTTP calls to the operator's own endpoint (2.3). Reasons there. This is a recommendation of this plan. |
| 11 | Section 5.3 describes session types `long-lived` (device-bound, sliding), `kiosk`, `stateless`, and the options `offlineGrace` and `biometricUnlock`, with no phase. [ADR 0028](../adr/0028-session-profiles.md) defers the types. Section 4.4 lists "offline-tolerant sessions on mobile". | Device binding is an option of a `hybrid` profile, not a new type (2.10). Offline tolerance is client behaviour in each SDK (keep the session through a failed refresh). Biometric unlock, `kiosk` and `stateless` are not planned. |
| 12 | Section 4.1 lists SDKs for Node/Bun and Python, a custom domain and `tula migrate`. None has a phase. Section 5.8 defers custom domains to V2. | None is in Phase 2. `@tula/admin` already serves a Node or Bun backend. |
| 13 | Section 4.4: generated `apple-app-site-association` and `assetlinks.json`, slot-based overrides in the native components, a built-in SMS inbox for local development. No phase. | The association files in 2.8, slots in 2.14 and 2.15, the local SMS inbox in 2.4. |
| 14 | Section 4.6: "30+ languages built in", RTL. No phase. Phase 1 is English only with a structure for more. | Not in Phase 2. The native SDKs get the same one-table structure. |
| 15 | Section 5.4's data model has a `devices` table. There is none: a session row is "a signed-in device". | 2.10 decides, in its ADR, whether a device outlives a session. This plan recommends it does not. |

The design file ([`docs/design/Design.pdf`](../design/Design.pdf), six pages) could not be
opened while this plan was written (no PDF renderer on the machine). What the native SDKs must
draw is taken from the business plan's description of it: an iOS SwiftUI sign-in, an Android
Compose sign-in with the native account chooser, and an iOS account screen with devices and
the idle rule. **Steps 2.14 and 2.15 start by reading pages 3 to 5.**

## How Phase 2 is built

The same loop: one step per branch off `develop`, `bun run verify` green, `/review-loop` with
no blocking findings, a failing-first test for every fixed finding, a PR into `develop`.

Four rules are new:

1. **A server feature ships with every surface it has.** Contract, conformance scenario and
   SDK journey as in Phase 1, and now also its `tula.config.ts` field with a `tula diff` rule,
   its dashboard screen, and its line in the docs. A feature that can only be reached with
   `curl` is not done.
2. **A native SDK is two modules: a client with no UI, and the UI.** The client (requests,
   flows, session, refresh, storage behind an interface) must build and test on a plain host:
   `swift test` on macOS, a JVM test task for Kotlin. Only the UI module, secure storage, the
   passkey sheet and native Google and Apple need a simulator, an emulator or a phone. This
   split is what lets most of each SDK be tested on a CI runner.
3. **Three clients, one list.** Every conformance scenario has a decision in every SDK:
   covered by a named journey, or listed as not applicable with a reason. The guard that
   holds this for `@tula/core` today ([`sdk-journeys.test.ts`](../../apps/api/src/sdk-journeys.test.ts))
   gets a language-neutral list that Swift and Kotlin read too (2.11).
4. **"Verified on a device" is written down or it did not happen.** A step that claims a
   physical device records the model, the OS version, the build and what was done, in the
   step's as-built note. Everything else goes on a Phase 2 unverified list, kept from the
   first step and not collected at the end.

Coverage targets stay: 80% everywhere; 95% on the security-sensitive modules, which now
include `webhook`, `hook`, `sms` and `device`. The native SDKs get a threshold of their own
on the client module when it exists; this plan does not invent the number.

## Milestones and order

```
A  Server       2.1 carry-overs + event contract → 2.2 webhooks → 2.3 JWT templates + hooks
                2.4 SMS · 2.5 more providers · 2.6 password history + expiry · 2.7 templates
B  Native base  2.8 app identity → 2.9 ID-token exchange · 2.10 device binding → 2.11 conformance for clients
C  Reach        2.12 tunnel + doctor's native checks → 2.13 @tula/expo (headless)
D  Native       2.14 Swift · 2.15 Kotlin → 2.16 Expo native UI
E  Agents       2.17 MCP write tools
F  Exit         2.18 examples, docs, the device pass, whole-phase review
```

**Why this order.** Milestone A needs no hardware, no account with Apple or Google, and no
decision about a licence; every part of it is provable with what the repository already has.
It also carries the two things other work stands on: the typed event contract (webhooks, and
the events every later step adds) and the outbound-HTTP guard (webhooks, hooks). Milestone B
is still server-only: it settles the protocol the three native clients implement, with a
software stand-in in the conformance suite, before any of them is written. Milestone C makes
a phone able to reach a laptop, and brings the first client that runs on one, reusing
`@tula/core`. Milestone D is the two native SDKs, then the wrappers that need both.

**Two places this differs from the obvious order, and why.**

- *Device binding before the native SDKs, not after.* The binding changes the refresh call,
  and refresh is "the highest-risk code" in each SDK (business plan 5.7). Writing three
  refresh modules and then changing all three is the expensive order. The server side and its
  conformance scenarios come first (2.10); each SDK implements the client side in its own
  step; an environment can only set `required` once the exit step has seen all three do it.
- *The tunnel before Expo, not last.* Passkeys and native Google and Apple do not work on a
  physical device against `localhost` (business plan 5.8). Without the tunnel nothing in
  Milestones C and D can be verified on a phone, and the unverified list would grow by every
  step.

**What can run in parallel.** 2.4, 2.5, 2.6 and 2.7 are independent of each other and of 2.2
and 2.3 once 2.1 is merged (2.7 after 2.4 if SMS templates are in it). 2.9 and 2.10 are
independent after 2.8. 2.14 and 2.15 are independent of each other and are the largest steps
of the phase: two people, or two agents, from the same 2.11. 2.17 depends only on Milestone A
and can run beside C and D. Contract changes are the collision point: every step regenerates
`openapi.json`, so parallel branches rebase and regenerate, never merge the file by hand.

**Every contract change in this phase is additive**: new routes, new optional fields with
defaults, new enum members where the schema is already documented as open (audit actions,
first-factor strategies, providers). Two changes are additive in shape but can surprise a
client built against Phase 1, and are called out where they happen: a new `strategies` member
(2.4) and a new step status if SMS enrolment needs one. `@tula/react` renders "not supported"
for a step it does not know; the native SDKs must do the same from their first version.

---

## Milestone A — Server, without hardware

### 2.1 Carry-overs and the event contract

- **What.** (a) Already done between Phase 1 and this plan's approval, and not part of this
  step any more: `Activity` is a required parameter of every store method that changes who
  can do what, and the deliberate exceptions (ADR 0012) are methods of their own
  ([`ports/activity-log.ts`](../../apps/api/src/ports/activity-log.ts)). (b) A typed payload per event type in `@tula/contract`
  (a Zod-free entry point for the type names, like `error-codes`), with a schema version, and
  a test that every `ACTIVITY_TYPES` member has one. (c) The retention job acts on
  `audit.retentionDays`. (d) One outbound-HTTP guard, `~/lib/outbound`, used by 2.2 and 2.3:
  see the threat below.
- **Why now.** Webhooks publish event payloads to other people's code: after 2.2 a payload's
  shape is a public contract and cannot be tidied. Every later step adds events (a phone
  verified, a device bound, a hook refused a sign-in), and adds them typed from the start.
- **Contract.** New exported types; `openapi.json` gains the event schemas as components. No
  route changes.
- **Security.** *Payloads leak.* An audit entry never holds an email, a token or a secret
  (ADR 0012); a webhook payload goes further, to a third party, so the per-type schema is an
  allow-list and a canary test (a secret-shaped value in every input must not appear in any
  payload). *The outbound guard* is the one place the server makes a request to an address an
  operator typed: `https` only outside the `local` tier; the host resolved once and the
  connection made to that address (no second lookup to rebind); private, loopback, link-local,
  CGNAT and metadata ranges refused, v4 and v6, including v4-mapped v6; no redirects
  followed; a deadline; a response-size cap; no proxy from the environment.
- **Tests here.** All of it: unit tests, the store suites, a table of addresses for the guard
  (with a fake resolver; one integration test against a loopback listener that must be
  refused).
- **Done when.** Removing an `activity` argument anywhere is a compile error; every event
  type has a schema and a fixture; the guard's table covers each refused range.

### 2.2 Webhook delivery and signing

- **What.** Endpoints per environment (`webhook_endpoints`: URL, subscribed event types,
  sealed signing secret, enabled, a failure count), a delivery record per endpoint and event
  (`webhook_deliveries`: attempts, next attempt, last status, never the body of the answer
  beyond a status code), and a worker: a job on the existing timer and job lock
  ([`server.ts`](../../apps/api/src/server.ts), `deps.jobLock`) that takes undelivered
  events in batches, posts them, retries with backoff and jitter, gives up after a bounded
  time, and disables an endpoint that has failed for long enough (audited, and shown).
  `events.delivered_at` is set when every subscribed endpoint has been delivered or given up;
  the retention job then deletes delivered events (the delete, its grant and its policy were
  left for this step by [ADR 0017](../adr/0017-retention.md)). Admin routes for endpoints,
  deliveries, "send a test event" and "redeliver". The dashboard's webhooks screen. A
  `verifyWebhook()` helper in `@tula/admin`. `tula.config.ts` gains endpoints (the secret is
  never in the file).
  *As built, first part (TULA-26, [ADR 0034](../adr/0034-webhooks.md)):* the tracer bullet
  only. Endpoints with a sealed secret shown once, the Standard Webhooks signature, one
  attempt per endpoint and event (a failure is recorded and not repeated), the worker inside
  each API instance under its own job lock, `verifyWebhook` in `@tula/admin`, the `webhook`
  conformance step, and two scenarios. `webhook_endpoints` has no failure count and
  `webhook_deliveries` no attempt count or next attempt yet: they arrive with retries. Still
  to come, each its own ticket: retries and disabling a failing endpoint, the delivery log's
  routes with "send a test event" and "redeliver", secret rotation, endpoints in
  `tula.config.ts`, the dashboard screen, the worker as its own service, and deleting
  delivered events. What it did not verify is in
  [phase-2-unverified.md](phase-2-unverified.md).
  *As built, third part (TULA-43, [ADR 0034](../adr/0034-webhooks.md#secret-rotation-added-2026-10-08-tula-43)):*
  secret rotation. The new secret signs beside the previous one for a fixed 24 hours (two
  signatures in the header, the new one's first); an endpoint never has three secrets (a
  rotation during an overlap is refused); the overlap can be ended early; the previous secret
  stops signing by the clock and is deleted by the worker's next round; `verifyWebhook` takes
  one secret or two.
  *As built, the worker as its own service (TULA-52, decision D9, [ADR 0034](../adr/0034-webhooks.md#the-worker-as-its-own-service-added-2026-10-08-tula-52)):*
  `WEBHOOK_WORKER=separate` on every process moves the deliveries into a worker process from
  the same image (`bun run src/worker.ts`; the `worker` service of the Compose file, profile
  `worker`), and an API instance then makes no delivery. A test event and a delivery sent
  again are refused there (`not_implemented`, `worker_separate`); hooks and retention stay in
  the API. The diagnostics gain `webhook_worker`, and CI's `self-host-worker` job delivers a
  webhook through the worker's container.
- **Why now.** First, because it is the oldest promise in the codebase (the outbox has been
  filling since Phase 0) and needs nothing external. Before 2.3 because hooks reuse its
  outbound client, its secret handling and its dashboard patterns.
- **Signing.** HMAC-SHA256 over `id.timestamp.body` with a per-endpoint secret, sent as an
  id, a timestamp and a versioned signature header. This plan recommends following the
  [Standard Webhooks](https://www.standardwebhooks.com/) header names and secret format so
  that existing verifier libraries work in languages Tula has no SDK for. The secret is
  generated by the server, shown once, sealed with `~/lib/secret-box`. **Rotation**: a new
  secret is added and both sign for a fixed overlap, so a receiver can deploy the new one
  before the old one stops.
- **Security.** *SSRF*: every delivery goes through the guard of 2.1, at delivery time, not
  only when the URL is saved (DNS changes). *Replay*: the timestamp is signed and the helper
  refuses one older than five minutes; the event id lets a receiver deduplicate; delivery is
  at least once and says so. *The receiver as an oracle*: nothing from a response is stored
  or shown beyond the status code and a duration, so an endpoint URL cannot be used to read
  an internal service's answers. *Availability*: one slow endpoint must not delay another
  environment's deliveries (a deadline per request, a cap per endpoint per round, a cap on
  concurrent deliveries). *Ordering*: not guaranteed, and documented; payloads carry
  `occurredAt` and the receiver fetches current state when order matters.
- **Open in this step.** The worker's home is decision D9.
- **Tests here.** All of it. The memory and Postgres stores run one suite; the worker is
  tested against a receiver in process with a controllable clock (retry schedule, giving up,
  disabling, rotation overlap, two instances and the job lock). A conformance step type
  `webhook` (the runner starts a receiver; a live target must be able to reach it, which is
  why the scenario is marked like `needsSecretKey` ones are) and scenarios: delivered and
  signed; retried after a 500; a rotated secret verifies with either; an endpoint on a
  refused address is rejected when saved and again when delivered.
- **Cannot be tested here.** A receiver on the public internet, a slow or hostile one at
  scale, and delivery volume beyond one machine.
- **Done when.** A change made through the API arrives at a receiver signed, is retried when
  the receiver fails, and is visible with its attempts in the dashboard; the outbox stops
  growing in a run of the conformance suite.

### 2.3 JWT templates and server hooks

- **What.** *JWT templates*: named sets of extra claims per environment, built from an
  allow-list of user and session fields and constants; a template is chosen per session
  profile. *Hooks*: an environment may register an HTTPS endpoint for a fixed list of points
  (`before sign-up`, `before a session is created`, `before a token is issued`), signed like
  a webhook, that answers allow, deny with a message code, or (token issuance only) extra
  claims. The business plan's "custom validator hook" (4.7) is the `before sign-up` hook.
- **Why now.** After 2.2 (same outbound client, signing and secrets). Before the native SDKs
  because a custom claim changes what `auth()` returns in every client; better that they are
  written against the final token.
- **Why HTTP and not code loaded into the API.** The self-hosted product is a Docker image;
  loading an operator's TypeScript into the process that holds the master key means either a
  rebuilt image or a plugin loader, and it removes the boundary between tenant logic and key
  material. The embedded mode (business plan 5.6) can take in-process functions later with
  the same request and response types. This is this plan's recommendation; the business plan
  says "written in TypeScript" and no more.
- **Contract.** Reserved claims can never be set by a template or a hook (`iss`, `sub`,
  `aud`, `exp`, `iat`, `sid`, `amr`, `auth_time`, `sp`, and whatever 2.10 adds); custom
  claims live under one namespace claim, so a later Tula claim can never collide with a
  customer's. A size cap on the result. Additive: tokens without a template are unchanged.
- **Security.** *SSRF*: the guard of 2.1. *Availability*: a hook is on the sign-in path, so
  it has a short deadline (a recommendation: two seconds, not configurable above five) and
  an explicit per-hook failure mode. `before` hooks that can deny fail **closed** by default
  (a broken fraud check must not wave everyone in); the claims hook fails closed too, since
  a token without a claim an app relies on for authorization is worse than a failed refresh.
  The operator can choose "allow on failure" per hook, and that choice is a recorded
  weakening. *Token refresh is every 60 seconds per session*: a claims hook is therefore
  called at sign-in and when a session's inputs change, and its result is stored on the
  session, not called on every refresh. *Enumeration*: a `before sign-up` denial must not
  turn sign-up into an oracle for which addresses exist; the hook is called only where the
  flow already answers differently. *Data sent out*: the hook's request body is an
  allow-list like a webhook payload; never a password, a code or a token. *A hook is not an
  authority*: it can deny or add claims; it cannot mark an email verified, skip a second
  factor or choose a user.
- **Tests here.** All of it, against a hook receiver in process: deadline, failure modes,
  reserved claims, size cap, the stored result across refreshes. Conformance: a `hook` step
  (reusing the `webhook` receiver), scenarios for a denied sign-up, added claims in
  `expect.claims`, and a hook that times out.
- **Done when.** A scenario signs in and reads a custom claim from the token through
  `@tula/nextjs`'s `auth()`; a hook that hangs fails a sign-in in bounded time and is
  visible to the operator.

### 2.4 SMS: the port, the adapters, phone numbers and codes

- **What.** A `SmsSender` port with three adapters: memory (tests), a development adapter
  that keeps messages where the local tooling can read them (the business plan's "built-in
  SMS inbox", 4.4; this plan recommends an in-memory outbox readable only in the `local`
  tier, like the mock provider's guards), and Twilio. A verified phone number on a user
  (E.164, an allow-list of countries per environment). SMS code as a first factor
  (`sms_code`), and, depending on decision D5, as a second factor.
- **Why now.** Independent of 2.2 and 2.3; it is here because it needs no device. The
  native account chooser and one-tap code autofill on Android and iOS make SMS a method the
  native UI kits should draw from their first version, so the server side should exist.
- **Contract.** New optional `phoneNumber` on the user; a new settings section, off by
  default; a new strategy `sms_code` in `needs_first_factor` (a Phase 1 client that meets it
  shows "not supported" only if it is the only method, which the server already refuses to
  configure silently: document it). New error codes under `sms.` and `phone.`.
- **Security.** This is the step with the most ways to lose money and accounts.
  - *SMS pumping and toll fraud.* An attacker makes the service send messages to
    premium-rate numbers they profit from. Defences, all on by default: a country allow-list
    (empty means SMS is off); per-number, per-IP, per-environment and **per-destination-prefix**
    send limits; a daily spend ceiling per environment that fails closed; no SMS before a
    cheap proof where the flow has one; conversion tracking (codes sent and never used, by
    prefix) surfaced to the operator. A line type lookup ("block VoIP", 4.7) is an option
    that costs money per lookup: off by default.
  - *SIM swap and interception.* A phone number is not a possession factor an attacker
    cannot move. So: an SMS code **never** steps up a session that has a stronger factor,
    **never** resets or removes another second factor, is **never** offered as account
    recovery for an account with TOTP or a passkey, and `amr` records it as its own value so
    an app can refuse it for sensitive actions. Whether it may be a second factor at all is
    D5; this plan recommends "allowed, off by default, never satisfying `required` alone
    where a stronger factor is enrolled".
  - *Enumeration.* Asking for an SMS code answers the same for every number, with the same
    limits and cost, as for emailed codes. For an unknown number that means no message is
    sent (a notice by SMS would itself be pumping), which differs from email and is said in
    the ADR.
  - *Codes.* Six digits, keyed hash, bound to purpose and attempt, the existing lockout, as
    for email. The message names the app and the origin-bound code format
    (`@host #123456`) so platforms autofill it only in the right app.
  - *Number recycling.* A number can pass to another person. A phone number never finds an
    account for linking, and re-verification is required after a period of disuse (the ADR
    sets it).
- **Tests here.** Everything except Twilio: the port suite, flows, limits, the spend
  ceiling, scenarios with a new `smsCode` step reading the development outbox, SDK journeys,
  the React screens, Playwright with axe.
- **Cannot be tested here.** The Twilio adapter against Twilio (it is tested with a stubbed
  `fetch`), delivery to a handset, carrier filtering, sender registration (10DLC in the US,
  sender ids elsewhere), and autofill of the code on a real phone. Needs: a Twilio account,
  a number, and a phone.
- **Done when.** A user signs in with an SMS code in the conformance suite and in the
  browser tests; a run that requests codes for a blocked prefix, and one that exceeds the
  spend ceiling, sends nothing.

### 2.5 More providers: Microsoft, Discord, X, Facebook, LinkedIn

- **What.** Five adapters behind the existing `OAuthProvider` port, each with its
  credentials shape, its row in `FIRST_FACTORS`
  ([`factor/service.ts`](../../apps/api/src/modules/factor/service.ts)), a setup checklist
  under `docs/providers/`, the mock provider, the React button and the dashboard card.
- **Why now.** No dependency; it widens `OAUTH_PROVIDERS` before the native SDKs draw
  provider buttons, so they draw eight from the start.
- **Contract.** New enum members. Provider is already an open list for clients.
- **Security.** The account-linking rule does not change: automatic only when the provider
  asserts the address verified and Tula's is verified too. What changes is that **most of
  these providers do not assert it in a way that can be trusted**:
  - Microsoft's multi-tenant endpoint returns an `email` claim a tenant administrator can
    set to anything (the "nOAuth" class of takeover). The adapter must identify the account
    by `tid` + `oid`, and treat the address as unverified unless the token carries the
    verified-domain claim. The issuer differs per tenant and must be validated against the
    token's own `tid`.
  - Discord returns a `verified` flag; LinkedIn's OIDC returns `email_verified`; Facebook
    returns an address with no verified flag; X often returns no address at all. Each
    adapter's `emailVerified` is `false` unless the provider says otherwise in a signed or
    first-party answer, and a provider with no address signs up an account with none.
  - X and Facebook are OAuth 2.0 without OIDC: the profile comes from an API call with the
    access token, which stays inside the adapter (ADR 0026). PKCE wherever the provider
    supports it; where a provider documents none, that is recorded like Apple's is.
- **Tests here.** Adapters with stubbed HTTP and locally generated keys; the mock provider
  for scenarios and browser tests; a table test of the linking outcome per provider.
- **Cannot be tested here.** Any of the five against the real provider. Needs a developer
  account and an app registration with each; X's API access may need a paid tier (not
  checked for this plan).
- **Done when.** Each provider signs up, signs in and links in the scenarios through the
  mock, and the per-provider linking table is in ADR 0026's successor.

### 2.6 Password history and expiry

- **What.** Enforce `history` (keep the last N hashes; refuse a new password that matches
  one) and `expiryDays` (a sign-in with an expired password stops at `needs_new_password`
  after the first factor and any second factor).
- **Why now.** Small, independent, and the contract already promises it.
- **Contract.** A new error code `password.reused`. `needs_new_password` already exists as a
  status; reaching it from a sign-in is new for clients, and the three web SDKs and the
  scenario format must handle it in this step.
- **Security.** Old hashes are argon2id like the current one and deleted beyond N; checking
  N hashes costs N verifications, so N is capped (the schema allows 24: the step measures it
  and lowers the cap if a change-password call becomes a denial-of-service lever). An
  expired password must not skip the second factor, and must not be changeable with the
  first factor alone by someone who has only the password where the user has MFA.
- **Tests here.** All of it. Scenario: reuse refused; expiry forces a change, with a
  controllable clock in process and a short expiry live.
- **Done when.** Both rules hold in the scenarios and the live checklist shows them.

### 2.7 Email and SMS templates

- **What.** Per-environment overrides of each message's subject and body, stored and
  versioned, edited in the dashboard with a preview and a "send me a test", managed from
  `tula.config.ts` as files. The built-in copy stays the default.
- **Why now.** After 2.4 so that it covers SMS bodies too. Before the native work only
  because it is server-and-dashboard work that can run in parallel.
- **Security.** A template is operator-supplied text rendered into mail to end users.
  *Injection*: a small logic-free template language with a fixed variable list per message
  (no expressions, no includes, no raw HTML variables); values are escaped by the renderer,
  never by the template; headers are never templated beyond the subject, which is stripped
  of line breaks. *Phishing by a compromised operator account or by an agent* (2.17): a
  template change is audited, announced in the dashboard, and a template cannot remove the
  parts a security notice depends on (the code, the app name, "if this was not you").
  *Rules that must survive customization*: a subject never starts with digits and a notice
  carries no link or code (`AGENTS.md`, ADR 0023); the renderer enforces them and refuses to
  save a template that breaks them. *HTML*: sanitized to an allow-list of tags and
  attributes; no script, no remote CSS, no forms; links only `https`.
- **Not in this step.** A drag-and-drop visual editor, React Email or MJML input (business
  plan 4.6, layer 5), and per-locale templates. The step ships a text editor with a preview.
  This plan recommends that scope; it is the first thing to grow if the phase has room.
- **Tests here.** All of it: renderer table tests, canaries, Playwright on the editor.
- **Cannot be tested here.** How real mail clients render a customized template.
- **Done when.** An environment sends a customized sign-in email in a scenario and the
  default one after the override is removed.

---

## Milestone B — What native clients need from the server

### 2.8 Native app identity

- **What.** An environment's settings gain `apps`: iOS apps (team id, bundle id) and Android
  apps (package name, SHA-256 signing-certificate fingerprints). From them the server:
  - serves `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` for
    the API's own host, and prints them (`tula`) for an operator who hosts the relying-party
    domain elsewhere, which is the usual case: the passkey `rpId` is the app's domain, not
    the API's;
  - accepts a native passkey ceremony: Android's origin is `android:apk-key-hash:<hash>`,
    checked against the registered fingerprints; iOS sends an `https` origin of the
    associated domain. `Passkeys.relyingParty` stays the one place that decides, and still
    takes nothing from a request body;
  - accepts redirect URLs for native apps: `https` app links and universal links as today,
    and custom schemes only where an app is registered, matched exactly.
- **Why now.** 2.9, 2.13, 2.14 and 2.15 all need it, and it is pure server work.
- **Contract.** A new settings section with a default of no apps; the stricter and lenient
  schemas both; the weakening rules extended (adding an app or a fingerprint widens who can
  complete a ceremony, so it is a recorded change).
- **Security.** *An Android origin is asserted by the platform to the authenticator, not by
  the app to the server*: the hash arrives inside signed client data, so it is trustworthy
  only through the WebAuthn verification, never from a header. A native client sends no
  `Origin`; the rule "no `Origin`, no passkey" becomes "no `Origin`: the origin is read from
  the verified client data and must be a registered app", and the browser rule is unchanged.
  *Custom schemes can be claimed by any app on the device*: that is why PKCE and the
  binding of ADR 0026 stay mandatory, why app links are recommended over schemes in the
  docs, and why a custom-scheme redirect is never honoured for a `web` attempt. *The
  association files are public and name the apps*: nothing else goes in them.
- **Tests here.** All of the server: the software authenticator in `@tula/conformance`
  gains an Android-origin mode; scenarios for a registered and an unregistered app; table
  tests of the redirect rule.
- **Cannot be tested here.** Whether iOS and Android accept the served files (Apple fetches
  them through its own CDN, from a public https host, and caches them). Needs the tunnel
  (2.12), a registered app and a device or simulator.
- **Done when.** A scenario registers and uses a passkey as an Android app and is refused as
  an unregistered one.

### 2.9 Native Google and Apple: ID-token exchange

- **What.** The second port method [ADR 0026](../adr/0026-oauth.md) left room for:
  `verifyIdToken`, over the verifier in
  [`adapters/oauth/id-token.ts`](../../apps/api/src/adapters/oauth/id-token.ts). A flow: the
  app starts an attempt and receives a nonce; the platform's own sheet (Sign in with Apple;
  Credential Manager with Google) returns an ID token; the app submits it on the attempt;
  the server verifies it and continues through `OAuth.resolveAccount` and
  `Factors.requiredFor` exactly as the web exchange does. The mock provider issues ID tokens
  for tests.
- **Why now.** After 2.8 (the audiences come from the registered apps). Before the SDKs so
  that each implements a finished protocol.
- **Contract.** New routes under the sign-in flow; the provider's settings gain the native
  client ids (Google needs iOS, Android and web client ids; Apple's audience for a native
  app is the bundle id, not the Services ID).
- **Security.** An ID token is a bearer assertion. Without all of the following, a token
  issued to *another* app for the same user signs that user in here.
  - **Audience.** Exactly one of the client ids registered for this environment and this
    provider. Google tokens from Android carry the *web* client id as `aud` and the Android
    client in `azp`; both are checked against the registered set. Never "any audience from
    this issuer".
  - **Nonce.** The server issues it on the attempt, single use, short-lived; the token must
    carry it (Apple hashes it: the client sends SHA-256 of the raw nonce to the sheet and
    the raw nonce to the server). This is what stops a token captured elsewhere, or issued
    earlier, from being replayed into a new attempt.
  - **Issuer, signature, algorithm, expiry, `iat` freshness** as the web path. The key set
    is fetched from a fixed URL with a deadline, never from the token's header.
  - **No access to the unsigned parts.** Apple gives the name outside the token on first
    authorization: display only, as today.
  - **Linking is unchanged**, and the "verified" rule with it. A hybrid of the two paths
    must not appear: an ID token is accepted only on an attempt started for native exchange.
  - **No client attestation.** The server cannot know the request came from the real app;
    that is what audience and nonce are for, and it is said in the ADR.
- **Tests here.** The verifier with locally generated keys (wrong audience, `azp` mismatch,
  missing or reused nonce, expired, wrong issuer, `alg: none`, a symmetric key, a token for
  the web flow presented natively). Scenarios through the mock provider's ID tokens.
- **Cannot be tested here.** Real tokens from Apple and Google, which need: an Apple
  Developer account (paid) with Sign in with Apple enabled on an app id, a Google Cloud
  project with OAuth clients for iOS, Android (package and fingerprint) and web, and a
  signed build on a device or a simulator signed in to an account. Whether Google's Android
  tokens look as described above must be confirmed against a real one before this step is
  called verified.
- **Done when.** The scenarios pass, and the failure table above is a table test.

### 2.10 Device binding (server side)

- **What.** A session can be bound to a key the device holds and cannot export: generated in
  the Secure Enclave or the Android Keystore (StrongBox where present), public key sent at
  sign-in, and a signed proof on every refresh. A profile option
  `deviceBinding: 'none' | 'optional' | 'required'`; default `none` for `web`, `optional`
  for `mobile`. The device list shows a bound session as such.
- **Why now.** See "Why this order". After 2.8.
- **Design, recommended here and to be fixed in the step's ADR.** DPoP-shaped proofs
  (RFC 9449): a signed JWT per request carrying the method, the URL, a timestamp, a unique
  id and a server-provided nonce; the session stores the key's thumbprint; a refresh without
  a valid proof for that key is refused **without** ending the session. Binding refresh only,
  not every API call, in this phase: the access token lives 60 seconds and binding it means
  every resource server must check proofs.
- **Contract.** A new optional claim on the access token for the key thumbprint (`cnf`),
  reserved in 2.3. New optional headers. Additive: an unbound session is as today.
- **Security. What it proves:** that the refresh came from a process that can use the
  private key generated at sign-in, so a refresh token copied out of a backup, a log or a
  compromised storage layer is useless elsewhere. **What it does not prove:** that the key
  is in hardware (without attestation the server takes the client's word), that the app is
  the genuine app, or that the device is not compromised: malware on the device uses the
  key in place. It does nothing for the 60-second access token. So it is never described
  as "device verification" in UI or docs.
  - *Attestation* (App Attest, Play Integrity) would prove more and ties the product to
    Apple's and Google's services, with quotas and an online check. Not in this phase;
    decision D12 lists it as cut.
  - *Replay*: the unique id is remembered for the proof's lifetime (the shared store, fails
    closed like the other shared state) and the server nonce bounds pre-computed proofs.
  - *Reuse detection interacts*: a bad proof must not trigger family revocation, or anyone
    holding a stolen refresh token can sign the victim out at will; it is counted and
    audited instead.
  - *The grace window* (the same child token within 10 seconds) still requires a proof.
  - *Key loss* (app reinstall, restore to a new phone) ends the session by design; the user
    signs in again. The device list and the new-device notice (ADR 0023) can finally mean a
    device: this plan recommends replacing that definition for bound sessions, as the ADR
    said it would be.
- **Tests here.** All of the server, with a software key in `@tula/conformance` (Web Crypto
  P-256): bound refresh, missing proof, wrong key, replayed proof, stale nonce, grace
  window, `required` refusing an unbound sign-in from a native client.
- **Cannot be tested here.** That a key really is non-exportable on a device; Secure Enclave
  and StrongBox behaviour; what happens across an OS restore. The simulator has no Secure
  Enclave. Needs physical devices of both platforms.
- **Done when.** The scenarios pass and `@tula/core` can bind a session with a software key
  (for the `server` client kind and for tests).

### 2.11 The conformance suite as a client test

- **What.** Three additions, so that three clients are held to one behaviour.
  1. **A language-neutral journey list.** `conformance/client-journeys.json` (built in
     TULA-20; its format is in [`conformance/README.md`](../../conformance/README.md)): every scenario name,
     and per client kind either "journey" or "not applicable" with the reason. The guard in
     `sdk-journeys.test.ts` reads it; the Swift and Kotlin suites read the same file and
     fail when a scenario has no journey of that name. A new scenario then fails four test
     suites until each has decided.
  2. **A fixture server the native suites can start.** Today's browser fixture
     ([`e2e/server.ts`](../../e2e/server.ts): the real API in process on memory adapters,
     sent email readable at `/__test/outbox`, behind `e2e/guard.ts`) gains what native
     journeys need: the SMS outbox, the mock provider's ID tokens, a clock the test can
     move, and **fault injection** for the client-only behaviours. It stays outside the API
     image and behind the same guard.
  3. **Client behaviours as named cases.** [ADR 0013](../adr/0013-conformance-suite.md) says
     concurrent refresh "is not expressible" as an HTTP scenario. It is expressible as a
     named case each SDK must implement against the fixture: N concurrent `getToken()`
     calls make one refresh; a refresh whose response is lost recovers through the grace
     window; a storage write that fails is reported and the session continues; a clock two
     minutes off still refreshes on time; an unknown step renders "not supported"; a
     revoked session is noticed within one access-token lifetime; a bound refresh carries a
     fresh proof. The list is a file; each SDK's guard reads it.
- **Why now.** Last server-side step before any native client, so that each client is
  written against the list rather than the list being fitted to the first client. It also
  re-proves `@tula/core`: the TypeScript SDK implements the named cases first.
- **Security.** The fixture is a server that signs anyone in as anyone. Its guards
  (`E2E=1`, loopback `Host`, no `Origin`, excluded from the image) are kept, and the fault
  injection routes go behind them. A phone on a LAN cannot reach it by design; device runs
  use the packaged stack with the mock provider, which already refuses anything but the
  `local` tier and a loopback `PUBLIC_URL`. **That refusal is in the way of physical-device
  testing with the mock provider and must not be loosened**: on a device the real
  providers are used (2.18).
- **Tests here.** All of it.
- **Done when.** `@tula/core` passes every named case, and deleting a journey from any
  client's suite fails that suite.

---

## Milestone C — Reaching a phone

### 2.12 The tunnel, and `tula doctor` for native apps

- **What.** `tula dev --tunnel`: starts a tunnel to the local API through the injectable
  `Host` (an argument vector, a timeout, as [ADR 0031](../adr/0031-instance-admin-and-cli.md)
  requires), learns its public https URL, restarts the API with that `PUBLIC_URL`, adds the
  origin to the development environment's settings, and prints what to put in the app.
  `tula doctor` gains native checks from the server's side (the association files are
  served, parse and name the registered apps; each provider's native client ids are set)
  and, run inside an app project, static ones (the bundle id, the associated-domains
  entitlement, the Android package and the intent filters match what is registered).
- **Why now.** See "Why this order".
- **Security.** A tunnel publishes a development auth server, with its mail outbox and its
  seeded keys, on the internet. So: off unless asked for, every run; a warning that names
  what is exposed; `OAUTH_MOCK_PROVIDER` refused while a tunnel is up (its existing loopback
  rule already does this; keep a test); the dashboard and `/v1/instance/*` not reachable
  through the tunnel unless explicitly allowed; the development SMS and mail outboxes
  never readable from a non-loopback address; the tunnel torn down with `tula dev down` and
  on exit. The CLI downloads nothing: it runs a tunnel binary the developer installed, and
  says how to install it. `doctor` still never requests an address from the server's answer
  other than the origin the operator gave.
- **Open.** Which tunnel (decision D10). A tunnel with a stable hostname matters: Apple
  caches association files per domain, and a passkey is bound to its `rpId`, so a hostname
  that changes per run orphans every passkey made the run before.
- **Tests here.** The command with a fake `Host` (start, URL parsing, settings change,
  teardown, refusal cases). No tunnel binary is installed on the machine this plan was
  written on.
- **Cannot be tested here.** A real tunnel, and anything through it, without the binary, an
  account with the tunnel's provider for a stable hostname, and a domain.
- **Done when.** A phone on mobile data opens the development API's status page over https
  (recorded per rule 4), and `tula doctor` names a deliberately wrong bundle id.

### 2.13 `@tula/expo` (headless)

- **What.** A package on `@tula/core`: a secure-store `TokenStorage`
  ([`storage.ts`](../../packages/core/src/storage.ts) is the interface), the provider and
  hooks of `@tula/react` that have no DOM in them, app-state-aware refresh (a foregrounded
  app refreshes; a backgrounded one does not hold a lock), OAuth through the system browser
  session with PKCE and the app-link redirect of 2.8, native Google and Apple through the
  platform sheets (2.9), passkeys through a native module, device binding (2.10) through a
  native key module, and a config plugin that writes the associated domains, the intent
  filters and the provider client ids from one place. No prebuilt UI (decision D8): the
  `create-tula` Expo template carries example screens the app owns.
- **Why now.** It reuses the client that already passes everything, so it is the cheapest
  way to put a real app on a real phone and to find what 2.8 to 2.12 got wrong, before two
  native SDKs are built on them.
- **Refactoring it forces.** The hooks and the provider logic shared by `@tula/react` and
  `@tula/expo` move to where both can import them without a DOM. `@tula/core`'s passkey
  code takes the ceremony from an injected implementation (it already looks
  `navigator.credentials` up through its environment). `@tula/core` stays Zod-free and
  free of Node, Bun and now React Native APIs.
- **Security.** *Storage*: the refresh token in the Keychain with
  `WHEN_UNLOCKED_THIS_DEVICE_ONLY`-class protection (not synced, not in backups) and the
  Android Keystore-backed store; never AsyncStorage, never a log, never a crash report.
  *Deep links*: a link into the app is untrusted input; the emailed-link binding and the
  OAuth binding (ADR 0024, ADR 0026) are what make one safe and both must be held by the
  app that started the attempt, in secure storage rather than `localStorage`/`sessionStorage`.
  *The emailed link on mobile*: "the browser that asked" becomes "the app that asked",
  which only works when the link opens the app (a universal or app link); otherwise the
  code in the same email is the path, as already designed. *Expo Go* cannot hold custom
  native modules: there the package offers password, emailed code and browser OAuth only,
  and says so in words rather than failing.
- **Tests here.** Unit tests under Bun with the native modules faked (the same harness
  pattern as `@tula/react`), the named cases of 2.11, the journeys, `typecheck:portable`.
  The config plugin is tested on fixtures of `app.json`. The iOS simulator can run the JS
  and the system browser flow; Xcode is installed on the machine this plan was written on,
  an Android emulator image and Gradle were not checked.
- **Cannot be tested here.** Keychain protection classes, passkeys (the simulator supports
  them only partly, and a physical Android device needs Google Play services and a screen
  lock), native Google and Apple, the config plugin's output in a signed build. Needs:
  Xcode, an Android SDK with an emulator, both developer accounts, and one phone of each
  platform.
- **Done when.** The scaffolded Expo app signs up, signs in and refreshes on the iOS
  simulator and an Android emulator against the fixture; and on one physical device of each
  platform, through the tunnel, signs in with a passkey and with native Google (recorded
  per rule 4). Until the second half has happened the step is "merged, unverified".

---

## Milestone D — Native SDKs

### 2.14 Swift: `TulaAuth` and `TulaAuthUI`

- **What.** A Swift package under `native/swift` with two products (rule 2). `TulaAuth`:
  the client, flows as values of the server's step, the session with single-flight refresh
  (an actor), Keychain storage behind a protocol, device-binding keys in the Secure
  Enclave, passkeys through `ASAuthorizationController`, Sign in with Apple, Google through
  its ID-token flow. `TulaAuthUI`: `SignIn`, `SignUp`, `UserButton`, `UserProfile` in
  SwiftUI, a screen per step status with "not supported" as the default, the live password
  checklist, slots for header, footer and fields (business plan 4.4), a theme generated
  from [`@tula/contract/theme`](../../packages/contract/src/theme.ts) plus "inherit the
  host's tint and fonts".
- **Generated or written.** Decision D7. This plan recommends: the request and response
  types and the error-code and theme constants are **generated** from `openapi.json` and
  the contract by a generator in this repository (as `@tula/core`'s are), and everything
  with behaviour is written by hand.
- **Why now.** After 2.11 (the list it is written against) and 2.13 (the server-side
  mistakes already found). Parallel with 2.15.
- **Security.** Everything in 2.13's list, natively; plus: the password policy evaluator is
  ported and must agree with the TypeScript one on a shared fixture file (thousands of
  password and policy pairs generated from `@tula/contract`'s own tests), because a
  checklist that disagrees with the server teaches users to distrust it; theme values are
  untrusted and go through the same grammar as on the web; no token, code or password in
  `UserDefaults`, a pasteboard, a log, a screenshot of the app switcher (secure fields) or
  an accessibility label; the one-time-code field uses the platform's autofill; the passkey
  sheet is never started twice at once and a dismissed sheet is neither an error nor a
  success, as on the web.
- **Accessibility** is part of done as on the web: VoiceOver labels and order, Dynamic Type
  to the largest sizes, contrast from the same tokens, state in words. There is no axe on
  iOS: the step uses Xcode's accessibility audit in UI tests, and says what it does not
  cover.
- **Tests here.** `swift test` on macOS for `TulaAuth` against the fixture: the journeys,
  the named cases, the policy fixture. Snapshot or UI tests of `TulaAuthUI` on a simulator.
  CI needs a macOS runner; the repository's workflows run on `ubuntu-latest` only today
  ([`ci.yml`](../../.github/workflows/ci.yml)), so this step adds a job and its cost is
  decision D6.
- **Cannot be tested here.** Secure Enclave keys, passkeys end to end, Sign in with Apple
  and Google, universal links: a physical iPhone, a paid Apple Developer account, a
  registered app id with the capabilities, and the tunnel. Distribution through Swift
  Package Manager needs a public tag, which needs the licence.
- **Done when.** Every journey and named case passes on macOS; the UI tests pass on a
  simulator; a sample app on a physical iPhone signs in with a password, a passkey, Apple
  and Google (recorded per rule 4).

### 2.15 Kotlin: `tula-android` and its Compose module

- **What.** The mirror of 2.14 under `native/android`: a client module that is plain Kotlin
  on the JVM (rule 2), an Android module for Keystore storage, device-binding keys,
  Credential Manager (passkeys and Google) and App Links, and a Compose module with the
  same four components, slots, generated theme and "inherit `MaterialTheme`".
- **Why now.** As 2.14.
- **Security.** As 2.14, with the platform's differences: Credential Manager returns the
  Google ID token and the passkey response; the APK signing fingerprint is part of the
  passkey origin and of Google's client registration, and **debug, release and Play App
  Signing builds have three different fingerprints**, which is the commonest reason native
  sign-in "silently fails" (business plan 2) and must be the first thing `tula doctor`
  checks; `FLAG_SECURE` on screens that show a setup key or backup codes; no token in
  `SharedPreferences`, a log or a `Bundle` saved by the system; StrongBox when present,
  the TEE otherwise, and never a claim of which.
- **Accessibility.** TalkBack, font scale, contrast from tokens; Compose UI tests with
  semantics assertions.
- **Tests here.** The client module's journeys and named cases on the JVM against the
  fixture, on a Linux runner. Compose tests on the JVM where they can run without a device,
  and on an emulator. An Android SDK directory with an emulator exists on the machine this
  plan was written on; Gradle and `adb` were not on the path and nothing was run.
- **Cannot be tested here.** Keystore-backed keys, Credential Manager with a real Google
  account and a real passkey provider, App Links verification: a physical Android phone
  with Play services, a Google Cloud project, the release fingerprint, and the tunnel.
  Distribution through Maven Central needs a namespace, a signing key and the licence.
- **Done when.** As 2.14, for Android.

### 2.16 Expo: the native components

- **What.** `@tula/expo` gains the prebuilt UI by wrapping `TulaAuthUI` and the Compose
  module through Expo Modules (business plan 5.7), driven by the same session the headless
  layer of 2.13 holds: one session, one storage entry, one refresh in flight, whichever
  side asks.
- **Why now.** It needs both native SDKs.
- **Security.** The hard part is two runtimes sharing one session. The rule this plan
  recommends: the native client owns the tokens and the refresh; the JavaScript side asks
  it. Two refresh loops over one refresh token would trip reuse detection and sign the
  user out, and the grace window exists to forgive accidents, not to carry a design.
- **Tests here.** The JavaScript side with the native module faked. Everything real needs a
  development build on a simulator, an emulator and devices.
- **If the phase must shrink, this is the first step to go** (D12): 2.13 already gives Expo
  apps sign-in, and an app can build screens from the hooks.
- **Done when.** The Expo example draws the native sign-in on both platforms and stays
  signed in across a restart, with one refresh per expiry in the server's log.

---

## Milestone E — Agents

### 2.17 MCP write tools, approvals and `test_signin`

- **What.** A second facade beside `ReadOnlyAdmin`, as ADR 0033 said it would be, over an
  allow-list of mutating operations, each classed: *reversible* (ban, unban, end a session,
  switch a provider off) or *not* (delete a user, reset a user's factors, rotate keys,
  replace settings). Write tools for the first class; settings changes as a `tula.config.ts`
  diff the agent writes to the repository and a human applies with `tula apply` (the
  business plan's "config as code", 4.5); and `test_signin`: a synthetic sign-up and
  sign-in of a throwaway user through the real flow, reported step by step.
- **Why now.** Independent of the native work; after Milestone A so that there are webhooks,
  hooks and templates worth configuring. The business plan puts it "alongside the native
  SDKs".
- **Security.** The threat is prompt injection: the server already returns text written by
  strangers (a user's name, a user agent), and a model that reads "ban every user" in a
  display name now has a tool that bans.
  - **A human approves every write, outside the model's control.** The MCP client's own
    confirmation is not enough (many are set to always allow). This plan recommends a
    two-step write: the tool returns a *proposal* (an id, a plain description, the exact
    operation and target) and performs nothing; the operator approves that id in the
    dashboard or with `tula approve <id>` in a terminal, using their own credential; the
    proposal expires in minutes, is single use, and is bound to the exact operation. The
    model never sees a credential that can approve.
  - **The agent's key is not the operator's.** A new key kind or scope for the MCP server
    that can read, and can *propose*; it cannot write. This needs a contract change
    (key scopes) and is the largest design question of the step. Without it, "approval" is
    a convention the server process could skip.
  - **Production.** Refused by default for write proposals; an environment opts in. The
    business plan says the token "is scoped to the dev environment".
  - **Attribution.** Every proposal, approval and execution is audited with actor type
    `agent` (reserved in [`audit.ts`](../../packages/contract/src/audit.ts)) and the
    approving human's actor beside it.
  - **Never a tool**: anything in the irreversible class, anything that returns or sets a
    secret, template edits that reach end users without the same approval, and bulk
    operations. Rate limits per tool.
  - **`test_signin`** creates a user: only in an environment that allows it, with a marked
    address that can never collide with a real one, deleted at the end, and never returning
    the session's tokens to the model.
  - Results stay allow-list projections through `sanitize.ts`.
- **Tests here.** All of it: the facade's type-level allow-list, a canary corpus of
  injection strings in every field a tool returns followed by an assertion that no write
  happened without an approval, expiry and single use of a proposal, the audit entries.
- **Cannot be tested here.** How real MCP clients present a proposal, and whether a model
  can be talked into persuading the human. The Phase 1 server was never connected to a
  real client ([unverified list](phase-1-unverified.md#runtimes-and-browsers)); that item
  must be closed before this step ships.
- **Done when.** An agent's proposal to ban a user does nothing until approved in the
  dashboard, appears in the audit log with both actors, and cannot be approved twice.

---

## Milestone F — Exit

### 2.18 Examples, docs, the device pass and the whole-phase review

- Example apps: Expo, SwiftUI and Compose, each the test bed for its SDK; `create-tula`
  templates for all three, synced from them as today.
- Docs: a quickstart per platform, method pages extended (SMS, native Google and Apple,
  passkeys on devices), webhooks, hooks and JWT templates, the provider checklists
  rewritten after being clicked through.
- **The device pass.** One sitting with the owner, real accounts and real phones, working
  through the Phase 1 [unverified list](phase-1-unverified.md) and Phase 2's. Its output is
  a list of what was seen working, on what, and what was not.
- A four-pass review of the phase, and a focused threat review of: ID-token exchange,
  device binding, webhooks and hooks (SSRF), SMS abuse, MCP writes.

## Exit criteria

- Every conformance scenario passes in process and against two packaged instances behind
  one address, and has a decision in `@tula/core`, `@tula/expo`, Swift and Kotlin; every
  named client behaviour (2.11) passes in all four.
- `bun run verify`, the Playwright job, the Swift job and the Kotlin job are green; coverage
  targets are met.
- A webhook is delivered, signed, retried after a failure and visible with its attempts in
  the dashboard; a custom claim set by a hook is read by an app.
- A new Expo app goes from `create-tula` to a sign-in with a passkey and with native Google
  on a physical iPhone and a physical Android phone, through the tunnel, without editing
  server code. The same for the SwiftUI and Compose examples.
- A sign-in with an SMS code reaches a real handset through Twilio, and a pumping run
  against a blocked prefix sends nothing.
- A refresh token copied from a bound session is refused from another client.
- An agent's write does nothing until a human approves it.
- Every item on the Phase 1 unverified list marked below as "must be closed" is closed or
  explicitly accepted by the owner in writing.
- The whole-phase review reports no blocking findings.

Criteria that need the owner (accounts, devices, money) are met by the device pass, not by
CI. If the phase ends without them, it ends as "built, not verified", and the README says so
in the words Phase 1 used.

---

## Not in Phase 2

Organizations, RBAC, invitations, verified domains, per-organization policy and branding,
and the importers are Phase 3 (business plan, section 8). Enterprise SSO, SCIM and billing
are Phase 4. The fraud and risk engine, OAuth provider mode, Flutter, Vue and Svelte are
Phase 5.

Deferred to V2 with the cloud (business plan 5.8): the managed service, the control plane
and operator accounts, white-label entitlements, hosted pages and managed custom domains,
the remote OAuth-protected MCP server, shared development OAuth credentials.

Considered for this phase and left out, with no phase assigned by any document:

- Device attestation (App Attest, Play Integrity), biometric unlock of a session, and the
  `kiosk`, `stateless` and `long-lived` session types.
- Binding the access token (not only refresh) to the device key.
- SMS as account recovery; voice calls; WhatsApp.
- A generic OIDC provider, provider API access on a user's behalf.
- A theme stored per environment, the dashboard theme editor, live preview on a device,
  design-token export to Tailwind.
- A visual email editor, React Email or MJML input, per-locale templates, and translations
  of the SDKs' strings beyond English.
- `minStrengthScore` and `onPolicyTightened` (business plan 4.7).
- Node/Bun and Python SDKs.
- In-process TypeScript hooks for the embedded mode.
- UIKit and Android Views components (decision D4).

## Decisions

Settled on 2026-10-08, when the plan was approved to start. The options each was chosen from
are in [the table below](#decisions-needed-before-starting).

| # | Decision | Outcome |
| --- | --- | --- |
| D1 | Licence | **Apache-2.0 for the whole repository**, server included (business plan 10.1), not the split recommended below. Publishing is no longer blocked by it. |
| D2 | Package names | The owner reserves the `@tula` npm scope, a Maven group and the Swift package name now. On 2026-10-08 `@tula/core`, `@tula/react` and `create-tula` were unpublished on npm; whether the `@tula` organization itself is free was not determined. |
| D3 | Developer accounts and identifiers | One set owned by the project (Apple Developer Program, Google Play Console and Cloud project, a physical iPhone and Android phone, a domain), set up by the owner while Milestone A is built. |
| D4 | Minimum OS versions and UI toolkits | iOS 16 and Android API 28; SwiftUI and Compose only. The floors are confirmed against platform documentation when 2.14 and 2.15 start. |
| D5 | SMS | Twilio only. A first factor and a second factor, both off by default; never a step-up or recovery path for an account with a stronger factor; its own `amr` value. |
| D6 | CI for native code | The macOS job runs on PRs that touch `native/swift`, `packages/contract` or `conformance/`, and nightly. Kotlin's client tests run on Linux in the normal job. |
| D7 | Producing the native SDKs | The repository's own generator for types, error codes and theme constants; behaviour by hand. |
| D8 | Expo | Both, in two steps: headless on `@tula/core` (2.13), native UI through Expo Modules (2.16). No React Native UI kit of Tula's own. |
| D9 | The webhook worker | Inside the API by default, with a switch to run it as a separate service from the same image. No queue. |
| D10 | The tunnel | One service behind the `Host` interface, chosen when 2.12 starts for a stable hostname without payment. |
| D11 | Hooks | HTTP only in this phase. |
| D12 | Scope and the cut order | The full eighteen steps. If the phase must shrink, in this order: 2.16, 2.7, three of the five providers, SMS as a second factor, 2.6. If only one native SDK can be finished, Swift. |
| D13 | Publishing | Alphas during the phase, as soon as D2 allows. |

Design questions settled the same day, each to be fixed in its step's ADR:

| Step | Question | Outcome |
| --- | --- | --- |
| 2.2, 2.3 | Signature format of webhooks and hook requests | The Standard Webhooks header names and secret format. |
| 2.3 | A hook that fails or exceeds its deadline | Refuses the sign-in by default; "allow on failure" is the operator's choice per hook and a recorded weakening. |
| 2.4 | Enrolment of a second factor after an SMS-only sign-in, under `mfa.policy: required` | Refused until the user also proves a verified email address or a password. |
| 2.10 | Whether a device outlives a session | It does not. A device is a bound session: no `devices` table, and losing the key ends the session. |
| 2.10 | Revoking a user's other sessions without a recent authentication | Stays as it is: it is how an owner evicts someone else, and misuse only makes the owner sign in again. |
| 2.17 | How an agent's write is authorized | A key kind that can read and propose and never write; a human approves each proposal in the dashboard or with `tula approve`; reversible operations only; production only where the environment opts in. |

How the phase is worked is unchanged from Phase 1: one step per branch, `/review-loop`, merged
into `develop` when CI is green, and UI checked by hand, now on simulators and phones as well
as in a browser. Milestone A starts before the Phase 1 [unverified list](phase-1-unverified.md)
is closed; each item is closed before the step [that depends on it](#what-on-the-phase-1-unverified-list-gets-more-dangerous).

## Decisions needed before starting

Kept as written on 2026-10-04, for the options and the reasons. The outcomes are
[above](#decisions).

"Owner" is the person who owns the repository and the accounts. "Lead" is whoever leads the
build and can decide alone.

| # | Decision | Options | Recommendation and reason | Who |
| --- | --- | --- | --- | --- |
| D1 | **Licence.** Deferred since Phase 0. It blocks publishing anything: npm (so `npx create-tula` does not exist), a public tag for Swift Package Manager, Maven Central, a registry for the image. | Apache-2.0; AGPL-3.0; a source-available licence (ELv2, BSL); split (SDKs permissive, server copyleft or source-available). | **Split: Apache-2.0 for the SDKs, the contract, the CLI and the conformance suite; decide the server separately.** An SDK is linked into customers' apps and app-store binaries: anything but a permissive licence there stops adoption regardless of the server's. The server's choice is a business question (business plan 10.1) this plan cannot answer. Not legal advice; have it reviewed. | Owner |
| D2 | **Package names.** The npm scope `@tula`, the Swift package name, the Maven group id. | `@tula/*` if the scope can be had; otherwise a different scope. For Maven, a group under a domain the owner controls. | Check availability now and reserve all three the day D1 is settled. A rename after the native SDKs exist touches every import in three languages. Whether `@tula` is free on npm was not checked for this plan. | Owner |
| D3 | **Developer accounts and identifiers.** Apple Developer Program (paid, yearly), a Google Play Console account (one-time fee) and a Google Cloud project; the bundle id and package name of the example apps; a domain for associated domains and the passkey `rpId`. | One set for the project's examples and tests; or each contributor's own. | One set owned by the project, with the identifiers written into the examples, and a documented way for a contributor to substitute their own. Needed by 2.9 for verification and by everything in Milestones C and D on a device. | Owner |
| D4 | **Minimum OS versions and UI toolkits.** | iOS 16 or 17; Android API 26, 28 or higher. SwiftUI only or UIKit as well; Compose only or Views as well. | **iOS 16 and Android API 28 (Android 9); SwiftUI and Compose only.** Passkeys need iOS 16, and Credential Manager works back to API 28 for passkeys with Play services. A UIKit or Views app can host SwiftUI and Compose screens, and the client modules have no UI at all, so nothing is closed off. The exact floors should be confirmed against current platform documentation when the step starts; they were not verified for this plan. | Lead, confirmed by owner |
| D5 | **SMS provider, and whether SMS may be a second factor.** | Provider: Twilio only; Twilio and one more. Second factor: never; allowed and off by default; allowed and on. | **Twilio only** (one real adapter plus the development one satisfies the port rule). **A first factor and a second factor, both off by default; never a step-up or recovery path for an account with a stronger factor; reported in `amr` as its own value.** Refusing it as a second factor entirely is the safer product and loses the customers whose users have nothing else. The owner should also decide who pays for the messages in the tests. | Owner |
| D6 | **CI for native code.** macOS runners cost more than Linux ones; the repository has none. | A macOS job on every PR; only when `native/swift` or the contract changes; nightly. | **On PRs that touch `native/swift`, `packages/contract` or `conformance/`, and nightly.** Kotlin's client tests run on Linux in the normal job. | Owner (cost), lead |
| D7 | **How the native SDKs are produced from the OpenAPI document.** | An off-the-shelf generator for the whole client; a generator in this repository for types and constants with hand-written behaviour; all by hand. | **The repository's own generator for types, error codes and theme constants; behaviour by hand.** It is what `@tula/core` and `@tula/admin` do, the flow protocol's unions map badly through general generators, and the dangerous code (refresh, storage) should not be generated. Cost: a generator to maintain in two more target languages. | Lead |
| D8 | **Expo: wrap the native SDKs, or pure JavaScript on `@tula/core`.** | Wrapper only (business plan 5.7); JavaScript only; both, in two steps. | **Both, in two steps** (2.13 headless on `@tula/core`, 2.16 native UI through Expo Modules), and **no React Native UI kit of Tula's own** in between: that would be a fourth UI stack to keep accessible and in step. | Lead, confirmed by owner |
| D9 | **Where the webhook worker runs.** | Inside every API instance, on the timer and job lock retention uses; a separate process from the same image (`worker` service in Compose); a queue. | **Inside the API by default, with a switch to run it as a separate service from the same image.** A self-hoster with one container gets webhooks with no extra moving part; a larger deployment separates outbound traffic (and its SSRF exposure) from the instances that hold sign-in traffic. No queue: the outbox is the queue. | Lead |
| D10 | **The tunnel.** | Cloudflare Tunnel (named in the business plan), ngrok, a self-hosted option; one or pluggable. | **One, behind the `Host` interface, chosen for a stable hostname without payment if one exists.** Passkeys and association files are bound to the hostname. Which service offers that today was not checked for this plan. | Lead |
| D11 | **Hooks: HTTP or in-process.** | HTTP endpoints; TypeScript loaded into the API; both. | **HTTP only in this phase** (reasons in 2.3). | Lead, confirmed by owner |
| D12 | **What is cut if the phase must shrink.** | | In this order: 2.16 (Expo native UI), 2.7 (template editor), three of the five providers (keep Microsoft and one other), SMS as a second factor (keep the first factor), 2.6. **Not cuttable**: 2.1, 2.2, 2.8, 2.9, 2.11, and one native SDK. If only one native SDK can be built, this plan recommends Swift first: Apple's review rules constrain an iOS app that offers other social sign-in (they have required Sign in with Apple or an equivalent; check the current wording), so the iOS path has the least room for a workaround. That is a judgement, and the owner's own apps should decide it. | Owner |
| D13 | **Publishing during the phase.** | Publish alphas as soon as D1 and D2 allow; publish only at the exit. | **Alphas as soon as possible.** `npx create-tula`, Swift Package Manager and Gradle all resolve from registries or tags; until something is published every native example depends on local paths, and the quickstart is not the one a user will run. | Owner |

## Risks

- **Verification debt.** Phase 1 ended with real providers, a physical authenticator, https
  and publishing all unverified. Phase 2 adds Apple, Google, Twilio, two operating systems
  and hardware keystores. If the device pass is left to the end and then does not happen,
  the phase ships three SDKs nobody has seen work on a phone. Rule 4 and the "merged,
  unverified" state of 2.13 exist for this; the real mitigation is D3 early.
- **Three refresh implementations.** The business plan names concurrent refresh the
  highest-risk code. There will be four (TypeScript, the Expo layer's interaction with
  native, Swift, Kotlin). The named cases of 2.11 are the control; they are only as good as
  the list.
- **The scope is larger than Phase 1's.** Eighteen steps, two new languages, and several
  features that are products in themselves (webhooks, SMS). D12 is there to be used.
- **The licence blocks distribution, and distribution is how native SDKs are consumed.**
- **Platform churn.** Credential Manager, Sign in with Apple and the Expo SDK change yearly;
  the plan's version floors and API names should be re-checked at the start of each step.
- **Outbound requests are new.** Until now the server called only identity providers and
  the breach API, at fixed hosts. Webhooks and hooks call addresses operators type. One
  guard, one place, and a review that looks for any `fetch` outside it.
- **SMS costs money when it goes wrong**, and the bill arrives after the attack.
- **macOS CI cost and speed** may push Swift tests out of the per-PR loop, which is where
  the conformance guard does its work.
- **The design file was not read for this plan.**

### What on the Phase 1 unverified list gets more dangerous

Items from [phase-1-unverified.md](phase-1-unverified.md) that native clients, or this
phase's features, turn from "untested" into "load-bearing". **Must be closed** means before
the step named, not at the exit.

| Item | Why it is worse now | Close before |
| --- | --- | --- |
| Real Google and Apple sign-in never run; Apple's client-secret signing and form-post callback never exercised | 2.9 builds a second path on the same verifier and the same provider settings. A wrong assumption about a real ID token (audience, `azp`, `email_verified` as a string, the nonce's hashing) becomes an account-takeover or a total outage on mobile, where there is no fallback page. | 2.9 is called verified |
| A physical passkey authenticator never used; only ES256 from a software authenticator | Native passkeys come from platform authenticators and synced providers; an algorithm or flag the server mishandles locks users out of an app, and they cannot "try another browser". | 2.13 |
| https never run: `Secure`, `__Host-` cookies, WebAuthn off `localhost` | The tunnel makes every development run https, and every device test depends on it. | 2.12 |
| Automatic linking trusts a provider's "verified" flag indefinitely | 2.5 adds five providers whose flag is weaker, and 2.4 adds phone numbers, which are recycled far more often than addresses. | 2.5 (the per-provider table) |
| Under `mfa.policy: required`, the first factor alone enrols the second | With SMS as a first factor, whoever holds a SIM-swapped number enrols their own authenticator. | 2.4 |
| The per-identifier lockout is shared, so anyone who knows an address can lock it | A phone number is easier to know than an address, and SMS codes add a third consumer of the same budget. | 2.4 |
| Apple sign-in has no PKCE (GitHub's was added after Phase 1) | In a native app the redirect can be a custom scheme another app may claim; without PKCE the binding is the only thing between an intercepted code and a session. Custom schemes must be refused for a provider without PKCE. | 2.8 |
| The `local` tier accepts any loopback origin and redirect | A phone is not loopback; developers will be tempted to move a device-test environment out of `local`, or to widen the rule. The tunnel is the answer and must exist first. | 2.12 |
| Revoking a user's other sessions needs no recent authentication | A stolen phone with an unlocked app can sign the owner out of every other device. With device binding and long mobile sessions that is a stronger position than a browser tab's. | 2.10 (decide; may stay) |
| The MCP server was never connected to a real client | 2.17 depends on how a real client shows a tool's result to a human. | 2.17 |
| `release.yml` never run; nothing published | Every native distribution path starts with a tag or a registry. | D13 |
| A real load balancer; Redis failover; the proxy address path | The webhook worker and the proof-replay store add shared state that fails closed. A failover that Phase 1 would have survived as a brief 503 now also pauses deliveries and refreshes. | 2.18 |
| A real mail relay and link scanners | An emailed link on a phone opens through whatever the mail app does with links (an in-app browser, a scanner); "the app that asked" may not be what opens it. | 2.13 |

Unchanged in risk, still open: Next.js 15 and the Edge runtime, React 18, Safari and
Firefox, a real screen reader on the web, PgBouncer and other Postgres versions, Valkey, an
upgrade of a database with real data. They remain the owner's to schedule.

## What this plan could not determine

- What pages 3 to 5 of the design file show beyond the business plan's one-line descriptions.
- Whether the `@tula` npm scope, a Maven group and a Swift package name are available.
- Current minimum OS versions for Credential Manager and passkeys, current terms of each
  tunnel service, X's API access terms, and Twilio's current sender-registration rules. Each
  is flagged where it matters and must be checked when its step starts.
- The exact shape of a Google ID token issued through Credential Manager on Android today.
- How long the phase takes. This plan gives no estimate.
