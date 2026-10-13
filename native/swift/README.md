# TulaAuth (Swift)

The Swift SDK of Tula Auth: a client with no screen. Sign-up, sign-in with a password, an
emailed code, a passkey, a provider's ID token or a provider's page, the second step and a
step-up, a password reset, and the session, with the refresh token in the Keychain and,
where asked for, bound to a device key.
How to use it is in [docs/swift.md](../../docs/swift.md); why it is the way it is, in
[ADR 0051](../../docs/adr/0051-swift-client.md).

**It has been built and tested on a Mac with `swift test`. It has not been run on iOS, in a
simulator or on a device; no test has asked a real Keychain or a Secure Enclave, and no
passkey sheet, Sign in with Apple sheet or browser session has been shown by it**
(what is unverified: [the session and the flows](../../docs/plans/phase-2-unverified.md#step-214-the-swift-client-tula-37-adr-0051),
[passkeys, providers and the device key](../../docs/plans/phase-2-unverified.md#step-214-the-swift-client-passkeys-providers-a-device-key-tula-56-adr-0051)).
Nothing is published.

Not in this version: texted codes, an emailed link, any screen.

## Layout

| Path | What |
| --- | --- |
| `Package.swift` | One library, `TulaAuth`; iOS 16, macOS 13; no dependency (Foundation, Security, CryptoKit and AuthenticationServices are the system's). |
| `Sources/TulaAuth/Generated/` | The types of the client API, the error codes, the theme. **Generated** by `bun run native:generate` ([ADR 0050](../../docs/adr/0050-native-type-generation.md)): never edit or add a file there. |
| `Sources/TulaAuth/*.swift` | The client, by hand: `TulaClient`, `TulaSession`, `TulaFlow`, `TokenStorage`, `TulaHTTP`, `TulaError`; `TulaDeviceKey` (the device key and its proofs), `TulaCeremony` (the three protocols a sheet is behind, and one sheet at a time), `TulaProviders`, `TulaAccount` (step-up, passkeys, factors, identities), and `TulaSystemSheets`, the one file that imports AuthenticationServices. |
| `Tests/TulaAuthTests/` | Unit tests on a fake transport, a fake Keychain and fake sheets: nothing is shown and no real key store is asked. |
| `Tests/TulaAuthJourneyTests/` | The client against the real API: the `swift` column of `conformance/client-journeys.json`. |
| `fixture/server.ts` | The server the journeys run against: the real API in memory, on a loopback port. A test fixture; it refuses to start without `TULA_NATIVE_FIXTURE=1`. |
| `fixture/journeys.ts` | Holds the journey tests and the client-journey list to each other, with the shared checks. |
| `fixture/coverage.ts` | The coverage threshold of the hand-written sources. |

## Commands

From the repository's root:

```bash
bun install                                   # once: the journeys start the API from source
swift test --package-path native/swift
swift test --package-path native/swift --enable-code-coverage
bun run native/swift/fixture/coverage.ts      # after the line above
bun run native/swift/fixture/journeys.ts      # the journeys against the list, alone
```

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
