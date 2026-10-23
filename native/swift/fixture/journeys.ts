import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type ClientSuite,
  clientJourneyListProblems,
  clientSuiteProblems,
  loadClientJourneys,
  notBuilt,
} from '../../../packages/conformance/src/client-journeys'
import { loadScenarios } from '../../../packages/conformance/src/load'

// What holds the Swift client's journey tests (native/swift/Tests/TulaAuthJourneyTests) and the
// `swift` column of conformance/client-journeys.json to each other.
//
// A Swift test cannot hand its registered tests to `clientSuiteProblems`, so the suite is read
// from its sources: a journey is a `journey("<scenario>", "<title>") { … }` call, a behaviour a
// `behaviour("<id>", "<title>") { … }` call, and each is the first statement of a test method.
// What is read is then judged by the same functions every other client's suite uses
// (`loadClientJourneys`, which refuses a key written twice, `clientJourneyListProblems` and
// `clientSuiteProblems`): there is no second copy of a rule here.
//
//   bun run native/swift/fixture/journeys.ts     prints what is wrong and exits 1, or exits 0
//
// It is run by the Swift suite itself (`JourneyListTests`) and by `bun run test:harness`
// (`.claude/hooks/swift-journeys.test.ts`), so `verify` holds the list on a machine with no
// Swift toolchain.

/** Where the Swift journey tests are. */
export const SWIFT_JOURNEY_TESTS = join(import.meta.dir, '../Tests/TulaAuthJourneyTests')

/**
 * How many scenarios the Swift client has not built, by the ticket that builds them.
 *
 * Held here so that the number shrinks on purpose and never grows unnoticed: a scenario that
 * becomes a journey, and one that is newly `not_built`, both change this table in the same
 * change.
 */
export const SWIFT_NOT_BUILT: Readonly<Record<string, number>> = {
  'TULA-121': 1,
  'TULA-56': 1,
}

/** One Swift source file of the suite. */
export interface SwiftSource {
  /** The file's name, for a message. */
  name: string
  /** Its text. */
  text: string
}

/** What the sources of the Swift suite declare, and what is wrong with how they declare it. */
export interface SwiftSuite extends ClientSuite {
  /** Scenario name → the titles of the tests that cover it. */
  journeys: Map<string, string[]>
  /** The behaviours the suite has a test of. */
  behaviours: string[]
  /** One sentence per declaration that may not run or could not be read. */
  problems: string[]
}

/** A string literal with nothing to evaluate in it: no escape, no interpolation, one line. */
const LITERAL = '"[^"\\\\\\n]*"'

/**
 * A declaration, whole: the test method XCTest finds (not private, not static, no parameter),
 * its first statement the call, both names literals, and the closure opened on the same
 * statement.
 */
const DECLARATION = new RegExp(
  `^ {4}func (test[A-Za-z0-9_]*)\\(\\) async throws \\{\\s*try await (journey|behaviour)\\(\\s*` +
    `(${LITERAL}|\\[\\s*${LITERAL}(?:\\s*,\\s*${LITERAL})*\\s*\\])\\s*,\\s*(${LITERAL})\\s*\\) \\{ [A-Za-z_][A-Za-z0-9_]* in$`,
  'gm'
)

