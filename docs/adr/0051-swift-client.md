# ADR 0051 — The Swift client: flows and the session, by `@tula/core`'s rules

- Status: accepted
- Date: 2026-10-12
- Extended: 2026-10-12, by TULA-56 ("Passkeys, providers, a device key and the second step")

## Context

Step 2.14 of [the plan](../plans/phase-2.md) is a Swift SDK. Its types are generated
([ADR 0050](0050-native-type-generation.md)); this record is the first hand-written part
(TULA-37): a client with no screen that signs a user up, signs them in with a password or an
emailed code, resets a password, and keeps and refreshes the session. Passkeys, a provider's
ID token, provider sign-in through a browser, device binding, the second step and a step-up
came with TULA-56 and are the section "Passkeys, providers, a device key and the second
step" below: the same decision record, because they are the same client held to the same
rules. The SwiftUI screens are not here: the first of them (TULA-49) are a second library
of the package and [ADR 0057](0057-swiftui-screens.md); the rest are TULA-60.

The behaviour was not open. `@tula/core` ([ADR 0021](0021-core-sdk.md)) already says what a
client does between requests, the conformance scenarios say what it must observe, and
`conformance/client-journeys.json` has a column for it. What had to be decided is how those
rules are held in Swift, where the refresh token is kept, and how a suite written in XCTest
is checked against a list whose checks are TypeScript.

## Decision

### One package, no dependency, an `ios` client

`native/swift` is one library, `TulaAuth`, on Foundation, Security, CryptoKit and
AuthenticationServices: frameworks of the system, and no package. The floor is iOS 16 and macOS 13 (`Package.swift`); macOS is there because
that is what `swift test` runs on. The client is an `ios` client to the API and that is not
an option: `x-tula-client: ios` is written in one place, so its tokens come in response
bodies, it is never given a stateful session, and a `web` rule never applies to it.

It takes a publishable key and refuses anything else at construction. Every refusal of the
constructor (`TulaConfigurationError`) is a fixed sentence that repeats nothing it was
given: an app shows such an error on a setup screen.

### The session is `@tula/core`'s, rule for rule

`TulaSession` is an actor, and its rules are the session manager's of ADR 0021:

- The access token is in memory only. The refresh token is in memory and in the client's
  storage, under the key `tula.refresh.<base URL>|<publishable key>`.
- **One refresh at a time.** Calls that need a token at the same moment await one task.
- **A refresh the server refuses for the session ends it once** (`session.*`,
  `auth.unauthenticated`, `auth.user_banned`). **Anything else keeps it**: offline, a
  timeout, a rate limit, a storage that fails. A stored token is never removed for a failure
  that is not a refusal.
- **A refresh gives up inside the server's grace window**: `TulaSession.refreshTimeout` is 8
  seconds, whatever timeout the client was given, below the smallest
  `refresh.reuseGracePeriod` an environment can set (10 seconds). A unit test holds the
  number equal to `@tula/core`'s.
- **A refresh that got no answer is repeated once, at once**, with the same token, inside
  the same single flight. An HTTP answer of any status is never repeated. It is the only
  request the client repeats by itself.
- Every change of session bumps a generation, and the result of an older one is never
  installed: a refresh that finishes after a sign-out signs nobody back in.
- **A failed sign-out is not a sign-out for the server.** The client forgets its tokens
  first and then tells the server; when the server could not be told, `signOut()` throws,
  the state is `signedOut`, and the token it could not revoke is kept (in memory, never in
  storage) so that the next `signOut()` tries again.

The deadline of a request does not rest on the transport honouring cancellation: the request
and a timer race, and the caller gets `network.timeout` when the timer wins, also from a
transport that ignores `Task.cancel`. A refresh that "gives up in time" only because
`URLSession` happened to cancel promptly would be a property of the transport, not of the
client.

### The refresh token is in the Keychain, on this device, behind a protocol

