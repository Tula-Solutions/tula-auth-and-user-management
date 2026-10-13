import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Step = {
  id?: string
  name?: string
  if?: string
  uses?: string
  run?: string
  with?: Record<string, unknown>
}
type Job = {
  needs?: string | string[]
  if?: string
  permissions?: Record<string, string>
  env?: Record<string, string>
  steps: Step[]
}
type Workflow = { jobs: Record<string, Job> }

const workflowsDir = join(import.meta.dir, '..', '..', '.github', 'workflows')
const source = readFileSync(join(workflowsDir, 'ci.yml'), 'utf8')
const { jobs } = Bun.YAML.parse(source) as Workflow

const job = (name: string) => jobs[name] ?? { steps: [] }
const needs = (name: string) => [job(name).needs ?? []].flat()
// The jobs that check something: every one but the two that decide and record.
const checks = Object.keys(jobs).filter((name) => name !== 'duplicate' && name !== 'passed')
const SKIPPABLE = "needs.duplicate.outputs.skip != 'true'"

/** The script of the step that decides whether the run is a duplicate. */
const look = () => job('duplicate').steps.find((step) => step.id === 'look')?.run ?? ''
const uses = (name: string, action: string) =>
  job(name).steps.filter((step) => step.uses?.startsWith(action))

// CI skips a run whose exact tree a push has already passed (the `duplicate` and `passed`
// jobs of ci.yml). A mistake there is a green run that checked nothing, so the rules it rests
// on are held here.
describe('skipping a run whose tree already passed', () => {
  test('there are jobs to skip', () => {
    expect(checks.length).toBeGreaterThanOrEqual(3)
  })

  test.each(checks)('%s waits for the decision and follows it', (name) => {
    expect(needs(name)).toContain('duplicate')
    expect(job(name).if).toBe(SKIPPABLE)
  })

  test('the pass is recorded only after every other job', () => {
    expect(needs('passed').sort()).toEqual(['duplicate', ...checks].sort())
  })

  test('the pass is recorded only by a push whose jobs all ran and succeeded', () => {
    // No status function: one would replace the implicit "every needed job succeeded".
    expect(job('passed').if).toBe(`${SKIPPABLE} && github.event_name == 'push'`)
  })

  test('no job or step may fail and still count as passed', () => {
    // `continue-on-error` makes a failed job read as a success to the jobs that need it.
    expect(source).not.toContain('continue-on-error')
  })

  test('the marker is named after the tree, on both sides', () => {
    expect(look()).toContain("tree=$(git rev-parse 'HEAD^{tree}')")
    expect(look()).toContain('artifacts?name=ci-passed-$tree&')
    const [upload, ...others] = uses('passed', 'actions/upload-artifact@')
    expect(others).toEqual([])
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a template
    expect(upload?.with?.name).toBe('ci-passed-${{ needs.duplicate.outputs.tree }}')
  })

  test('nothing else in any workflow writes a marker', () => {
    const writers = readdirSync(workflowsDir)
      .filter((file) => /\.ya?ml$/.test(file))
      .flatMap((file) => {
        const workflow = Bun.YAML.parse(readFileSync(join(workflowsDir, file), 'utf8')) as Workflow
        return Object.entries(workflow.jobs).flatMap(([name, { steps }]) =>
          steps
            .filter((step) => String(step.with?.name ?? '').includes('ci-passed'))
            .map(() => `${file}:${name}`)
        )
      })
    expect(writers).toEqual(['ci.yml:passed'])
  })

  test('a marker that expired, or that a fork’s run wrote, is not believed', () => {
    expect(look()).toContain(
      '.expired == false and .workflow_run.head_repository_id == (env.REPOSITORY_ID | tonumber)'
    )
  })

  test('the two jobs hold no more than read access', () => {
    expect(job('duplicate').permissions).toEqual({ contents: 'read', actions: 'read' })
    expect(job('passed').permissions).toBeUndefined()
    expect(source).toContain('\npermissions:\n  contents: read\n')
  })
})

