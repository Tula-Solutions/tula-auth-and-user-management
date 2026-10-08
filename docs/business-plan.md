# Tula Auth — Product, Architecture & Business Plan

*Draft v1 · Sept 29, 2026*

## 1. The pitch

Auth that's live in under 5 minutes on web, iOS and Android, with real native UI on every platform, and that you can self-host or run on our cloud without rewriting anything.

The gap we're going after:

- **Clerk** has the best DX and prebuilt UI, but it's hosted-only, priced per user, and its native mobile components are still in beta and need a dev build plus a lot of manual native config.
- **Better Auth** is open source, you own your data, and it's cheap. But it's a library: you build the UI, host it, and wire up mobile yourself. Even passkeys on Expo currently need a community package.
- **Tula** = Clerk's polish + Better Auth's ownership + first-class native mobile + a setup so automatic that the common path has zero config.

## 2. Research: what Clerk does today

**Product surface**

- Prebuilt components: SignIn, SignUp, UserButton, UserProfile, OrganizationSwitcher, OrganizationProfile, PricingTable.
- Auth methods: email/password, email + SMS OTP, magic links, social OAuth, passkeys, MFA (TOTP, SMS, backup codes), Enterprise SSO (SAML/OIDC), biometrics on mobile.
- B2B: organizations, roles and permissions, invitations, domain-based auto-join, verified domains.
- Session management: short-lived session tokens with background refresh, multi-session, device list, revoke.
- Admin: dashboard, user impersonation, ban/unban, allow/blocklists, webhooks, JWT templates, audit/application logs.
- Billing: subscriptions layered on Stripe with prebuilt pricing and account components.
- Mobile: Expo SDK with native SwiftUI and Jetpack Compose components (`AuthView`, `UserButton`, `UserProfileView`), native Google/Apple sign-in hooks, passkeys via a separate package. Native components are documented as beta, and need a development build (not Expo Go).

**Pain points we can hit**

- Native Google/Apple/passkey setup is manual: register Team ID + bundle ID, Android SHA-256 fingerprints, Google needs iOS, Android *and* web client IDs, and passkeys silently fail on real devices without Associated Domains / App Links set up correctly.
- Native UI is limited to a theme file, so deep customization means dropping to custom flows.
- Hosted-only, so no data residency control or self-host.
- Cost scales linearly with users. Clerk's own pricing has changed several times this year, which itself is a trust issue for teams planning ahead.

