import { describe, expect, test } from 'bun:test'
import {
  SWIFT_COVERAGE_THRESHOLD,
  SWIFT_COVERED_MODULES,
  swiftCoverage,
} from '../../native/swift/fixture/coverage'
import {
  SWIFT_NOT_BUILT,
  scanSwiftJourneys,
  swiftJourneyProblems,
} from '../../native/swift/fixture/journeys'
import { pickSimulator, readyPort, xcodebuildArguments } from '../../native/swift/fixture/ui-tests'
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
    expect(total).toBe(5)
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

  test('the screens’ module is held alone, and its views are left out like the generated types', () => {
    const report = {
      data: [
        {
          files: [
            entry('/r/native/swift/Sources/TulaAuth/TulaSession.swift', [1000, 1000], [100, 100]),
            entry('/r/native/swift/Sources/TulaAuthUI/TulaAuthModel.swift', [100, 80], [10, 9]),
            entry('/r/native/swift/Sources/TulaAuthUI/TulaStrings.swift', [100, 100], [10, 10]),
            entry('/r/native/swift/Sources/TulaAuthUI/Views/TulaAuthView.swift', [900, 0], [90, 0]),
            entry('/r/native/swift/Tests/TulaAuthUITests/Support.swift', [500, 500], [50, 50]),
          ],
        },
      ],
    }
    const screens = swiftCoverage(report, 'TulaAuthUI')
    // A fully covered client does not lift the screens' share, and a view counts for neither.
    expect(screens.lines).toBe(0.9)
    expect(screens.functions).toBe(0.95)
    expect(screens.files.map((file) => file.name)).toEqual([
      'TulaAuthModel.swift',
      'TulaStrings.swift',
    ])
    expect(swiftCoverage(report).files.map((file) => file.name)).toEqual(['TulaSession.swift'])
    expect(SWIFT_COVERED_MODULES).toEqual(['TulaAuth', 'TulaAuthUI'])
  })

  test('a report with only views of the screens’ module is refused, not passed', () => {
    const report = {
      data: [
        {
          files: [
            entry('/r/native/swift/Sources/TulaAuth/TulaSession.swift', [10, 10], [1, 1]),
            entry('/r/native/swift/Sources/TulaAuthUI/Views/TulaAuthView.swift', [10, 10], [1, 1]),
          ],
        },
      ],
    }
    expect(() => swiftCoverage(report, 'TulaAuthUI')).toThrow('Sources/TulaAuthUI')
  })
})

