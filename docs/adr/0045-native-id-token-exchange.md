# ADR 0045: Native sign-in by a provider's ID token

- **Status:** accepted
- **Date:** 2026-10-10
- **Ticket:** TULA-33 (phase 2)

## Context

A provider sign-in has so far been a browser's: the API sends the browser to the provider,
the provider returns a code to the API's callback, and the API exchanges it
([ADR 0026](0026-oauth.md)). A native app can do that through a browser tab and an app
link or a custom scheme ([ADR 0044](0044-app-link-and-custom-scheme-redirects.md)), but it
is not what Google's own SDKs do. Credential Manager on Android and Google Sign-In on iOS
show the system's account sheet and hand the app a **Google ID token** directly. There is
no redirect, no authorization code and no client secret in that exchange; the app's
backend is expected to verify the token and sign the user in.

This ADR decides how the API takes such a token. It is written for Google; the port leaves
room for Apple's native sign-in (TULA-47), which has the same shape.

### What Google's documentation says, and what it does not

Read for this decision, on 2026-10-10. Nothing below was observed against Google: no
credentials of a real project are in this repository, and no test makes a request to
Google.

| Claim | Source | Standing |
| --- | --- | --- |
| A backend verifies the token's signature with Google's keys, that `aud` is one of the app's client IDs, that `iss` is `accounts.google.com` or `https://accounts.google.com`, and that `exp` has not passed. | Google Identity, "Verify the Google ID token on your server side" | Documented. The guide does not mention `nonce` or `azp`. |
| `azp` is "the client_id of the authorized presenter", needed only when the party asking for the token is not its audience. | Google Identity, "OpenID Connect", the ID token's payload | Documented. |
| On Android the app asks with the **web** client ID (`setServerClientId`), and may set a nonce (`setNonce`), which is optional. | Android Developers, "Sign in with Google" for Credential Manager | Documented. That the token's `aud` is then the web client ID and its `azp` the Android client ID is stated by third parties (Auth0's documentation), not by the page read: **unconfirmed**. |
| On iOS `GIDConfiguration` takes `clientID` (the iOS client ID) and optionally `serverClientID`, described as returned as the audience. A nonce parameter exists since GoogleSignIn-iOS 9.0.0. | The GoogleSignIn-iOS reference and its release notes | Documented. That a token asked for **without** `serverClientID` has the iOS client ID as `aud` is inferred, not stated: **unconfirmed**. |
| Whether the nonce in the token is the string the app passed, or a hash of it. | Android's page generates a random string and passes it; nothing read says it is transformed. | Taken to be the string as passed. **Unconfirmed** for both platforms. |
| An SDK may hand back a cached token whose nonce is an earlier one. | Reports in third-party SDKs' issue trackers (Supabase, Capgo) | **Unconfirmed**, and if true such a token is refused here (below, "Accepted risks"). |

So two things are unknown that decide which tokens are accepted: which client ID is `aud`
on each platform, and how the nonce arrives. The design below does not depend on the
first (the operator lists every client ID whose tokens are theirs) and fails closed on the
second.

## Decision

### Two steps, one attempt

```
POST /v1/client/sign-ins/id-token              { provider }   → { attempt, nonce }
POST /v1/client/sign-ins/:attemptId/id-token   { idToken }    → the attempt's next step
```

The first (`startIdTokenSignIn`) starts an ordinary sign-in attempt, with the secret every
attempt has (`x-tula-attempt`), and a **nonce the server makes**: 32 random bytes, kept in
the attempt's state. The app hands the nonce to Google's SDK and brings back the token,
with the attempt's secret, to the second (`submitSignInIdToken`). The exchange takes the
token and nothing else: no audience, no nonce, no profile field comes from the request.

It is an attempt like any other. The start goes through the flow router's `clientContext`
(so a device key binds the session, [ADR 0043](0043-device-binding.md)), every step starts
with `load`, the account is decided by `OAuth.resolveAccount`, a second factor is asked
for through `Factors.requiredFor`, and the session is made only by `finish`. The
exchange and the browser flow's ticket exchange share the function that does all of that
(`completeProviderSignIn`); the two differ only in how the profile was obtained.