`TulaTokenStorage` is three functions (`get`, `set`, `remove`). `KeychainTokenStorage` is
the default: a generic-password item of the data-protection Keychain, never synchronizable,
in one of two accessibility classes that never leave the device
(`WhenUnlockedThisDeviceOnly`, the default, or `AfterFirstUnlockThisDeviceOnly`: a closed
pair). `MemoryTokenStorage` is for tests and previews.

**A Keychain that fails is not "signed out".** The adapter throws for every answer but
"found" and "no such item"; the session reports `storage.failed` and stays as it was (a
session whose token could not be read stays `loading` and is asked again by the next call).
Turning a failed read into `nil` would sign a user out for a locked device. Nothing is
cached in the adapter and nothing is written anywhere else: not user defaults, not a file.

**"The session is kept" is true of the running app only.** A refresh whose new token could
not be written reports `storage.failed` and goes on with the token in memory; the Keychain
holds the one the server has replaced. The write is not tried again by itself (the next
refresh that succeeds writes its own token), so an app ended then and started past the
grace window is signed out by the server (`session.reuse_detected`). `@tula/expo` retries a
refused write on a timer; that was not built here, and adding it is a decision (a late
write must never land over a sign-out or a newer token). `signOut()` removes the stored token also
when it could not read it: a token it never read must not sign the next start in.

The Keychain calls sit behind an internal seam (`KeychainItems`), so the adapter's logic
(update, then add; what each status becomes) is unit-tested on a fake. **No test asks a
real Keychain**: a command-line test bundle has no entitlement for the data-protection
Keychain. That the adapter works against the real one is not shown, and
`docs/plans/phase-2-unverified.md` says so.

### A flow is the server's step, and a screen is what this version can do with it

A flow (`SignUpFlow`, `SignInFlow`, `PasswordResetFlow`) holds the attempt's id and its
secret, sends the secret on every call after the start (`x-tula-attempt`), runs one action
at a time (`flow.busy` for a second), and can be discarded: the secret is forgotten and the
answer of an action still in flight signs nobody in.

`FlowStep` is the generated, open union: a status this version does not know decodes and is
kept whole. `FlowScreen` is the client's reading of it: `password`, `firstFactor`,
`emailVerification`, `newPassword`, `secondFactor`, `factorEnrolment`, `complete`, or
**`notSupported(status:)`** for a status it does not know, a reason it does not know, and a
step that offers only ways it cannot take (a second factor that is a texted code alone, or
a passkey alone on a client that was given no passkey sheet). Never an error,
never a guessed request.

**An emailed code is the only first factor besides the password, and that is structural**:
`prepareEmailCode()` and `attemptEmailCode(_:)`, not a call that takes a strategy. There is
no call that asks for an emailed link (the server honours one only in the client that asked,
with a binding and a page this client does not have) and none for a texted code, so neither
can be asked for and left unprovable. A first draft took the strategy as a parameter and
refused the link with `storage.failed`, as `@tula/expo` does; it was taken out because it
also let an app ask for a text message this version cannot prove.

### An error is its code

`TulaError` carries the server's envelope (`code`, `status`, `message`, `params`, field
errors, `retryAfter`) or one of the codes of the client's own with status 0
(`network.failed`, `network.timeout`, `response.invalid`, `storage.failed`, `flow.busy`,
and with TULA-56 `device.key_failed`, `passkey.unsupported`, `passkey.already_on_device`,
`passkey.failed`, `provider.unsupported`, `provider.failed`).
`code` is the string as sent, with `known` as the generated `ErrorCode`: a code the server
gained after the app shipped is still an error an app can show by its message. It holds no
underlying error and prints only its code and status: a `URLError` can quote a URL, and the
generated types print what they hold.

The client logs nothing. A redirect is never followed (the answer is handed back as it is),
the `URLSession` is ephemeral with no cookie store, cache or credential store, and a path
parameter that is not one path segment is refused before any request.

### Passkeys, providers, a device key and the second step (TULA-56)

