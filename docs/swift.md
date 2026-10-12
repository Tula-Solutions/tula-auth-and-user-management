# The Swift client

`TulaAuth` is the Swift package in [`native/swift`](../native/swift/README.md): a client with
no screen. It signs a user up, signs them in with a password, an emailed code, a passkey, a
provider's ID token or a provider's page in a browser session, takes the second step and a
step-up, resets a password, and keeps the session: the access token in memory, the refresh
token in the Keychain, refreshed when it is about to expire, and bound to a device key
where you ask for that. You draw the screens, from the step the server returns. The
decisions are in [ADR 0051](adr/0051-swift-client.md).

**What has been run.** The package is built and tested with `swift test` on a Mac, where its
journeys run against the real API on a loopback port. It has not been run on iOS, in a
simulator or on a device. No test has asked a real Keychain or a Secure Enclave, **no
passkey sheet, no Sign in with Apple sheet and no browser session has been shown by this
package**, and no real provider was asked: the tests put a software authenticator, a
software key and the API's mock provider in their place. What is unverified is listed for
[the session and the flows](plans/phase-2-unverified.md#step-214-the-swift-client-tula-37-adr-0051)
and for [passkeys, providers and the device key](plans/phase-2-unverified.md#step-214-the-swift-client-passkeys-providers-a-device-key-tula-56-adr-0051).
Nothing is published: there is no tag and no registry entry, and the package is used from a
checkout.

## What this version does not do

A sign-in that reaches one of these is the screen `notSupported`, not an error:

- a texted code (as a way to sign in or as the second step), and a phone number on the
  account;
- an emailed **link** (the code in the same email is the way);
- any screen: there is no SwiftUI view in the package.

## Setup

Requires iOS 16 or macOS 13, and Swift 5.9 or later. The package has no dependency: it uses
Foundation, Security, CryptoKit and AuthenticationServices, which are the system's.

```swift
import TulaAuth

let tula = try TulaClient(
    publishableKey: "tula_pk_…",
    baseURL: "https://auth.example.com"
)
```

The key is the environment's **publishable** key; anything else is refused when the client
is made (`TulaConfigurationError`, a fixed sentence that repeats nothing it was given). A
secret key never belongs in an app.

| Option | Default | What it is |
| --- | --- | --- |
| `storage` | `KeychainTokenStorage()` | Where the refresh token is kept. |
| `transport` | a `URLSession` of the client's own | What sends requests. It keeps no cookie, cache or credential and follows no redirect. |
| `sessionProfile` | none | A session profile to ask for by name, where the environment marks one `clientSelectable`. |
| `timeout` | 15 seconds | How long one request may take. A refresh never takes more than 8. |
| `deviceKeys` | none | Where the device key is kept: `KeychainDeviceKeyStore()`. With one, sessions are bound to the key ("A session bound to a device key"). |
| `passkeys` | none | The passkey sheet: `SystemPasskeySheet()`. Without one every passkey call throws `passkey.unsupported`. |
| `apple` | none | The Sign in with Apple sheet: `SystemAppleSheet()`. |
| `browser` | none | The browser session of a provider sign-in: `SystemBrowserSession()`. |

The client is an `ios` client to the API and that is not an option.

The last four are left out by default on purpose: nothing of the system is touched, and no
session is bound, unless the app said so. Each is a protocol (`TulaDeviceKeyStore`,
`TulaPasskeySheet`, `TulaAppleSheet`, `TulaBrowserSession`); a test or a preview passes an
implementation of its own.

## The session

```swift
try await tula.session.load()                 // reads the Keychain, once
for await state in await tula.session.updates() {
    switch state {
    case .loading: break                      // not known yet
    case .signedOut: showSignIn()
    case .signedIn(_, let user): showApp(user)
    }
}
```

`getToken()` hands out an access token for your own backend, refreshed first when it is
about to expire, and `nil` when nobody is signed in. Your backend verifies it against the
environment's published keys; send it nowhere else.

What the session does by itself is what `@tula/core` does:

- **One refresh at a time.** Calls that need a token at the same moment share one request.
- **A refresh the server refuses ends the session** (`session.*`, `auth.user_banned`,
  `auth.unauthenticated`): the state becomes `signedOut`.
- **Anything else keeps it.** Offline, a timeout, a rate limit: `getToken()` throws, the
  state stays `signedIn`, the stored token stays where it is, and the same call works when
  the network is back.
- **A refresh that got no answer is sent once more, at once**, with the same token. The
  server answers a token presented again inside its grace window (10 seconds by default)
  with the same next token, which is why a refresh gives up after 8 seconds whatever
  `timeout` says.

`list()`, `revoke(_:)` and `revokeOthers()` are the user's sessions.

### Signing out

```swift
do {
    try await tula.session.signOut()
} catch {
    // Signed out here, but the server could not be told: the session may live on there.
}
```

**A failed sign-out is not a sign-out.** When the server could not be told, `signOut()`
throws. The client is signed out all the same, and calling `signOut()` again tells the
server. Do not show "signed out everywhere" for a call that threw.

`signOut()` removes the stored token also when it could not read it. Two cases end in
`storage.failed` and are not put right by a second call: a stored token that could not be
read (the server was not told about that session, which lives until it expires or is ended
elsewhere), and a stored token that could not be removed (the next start of the app finds
it, and the server refuses it if the sign-out reached it).

### Where the refresh token is kept

In the Keychain, as a generic-password item that is never synchronized, in a class that
never leaves the device:

| `KeychainAccessibility` | Readable | For |
| --- | --- | --- |
| `.whenUnlocked` (default) | while the device is unlocked | most apps |
| `.afterFirstUnlock` | from the first unlock after a restart | an app that refreshes in the background |

It is written nowhere else: not user defaults, not a file, not a log line.

**A Keychain that cannot be read is not "signed out".** The call fails with
`storage.failed` and the session is kept: `load()` leaves the state `loading`, and the next
call asks again. With `.whenUnlocked`, a refresh made while the device is locked fails this
way.

**A Keychain that cannot be written is not harmless.** A refresh whose new token could not
be stored fails with `storage.failed`; the session is kept **in the running app**, which
holds the new token in memory. The Keychain still holds the token the server has replaced.
The client does not try the write again by itself: the next refresh that succeeds writes
its token. An app that is ended before that, and started after the server's grace window
(10 seconds by default), presents the replaced token and is signed out by the server
(`session.reuse_detected`).

`TulaTokenStorage` is a protocol of three functions; `MemoryTokenStorage` is the
implementation for tests and previews. An implementation of your own must keep the token on
the device and must throw, never return `nil`, when it could not read.

### A session bound to a device key

```swift
let tula = try TulaClient(
    publishableKey: "tula_pk_…",
    baseURL: "https://auth.example.com",
    deviceKeys: KeychainDeviceKeyStore()
)
```

With a key store, every sign-in this client starts carries a proof signed by the device's
key, the session is bound to that key, and every refresh carries a proof
([device binding](device-binding.md)). A refresh token copied off the device cannot be
refreshed without the key. Whether an environment allows or requires this is its session
profile's `deviceBinding`; a profile that says `none` refuses a client that sends a proof.

`KeychainDeviceKeyStore` makes a P-256 key in the Secure Enclave, which cannot be exported
and never leaves the device. **In a simulator, which has no Secure Enclave, it keeps a
software key instead**, which is for development and protects nothing.

What the client does with a refusal:

| What happened | The session |
| --- | --- |
| The server refused the proof (`device.proof_invalid`: a clock that is wrong, a proof seen before) and the key is there | **Kept.** `getToken()` throws; the next call makes a new proof. |
| The server asked for a fresh nonce (`device.nonce_required`) | Kept: the request is repeated once, by itself. |
| The key store could not answer (`device.key_failed`: a locked device, a Keychain error) | **Kept.** The same call may work a moment later. |
| The server refused the proof **and the key store says the key is gone** | **Ended.** Nobody can refresh that session again: the client signs out locally and tells the server. The user signs in again, and a new key is made. |

So a key store of your own must answer `nil` from `existing()` only when it knows there is
no key, and must throw when it cannot tell. A reinstalled app is a new device.
Signing out needs no proof.

## Flows

A flow is one attempt. It holds the attempt's secret, sends it with every step, and exposes
the server's step (`flow.step`, the generated `FlowStep`) and what this version can do with
it (`flow.screen`):

| `FlowScreen` | Draw | Then call |
| --- | --- | --- |
| `.password` | a password field | `submitPassword(_:)` |
| `.firstFactor(step)` | the ways in `step.strategies` that are in `FlowScreen.firstFactors` | `submitPassword(_:)`, or `prepareEmailCode()` then `attemptEmailCode(_:)` |
| `.emailVerification(step)` | a code field | `verifyEmail(code:)`, `resendCode()` |
| `.newPassword(step)` | a new-password field | a reset: `submit(code:password:)`; a sign-in whose password expired: `submitNewPassword(_:)` |
| `.secondFactor(step)` | the ways in `step.strategies` the client can take | `submitTotp(_:)`, `submitBackupCode(_:)`, `submitSecondFactorWithPasskey()` |
| `.factorEnrolment(step)` | an authenticator's setup key, then a code field | `startTotpEnrolment()`, `confirmTotpEnrolment(code:)` |
| `.complete` | nothing: the session is signed in | |
| `.notSupported(status:)` | "this app cannot finish this here" | nothing |

```swift
let flow = try await tula.startSignUp(email: email, password: password)
// The server emailed a code.
try await flow.verifyEmail(code: typed)       // .complete: tula.session is signed in

let signIn = try await tula.startSignIn(identifier: email)
try await signIn.submitPassword(typed)

let reset = try await tula.startPasswordReset(email: email)
try await reset.submit(code: typed, password: newPassword)
```

Every `default:` of a switch over `FlowScreen` or `FlowStep` should draw the "not supported"
screen. The server can gain a step after your app shipped; the client hands it on unchanged
and makes no request on a guess.

A flow runs one action at a time (a second call while one is out is `flow.busy`). Call
`discard()` when the user leaves the screen: the secret is forgotten, and the answer of an
action still in flight signs nobody in.

Nothing is sent by a start. A sign-in's emailed code is asked for with `prepareEmailCode()`,
and the answer is the same for an address with no account.

### The second step

`submitBackupCode(_:)` also answers how many backup codes are left. `confirmTotpEnrolment`
answers the backup codes, once: show them, and keep them nowhere. An authenticator's setup
key and its `otpauth://` address are secrets while their screen is open; never log one.

A second factor that is a texted code alone is `notSupported` in this version.

## Passkeys

A passkey call shows the system's sheet and answers a `TulaCeremony`:

```swift
switch try await tula.signInWithPasskey() {
case .finished(let flow): proceed(flow)       // complete, or the step the server asks for
case .dismissed: break                        // the user closed the sheet: say nothing
}
```

**A dismissed sheet is not an error and not a sign-in.** Nothing was sent to prove
anything, and the same call works again. A `catch` is for what failed.

| Call | |
| --- | --- |
| `tula.signInWithPasskey()` | A sign-in of its own, with no identifier. |
| `flow.submitSecondFactorWithPasskey()` | The second step, where the server offers a passkey. |
| `tula.passkeys.add(name:)` | Registers one for the signed-in user (needs a recent authentication). |
| `tula.passkeys.list()`, `.rename(_:to:)`, `.remove(_:)` | The user's passkeys. |
| `tula.stepUp.withPasskey()` | A step-up. |

One sheet at a time for the whole client: a second ceremony while one is out is `flow.busy`,
before any request. Nothing of a ceremony is kept.

The server accepts an iOS app's passkey only where the environment has the app registered
and allows the relying party's own origin ([native apps](native-apps.md)), and the app needs
the Associated Domains entitlement for that domain. None of that has been tried on a
device: the journeys answer with a software authenticator.

## Sign in with Apple, and Google's ID token

```swift
// Apple: the client runs the sheet.
let result = try await tula.signInWithApple()

// Google: the app gets the token from Google's SDK, the client exchanges it.
let attempt = try await tula.startIdTokenSignIn(provider: .google)
let idToken = try await askGoogle(nonce: attempt.nonce)
let flow = try await attempt.exchange(idToken: idToken)
```

The nonce is the server's, and an attempt takes one token, right or wrong. The token is
sent once and kept nowhere. The package has no Google dependency: the token comes from the
app.

For Apple the client hands the sheet the SHA-256 of the nonce, as Apple's token must carry
it, and sends the name the sheet gave (which Apple gives on the first authorization only).
An app that runs the sheet itself uses `attempt.appleNonce` and
`exchange(idToken:givenName:familyName:)`. The environment accepts Apple's token only for
the bundle IDs of its registered iOS apps ([Apple](providers/apple.md)).

## Sign in with a provider's page

```swift
switch try await tula.signIn(with: .github, redirectURL: "https://app.example.com/return") {
case .signedIn(let flow): proceed(flow)
case .needsStep(let flow): draw(flow.screen)  // a second factor
case .cancelled: break                        // the user closed the browser
case .refused(let why): explain(why)
case .linked: break                           // only from identities.link
}
```

The redirect URL is one the environment lists, exactly: an app link (`https://…`, which
the system's session can listen for from iOS 17.4; before that the call is
`provider.unsupported`) or a custom scheme, which the server allows only for a provider
that sends PKCE. The server decides; its refusal is thrown as it is.

**What the browser returns is read only when it is the redirect URL that was asked for,
character for character.** Anything else is `.refused(.unexpectedReturn)` and no request is
made. A closed browser is `.cancelled`: not an error, and nobody is signed in. When the
exchange got no answer, `retryProviderSignIn()` tries the same ticket again for a minute.

`tula.identities.link(_:redirectURL:)` adds a provider account to the signed-in user the
same way, and needs an app link: the server refuses a custom scheme there.

## Step-up, factors

```swift
do {
    try await tula.factors.disableTotp()
} catch let error as TulaError where error.code == "auth.step_up_required" {
    // error.stepUpMethods says how: "totp", "backup_code", "passkey", "password", "email_code"
    try await tula.stepUp.withTotp(typed)
}
```

`tula.stepUp` has `withPassword(_:)`, `withTotp(_:)`, `withBackupCode(_:)`,
`sendEmailCode()` then `withEmailCode(_:)`, and `withPasskey()`. A user with a second
factor steps up with it; the server never offers them the password or an emailed code.
`tula.factors` reads the user's factors, enrols and removes an authenticator and makes new
backup codes.

## Errors

Everything the client throws after construction is a `TulaError`:

| Field | |
| --- | --- |
| `code` | The contract's code as the server sent it (`auth.invalid_credentials`, `password.too_short`, …), or one of the client's own, below. `known` is the same as the generated `ErrorCode`. |
| `status` | The HTTP status; `0` for a client code. |
| `message` | The client's English sentence for the code (the contract's table); the server's own `detail` only for a code this version does not know. |
| `errors` | Field errors (a password that breaks several rules has one per rule). |
| `retryAfter` | Seconds to wait, for `rate_limited`. |

| Client code | When |
| --- | --- |
| `network.failed` | No answer: offline, a connection that died, or a call whose task was cancelled. |
| `network.timeout` | No answer in time. |
| `response.invalid` | An answer that is not what the contract says. |
| `storage.failed` | The storage could not be read, written or cleared. The running app keeps its session; what the Keychain then holds is said under "Where the refresh token is kept" and "Signing out". |
| `flow.busy` | A second action on a flow while one is out, or a second sheet or browser session while one is. |
| `device.key_failed` | The device key store could not answer, or could not sign. The session is kept. |
| `passkey.unsupported` | No passkey sheet was given to the client, or the system cannot show one. |
| `passkey.already_on_device` | A registration, where a passkey of this account is already on the device. |
| `passkey.failed` | The sheet failed for another reason. |
| `provider.unsupported` | No Apple sheet or browser session was given, or the system cannot do what was asked. |
| `provider.failed` | The sheet or the browser session failed for another reason. |

`device.proof_invalid`, `device.binding_required` and the other `device.*` codes are the
server's. None ends the session, except the one case under "A session bound to a device
key".

An error holds no token, password, code, attempt secret, key, proof or credential, and no
underlying error: what a system framework said when it failed is never kept.
The generated types are different: a `SessionTokens` or a request body prints what it holds.
Never log or interpolate one.

## Tests

```bash
bun install                                   # the journeys start the API from source
swift test --package-path native/swift
```

Two targets. `TulaAuthTests` are unit tests on a fake transport, a fake Keychain and fake
sheets: no network, no process, and nothing shown. `TulaAuthJourneyTests` drive the client against the real API, which
they start themselves in memory on a loopback port (`native/swift/fixture/server.ts`); they
are the `swift` column of [`conformance/client-journeys.json`](../conformance/README.md),
and `native/swift/fixture/journeys.ts` holds the two to each other.

Coverage has a threshold over the hand-written sources of the module (90% of lines, 85% of
functions):

```bash
swift test --package-path native/swift --enable-code-coverage
bun run native/swift/fixture/coverage.ts
```

The `Swift` workflow (`.github/workflows/swift.yml`) runs both on a macOS runner, on pull
requests that touch the package, the contract or the conformance files, and nightly.
