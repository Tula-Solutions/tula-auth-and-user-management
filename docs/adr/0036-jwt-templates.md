# ADR 0036: JWT templates and custom claims

- **Status:** accepted
- **Date:** 2026-10-08
- **Ticket:** TULA-10 (phase 2)

## Context

An application's backend wants to decide from the access token alone: which address this is,
whether it is verified, which kind of deployment the session belongs to. Until now the token
held only what Tula needs itself (`iss`, `sub`, `aud`, `exp`, `iat`, `sid`, `pid`, `eid`, `v`,
`auth_time`, `amr`, `sp`), and [ADR 0028](0028-session-profiles.md) deferred custom claims.

The danger of the feature is its flexibility. A claim an operator can name freely can shadow
one a verifier relies on; a claim whose value a user controls is a signed statement the user
wrote; a claim set that can grow makes a token that no longer fits in a cookie. This ADR
decides the smallest thing that is useful and closes each of those.

Hooks that add claims, organizations and roles are other tickets. What is decided here is
what they will have to fit into.

## Decision

### Where a template lives

In the environment's settings document ([ADR 0018](0018-environment-settings.md)), under
`sessions`:

- `sessions.jwtTemplates`: a record of templates by name (the profile-name grammar), at most
  `MAX_JWT_TEMPLATES` (10). Default `{}`.
- `sessions.profiles.<name>.jwtTemplate`: the name of the template that profile's sessions
  use, or `null` (default).

Both are additive fields with defaults, in the strict input schema and in the lenient stored
one. No table, no migration, no new route, no new error code. A template is therefore
versioned, audited, cached, diffed and applied by everything that already handles settings,
and is replaced under `If-Match` like the rest.

A template belongs to a **profile** and not to the environment because the profile is already
"what kind of session this is": a staff tool's `back-office` profile and the public `web`
profile want different claims, and a profile is chosen only in `Sessions.create`.

