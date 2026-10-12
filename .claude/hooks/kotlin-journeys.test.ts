import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  clientJourneyListProblems,
  clientSuiteProblems,
  loadClientJourneys,
  loadScenarios,
  notBuilt,
} from '../../packages/conformance/src/index'
import { REFRESH_TIMEOUT_MS } from '../../packages/core/src/session'

// The Kotlin client's journeys run on the JVM, in a CI job of their own (`kotlin`), and not
// in `bun run verify`. What `verify` can hold without a JVM is held here: that the list's
// `kotlin` column and the suite's declarations agree, by the same functions the TypeScript
// suites call, and that the constants the client shares with `@tula/core` are still equal.
// The suite itself checks the same from its side (`GuardTest.kt`), by reflection.

const ROOT = join(import.meta.dir, '..', '..')
const KOTLIN = join(ROOT, 'native/android/tula-auth/src')
const SUITE = join(KOTLIN, 'test/kotlin/dev/tula/auth/journeys/JourneysTest.kt')

interface Declared {
  title: string
  annotations: string
}

/** Every function of a Kotlin test file with the annotations written above it. */
function declared(source: string): Declared[] {
  const found: Declared[] = []
  // A run of annotation lines, then `fun `title``. An argument list holds strings and commas.
  const pattern =
    /((?:^[ \t]*@[A-Za-z]+(?:\((?:"[^"\n]*"|[^()"\n])*\))?[ \t]*\n)+)[ \t]*fun `([^`\n]+)`/gm
  for (const match of source.matchAll(pattern)) {
    found.push({ annotations: match[1] ?? '', title: match[2] ?? '' })
  }
  return found
}

function strings(annotations: string, name: string): string[] {
  const call = new RegExp(`@${name}\\(((?:"[^"\\n]*"|[^()"\\n])*)\\)`).exec(annotations)
  return call ? [...(call[1] ?? '').matchAll(/"([^"\n]*)"/g)].map((match) => match[1] ?? '') : []
}

async function suite() {
  const source = await Bun.file(SUITE).text()
  const journeys = new Map<string, string[]>()
  const behaviours = new Set<string>()
  const tests = declared(source)
  for (const { annotations, title } of tests) {
    for (const scenario of strings(annotations, 'Journey')) {
      journeys.set(scenario, [...(journeys.get(scenario) ?? []), title])
    }
    for (const id of strings(annotations, 'Behaviour')) {
      behaviours.add(id)
    }
  }
  return { source, tests, journeys, behaviours }
}

describe('the Kotlin suite and the client-journey list', () => {
  test('every scenario and every named behaviour has a decision for kotlin', async () => {
    const names = (await loadScenarios()).map(({ scenario }) => scenario.name)
    expect(clientJourneyListProblems(await loadClientJourneys(), names, 'kotlin')).toEqual([])
  })

  test('the list and JourneysTest.kt agree: a test for every journey and behaviour, none for what is not applicable or not built', async () => {
    const { journeys, behaviours } = await suite()
    expect(journeys.size).toBeGreaterThanOrEqual(16)
    expect(
      clientSuiteProblems(await loadClientJourneys(), 'kotlin', { journeys, behaviours })
    ).toEqual([])
  })

  test('what the list says the Kotlin client has not built, ticket by ticket', async () => {
    // A `not_built` entry is a debt: paying one off, or taking one on, changes this too.
    const counts: Record<string, number> = {}
    for (const { ticket } of notBuilt(await loadClientJourneys(), 'kotlin')) {
      counts[ticket] = (counts[ticket] ?? 0) + 1
    }
    expect(counts).toEqual({ 'TULA-57': 52, 'TULA-61': 4 })
  })

  test('a journey or a behaviour of the suite is a test that runs: @Test above it, and nothing in the file is ignored', async () => {
    const { source, tests } = await suite()
    const marked = tests.filter(({ annotations }) => /@(Journey|Behaviour)\(/.test(annotations))
    expect(marked.length).toBeGreaterThanOrEqual(16)
    expect(
      marked.filter(({ annotations }) => !/@Test\b/.test(annotations)).map((t) => t.title)
    ).toEqual([])
    // Every annotation of either kind sits where the scan above reads it.
    expect(source.match(/@(Journey|Behaviour)\(/g)?.length).toBe(marked.length)
    expect(source).not.toMatch(/@Ignore\b|\bassume[A-Z]\w*\(|org\.junit\.Assume/)
  })
})

describe('what the Kotlin client shares with @tula/core', () => {
  test('a refresh gives up after the same time', async () => {
    const session = await Bun.file(join(KOTLIN, 'main/kotlin/dev/tula/auth/Session.kt')).text()
    const value = /const val REFRESH_TIMEOUT_MS(?::\s*Long)?\s*=\s*([0-9_]+)L?/.exec(session)?.[1]
    expect(Number(value?.replaceAll('_', ''))).toBe(REFRESH_TIMEOUT_MS)
  })
})

describe('where the Kotlin suite runs', () => {
  test('CI has a job that runs it, and the script it runs is the one the list names', async () => {
    // The list says the suite `exists`. `verify` has no JVM, so a suite no job ran would be
    // a column of decisions with nothing behind them.
    type Step = { run?: string; uses?: string; with?: Record<string, unknown> }
    const workflow = Bun.YAML.parse(
      await Bun.file(join(ROOT, '.github/workflows/ci.yml')).text()
    ) as { jobs: Record<string, { steps: Step[] } | undefined> }
    const steps = workflow.jobs.kotlin?.steps ?? []
    expect(steps.map((step) => step.run)).toContain('bun run native:kotlin:test')
    const scripts = (await Bun.file(join(ROOT, 'package.json')).json()).scripts
    expect(scripts['native:kotlin:test']).toBe('bun run scripts/kotlin-test.ts')
    // By default the script runs the module's `check`: the tests and the coverage bound.
    expect(await Bun.file(join(ROOT, 'scripts/kotlin-test.ts')).text()).toContain(
      "tasks.length > 0 ? tasks : [':tula-auth:check']"
    )
    const build = await Bun.file(join(ROOT, 'native/android/tula-auth/build.gradle.kts')).text()
    expect(build).toMatch(/tasks\.check \{\s*dependsOn\("koverVerify"\)/)
    expect(Number(/minBound\((\d+)\)/.exec(build)?.[1])).toBeGreaterThanOrEqual(80)
    // A push does all the work itself: nothing of Gradle's is cached between runs.
    expect(steps.filter((step) => step.with && 'cache' in step.with)).toEqual([])
    expect(steps.filter((step) => step.uses?.includes('setup-gradle'))).toEqual([])
  })
})

describe('the fixture the Kotlin suite runs against', () => {
  test('does not start unless it is asked for by name', () => {
    const run = Bun.spawnSync(['bun', 'run', join(ROOT, 'e2e/kotlin-fixture.ts')], {
      env: { ...process.env, KOTLIN_FIXTURE: '' },
      // A child that never exits would hang the run: `spawnSync` blocks the runner's thread.
      timeout: 20_000,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(run.exitCode).not.toBe(0)
    expect(run.stdout.toString()).not.toContain('TULA_FIXTURE_URL=')
    expect(run.stderr.toString()).toContain('KOTLIN_FIXTURE=1')
  })
})
