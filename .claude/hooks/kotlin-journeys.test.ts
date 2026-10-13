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

/**
 * What in a Kotlin test file the scan above cannot read past, by line. The scan reads text,
 * so a test inside a comment or a multi-line string would count as one that runs. Rather
 * than parse Kotlin, the file is held to a form in which that cannot happen:
 *
 * - a raw string (`"""`) opens and closes on one line: none spans lines;
 * - a block comment only as documentation: opened by `/**` at the start of a line, every
 *   further line starting with `*`, closed at the end of a line, nothing nested.
 *   A line that starts with `*` is never an annotation or a function to the scan.
 *
 * A line comment hides nothing: its line starts with `//`, and the count of annotations in
 * the file is held equal to the count of those the scan read. A `/*` inside a string or a
 * line comment is refused too: reword it, never this rule.
 */
function unscannable(source: string): string[] {
  const problems: string[] = []
  let documentation = false
  source.split('\n').forEach((line, index) => {
    const at = `line ${index + 1}`
    // A raw string that opens and closes on its line holds no line of its own.
    if ((line.split('"""').length - 1) % 2 === 1) {
      problems.push(`${at}: a raw string that does not end on its line`)
    }
    if (documentation) {
      if (!/^[ \t]*\*/.test(line)) {
        problems.push(`${at}: a line of a block comment that does not start with *`)
      }
      if (line.includes('/*')) {
        problems.push(`${at}: a block comment inside another`)
      }
      if (line.includes('*/')) {
        documentation = false
        if (!/\*\/[ \t]*$/.test(line)) {
          problems.push(`${at}: something after the end of a block comment`)
        }
      }
      return
    }
    const open = line.indexOf('/*')
    if (open === -1) {
      return
    }
    if (!/^[ \t]*\/\*\*/.test(line)) {
      problems.push(`${at}: a block comment that is not documentation at the start of a line`)
    }
    const rest = line.slice(open + 2)
    if (rest.includes('/*')) {
      problems.push(`${at}: a block comment inside another`)
    }
    if (!rest.includes('*/')) {
      documentation = true
    } else if (!/\*\/[ \t]*$/.test(line)) {
      problems.push(`${at}: something after the end of a block comment`)
    }
  })
  if (documentation) {
    problems.push('a block comment that never ends')
  }
  return problems
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
    expect(counts).toEqual({ 'TULA-57': 24, 'TULA-61': 6 })
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

  test('nothing in JourneysTest.kt can hide a test from the scan: no block comment but documentation, no multi-line string', async () => {
    expect(unscannable((await suite()).source)).toEqual([])
  })

  test('the scan refuses a file in which a commented-out journey would count', () => {
    const journey =
      '    @Test\n    @Journey("a scenario")\n    fun `a journey`() = journey {\n    }\n'
    // The form the suite is written in passes.
    expect(
      unscannable(
        `/**\n * What the suite is.\n */\nclass JourneysTest {\n    /** One line. */\n${journey}}\n`
      )
    ).toEqual([])
    // A journey in a block comment: the scan still reads it as declared, which is the hole.
    const hidden = `class JourneysTest {\n    /*\n${journey}    */\n}\n`
    expect(declared(hidden).map(({ title }) => title)).toEqual(['a journey'])
    expect(unscannable(hidden).length).toBeGreaterThan(0)
    // The same behind `/**`, where no line starts with a star.
    expect(unscannable(`/**\n${journey}*/\n`).length).toBeGreaterThan(0)
    const refused = [
      // In a multi-line string.
      `val text = """\n${journey}"""\n`,
      // After a comment that closes mid-line, and in one that opens there.
      `/** x */ val y = 1 /*\n${journey}*/\n`,
      `val y = 1 /* a note */\n`,
      `/**\n * a\n */ @Test\n`,
      // Kotlin nests block comments: the first close would not end the outer one.
      `/**\n * /* inner */\n${journey} */\n`,
      '/**\n * never closed\n',
    ]
    for (const source of refused) {
      expect(`${JSON.stringify(source)}: ${unscannable(source).length > 0}`).toBe(
        `${JSON.stringify(source)}: true`
      )
    }
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

  // A world's secret key opens its admin API. It stays in the fixture's process, as the Swift
  // fixture's does: a journey's admin call is relayed, and no answer hands the key out.
  // The test's own limit is for one process that loads the whole API before it listens.
  test('keeps a world’s secret key to itself and relays an admin call', async () => {
    const fixture = Bun.spawn(['bun', 'run', join(ROOT, 'e2e/kotlin-fixture.ts')], {
      env: { ...process.env, KOTLIN_FIXTURE: '1', KOTLIN_FIXTURE_PORT: '0' },
      // The child is killed below; this ends one that the test lost track of.
      timeout: 40_000,
      stdout: 'pipe',
      stderr: 'ignore',
    })
    try {
      const reader = fixture.stdout.getReader()
      let printed = ''
      while (!printed.includes('\n')) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        printed += new TextDecoder().decode(value)
      }
      reader.releaseLock()
      const base = /^TULA_FIXTURE_URL=(http:\/\/127\.0\.0\.1:\d+)$/m.exec(printed)?.[1] ?? ''
      expect(base).not.toBe('')
      const ask = (path: string, body: unknown) =>
        fetch(`${base}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        })

      const made = await ask('/__test/worlds', {})
      expect(made.status).toBe(201)
      const text = await made.text()
      expect(text).not.toContain('tula_sk_')
      const world = JSON.parse(text) as { id: string }
      expect(Object.keys(world).sort()).toEqual(['id', 'publishableKey'])

      // Without the key the world's admin API is closed, by the API's own rule.
      const direct = await fetch(`${base}/w/${world.id}/v1/admin/settings`, {
        signal: AbortSignal.timeout(10_000),
      })
      expect(direct.status).toBe(401)

      const relayed = await ask(`/__test/worlds/${world.id}/admin`, {
        method: 'GET',
        path: '/v1/admin/settings',
      })
      expect(relayed.status).toBe(200)
      const answer = (await relayed.json()) as {
        status: number
        headers: Record<string, string>
        body: string
      }
      expect(answer.status).toBe(200)
      expect(answer.headers.etag).toBeTruthy()
      expect(JSON.stringify(answer)).not.toContain('tula_sk_')

      // The relay is for the admin API and nothing else, and a caller's own credential
      // never replaces the world's.
      for (const path of [
        '/v1/client/config',
        '/v1/instance/diagnostics',
        'v1/admin/settings',
        '/v1/admin/../client/config',
      ]) {
        const refused = await ask(`/__test/worlds/${world.id}/admin`, { method: 'GET', path })
        expect(refused.status).toBe(422)
      }
      const own = await ask(`/__test/worlds/${world.id}/admin`, {
        method: 'GET',
        path: '/v1/admin/settings',
        headers: { authorization: 'Bearer tula_sk_dev_somebody-elses' },
      })
      expect(own.status).toBe(422)

      // And it is a test route: a page of another origin is refused by the guard.
      const foreign = await fetch(`${base}/__test/worlds/${world.id}/admin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: JSON.stringify({ method: 'GET', path: '/v1/admin/settings' }),
        signal: AbortSignal.timeout(10_000),
      })
      expect(foreign.status).toBe(403)
    } finally {
      fixture.kill()
      await fixture.exited
    }
  }, 60_000)
})