There is no redirect URL, no ticket and no browser binding: there is no browser. What the
binding does for a browser (a sign-in cannot be planted in someone else's session) the
nonce does here: a token is accepted only for the attempt whose nonce it carries, and only
by the holder of that attempt's secret.

### Native clients only

The start is refused for a client that is not `ios` or `android` (422
`validation.failed` on `x-tula-client`; no new error code). A browser has Google's
redirect flow, and "One Tap" on the web is a different product with its own CSRF rules:
not built here. The client kind is the client's own claim, as everywhere
([ADR 0044](0044-app-link-and-custom-scheme-redirects.md), "Client kind"): this is a
policy for honest clients and not a boundary. What bounds the exchange is the token.

### What a token must be

Verification is the adapter's, through the `OAuthProvider` port's new **optional** method
`verifyIdToken(credentials, { idToken, audiences, nonce })`. Only Google implements it; a
provider without it is not offered this sign-in (`ID_TOKEN_PROVIDERS` in the contract is
the closed list the request schema takes; the service checks the adapter again and
answers `auth.method_disabled` for one without the method). Google's adapter uses the verifier its code flow already uses, so the
two cannot drift:

- the signature, against Google's published keys, `RS256` only;
- `iss` one of Google's two issuers;
- `exp` (and `iat`, `sub` present);
- **`aud` is one string, and it is one of the environment's accepted client IDs**;
- **`azp`, when present, is one of them too**;
- **`nonce` is the attempt's, compared as a string in constant time**;
- the address is verified only when `email_verified` is the JSON boolean `true`.

A token with several audiences is refused: Google documents one, and "any of these is
ours" would accept a token minted for someone else that also names us. `azp` is checked
because the presenter is exactly the party an operator means to authorize by listing a
client ID; a token for our web client ID presented by a client ID nobody listed is
refused.

The adapter returns a profile and nothing else. **The token is not stored and not
logged**, nor any part of it; the one log line of a refusal holds the environment, the
provider and a fixed word (`nonce_used`, `invalid_token`, `invalid_profile`,
`unavailable`).

### The accepted client IDs are the operator's list

A Google project has one OAuth client ID per platform. The provider record already holds
the **web** client ID (with its secret, for the browser flow). It gains
`additionalClientIds`: the client IDs of the operator's Android and iOS apps.

- The accepted audiences are the record's `clientId` and its `additionalClientIds`, and
  nothing else (`OAuth.idTokenAudiences`). Because the documentation does not settle
  which ID is `aud` on which platform, the operator lists the IDs of every app that signs
  in; the server needs to know only that each is theirs.
- An entry has the shape of a Google client ID (`isGoogleClientId`:
  `<digits>[-<opaque>].apps.googleusercontent.com`, one spelling), each once, at most
  eight (`MAX_ADDITIONAL_CLIENT_IDS`). They are not secrets: every token carries its own.
- They live in the provider row's existing `config` JSON, beside Microsoft's `tenant`.
  **No migration.**
- The field belongs to Google alone; another provider is refused it.
- `PUT /v1/admin/oauth-providers/google` replaces the record, as it always has: **a
  request without the field stores none**. A client that does not know the field
  therefore removes the IDs when it saves the provider. That fails closed (native
  sign-ins stop; nobody gains anything), and the dashboard and the CLI of this version
  always send them.

### Adding a client ID is a weakening

Every accepted client ID is another app whose tokens sign users in. So a client ID
**gained** is a recorded weakening, by one function of the contract
(`oauthProviderWeakenings`), shared, as the others are, by the audit entry
(`weakened: true`), the dashboard's question and `tula apply --yes` (refused without
`--allow-weaker`, as `providers.google.additionalClientIds`). An ID taken away, and a
reordering, are not.

This is the same judgement as a fingerprint gained by an Android app
([ADR 0040](0040-native-app-identity.md)), and for the same reason. It differs from
Microsoft's `tenant`, whose widening is pinned as *not* a weakening (TULA-12): that
question is open with the owner, and this ADR does not answer it by analogy.