**The system is behind four protocols, and an app hands the client each one it wants.**
`TulaPasskeySheet`, `TulaAppleSheet`, `TulaBrowserSession` and `TulaDeviceKeyStore`, with
the system's own behind them (`SystemPasskeySheet`, `SystemAppleSheet`,
`SystemBrowserSession` on AuthenticationServices; `KeychainDeviceKeyStore` on the Secure
Enclave). All four default to `nil`. A client without one refuses the feature with a code
of its own (`passkey.unsupported`, `provider.unsupported`) before any request, and a client
without a key store binds nothing. Rejected: defaulting to the system's adapters, which
would let a unit test put a sheet up by forgetting an argument, and would bind every
session of an app that never asked for it (a profile with `deviceBinding: none` then
refuses the app's sign-ins).

**A ceremony's result says whether the user went through with it.** A call that shows a
sheet returns `TulaCeremony<Value>` (`finished(value)` or `dismissed`), and a provider
round trip returns `ProviderOutcome` (`signedIn`, `needsStep`, `linked`, `cancelled`,
`refused(reason)`). A dismissed sheet and a closed browser are values, never a thrown
error and never a sign-in: nothing was sent to prove anything, and the call works again at
once. `@tula/core` throws `passkey.cancelled` for the same thing and lets its callers sort
it; in Swift the type does the sorting, so an app cannot show a dismissal as a failure by
catching too widely. What a sheet fails with is one of four fixed words
(`TulaSheetError`), read from the framework's error by domain and code alone: the
framework's own text is never kept, in an error or anywhere else.

**One sheet at a time for a whole client** (`CeremonyGate`). A second ceremony while one
is out is `flow.busy` before any request: never joined (its answer would be for another
challenge) and never queued. The place is kept for at most five minutes (the lifetime of a
challenge); a sheet that answers later is dropped. Nothing of a ceremony is kept: not the
options, not the credential.

**What holds a secret prints as its type's name** (`TulaRedacted`: `print`, interpolation,
`String(reflecting:)` and `dump` alike). The client, the session, a flow, an ID-token
sign-in, a ceremony's result, a provider's outcome, Apple's credential, the results that
carry backup codes, `MemoryTokenStorage`, and inside the package the proofs, the round
trip's binding, ticket and read answer, a software key and the private values that hold a
token or an attempt's secret on the way. The mirror suppresses the superclass as well
(`ancestorRepresentation: .suppressed`): by default `dump` of a subclass prints what the
redacted class it inherits from holds. A ceremony and an outcome say which case they are, which an app may
log. The generated types are the exception ADR 0050 states: a `SessionTokens` or a
`TotpEnrolment` prints what it holds, and so does `FlowSnapshot`, which is a generated step
and its screen. One table test runs every redacted type it can name (a private one
conforms and has no row).

**A provider's ID token is exchanged in two steps, and the client hashes Apple's nonce.**
`startIdTokenSignIn(provider:)` returns the server's nonce and the one `exchange`; the
token is sent once and kept nowhere. Google's token comes from the app (Google's SDK is
the app's dependency, never the client's). For Apple there is also `signInWithApple()`,
which runs the sheet itself and therefore hands it the lowercase hexadecimal SHA-256 of
the nonce: **here the client takes the hash**, where `@tula/core` and `@tula/expo` leave
it to the app, because here the client is what calls the sheet. `IdTokenSignIn.appleNonce`
is the same value for an app that runs the sheet itself. The name the sheet gives goes
beside the token, as ADR 0047 says.