// A push is what vouches for a tree, so a push must do all the work itself.
describe('the Turborepo cache', () => {
  test('only a pull request reads it, and only a push saves it', () => {
    const [restore, ...moreRestores] = uses('verify', 'actions/cache/restore@')
    const [save, ...moreSaves] = uses('verify', 'actions/cache/save@')
    expect([moreRestores, moreSaves]).toEqual([[], []])
    expect(restore?.if).toBe("github.event_name == 'pull_request'")
    expect(save?.if).toBe("github.event_name == 'push'")
    expect(restore?.with?.path).toBe('.turbo/cache')
    expect(save?.with?.path).toBe('.turbo/cache')
  })

  test('no step restores and saves in one go, and no other job has a cache', () => {
    for (const name of Object.keys(jobs)) {
      expect(uses(name, 'actions/cache@')).toEqual([])
      if (name !== 'verify') {
        expect(uses(name, 'actions/cache')).toEqual([])
      }
    }
  })

  test('the cache is saved after the checks it records', () => {
    const steps = job('verify').steps
    const verify = steps.findIndex((step) => step.run === 'bun run verify')
    expect(verify).toBeGreaterThan(-1)
    expect(steps.findIndex((step) => step.uses?.startsWith('actions/cache/restore@'))).toBeLessThan(
      verify
    )
    expect(steps.findIndex((step) => step.uses?.startsWith('actions/cache/save@'))).toBeGreaterThan(
      verify
    )
  })
})

// TULA-52: a webhook delivered by the worker running as a service of its own.
describe('the self-host run with the worker as its own service', () => {
  const steps = () => job('self-host-worker').steps
  const scripts = () => steps().map((step) => step.run ?? '')
  const indexOf = (text: string) => scripts().findIndex((script) => script.includes(text))
  const COMPOSE =
    'docker compose -f docker-compose.yml -f docker/worker-check/compose.yml --profile app --profile worker'

  test('every container is told the worker is separate, and nothing else is changed', () => {
    // No `ENVIRONMENT` and nothing that loosens the outbound guard: the stack runs in the
    // tier the other self-host jobs run in, and the receiver is reached within its rules.
    expect(Object.keys(job('self-host-worker').env ?? {}).sort()).toEqual([
      'TULA_MASTER_KEY',
      'WEBHOOK_WORKER',
    ])
    expect(job('self-host-worker').env?.WEBHOOK_WORKER).toBe('separate')
  })

  test('the stack is started without the worker: the check has to see nothing delivered first', () => {
    const start = indexOf('up -d --build')
    expect(start).toBeGreaterThan(-1)
    expect(scripts()[start]).toContain('--profile app up -d --build')
    expect(scripts()[start]).not.toContain('--profile worker')
    // The check starts the worker itself, after it has seen the event wait.
    expect(scripts().filter((script) => /up -d[^\n]*\bworker\b/.test(script))).toEqual([])
  })

  test('the check runs against that stack, with the receiver’s file laid over it', () => {
    const check = indexOf('scripts/worker-check/check.ts')
    expect(check).toBeGreaterThan(indexOf('up -d --build'))
    expect(scripts()[check]).toContain(`bun run scripts/worker-check/check.ts -- ${COMPOSE}`)
    // Its exit code is the step's: nothing after it on the line, nothing that swallows it.
    expect(scripts()[check]).not.toMatch(/check\.ts[^\n]*(\|\||\|\s|;)/)
  })

  test('the instance token is generated for the run, never written in the workflow', () => {
    const token = indexOf('TULA_ADMIN_TOKEN=')
    expect(token).toBeGreaterThan(-1)
    expect(token).toBeLessThan(indexOf('up -d --build'))
    expect(scripts()[token]).toContain('openssl rand -hex 32')
    expect(scripts()[token]).toContain('::add-mask::')
  })

  test('the conformance run still names the scenarios it skips, all nine', () => {
    // The worker job replaces none of that: a receiver on the runner is still out of reach
    // for a server in a container, and the skip is still checked by name. The ninth waits a
    // day, which a live server cannot be made to do.
    const run = job('self-host').steps.find((step) => step.run?.includes('bun run conformance'))
    for (const name of [
      'claims added by a hook',
      'hook that times out',
      'password expiry',
      'sign-in denied by a hook',
      'sign-in hook that times out',
      'sign-up denied by a hook',
      'webhook delivered and signed',
      'webhook retried after a 500',
      'webhook secret rotated with an overlap',
    ]) {
      expect(run?.run).toContain(`'${name}'`)
    }
    expect(run?.run).toContain('if [ "$skipped" != "$expected" ]; then')
    // And the count in both summary lines is the list's own.
    expect(run?.run?.match(/ 0 failed, 9 skipped against /g)).toHaveLength(2)
  })
})

