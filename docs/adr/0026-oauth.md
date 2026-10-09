# ADR 0026 — OAuth sign-in: Google, GitHub, Apple, Microsoft, Discord, LinkedIn, X, Facebook

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
- **Discord** (Phase 2, TULA-13): plain OAuth 2.0 with PKCE, no ID token, on `arctic`'s
  `Discord`; the profile is read from `GET /users/@me`. **LinkedIn** (TULA-13): OIDC with
  **no PKCE and no nonce**, on `arctic`'s `LinkedIn` and the shared `jose` verifier; the
  ID token gives the account and `GET /v2/userinfo` the address. Both are in "Discord and
  LinkedIn" below.
- **X** (Phase 2, TULA-14): plain OAuth 2.0 with PKCE, no ID token, on `arctic`'s generic
  `OAuth2Client`; the account is read from `GET /2/users/me`. **Facebook** (TULA-14): plain
  OAuth 2.0 with **no PKCE and no nonce**, on `arctic`'s `Facebook`; the account is read
  from the Graph API's `/me`. **Neither is asked for an email address**, which changes the
  linking table for the two of them: "X and Facebook: providers without an address" below.
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

For **X and Facebook** rows two to five are replaced by one, because they give no address
("X and Facebook: providers without an address"):

| Situation | Outcome |
| --- | --- |
| The identity (provider + subject) is a user's | That user, as above. |
| The identity is nobody's | A new user with the identity and **no email address**, whatever address the person has at the provider and whoever has it at Tula. Nothing is looked up by address and nothing is connected. |

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
email code is on, or another identity of an enabled provider. An account with no address has
neither of the first two, so its one identity cannot be removed until it has a passkey or a
second provider. The check runs inside the store's
transaction with the user row locked.

**The unique keys arbitrate races**: `(environment, provider, subject)` and the new
`(user, provider)`. A create or link that loses is looked at again once and ends as a sign-in;
never a 500.

**The table holds for every provider, and a test says so per provider.**
`modules/oauth/linking-table.test.ts` states the outcome of every combination (the provider's
address verified, unverified or absent; the Tula account verified, unverified or absent; the
identity known or new) once for each entry of the contract's `OAUTH_PROVIDERS`, with what
that provider's "verified" rests on, and fails for a provider that has no rows. A new
provider adds its rows there; it does not get a rule of its own. There are two rules and no
third: the table above, and the one row of a provider in `OAUTH_PROVIDERS_WITHOUT_ADDRESS`.
The test states which rule each provider has, so moving one between them is a visible change.

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

### Discord and LinkedIn

Added in Phase 2 (TULA-13). Each takes a client id and a client secret and nothing else; the
linking table, the callback, the ticket and the exchange are unchanged, and
`OAuth.resolveAccount` was not touched.

**Discord** is plain OAuth 2.0 (its documentation describes no OpenID Connect and no ID
token), so the shape is GitHub's.