The audit entry and the `oauth_provider.updated` event name the field in `changed` and
carry a count (`additionalClientIdCount`, only when the field changed): never a client
ID. They are public, and still not ids the server made.

### Every refusal of a token is the same answer

At the exchange a token that is malformed, expired, signed by another key, made for
another app, carrying another nonce, or presented a second time is
`auth.invalid_credentials` (401). There is no code or parameter per reason; the reason is
the log's fixed word.

**The nonce is taken before the token is judged**, with a compare-and-set on the
attempt's state. So:

- a token presented twice for one attempt is verified once: the second finds no nonce;
- two requests at once with one token make one session;
- a wrong token spends the attempt: the right one afterwards is refused, and the app
  starts again. An attempt is one guess.
- a token replayed on **another** attempt carries the wrong nonce and is refused there.

What is not a refusal of the token keeps its own answer: an unknown or foreign attempt
(`flow.not_found`), a provider switched off between the two steps (`auth.method_disabled`,
asked at both, before the nonce is taken), and what `OAuth.resolveAccount` refuses for
the **account** (`oauth.account_exists`, `oauth.email_unverified`, `oauth.email_missing`,
`auth.user_banned`), exactly as in the browser flow. These are reached only with a token
that verified, so they tell a caller nothing a valid Google token for that address does
not already.

When Google's keys cannot be fetched in time the answer is `service.unavailable` (503),
not a failed sign-in: the token was not judged. The nonce is spent by then; the app starts
again.

### Limits

Both routes are behind `publishableKey()` and a per-IP limit of their own. The start is
counted under the environment's `oauth` ceiling and the exchange under `verify`, before
the nonce is taken, so a request the ceiling refuses leaves the attempt usable. There is
no lockout: there is no identifier and nothing guessable, as for a passkey sign-in.

### Account resolution is unchanged

A Google account is the token's `sub`, the same value the browser flow stores, so a user
who signed up in a browser signs in from the app and the other way round. Linking by
address follows the one table of `OAuth.resolveAccount`. Connecting Google to a signed-in
account from a native app is not built (the identity routes make a browser attempt).

### The mock provider mints tokens