// The decision itself, run as the workflow runs it, with `gh` and `git` replaced by stubs.
describe('the decision', () => {
  let dir = ''

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tula-ci-'))
    // `gh` answers what the test says the API would, and can be made to fail.
    writeFileSync(
      join(dir, 'gh'),
      '#!/bin/sh\nprintf "%s\\n" "$STUB_GH_ANSWER"\nexit "$STUB_GH_EXIT"\n'
    )
    writeFileSync(join(dir, 'git'), '#!/bin/sh\necho 0123456789abcdef0123456789abcdef01234567\n')
    chmodSync(join(dir, 'gh'), 0o755)
    chmodSync(join(dir, 'git'), 0o755)
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function decide(event: string, ref: string, answer: string, exit = 0) {
    const output = join(dir, `output-${crypto.randomUUID()}`)
    writeFileSync(output, '')
    const result = Bun.spawnSync(['bash', '-euo', 'pipefail', '-c', look()], {
      env: {
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        GITHUB_OUTPUT: output,
        GITHUB_EVENT_NAME: event,
        GITHUB_REF: ref,
        GITHUB_REPOSITORY: 'owner/repository',
        REPOSITORY_ID: '1',
        STUB_GH_ANSWER: answer,
        STUB_GH_EXIT: String(exit),
      },
      timeout: 10_000,
    })
    return { exitCode: result.exitCode, output: readFileSync(output, 'utf8') }
  }

  const TREE = 'tree=0123456789abcdef0123456789abcdef01234567\n'

  test.each([
    [
      'a pull request whose tree has a marker',
      'pull_request',
      'refs/pull/7/merge',
      'true',
      0,
      true,
    ],
    ['a push to develop whose tree has a marker', 'push', 'refs/heads/develop', 'true', 0, true],
    ['a tree with no marker', 'pull_request', 'refs/pull/7/merge', 'false', 0, false],
    ['a lookup that fails', 'pull_request', 'refs/pull/7/merge', '', 1, false],
    ['a lookup that fails after answering', 'push', 'refs/heads/develop', 'true', 1, false],
    ['an answer that is not exactly "true"', 'push', 'refs/heads/develop', 'true-ish', 0, false],
    ['a push to main, marker or not', 'push', 'refs/heads/main', 'true', 0, false],
  ])('%s: skip is %p', (_case, event, ref, answer, exit, skip) => {
    const { exitCode, output } = decide(event, ref, answer, exit)
    expect(exitCode).toBe(0)
    expect(output).toBe(`${TREE}skip=${skip}\n`)
  })

  test('a pull request into main is not a push to main, and may be skipped', () => {
    expect(decide('pull_request', 'refs/heads/main', 'true').output).toBe(`${TREE}skip=true\n`)
  })
})

