import { describe, expect, test } from 'bun:test'
import { SWIFT_COVERAGE_THRESHOLD, swiftCoverage } from '../../native/swift/fixture/coverage'
import {
  SWIFT_NOT_BUILT,
  scanSwiftJourneys,
  swiftJourneyProblems,
} from '../../native/swift/fixture/journeys'
import { loadClientJourneys, notBuilt } from '../../packages/conformance/src/client-journeys'

// The Swift client's journey tests are XCTest methods, which no CI job of `verify` can run (it
// has no Swift toolchain). What `verify` can hold is that the tests the Swift sources declare
// and the `swift` column of conformance/client-journeys.json agree, by the rules every
// client's suite is held to. Whether those tests pass is `swift test` (the `swift` workflow).

const file = (body: string, owner = 'final class FlowJourneys: JourneyTestCase {') => [
  { name: 'Journeys.swift', text: `import XCTest\n\n${owner}\n${body}\n}\n` },
]

const DECLARED = `    func testSignUp() async throws {
        try await journey(
            "sign-up",
            "sign-up: start, verify, signed in"
        ) { s in
            _ = s
        }
    }`

describe('the Swift journeys and the client-journey list', () => {
  test('agree, by the shared checks', async () => {
    expect(await swiftJourneyProblems()).toEqual([])
  })

  test('the number of scenarios the Swift client has not built is the one held', async () => {
    const owed = notBuilt(await loadClientJourneys(), 'swift')
    const total = Object.values(SWIFT_NOT_BUILT).reduce((sum, count) => sum + count, 0)
    expect(owed).toHaveLength(total)
    expect(total).toBe(11)
  })
})

