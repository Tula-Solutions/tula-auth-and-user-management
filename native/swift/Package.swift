// swift-tools-version:5.9
import PackageDescription

// The Swift SDK (step 2.14, TULA-37). Today the target holds only the generated types,
// error codes and theme constants (ADR 0050): everything under Sources/TulaAuth/Generated is
// written by `bun run native:generate` and must not be edited by hand.
let package = Package(
    name: "TulaAuth",
    products: [
        .library(name: "TulaAuth", targets: ["TulaAuth"])
    ],
    targets: [
        .target(name: "TulaAuth", path: "Sources/TulaAuth"),
        .testTarget(name: "TulaAuthTests", dependencies: ["TulaAuth"], path: "Tests/TulaAuthTests"),
    ]
)