// The Kotlin client has two modules and two jobs (ADR 0054). The JVM tests are what shows
// the client works; the Android module is only compiled and linted. In one job a problem
// with the runner's Android SDK failed both, and a red job said nothing about the tests.
describe('the Kotlin client: the JVM tests and the Android build are read apart', () => {
  const runs = (name: string) => job(name).steps.map((step) => step.run ?? '')
  const androidBuild = /tula-auth-android|assemble|lint/

  test('they are two jobs', () => {
    expect(Object.keys(jobs)).toContain('kotlin')
    expect(Object.keys(jobs)).toContain('kotlin-android')
    expect(runs('kotlin').filter((run) => run.includes('native:kotlin:test')).length).toBe(1)
    expect(runs('kotlin').filter((run) => androidBuild.test(run))).toEqual([])
    expect(runs('kotlin-android').filter((run) => run.includes('native:kotlin:test'))).toEqual([])
    expect(runs('kotlin-android').filter((run) => androidBuild.test(run)).length).toBe(1)
    // Neither waits for the other, and the pass is recorded only after both.
    expect(needs('kotlin')).toEqual(['duplicate'])
    expect(needs('kotlin-android')).toEqual(['duplicate'])
    expect(needs('passed')).toContain('kotlin')
    expect(needs('passed')).toContain('kotlin-android')
  })

  test('the JVM tests run with no Android SDK named, so the build has the JVM module alone', () => {
    const tests = job('kotlin').steps.find((step) => step.run === 'bun run native:kotlin:test') as
      | (Step & { env?: Record<string, string> })
      | undefined
    expect(tests?.env).toEqual({ ANDROID_HOME: '', ANDROID_SDK_ROOT: '' })
    const settings = readFileSync(
      join(workflowsDir, '..', '..', 'native/android/settings.gradle.kts'),
      'utf8'
    )
    // An empty variable names no SDK: without this the module would still be included.
    for (const name of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
      expect(settings).toContain(
        `providers.environmentVariable("${name}").orNull?.takeIf { it.isNotBlank() }`
      )
    }
  })

  test('the Android job installs, by name, the platform and build tools the module pins, before it builds', () => {
    const build = readFileSync(
      join(workflowsDir, '..', '..', 'native/android/tula-auth-android/build.gradle.kts'),
      'utf8'
    )
    const major = /version = release\((\d+)\)/.exec(build)?.[1]
    const minor = /minorApiLevel = (\d+)/.exec(build)?.[1]
    const tools = /buildToolsVersion = "([0-9.]+)"/.exec(build)?.[1]
    expect([major, minor, tools].every(Boolean)).toBe(true)
    const steps = runs('kotlin-android')
    const install = steps.findIndex((run) => run.includes('sdkmanager" --install'))
    const gradle = steps.findIndex((run) => run.includes('./gradlew'))
    expect(install).toBeGreaterThanOrEqual(0)
    expect(gradle).toBeGreaterThan(install)
    const script = steps[install] ?? ''
    expect(script).toContain(
      `--install "platforms;android-${major}.${minor}" "build-tools;${tools}"`
    )
    // Installed is looked at, not assumed from the tool's exit.
    expect(script).toContain(`test -d "$ANDROID_HOME/platforms/android-${major}.${minor}"`)
    expect(script).toContain(`test -d "$ANDROID_HOME/build-tools/${tools}"`)
    // Nothing of Gradle's is cached here either.
    const all = job('kotlin-android').steps
    expect(all.filter((step) => step.with && 'cache' in step.with)).toEqual([])
    expect(all.filter((step) => step.uses?.includes('setup-gradle'))).toEqual([])
  })

  // The Compose screens (ADR 0058): the library, the example app and the example's UI tests
  // are compiled and linted where the Android SDK is. The UI tests need a device, so they are
  // run by hand (native/android/fixture/ui-tests.ts) and never by a workflow.
  test('the Android job compiles and lints the Compose screens, the example and its UI tests', () => {
    const gradle = runs('kotlin-android').find((run) => run.includes('./gradlew')) ?? ''
    for (const task of [
      ':tula-auth-android:assembleRelease',
      ':tula-auth-android:lintRelease',
      ':tula-auth-compose:assembleRelease',
      ':tula-auth-compose:lintRelease',
      ':compose-example:assembleDebug',
      ':compose-example:assembleDebugAndroidTest',
      ':compose-example:lintDebug',
    ]) {
      expect(gradle.split(/\s+/)).toContain(task)
    }
  })

  test('every Android module compiles against the platform and build tools the job installs', () => {
    const pins = (file: string) => {
      const build = readFileSync(join(workflowsDir, '..', '..', file), 'utf8')
      return [
        /version = release\((\d+)\)/.exec(build)?.[1],
        /minorApiLevel = (\d+)/.exec(build)?.[1],
        /buildToolsVersion = "([0-9.]+)"/.exec(build)?.[1],
      ]
    }
    const installed = pins('native/android/tula-auth-android/build.gradle.kts')
    expect(installed.every(Boolean)).toBe(true)
    for (const file of [
      'native/android/tula-auth-compose/build.gradle.kts',
      'examples/compose/build.gradle.kts',
    ]) {
      expect(pins(file)).toEqual(installed)
    }
  })

  test('no job starts an emulator or runs tests on a device', () => {
    const everyRun = Object.keys(jobs).flatMap((name) => runs(name))
    expect(
      everyRun.filter((run) => /connected\w*AndroidTest|emulator|ui-tests\.ts|\bavd\b/i.test(run))
    ).toEqual([])
  })
})
