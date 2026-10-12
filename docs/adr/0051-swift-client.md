# ADR 0051 — The Swift client: flows and the session, by `@tula/core`'s rules

- Status: accepted
- Date: 2026-10-12

## Context

Step 2.14 of [the plan](../plans/phase-2.md) is a Swift SDK. Its types are generated
([ADR 0050](0050-native-type-generation.md)); this record is the first hand-written part
(TULA-37): a client with no screen that signs a user up, signs them in with a password or an
emailed code, resets a password, and keeps and refreshes the session. Passkeys, a provider's
ID token, provider sign-in through a browser, device binding, the second step and a step-up
are TULA-56; the SwiftUI screens are TULA-49 and TULA-60. None of them is here.

The behaviour was not open. `@tula/core` ([ADR 0021](0021-core-sdk.md)) already says what a
client does between requests, the conformance scenarios say what it must observe, and
`conformance/client-journeys.json` has a column for it. What had to be decided is how those
rules are held in Swift, where the refresh token is kept, and how a suite written in XCTest
is checked against a list whose checks are TypeScript.

## Decision

### One package, no dependency, an `ios` client

`native/swift` is one library, `TulaAuth`, on Foundation and the Security framework and
nothing else. The floor is iOS 16 and macOS 13 (`Package.swift`); macOS is there because
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
`emailVerification`, `newPassword`, `complete`, or **`notSupported(status:)`** for a status
it does not know, a known step it has no call for yet (a second factor, an enrolment), a
reason it does not know, and a step that offers only ways it cannot take. Never an error,
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
errors, `retryAfter`) or one of five codes of the client's own with status 0
(`network.failed`, `network.timeout`, `response.invalid`, `storage.failed`, `flow.busy`).
`code` is the string as sent, with `known` as the generated `ErrorCode`: a code the server
gained after the app shipped is still an error an app can show by its message. It holds no
underlying error and prints only its code and status: a `URLError` can quote a URL, and the
generated types print what they hold.

The client logs nothing. A redirect is never followed (the answer is handed back as it is),
the `URLSession` is ephemeral with no cookie store, cache or credential store, and a path
parameter that is not one path segment is refused before any request.

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

The suite `exists`. Of the 107 scenarios: 28 are journeys, 16 are `not_applicable` (the
admin API, the deployment, a browser, an Android app's certificate), 53 are `not_built`
under TULA-56 and 10 under TULA-60; the four behaviours are journeys. `SWIFT_NOT_BUILT`
holds the two counts.

Two of those assignments are the nearest ticket and not a ticket that names the work, and
are for the plan's owner to confirm: the texted-code and phone-number scenarios are under
TULA-60, which is the SwiftUI ticket that names the texted-code step; and "email link
sign-in" is under TULA-56, whose app-link returns are what a link that opens the app would
need.

### CI and coverage

`.github/workflows/swift.yml` runs `swift test` with coverage on a macOS runner, on pull
requests that touch `native/swift`, the contract, `packages/conformance` or `conformance/`,
nightly, and on demand. It is its own workflow so that macOS minutes are spent only where
the client can break. The threshold is over the hand-written sources of the module only
(`native/swift/fixture/coverage.ts`): 90% of lines and 85% of functions. The generated
types are left out so that their thousands of covered lines cannot hide an uncovered
refresh path; functions are held lower because the calls into the system Keychain are
functions no test runs.

## Consequences

- An app gets the same session behaviour as a web app on `@tula/core`, and a test of each
  rule in two places: on a fake transport (deadlines, ordering, storage failures) and
  against the real API (the grace window, reuse detection, the profile's limits).
- The client and `@tula/core` are two implementations of one set of rules. Nothing but the
  journeys and the shared constants' tests keeps them equal: a rule changed in one is
  changed in the other, and gets a journey.
- A step this version has no call for is a screen that says so. An environment that
  requires a second factor cannot be signed in to with this version; that is TULA-56.
- The journey tests need `bun` and an installed workspace. `swift test` on a checkout
  without them fails with a message that says so, rather than skipping.
- The form of a journey declaration is rigid on purpose. A helper that wraps `journey(…)`,
  or a name built at run time, fails the scan.

## Not verified

Nothing here ran on iOS, in a simulator or on a device, and no test asked a real Keychain.
The workflow has never run. `docs/plans/phase-2-unverified.md`, "Step 2.14, the Swift
client", has what was run, with which toolchain, and what was not.

## Not decided here

The client-side password checklist (`@tula/core`'s policy evaluator) is not ported: the
server's field errors are what a refusal carries, and a checklist belongs with the screens
(TULA-49). A session's observation API beyond `updates()` (an `ObservableObject`, a
`@Observable` model) is the screens' too. Publishing the package (a tag, a registry) is
not decided: nothing is published.