**Consistency is checked at save**, by the schema (`SessionSettingsSchema`'s `superRefine`):
a profile that names a template the same document does not define is refused, on
`sessions.profiles.<name>.jwtTemplate`. That one rule is also "a template in use cannot be
removed": the document that removes it still names it. Unset the profile in the same save, or
first.

### What a claim is

`{ claims: { <key>: { from: <source> } | { value: <constant> } } }`. A claim has exactly one
source, and the two forms are strict objects in a union, so `{ from, value }` is refused.

Sources are a **closed list** in the contract (`JWT_TEMPLATE_SOURCES`):

| Source | Why it is safe to sign |
| --- | --- |
| `user.email` | The address in the normalised form the server matches by. The one user-chosen string, and one the user had to prove to make it `email_verified`. Printable ASCII, at most 320 characters. |
| `user.email_verified` | A boolean the server decides. About the address: for a user who has none (a first sign-in with X or Facebook, [ADR 0026](0026-oauth.md)) it has no value, like `user.email`, and not `false`. |
| `user.created_at` | A time the server set. Seconds since the epoch. |
| `session.client` | The client kind, one of four fixed names, fixed when the session began. |
| `session.created_at` | A time the server set. Seconds since the epoch. Unlike `auth_time`, a step-up does not move it. |
| a constant | What the operator typed: a string (at most 256 characters, no control characters or line separators), a number or a boolean. |

Left out on purpose:

- **The user id.** It is `sub`.
- **First and last name.** Text the user chose, which nothing checks. In a signed token it
  reads as a fact, and a backend that prints it has an injection to think about.
- **The session's IP address and user agent.** What a request claimed about itself when the
  session began: personal data, not something the server knows, and stale one request later.
- **Anything a request says now.** No header, body or query value ever reaches a claim.
- **Secrets.** Nothing sealed or hashed is a source.
- **Expressions.** No concatenation, conditionals, nesting or lookups. Each of those is a
  small language whose evaluation would run on the token path for every request.

### One namespace claim: `ext`

Every custom claim is inside the one top-level claim `ext` (`CUSTOM_CLAIMS_CLAIM` in the new
Zod-free entry point `@tula/contract/custom-claims`).

- Nothing a template says is at the top level, so a template cannot shadow a claim a verifier
  reads, whatever key it uses and whatever claims later versions add.
- `ext` is not in the IANA "JSON Web Token Claims" registry, and is what Ory's tokens use for
  the same purpose, so it is recognisable. It is three bytes on every token that has one.
- A namespaced URI key (`https://…/claims`) was considered. It costs 30 or more bytes on a
  token that is read on every request and gains nothing a fixed short name does not.

### Reserved names and the key grammar

`RESERVED_CLAIM_NAMES`: `iss`, `sub`, `aud`, `exp`, `nbf`, `iat`, `jti`, `sid`, `pid`, `eid`,
`v`, `auth_time`, `amr`, `sp`, `cnf`, `ext`. They are refused as keys **inside** `ext` too.
Inside the namespace they could not shadow anything by themselves; but code that flattens
`{ ...claims, ...claims.ext }` exists in the world, and a reserved name inside `ext` would
then be an escalation written by an operator's typo. `cnf` is reserved for proof-of-possession
(device-bound tokens), `nbf` and `jti` because they are registered and Tula may issue them.

A test (`apps/api/src/modules/session/custom-claims.test.ts`) signs a real access token and
fails if the server sets a top-level claim that is not in the list: a new server claim must
be reserved in the same change.

A key is `/^[A-Za-z_][A-Za-z0-9_]*$/`, at most 32 characters, and not `__proto__`,
`constructor` or `prototype`. Conservative on purpose: it is a JSON key, a JavaScript
property, a Swift and Kotlin field name, and often a database column, without quoting.

### The size cap

`MAX_CUSTOM_CLAIMS_BYTES` is **1,024 bytes** of the namespace claim's JSON, in UTF-8.

- **At save**, a template is refused when its claims *could* exceed the cap
  (`jwtTemplateMaxBytes`): constants at their exact size, every other source at its maximum
  (`user.email` at 642 bytes: 320 characters, each escaped, and two quotes; a boolean 5; a
  time 16; a client kind 9). It is a true upper bound over every user and session, so a
  template that is saved fits for all of them.
- **At build**, the size is checked again (`CustomClaims.build`). It can only fail for a
  stored document this version reads differently, or for a later source. Then the **whole**
  namespace is left out and the template's name and the byte count are logged, never a value.
  Dropping some claims would choose which authorization facts survive; dropping all is the
  one answer an application already handles ("no claim means no").
- Also capped: 10 templates an environment, 16 claims a template
  (`MAX_JWT_TEMPLATE_CLAIMS`).

Measured in `packages/nextjs/src/real-api.test.ts`: an access token without a template is 716
characters; with a template at the cap it is 2,082. As the `__Host-tula_at` cookie that is
2,097 bytes of name and value, against the 4,096 a browser stores for one cookie: about 2,000
to spare for attributes and for claims Tula adds later. The cap is a constant, not a setting.

### Read at every issue

Nothing of a template or its values is stored with a session. `Sessions` builds the claims
when it signs a token: at sign-in, at every refresh, at the grace-window replay, at a step-up,
and when it answers for a stateful session. So a changed template, a removed one and a newly
verified address reach a session at its next token, and there is no backfill and no stale
copy to reason about.

**A refresh gains no database read.** It already loads the user to refuse a banned one, and
that row is what the claims are read from. A sign-in, a step-up and a stateful request load
the user **only** when the profile's template has a `user.*` source (`CustomClaims.needsUser`).
For a stateful session that is one more read on **every** authenticated request (the fast
path of `Sessions.authenticate`), on top of the session read the type already costs; the
docs say so where an operator chooses a source.
A test counts the user reads of a refresh, a sign-in and a stateful check, with and without
such a template.

**A value that is absent leaves its key out**; it is never `null`. A user with no email
address has no value for `user.email` and none for `user.email_verified`: "is it proven" is
a question about an address, `false` would say there is one, and a reader already has to
treat an absent claim as "no". An address that is there and unproven is `false`. A template
that yields no claim adds no `ext`, never `{}`. A token of a profile with no template is, claim for claim,
the token of before this ADR: a snapshot test holds the claim set.

**Another instance** keeps issuing under the settings it has cached for up to 5 seconds with
Redis and 30 without ([ADR 0016](0016-redis-and-multiple-instances.md)). It can only issue a
template that was valid at an earlier revision, and a token lives for `accessTokenTtl` (at
most 15 minutes) after that. This is the same rule as every setting: nothing here needs to
take effect everywhere at once.

**A stored document never fails a read.** `readStoredJwtTemplate` leaves out a claim whose
source this version does not know (a rollback after a later version added one) and leaves out
whole a template that is over a cap; a stored profile that names a missing template has none.

### Stateful sessions

A stateful session has no token ([ADR 0028](0028-session-profiles.md)). The same claims are
part of `claims` in what `POST /v1/admin/sessions/verify` answers, built by the same function
on every check. `@tula/nextjs` carries them to `auth()` in the sealed `x-tula-auth` header,
whose HMAC already covers the whole claim set ([ADR 0029](0029-nextjs-sdk.md)).

### What an application reads

`readCustomClaims(claims)` in `@tula/contract/custom-claims` (no Zod): the namespace claim as
a frozen record with `unknown` values, or `null` unless it is exactly what a template can
issue: a plain object, at least one own key, every key in the grammar and not reserved, every
value a string, number or boolean, the whole within the cap. Anything else is treated as
absent, whole, for the same reason as at build.

`@tula/nextjs`: `auth().customClaims` is that record (an empty frozen object when signed in
with none, `null` when signed out), and `SessionClaims.ext` is set only from it, so a
malformed `ext` in a verified token never reaches application code. `@tula/core` and
`@tula/react` do not expose the claims: a claim read in a browser decides nothing, and the
core's bundle stays as it was.

### Settings as code and "weaker"

- `tula diff`: templates are a set by name and a template's claims a set by key (order is not
  a change). A claim is compared and shown as one value (`{ from: "user.email" }` →
  `{ value: "x" }`), not as its fields.