- Scopes: `identify` and `email`, and nothing else.
- After the exchange the adapter reads `GET https://discord.com/api/v10/users/@me` with the
  access token (Discord's "Get Current User"). **Subject = `id`**, a snowflake, accepted only
  as a decimal string of one to twenty digits with no sign and no leading zero (`isSnowflake`):
  one spelling per id, so two spellings can never be two accounts. Never the username.
- **`emailVerified` only when `verified === true`** (the JSON boolean; Discord documents
  `verified` as "whether the email on this account has been verified", with the `email`
  scope) and an address is present. `email` is nullable: an account without one is
  `oauth.email_missing` for a sign-up, by the existing rule.
- The access token is dropped when the adapter returns and is **not revoked**. Discord has a
  revocation endpoint; GitHub's adapter revokes nothing either, and a second outbound call
  that can fail after the profile was read would need an answer for "the profile is good and
  the revocation timed out". The token grants reading the same profile again and nothing
  else was asked for.
- **PKCE (S256) is sent.** `arctic` 3.7.0's `Discord.createAuthorizationURL(state,
  codeVerifier, scopes)` adds `code_challenge` for a confidential client and
  `validateAuthorizationCode(code, codeVerifier)` sends the verifier with the client's Basic
  credentials. The rule is that **a new provider sends PKCE unless its documentation rules
  it out, and silence does not rule it out**. **Discord's OAuth2 page does not mention
  PKCE** (read 2026-10-08), neither for nor against: the source for sending it is the client
  library, not Discord's page, and that Discord accepts the parameters or refuses a wrong
  verifier was never observed against the real service. Apple and LinkedIn are different
  cases: each documents the list of its request's parameters, and a challenge is not among
  them. An authorization server that ignores unknown parameters loses nothing, and one that
  honours them gains the binding. If Discord ever rejects the parameters, passing `null` as the
  verifier to `arctic` removes them; the mock would then have to stop checking Discord's.
  An exchange with an empty verifier is refused before any request, as GitHub's is.
- The profile answer is read up to 64 KiB (`DISCORD_MAX_PROFILE_BYTES`) and a longer one is
  cancelled, not buffered; the request follows no redirect (it would carry the token along).

**LinkedIn** is OpenID Connect ("Sign In with LinkedIn using OpenID Connect"), so the shape
is Google's with two things missing.

- Scopes: `openid`, `profile`, `email`.
- **The ID token is the identity and nothing else.** It is checked by the shared verifier:
  `RS256`, audience = client id, expiry, and keys from
  `https://www.linkedin.com/oauth/openid/jwks`. Subject = `sub`, which LinkedIn's discovery
  document says is pairwise (per application). No other claim of the token is read.
- **Two issuers are accepted, exactly**: `https://www.linkedin.com/oauth` and
  `https://www.linkedin.com`. LinkedIn's discovery document
  (`https://www.linkedin.com/oauth/.well-known/openid-configuration`, fetched 2026-10-08)
  says the first; LinkedIn's guide says the second in its table of ID-token claims. Which one
  a real token carries was not observed. Both are LinkedIn's own, under keys only LinkedIn
  publishes, so accepting either admits nobody else.
- **The address, whether it is verified and the name come from the userinfo endpoint, and
  only from there.** After the token has verified, the adapter reads
  `GET https://api.linkedin.com/v2/userinfo` with the access token: it is where LinkedIn's
  guide documents `email`, `email_verified`, `name`, `given_name` and `family_name` (for the
  ID token it lists `iss`, `sub`, `aud`, `iat` and `exp`). The first version of this adapter
  read the token only; it was changed before any release, because a sign-up that depends on
  claims the provider does not document for the token is a guess. There is **one path**, not
  "the token first, userinfo when it has no address": two sources for one fact are two rules
  for what "verified" means.
- **The answer must be about the member the token is about**: its own `sub` must equal the
  verified token's (`linkedInProfile`), else the exchange fails as an invalid token does
  (`invalid_token`). The answer is protected by TLS and not by a signature, as GitHub's and
  Discord's are; the token is what was verified, so it stays the anchor of who signed in.
- **`emailVerified` only when the answer's `email_verified === true`**, the JSON boolean,
  strictly (LinkedIn documents a Boolean), beside an address. `"true"`, `1`, `false` and an
  absent field are unverified.
- **The read has the bounds of Discord's** (one function, `readProfile` in
  `adapters/oauth/profile-read.ts`): a fixed address, a deadline, `redirect: 'error'` (a
  redirect would carry the token along), at most 64 KiB read and the rest cancelled. No
  answer, a non-2xx (a 401 and a 403 among them, as GitHub's adapter has always treated its
  profile read) and a body cut off are `unavailable`; an oversized or non-JSON answer, or
  one that is not an object, is `invalid_profile`. Nothing of the answer or the token is in
  an error or a log line, and the access token is dropped when the exchange returns.
- **The mock provider keeps the two sources**: a LinkedIn code carries a userinfo answer
  beside the "token's" subject, and the profile is made by `linkedInProfile`, the real
  adapter's own function. The mock still makes no request; its guards are unchanged.
