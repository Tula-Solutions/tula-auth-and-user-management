import Foundation
import XCTest

@testable import TulaAuth

/// The shared vectors of `@tula-tech/contract`, run on the Swift hash. The expected values were
/// computed with `node:crypto` (the TS test does the same), not by this code.
final class PermissionsHashTests: XCTestCase {
    private let expected = [
        "empty": "1.T1PNoYwrqgwDVLtfmj7L5e0Sq02OEbqHPC8RFhICuUU",
        "one key": "1.sonRRYVwmHSoL4KzrNsxB848gpXsR38DeIz2S4UwFN0",
        "unsorted": "1.kdxxYipIfD1CwKEWlHHKHTjlXSfyvyL0MCO13LC5oy0",
        "duplicates": "1.lpKYugZ8Jj_zXw0qw_1iV1uMUdrW1e7RajXdaKNNQGU",
        "code point order": "1.pBg77BDyzcUFJtyIOJIfrfWD443falmIdFuhpFxHSOU",
        "1000 keys": "1.EtT2o60HPgHeGHxhFnuKr60vczqfXZz0l6pVBM0pnbE",
    ]

    func testEverySharedVectorHashesAsTheReferenceDoes() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(
            contentsOf: root.appendingPathComponent("packages/contract/src/permissions-hash-vectors.json"))
        struct Vector: Decodable { let name: String; let keys: [String] }
        struct File: Decodable { let vectors: [Vector] }
        let vectors = try JSONDecoder().decode(File.self, from: data).vectors
        XCTAssertEqual(Set(vectors.map(\.name)), Set(expected.keys))
        for vector in vectors {
            XCTAssertEqual(permissionsHash(vector.keys), expected[vector.name], vector.name)
        }
    }
}
