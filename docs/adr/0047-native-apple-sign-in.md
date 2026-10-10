# ADR 0047: Native Sign in with Apple by identity token

- **Status:** accepted
- **Date:** 2026-10-10
- **Ticket:** TULA-47 (phase 2)

## Context

[ADR 0045](0045-native-id-token-exchange.md) gave a native app a sign-in of two requests:
a start that answers an attempt and a nonce the server made, and an exchange that takes
the ID token the provider's own SDK handed the app. It was written for Google and left the
port's method (`verifyIdToken`) for Apple.

On iOS the system's Sign in with Apple sheet (`ASAuthorizationAppleIDProvider`) hands the
app an **identity token**: a JWT Apple signed. There is no redirect, no authorization code
and no client secret in that exchange. This ADR decides what the API accepts of such a
token. Everything ADR 0045 decided that is not named here holds unchanged: the two routes,
the nonce taken before the token is judged, one token per attempt, every refusal of a
token the one `auth.invalid_credentials`, keys that could not be had a 503 with the nonce
spent, the limits, and the shared tail that resolves the account.

### What Apple's documentation says, and what it does not

Read for this decision on 2026-10-10, from developer.apple.com, and from two documents
Apple serves: `https://appleid.apple.com/.well-known/openid-configuration` and
`https://appleid.apple.com/auth/keys`. **Nothing below was observed from a device or an
Apple developer account**: no credentials of a real team are in this repository, no test
makes a request to Apple, and no token Apple signed was ever verified here.

| Claim | Source | Standing |
| --- | --- | --- |
| The token's issuer is `https://appleid.apple.com`. | "Authenticating users with Sign in with Apple"; Sign in with Apple JS, the `id_token` object; the discovery document's `issuer` | Documented. |
| Apple's keys are at `https://appleid.apple.com/auth/keys`. | The discovery document's `jwks_uri` | Documented, and fetched: a key set of RSA keys, each with `alg: RS256` and a `kid`. |
| Tokens are signed with `RS256`. | The discovery document (`id_token_signing_alg_values_supported: ["RS256"]`) and the key set | Documented by the two served documents. The page "Verifying a user" speaks of a "JWS E256 signature", which is no algorithm; taken for a slip of that page. |
| A server verifies the signature, the nonce, that `iss` is Apple, that `aud` is the developer's `client_id`, and that `exp` has not passed. | "Verifying a user" | Documented. |
| `aud` is "the `client_id` from your developer account", and `client_id` is "the identifier (App ID or Services ID) for your app" and "must not include your Team ID". | The `id_token` object; "Generate and validate tokens" | Documented. **That a token the native sheet makes has the app's bundle ID as `aud` follows from the two sentences** (an App ID without the team prefix is the bundle ID) and from every third-party guide; no page read says it in one sentence. |
| `nonce` is "a string for associating a client session with the identity token", present only if the request passed one, and `ASAuthorizationOpenIDRequest.nonce` is "a string value to pass to the identity provider". | The `id_token` object; the AuthenticationServices reference | Documented. **Apple puts the string it was given into the token: it does not hash it.** |
| `nonce_supported` is a Boolean; "if this claim returns true, treat nonce as mandatory and fail the transaction" when it does not match. | The `id_token` object | Documented. What a token looks like where it is `false` (an old system version) was not found. |
| `email_verified` and `is_private_email` are each "a string or Boolean value": `"true"` or `true`. | The `id_token` object | Documented. |
| A private relay address ends in `@privaterelay.appleid.com` (the pages read also name `@private.icloud.com` and `@icloud.com`); a user of a managed Apple account may have no address at all. | Apple's Sign in with Apple documentation ("Authenticating users with Sign in with Apple" and the pages it links) | Documented. |
| **The user's name is not in the identity token.** The sheet gives it to the app (`ASAuthorizationAppleIDCredential.fullName`) on the first authorization only. | "Authenticating users with Sign in with Apple" ("the raw data is passed directly to your app … and is not included in the user's identity token") | Documented. |
| The token of a later sign-in still carries the email address. | The same page ("Apple provides the user's email address in the identity token on all subsequent API responses") | Documented. Third-party reports say an address is sometimes absent later; the design does not depend on which is true. |
| `sub` is stable for a user within one developer team, and differs between teams. | The `id_token` object; "Authenticating users" | Documented. |
| The app hashes the server's nonce with SHA-256 and passes the hexadecimal digest to the sheet; the server compares the token's `nonce` with its own hash of the raw value. | Firebase's and Supabase's guides, and the libraries built on them | **A convention, not Apple's.** Apple echoes whatever string it is given. Some React Native libraries hash for the app without saying so. |