describe('what the scan of the Swift sources reads', () => {
  test('a journey and a behaviour, each the first statement of a test method', () => {
    const suite = scanSwiftJourneys(
      file(`${DECLARED}

    func testBoth() async throws {
        try await journey(["sign-in", "sign-out"], "two scenarios, one test") { s in
            _ = s
        }
    }

    func testConcurrentRefresh() async throws {
        try await behaviour("concurrent_refresh", "ten calls share one refresh") { s in
            _ = s
        }
    }`)
    )
    expect(suite.problems).toEqual([])
    expect([...suite.journeys]).toEqual([
      ['sign-up', ['sign-up: start, verify, signed in']],
      ['sign-in', ['two scenarios, one test']],
      ['sign-out', ['two scenarios, one test']],
    ])
    expect(suite.behaviours).toEqual(['concurrent_refresh'])
  })

  test('the definitions of the two functions are not calls', () => {
    const suite = scanSwiftJourneys([
      {
        name: 'Support.swift',
        text: 'class JourneyTestCase: XCTestCase {\n    func journey(_ scenario: String) {}\n    func behaviour(_ id: String) {}\n}\n',
      },
    ])
    expect(suite.problems).toEqual([])
    expect(suite.journeys.size).toBe(0)
  })

  const refused: [string, string, string?][] = [
    [
      'a call that is not the first statement',
      DECLARED.replace(
        '        try await journey(',
        '        let ready = true\n        try await journey('
      ),
    ],
    ['a method XCTest does not find', DECLARED.replace('func testSignUp', 'func signUp')],
    ['a private method', DECLARED.replace('    func testSignUp', '    private func testSignUp')],
    [
      'a method that takes a parameter',
      DECLARED.replace('testSignUp()', 'testSignUp(_ flag: Bool)'),
    ],
    ['a name that is not a literal', DECLARED.replace('"sign-up",', 'Names.signUp,')],
    ['a name with an interpolation', DECLARED.replace('"sign-up",', '"sign-\\(kind)",')],
    ['a title built at run time', DECLARED.replace('"sign-up: start, verify, signed in"', 'title')],
    [
      'a method of a nested type',
      `    final class Inner {\n${DECLARED.replaceAll('\n', '\n    ').replace(/^/, '    ')}\n    }`,
    ],
    ['a class that is not a journey test case', DECLARED, 'final class Helpers {'],
    ['a method of an extension', DECLARED, 'extension FlowJourneys {'],
    ['a skipped test', `${DECLARED}\n    func testLater() throws { throw XCTSkip("later") }`],
    ['a skip on a condition', DECLARED.replace('_ = s', 'try XCTSkipIf(true)')],
    ['an expected failure', DECLARED.replace('_ = s', 'XCTExpectFailure("known")')],
    ['a conditional compilation block', `#if os(iOS)\n${DECLARED}\n#endif`],
    ['an availability attribute', `    @available(macOS 99, *)\n${DECLARED}`],
    [
      'a chosen set of tests',
      `${DECLARED}\n    override class var defaultTestSuite: XCTestSuite { XCTestSuite(name: "none") }`,
    ],
    ['a swift-testing test', `    @Test(.disabled("later")) func later() {}\n${DECLARED}`],
    ['a declaration inside a block comment', `    /*\n${DECLARED}\n    */`],
    ['a declaration inside a multi-line string', `    let text = """\n${DECLARED}\n    """`],
    [
      'a test case that decides how it is invoked',
      `${DECLARED}\n    override func invokeTest() {}`,
    ],
    ['a test case that overrides its run', `${DECLARED}\n    override func run() {}`],
  ]

  test.each(refused.map(([what, body, owner]) => ({ what, body, owner })))(
    'refuses $what',
    ({ body, owner }) => {
      const suite = scanSwiftJourneys(file(body, owner))
      expect(suite.problems.length).toBeGreaterThan(0)
    }
  )

  test('a declaration a comment hides is a problem, whatever else the scan read', () => {
    const suite = scanSwiftJourneys(file(`    /*\n${DECLARED}\n    */`))
    expect(suite.problems).toEqual([
      'Journeys.swift:4: a block comment can keep a test from running, and a journey is counted where it is declared',
    ])
  })

  test('two test methods of one name are refused', () => {
    const suite = scanSwiftJourneys([...file(DECLARED), ...file(DECLARED)])
    expect(suite.problems).toEqual(['Journeys.swift:5: a second test method is named testSignUp'])
  })
})

describe('the coverage of the Swift client module', () => {
  const entry = (filename: string, lines: [number, number], functions: [number, number]) => ({
    filename,
    summary: {
      lines: { count: lines[0], covered: lines[1] },
      functions: { count: functions[0], covered: functions[1] },
    },
  })

  test('counts the hand-written sources and leaves the generated ones and the tests out', () => {
    const coverage = swiftCoverage({
      data: [
        {
          files: [
            entry('/r/native/swift/Sources/TulaAuth/TulaSession.swift', [100, 90], [10, 8]),
            entry('/r/native/swift/Sources/TulaAuth/TulaFlow.swift', [100, 50], [10, 10]),
            entry(
              '/r/native/swift/Sources/TulaAuth/Generated/Types.swift',
              [9000, 9000],
              [900, 900]
            ),
            entry('/r/native/swift/Tests/TulaAuthTests/Support.swift', [500, 500], [50, 50]),
          ],
        },
      ],
    })
    expect(coverage.lines).toBe(0.7)
    expect(coverage.functions).toBe(0.9)
    expect(coverage.files.map((file) => file.name)).toEqual(['TulaFlow.swift', 'TulaSession.swift'])
  })

  test('a report with none of the client’s sources is refused, not passed', () => {
    expect(() => swiftCoverage({ data: [{ files: [] }] })).toThrow('names no hand-written source')
    expect(() => swiftCoverage({})).toThrow('names no hand-written source')
  })

  test('the thresholds are the ones the docs state', () => {
    expect(SWIFT_COVERAGE_THRESHOLD).toEqual({ lines: 0.9, functions: 0.85 })
  })
})