describe('what the documentation tells an app to keep out of its backups', () => {
  test('is the preferences file the storage writes, in both rule files', async () => {
    const storage = await Bun.file(
      join(
        ROOT,
        'native/android/tula-auth-android/src/main/kotlin/dev/tula/auth/android/KeystoreTokenStorage.kt'
      )
    ).text()
    const name = /const val DEFAULT_PREFERENCES_NAME: String = "([^"]+)"/.exec(storage)?.[1]
    expect(name).toBeTruthy()
    // `SharedPreferences` keeps a file `<name>.xml`, and a backup rule names the file.
    const file = `${name}.xml`
    const page = await Bun.file(join(ROOT, 'docs/kotlin.md')).text()
    const samples = [...page.matchAll(/^```xml\n([\s\S]*?)^```$/gm)].map((match) => match[1] ?? '')
    const excluded = (sample: string) =>
      [...sample.matchAll(/<exclude domain="([^"]*)" path="([^"]*)" \/>/g)].map(
        ([, domain, path]) => `${domain}:${path}`
      )
    // Android 12 and later: a cloud backup and a device-to-device transfer, each by itself.
    const extraction = samples.find((sample) => sample.includes('<data-extraction-rules>')) ?? ''
    expect(
      excluded(/<cloud-backup>([\s\S]*?)<\/cloud-backup>/.exec(extraction)?.[1] ?? '')
    ).toEqual([`sharedpref:${file}`])
    expect(
      excluded(/<device-transfer>([\s\S]*?)<\/device-transfer>/.exec(extraction)?.[1] ?? '')
    ).toEqual([`sharedpref:${file}`])
    // Android 11 and earlier.
    const full = samples.find((sample) => sample.includes('<full-backup-content>')) ?? ''
    expect(excluded(full)).toEqual([`sharedpref:${file}`])
    // No sample names another file, and every `<exclude` is of the form read above.
    expect(samples.flatMap(excluded)).toEqual(Array(3).fill(`sharedpref:${file}`))
    expect(page.match(/<exclude /g)?.length).toBe(3)
    // The prose names the same file, and both manifest attributes.
    expect(page).toContain(`(\`${name}\`, unless the app names another)`)
    expect(page).toContain('android:dataExtractionRules="@xml/data_extraction_rules"')
    expect(page).toContain('android:fullBackupContent="@xml/backup_rules"')
  })
})