So the claims the verification rests on are documented, and two things are not Apple's:
that the audience of a native token is the bundle ID (an inference every implementation
shares), and the hashed nonce (a choice, made below).

## Decision

### Apple is an ID-token provider, for iOS clients only

`ID_TOKEN_PROVIDERS` is `['google', 'apple']`. Which clients may start the sign-in is per
provider (`ID_TOKEN_CLIENT_KINDS` in the contract): `ios` and `android` for Google, **`ios`
alone for Apple**. An `android`, `web` or `server` client that names Apple is refused the
start with `validation.failed` on `x-tula-client`, before anything is looked up, as an
unsupported client always was. Sign in with Apple on Android is a browser's (the code
flow, [ADR 0026](0026-oauth.md)); nothing here changes that flow.

The client kind is the caller's claim, as everywhere. A script that says `ios` reaches the
route and still needs a token Apple signed for a registered bundle ID and this attempt's
nonce.

### The audience is the bundle ID of a registered iOS app

A token is accepted when its `aud` is the bundle ID of one of **the environment's
registered iOS native apps** ([ADR 0040](0040-native-app-identity.md)), read when the
token is judged (`OAuth.idTokenAudiences`, one `nativeApps.list`). Not the provider's
`clientId`: that is the Services ID, which names the web sign-in, and a token for it was
made by the browser flow and belongs to that flow's callback. Not a list on the provider:
the operator has already told the server which iOS apps are theirs, and a second list
would be a second place to forget.

This is the one thing built on a native app's registration beyond the association files
and the passkey origin. It reverses, for Apple, an alternative ADR 0045 refused for Google
("client IDs on the native app's registration"). The reasons there do not carry over: a
Google client ID is Google's name for an OAuth client and one app has several, where
Apple's audience **is** the app's own identifier, the very string the registration holds.

- **Removing an app takes its audience away at once**, for an attempt under way too: the
  exchange reads the apps again. Nothing is cached.
- **A row is an audience only when it is an iOS row whose identifier is a bundle ID** by
  the contract's pattern (`appleIdTokenAudiences`). An Android app's package name, another
  environment's app and a malformed row are none.
- **The team is not checked.** A token names no team, so there is nothing to compare an
  app's `teamId` with. What ties a token to the operator is that Apple issues a token for
  a bundle ID only to an app signed for the team that owns that App ID. The provider's own
  `teamId` (for the web flow's client secret) and an app's are not held equal either:
  nothing reads both. One consequence is the operator's to know: **`sub` is per team**, so
  the web flow (a Services ID of team A) and an app of team B are different Apple accounts
  to this server. Group the Services ID with the app's App ID, as Apple's setup does.

### With no iOS app there is no method

Apple with its provider record enabled and **no registered iOS app** has nothing a token
could be for. `OAuth.requireIdTokenAudiences` answers `auth.method_disabled`
(`params.method: 'oauth_apple'`), exactly as a provider that is switched off:

- at the **start**, after `OAuth.credentials` and before the environment's ceiling is
  counted or an attempt made, so the answer depends on the environment alone and never on
  who is signing in;
- at the **exchange**, after `OAuth.credentials` and before the ceiling and the nonce, so
  an app removed mid-attempt uses nothing up: the same attempt and token complete once an
  app is registered again.

Where another iOS app is still registered the method is on, and the removed app's token is
a token for an audience that is not accepted: `auth.invalid_credentials`.

**The provider record stays the switch.** `OAuth.credentials` is asked on every step, as
for every provider, so native Sign in with Apple needs Apple configured and enabled
(a Services ID, team, key ID and key) even for an operator who never uses the web flow.
The verification itself reads none of the four. This keeps one switch per provider and one
function that says whether a provider is on; see "Not decided here".

### Registering an iOS app now widens who can sign in

Registering an app was already a recorded weakening (`nativeAppWeakenings`: the audit
entry's `weakened`, the dashboard's question, `tula apply --yes` needing
`--allow-weaker`). The rule does not change; what it stands for does, and the words say
so: the dashboard's question for an iOS app adds that, where Sign in with Apple is on, the
server will accept Apple's identity tokens issued for the bundle ID, and its removal
dialog that Sign in with Apple from the app is refused at once. `docs/native-apps.md` and
`docs/config.md` say the same of a registration made through the API or a config file. A
change of an iOS app's team stays a weakening for the association file and means nothing
for this sign-in.

There is no new weakening path and no new event field: `native_app.created` already says
what it must, and an identifier is in no event.

### The nonce is hashed by the app, and one spelling is accepted

The start answers the server's nonce, as for Google. **The token's `nonce` must be the
lowercase hexadecimal SHA-256 of that nonce's UTF-8 bytes** (`appleNonceClaim`): the app
takes the hash and hands it to the sheet as `ASAuthorizationAppleIDRequest.nonce`, Apple
echoes it into the token, and the adapter compares the claim with its own hash of the
attempt's nonce, as one string, in constant time. Exactly 64 characters, `0-9a-f`.

- **The raw nonce in the token is refused.** So are upper-case hexadecimal, base64 and any
  other encoding of the right digest. A second accepted spelling is a second thing an
  attacker may satisfy, and an app that sends the raw value has skipped the step that
  keeps the server's nonce out of what Apple and the device's logs see.
- **A token with no `nonce` is refused**, and so is one whose `nonce_supported` is `false`
  (the Boolean or the string). Apple says a token from a system that does not support the
  nonce cannot be tied to a request; such a sign-in fails here and the web flow remains.
  An absent `nonce_supported` is accepted: the nonce's own match is the check, and the
  claim adds nothing to a token that carries the right one.

Why hash at all, when Apple documents no hash: the convention is what existing iOS code
and every guide an integrator will read does, and it means the value the server later
compares against never leaves the server and the app in the clear. The cost is that an app
must hash, and that a library which hashes on the app's behalf would hash twice; the
provider page says so.

### What a token must be

Verified by the real adapter (`adapters/oauth/apple.ts`, `verifyIdToken`) with the same
verifier as the code flow's ID token (`createIdTokenVerifier`: `RS256` only, issuer
`https://appleid.apple.com`, Apple's key set, the expiry, a `kid` required), told that the token was handed over (`handedOver: true`, so that
keys which could not be had are `unavailable` and not a refusal), and then judged by
`appleNativeIdTokenProfile`:

