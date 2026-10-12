# The Swift client

`TulaAuth` is the Swift package in [`native/swift`](../native/swift/README.md): a client with
no screen. It signs a user up, signs them in with a password or an emailed code, resets a
password, and keeps the session: the access token in memory, the refresh token in the
Keychain, refreshed when it is about to expire. You draw the screens, from the step the
server returns. The decisions are in [ADR 0051](adr/0051-swift-client.md).

**What has been run.** The package is built and tested with `swift test` on a Mac, where its
journeys run against the real API on a loopback port. It has not been run on iOS, in a
simulator or on a device, and no test has asked a real Keychain:
[what is unverified](plans/phase-2-unverified.md#step-214-the-swift-client-tula-37-adr-0051)
lists it. Nothing is published: there is no tag and no registry entry, and the package is
used from a checkout.

## What this version does not do

A sign-in that reaches one of these is the screen `notSupported`, not an error:

- a second factor, an enrolment inside a sign-in, a step-up, managing factors;
- passkeys, sign-in with a provider (through a browser or with Apple's or Google's ID
  token), device binding;
- a texted code, a phone number on the account, an emailed **link** (the code in the same
  email is the way);
- any screen: there is no SwiftUI view in the package.

An environment whose `mfa.policy` is `required`, or whose users have a second factor, cannot
be signed in to with this version.

## Setup

Requires iOS 16 or macOS 13, and Swift 5.9 or later. The package has no dependency.

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

The client is an `ios` client to the API and that is not an option.

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
| `flow.busy` | A second action on a flow while one is out. |

An error holds no token, password, code or attempt secret, and no underlying error.
The generated types are different: a `SessionTokens` or a request body prints what it holds.
Never log or interpolate one.

## Tests

```bash
bun install                                   # the journeys start the API from source
swift test --package-path native/swift
```

Two targets. `TulaAuthTests` are unit tests on a fake transport and a fake Keychain: no
network, no process. `TulaAuthJourneyTests` drive the client against the real API, which
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