describe('the run of the SwiftUI screens’ UI tests', () => {
  const list = {
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-18-5': [
        { udid: 'B', name: 'iPhone 16 Pro', isAvailable: true },
        { udid: 'A', name: 'iPhone 16' },
        { udid: 'P', name: 'iPad Air', isAvailable: true },
      ],
      'com.apple.CoreSimulator.SimRuntime.iOS-18-10': [
        { udid: 'GONE', name: 'iPhone 15', isAvailable: false },
      ],
      'com.apple.CoreSimulator.SimRuntime.iOS-17-9': [{ udid: 'OLD', name: 'iPhone 15' }],
      'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [{ udid: 'W', name: 'iPhone Watch' }],
    },
  }

  test('picks an available iPhone of the newest iOS runtime that has one, the first by name', () => {
    expect(pickSimulator(list)).toEqual({ udid: 'A', name: 'iPhone 16', version: '18.5' })
  })

  test('orders runtime versions by number, not by text', () => {
    const picked = pickSimulator({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-18-9': [{ udid: 'NINE', name: 'iPhone 16' }],
        'com.apple.CoreSimulator.SimRuntime.iOS-18-10': [{ udid: 'TEN', name: 'iPhone 16' }],
      },
    })
    expect(picked?.udid).toBe('TEN')
  })

  test('answers nothing where the machine has no iPhone simulator', () => {
    expect(pickSimulator({})).toBeNull()
    expect(
      pickSimulator({ devices: { 'com.apple.CoreSimulator.SimRuntime.tvOS-18-0': [] } })
    ).toBeNull()
  })

  test('runs one test at a time on the simulator it was given, and passes the rest on', () => {
    const args = xcodebuildArguments('UDID-1', '/tmp/derived', ['-only-testing:T/C/testX'])
    expect(args.slice(0, 2)).toEqual(['xcodebuild', 'test'])
    expect(args[args.indexOf('-destination') + 1]).toBe('platform=iOS Simulator,id=UDID-1')
    expect(args[args.indexOf('-derivedDataPath') + 1]).toBe('/tmp/derived')
    expect(args[args.indexOf('-parallel-testing-enabled') + 1]).toBe('NO')
    expect(args.at(-1)).toBe('-only-testing:T/C/testX')
  })

  /** The text of every `Bun.spawn(…)` and `Bun.spawnSync(…)` call, to its closing parenthesis. */
  function spawnCalls(source: string): string[] {
    const calls: string[] = []
    for (const match of source.matchAll(/Bun\.spawn(?:Sync)?\(/g)) {
      const open = match.index + match[0].length
      let depth = 1
      let end = open
      while (end < source.length && depth > 0) {
        const character = source[end]
        depth += character === '(' ? 1 : character === ')' ? -1 : 0
        end += 1
      }
      calls.push(source.slice(match.index, end))
    }
    return calls
  }

  test('the scan of spawn calls finds both kinds, each whole', () => {
    const calls = spawnCalls(
      "Bun.spawnSync(['a', f(1)], { timeout: 1 })\nconst x = Bun.spawn(['b'], {\n  cwd: g(),\n})\n"
    )
    expect(calls).toEqual([
      "Bun.spawnSync(['a', f(1)], { timeout: 1 })",
      "Bun.spawn(['b'], {\n  cwd: g(),\n})",
    ])
  })

  test('every Bun.spawn and Bun.spawnSync call of the run names a timeout among its arguments', async () => {
    const source = await Bun.file(
      new URL('../../native/swift/fixture/ui-tests.ts', import.meta.url)
    ).text()
    const calls = spawnCalls(source)
    // The question to simctl, the fixture and xcodebuild.
    expect(calls.length).toBe(3)
    expect(calls.filter((call) => !/\btimeout: [A-Z_]+_TIMEOUT_MS\b/.test(call))).toEqual([])
  })

  test('the fixture keeps its guard, and is ended in a finally and on a signal', async () => {
    const source = await Bun.file(
      new URL('../../native/swift/fixture/ui-tests.ts', import.meta.url)
    ).text()
    expect(source).toContain("TULA_NATIVE_FIXTURE: '1'")
    expect(source).toMatch(/finally \{\s+stop\(\)/)
    // One list is what the handlers are put on: a signal named only in a comment or in
    // the table of exit codes would not be listened for.
    expect(source).toContain("for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'] as const)")
    expect(source).toMatch(/process\.on\(signal, \(\) => \{\s+stop\(\)/)
  })

  test('the fixture’s line is read whole, however it is cut, and waited for no longer than said', async () => {
    const encode = (text: string) => new TextEncoder().encode(text)
    const cut = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encode('{"po'))
        controller.enqueue(encode('rt":51'))
        controller.enqueue(encode('234}\nlater output\n'))
        controller.close()
      },
    })
    expect(await readyPort(cut, 1_000)).toBe(51234)

    const ended = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encode('{"port":51'))
        controller.close()
      },
    })
    expect(await readyPort(ended, 1_000)).toBeNull()

    const other = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encode('something else\n{"port":1}\n'))
      },
    })
    expect(await readyPort(other, 1_000)).toBeNull()

    const silent = new ReadableStream<Uint8Array>({ start() {} })
    const before = Date.now()
    expect(await readyPort(silent, 50)).toBeNull()
    expect(Date.now() - before).toBeLessThan(900)
  })

  test('what the fixture prints after its line is read and dropped, so that it never waits on a full pipe', async () => {
    let pulled = 0
    const chatty = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled += 1
          if (pulled === 1) {
            controller.enqueue(new TextEncoder().encode('{"port":4000}\n'))
          } else if (pulled <= 20) {
            controller.enqueue(new Uint8Array(1024))
          } else {
            controller.close()
          }
        },
      },
      { highWaterMark: 0 }
    )
    expect(await readyPort(chatty, 1_000)).toBe(4000)
    for (let turn = 0; turn < 100 && pulled < 21; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(pulled).toBe(21)
  })
})
