import Foundation
import XCTest

/// The guard of this suite: the tests it declares and the `swift` column of
/// `conformance/client-journeys.json` agree.
///
/// The rules are not restated here. `native/swift/fixture/journeys.ts` reads these sources and
/// judges them with the functions every client's suite uses (the list's loader, which
/// refuses a key written twice, and the two shared checks); this test runs it and shows what
/// it said.
final class JourneyListTests: XCTestCase {
    func testTheSuiteAndTheClientJourneyListAgree() throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["bun", "run", "native/swift/fixture/journeys.ts"]
        process.currentDirectoryURL = repositoryRoot
        let said = Pipe()
        process.standardOutput = said
        process.standardError = said
        try process.run()
        // The check reads a dozen files and makes no request: a minute is a hang.
        let limit = DispatchWorkItem { process.terminate() }
        DispatchQueue.global().asyncAfter(deadline: .now() + 60, execute: limit)
        let output = said.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        limit.cancel()
        XCTAssertEqual(
            process.terminationStatus, 0,
            "the Swift journeys and conformance/client-journeys.json disagree:\n"
                + (String(data: output, encoding: .utf8) ?? "")
        )
    }
}
