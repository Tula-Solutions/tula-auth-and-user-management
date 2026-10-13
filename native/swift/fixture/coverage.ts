// The coverage threshold of the Swift modules.
//
//   swift test --package-path native/swift --enable-code-coverage
//   bun run native/swift/fixture/coverage.ts
//
// Reads the report the first command leaves (llvm-cov's JSON export, whose path
// `swift test --show-codecov-path` prints) and fails when the hand-written sources of a
// module are covered below the threshold. The generated types are left out: they are data,
// written and checked by `bun run native:generate` (ADR 0050), and counting them would let
// thousands of covered `Codable` lines hide an uncovered refresh path.
//
// Two modules are held, each alone to the same threshold, so that neither can hide the
// other: `TulaAuth` (the client) and `TulaAuthUI` (the screens). Of `TulaAuthUI` what counts
// is what decides something: the model behind the screens, the table of strings and the
// theme's road from a string to a colour, which are the files directly in its directory.
// `Sources/TulaAuthUI/Views/` is left out, as `Generated/` is, and for a stated reason: a
// SwiftUI `body` is run by SwiftUI when a view is on a screen, and `swift test` on a Mac has
// no screen, so its lines would be counted as uncovered whatever is tested. The views hold
// no decision (ADR 0057); they are run by the UI tests on a simulator
// (`bun run native/swift/fixture/ui-tests.ts`), which report no coverage here.

/**
 * The least share of lines, and of functions, a module's own sources are covered to.
 *
 * Functions are held lower than lines: the calls into the system Keychain
 * (`SystemKeychainItems`) are functions no test of this repository runs, because none asks a
 * real Keychain (docs/plans/phase-2-unverified.md).
 */
export const SWIFT_COVERAGE_THRESHOLD = { lines: 0.9, functions: 0.85 } as const

/** The modules whose hand-written sources are held to the threshold, each alone. */
export const SWIFT_COVERED_MODULES = ['TulaAuth', 'TulaAuthUI'] as const

/** A module of {@link SWIFT_COVERED_MODULES}. */
export type SwiftCoveredModule = (typeof SWIFT_COVERED_MODULES)[number]

/** A count of llvm-cov's export. */
interface Count {
  count: number
  covered: number
}

/** One file of llvm-cov's export, as far as it is read. */
interface CoveredFile {
  filename: string
  summary: { lines: Count; functions: Count }
}

/** What a report says of a module's own sources. */
export interface SwiftCoverage {
  /** The share of lines covered, 0 to 1. */
  lines: number
  /** The share of functions covered, 0 to 1. */
  functions: number
  /** Each file and its share of lines, least covered first. */
  files: { name: string; lines: number }[]
}

const share = ({ count, covered }: Count) => (count === 0 ? 1 : covered / count)

/**
 * The coverage of the hand-written sources of one module in an llvm-cov export.
 *
 * @param report - The parsed JSON of `swift test --enable-code-coverage`.
 * @param module - The module: `TulaAuth` (the default) or `TulaAuthUI`.
 * @returns The shares for the files directly in `Sources/<module>/`: without `Generated/`
 *   and without `Views/`.
 * @throws Error when the report names no such file: a threshold over nothing would pass.
 */
export function swiftCoverage(
  report: unknown,
  module: SwiftCoveredModule = 'TulaAuth'
): SwiftCoverage {
  const own = `/Sources/${module}/`
  const files = ((report as { data?: { files?: CoveredFile[] }[] }).data ?? [])
    .flatMap((entry) => entry.files ?? [])
    .filter(({ filename }) => {
      const at = filename.lastIndexOf(own)
      const rest = at < 0 ? '' : filename.slice(at + own.length)
      return rest.endsWith('.swift') && !rest.includes('/')
    })
  if (files.length === 0) {
    throw new Error(`the report names no hand-written source of Sources/${module}`)
  }
  const total = (pick: (file: CoveredFile) => Count) =>
    share(
      files.reduce(
        (sum, file) => ({
          count: sum.count + pick(file).count,
          covered: sum.covered + pick(file).covered,
        }),
        { count: 0, covered: 0 }
      )
    )
  return {
    lines: total((file) => file.summary.lines),
    functions: total((file) => file.summary.functions),
    files: files
      .map((file) => ({
        name: file.filename.split('/').at(-1) as string,
        lines: share(file.summary.lines),
      }))
      .sort((a, b) => a.lines - b.lines),
  }
}

if (import.meta.main) {
  const asked = Bun.spawnSync(
    ['swift', 'test', '--package-path', 'native/swift', '--show-codecov-path'],
    { timeout: 120_000 }
  )
  const path = process.argv[2] ?? asked.stdout.toString().trim()
  const report = Bun.file(path)
  if (!(await report.exists())) {
    process.stderr.write(
      'no coverage report: run `swift test --package-path native/swift --enable-code-coverage` first\n'
    )
    process.exit(1)
  }
  const parsed = await report.json()
  const percent = (value: number) => `${(value * 100).toFixed(2)}%`
  let held = true
  for (const module of SWIFT_COVERED_MODULES) {
    const coverage = swiftCoverage(parsed, module)
    for (const file of coverage.files) {
      process.stdout.write(`${percent(file.lines).padStart(8)}  ${file.name}\n`)
    }
    process.stdout.write(
      `${module}: lines ${percent(coverage.lines)}, functions ${percent(coverage.functions)} ` +
        `(thresholds ${percent(SWIFT_COVERAGE_THRESHOLD.lines)} and ${percent(SWIFT_COVERAGE_THRESHOLD.functions)})\n`
    )
    held &&=
      coverage.lines >= SWIFT_COVERAGE_THRESHOLD.lines &&
      coverage.functions >= SWIFT_COVERAGE_THRESHOLD.functions
  }
  process.exit(held ? 0 : 1)
}