`POST /v1/dev/oauth/id-token` (`OAUTH_MOCK_PROVIDER=true` only: `ENVIRONMENT=local` and a
loopback `PUBLIC_URL`, checked where the mock's other routes are) returns an ID token for
a given audience, nonce and address and, for the refusal tests, an `azp`, an address that
is not verified or an expiry in the past. The mock's tokens are sealed by the server, not Google-signed
JWTs: the mock adapter opens them and applies the **same** claim rules
(`nativeIdTokenProfile`) the real adapter applies after its signature check. The
signature, `RS256` and the key fetch are tested in the adapter's own tests with tokens
the tests sign.

The route is stricter than the consent page it sits beside: it refuses a request whose
`Host` is not a loopback name, any request with an `Origin`, and a cross-site
`Sec-Fetch-Site`, and it is not in the OpenAPI document. With the mock provider on, anyone
who can reach the API can already sign in as any address; this route does not widen that.

### `@tula/core`

```ts
const pending = await tula.signIn.withIdToken({ provider: 'google' })
const idToken = await askGoogle(pending.nonce)   // the app's own call to the platform
const flow = await pending.exchange(idToken)
```

`withIdToken` returns the nonce and a function; the attempt's secret stays in the closure
and is not in what the object serializes to. The token is sent once in a JSON body and is
kept nowhere. The start is one of the operations that carry a device proof (`PROVEN`). No
new error code. The package gains no dependency and stays portable: asking Google is the
app's job, with the platform's SDK.

### Config, CLI, dashboard, MCP

- `@tula/config`: `providers.google.additionalClientIds`. A set, sorted on load. **Left
  out means none, and is managed**: the file's list is the whole set. This is deliberately
  not the rule of a native app's `appLinkPaths` (left out is unmanaged, ADR 0044): there a
  kept path is no check missing, here a kept client ID is an app still trusted by a file
  that no longer says so. An empty list is dropped on load, so a file from before the
  field keeps its fingerprint.
- `tula diff` / `apply`: compared as a set, shown as what is added and removed, the stored
  secret kept, a gained ID in `plan.weakened`. The key is sent only when the file names an
  ID, so a file without one still applies to a server from before the field.
- Dashboard: one field on Google's card, always sent; a gained ID is asked about first
  (the contract's function decides), with the provider's name typed in production.
- `@tula/mcp`: `list_oauth_providers` names `additionalClientIds`. They are as public as
  `clientId`.

## Consequences

- An Android or iOS app signs in with Google's own sheet, with no browser tab, no redirect
  URL to allow and no client secret on the device.
- The session, its factors, its hooks and its events are those of any provider sign-in;
  `session.created` cannot tell the two apart, on purpose.
- An operator has one more list to keep. A client ID left off it is a sign-in that fails
  with the generic answer; `docs/providers/google.md` says where to look.

## Accepted risks

- **A token is a bearer credential until it is exchanged.** Whoever holds a valid token
  for the attempt's nonce and the attempt's secret completes the sign-in. Both are on the
  device that asked; the token lives an hour at most and is good here once.
- **A stale nonce fails closed.** If an SDK returns a cached token (reported, not
  confirmed), the sign-in is refused and the app has to ask again. That is the cost of
  requiring the nonce; accepting a token without one would make a token stolen from
  anywhere a sign-in for an hour.
- **A hashed nonce is not supported.** If a platform's SDK turns out to put a hash of the
  string in the token, every sign-in from it fails until the comparison is extended. Not
  guessed at now: a second accepted form is a second thing an attacker may satisfy.
- **The client kind is a claim.** A script that says `android` reaches the route. It
  still needs a token Google signed for one of the operator's client IDs and this
  attempt's nonce.
- **A client that does not know the field removes it** (above). Accepted because it fails
  closed.
- **One guess per attempt** means a transient mistake by the app (the wrong token) costs
  a fresh start. Starts are cheap and limited.

## What could not be verified

- Anything against Google. Which client ID is `aud` and which is `azp` on Android and on
  iOS, how the nonce arrives, and whether Google's keys endpoint behaves under the
  verifier's deadline as the code flow's tests assume.
- That `email_verified` is always a JSON boolean in a native token (the code flow has
  taken it so since ADR 0026).
- The console steps in `docs/providers/google.md`: written from the documentation, not
  clicked through.

Real Google therefore stays on the list of what is unverified; the provider page says so
at its top.

## Not decided here

- Native Sign in with Apple (TULA-47): the port's method is there for it; its audience is
  the app's bundle ID and its nonce is hashed, both decisions of that ticket.
- Google One Tap and the Google Identity Services button on the web.
- Connecting a provider to a signed-in account from a native app.
- Whether `auth.invalid_credentials`'s message, which speaks of an email and a password,
  should have a wording of its own for a provider sign-in. The code is right; the sentence
  is the SDK's table by code, shared with every other use.
- Whether the provider's own `clientId` should be held to Google's shape. It never has
  been, and existing rows must keep working.

## Alternatives considered

- **One step: post the token, no nonce.** Simplest for an app, and what the verification
  guide alone would suggest. Refused: a token copied from anywhere (a log, another backend
  the same app talks to) would be a sign-in for as long as it lives, and nothing would
  tie it to the device that asked.
- **A nonce the client makes.** Then the server has to remember every nonce it has seen,
  for an hour, across instances, to refuse a replay. The attempt already is that memory.
- **Accept any audience of the operator's Google project.** A token does not name its
  project; only its client ID.
- **Client IDs on the native app's registration** ([ADR 0040](0040-native-app-identity.md)).
  A native app is a bundle ID or a package and fingerprints, for the association files;
  a Google client ID is Google's name for an OAuth client, and one app can have several.
  Tying them would make a provider's setting depend on a table that is about something
  else, and an iOS app that signs in with Google but uses no passkey would have to be
  registered for nothing.
- **A setting in the environment's settings document.** Provider credentials are
  deliberately not part of it (ADR 0026).
- **Verifying through Google's `tokeninfo` endpoint.** A request to Google per sign-in,
  and Google's own guide recommends local verification.