**A browser round trip keeps its binding in memory and reads one address.** What the
browser returns is read only when it is the redirect URL that was asked for, character for
character, followed by `#`: anything else is `refused(.unexpectedReturn)` or
`refused(.noAnswer)` with no request, and a ticket for an attempt this client did not start
is `refused(.notStartedHere)`. The redirect URL is never judged by the client: the server's
`request.redirect_not_allowed` (with its reason) is thrown as it is. An error code in the
returned address is untrusted and is passed on only when the contract defines it. A ticket
whose exchange got no answer is kept for one minute, in memory, for `retryProviderSignIn()`
(the server honours it that long). **The ticket is forgotten only on an answer about it**
(and at the minute's end, a sign-out, a new round trip): a failure raised before it was
presented keeps it, which is no answer, a rate limit, and `storage.failed` or
`device.key_failed` from the refresh a link's exchange may need first. Once the server has
answered a sign-in's ticket it is forgotten before anything else is done with the answer.
The system's session listens for an app link by host and path, which the system offers
from iOS 17.4 and macOS 14.4; before those an app link is `provider.unsupported` and a
custom scheme is the way. **By host and path and nothing else**: an `https` redirect URL
with a port, user information, a query, a fragment or a host that ends in a full stop
could be opened and never returned to, so `SystemBrowserSession` refuses it
(`provider.unsupported`) before anything is opened.

**A session is bound to a device key at the start, and every refresh carries a proof**
(ADR 0043). The transport makes a DPoP proof (`ES256`, the public key as a JWK of four
members, `htm`, `htu`, `iat`, a fresh `jti`, the nonce when it has one) for the six starts
and the refresh and for nothing else, keeps the nonce in memory, and repeats a request once
after `device.nonce_required`, inside the same call and the same deadline.

**The key store is inside the call's deadline.** The look for the key and the signing of
each proof are raced against what is left of the deadline, as the request is (`within` in
`TulaHTTP.swift`): a store or a key that never answers ends the call as `network.timeout`
with nothing sent and the session kept. The code is `@tula/core`'s for the same case, so
that the two clients agree; like any refresh that got no answer it is repeated once, which
sends nothing either. Without this one stalled Keychain call would hold the shared refresh,
and every caller of `getToken()`, for ever.

**The store is asked one thing at a time.** A call that gave up at its deadline cannot stop
the store's call, only stop waiting for it, so each later refresh (and its repeat) would
start another look beside the one still out. `DeviceProofs` therefore keeps one look and
one making in flight: a caller that finds one out joins it under its own deadline and
starts nothing. Two costs, both kept. A look that never returns is the only look the client
makes until the key is removed through the client (below): every call that needs the key
ends at its deadline meanwhile, where before a store that hung once could answer the next
call. And a making that answers
after its caller gave up has still made a key, with nothing sent: it is not undone (the
next start finds it and uses it), and a device whose making outlasts every deadline never
binds a session and keeps the key it made.

**A caller that gives up leaves nothing waiting.** The flight was first a `Task` whose value
every caller awaited, and such an await does not end with the awaiting task's cancellation:
each refresh or start that joined a look that never returned left one suspended task behind
it until the process ended, however long ago its own deadline had passed. The flight is now
a list of waiters (`Shared` in `DeviceProofs`): a caller is a continuation kept under an id,
its task's cancellation (which is what a deadline does to it, `ApiTransport.within`) resumes
that one continuation and takes it off the list, and the store's call goes on for whoever
else waits. A caller's deadline never cancels the shared call. What a hung look still costs
is the look itself, one for the client, not one task per call.

**A removal drops the flight.** A look that began before the key was removed and answers
afterwards holds the removed key, and a start that took it would bind a session to a key
the store no longer has. So a removal that succeeded, the sign-out's own and the app's
(`TulaClient.removeDeviceKey()`), drops the look and the making that are out: their answer,
whenever it comes, is given to nobody. **Who joined before the removal gets an error**,
`device.key_failed`, at once (the answer it waited for is about a key that is gone, and a
refresh so refused keeps its session, as for any key failure); **who asks after it starts a
new look**, beside the old one if that is still out.

**A removal the store refused drops nothing; a removal whose outcome is not known drops as
one that succeeded does.** The store answered with an error inside the deadline: the key is
taken to be there still, and the look that is out is right about it. The store did not
answer in time, or the caller's task was cancelled: neither stops the store's call, which
may remove the key afterwards, so the flights are dropped all the same; dropping for a
removal that then did not happen costs one more look. `removeDeviceKey()` ends
`network.timeout` for the first and `device.key_failed` for the second. **A cancelled
removal has no code of its own**: nothing in the client surfaces a `CancellationError` (a
cancelled request is `network.failed`, a cancelled look for the key `device.key_failed`),
every public call throws a `TulaError`, and a key-store call that was cancelled is a key
failure like the look. What tells the cancelled from the refused is the caller's own task,
not the error the store threw.

**Two calls of the store can run at once after a drop.** The dropped call is not cancelled
(nothing can stop a store), so the look or the making that follows a removal may start
while one from before it is still out. A store must tolerate that and end with one key;
the protocol's `create()` says so. `KeychainDeviceKeyStore` is written for it: an add that
finds an item already there (`errSecDuplicateItem`) returns the stored key. That is read
from its source and shown on a fake of `KeychainItems`; no real Keychain was asked.

**What a drop does not cover.** The client can only know of a removal made through it: an
app that calls the store's own `remove()` keeps the old exposure, which is why the
documented way out is the client's call. And a start that **already holds** the key when
`removeDeviceKey()` runs (the look answered before the removal, the request is on its way)
binds its session to the removed key; that session is ended at its next refresh, as a
session whose key is gone is. The same is true of a look that starts after a removal that
timed out and is answered before the store gets to removing. "Sign out first" is said
beside "with no sign-in under way" for that reason.

A `device.*` answer never ends the session, **with one exception, which is the answer to
"what if the key is gone"**:

- `TulaDeviceKeyStore.existing()` answers `nil` only when the store knows there is no key,
  and throws when it cannot tell (a locked device, a Keychain error).
- A refresh that is refused `device.proof_invalid` **while the store says, twice, that
  there is no key** ends the session locally and tells the server (a best-effort sign-out,
  which needs no proof): the session cannot be refreshed by anyone again, and keeping it
  would be a client that is refused for ever.
- **The store is asked twice because the end cannot be undone** (`DeviceProofs.verdict`).
  One "no such item" is not believed: a second look that finds the key, or that throws,
  keeps the session and the call is `device.key_failed`. This narrows the case and does
  not close it: a store that is wrong twice in a row still ends a session that could have
  lived. Both looks are inside the refresh's deadline, and a look that does not answer has
  not said the key is gone.
- A store that throws is `device.key_failed` and the session is kept: the same call may
  work a moment later. **It may also never work again**: a blob the Secure Enclave no
  longer opens fails every time, and the client cannot tell that from a locked device, so
  the rule stands (a failure is never read as "gone") and the session stays, refused at
  every refresh.
- **The client removes a key by itself in one case: at a sign-out, when the store threw
  `TulaDeviceKeyStoreError.unusable`**, a public error that is the store's own word for "what
  I keep will never be a key again". Then `TulaDeviceKeyStore.remove()` is asked once, and
  a removal that fails is not the sign-out's failure. **A sign-out cancelled while the
  store is being asked removes nothing**, also when the store then answers "never again":
  the removal is best effort, the wait ends with the cancellation (`within`), and the next
  sign-out asks again. For every other failure (a locked
  device, an interaction that is not allowed, a cancellation, a look that did not answer in
  time, an error the client does not know) nothing is removed. An earlier version removed
  on any failure, and was wrong twice over: the default store's name is shared by the
  clients of one app, so a sign-out of one with the device locked removed the key another
  client's session was bound to; and a failure that passes a moment later had cost a key.
- **`KeychainDeviceKeyStore` throws that error for nothing.** The candidates were looked
  at and none can be argued from what Apple documents: `errSecInteractionNotAllowed` is a
  locked device, `errSecAuthFailed` and `errSecNotAvailable` are states that pass,
  `errSecDecode` and an empty item say something about one read, and
  `SecureEnclave.P256.Signing.PrivateKey(dataRepresentation:)` is documented only to throw,
  with no error that tells a blob of another enclave from one this enclave cannot use just
  now. So with the Keychain store a sign-out removes nothing of its own accord, and the way
  out of a key that never opens is the app's: `signOut()`, which needs no proof, then
  `TulaClient.removeDeviceKey()`, after which the next sign-in makes a new key. Until then every start
  is `device.key_failed` with nothing sent. The app can know what the adapter cannot (the
  device is unlocked and every start has failed since a restore). Giving the adapter a
  status is a decision of this record, with the sentence of Apple's that justifies it.
  Two clients that share one store share its key.
- A bad proof on a client that has its key (a clock that is wrong, a replayed proof) ends
  nothing, and neither does any refusal on a client with no key store.
- The sign-out of a lost key runs inside the shared refresh, so it has the refresh's
  deadline and not the client's; when it got no answer the token is kept in memory for the
  next `signOut()`.

This is the Expo decision ([ADR 0052](0052-expo-native-providers-and-device-keys.md)) in Swift's terms. `KeychainDeviceKeyStore`
makes the key in the Secure Enclave on a device (not extractable, this device only) and in
software on a simulator, which has no enclave; the tests use `SoftwareDeviceKeyStore` or a
fake of the internal `DeviceKeyEnclave`.

**The second step and a step-up are calls of their own, like the first factors**:
`submitTotp`, `submitBackupCode`, `submitSecondFactorWithPasskey`, the enrolment inside a
sign-in (`startTotpEnrolment`, `confirmTotpEnrolment`), and `stepUp.withPassword`,
`.withTotp`, `.withBackupCode`, `.sendEmailCode` / `.withEmailCode`, `.withPasskey`. A
step-up installs the new access token for the same session and keeps the refresh token;
confirming an authenticator refreshes once, so that the token says what was just proven.
There is no call for a texted code (TULA-60).

**Not built: an emailed link.** The server honours a link only with the binding the asking
client was given. A provider's binding lives in memory for one round trip; an emailed link
needs one that outlives the app, and a link the app judges when it is opened. Neither is
decided (`@tula/expo` refuses it for the same reason), so there is still no call that asks
for one, and the scenario stays `not_built`.

**The fixture gained what these journeys need and nothing looser**: an API whose providers
are the API's own mock provider (as `oauthServer()` of the JS journeys; the mock's gates
are unchanged, and the fixture is loopback only), a token of that mock for the ID-token
journeys (`issueMockIdToken`, as the JS journeys call it), the deployment tier, and the
server's clock, because a proof says when it was made.

