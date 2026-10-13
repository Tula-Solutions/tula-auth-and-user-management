---
paths:
  - "apps/api/src/modules/oauth/**"
  - "apps/api/src/adapters/oauth/**"
  - "apps/api/src/modules/email-address/**"
  - "apps/api/src/modules/flow/**"
  - "packages/contract/src/redirect-url*"
  - "packages/contract/src/oauth*"
---

# OAuth providers, and an email address for an account without one

Moved here from `AGENTS.md`, word for word, and canonical for this area: `AGENTS.md` lists
this file under "Area rules" and does not repeat it. A section named in a sentence as
"above" or "below" is found through that list.

## OAuth providers

Sign-in with Google, GitHub, Apple, Microsoft, Discord, LinkedIn, X and Facebook
([ADR 0026](../../docs/adr/0026-oauth.md)) lives in
`modules/oauth` (provider credentials, account resolution and linking, the callback and
identity routes) and in the flow service (`startOAuth`, `oauthCallback`, `exchangeOAuth`).

- **Credentials are per environment and are not part of the settings document**: the table
  `oauth_providers`, managed through `/v1/admin/oauth-providers`, the secret sealed with
  `~/lib/secret-box` (purpose `oauth-credentials`, bound to environment and provider). Read
  them only through `OAuth.credentials`, which also checks the provider is enabled; call it on
  every step that uses a provider.
- **Protocol goes through the `OAuthProvider` port** (`deps.oauth[provider]`); adapters are in
  `adapters/oauth/` (`arctic` + `jose`). An adapter returns a profile and nothing else: no
  provider token leaves it or is stored. Unit tests use `FakeOAuthProvider`
  (`createTestDeps().oauth.google.profile = …`).
- **A provider's code is bound to the attempt.** Google, GitHub, Microsoft, Discord and X send
  PKCE (the S256 challenge of the attempt's `codeVerifier` on the authorization URL, the
  verifier on the token request); Google, Apple and Microsoft check the attempt's `nonce`
  in the ID token. Apple documents no PKCE and is sent none. **LinkedIn documents neither
  and gets neither**: its code is bound by the single-use `state` and the client secret
  alone, which ADR 0026 and `docs/providers/linkedin.md` say in so many words. **Facebook's
  flow documents neither as well** (Meta has them only in its OpenID Connect flow, which is
  not used) and is sent neither: `state`, the app secret and the exact redirect URI bind
  its code. Whether an
  ID token's nonce is checked is written at every call of `verifyIdToken` (the attempt's
  nonce, or `NONCE_NOT_ECHOED`): never give that parameter a default. **A LinkedIn profile
  has two sources with one job each**: the verified ID token gives `sub` and nothing else,
  the userinfo answer (`GET https://api.linkedin.com/v2/userinfo`, read through
  `readProfile` like Discord's user: a deadline, no redirect, 64 KiB) gives the address,
  `email_verified` and the name, and its `sub` must be the token's (`linkedInProfile`, which
  the mock provider uses too). Never fall back from one source to the other. The callback refuses an attempt with no verifier before
  it reaches an adapter, and the mock provider checks the verifier for every provider. A new
  provider sends PKCE unless its documentation rules it out, and the ADR says which.
- **Which providers send PKCE is two closed lists in `@tula/contract/redirect-url`**
  (`OAUTH_PROVIDERS_WITH_PKCE`, `OAUTH_PROVIDERS_WITHOUT_PKCE`: Apple, LinkedIn, Facebook),
  read through `bindsCodeWithPkce` and nothing else
  ([ADR 0044](../../docs/adr/0044-app-link-and-custom-scheme-redirects.md)). A new provider goes
  in exactly one: `modules/oauth/native-redirects.test.ts` fails for one in neither, and
  builds every real adapter's authorization URL to hold the lists to whether it carries a
  `code_challenge`. Never make the lists a setting or a stored value.