/** Any call of one of the two functions, declared well or not. */
const CALL = /(?<![A-Za-z0-9_])(journey|behaviour)\s*\(/g

/** What makes a test, or part of one, not run. Found anywhere in the suite's sources. */
const MAY_NOT_RUN: readonly [RegExp, string][] = [
  [/\bXCTSkip(If|Unless)?\b/, 'XCTSkip'],
  [/\bXCTExpectFailure\b/, 'XCTExpectFailure'],
  [/^\s*#(if|elseif|else)\b/, 'a conditional compilation block'],
  [/\bdefaultTestSuite\b/, 'defaultTestSuite'],
  [/\btestInvocations\b/, 'testInvocations'],
  [/@available\b/, '@available'],
  [/@(Test|Suite)\b/, 'a swift-testing declaration'],
  [/\.disabled\(/, '.disabled('],
  // The scan reads lines and does not know a comment or a string from code: a declaration
  // inside either would be counted and never run.
  [/\/\*/, 'a block comment'],
  [/"""/, 'a multi-line string'],
  [/\binvokeTest\b/, 'invokeTest'],
  [/\boverride\s+func\s+(run|perform)\b/, 'an override of how a test is run'],
]

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length

/**
 * Read the journeys and behaviours the Swift suite declares.
 *
 * A journey counts from where it is declared, so a declaration has one form and everything
 * else is a problem: a call that is not the first statement of a `func test…() async throws`
 * method, a name that is not a plain string literal, a test class that is not a
 * `JourneyTestCase`, and anything in the suite's sources that can keep a test from running
 * (`XCTSkip`, `XCTExpectFailure`, `#if`, `@available`, `defaultTestSuite`, …). It is a scan
 * of the text: reword a comment or a string it finds, never the scan.
 *
 * What it cannot see: a `return` or a thrown error inside a journey's own body, a helper
 * that does not call the closure it is given, and a `swift test --filter` on a command
 * line. The CI job and the documented command run the whole suite.
 *
 * @param sources - Every Swift file of the journey test target.
 * @returns The suite, and what is wrong with its declarations.
 */
export function scanSwiftJourneys(sources: readonly SwiftSource[]): SwiftSuite {
  const journeys = new Map<string, string[]>()
  const behaviours = new Set<string>()
  const problems: string[] = []
  const methods = new Set<string>()

  for (const { name, text } of sources) {
    text.split('\n').forEach((line, index) => {
      for (const [pattern, what] of MAY_NOT_RUN) {
        if (pattern.test(line)) {
          problems.push(
            `${name}:${index + 1}: ${what} can keep a test from running, and a journey is counted where it is declared`
          )
        }
      }
    })

    const declared = new Set<number>()
    for (const match of text.matchAll(DECLARATION)) {
      const [whole, method, kind, names, title] = match as unknown as [
        string,
        string,
        string,
        string,
        string,
      ]
      const at = match.index + whole.indexOf(`${kind}(`)
      declared.add(at)
      const where = `${name}:${lineOf(text, at)}`
      const owner = [
        ...text
          .slice(0, match.index)
          .matchAll(/^(?:[a-z]+ )*(?:class|extension|struct|actor|enum) .*$/gm),
      ].at(-1)?.[0]
      if (owner === undefined || !/^final class [A-Za-z0-9_]+: JourneyTestCase \{$/.test(owner)) {
        problems.push(
          `${where}: ${method} is not a method of a "final class …: JourneyTestCase", so nothing says XCTest runs it`
        )
      }
      if (methods.has(method)) {
        problems.push(`${where}: a second test method is named ${method}`)
      }
      methods.add(method)
      const named = [...names.matchAll(new RegExp(LITERAL, 'g'))].map(([literal]) =>
        literal.slice(1, -1)
      )
      for (const id of named) {
        if (kind === 'behaviour') {
          behaviours.add(id)
        } else {
          journeys.set(id, [...(journeys.get(id) ?? []), title.slice(1, -1)])
        }
      }
    }

    for (const call of text.matchAll(CALL)) {
      const before = text.slice(0, call.index)
      if (declared.has(call.index) || /\bfunc\s+$/.test(before)) {
        continue
      }
      problems.push(
        `${name}:${lineOf(text, call.index)}: ${call[1]}( is not declared as the first statement of a ` +
          '"func test…() async throws" method with its names as plain string literals, so it cannot be counted'
      )
    }
  }
  return { journeys, behaviours: [...behaviours], problems }
}

/**
 * Everything that is wrong between the Swift suite and the client-journey list.
 *
 * @param directory - The journey test target (default: the repository's).
 * @param listPath - The list (default: `/conformance/client-journeys.json`).
 * @returns One sentence per problem; empty when the suite and the list agree.
 */
export async function swiftJourneyProblems(
  directory: string = SWIFT_JOURNEY_TESTS,
  listPath?: string
): Promise<string[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.swift')).sort()
  const sources = await Promise.all(
    names.map(async (name) => ({ name, text: await Bun.file(join(directory, name)).text() }))
  )
  const suite = scanSwiftJourneys(sources)
  const list = await loadClientJourneys(listPath)
  const scenarios = (await loadScenarios()).map(({ scenario }) => scenario.name)

  const owed = new Map<string, number>()
  for (const { ticket } of notBuilt(list, 'swift')) {
    owed.set(ticket, (owed.get(ticket) ?? 0) + 1)
  }
  const counts: string[] = []
  for (const ticket of new Set([...owed.keys(), ...Object.keys(SWIFT_NOT_BUILT)])) {
    const listed = owed.get(ticket) ?? 0
    const held = Object.hasOwn(SWIFT_NOT_BUILT, ticket) ? SWIFT_NOT_BUILT[ticket] : 0
    if (listed !== held) {
      counts.push(
        `the list has ${listed} scenarios not_built for swift under ${ticket}, and SWIFT_NOT_BUILT ` +
          `(native/swift/fixture/journeys.ts) holds ${held}: change both in the same change`
      )
    }
  }
  return [
    ...suite.problems,
    ...clientJourneyListProblems(list, scenarios, 'swift'),
    ...clientSuiteProblems(list, 'swift', suite),
    ...counts,
  ]
}

if (import.meta.main) {
  const problems = await swiftJourneyProblems()
  for (const problem of problems) {
    process.stderr.write(`${problem}\n`)
  }
  if (problems.length === 0) {
    process.stdout.write('the Swift journeys and conformance/client-journeys.json agree\n')
  }
  process.exit(problems.length === 0 ? 0 : 1)
}