- **No PKCE.** LinkedIn's authorization-code flow page lists five parameters for the
  authorization request and five for the token request, none of them a challenge or a
  verifier; the discovery document has no `code_challenge_methods_supported`; and `arctic`'s
  `LinkedIn.createAuthorizationURL(state, scopes)` takes no verifier. As with Apple, nothing
  undocumented is sent. LinkedIn does document PKCE, but as a flow of its own for native
  clients ("Authenticating with OAuth 2.0 for Native Clients", read 2026-10-09): another
  authorization endpoint (`/oauth/native-pkce/authorization`), a loopback redirect address
  only, no client secret in the token request, and switched on for one app at a time by
  LinkedIn on request. It is not something a server that exchanges a code with a secret
  can send, so it is not an alternative here.
- **No nonce.** The same request takes none, the discovery document does not list `nonce`
  among `claims_supported`, and the guide's ID token has none. `verifyIdToken` used to
  require the attempt's nonce; it now takes `nonce: string | typeof NONCE_NOT_ECHOED`, with
  no default, so that leaving the check out is written at the call and cannot happen by
  forgetting an argument. An empty string is refused there. Only LinkedIn's adapter passes
  the symbol.
- **So LinkedIn's code is bound to the attempt by the single-use `state` and the client
  secret alone**: the weakest binding of the six providers (Google and Microsoft have PKCE
  and a nonce, GitHub and Discord PKCE, Apple a nonce). Someone who can read another user's
  redirect to the callback, and has an unused `state` of their own, could present that
  user's code under their own attempt. The exact, registered redirect URI and the code's
  short life at LinkedIn are what stand in the way. This is LinkedIn's protocol, accepted,
  and stated in `docs/providers/linkedin.md`.

**Read by server-supplied name.** Both the dashboard's cards and its sign-in summary look a
provider up by the name the server sent; they now do it by own key (`own()`), and a provider
this build has no name for gets no card (settings) or is shown as the server's word (the
user's sign-in summary) instead of a property of `Object.prototype`.

### X and Facebook: providers without an address

Added in Phase 2 (TULA-14). Each takes a client id and a client secret and nothing else. The
callback, the ticket, the binding and the exchange are unchanged. **`OAuth.resolveAccount`
gained one branch**, and that branch is what this section decides.