- **A change that takes a claim away from sessions is a weakening**, because a missing claim
  is what an application reads as "no" and a changed one as something else: for each profile,
  the claims its sessions carry before and after are compared, and a claim that is lost or
  whose definition changed flags `sessions.profiles.<name>.jwtTemplate`. Adding a template,
  adding a claim, and editing a template no profile uses are not flagged. This is "weaker" in
  the sense the audit entry and `tula apply --yes` use the word: a change that can lock users
  out of something or change what a backend concludes, which an operator should confirm.
- The config fingerprint (`hashEnvironmentConfig`) leaves out an empty `jwtTemplates` and a
  `null` `jwtTemplate`, so an environment without templates hashes as it did.

### Audit and events

A settings change records the keys that changed, never values ([ADR 0012](0012-events-and-audit-log.md)).
For templates that is stricter still: all of `sessions.jwtTemplates` is **one** key. A
template's name is also a *value* elsewhere in the document (a profile's `jwtTemplate`), and
a claim's key says what an application authorizes on; the `settings.updated` event goes to
webhook endpoints, so neither is named, and no constant ever is. A profile that changes its
template is named by its field, `sessions.profiles.<name>.jwtTemplate`.

### A later source of claims

`CustomClaims.build(template, facts, extra)` takes further sources after the template's. They
are merged under the same key grammar, value types and reserved names, a later source wins a
key, and the result is measured against the same cap and dropped whole beyond it. A hook that
adds claims is one more entry in `extra`; whether a hook may override a template's claim is
that ticket's decision.

**2026-10-08 (TULA-53).** That ticket decided it: the `before_token` hook's claims are the
one entry of `extra`, read from the session's row and judged again there
(`CustomClaims.stored`), and **the hook wins a key both set**
([ADR 0035](0035-hooks.md#2026-10-08-hooks-before-a-session-and-before-a-token-tula-53)).
"Read at every issue, never stored" above remains true of a template's claims; a hook's are
stored on the session and are not read from the hook again until the session steps up.
"Dropped whole beyond it" is true of a template alone and is **not** what happens to the two
together: over the cap at issue, the hook's claims are issued and all of the template's are
left out (ADR 0035, "The cap is on the merged claims"). A template alone cannot exceed the
cap; a template beside stored hook claims can.

## Consequences

- An environment without a template is unchanged, byte for byte in its claim set.
- An operator can put a user's address in a token. It is personal data in something that is
  logged by proxies more readily than a database row is. The docs say so; the default is no
  template.
- A constant is the same for every session of a profile. Until a per-user source exists
  (roles, a hook), templates distinguish profiles and expose facts about the user, not
  permissions.
- Tokens grow by up to about 1,370 characters. The cap is fixed so that the Next.js cookie
  always fits.
- A removed claim reaches offline verifiers only as tokens expire: up to one access-token
  lifetime, plus the settings cache of another instance.

## Alternatives considered

- **Templates as their own table and routes.** A second place for configuration, a second
  audit path, a second thing for `tula apply` to order. The settings document already has
  revisions and `If-Match`.
- **A template per environment.** Simpler, and wrong the day a staff profile wants a claim the
  public one must not have.
- **Storing the built claims on the session.** One read fewer at sign-in, and a copy that is
  stale the moment the template or the user changes.
- **Truncating at build** instead of dropping the namespace. It decides which claim an
  application loses, silently.
- **Free-form JSON values** (arrays, objects). Nothing in the closed list produces one, and
  every reader would need a schema. Roles, when they exist, can widen the value type
  additively.

## Deferred

- Claims from organizations, roles or user metadata. (A hook that adds claims was built by
  TULA-53: ADR 0035.)
- Custom claims in `@tula/core` and `@tula/react`.
- A second, separately shaped token (another audience or lifetime).
- Showing the claims a given user would get, in the dashboard.
