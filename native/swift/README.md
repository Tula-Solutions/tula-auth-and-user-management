# TulaAuth (Swift)

The Swift SDK of Tula Auth, in two libraries. `TulaAuth` is a client with no screen:
sign-up, sign-in with a password, an emailed code, a passkey, a provider's ID token or a
provider's page, the second step and a step-up, a password reset, and the session, with the
refresh token in the Keychain and, where asked for, bound to a device key. `TulaAuthUI` is
SwiftUI screens on it, for a sign-in with a password or an emailed code, a sign-up, the
emailed code that proves an address and a password reset.
How to use them is in [docs/swift.md](../../docs/swift.md); why they are the way they are,
in [ADR 0051](../../docs/adr/0051-swift-client.md) and
[ADR 0057](../../docs/adr/0057-swiftui-screens.md).

**It has been built and tested on a Mac with `swift test`, and the screens, with the client
under them, were run in one iOS simulator by the example's UI tests. It has not been run on
a device, and VoiceOver was never turned on; no test has asked a Secure Enclave or looked at
a Keychain item, and no passkey sheet, Sign in with Apple sheet or browser session has been
shown by it**
(what is unverified: [the session and the flows](../../docs/plans/phase-2-unverified.md#step-214-the-swift-client-tula-37-adr-0051),
[passkeys, providers and the device key](../../docs/plans/phase-2-unverified.md#step-214-the-swift-client-passkeys-providers-a-device-key-tula-56-adr-0051),
[the screens](../../docs/plans/phase-2-unverified.md#step-214-the-swiftui-screens-tula-49-adr-0057)).
Nothing is published.

Not in this version: texted codes, an emailed link; and, of the screens, the second step,
passkeys, providers and the account's own screens (a sign-in that reaches one is the "not
supported" screen).

## Layout

| Path | What |
| --- | --- |
| `Package.swift` | Two libraries, `TulaAuth` and `TulaAuthUI` (which depends on `TulaAuth` and on nothing else); iOS 16, macOS 13; no dependency (Foundation, Security, CryptoKit, AuthenticationServices and SwiftUI are the system's). |
| `Sources/TulaAuthUI/*.swift` | What the screens decide, by hand: `TulaAuthModel` (which screen, what the fields hold, where a problem is said, the actions), `TulaStrings` (the one table of strings, and an error's message by its code), `TulaThemeValues` (the contract's theme grammar, and a value turned into a colour, points or a typeface). Counted by the coverage check. |
| `Sources/TulaAuthUI/Views/` | The SwiftUI views and the four slots: `TulaAuthView`, `TulaAuthParts`. They draw the model and decide nothing; not counted by the coverage check (`swift test` draws no view). |
| `Tests/TulaAuthUITests/` | The model, the strings and the theme, on the real client over a table of answers. No view is made. |
| `fixture/ui-tests.ts` | Runs the screens in an iOS simulator: starts the fixture, picks a simulator and runs the UI tests of [`examples/swiftui`](../../examples/swiftui/README.md) with `xcodebuild test`. By hand; in no workflow. |
| `Sources/TulaAuth/Generated/` | The types of the client API, the error codes, the theme. **Generated** by `bun run native:generate` ([ADR 0050](../../docs/adr/0050-native-type-generation.md)): never edit or add a file there. |
| `Sources/TulaAuth/*.swift` | The client, by hand: `TulaClient`, `TulaSession`, `TulaFlow`, `TokenStorage`, `TulaHTTP`, `TulaError`; `TulaDeviceKey` (the device key and its proofs), `TulaCeremony` (the three protocols a sheet is behind, and one sheet at a time), `TulaProviders`, `TulaAccount` (step-up, passkeys, factors, identities), and `TulaSystemSheets`, the one file that imports AuthenticationServices. |
| `Tests/TulaAuthTests/` | Unit tests on a fake transport, a fake Keychain and fake sheets: nothing is shown and no real key store is asked. |
| `Tests/TulaAuthJourneyTests/` | The client against the real API: the `swift` column of `conformance/client-journeys.json`. |
| `fixture/server.ts` | The server the journeys run against: the real API in memory, on a loopback port. A test fixture; it refuses to start without `TULA_NATIVE_FIXTURE=1`. |
| `fixture/journeys.ts` | Holds the journey tests and the client-journey list to each other, with the shared checks. |
| `fixture/coverage.ts` | The coverage threshold, held by each library alone: `TulaAuth` over its hand-written sources, `TulaAuthUI` over the files directly in `Sources/TulaAuthUI`. |

## Commands

From the repository's root:

```bash
bun install                                   # once: the journeys start the API from source
swift test --package-path native/swift
swift test --package-path native/swift --enable-code-coverage
bun run native/swift/fixture/coverage.ts      # after the line above
bun run native/swift/fixture/journeys.ts      # the journeys against the list, alone
bun run native/swift/fixture/ui-tests.ts      # the screens in an iOS simulator (needs Xcode)
```

The last one is not part of `swift test`, of `verify` or of any workflow. After a change
under `Sources/TulaAuthUI` or `examples/swiftui`, run it and record the run (Xcode, the
simulator, the iOS version, the result line) in
[the unverified list](../../docs/plans/phase-2-unverified.md#step-214-the-swiftui-screens-tula-49-adr-0057).

## Adding a journey

A journey is counted where it is declared, so a declaration has one form: the first
statement of a test method of a top-level `final class …: JourneyTestCase`, with both names
as plain string literals.

```swift
func testSignOut() async throws {
    try await journey("sign-out", "sign-out: ends the session on the server and in the client") { s in
        …
    }
}
```

`behaviour("<id>", "<title>") { s in … }` is the same for a named client behaviour. Change
the scenario's entry for `swift` in `conformance/client-journeys.json` in the same change,
and `SWIFT_NOT_BUILT` in `fixture/journeys.ts` when the entry was `not_built`. `XCTSkip`,
`XCTExpectFailure`, `#if` and `@available` are refused anywhere in that directory.
