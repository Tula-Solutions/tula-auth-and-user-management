# ADR 0026 — OAuth sign-in: Google, GitHub, Apple

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
- **GitHub**: plain OAuth 2.0, no ID token. After the exchange the adapter reads `/user` and
  `/user/emails`: **subject = the numeric user id** (a login can be renamed and re-registered),
  email = the **primary** address with its own `verified` flag. `arctic`'s GitHub client sends
  no PKCE challenge and GitHub has no nonce; the code is bound by the single-use `state` and
  the client secret.
- **Apple**: OIDC with `response_mode=form_post` (the callback arrives as a cross-site `POST`),
  a client secret that is an ES256 JWT signed with the developer's key (team id, key id,
  Services ID; valid five minutes, minted per exchange), the ID token verified like Google's.
  The name arrives only on the first authorization, in the **unsigned** posted `user` field: a
  display name is read from it and nothing else. Private relay addresses are ordinary
  addresses; `email_verified` may be the string `"true"`.
- `arctic` calls the global `fetch` and takes no injected one. The adapters therefore use the
  global `fetch` throughout, looked up at call time, and their tests stub it (`spyOn`) with
  locally generated keys: no test touches the network.
- **Native sign-in** (Phase 2: Google and Apple hand an app an ID token) is a second port
  method, `verifyIdToken`, over the verifier the OIDC adapters already share
  (`adapters/oauth/id-token.ts`). It is not declared yet.
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
  provider is enabled, and the provider routes refuse disabling or removing the last one. The
  two checks are not one transaction; a concurrent pair could leave an environment with no
  method, which locks nobody out for good (an administrator re-enables one).

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

An unverified Tula account may have been created by someone who does not own the address,
precisely to be linked into later; that is why both sides must have verified it.
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

### The mock provider

`OAUTH_MOCK_PROVIDER=true` serves every provider from a built-in adapter whose "consent page"
(`/v1/dev/oauth/authorize`, on the API) asks which address the provider should report. Its
code is the grant sealed with the secret box (stateless, so two instances work), bound to the
client id and redirect URI, expiring in a minute, and exchanged only with the matching PKCE
verifier and nonce. The real callback, ticket, exchange and linking code run behind it in the
browser tests, the conformance scenarios and local development.

Guards: `env.ts` refuses to boot with the variable in any tier but `local` (including `dev`);
the container checks the tier again; the routes are mounted only then, and each handler checks
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
  a token and not the attempt's secret. It is removed on every outcome and expires on the
  device's clock. `redirectUrl` must be on the page's origin (`link.cross_origin`).
- `@tula/react`: "Continue with …" buttons on `<SignIn>` and `<SignUp>` for the providers
  `/v1/client/config` lists (neutral buttons with inline marks, no icon dependency),
  `<OAuthCallback>` / `useOAuthCallback()`, and "Connected accounts" in `<UserProfile>`.

## Consequences

- An environment's first OAuth sign-in needs set-up outside Tula: an app at the provider with
  the callback URL registered (`docs/providers/`), and the app's landing URL on the allow-list.
- **Real Google, GitHub and Apple were not exercised**: there are no credentials. Everything
  up to the provider's endpoints is covered against the mock and with stubbed HTTP.
- GitHub has neither PKCE (in `arctic`) nor a nonce; its code is protected by `state` and the
  client secret only.
- A user who signs up through a provider has no password; removing that provider leaves them
  to a password reset. A provider's changed email never changes the Tula address.
- A sign-in start reads the environment's providers (one indexed read, not cached).
- The provider buttons are not the providers' own artwork. An app must check each provider's
  brand rules (and the App Store's rule about offering Sign in with Apple) for its own theme.
- As with an emailed link (ADR 0024), the browser keeps the landing page's first URL, ticket
  included, in its Navigation Timing entry (observed in Chromium) although the address bar and
  history are cleaned. That copy is of a ticket already spent, useless without the binding.
- Not here: native ID-token exchange (Phase 2), more providers, a generic OIDC provider,
  provider API access on a user's behalf, a "sign-ups allowed" switch, and unlinking by an
  administrator.
- `@tula/core` grew from about 11.0 kB to 12.5 kB gzip (budget 12 → 13 kB) and `@tula/react`
  from 32.7 kB to 38 kB (budget 35 → 39 kB).
- The conformance format gained an `oauth` step; three scenarios (25 to 27) and their SDK
  journeys were added. A live run is about 95 seconds longer (a 61-second and a 31-second wait).
