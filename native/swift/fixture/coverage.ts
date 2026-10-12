// The coverage threshold of the Swift client module.
//
//   swift test --package-path native/swift --enable-code-coverage
//   bun run native/swift/fixture/coverage.ts
//
// Reads the report the first command leaves (llvm-cov's JSON export, whose path
// `swift test --show-codecov-path` prints) and fails when the hand-written sources of the
// module are covered below the threshold. The generated types are left out: they are data,
// written and checked by `bun run native:generate` (ADR 0050), and counting them would let
// thousands of covered `Codable` lines hide an uncovered refresh path.

/**
 * The least share of lines, and of functions, the client's own sources are covered to.
 *
 * Functions are held lower than lines: the calls into the system Keychain
 * (`SystemKeychainItems`) are functions no test of this repository runs, because none asks a
 * real Keychain (docs/plans/phase-2-unverified.md).
 */
export const SWIFT_COVERAGE_THRESHOLD = { lines: 0.9, functions: 0.85 } as const

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

/** What a report says of the client's own sources. */
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
 * The coverage of the hand-written sources of `TulaAuth` in an llvm-cov export.
 *
 * @param report - The parsed JSON of `swift test --enable-code-coverage`.
 * @returns The shares for `Sources/TulaAuth/*.swift`, without `Generated/`.
 * @throws Error when the report names no such file: a threshold over nothing would pass.
 */
export function swiftCoverage(report: unknown): SwiftCoverage {
  const files = ((report as { data?: { files?: CoveredFile[] }[] }).data ?? [])
    .flatMap((entry) => entry.files ?? [])
    .filter(({ filename }) => /\/Sources\/TulaAuth\/[^/]+\.swift$/.test(filename))
  if (files.length === 0) {
    throw new Error('the report names no hand-written source of Sources/TulaAuth')
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
  const coverage = swiftCoverage(await report.json())
  const percent = (value: number) => `${(value * 100).toFixed(2)}%`
  for (const file of coverage.files) {
    process.stdout.write(`${percent(file.lines).padStart(8)}  ${file.name}\n`)
  }
  process.stdout.write(
    `lines ${percent(coverage.lines)}, functions ${percent(coverage.functions)} ` +
      `(thresholds ${percent(SWIFT_COVERAGE_THRESHOLD.lines)} and ${percent(SWIFT_COVERAGE_THRESHOLD.functions)})\n`
  )
  process.exit(
    coverage.lines >= SWIFT_COVERAGE_THRESHOLD.lines &&
      coverage.functions >= SWIFT_COVERAGE_THRESHOLD.functions
      ? 0
      : 1
  )
}