- **A custom-scheme redirect is for a provider sign-in, by a native client, with a
  provider that sends PKCE.** `customSchemeRedirectRefusal` (the contract's) decides, and
  `Settings.requireRedirectUrl` is its only caller: a **listed** custom scheme asked for
  otherwise is `request.redirect_not_allowed` with the fixed `params.reason`
  (`CUSTOM_SCHEME_REDIRECT_REFUSALS`: `provider_without_pkce` before `client_not_native`,
  and `not_a_provider_sign_in` for an emailed link); an unlisted URL gets no reason. It is
  judged at the start, before the attempt is made and before the environment's ceiling is
  counted, **and again at the callback** against the attempt's own client and provider.
  The answer never depends on who signs in. The identity-link start
  (`/v1/client/me/identities/oauth`) makes a `web` attempt and is refused one. The
  callback's answer is the same for every kind of redirect URL (a bare `303`, the ticket in
  the fragment, no cookie, no body), and the ticket still completes nothing without the
  binding: keep the tests of both for a custom scheme and an app link.
- **The mock provider** (`OAUTH_MOCK_PROVIDER=true`) serves every provider from the API
  itself, with a consent page at `/v1/dev/oauth/authorize`. It needs `ENVIRONMENT=local`
  **and** a loopback `PUBLIC_URL` (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`): `env.ts`
  refuses to boot otherwise, `container.ts` checks the tier again, and it warns on every boot,
  because with it on anyone who can reach the API signs in as any address. The conformance
  scenarios, SDK journeys and browser tests use it. Never loosen its guards.
  **Every development-only route answers a loopback `Host` only** (`isLoopbackHost`: the
  consent page and the token route under `/v1/dev/oauth`, and the SMS inbox), whatever a
  forwarding header says: a tunnel in front of the API must not reach one. A new such
  route gets the tables of `modules/oauth/dev-router.test.ts`; a test that hands the app
  a request directly names this machine with `fromThisMachine` (`~/testing/local-host`),
  never by loosening the check. **The consent form's post is taken only from the page that
  showed it** (`postedByOwnPage` in `modules/oauth/dev-router.ts`: no `Sec-Fetch-Site` that names
  another origin, and no `Origin`, the origin of `PUBLIC_URL` compared as a string, or
  `null` beside `Sec-Fetch-Site: same-origin`, which is what a browser sends under the
  API's `no-referrer` policy; a bare 403 before the form is read), so neither another site nor the app under
  development on another port posts it; a request with neither header is a tool's. The
  `GET` is not held to an origin (it is reached by a navigation from the app) and its
  page says `frame-ancestors 'none'`. ADR 0026 has what each check stops.
- **Which account a provider identity signs in to is decided in one place**,
  `OAuth.resolveAccount`, and only at the exchange (after the binding is checked), never in
  the callback. "Can still sign in" is `OAuth.canStillSignIn`. **The linking outcome is
  stated per provider** in `modules/oauth/linking-table.test.ts`, which fails for an entry
  of `OAUTH_PROVIDERS` with no rows: a new provider adds its rows and what its "verified"
  rests on, never a rule of its own.
- **X and Facebook give no address, and that is declared in one place**: the contract's
  `OAUTH_PROVIDERS_WITHOUT_ADDRESS`, read through `givesNoAddress(provider)`. Their adapters
  ask for no email scope or field and return `email: null`, `emailVerified: false` always;
  never read an address from either, and never make the list something a request, a
  setting or a stored row can change. For a provider on it `OAuth.resolveAccount` has one
  row after "a known identity is its user": a new user with the identity and **no email
  address**, with nothing looked up or linked by address. Every other provider keeps the
  table, where a profile with no address is still `oauth.email_missing`. The linking-table
  test states which of the two rules each provider has; there is no third. An X account is
  `data.id` of `GET /2/users/me` (`isXUserId`: digits, one spelling, never the username); a
  Facebook account is the app-scoped `id` of the Graph API's `/me` (`isFacebookUserId`),
  read on the pinned `FACEBOOK_GRAPH_VERSION` with `appsecret_proof`, both through
  `readProfile`.
- **A user may have no email address** (`users.email` and `email_normalized` are null
  together: `users_email_whole`). Only `OAuth.resolveAccount` makes one, and only for a
  provider on that list. Code that reads `user.email` handles `null`: such a user has no
  `email` identity row, no password (`Passwords.ofUser` is the lookup; setting one is
  refused), gets no notice (`Notices` returns before the limiter and logs the skip by id),
  has no step-up method until a passkey or an authenticator exists, and is named by
  `accountLabel` (`~/lib/account-label`) where a label is needed. Never write the string
  `null`, an empty string or a placeholder where an address would go, and never send mail
  to one. Such a user gets an address by the rules of "An email address for an account
  without one" below, and by nothing else.
- **A Microsoft account is `<tid>:<oid>`, its issuer is its own tenant's, and its address is
  verified only by `xms_edov`** (`adapters/oauth/microsoft.ts`). Never identify one by
  `sub`, `email`, `preferred_username` or `upn`. `iss` must equal
  `https://login.microsoftonline.com/<tid>/v2.0` built from the token's own `tid`, the
  signing key's `issuer` must cover it (a key without one is refused), and the tenant must
  be one the environment's `tenant` accepts; every failure is the same `invalid_token`.
  `emailVerified` is `xms_edov === true` and nothing looser. `tenant` is required, has no
  default, is an alias or a GUID (never a domain name), and is not a secret. A stored
  `tenant` that is anything else is the provider being unavailable: `OAuth.credentials`
  answers `auth.method_disabled` exactly as for a provider that is off, before a redirect
  URL is judged or an attempt made, and logs the field's name, never its value. Such a row
  is **not a way to sign in**: `isSignInMethod` (`modules/oauth/provider-record.ts`) is
  the one rule behind `OAuth.enabledProviders` and the settings' "at least one sign-in
  method", so never count providers by `enabled` alone. A new refusal
  gets a row in the table of `adapters/oauth/microsoft.test.ts`, with a token the test
  signs.
- **Discord and LinkedIn report an address as verified only on the provider's own word, a
  JSON boolean**: Discord's `verified === true` on the user object, LinkedIn's
  `email_verified === true` in the userinfo answer, and only in an answer whose `sub` is
  the verified ID token's (`linkedInProfile`; never the string Apple sends, and never the
  token's own `email` claims, which are not read). A
  Discord account is its user id, taken only through `isSnowflake` (one decimal spelling
  per id), never the username; a LinkedIn account is the verified ID token's `sub`, under
  one of the two issuers of `LINKEDIN_ISSUERS`. Each provider's access token is read with
  once, at its profile endpoint, and dropped.
- **A native app signs in with a provider's ID token in two steps of one attempt**
  ([ADR 0045](../../docs/adr/0045-native-id-token-exchange.md)): `Flows.startIdTokenSignIn`
  (`POST /v1/client/sign-ins/id-token`) makes the attempt and a **nonce of the server's**
  (32 random bytes, in the attempt's state), and `Flows.submitIdToken`
  (`…/:attemptId/id-token`) takes `{ idToken }` and, for Apple alone, the unsigned
  `givenName` / `familyName` the sheet gave the app (below). Never take an audience, a
  nonce or any other profile field from a request. Google and Apple
  (`ID_TOKEN_PROVIDERS`); which clients may start is per provider
  (`ID_TOKEN_CLIENT_KINDS`: `ios` and `android` for Google, `ios` alone for Apple; the
  client's own claim: a policy, not a boundary); no redirect URL, ticket or binding. From there it is the browser flow's own code
  (`completeProviderSignIn`: `OAuth.resolveAccount`, `Factors.requiredFor`, `finish`):
  never a second path to an account or a session.
  - **A token is verified by the adapter, through the port's optional `verifyIdToken`**:
    the code flow's verifier (signature, `RS256`, issuer, expiry), then
    `nativeIdTokenProfile`, which the mock shares: `aud` **one string** among the accepted
    client ids, `azp` among them when present, the nonce equal as a string in constant
    time, `email_verified === true` the boolean. Never accept a token with several
    audiences, never skip `azp`, and never add a second accepted form of the nonce
    without a decision in ADR 0045.
  - **The accepted client ids are `OAuth.idTokenAudiences`**: for Google, the record's `clientId` and
    its `additionalClientIds` (Google only: `takesAdditionalClientIds`, the contract's `AdditionalClientIdsSchema`,
    in the row's `config`; the `PUT` replaces the record, so left out is none). The
    provider's own `clientId` is never among them: the contract's `ownClientIdAmong` is
    the one rule, for the admin route's 422, `@tula/config` and the dashboard's field,
    and the tolerant read leaves such an entry out. **A
    gained id is a weakening** (`oauthProviderWeakenings`, shared by the audit entry, the
    dashboard's question and `tula apply --yes`). No client id in an audit entry or an
    event: `changed` names the field and `additionalClientIdCount` counts, only when it
    changed.
  - **The nonce is taken, by a compare-and-set, before the token is judged**, after
    `OAuth.credentials` and the environment's ceiling (which therefore leave it usable).
    An attempt is one token, right or wrong: never give the nonce back, and never verify
    before taking it (two requests at once would be two sessions).
  - **Every refusal of a token is `auth.invalid_credentials`**, with one fixed word in
    the log (`nonce_used`, `invalid_token`, `invalid_profile`) and nothing of the token.
    **Keys that could not be had are `service.unavailable`, however they failed** (no
    answer in time, a failed request, a status that is not 200, a body that is no key
    set: `keysForHandedOverToken`, which decides by "the key set threw, and not for a
    missing key", never by an error's kind), and the nonce stays spent. A key the fetched
    set does not have, and a token that names none (refused before the keys are asked
    for), are `invalid_token`; a token `jose` refuses before it asks for a key causes no
    request. The browser's code flow keeps its own classification (only a timeout is
    `unavailable`; `adapters.test.ts`): never change one to match the other without ADR
    0045's argument. What
    `OAuth.resolveAccount` refuses for the account keeps its own code, as in a browser.
    No ID token, and no part of one, is stored or logged.
  - **The mock mints tokens at `POST /v1/dev/oauth/id-token`**, behind the mock's own
    gates and stricter than its consent page (a loopback `Host`, no `Origin`, no
    cross-site `Sec-Fetch-Site`; not in the OpenAPI document). Its tokens are sealed, not
    JWTs: the signature check is the adapter's own tests'. Never loosen the route, and no
    test makes a request to Google.
  - In `tula.config.ts`, `providers.google.additionalClientIds` left out is **none, and
    managed** (not unmanaged, as `appLinkPaths` is: a kept id is an app still trusted by
    a file that no longer says so); `apply` sends the key only when the file names one.
  - **Apple's audiences are the bundle IDs of the environment's registered iOS apps, read
    when the token is judged** ([ADR 0047](../../docs/adr/0047-native-apple-sign-in.md);
    `appleIdTokenAudiences`: iOS rows whose identifier is a bundle ID by the contract's
    pattern). Never the provider's `clientId` (the Services ID is the web flow's), never
    a list on the provider, never a cached copy: a removed app's audience goes with the
    removal, for an attempt under way too. An app's team is not checked (a token names
    none). **With no iOS app there is no method**: `OAuth.requireIdTokenAudiences`
    answers `auth.method_disabled` at the start (after `OAuth.credentials`, before the
    ceiling and before an attempt is made, so the answer never depends on who signs in)
    and at the exchange (before the ceiling and the nonce, so nothing is used up). Keep
    it answering exactly as "Apple is off" does (a side-by-side test holds it), and keep
    the provider record the switch: `OAuth.credentials` on both steps, as for every
    provider.
  - **Apple's nonce has one accepted spelling**: the token's `nonce` is the lowercase
    hexadecimal SHA-256 of the attempt's nonce (`appleNonceClaim`), compared as one
    string in constant time. The raw nonce, upper case, base64, no `nonce`, and
    `nonce_supported` `false` (the boolean or the string) are refused
    (`appleNativeIdTokenProfile`, which the mock shares). The hash is the **app's** to
    take: the mock echoes the nonce it is given, `@tula/core` does not hash, and the
    conformance runner plays the app (`nonceSha256`). Never accept a second form, and
    never hash on the app's behalf in the mock or the client.
  - **Apple's token gives no name**: `appleNativeIdTokenProfile` reads none from it,
    whatever it carries. The exchange's `givenName` / `familyName` are read for Apple
    only, cleaned by the web flow's `displayName`, and **name a new account and nothing
    else**: never rename an existing user from them, never let them take part in which
    account is signed in, and never put them in an event, an audit entry or a log line.
    A Google exchange ignores them.
  - **A token's path decides nothing about the account.** Apple's rows of the linking
    table hold for the browser flow and the native one alike: a known `sub` signs in
    with no address, an unknown one with none is `oauth.email_missing`.
- "At least one sign-in method" counts enabled providers: `Settings.replace` and the provider
  routes enforce it, not the settings schema.
- **The accounts that depend on a provider are counted before it goes, and the count is a
  number and nothing else** ([ADR 0059](../../docs/adr/0059-email-for-accounts-without-one.md)).
  An account depends on a provider when it has it connected and `OAuth.canStillSignIn`
  says no with that provider taken out of the enabled ones: never a second definition of
  "a way to sign in". The count is `users.countDependentOn` (both adapters, the shared
  suite), bounded by the contract's `DEPENDENT_ACCOUNTS_SCAN_LIMIT`; past it the answer
  says `more` and every surface says "at least". `GET
  /v1/admin/oauth-providers/:provider/dependents` answers `{ provider, accounts, more }`:
  never an id, an address or a name, there, in an audit entry, an event or a log line.
  **Switching off or removing a provider accounts depend on is a weakening, not a
  refusal** (`oauthProviderWeakenings`, the path `enabled`): `OAuth.update` and
  `OAuth.remove` count again under the `sign_in_methods` lock and record
  `dependentAccounts` (and `dependentAccountsIncomplete` for a cut scan), the dashboard
  reads the count and asks first, `tula diff` prints it and `tula apply --yes` refuses
  without `--allow-weaker`. Turning it into a refusal is the owner's decision; the count
  is already taken in the write's lock for it. **A count `tula` could not read is never a
  count of none and never "not judged"**: only a server from before the route
  leaves a plan unjudged (`null`), and it is known by the API's own answer for an unknown
  route and nothing else (`isUnknownRoute`: a 404 in the contract's envelope with
  `resource.not_found`; never by the status alone, a proxy's or an access wall's 404 or
  405 is `'unread'`); a refusal, a limit, a failure, no answer and an answer
  that is no count are `'unread'` (`readDependents`), handed to the contract's rule as a
  floor of none (`{ accounts: 0, more: true }`: no rule of the CLI's own), so the path is
  in `plan.weakened` and `apply --yes` needs `--allow-weaker`; the diff says it in fixed
  words with nothing of the failure. Never widen the set of statuses that mean "no
  count". `@tula/mcp`'s draft tool does not judge the weakening (it never reads the
  count, and no operation is added to `READ_OPERATIONS` for it): a draft that takes a
  provider from on to off says so in one constant entry of `notes` (no name, no number),
  because `weakens: false` would otherwise read as "nobody is locked out".

## An email address for an account without one (`modules/email-address`, see ADR 0059)

- **The user's two routes are for an account with no address, and only that**
  (`POST /v1/client/me/email`, `…/verify`, behind `requireRecentAuth()`). A user who has
  one, verified or not, is `email.already_set` before anything is counted, sent or spent.
  Changing an address is a decision of its own, not an extension of these routes.
- **The address is stored only by confirming a code, with its activity, in one
  transaction** (`users.addEmail`, `user.email_added`). Asking stores nothing on the user:
  the pending address is the verification token's (purpose `email_addition`, a keyed hash
  that covers the user and the normalised address), and a token of another purpose is
  never honoured here, nor this one anywhere else. The unique key decides two users who
  proved one address: the loser is `verification.expired`, its code spent.
- **A taken address is answered and limited like a free one.** The request looks every
  address up, answers the same receipt, emails the taken address a notice with no code
  (`email_in_use`) and stores a decoy no code matches, so the verify step answers
  `verification.invalid_code` as for a wrong code. Never answer, limit or word the two
  apart; keep the side-by-side test in `modules/email-address/router.test.ts`.
- **The order of the verify step is fixed**: the user exists, is not banned and has no
  address; nothing pending is `verification.expired`, uncounted; the guess is counted
  under `EmailAddress.codeLockKey` (a per-user key **of its own**, never the step-up key:
  anyone with a session can succeed here with their own inbox, and a success clears the
  key); the code is checked; the address is stored. The limits are per user (a minute's
  cooldown, `EMAIL_ADDITION_EMAILS_PER_HOUR`) and per address under a keyed hash
  (`EMAIL_ADDITION_EMAILS_PER_ADDRESS_PER_HOUR`), never the address itself in a key.
  **`<UserProfile>`'s "Email address" section is drawn only for an account with no
  address** (`components/email-address.tsx`): no rule of its own, every call through
  `useStepUp`, words that never say a code was sent, keyed by the session id. A declined
  step-up is not an error. Its browser test is `e2e/tests/email-address.spec.ts`.
  **The `email_added` notice says only what holds in every environment**: never that the
  address can sign in (a setting decides), and its closing tells the reader to set a new
  password for the address, not to reset one the account does not have.
  **The per-address budget is spent by whoever names the address, and that is accepted**:
  one address-less account can make an address's owner wait up to an hour to add it
  (`rate_limited`), and nothing else (the key is this purpose's own: no sign-in code or
  reset is spent). Never word the limit as protecting the owner from that, and never drop
  it to spare the wait (any number of accounts could then mail one inbox). A router test
  pins the cost.
- **An administrator's address is stored unverified, and never replaces one**
  (`Users.setEmail`, `PUT /v1/admin/users/:userId/email`): `email.already_set` for a user
  who has one, `resource.conflict` for an address another account holds, no session ended,
  nothing emailed, `user.email_added` with `method: 'admin'`, `verified: false`. Never
  let an administrator's word mark an address verified: automatic linking and the emailed
  step-up trust that flag.
- **Nothing here merges accounts or asks for an address in a sign-up.** Both are designed
  in ADR 0059, Part B, and are decisions for the product's owner: do not build either as
  an addition.

## Security rules (non-negotiable)

- **An OAuth callback proves nothing by itself.** `state` is single use and consumed before
  the code exchange; the callback sets no cookie and returns no token, only a 60-second,
  single-use ticket in the URL fragment of an allow-listed page. The ticket is honoured only
  with the binding the starting browser was given (`oauth.different_browser` otherwise, with
  nothing completed): that is what stops login CSRF. OAuth is a **first** factor: the exchange
  goes through `Factors.requiredFor` like every other.
- **A provider account is linked to an existing user automatically only when the provider
  asserts the address verified and the Tula address is verified too.** Otherwise
  `oauth.account_exists`, and never for an unverified provider address (refused before any
  lookup). A known identity is its user whatever email the provider reports. Removing a user's
  last way to sign in is refused. Never add a path that attaches an identity outside
  `OAuth.resolveAccount` / `OAuth.link`.
- **No provider token is stored or logged**, and provider credentials are sealed and never
  returned. Identity changes are audited (`user.identity_linked`, `user.identity_unlinked`)
  and announced to the owner (`notifications.identityChanged`).
