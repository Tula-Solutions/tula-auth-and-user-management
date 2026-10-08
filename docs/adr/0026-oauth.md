# ADR 0026 — OAuth sign-in: Google, GitHub, Apple, Microsoft

- Status: accepted
- Date: 2026-10-03
- Builds on [ADR 0004](0004-signing-keys-and-issuer.md) (the secret box),
  [ADR 0018](0018-environment-settings.md) (settings, `urls.allowedRedirectUrls`),
  [ADR 0019](0019-flow-engine-v2.md) (bound attempts, the origin rule, `FIRST_FACTORS`, the
  second-factor hook), [ADR 0024](0024-email-sign-in.md) (the same-browser binding, fragment
  delivery, the exact redirect allow-list), [ADR 0025](0025-mfa.md) (`Factors.requiredFor`,
  `needs_factor_enrolment`, `amr`) and [ADR 0023](0023-security-notices.md) (notices).

## Context

Phase 1 step 1.9: an environment lets users sign up and sign in with Google, GitHub and Apple,
using **its own** OAuth credentials. OAuth sign-in is where four classic failures live: a token
in a URL, an account taken over through linking, login CSRF, and a second factor skipped. Each
decision below answers one of them. There are no shared development credentials (business plan
§5.8): a developer brings their own, so everything had to be testable without any.

## Decision

### Library and adapters

Provider protocol details (authorization URL, PKCE, code exchange, Apple's client-secret JWT)
come from [`arctic`](https://arcticjs.dev) 3.7; ID tokens are verified with `jose`. Nothing of
OAuth is hand-written. Both sit behind a port, `OAuthProvider` (`apps/api/src/ports`):
`authorizationUrl(credentials, { state, codeVerifier, nonce, redirectUri })` and
`exchange(credentials, { code, codeVerifier, nonce, redirectUri, user? })`, which returns a
normalized profile `{ subject, email, emailVerified, givenName?, familyName? }` and nothing
else. Adapters are stateless; credentials are passed per call.

- **Google**: OIDC with PKCE. The ID token is verified against Google's JWKS (cached by `jose`,
  refetched on an unknown `kid`): `RS256` only, issuer, audience = client id, expiry, and the
  `nonce` the attempt put in the request. `email_verified` comes from the token.
- **GitHub**: plain OAuth 2.0 with PKCE, no ID token. After the exchange the adapter reads
  `/user` and `/user/emails`: **subject = the numeric user id** (a login can be renamed and
  re-registered), email = the **primary** address with its own `verified` flag. GitHub has no
  nonce, so PKCE is what binds its code to the attempt, beside the single-use `state` and the
  client secret: the authorization URL carries `code_challenge` (S256 of the attempt's
  verifier) and the token request `code_verifier`. `arctic` 3.7.0's `GitHub` class has no
  parameter for either, so the adapter uses `arctic`'s generic `OAuth2Client`
  (`createAuthorizationURLWithPKCE`, `validateAuthorizationCode` with a verifier) against
  GitHub's two endpoints: the same requests, plus the challenge and the verifier, and still
  nothing hand-written. The generic client does not know that GitHub answers a refused code
  with status 200 and an `error` member, so the adapter tells that apart itself. An exchange
  with an empty verifier is refused before any request (GitHub would accept it for a code
  that was asked for without a challenge), and the callback refuses an attempt that holds no
  verifier before it reaches the adapter. **Verified against the mock provider and unit
  fixtures (the requests the adapter builds), not against github.com**: that GitHub rejects a
  wrong or missing verifier is its documented behaviour ("Authorizing OAuth apps":
  `code_challenge`, `code_challenge_method` = `S256` only, `code_verifier` required once a
  challenge was sent), which no test here observes.
  **Attempts in flight across the upgrade.** A GitHub attempt started by the version before
  this one stored a verifier (every attempt always has) but its authorization URL carried no
  challenge. If its callback is served by the new version, the token request carries a
  `code_verifier` for a code that was asked for without one. What github.com does with that
  is not known here: RFC 7636 leaves it to the server, and GitHub's page speaks only of the
  case where a challenge was sent. The worst case is that those sign-ins fail once
  (`oauth.provider_error`) and the user starts again: an attempt lives ten minutes, so it
  affects GitHub sign-ins begun in the ten minutes before the deployment and finished after
  it, and with several instances also one started on an old instance and finished on a new
  one while both run. Nothing is done about it in code: accepting a callback without the
  verifier, even for a while, would be the gap this change closes.
- **Apple**: OIDC with `response_mode=form_post` (the callback arrives as a cross-site `POST`),
  a client secret that is an ES256 JWT signed with the developer's key (team id, key id,
  Services ID; valid five minutes, minted per exchange), the ID token verified like Google's.
  The name arrives only on the first authorization, in the **unsigned** posted `user` field: a
  display name is read from it and nothing else. Private relay addresses are ordinary
  addresses; `email_verified` may be the string `"true"`. **No PKCE**, deliberately:
  `arctic` 3.7.0's `Apple` class sends none, Apple's documentation of the authorization and
  token requests names no `code_challenge` or `code_verifier`, and its discovery document
  (`appleid.apple.com/.well-known/openid-configuration`) lists no
  `code_challenge_methods_supported`. Sending parameters a provider does not document proves
  nothing and may break at any time, and there are no Apple credentials here to try it with.
  Apple's code is bound to the attempt by the `nonce` in the signed ID token (a code that
  belongs to another sign-in yields a token with another nonce, refused), by the single-use
  `state` and by the client-secret JWT.