**Neither adapter reports an address, ever.** `email` is `null` and `emailVerified` is
`false` in every profile either returns. X is not asked for the `users.email` scope and its
`/2/users/me` is read with no `user.fields`; Facebook is asked for `public_profile` only and
its `/me` for `fields=id,name`. An answer that carried an address anyway would not be read:
the adapters take two named fields. The reason is the linking table: an address decides which
account a sign-in belongs to, and it may only do that when the provider asserts it verified
in a way the adapter can check. X's `confirmed_email` and Facebook's `email` ("the primary
email address listed on their profile") come with no such assertion that was found. Asking
for an address and then treating it as unverified would refuse every new sign-up
(`oauth.email_unverified`), which is no provider at all; so the address is not asked for, and
a provider that gives none is given a rule that needs none.

**That a provider gives no address is declared in one place**: the contract's
`OAUTH_PROVIDERS_WITHOUT_ADDRESS` (`['x', 'facebook']`, typed against `OAUTH_PROVIDERS`),
read through `givesNoAddress(provider)`. It is a property of the provider, in code. No
request, header, setting or stored row can switch it on for another provider or off for
these two, and the API, the mock provider, the dashboard's card and the linking-table test
all read that one list.

**What `resolveAccount` does for such a provider**, after the row every provider shares (a
known identity is its user):

- the `before_sign_up` hook is asked, at the point it is asked for every provider (the
  account is about to be created, the exchange has checked the ticket and the binding), with
  `email: null` (ADR 0035);
- a user is created with the identity, **no address**, no password, and the name the
  provider gave;
- a creation that loses the unique key `(environment, provider, subject)` to a parallel
  callback is looked at again and ends as that user's sign-in.

Nothing is looked up by address, so nothing can be linked by one, and
`oauth.email_missing` / `oauth.email_unverified` / `oauth.account_exists` cannot be the
answer. For every other provider the code path is what it was: a profile with no address is
still `oauth.email_missing`, and a test holds that beside the new rule.

*Alternative: require an address before the account exists* (a step after the provider that
asks for one and proves it by code). It keeps "every user has an address" and joins the
person to an existing account when they prove its address. Rejected for this ticket: it is a
new flow step (`needs_email`), a screen in every SDK and a change to `FlowStep`; and the
acceptance criterion is the opposite ("a provider account with no address signs up an
account with none"). It remains the natural next step and is listed for the product's
owner.

**A user may now have no email address.** Phase 1 assumed one everywhere. What changed:

| Where | Before | Now |
| --- | --- | --- |
| `users.email`, `users.email_normalized` | `NOT NULL` | Nullable, with the check `users_email_whole`: both or neither, and no verified-at without an address (migration `0025_user_without_address`). The unique key on `(environment, email_normalized)` is unchanged: `NULL`s do not collide, so any number of such users coexist. |
| The `email` identity row | One per user | None for a user with no address. |
| The contract's `User.email`, and `CurrentUser` | `string` | `string \| null`. A client that reads `user.email` has to allow for `null`: a breaking change of the type for TypeScript callers, said in the changeset. |
| `HookBeforeSignUpData.email` | `string` | `string \| null` (ADR 0035). |
| A password | Looked up by address | An account with no address has none and cannot be given one: an administrator's set-password answers 409, a change-password `password.not_set`. A password signs in beside an address; there is no identifier to sign in with. |
| Security notices (ADR 0023) | Sent to the address | **Not sent.** `Notices` returns before the limiter and logs the skip by user id. A new device, a factor changed, an identity changed: none is announced. |
| Step-up (ADR 0025) | A password, or an emailed code | `Mfa.stepUpMethods` is empty until the account has a passkey or an authenticator. Inside the window after sign-in (`stepUpAfter`, ten minutes by default) sensitive changes work; after it, the user signs in again. |
| The label of a passkey and of an authenticator entry | The address | The name, else the word "Account" (`~/lib/account-label`). |
| A JWT template's `user.email` and `user.email_verified` sources (ADR 0036) | The address, and whether it is proven | No value for either, so no key for either: `email_verified` is about the address, and `false` would read as "has an address that is not proven". A template of only those two adds no `ext`. An account with an unproven address still gets `false`. |
| `user.created` | `emailVerified: true` for a provider sign-up | `emailVerified: false`. The payload has no address field and gains none, and the schema is unchanged: `false` there now also covers "no address". A consumer that needs to tell "unproven" from "none" reads the user (`email` is `null`). Unlike the token claim above, the field is required by the event's schema, so it cannot be left out within this schema version. |
| The React profile and user button, the dashboard's user screens | Drew the address | Draw the name (or "Account" / the id), no address line, no "Not verified" badge, no password section and no "Set password" action. |

`Factors.requiredFor`, the `mfa.policy` and the flow's `finish` needed no change: none reads
the address. A passkey sign-in of such a user skips the emailed-code step it would send an
unverified address through (there is nothing to verify). `OAuth.canStillSignIn` needed no
change either: with no password and no verified address its answer rests on the other
identities and the passkeys, which is why the last identity cannot be removed.

**There is no way to add an address to such an account today**, and none was added: no
route changes any user's address. That is the largest cost of this decision and is listed
for the product's owner (`docs/plans/phase-2-unverified.md`).

**Switching the provider off, or removing its credentials, locks such an account out, and
nothing refuses or warns.** `OAuth.update` and `OAuth.remove` ask one thing under the
`sign_in_methods` lock: would the *environment* still have a way to sign in
(`requireWayIn`). Neither asks whether some *user* depends on the provider, on purpose:
that would mean reading every user. Until now the answer to "what about that user" was
that they are not locked out for good, because a reset sets a first password and an
administrator can set one. For an account with no address neither exists: no password can
be set (409), there is nothing to send a code, a link or a reset to, and no route gives it
an address. Its only other ways in are a passkey it registered (with passkeys on) or
another provider it connected that is still on. Otherwise it is locked out until the
provider is configured again, which lets it back in: nothing is deleted, the identity row
stays, the admin API still shows the user, and the sessions it has run their course
(disabling a provider ends none). Facebook's id is scoped to the app, so "again" means the
same Facebook app.

This is documented and pinned, not prevented (`modules/oauth/x-facebook.test.ts`, "an
account whose only way in is this provider is locked out when the operator …"). The
provider pages warn before "switch it off". A refusal or a count of dependent accounts on
the provider's card would need a query over identities per environment and is not part of
this change; it belongs with the route that adds an address.

**X** (`adapters/oauth/x.ts`):

- `arctic`'s `Twitter` client still names `twitter.com` and `api.twitter.com`. X's
  documentation (read 2026-10-09) writes `https://x.com/i/oauth2/authorize` and
  `https://api.x.com/2/oauth2/token`, so the adapter uses `arctic`'s generic `OAuth2Client`
  on those: the same library, no new dependency.
- **PKCE (S256) is sent**: X documents `code_challenge`, `code_challenge_method` and
  `code_verifier`. The client id and secret travel in the token request's `Authorization`
  header (a confidential client).
- Scopes `users.read` and `tweet.read`, the two X's reference lists for the endpoint.
- **Subject = `data.id`** of `GET https://api.x.com/2/users/me`, accepted only as a decimal
  string of one to twenty digits with no sign and no leading zero (`isXUserId`): one
  spelling per account. Never `username`, which a person can change and another can take.
  `data.name` is the display name. The read goes through `readProfile`.
- **X's access terms were read and not confirmed.** Its pricing page (read 2026-10-09)
  describes pay-per-usage credits with no subscription and no free tier named, and a price
  per user read; whether `/2/users/me` is billed is not stated. `docs/providers/x.md` and
  `docs/plans/phase-2-unverified.md` say exactly what was read.

**Facebook** (`adapters/oauth/facebook.ts`):

- `arctic`'s `Facebook` client writes the dialog and the token request (the app id and
  secret in the body).
- **No PKCE and no nonce.** Meta's manual-flow page (read 2026-10-09) documents
  `client_id`, `redirect_uri`, `state`, `response_type` and `scope` for the dialog and
  `client_id`, `redirect_uri`, `client_secret` and `code` for the exchange. A
  `code_challenge` and a `nonce` are documented only for Meta's OpenID Connect flow (the
  `openid` scope), which is another flow with an ID token and is not used. As with Apple and
  LinkedIn, nothing undocumented is sent, and `arctic`'s client takes no verifier. **So
  Facebook's code is bound to the attempt by the single-use `state`, and to the app by the
  app secret and the exact redirect URI**: what LinkedIn's has. The browser binding of the
  ticket (login CSRF) is unaffected.
  *Alternative: Meta's OIDC flow*, which has PKCE and a nonce. Rejected here: it is
  documented for Limited Login and native clients, its ID token would have to be verified
  against a key set and an issuer nobody here has seen, and it would be chosen only for the
  binding, on a reading of a page. Worth revisiting with real credentials.
- **Subject = `id`** of `GET https://graph.facebook.com/v25.0/me?fields=id,name`, the
  app-scoped user id, accepted only as a decimal string of one to thirty-two digits with no
  sign and no leading zero (`isFacebookUserId`). `name` is the display name. Through
  `readProfile`, with the token in the `Authorization` header.
- **`appsecret_proof` is sent**: the access token's HMAC-SHA256 under the app secret, hex,
  computed inside the adapter and put in that one request's query. Meta documents it for
  server calls and requires it when the app's "Require App Secret" is on.
- **The Graph version of the profile read is pinned** (`FACEBOOK_GRAPH_VERSION`, `v25.0`)
  and has to be raised before Meta retires it (`docs/providers/facebook.md`). The dialog
  and token URLs are `arctic`'s, on the version it was built with (`v16.0` in 3.7.0).
- A failed exchange that Facebook answers in the Graph API's error format is `unavailable`,
  not `invalid_grant`: `arctic` reads OAuth's `error` string. Pinned by a test, accepted:
  the caller sees a failed sign-in either way.

**The mock provider** stands in for both: its account id must be digits as the adapters
require, **whatever address is typed on its consent page is dropped** (`givesNoAddress`),
and it checks a PKCE challenge for Facebook too, which the real service cannot.

### The mock provider

`OAUTH_MOCK_PROVIDER=true` serves every provider from a built-in adapter whose "consent page"
(`/v1/dev/oauth/authorize`, on the API) asks which address the provider should report. Its
code is the grant sealed with the secret box (stateless, so two instances work), bound to the
client id and redirect URI, expiring in a minute, and exchanged only with the matching PKCE
verifier and nonce (for every provider, also the two whose real adapters send no PKCE; for
Discord its account id must be a snowflake, and for X and Facebook digits, as the adapters require). The real callback, ticket, exchange and linking code run behind it in the
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
- **Real Google, GitHub, Apple, Microsoft, Discord, LinkedIn, X and Facebook were not exercised**: there are no credentials. Everything
  up to the provider's endpoints is covered against the mock and with stubbed HTTP.
- GitHub sign-in sends PKCE, and that was checked against the mock provider and stubbed
  HTTP only: nothing here has seen github.com refuse a wrong verifier. Apple sign-in has no
  PKCE (Apple documents none); its code is bound by the ID token's nonce.
- **Microsoft sign-up depends on a claim the operator has to switch on** (`xms_edov`):
  without it every new Microsoft account is `oauth.email_unverified`. Whether to let such an
  account in with an unverified address instead is an open product question; it would
  change the linking table for every provider or add a second rule for one.
- **LinkedIn sign-in has neither PKCE nor a nonce**, because LinkedIn documents neither:
  its code is bound to the attempt by `state` and the client secret only. Its address comes
  from the userinfo endpoint: a second outbound call per sign-in, whose answer TLS protects
  and no signature does. No real answer was seen; if its `sub` were not the token's, every
  LinkedIn sign-in would be refused.
- Discord sign-in sends PKCE that Discord's documentation does not mention, on the client
  library's word: not observed against the real service.
- **An account made through X or Facebook has no email address** and cannot be given one
  today: no security notice reaches it, it cannot use an emailed code, a link or a password,
  and it is lost with the provider account unless it has a passkey. Someone with an
  existing account who chooses "Continue with X" gets a second account. A consumer of the
  API, of a webhook or of the `before_sign_up` hook that assumed every user has an address
  now meets `email: null`.
- **Facebook sign-in has neither PKCE nor a nonce**, as LinkedIn's has not: its code is
  bound by `state`, the app secret and the redirect URI. Its Graph API version is a
  constant that ages.
- **What X charges for the one API call a sign-in makes is not known here.**
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
- Discord and LinkedIn (TULA-13) left `@tula/core` at 15,504 bytes and took `@tula/react`
  from 45,985 to 46,846 bytes (two marks and two names; budget 46,000 → 46,861, its fifteen
  bytes of room kept). The conformance format gained a variable generator, `snowflake`, and
  four scenarios (60 to 63) with their SDK journeys. No migration: the provider columns are
  text and their set of values lives in TypeScript.
- X and Facebook (TULA-14) left `@tula/core`'s bundle unchanged (no new error code: the
  refusals reuse `identity.last_sign_in_method`, `password.not_set` and `resource.conflict`)
  and took `@tula/react` from 48,362 to 48,885 bytes (two marks, two names, and a profile
  that may have no address; budget 48,798 → 49,321, its 436 bytes of room kept). Four
  scenarios (66 to 69) with their SDK journeys; the scenario format did not change. One
  migration, `0025_user_without_address`.
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