- `aud` one string, among the accepted bundle IDs; an `azp`, if there is one, among them
  too (`nativeIdTokenProfile`, shared with Google);
- `nonce` as above;
- `sub` a non-empty string: the account;
- the address from `email`, verified only when `email_verified` is `true` or `"true"`
  (`emailClaims`, the code flow's own reading);
- **no name from the token**, whatever it carries.

Every failure is `auth.invalid_credentials` to the caller and a fixed word in the log.

### The name travels beside the token, unsigned

Apple's token has no name, and the sheet hands one to the app once. So the exchange's body
is `{ idToken, givenName?, familyName? }` (strict; at most `MAX_ID_TOKEN_NAME_LENGTH`
characters each), which amends ADR 0045's "the token and nothing else". The two fields:

- are **read for Apple only** (a Google token has its own, signed; names sent beside one
  are ignored);
- go through the same `displayName` cleaning as the web flow's `user` form field, which is
  equally unsigned;
- **name a new account and nothing else**: an existing user is never renamed by them, and
  they take no part in which account is signed in;
- are in no event, audit entry or log line.

A user can type any name into a sign-up form too. What matters is that nothing is decided
by it.

### Account resolution is the web flow's

The profile goes to `completeProviderSignIn`, and so through `OAuth.resolveAccount` and
`Factors.requiredFor`, as the ticket exchange does. Nothing is keyed by how the token
arrived:

- a known `sub` is its user, with or without an address in the token;
- an unknown `sub` with no address is `oauth.email_missing`; with an address Apple does not
  vouch for, `oauth.email_unverified`;
- a verified address with a verified account is linked; with an unverified account,
  `oauth.account_exists`;
- a private relay address is an address.

The linking table (`modules/oauth/linking-table.test.ts`) is stated per provider and
already has Apple's rows; they hold for both paths.

### Keys that could not be had

As ADR 0045: a 503 `service.unavailable`, the nonce spent, the app starts again. A token
with no `kid`, another `alg` or an unknown `kid` is `auth.invalid_credentials`, and the
first two cost no request.

### The mock provider mints Apple-shaped tokens

The existing route (`POST /v1/dev/oauth/id-token`, the same guards) takes
`provider: 'apple'`: the token then has `nonce_supported: true`, `email_verified` and
`is_private_email` **as strings** (a private relay address by its suffix), and no name
whatever is asked. **The mock echoes the nonce it is given**, as Apple does; whoever plays
the app hashes. It is judged by `appleNativeIdTokenProfile`, the real adapter's function.

### `@tula/core`

```ts
const pending = await tula.signIn.withIdToken({ provider: 'apple' })
const idToken = await askApple(sha256Hex(pending.nonce)) // the app's call to the sheet
const flow = await pending.exchange(idToken, { givenName, familyName })
```

`exchange` takes the name as an optional second argument. **The client does not hash**:
`pending.nonce` is the server's value for both providers, and the JSDoc says what Apple
needs. Hashing in the client would need `crypto.subtle`, which React Native's Hermes does
not have, or a SHA-256 of its own, which the bundle budget has no room for (23 bytes are
left after this change's 5); an app has its platform's hash one line away (CryptoKit,
`expo-crypto`). No new error code.

### The conformance runner

An `idToken` step may say `nonceSha256` instead of `nonce`: the runner takes the hash, as
an app does, and asks the mock for a token with it. A variable may be generated as
`p256_private_key`, a throwaway PKCS#8 key for the provider's record, so that no key is
written in a scenario file. Scenarios 104 to 107 change no environment setting.

## Consequences

- An iOS app signs in with the system's sheet: no browser tab, no redirect URL, no client
  secret on the device.
- Registering an iOS app is no longer only about the association files. An operator who
  registered one for passkeys, and has Apple enabled for the web, now also accepts Apple's
  tokens for that bundle ID. That is what registering an app has always claimed (the app
  is theirs), and the question asked at registration now says it.
- An operator with a native app and no web sign-in still configures Apple's provider
  record.
- The session, its factors, hooks and events are those of any provider sign-in.

## Accepted risks

- **The hashed nonce is a convention.** An app that passes the raw nonce, or whose library
  hashes a second time, is refused with the generic answer; the server's log says
  `invalid_token` and the provider page lists the cause first.
- **`nonce_supported: false` is refused.** A device old enough to say so cannot use this
  sign-in.
- **The name is unsigned**, as on the web.
- **An existing registration gains a meaning.** An environment that had an iOS app and
  Apple enabled before this change accepts identity tokens for that app after it, with no
  new act by the operator. Accepted because the app was registered as the operator's own,
  which is the only claim the audience rests on; called out in the changeset.
- **One list read per step.** The start and the exchange each read the environment's
  native apps (at most 20 rows).
- Everything ADR 0045 accepted: a token is a bearer credential until exchanged, a stale
  nonce fails closed, the client kind is a claim, one guess per attempt.

## What could not be verified

- Anything against Apple: that a native token's `aud` is the bundle ID, that the nonce
  arrives as the app passed it, the types of `email_verified` and `is_private_email` in a
  native token, whether a later token carries the address, what `nonce_supported` is on
  which system versions, and that Apple's keys endpoint answers inside the verifier's
  deadline.
- Any iOS app: no `ASAuthorizationAppleIDProvider` request was made, on a device or a
  simulator. The Swift and Expo SDKs do not exist yet.
- The console steps in `docs/providers/apple.md`.

Real Apple is therefore on the list of what is unverified
([docs/plans/phase-2-unverified.md](../plans/phase-2-unverified.md)), and the provider
page says so at its top.

## Not decided here

- **Whether native Sign in with Apple should need the provider's web credentials.** Today
  the provider record is the switch. A switch of its own, or a record that may hold no
  Services ID, is a change to what "Apple is configured" means everywhere.
- Apple's server-to-server notifications (consent revoked, account deleted, relay
  forwarding changed) and the revocation of Apple's tokens when an account is deleted,
  which App Store Review asks of apps.
- Connecting Apple to a signed-in account from a native app.
- Giving an account that began with no name the name of a later sign-in.
- Sign in with Apple JS on the web, and Sign in with Apple on Android other than through
  the browser.

## Alternatives considered

- **Accept the raw nonce as well as the hash.** Friendlier to an app that forgot. Refused:
  two spellings, and the looser one is the one that leaks the server's value.
- **Accept only the raw nonce, as for Google.** Apple's own documentation asks for no
  hash. Refused because every existing integration hashes, and an integrator following
  any guide would be refused.
- **Hash inside `@tula/core`.** Refused for the bundle and for Hermes (above).
- **The provider's `clientId`, or a list on the provider, as the audience.** The Services
  ID is not what a native token is for, and a list repeats what the registration says.
- **Refuse the start with `validation.failed` when no iOS app is registered.** It is not
  the request that is wrong; the method is not available in this environment, which is
  what `auth.method_disabled` means and what a client already draws.
- **Read the name from the token if a future token carries one.** Not guessed at.