- **Microsoft** (Phase 2, TULA-12): OIDC with PKCE and a nonce, on `arctic`'s
  `MicrosoftEntraId` and the shared `jose` verifier. Everything about it that differs from
  Google is in "Microsoft: the tenant, the issuer and the address" below.
- `arctic` calls the global `fetch` and takes no injected one. The adapters therefore use the
  global `fetch` throughout, looked up at call time, and their tests stub it (`spyOn`) with
  locally generated keys: no test touches the network.
- **Native sign-in** (Phase 2: Google and Apple hand an app an ID token) is a second port
  method, `verifyIdToken`, over the verifier the OIDC adapters already share
  (`adapters/oauth/id-token.ts`). It is not declared yet.
- **Every outbound call has a deadline** of ten seconds (`PROVIDER_TIMEOUT_MS`): the code
  exchange, the key-set fetch and GitHub's two profile reads. A provider that does not answer
  in time is `unavailable`, like one that cannot be reached. See "Review decisions" (F6).
- **No provider token is stored.** Access and ID tokens are used inside one adapter call and
  dropped. There is no column for one. Tula signs users in with a provider; it does not call
  provider APIs for them.

### Credentials

Per environment, in a new tenant table `oauth_providers` (provider, client id, sealed secret,
Apple's team and key ids, `enabled`; one row per environment and provider; RLS forced;
migration `0010_oauth`). The secret (client secret, or Apple's `.p8` key) is sealed with the
secret box under its own purpose (`oauth-credentials`) with the environment and provider as
associated data, so a ciphertext copied to another row does not open. It is never returned,
logged or audited.

- `GET /v1/admin/oauth-providers`: every provider, configured or not, with `callbackUrl`
  (`PUBLIC_URL/v1/oauth/callback/<provider>`, the redirect URI to register) and never a secret.
- `PUT /v1/admin/oauth-providers/:provider`: credentials and `enabled`. The secret may be left
  out to keep the stored one. Apple's key is checked to be a P-256 PKCS#8 key at once.
  Audited as `oauth_provider.updated` with the **names** of what changed.
- `DELETE /v1/admin/oauth-providers/:provider`: audited as `oauth_provider.deleted`. Users keep
  their identities. **It is not refused because a user has no other way in**: deciding that
  means reading every user, and such a user recovers through a password reset (which sets a
  first password) or an administrator. It **is** refused when it would leave the environment
  with no sign-in method at all.
- An enabled provider is a first factor: `FIRST_FACTORS` offers `oauth_<provider>`, and
  `GET /v1/client/config` lists the providers in `signIn.oauth`. **"At least one sign-in method"
  now counts providers.** The settings document no longer refuses "every method off" in its
  schema (providers are not part of the document); `Settings.replace` refuses it unless a
  provider is enabled, and the provider routes refuse disabling or removing the last one.
  The rule spans two stores written by different routes, so **both writes take one
  per-environment lock** (`deps.environmentLock`, scope `sign_in_methods`) and make their check
  inside it, reading the settings past the cache and the provider rows from the store: neither
  decides on a snapshot the other is about to change. See "Review decisions" (F3).

### The flow

```
POST /v1/client/sign-ins/oauth { provider, redirectUrl }      → { attempt, authorizationUrl, binding }
browser → provider → GET|POST /v1/oauth/callback/:provider    → 303 redirectUrl#tula_ticket=…&tula_attempt=…
POST /v1/client/sign-ins/oauth/exchange { ticket, attemptId, binding } → the next flow step
```

- **Start.** Publishable key, the origin rule, the provider enabled, and `redirectUrl` exactly
  on `urls.allowedRedirectUrls` (loopback in the local tier). The attempt is a `sign_in` on
  `needs_first_factor` offering only `oauth_<provider>`: one kind for sign-in and sign-up,
  because "continue with Google" creates the account when there is none. Kept on the attempt,
  server-side: SHA-256 of `state`, the PKCE verifier, the nonce, SHA-256 of the binding. The
  client gets the provider URL and the **binding** (256 bits, once).
- **The callback is on the API**, not on the app: the code never passes through app pages, and
  one redirect URI serves every app of an environment. It carries no API key and no cookie, so
  `state` names its environment and attempt (`<environment>.<attempt>.<random>`; RLS needs the
  environment to look anything up) and its hash is compared in constant time. **`state` is
  single use**: it is consumed (a compare-and-set on the attempt's phase) before the code is
  exchanged, whether or not the exchange succeeds. The callback sets no cookie, creates no
  session, returns no token, and reflects nothing the provider sent: it answers a 303 to the
  attempt's allow-listed URL with a ticket or a contract error code in the **fragment**, or,
  when the state matches no attempt, a constant page. Provider failures are logged by kind
  only and become `oauth.provider_error`.
- **The ticket** is 256 bits, single use, valid 60 seconds, stored hashed. It is not a token.
- **The exchange** is authorized by the ticket **and the binding**, not by the attempt's
  secret, which the navigation destroyed. A wrong or missing binding is the login-CSRF case
  (an attacker's callback URL opened in a victim's browser): `oauth.different_browser`,
  nothing completed, nothing used up. With both, the account is resolved (below) and the
  engine continues as after any first factor: ban check, `Factors.requiredFor` →
  `needs_second_factor`, the MFA policy → `needs_factor_enrolment`, else a session. **The
  attempt's secret is rotated** at the exchange: the response carries a fresh `attemptSecret`
  when the flow continues, and the old one stops working.
- The attempt's phase (`started` → `returned` → `proven` → `exchanged`) is what makes the
  state and the ticket single use: `FlowAttemptStore.transition` gained an optional guard on a
  value of the stored state, because the attempt's status does not change in between.
- **`amr`**: an OAuth sign-in records `fed`. RFC 8176 registers no value for federated
  sign-in; `fed` is the de-facto one (Microsoft Entra ID uses it).
- The provider's identity is the proof, not the inbox: an OAuth sign-in never detours through
  `needs_email_verification`, and does not change the address's verified flag afterwards.

### Which account: the linking table

| Situation | Outcome |
| --- | --- |
| The identity (provider + subject) is a user's | That user. The provider's email is not looked at. |
| The provider gave no address, or does not assert it verified | `oauth.email_missing` / `oauth.email_unverified`, **before** any lookup by address. No account is created with an unverified address, and nothing is revealed. |
| No user has the address | A new user with the identity, the address verified, no password. |
| A user has the address, verified on their Tula account | The identity is connected to them (`user.identity_linked`, `method: auto`, the owner is emailed) and they sign in. A second factor still applies. |
| A user has the address, **unverified** on their Tula account | `oauth.account_exists`. Nothing is connected. |

**An address is compared as it was written.** `parseEmail` validates a provider's address
before any case folding and accepts printable ASCII only (an IDN domain in its punycode form):
a look-alike such as U+212A KELVIN SIGN, which lowercases to `k`, is `oauth.email_missing` and
is never looked up, linked or created under the ASCII address it resembles. See "Review
decisions" (F1).

An unverified Tula account may have been created by someone who does not own the address,
precisely to be linked into later; that is why both sides must have verified it. (The same
account is why an emailed sign-in that verifies such an address removes its password:
ADR 0024, "A password set before the address was proven". After that the address is verified,
the password is gone, and a later provider sign-in links into an account only its owner can
enter.)
`oauth.account_exists` tells the caller an account exists. **That is acceptable here and
nowhere else**: it is only reached with an address the provider asserts verified, so the
caller has proven control of that inbox and learns nothing its own "forgot password" email
would not tell it. An *unverified* provider address is refused before the lookup, the same
with and without an account.

A banned user is connected to nothing. An account that already has another account of the
provider is not given a second (`oauth.account_exists`). There is no sign-ups switch in the
settings today, so account creation is not gated; when one is added it gates
`OAuth.resolveAccount`.

**From a profile.** `GET /v1/client/me/identities`; `POST /v1/client/me/identities/oauth`
(step-up) starts a link attempt bound to the session's user;
`POST /v1/client/me/identities/oauth/exchange` connects the identity to **that** user whatever
its address, or answers `oauth.identity_in_use` / `oauth.already_linked`;
`DELETE /v1/client/me/identities/:id` (step-up) is refused with `identity.last_sign_in_method`
when nothing else would let the user in. "A way to sign in" is one function
(`OAuth.canStillSignIn`): a password where passwords are on, a verified address where the
email code is on, or another identity of an enabled provider. The check runs inside the store's
transaction with the user row locked.

**The unique keys arbitrate races**: `(environment, provider, subject)` and the new
`(user, provider)`. A create or link that loses is looked at again once and ends as a sign-in;
never a 500.

**The table holds for every provider, and a test says so per provider.**
`modules/oauth/linking-table.test.ts` states the outcome of every combination (the provider's
address verified, unverified or absent; the Tula account verified, unverified or absent; the
identity known or new) once for each entry of the contract's `OAUTH_PROVIDERS`, with what
that provider's "verified" rests on, and fails for a provider that has no rows. A new
provider adds its rows there; it does not get a rule of its own.

### Microsoft: the tenant, the issuer and the address

Phase 2 (TULA-12). Scopes `openid profile email` and nothing else; no Graph call.

- **The tenant is a credential field, required, with no default.** `tenant` is `common`,
  `organizations`, `consumers` or one tenant's id (a GUID; a domain name is refused, because
  a token names its tenant by id and ids are what is compared). It is stored in the
  provider's `config` beside nothing secret, returned by the list, and recorded on a change
  as the name `tenant` in `oauth_provider.updated.changed`, never its value. A default of
  `common` was considered and not taken: it would let every Microsoft account on earth sign
  in to an environment whose operator only typed a client id. No migration: `config` is
  `jsonb` and the provider column is text. The admin route stores only such a value; a row
  that holds anything else (changed in the database) is not repaired: `OAuth.credentials`
  answers `auth.method_disabled`, at the point and in the words of a provider that is off,
  so a start makes no attempt and an anonymous caller learns nothing about why, and the
  field's name is logged for the operator. **Such a row is not counted as a way to sign in**
  (`isSignInMethod`, behind `OAuth.enabledProviders` and the settings' "at least one
  sign-in method"): it is not offered, an identity of it is no way in for a user, and it
  cannot be what lets the last working method be switched off; the admin list still shows it
  as stored, `enabled` included, so it can be repaired. "Enabled" is not "usable" in one
  other case, which is left as it was: a provider whose stored secret no longer opens (a
  changed master key) is still counted, because telling means opening the secret on every
  count; the diagnostics' master-key check is what reports it.
- **An account is `<tid>:<oid>`**, both GUIDs, lower-cased. Never `sub` (pairwise: another
  value for every application, so it would not survive a new app registration), and never
  `email`, `preferred_username` or `upn`, which a tenant's administrator sets. The object id
  alone is not enough: it is unique within a tenant only. A token without a well-formed
  `tid` and `oid` is refused.
- **The issuer is checked against the token's own tenant.** With `common`, `organizations`
  and `consumers` there is no one issuer to compare with: Microsoft's metadata gives
  `https://login.microsoftonline.com/{tenantid}/v2.0`. The adapter verifies the signature
  against the configured authority's keys, then requires `tid` to be a GUID and `iss` to
  be exactly that template with the token's `tid` in it, then that the signing key is one
  Microsoft publishes for that issuer (each key carries an `issuer`, templated or, for the
  personal-account tenant, exact: Microsoft's "Validate the signing key issuer"), then that
  the tenant is one the configured value accepts (the tenant itself for a GUID; the
  personal-account tenant `9188040d-6c67-4c5b-b112-36a304b66dad` and only it for
  `consumers`; every tenant but it for `organizations`). Without the first of these a
  token signed by any tenant's key would be accepted with another tenant's `tid` typed into
  it; without the key rule, a personal-account key could sign for an organization. **A key
  with no `issuer` is refused**: Microsoft's keys document has one on each, and accepting a
  key that says nothing about whom it signs for would undo the rule. Every failure is the
  one `invalid_token` (`oauth.provider_error` to the client), carrying nothing of the token.
- **The address is verified only with `xms_edov` exactly `true`.** `email` in a Microsoft
  token is what the tenant's administrator stored; Microsoft's claims reference says it
  "isn't guaranteed to be correct" and gives `xms_edov` ("whether the user's email domain
  owner has been verified") as the claim to rely on. Absent, `false`, the string `"true"` or
  `1`: unverified. The table above then applies unchanged: an unverified provider address
  is `oauth.email_unverified` **before any lookup**, so a Microsoft token without the claim
  signs in an identity that is already known and nothing else. It creates no account and is
  linked to none, and the answer is the same whether or not the address has an account.
  That is stricter than the ticket's wording ("automatic linking does not happen") and is
  what the existing rule gives; a path that created an account with an unverified address
  for Microsoft alone would be a second linking rule, and was not added. The cost is real:
  an operator who has not added the optional claim to the app registration gets no
  Microsoft sign-ups, and the user's message ("verify it with the provider") points at
  something the user cannot do. `docs/providers/microsoft.md` says so in its checklist.
  **Whether a personal account's token carries the claim is not known**: the reference
  speaks of a domain owner, which a personal account does not have in the same sense, and
  no such token was seen. If it does not, `consumers` admits accounts that can be
  connected from a profile and can never sign up.
- **PKCE is sent** (S256), and the nonce is checked in the ID token.
- **The mock provider serves it** with a tenant id and an object id on its consent page and
  a box that leaves the verified-domain claim out, and refuses an account of a tenant the
  configured `tenant` does not accept, as the adapter does. Its guards are unchanged.
- **Not exercised against Microsoft.** No tenant, no credentials, no real token. The
  adapter's refusals are tested with tokens the tests sign with their own keys, published
  through a stubbed keys document that carries `issuer` the way Microsoft's documentation
  shows it. That `xms_edov` arrives as a JSON boolean, that every key carries `issuer`, and
  what the portal calls each step are read from the documentation, not observed.

### The mock provider

`OAUTH_MOCK_PROVIDER=true` serves every provider from a built-in adapter whose "consent page"
(`/v1/dev/oauth/authorize`, on the API) asks which address the provider should report. Its
code is the grant sealed with the secret box (stateless, so two instances work), bound to the
client id and redirect URI, expiring in a minute, and exchanged only with the matching PKCE
verifier and nonce. The real callback, ticket, exchange and linking code run behind it in the
browser tests, the conformance scenarios and local development.

Guards: `env.ts` refuses to boot with the variable in any tier but `local` (including `dev`),
**and with a `PUBLIC_URL` whose host is not loopback** (`localhost`, `127.0.0.1`, `[::1]`, a
`*.localhost` name): the tier is a label an operator types, and an API that tells other machines
where to reach it is not a developer's own machine. The container checks the tier again and
**logs a warning at every boot** while the mock is on; the routes are mounted only then, and each handler checks
once more; the consent page redirects only to this API's own callback; it is not in the
OpenAPI document. A standalone mock OIDC server pointed at through an issuer override was
considered: it would exercise the Google adapter's verifier too, but needs a second process
reachable from both the browser and the API container, and an override that exists in
production code. The adapters' verifiers are covered by unit tests with local keys instead.

### SDKs

- `@tula/core`: `signIn.withOAuth({ provider, redirectUrl, navigate? })` keeps the binding and
  navigates (or returns the URL); `signIn.handleOAuthCallback()` strips the fragment before any
  request and answers `complete` / `needs_step` (with a flow on that step), `linked`,
  `different_browser`, `error` (a contract code) or `none`; `user.identities.{list,link,unlink}`.
  **The binding is kept in `sessionStorage`** (`tula.oauth.<attempt id>`): the page is replaced
  by the provider's, so memory does not survive, and the same tab must read it back. It is not
  a token and not the attempt's secret. It is removed when the exchange has a **definitive
  answer** (success, or any refusal by the API) and expires on the device's clock. When the
  exchange gets no answer (`network.failed`, `network.timeout`) or a `rate_limited`, the error
  is thrown and the round trip is kept: the binding stays, the ticket is held **in memory only**
  (a closure of the client; never storage, the address, an error or `toJSON`) for 60 seconds,
  and calling `handleOAuthCallback()` again retries. `signIn.discardOAuthCallback()`, a
  sign-out and a new round trip forget it. `isRetryableOAuthError` tells the two kinds of
  failure apart. `redirectUrl` must be on the page's origin (`link.cross_origin`).
- `@tula/react`: "Continue with …" buttons on `<SignIn>` and `<SignUp>` for the providers
  `/v1/client/config` lists (neutral buttons with inline marks, no icon dependency),
  `<OAuthCallback>` / `useOAuthCallback()` (with "Try again" / `retry()` after a request that
  got no answer), and "Connected accounts" in `<UserProfile>`.

## Consequences

- An environment's first OAuth sign-in needs set-up outside Tula: an app at the provider with
  the callback URL registered (`docs/providers/`), and the app's landing URL on the allow-list.
- **Real Google, GitHub, Apple and Microsoft were not exercised**: there are no credentials. Everything
  up to the provider's endpoints is covered against the mock and with stubbed HTTP.
- GitHub sign-in sends PKCE, and that was checked against the mock provider and stubbed
  HTTP only: nothing here has seen github.com refuse a wrong verifier. Apple sign-in has no
  PKCE (Apple documents none); its code is bound by the ID token's nonce.
- **Microsoft sign-up depends on a claim the operator has to switch on** (`xms_edov`):
  without it every new Microsoft account is `oauth.email_unverified`. Whether to let such an
  account in with an unverified address instead is an open product question; it would
  change the linking table for every provider or add a second rule for one.
- A user who signs up through a provider has no password; removing that provider leaves them
  to a password reset. A provider's changed email never changes the Tula address.
- A sign-in start reads the environment's providers (one indexed read, not cached).
- The provider buttons are not the providers' own artwork. An app must check each provider's
  brand rules (and the App Store's rule about offering Sign in with Apple) for its own theme.
- As with an emailed link (ADR 0024), the browser keeps the landing page's first URL, ticket
  included, in its Navigation Timing entry (observed in Chromium) although the address bar and
  history are cleaned. That copy is of a ticket already spent, useless without the binding.
- **Migration `0010_oauth` adds a unique key on `identities (user_id, provider)`** and fails
  on a database that already holds two identities of one provider for one user. No released
  version could create such rows (before this step the only provider was `email`, one per
  user), but an operator who wrote to the table by hand checks first, as the owner:
  `select user_id, provider, count(*) from tula.identities group by 1, 2 having count(*) > 1;`
  and removes the extra rows before migrating (`docs/self-host.md`).
- **Switching a method or provider off is not instant everywhere.** Settings are cached per
  instance (5 seconds with Redis, 30 without; ADR 0018), so another instance may go on
  offering a sign-in method for that long, and `Settings.requireMethod` checks every step
  against the same cache. Provider rows are read without a cache at every start and callback,
  but a round trip already at the provider's consent page ends at the callback's check. The
  "at least one sign-in method" rule does not depend on the cache (it reads past it, under the
  lock). Accepted: nothing whose safety depends on taking effect everywhere at once may be put
  behind either switch.
- Not here: native ID-token exchange (Phase 2), more providers, a generic OIDC provider,
  provider API access on a user's behalf, a "sign-ups allowed" switch, and unlinking by an
  administrator.
- `@tula/core` grew from about 11.0 kB to 12.5 kB gzip (budget 12 → 13 kB) and `@tula/react`
  from 32.7 kB to 38 kB (budget 35 → 39 kB).
- The conformance format gained an `oauth` step; three scenarios (25 to 27) and their SDK
  journeys were added. A live run is about 95 seconds longer (a 61-second and a 31-second wait).

## Review decisions

Findings of the review of this step, and what was decided.

- **F1, look-alike addresses.** `parseEmail` validated the lowercased address, and
  `toLowerCase()` maps U+212A (KELVIN SIGN) to `k`: a provider address spelled with it equalled
  an ASCII mailbox and could be linked to its owner's account. Now the address is validated as
  written, before folding, and must be printable ASCII in both parts (punycode for an IDN
  domain); `normalizeEmail` folds `A` to `Z` only. Internationalised local parts were never
  accepted and still are not; this is stated instead of implied. Every caller (sign-up, reset,
  admin user creation, the mock consent page, `OAuth.resolveAccount`) refuses such an address;
  a sign-in identifier containing one simply matches no account.
- **F3, the last sign-in method under concurrent writes.** A new port, `EnvironmentLock`
  (`runExclusive(environmentId, scope, fn)`), with a memory adapter and a Postgres one on a
  session-level advisory lock, and one behaviour suite run by both and against two real
  sessions. Unlike `JobLock` it **waits**: the second administrator request must be decided
  against what the first wrote. It waits by retrying `pg_try_advisory_lock` (25 ms apart, up to
  5 s, then `service.unavailable` with nothing written) rather than blocking in
  `pg_advisory_lock`, because blocked waiters would each sit on a pool connection and could
  leave the holder without one for its own write. The key is Tula's namespace and a hash of
  scope and environment, kept above the fixed job ids; two environments sharing a key only take
  turns. `Settings.replace` and `OAuth.update` / `OAuth.remove` do their read, check and write
  inside it. The store's own revision check stays as the second line. The lock is not
  reentrant.
- **F4, a sign-in lost to a dropped request.** See SDKs above. A retry after a request that did
  reach the API finds the ticket spent (`oauth.ticket_invalid`), which is a definitive answer:
  the user starts again. The ticket is held no longer than the API honours it.
- **F5, the mock provider.** Loud (a warning at every boot) and loopback-only (`PUBLIC_URL`),
  on top of the tier check.
- **F6, provider timeouts.** `AbortSignal.timeout` on GitHub's REST reads; `timeoutDuration` on
  `jose`'s key-set fetch; and a timer raced against every call, which is the only way to bound
  `arctic`'s code exchange (it takes neither a `fetch` nor a signal: the request is abandoned,
  not cancelled, and nothing of a late answer is read). A timeout is `unavailable`, logged by
  kind only. The callback consumes `state` before the exchange, so a timed-out attempt is left
  exactly as after any failed exchange: spent, with no ticket, no account and no session.