### The journeys run against the real API, which the tests start

A Swift process cannot call the API in process, so `native/swift/fixture/server.ts` serves
it: `createApp(createTestDeps())`, every route and middleware, on memory adapters, one fresh
instance per test under its own path of one loopback port. It is `e2e/server.ts`'s kind of
fixture and is guarded the same way: it refuses to start without `TULA_NATIVE_FIXTURE=1`,
listens on 127.0.0.1 only, puts its test routes behind `e2e/guard.ts`, is outside `apps/api`
and excluded from the Docker build context, and keeps the run's secret key to itself (an
admin call of a journey is relayed, never made by the test). The journey tests spawn it and
it ends when they do.

### The list is held by the shared checks, from the sources

`conformance/client-journeys.json` is checked by `clientJourneyListProblems` and
`clientSuiteProblems`, which are TypeScript, and which a suite hands the tests it
registered. An XCTest bundle cannot do that. So a journey has **one form in the source**: a
`journey("<scenario>", "<title>") { … }` or `behaviour("<id>", "<title>") { … }` call that
is the first statement of a `func test…() async throws` method of a top-level
`final class …: JourneyTestCase`, with its names as plain string literals.
`native/swift/fixture/journeys.ts` reads the sources, refuses any other use of the two
functions and anything that can keep a test from running (`XCTSkip`, `XCTExpectFailure`,
`#if`, `@available`, `defaultTestSuite`, a swift-testing attribute), and gives what it read
to the shared functions, with the list loaded by `loadClientJourneys` (which refuses a key
written twice). No rule is restated.