**Clerk pricing (verify on clerk.com before quoting anyone; sources disagree and it's changed often)**

- Older model: free to 10K MAU, then $25/mo + $0.02 per extra MAU.
- Feb 2026: free tier raised to 50K monthly retained users (MRU) per app, unlimited apps.
- A tracker dated July 2026 lists Hobby free, Pro $100/mo ($85 annual), Business $300/mo, Enterprise custom, still $0.02 per extra retained user past 50K.
- Organizations are priced separately (roughly 100 free monthly active orgs, then per-org fees on paid plans).

**Better Auth (the other benchmark)**

- TypeScript framework, runs in your own backend and your own database, plugin system for passkeys, orgs, 2FA, SSO and more.
- Wins on cost and control; loses on prebuilt UI, hosted dashboard, and mobile-native polish. You operate it yourself.

## 3. Positioning: where we win

1. **Native-first mobile.** Real SwiftUI and Compose components, native Google/Apple/passkeys, all configured automatically. Web and mobile are equal citizens.
2. **Zero-config setup.** One command creates the project, keys, dev OAuth, redirect URIs and platform files.
3. **Deploy anywhere.** Same code as our cloud or self-hosted (Docker / single binary / bring-your-own Postgres).
4. **Cheaper and more predictable.** Flat, simple pricing, no paywall on core security features (MFA, passkeys, session mgmt).
5. **Server-driven flows.** One flow definition renders identically across web, iOS, Android, so new methods ship everywhere at once.
6. **AI-agent ready.** MCP server, `llms.txt`, and machine-readable docs so coding agents can integrate correctly on the first try. Also agent auth (OAuth for AI agents/MCP clients) as a first-class feature.
7. **Migration in a day.** Importers for Clerk, Auth0, Firebase, Supabase, Better Auth, including password hashes.

## 4. Feature set

### 4.1 MVP (launch)

- Email + password (Argon2id), email OTP, magic link
- Social: Google, Apple, GitHub, Microsoft, Discord, X, Facebook, LinkedIn (native flows on mobile for Google and Apple)
- Passkeys (web + native iOS/Android)
- TOTP MFA + backup codes; SMS OTP
- Sessions: short-lived access token + rotating refresh, multi-session, device list, remote revoke
- Prebuilt UI: SignIn, SignUp, UserButton, UserProfile (web, SwiftUI, Compose)
- Theming via shared design tokens; custom domain; email template editor
- Dashboard: users, sessions, providers, logs, API keys
- Webhooks, JWT templates, JWKS endpoint
- SDKs: React/Next.js, Expo/React Native, Swift, Kotlin, Node/Bun, Python
- CLI: `create-tula`, `tula doctor`, `tula migrate`

### 4.2 B2B (v1.1)

- Organizations, members, invitations, verified-domain auto-join
- RBAC with custom roles and permissions, `has({permission})` checks in every SDK
- OrganizationSwitcher / OrganizationProfile components (all platforms)
- Enterprise SSO: SAML + OIDC, self-serve setup portal for the customer's IT admin
- SCIM provisioning, directory sync
- Audit logs with export and long retention

### 4.3 Advanced (v1.2+)

- User impersonation with audit trail
- Bot/fraud protection (rate limits, device fingerprint, disposable-email and IP reputation, risk score)
- Step-up auth for sensitive actions
- Waitlist / invite-only signups
- Machine-to-machine tokens and API keys for end users
- OAuth provider mode (you are the IdP for third-party apps and MCP clients)
- Billing/subscriptions on Stripe with `<PricingTable/>`
- Data residency (US / EU), BYO encryption keys
- Flutter SDK, Vue, Svelte, Go

### 4.4 The "better than Clerk" list

- Auto-generated `apple-app-site-association` and `assetlinks.json`, served from your domain or ours
- `tula doctor` that tests the whole native setup (bundle ID, SHA-256, associated domains, redirect URIs) and tells you exactly what's wrong
- Shared dev OAuth credentials so social login works before you touch Google Cloud Console
- Local dev mode with a built-in mail/SMS inbox, no provider account needed
- Native components that are not locked to a theme file: slot-based overrides in SwiftUI/Compose
- Works in Expo Go for the basic path; full native via a config plugin
- Offline-tolerant sessions on mobile (secure enclave / Keystore storage, graceful refresh)

### 4.5 AI-native: the Tula MCP server

Tula ships a first-party MCP server so a coding agent can go from "add auth to my app" to working, verified auth on web, iOS and Android without a human opening the dashboard.

**Tools the agent gets**

| Group | Example tools | What it does |
|---|---|---|
| Project and keys | `create_project`, `get_keys`, `rotate_keys` | Provisions a dev project and writes env vars |
| Providers | `enable_provider`, `get_provider_status` | Turns on Google, Apple, GitHub etc. and registers redirect URIs; generates `apple-app-site-association` and `assetlinks.json` |
| Auth config | `set_password_policy`, `enable_mfa`, `set_session_lifetime`, `set_theme` | Changes settings, email templates, custom domain, design tokens |
| Orgs and RBAC | `create_role`, `define_permissions` | Sets up B2B roles and permission checks |
| Users | `search_users`, `create_user`, `ban_user` | Scoped user admin, destructive actions need confirmation |
| Scaffolding | `detect_framework`, `scaffold_auth`, `add_protected_route`, `generate_native_screen` | Writes the actual code for Next, Expo, SwiftUI, Compose |
| Verification | `run_doctor`, `test_signin`, `check_native_config` | Runs a synthetic sign-in and checks bundle IDs, SHA-256, associated domains |
| Migration | `plan_migration`, `import_users` | Imports from Clerk, Auth0, Firebase, Supabase, Better Auth |
| Docs and debug | `search_docs`, `get_snippet`, `explain_auth_error`, `get_logs` | Version-pinned snippets and plain-language error diagnosis |

**Design principles**

1. **Config as code.** Everything the agent changes lands in a `tula.config.ts` file, and `tula apply` syncs it to the project. AI changes show up as a normal diff in a PR instead of hidden dashboard state.
2. **One API, three surfaces.** Every dashboard action is an API call first. The dashboard, CLI and MCP tools are generated from the same OpenAPI spec, so they never drift.
3. **Self-verifying loop.** After each change the agent calls `run_doctor` and gets machine-readable failures with fix hints (for example, "Android SHA-256 missing for package com.app"), so it can fix its own mistakes.
4. **Safe by default.** The MCP token is scoped to the dev environment. Production changes are returned as a plan and diff that a human must approve. Destructive actions need explicit confirmation, all agent actions are tagged in the audit log (`actor: agent:<client>`), and user data returned to the agent is redacted and marked as untrusted content to blunt prompt injection.
5. **Agent-readable docs.** `llms.txt`, per-framework rules files (`AGENTS.md`, `CLAUDE.md`, Cursor rules) generated by `create-tula`, and versioned snippets so agents stop hallucinating old APIs.
6. **Local and remote.** A local stdio server (`npx tula mcp`) for scaffolding code in the repo, and a hosted remote server (OAuth) for cloud config. Both work against self-hosted instances.

**What the flow looks like**

Prompt: "Add Google and Apple sign-in and organizations to my Expo app."

1. Agent calls `detect_framework`, sees Expo, and runs `scaffold_auth`.
2. It calls `enable_provider` for Google and Apple, and Tula registers redirect URIs and generates the domain association files.
3. It writes the native `AuthView`, org switcher and protected routes.
4. It calls `run_doctor`, fixes anything flagged, then `test_signin` to confirm a full round trip.
5. It opens a PR with code plus the `tula.config.ts` diff. Production rollout waits for human approval.

**Auth for your users' agents.** The same OAuth provider mode from 4.3 lets apps built on Tula protect their own MCP servers and AI agents: dynamic client registration, consent screens, scoped and revocable agent tokens, and per-agent audit trails. This is the second half of "AI-native" and few competitors cover it well.

**Business angle.** The MCP server is free on every plan since it drives adoption. Paid extras: team approval workflows for production changes, longer agent audit retention, and SSO-gated MCP access for enterprises.

**Build order.** Config-as-code and the OpenAPI spec come first (they're needed anyway), then a read/scaffold MCP in Phase 1, and write access with approvals and `test_signin` in Phase 2 alongside the native SDKs.

### 4.6 Customization, theming and white-labeling

Theming is free on every plan. Only removing Tula's branding is a paid feature. Every component looks like part of the customer's app on web, iOS and Android, from one shared theme.

**Customization layers (go as deep as you need)**

| Layer | What you change | How |
|---|---|---|
| 1. Theme tokens | Colors, dark mode, fonts, radius, spacing, shadows, density | One JSON/TS theme file shared by web, SwiftUI and Compose, or the dashboard theme editor |
| 2. Component appearance | Per-component styles and variants (button shapes, card vs full-screen, icon-only social buttons) | `appearance` prop and CSS variables on web, theme objects on SwiftUI and Compose |
| 3. Slots and layout | Replace or reorder parts (header, footer, social buttons, fields), add custom signup fields | Slot props on every component |
| 4. Copy and locale | Every string, plus translations and RTL | Override file, 30+ languages built in |
| 5. Templates | Email and SMS content, per locale | Visual editor or React Email/MJML, with variables |
| 6. Headless | Fully custom UI on top of the flow engine | Hooks and headless client, all logic still handled by Tula |

**Theme file**

```ts
// tula.config.ts
theme: {
  brand: { primary: "#6D5DFB", logo: "./logo.svg" },
  mode: "system",                    // light | dark | system
  tokens: {
    radius: "12px",
    font: { body: "Inter", heading: "Inter" },
    density: "comfortable",
  },
  dark: { background: "#0B0B10", surface: "#15151C" },
  components: {
    signIn: { layout: "card", socialButtons: "icons-only" },
    userProfile: { layout: "sidebar" },
  },
  inheritHostTheme: false,           // true = adopt the app's own MaterialTheme / SwiftUI tint
}
```

**Things that make it better than a color picker**

- **One brand color in, full theme out.** Give a color or a logo and Tula generates a full palette for light and dark, checks WCAG contrast, and fixes failing pairs.
- **Live preview on all three platforms.** The dashboard theme editor renders web, iOS and Android side by side, and updates connected dev builds in real time.
- **Inherit host theme.** Native components can pick up the app's existing SwiftUI/Compose theme and fonts instead of a separate one.
- **Per-org branding.** In B2B apps each customer org can have its own logo and colors on its sign-in page (for example `acme.yourapp.com`).
- **Agent-friendly.** The MCP `set_theme` tool takes a brand description or logo and writes the theme file, so an agent can brand the whole flow in one step.
- **Design system export.** Export tokens to CSS variables, Tailwind config, Swift and Kotlin constants so the rest of the app matches.

**White-labeling by plan**

| Capability | Free | Pro | Business | Enterprise |
|---|---|---|---|---|
| Full theming (colors, fonts, dark mode, slots, copy) | Yes | Yes | Yes | Yes |
| Remove "Secured by Tula" badge | No | Yes | Yes | Yes |
| Custom domain for hosted pages and API (`auth.yourapp.com`) | No | Yes | Yes | Yes |
| Custom email sender domain (DKIM/SPF) and SMS sender ID | No | Yes | Yes | Yes |
| Fully branded emails, errors and consent screens (no Tula mentions) | No | Yes | Yes | Yes |
| App name in passkey and OAuth prompts | Yes | Yes | Yes | Yes |
| Per-org branding on sign-in pages | No | No | Yes | Yes |
| Branded end-user account portal and custom legal links | No | No | Yes | Yes |
| Branded SSO setup portal for your customers' IT admins | No | No | Yes | Yes |
| White-label dashboard for resellers and agencies | No | No | No | Yes |

**How it's enforced.** Branding on server-rendered surfaces (hosted pages, emails, consent screens, the SSO portal) is controlled by a signed entitlement on the project, so it can't be toggled from the client. The in-app badge on the React and native components is a small, non-intrusive element that turns off when the project has a paid entitlement.

**Open question for self-hosters.** With open-source code, a badge in the client can always be forked out. Options are: allow removal for self-hosters for free (simplest, builds goodwill), or require a license key for white-label features (protects revenue). Worth deciding alongside the license choice in section 10.

**Build order.** Web tokens, `appearance` prop and dashboard editor in Phase 1. Native SwiftUI/Compose theming with the shared token file in Phase 2. Per-org branding, white-label entitlements and the reseller dashboard in Phase 3 and 4.

### 4.7 Credential and input policies (password rules, validation)

Every rule for what users can enter is configurable per project, and the same rules run on the server and in the UI, so web, iOS and Android can never disagree about what's valid.

**Password policy**

```ts
// tula.config.ts
passwordPolicy: {
  preset: "recommended",         // recommended | strict | legacy | custom
  minLength: 10,
  maxLength: 128,
  requireLowercase: true,
  requireUppercase: true,
  requireNumber: true,
  requireSpecial: true,
  minCharacterClasses: 3,        // alternative to requiring each class
  specialChars: "!@#$%^&*()-_=+[]{};:,.?",
  disallowUserInfo: true,        // email, name, username inside the password
  disallowCommon: true,          // top common-password list
  breachCheck: "block",          // off | warn | block (k-anonymity, password never leaves as plain text)
  maxRepeatedChars: 3,           // aaaa
  blockSequences: true,          // abcd, 1234
  history: 5,                    // can't reuse the last 5
  expiryDays: null,              // null = never expire
  minStrengthScore: 3,           // 0-4 zxcvbn-style score
  onPolicyTightened: "force-reset-on-next-login", // or "warn" | "allow"
}
```

**Presets**

| Preset | Rules | Best for |
|---|---|---|
| Recommended (default) | 10+ characters, breach check, common-password block, no forced composition | Most apps, follows NIST 800-63B guidance |
| Strict | 12+ characters, all character classes, history, strength score 3+ | Fintech, health, admin users |
| Legacy / compliance | Classic composition rules (upper, lower, number, special), optional expiry | Customers whose auditors require it |
| Custom | Anything above, mixed | Everything else |

The design note here: composition rules and forced expiry are fully supported because customers demand them, but the default steers toward length plus breach checking, since current NIST guidance discourages forced composition and rotation.

**How it's enforced**

- **Server is the source of truth.** Checked on sign-up, password change and reset. Nothing can bypass it through the API.
- **Live checklist in the components.** The SDK fetches the active policy and shows requirements ticking off as the user types, with a strength meter. Native SwiftUI and Compose components render the same checklist from the same policy.
- **Machine-readable errors.** Failures return codes like `password.too_short` and `password.breached` with parameters, translated into the user's language.
- **Long passphrases work.** Allows spaces and Unicode, up to 128+ characters, with safe pre-hashing before Argon2id.
- **Login errors stay generic** to avoid account enumeration. Detailed messages only appear when setting a password.
- **Existing users.** When you tighten a policy, choose what happens: force a reset on next login, warn, or grandfather them.

**Other configurable validators**

| Field | Options |
|---|---|
| Email | Require verification, block disposable domains, allow/blocklist domains, MX check, normalize plus-addressing and case |
| Username | Min/max length, allowed characters, reserved words, profanity filter, case sensitivity |
| Phone | E.164 format, allowed countries, block VoIP numbers |
| Names and profile fields | Required or optional, max length, allowed characters |
| Custom signup fields | Any extra field with type, required flag and schema validation (Zod or JSON Schema) |
| Custom validator hook | An async function that can accept or reject any signup or profile change with your own message |

**Scope and tooling.** Policies resolve project, then org (an enterprise customer can require stricter passwords for their own members), then role (admins can be held to Strict). They're editable in the dashboard, in `tula.config.ts`, by API and through the MCP `set_password_policy` tool. The dashboard includes a policy tester, and the CLI has `tula policy test` to check a sample password or email against the active rules and see which ones fail.

**Build order.** Password policy, presets, breach check and live checklist in Phase 1. Org and role overrides, history and expiry, and the custom validator hook in Phase 2 and 3.

## 5. Architecture

### 5.1 High level

```
Clients (Web / iOS / Android / RN)
   |  headless core client + platform UI renderers
   v
Edge layer (Cloudflare): WAF, rate limit, JWKS cache, token verify
   v
Auth API (Bun + Hono, hexagonal)
   |-- Flow engine (server-driven sign-in/up state machine)
   |-- Credentials: password, OTP, magic link, passkey, TOTP
   |-- Federation: OAuth/OIDC + SAML adapters
   |-- Session service: access + refresh tokens, revocation
   |-- Org/RBAC service
   |-- Risk engine
   |-- Event outbox -> webhooks, audit log, analytics
   v
Postgres (RLS multi-tenant)   Redis (rate limit, short-lived state)   Object store (avatars, exports)
   ^
Notification adapters: email (Resend/SES/SMTP), SMS (Twilio/Vonage), push

Control plane (cloud only): dashboard, project mgmt, billing, provisioning
```

### 5.2 Key design decisions

**Hexagonal core.** Domain logic has no knowledge of HTTP, DB, or vendors. Ports for storage, email, SMS, OAuth providers, and key management. This is what lets one codebase run as multi-tenant cloud, single-tenant self-host, or embedded in your own Hono app.

**Data plane vs control plane.** The data plane (auth API and per-project data) can run anywhere. The control plane (dashboard, billing, provisioning) is cloud-only. Self-hosters get a simpler local admin UI.

**Server-driven flows.** The API never says "show the password form." It returns `{ status: "needs_second_factor", options: ["totp","passkey"] }`. Each platform renderer maps steps to native screens. Add a new method once on the server and every client supports it after an SDK update; no flow logic is duplicated per platform.

**Sessions.**

- Access token: JWT, ~60 seconds, signed with rotating asymmetric keys (EdDSA), public keys via JWKS.
- Refresh token: opaque, rotating, single-use with reuse detection (reuse revokes the whole token family).
- Web: httpOnly, SameSite cookies. Mobile: Keychain (Secure Enclave-backed) and Android Keystore.
- Verification at the edge with no DB call; instant revoke via a short denylist plus the 60s expiry.

**Multi-tenancy.** Every row carries `project_id`; Postgres row-level security enforces it. Optional per-project envelope encryption keys. Enterprise tier can get a dedicated database.

**Native SDK strategy.**

- Core is a headless TypeScript client for web/RN, plus thin Swift and Kotlin clients generated from one OpenAPI/flow spec so behavior stays identical.
- UI: React components for web; SwiftUI and Jetpack Compose libraries for native; React Native wrapper exposes the native components via Expo Modules.
- Design tokens (colors, radius, type, spacing) live in one JSON file consumed by all renderers.

**Extensibility.** Plugin hooks on the server (before/after sign-in, custom claims, custom providers) written in TypeScript, plus webhooks for everything else.

### 5.3 Session engine: multiple types, everything configurable

Sessions are not one fixed design. Tula ships several session types and lets each project define named **session profiles** (web, mobile, admin, kiosk, API) that pick a type and tune every knob. The 5.2 defaults are just the starting profile.

**Session types**

| Type | How it works | Best for | Tradeoff |
|---|---|---|---|
| Hybrid (default) | Short-lived JWT access token + rotating refresh token backed by a store | Most web and mobile apps | Revoke takes effect within the access TTL, or instantly with the denylist |
| Stateful (opaque) | Random session ID in an httpOnly cookie, looked up server-side every request | Admin panels, banking-style apps needing instant revoke | A store lookup per request |
| Stateless JWT | Signed token only, no server state | Edge/serverless, read-heavy APIs | Cannot be revoked before expiry |
| Long-lived mobile | Device-bound refresh token with a sliding inactivity window | Native iOS/Android apps | Needs secure on-device storage |
| Kiosk / shared device | Short idle timeout, nothing persisted | Shared tablets, public terminals | Users sign in often |
| API key / M2M | Long-lived or scoped machine tokens | Server-to-server, end-user API keys | Rotation is on the customer |
| Delegated / agent | Short-lived, narrowly scoped, on behalf of a user | AI agents, MCP clients | Extra consent step |
| Impersonation | Support-staff session as a user, fully audited, time-boxed | Customer support | Restricted actions, visible banner |

**Example: "sign in once, stay signed in, log out after 30 days idle"**

That is just a mobile profile:

```ts
// tula.config.ts
sessions: {
  defaultProfile: "web",
  profiles: {
    web: {
      type: "hybrid",
      access: { format: "jwt", ttl: "60s" },
      refresh: { rotate: true, reuseDetection: true },
      idleTimeout: "7d",
      absoluteTimeout: "30d",
      cookie: { sameSite: "lax", domain: ".myapp.com" },
      multiSession: true,
      maxConcurrent: 5,
    },
    mobile: {
      type: "long-lived",
      access: { format: "jwt", ttl: "5m" },
      refresh: { rotate: true, sliding: true },
      idleTimeout: "30d",        // logged out after 30 days of inactivity
      absoluteTimeout: null,      // otherwise stays signed in
      deviceBinding: "required",
      storage: "secure-enclave",  // Keychain / Keystore
      biometricUnlock: true,
      offlineGrace: "24h",
    },
    admin: {
      type: "stateful",
      idleTimeout: "15m",
      absoluteTimeout: "8h",
      mfa: "required",
      stepUpFor: ["delete_user", "change_billing"],
    },
  },
  rules: [
    { when: { client: "ios" | "android" }, use: "mobile" },
    { when: { role: "admin" }, use: "admin" },
  ],
  store: { primary: "postgres", cache: "redis" },
  onLimitExceeded: "revoke-oldest",
}
```

**What's configurable**

| Setting | What it controls |
|---|---|
| Type | Hybrid, stateful, stateless, long-lived, kiosk, and so on |
| Access token | Format (JWT or opaque), TTL, signing algorithm, custom claims, audience |
| Refresh token | TTL, rotation, reuse detection, sliding vs fixed |
| Idle timeout | Sign out after N days of no activity |
| Absolute timeout | Hard cap on session age, regardless of activity |
| Concurrency | Max sessions per user, per device, per org; what to do at the limit (block, revoke oldest, ask) |
| Multi-session | Several accounts signed in at once on one device |
| Device binding | None, soft (fingerprint), or hard (device-held key, DPoP) |
| Client storage | httpOnly cookie, Keychain/Keystore, memory only |
| Re-auth and step-up | Force MFA or password for sensitive actions, with a freshness window |
| Risk rules | Revoke or step up on new country, impossible travel, high risk score |
| Revocation triggers | Password change, MFA reset, role change, org policy change, ban |
| Offline grace | How long a mobile app works offline before needing to refresh |
| Events and hooks | `session.created`, `refreshed`, `expired`, `revoked`, plus a hook to add custom claims |

**Scope of configuration.** Settings resolve from most to least specific: user, then org (for example an enterprise customer forcing 12-hour sessions), then profile, then project default. Everything is editable in the dashboard, in `tula.config.ts`, via the API, and through the MCP server.

**Session stores (pluggable)**

| Store | Use it when | Notes |
|---|---|---|
| Postgres (default) | You want simple and durable | Source of truth for sessions and refresh families |
| Redis | High volume, fast revoke and rate limits | Cache in front of Postgres, or primary for stateful sessions |
| Edge KV / Durable Objects | Edge-first apps | Denylist and session lookups close to the user |
| In-memory | Local dev and tests | Lost on restart |
| None (stateless) | Serverless, no infra | Only valid for the stateless JWT type |
| Custom adapter | You have your own store | Implement a small `SessionStore` interface |

**How inactivity is measured.** Stateless access tokens don't touch the server, so "last active" is updated when the client refreshes (plus an optional lightweight heartbeat). That means idle timeout precision equals the access token TTL. For example, a 5-minute access token gives roughly 5-minute accuracy on a 30-day idle window, which is fine. Stateful profiles check activity on every request for exact timing.

**Revocation.** Revoke one session, one device, all devices, or everything matching a rule. Reuse of a rotated refresh token kills the whole token family. Hybrid sessions revoke instantly through a short-lived denylist checked at the edge, and otherwise within the access TTL.

**Safe defaults.** Out of the box the web profile is hybrid with 60-second tokens, and mobile is long-lived with device binding and a 30-day idle timeout. A new project works without touching any of this; the settings exist for when you need them.

**Build order.** Hybrid sessions with rotation and Postgres store in Phase 0. Profiles, rules, idle and absolute timeouts, and the Redis adapter in Phase 1. Device binding, org-level overrides, risk rules and custom store adapters in Phase 2 with the native SDKs.

### 5.4 Data model (core tables)

`projects`, `users`, `identities` (one per provider/credential), `credentials` (password hash, passkey public keys, TOTP secrets encrypted), `sessions`, `refresh_tokens`, `devices`, `organizations`, `memberships`, `roles`, `permissions`, `invitations`, `sso_connections`, `api_keys`, `webhook_endpoints`, `events` (outbox), `audit_logs`, `verification_tokens`.

### 5.5 Security baseline

- Argon2id, breached-password check (k-anonymity), constant-time comparisons
- PKCE everywhere, strict redirect URI matching, state/nonce validation
- Refresh token rotation with reuse detection
- Rate limiting and lockout per IP, account and device
- CSRF protection, secure cookie defaults
- Secrets and TOTP seeds encrypted at rest
- Full audit trail for admin and sensitive actions
- Compliance path: SOC 2 Type 2 first (needed to sell to B2B), then GDPR tooling, then HIPAA BAA on enterprise

### 5.6 Deployment modes

1. **Cloud** (multi-tenant, managed)
2. **Self-host** (Docker Compose / Helm chart / single binary, BYO Postgres)
3. **Embedded** (mount the Hono app inside your own backend)

### 5.7 Implementation language and SDK architecture

**Decision:** the server is Bun + Hono in TypeScript, built contract-first. Rust is kept as a later option for a shared client core, not the starting point.

**Why not Rust for the server now**

- Server language isn't the bottleneck. Postgres writes, Argon2 hashing (native code in either language) and email/SMS providers dominate cost and latency.
- Time to market matters most. Auth has a huge surface (providers, sessions, orgs, SDKs, dashboard, docs), and Rust would slow every part of it.
- TypeScript is the audience's language, so hooks, validators and config (4.7, 5.3, `tula.config.ts`) stay natural.
- The TypeScript ecosystem is stronger for SAML and OAuth/OIDC provider mode, which enterprise SSO and agent auth depend on.
- The choice is reversible because the contract is language-agnostic (below).

**The contract is the product.** Everything below is versioned and language-neutral, so any server or SDK implementation can be swapped without breaking customers.

| Artifact | Purpose |
|---|---|
| OpenAPI spec | Source for generated TypeScript, Swift and Kotlin clients, the dashboard, the CLI and MCP tools |
| Flow protocol | Server-driven next steps (`needs_second_factor`, `verify_email` and so on), so clients hold almost no auth logic |
| Token and JWKS format | Claims, key rotation and verification rules any language can implement |
| Error codes | Stable machine-readable codes (`password.too_short`) with localized messages |
| Design tokens file | One JSON theme that generates CSS, Swift and Kotlin constants |
| Conformance test suite | Language-neutral JSON scenarios run against a mock server; every SDK must pass it |

**Package layout**

| Package | Contents | Hand-written? |
|---|---|---|
| `@tula/core` | Headless TypeScript client for web, Node and React Native | Yes |
| `@tula/react`, `@tula/nextjs` | Components, hooks, middleware | Yes |
| `TulaAuth` (Swift) and `TulaAuthUI` | Client plus SwiftUI components, native Apple sign-in, passkeys, Keychain | Yes |
| `tula-android` and Compose module | Client plus Compose components, Credential Manager, Keystore | Yes |
| `@tula/expo` | Wraps the native SwiftUI/Compose components through Expo Modules and reuses `@tula/core` hooks | Thin wrapper |
| API clients and token constants | Generated from the OpenAPI spec and tokens file | No, generated |

What's shared versus native:

- **Shared or generated:** API clients, flow logic (lives on the server), password policy (served to clients), design tokens, error codes.
- **Written per platform:** UI components, native sign-in and passkey integrations, secure storage, and a small session/refresh module.
- **Highest-risk code:** concurrent token refresh (several requests hitting an expired token at once). Write it carefully in each language and cover it heavily in the conformance suite.

**SDK order:** TypeScript SDKs first (core, React, Next.js), then native Swift and Kotlin, then the Expo wrapper around the native components. Hosted pages remain a fallback for platforms without an SDK.

**When to bring Rust in**

The first Rust use would be a shared client core (token refresh, session rules, password policy) compiled to WASM for web and edge and to Swift/Kotlin through UniFFI. It replaces the small per-language session modules so that logic exists once. Trigger: the first two native SDKs work and keeping the modules in sync is a real cost.

A Rust server would be considered only if most of these become true:

- Profiling shows server compute is a top-three cost line.
- A tiny single-binary self-host story becomes a selling point.
- The team includes strong Rust engineers.
- Paying customers fund the rewrite.

Until then, benchmark the refresh and verify path against real traffic before deciding anything.

### 5.8 Version 1 scope: local-first, hosting deferred to V2

**Decision:** V1 runs entirely on the developer's own machine or their own server from one Docker Compose file. There is no Tula cloud and no control plane in V1. The hosted stack (Neon + Railway + Cloudflare vs AWS) is decided in V2. Early cost research suggests infrastructure is a small cost line at first, so it doesn't need to drive V1.

**V1 local stack**

| Component | Local V1 setup |
|---|---|
| Auth API | Bun + Hono |
| Database | Postgres in Docker |
| Cache and rate limits | Redis in Docker (a no-dependency mode can fall back to Postgres or memory) |
| Email | Mailpit local inbox in dev, any SMTP server for real sending |
| SMS | Logged to console in dev, optional Twilio adapter |
| Dashboard | Local admin UI served by the API on localhost |
| Config | `tula.config.ts` applied with `tula apply` |
| MCP | Local stdio server (`npx tula mcp`) |
| Files | Local disk, with an S3-compatible adapter later |
| Keys | Generated locally, public keys served over JWKS |

One command starts it all: `npx create-tula`, then `tula dev`. An optional lite mode with embedded Postgres would remove the Docker requirement for quick trials.

**In V1 versus deferred to V2**

| In V1 | Deferred to V2 |
|---|---|
| Email/password, OTP, magic link, social, passkeys, MFA | Managed cloud and multi-tenant hosting |
| Session engine and password policies (5.3, 4.7) | Control plane, billing, per-MRU pricing and paid tiers |
| Theming and components for web, Expo, Swift, Kotlin (4.6) | White-label entitlements (they need a signed entitlement from the cloud) |
| Orgs and RBAC | Hosted pages and custom domains managed by us |
| Local MCP server and config-as-code (4.5) | Remote OAuth-protected MCP server |
| Migration importers, self-host guide | Shared dev OAuth credentials, SOC 2, data residency, reseller dashboard |

**Local limitations to design around**

1. **No shared dev OAuth credentials.** Social login needs the developer's own Google, Apple and GitHub credentials. `tula doctor` should give copy-paste redirect URIs and step-by-step checks for each provider.
2. **Passkeys and native Apple/Google sign-in need HTTPS on a real domain.** Web passkeys work on localhost, but testing on physical iOS and Android devices does not. `tula dev --tunnel` should open a Cloudflare Tunnel or similar and auto-generate the `apple-app-site-association` and `assetlinks.json` files for it.
3. **Devices can't reach `localhost`.** Simulators can. Physical phones need the LAN address or the tunnel.
4. **No revenue from V1.** V1 is free and open source, and it's the adoption and dogfooding phase. The pricing and white-label plans in section 7 and 4.6 take effect in V2 with the cloud.

**Build order.** Everything in the roadmap through Phase 3 fits this scope. Phase 4 and 5 items that need the cloud (billing, remote MCP, data residency) move to V2.

## 6. Developer experience (the "just works" flow)

```
npx create-tula@latest
```

1. Detects framework (Next, Expo, Swift, Kotlin), installs the SDK
2. Creates a dev project and writes env keys
3. Adds provider, middleware and a working sign-in page
4. Turns on Google/Apple with shared dev credentials
5. `tula doctor` verifies everything, including the native config

Production: `tula deploy` walks through custom domain, real OAuth credentials, and email/SMS providers with guided steps and live validation.

## 7. Business model

### 7.1 Strategy: open core + managed cloud

- **Open core** (permissive or source-available license, decide below): everything a solo dev or small startup needs, self-hostable.
- **Cloud:** we run it, you pay usage-based.
- **Enterprise repo** (private): SSO/SAML, SCIM, advanced audit, compliance features, dedicated infra.

### 7.2 Proposed pricing (illustrative, tune after cost modeling)

| Plan | Price | Included | Notes |
|---|---|---|---|
| Self-host | Free | Core features, unlimited users | Community support |
| Cloud Free | $0 | 25K MRU, unlimited apps, all core auth incl. MFA + passkeys | Tula branding on hosted pages |
| Pro | $25/mo | 50K MRU, custom domain, no branding, webhooks, 30-day logs | $0.01 per extra MRU |
| Business | $150/mo | Orgs + RBAC, 100K MRU, impersonation, 1-yr logs, priority support | Volume tiers past 100K |
| Enterprise | Custom | SSO/SCIM, SLA, SOC 2 report, data residency, dedicated DB | Annual contract |

Add-ons and usage:

- Enterprise SSO connections: per connection per month (this is where B2B pays; competitors charge around $100+ each, so price against that)
- SMS: pass-through cost plus markup
- Bot/fraud protection: usage-based
- Billing layer: small percentage on top of Stripe fees, or flat add-on
- Migration service and premium onboarding: paid one-time

**Pricing principles:** count *retained* users (MRU) like Clerk, never gate core security behind higher plans, and publish a calculator so there are no surprises.

### 7.3 Why the economics work

The marginal cost per active user is tiny (a few token refreshes and DB reads). Main variable costs are email/SMS, support, and compliance. Margins come from Pro/Business subscriptions plus SSO and SMS, with self-host acting as top-of-funnel and trust builder.

### 7.4 Go-to-market

1. Dogfood on your own apps first so the DX is proven on real projects.
2. Ship the migration tools and "Clerk/Better Auth alternative" landing pages early. People search this exact thing.
3. Open-source the core, publish honest comparison benchmarks, and lean on the pricing story.
4. Target Expo/React Native and indie/AI-app builders first (underserved on native), then B2B SaaS.
5. Starter templates and agent-friendly docs so AI coding tools recommend and correctly integrate Tula.

## 8. Roadmap

| Phase | Timeline | Deliverables |
|---|---|---|
| 0 | Weeks 1-4 | Core API, hexagonal skeleton, email/password, sessions, Postgres schema, JWKS |
| 1 | Weeks 5-10 | Social (Google, Apple, GitHub), passkeys, MFA, React components, Next SDK, dashboard v1, CLI |
| 2 | Weeks 11-18 | Expo SDK + native SwiftUI/Compose components, native Google/Apple, `tula doctor`, webhooks |
| 3 | Weeks 19-26 | Orgs + RBAC, invitations, migration tools, public beta, docs and templates |
| 4 | Months 7-9 | SAML/OIDC SSO, SCIM, audit logs, billing, start SOC 2 |
| 5 | Months 10+ | Fraud engine, OAuth provider mode, Flutter/Vue/Svelte, data residency |

## 9. Risks and how to handle them

- **Trust and liability.** Auth is a breach-magnet. Mitigate with third-party pen tests, bug bounty, minimal data retention, and early SOC 2.
- **Email/SMS deliverability.** Use reputable providers with fallbacks, warm sending domains, and monitoring.
- **Native maintenance load.** Three UI stacks is a lot. The server-driven flow engine and shared design tokens keep the per-platform code thin.
- **Incumbents cutting price.** Clerk already dropped and reshuffled pricing this year. Compete on native, ownership and DX, not only price.
- **Small team, big surface.** Ruthlessly scope MVP; SSO and fraud can wait for demand.
- **OAuth provider quirks** (Apple especially). Budget ongoing time for provider maintenance.

## 10. Open decisions

1. **License:** resolved, October 2026: Apache-2.0 for the whole repository (max adoption; the server can be embedded in an app without licence friction). The alternative was AGPL/ELv2, which protects against cloud resellers.
2. **Free tier size:** 25K vs 50K MRU to match Clerk headline.
3. **Native first target:** resolved in 5.7: TypeScript SDKs first, then native Swift and Kotlin, with the Expo wrapper reusing the native components.
4. **Hosting stack for cloud:** resolved for V1 in 5.8: everything runs locally. The hosted stack (Neon + Railway + Cloudflare vs AWS) gets decided in V2.
5. **Name and brand** for the product vs Tula Solutions.
6. **Reuse vs build:** build SAML/OIDC/passkey engines in-house or wrap proven libraries (recommended: wrap, then replace where it matters).

## Visual references

- **Platform flows (design canvas):** [Tula Auth: Platform Flows](https://claude.ai/artifact/PSCf6qocLqVkFRw4voQnGq). Six high-fidelity screens: the sign-in flow across web, iOS and Android; web sign-up with live password rules; iOS SwiftUI sign-in; Android Compose sign-in with the native account chooser; iOS account screen with devices and the 30-day idle rule; and the dashboard with workspace, project, environment, sign-in methods, session profiles and theme. The brand shown ("Northline") and its colors are placeholders.
- **Full architecture (Excalidraw):** drawn in the chat as layers: clients, SDKs and tooling, the shared contract (OpenAPI, flow protocol, JWT/JWKS, error codes, design tokens, conformance tests), the Bun + Hono server modules, swappable adapters (Postgres, Redis, session stores, email/SMS, files, identity providers), and the workspace, project, environment, end-user account model. It matches sections 5.1, 5.3, 5.7 and 5.8. Save or export it from the Excalidraw view in the chat and attach it here if you want a copy to keep.

The workspace and project account model is described in the conversation but has not been written into a section of this doc yet.

## Sources

Clerk pricing pages and trackers (Feb–Jul 2026), Clerk Expo documentation and articles on native components, native OAuth and passkeys, Expo's Clerk guide, WorkOS's Clerk pricing comparison, Better Auth comparisons, and the `expo-better-auth-passkey` community package.
