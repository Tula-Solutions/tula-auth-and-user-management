// swift-tools-version:5.9
import PackageDescription

// The Swift SDK (step 2.14). One library, `TulaAuth`: the client with no UI (TULA-37,
// ADR 0051). Everything under Sources/TulaAuth/Generated is written by
// `bun run native:generate` (ADR 0050) and must not be edited by hand; the client is written
// by hand beside that directory. No dependency: Foundation and the Security framework.
//
// Two test targets:
// - TulaAuthTests: unit tests on a fake transport and a fake Keychain. No network, no process.
// - TulaAuthJourneyTests: the client against the real API, which the tests start themselves
//   (`bun` must be on the PATH and `bun install` done at the repository's root). It is the
//   `swift` column of conformance/client-journeys.json.
let concurrency: [SwiftSetting] = [.enableExperimentalFeature("StrictConcurrency")]

let package = Package(
    name: "TulaAuth",
    // iOS 16 is the floor of the plan (docs/plans/phase-2.md); macOS 13 is its contemporary
    // and what `swift test` runs on.
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "TulaAuth", targets: ["TulaAuth"])
    ],
    targets: [
        .target(name: "TulaAuth", path: "Sources/TulaAuth", swiftSettings: concurrency),
        .testTarget(
            name: "TulaAuthTests", dependencies: ["TulaAuth"], path: "Tests/TulaAuthTests",
            swiftSettings: concurrency),
        .testTarget(
            name: "TulaAuthJourneyTests", dependencies: ["TulaAuth"], path: "Tests/TulaAuthJourneyTests",
            swiftSettings: concurrency),
    ]
)