It runs in two places: as a test of the Swift suite, and in `bun run test:harness`, so
`verify` holds the list and the declared tests to each other on a machine with no Swift
toolchain. What `verify` cannot show is that the tests pass.

Rejected: a JSON Schema validator in Swift (a second implementation of the rules, with no
dependency allowed to do it); a list of journeys kept beside the tests (a third thing to
agree with the other two).

### The `swift` column

The suite `exists`. Of the 108 scenarios, after TULA-56: 80 are journeys, 17 are
`not_applicable` (the admin API, the deployment, a browser, an Android app's certificate),
1 is `not_built` under TULA-56 and 10 under TULA-60; the four behaviours are journeys.
`SWIFT_NOT_BUILT` holds the two counts. (Before TULA-56: 28 journeys, 17 not applicable,
53 under TULA-56.)

"passkey assertion replay" and "passkeys switched off mid-attempt" are `not_applicable` for
`@tula/core`, which asks the browser itself, and are journeys here: the passkey sheet is a
public protocol the client awaits between the start of an attempt and its submit, so an
app's own sheet can take long enough for a setting to change, and can answer with an
assertion made earlier. The journeys put such a sheet behind the client and hold the
server's refusal and that nobody is signed in.

Two of those assignments are the nearest ticket and not a ticket that names the work, and
are for the plan's owner to confirm: the texted-code and phone-number scenarios are under
TULA-60, which is the SwiftUI ticket that names the texted-code step; and "email link
sign-in" stays under TULA-56, which built the app-link return of a provider sign-in but
not a link in an email (below, "Not built").

### CI and coverage

`.github/workflows/swift.yml` runs `swift test` with coverage on a macOS runner, on pull
requests that touch `native/swift`, the contract, `packages/conformance` or `conformance/`,
nightly, and on demand. It is its own workflow so that macOS minutes are spent only where
the client can break. The threshold is over the hand-written sources of the module only
(`native/swift/fixture/coverage.ts`): 90% of lines and 85% of functions. The generated
types are left out so that their thousands of covered lines cannot hide an uncovered
refresh path; functions are held lower because the calls into the system Keychain are
functions no test runs. The adapters of TULA-56 (the three sheets, the Secure Enclave) are
in the measure like every other hand-written file, and were not moved out of it: what a
test can run of them without showing anything is run (the framework's requests are built
and read, and the one step that shows a sheet or a browser is stood in for), and what only
the system can answer (a credential) is the part no test runs.

## Consequences

- An app gets the same session behaviour as a web app on `@tula/core`, and a test of each
  rule in two places: on a fake transport (deadlines, ordering, storage failures) and
  against the real API (the grace window, reuse detection, the profile's limits).
- The client and `@tula/core` are two implementations of one set of rules. Nothing but the
  journeys and the shared constants' tests keeps them equal: a rule changed in one is
  changed in the other, and gets a journey.
- A step this version has no call for is a screen that says so. After TULA-56 that is a
  texted code (TULA-60) and an emailed link.
- The client now takes four things an app may leave out (a device key store, a passkey
  sheet, an Apple sheet, a browser session). Left out, the feature is refused with a code
  before any request, and nothing of the system is touched: that is also what keeps every
  test from showing a sheet.
- The journey tests need `bun` and an installed workspace. `swift test` on a checkout
  without them fails with a message that says so, rather than skipping.
- The form of a journey declaration is rigid on purpose. A helper that wraps `journey(…)`,
  or a name built at run time, fails the scan.

## Not verified

Nothing here ran on iOS, in a simulator or on a device, and no test asked a real Keychain.
No passkey sheet, no Sign in with Apple sheet and no browser session was ever shown, no key
was made in a Secure Enclave, and no real provider was asked: the journeys use a software
authenticator, a software P-256 key, the API's mock provider and the test itself as the
browser. The origin an iOS passkey response carries (`https://<rpId>`) is taken from ADR
0027 and was not seen from a device. `docs/plans/phase-2-unverified.md`, "Step 2.14, the Swift
client", has what was run, with which toolchain, and what was not.

## Not decided here

The client-side password checklist (`@tula/core`'s policy evaluator) is not ported: the
server's field errors are what a refusal carries, and a checklist belongs with the screens
(the first screens, [ADR 0057](0057-swiftui-screens.md), show the server's field errors and
did not port it either). A session's observation API beyond `updates()` (an
`ObservableObject`, a `@Observable` model) is the screens' too: ADR 0057's `TulaAuthModel`
observes a flow, not the session. Publishing the package (a tag, a registry) is not
decided: nothing is published.
