// swift-tools-version:5.9
import PackageDescription

// The Swift SDK (step 2.14). Two libraries. `TulaAuth`: the client with no UI (TULA-37,
// TULA-56, ADR 0051). `TulaAuthUI`: the SwiftUI screens of sign-in, sign-up and password
// reset, drawn from the client's steps (TULA-49, ADR 0057); it depends on `TulaAuth` and on
// SwiftUI, and on nothing else. Everything under Sources/TulaAuth/Generated is written by
// `bun run native:generate` (ADR 0050) and must not be edited by hand; the client is written
// by hand beside that directory. No dependency: Foundation, Security, CryptoKit and
// AuthenticationServices are frameworks of the system.
//
// Three test targets:
// - TulaAuthTests: unit tests on a fake transport, a fake Keychain and fake sheets. No
//   network, no process, nothing shown.
// - TulaAuthJourneyTests: the client against the real API, which the tests start themselves
//   (`bun` must be on the PATH and `bun install` done at the repository's root). It is the
//   `swift` column of conformance/client-journeys.json.
// - TulaAuthUITests: what is behind the screens (the screen model, the strings, the theme's
//   checks) on a scripted transport, and that every screen can be laid out. No simulator:
//   the screens are driven on one by examples/swiftui's UI tests (docs/swift.md, "Tests").
let concurrency: [SwiftSetting] = [.enableExperimentalFeature("StrictConcurrency")]

let package = Package(
    name: "TulaAuth",
    // iOS 16 is the floor of the plan (docs/plans/phase-2.md); macOS 13 is its contemporary
    // and what `swift test` runs on.
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "TulaAuth", targets: ["TulaAuth"]),
        .library(name: "TulaAuthUI", targets: ["TulaAuthUI"]),
    ],
    targets: [
        .target(name: "TulaAuth", path: "Sources/TulaAuth", swiftSettings: concurrency),
        .target(
            name: "TulaAuthUI", dependencies: ["TulaAuth"], path: "Sources/TulaAuthUI", swiftSettings: concurrency),
        .testTarget(
            name: "TulaAuthTests", dependencies: ["TulaAuth"], path: "Tests/TulaAuthTests",
            swiftSettings: concurrency),
        .testTarget(
            name: "TulaAuthJourneyTests", dependencies: ["TulaAuth"], path: "Tests/TulaAuthJourneyTests",
            swiftSettings: concurrency),
        .testTarget(
            name: "TulaAuthUITests", dependencies: ["TulaAuthUI"], path: "Tests/TulaAuthUITests",
            swiftSettings: concurrency),
    ]
)
