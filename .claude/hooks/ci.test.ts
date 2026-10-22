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
// `verify`, `e2e` and `e2e-docs` are aggregates of jobs that run side by side
// (`ci-split.test.ts`); `passed` waits for the aggregates, which fail unless every part passed.
const AGGREGATES = ['verify', 'e2e', 'e2e-docs']
const PARTS = ['verify-static', 'verify-tests', 'verify-integration', 'e2e-shard', 'e2e-docs-shard']
// The jobs that do the checking: every one but the two that decide and record, and the aggregates.
const checks = Object.keys(jobs).filter(
  (name) => name !== 'duplicate' && name !== 'passed' && !AGGREGATES.includes(name)
)
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
    expect(needs('passed').sort()).toEqual(
      ['duplicate', ...checks.filter((name) => !PARTS.includes(name)), ...AGGREGATES].sort()
    )
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
// The jobs of `verify` that run Turborepo's tasks are the only ones with a cache.
const TURBO_JOBS = ['verify-static', 'verify-tests']
describe('the Turborepo cache', () => {
  test('only a pull request reads it, and only a push saves it', () => {
    for (const name of TURBO_JOBS) {
      const [restore, ...moreRestores] = uses(name, 'actions/cache/restore@')
      const [save, ...moreSaves] = uses(name, 'actions/cache/save@')
      expect([moreRestores, moreSaves]).toEqual([[], []])
      expect(restore?.if).toBe("github.event_name == 'pull_request'")
      expect(save?.if).toBe("github.event_name == 'push'")
      expect(restore?.with?.path).toBe('.turbo/cache')
      expect(save?.with?.path).toBe('.turbo/cache')
    }
  })

  test('each job that has one keeps a cache of its own: two saves under one key would collide', () => {
    const keys = TURBO_JOBS.map((name) => String(uses(name, 'actions/cache/save@')[0]?.with?.key))
    expect(new Set(keys).size).toBe(TURBO_JOBS.length)
    for (const name of TURBO_JOBS) {
      const [restore] = uses(name, 'actions/cache/restore@')
      const [save] = uses(name, 'actions/cache/save@')
      expect(String(restore?.with?.['restore-keys'])).toContain(`turbo-\${{ runner.os }}-${name}-`)
      expect(String(save?.with?.key)).toContain(`turbo-\${{ runner.os }}-${name}-`)
    }
  })

  test('no step restores and saves in one go, and no other job has a cache', () => {
    for (const name of Object.keys(jobs)) {
      expect(uses(name, 'actions/cache@')).toEqual([])
      if (!TURBO_JOBS.includes(name)) {
        expect(uses(name, 'actions/cache')).toEqual([])
      }
    }
  })

  test('the cache is saved after the checks it records', () => {
    for (const name of TURBO_JOBS) {
      const steps = job(name).steps
      const checked = steps.findIndex((step) =>
        /^bun run (verify:static|\$\{\{ matrix\.script \}\})$/.test(step.run ?? '')
      )
      expect(checked, name).toBeGreaterThan(-1)
      expect(
        steps.findIndex((step) => step.uses?.startsWith('actions/cache/restore@'))
      ).toBeLessThan(checked)
      expect(
        steps.findIndex((step) => step.uses?.startsWith('actions/cache/save@'))
      ).toBeGreaterThan(checked)
    }
  })
})

// The packaged server, in one job (`self-host`): the image is built once, and three Compose
// projects of it run side by side on the one runner, each with its own host ports and its own
// file of settings (docker/self-host/*.env). Both conformance runs (two ports, and one
// address in front of both instances) go at once in the background, and the worker check
// (TULA-52: a webhook delivered by the worker running as a service of its own) runs while
// they wait. They were three jobs, each building the same image and starting its own stack.
describe('the self-host job: one image, three stacks side by side', () => {
  const repository = join(workflowsDir, '..', '..')
  const steps = () => job('self-host').steps
  const scripts = () => steps().map((step) => step.run ?? '')
  const indexOf = (text: string) => scripts().findIndex((script) => script.includes(text))
  const stepWith = (text: string) => steps().find((step) => step.run?.includes(text))

  const STACKS = {
    ONE_ADDRESS: 'one-address',
    TWO_PORTS: 'two-ports',
    WORKER_STACK: 'worker',
  } as const
  const compose = (file: string) =>
    `docker compose -p self-host-${file} --env-file docker/self-host/${file}.env`
  const WORKER_CHECK = `${compose('worker')} -f docker-compose.yml -f docker/worker-check/compose.yml --profile app --profile worker`

  /** A stack's file of settings, as Compose reads it: `NAME=value` lines, `#` comments. */
  const settings = (file: string): Record<string, string> =>
    Object.fromEntries(
      readFileSync(join(repository, 'docker/self-host', `${file}.env`), 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
        .map((line) => {
          const at = line.indexOf('=')
          return [line.slice(0, at), line.slice(at + 1)]
        })
    )
  /** Every variable the Compose files read, and those of them that name a host port. */
  const composeVariables = [
    ...new Set(
      ['docker-compose.yml', 'docker/worker-check/compose.yml'].flatMap((file) =>
        [...readFileSync(join(repository, file), 'utf8').matchAll(/\$\{([A-Z0-9_]+)/g)].map(
          (match) => match[1] as string
        )
      )
    ),
  ]
  const PORTS = composeVariables.filter((name) => name.endsWith('_PORT'))
  const at = (file: string, port: string) => `http://localhost:${settings(file)[port]}`

  test('one job runs every mode and the worker check: no matrix, and no job beside it', () => {
    expect(Object.keys(jobs).filter((name) => name.startsWith('self-host'))).toEqual(['self-host'])
    expect((job('self-host') as Job & { strategy?: unknown }).strategy).toBeUndefined()
  })

  test('the image is built once, and nothing that starts a stack builds it again', () => {
    const lines = scripts().flatMap((script) => script.split('\n'))
    expect(lines.filter((line) => /\sbuild(\s|$)/.test(line))).toEqual([
      'docker compose --profile app build api',
    ])
    expect(scripts().filter((script) => script.includes('--build'))).toEqual([])
    const ups = scripts().flatMap((script) =>
      script.split('\n').filter((line) => /\bup -d\b/.test(line))
    )
    expect(ups.length).toBe(3)
    for (const line of ups) {
      expect(line).toContain('up -d --no-build')
    }
    expect(indexOf('build api')).toBeLessThan(indexOf('up -d'))
  })

  test('each stack is a Compose project of its own, with its own file of settings', () => {
    const env = job('self-host').env ?? {}
    expect(Object.keys(env).sort()).toEqual([...Object.keys(STACKS), 'TULA_MASTER_KEY'].sort())
    for (const [name, file] of Object.entries(STACKS)) {
      expect(env[name]).toBe(`${compose(file)} --profile app`)
    }
    // Every stack is started, by its own command.
    const start = scripts()[indexOf('up -d')] ?? ''
    for (const name of Object.keys(STACKS)) {
      expect(start).toMatch(new RegExp(`\\$${name} up -d --no-build`))
    }
  })

  test('nothing a stack reads comes from the job but the master key', () => {
    // The job's environment reaches every Compose command of every stack: a setting of one
    // mode there would be every mode's. The settings are in each stack's own file.
    const env = Object.keys(job('self-host').env ?? {})
    expect(env.filter((name) => composeVariables.includes(name))).toEqual(['TULA_MASTER_KEY'])
    const written = scripts().flatMap((script) =>
      [...script.matchAll(/echo "([A-Z0-9_]+)=[^\n]*>> "\$GITHUB_ENV"/g)].map((m) => m[1])
    )
    expect(written.length).toBeGreaterThan(0)
    expect(written.filter((name) => composeVariables.includes(name as string))).toEqual([])
  })

  test('every stack has every host port of its own: the three run on one runner', () => {
    const used: string[] = []
    for (const file of Object.values(STACKS)) {
      for (const port of PORTS) {
        expect(settings(file)[port]).toMatch(/^[0-9]+$/)
        used.push(settings(file)[port] as string)
      }
    }
    expect(PORTS.length).toBeGreaterThanOrEqual(7)
    expect(new Set(used).size).toBe(used.length)
  })

  test('each mode keeps its own settings, and the worker stack is told nothing else', () => {
    const ports = (file: string) => Object.fromEntries(PORTS.map((p) => [p, settings(file)[p]]))
    const conformance = {
      TRUST_PROXY: 'true',
      // The OAuth scenarios run against the mock provider and the texted codes are read from
      // the development inbox: both are accepted in the `local` tier only.
      OAUTH_MOCK_PROVIDER: 'true',
      SMS_PROVIDER: 'dev',
    }
    expect(settings('two-ports')).toEqual({
      ...ports('two-ports'),
      ...conformance,
      LB_CLIENT_ADDRESS: 'peer',
    })
    expect(settings('one-address')).toEqual({
      ...ports('one-address'),
      ...conformance,
      // The issuer of the tokens, and where the mock provider's pages are reached.
      API_PUBLIC_URL: at('one-address', 'LB_PORT'),
      LB_CLIENT_ADDRESS: 'client',
    })
    // No `ENVIRONMENT` and nothing that loosens the outbound guard: the worker's stack runs
    // in the tier the others run in, and the receiver is reached within its rules.
    expect(settings('worker')).toEqual({ ...ports('worker'), WEBHOOK_WORKER: 'separate' })
  })

  test('the two runs: one against each instance on its own port, one through the proxy', () => {
    const start = stepWith('bun run conformance')?.run ?? ''
    expect(start.match(/bun run conformance/g)).toHaveLength(1)
    const section = (mode: string) => start.slice(start.indexOf(`start ${mode} `)).split('\n\n')[0]
    expect(section('two-ports')).toContain(
      [
        `CONFORMANCE_BASE_URL=${at('two-ports', 'API_PORT')}`,
        `CONFORMANCE_SECOND_BASE_URL=${at('two-ports', 'API_2_PORT')}`,
        'CONFORMANCE_SETTLE_MS=0',
        `CONFORMANCE_SMS_INBOX_URLS=${at('two-ports', 'API_PORT')},${at('two-ports', 'API_2_PORT')}`,
        `CONFORMANCE_MAILPIT_URL=${at('two-ports', 'MAILPIT_UI_PORT')}`,
        'CONFORMANCE_PUBLISHABLE_KEY="$TWO_PORTS_PUBLISHABLE_KEY"',
        'CONFORMANCE_SECRET_KEY="$TWO_PORTS_SECRET_KEY"',
        'CONFORMANCE_ENVIRONMENTS="$TWO_PORTS_ENVIRONMENTS"',
      ].join(' \\\n  ')
    )
    expect(section('one-address')).toContain(
      [
        `CONFORMANCE_BASE_URL=${at('one-address', 'LB_PORT')}`,
        'CONFORMANCE_SECOND_BASE_URL=',
        'CONFORMANCE_SETTLE_MS=6000',
        // Each instance keeps its own inbox, and through the one address a request may reach
        // either: the runner asks both, on their own ports.
        `CONFORMANCE_SMS_INBOX_URLS=${at('one-address', 'API_PORT')},${at('one-address', 'API_2_PORT')}`,
        `CONFORMANCE_MAILPIT_URL=${at('one-address', 'MAILPIT_UI_PORT')}`,
        'CONFORMANCE_PUBLISHABLE_KEY="$ONE_ADDRESS_PUBLISHABLE_KEY"',
        'CONFORMANCE_SECRET_KEY="$ONE_ADDRESS_SECRET_KEY"',
        'CONFORMANCE_ENVIRONMENTS="$ONE_ADDRESS_ENVIRONMENTS"',
      ].join(' \\\n  ')
    )
    // Every scenario must run: a missing secret key would skip the admin ones.
    expect(start).toContain('test -n "$CONFORMANCE_PUBLISHABLE_KEY"')
    expect(start).toContain('test -n "$CONFORMANCE_SECRET_KEY"')
  })

  test('each conformance run goes through eight environments, so that its waits overlap', () => {
    // Scenarios restore the settings they change, so they overlap only in environments of
    // their own. The seeded one is the primary; the other seven are made before the runs start,
    // for the two modes that run the scenarios (the worker stack runs none).
    const make = stepWith('create-environments.ts')
    expect(make?.run).toContain('--count 7')
    expect(make?.run).toContain('lanes ONE_ADDRESS &')
    expect(make?.run).toContain('lanes TWO_PORTS &')
    expect(make?.run).not.toContain('WORKER_STACK')
    // Every key is masked, and a stack that did not give seven pairs fails the step.
    expect(make?.run).toContain('::add-mask::$key')
    expect(make?.run).toContain('!= 7')
    expect(make?.run).toContain('_ENVIRONMENTS=')
    const runs = indexOf('bun run conformance')
    expect(indexOf('create-environments.ts')).toBeGreaterThan(indexOf('create-api-key.ts'))
    expect(indexOf('create-environments.ts')).toBeLessThan(runs)
    // The script the image runs is there, and it prints one pair a line.
    const script = readFileSync(
      join(repository, 'apps/api/src/scripts/create-environments.ts'),
      'utf8'
    )
    expect(script).toContain('`${publishable.key}:${secret.key}\\n`')
  })

  test('a run that failed, or never ended, fails the job', () => {
    const wait = steps().find((step) => step.run?.includes('--pid='))
    expect(wait?.run).toContain('for mode in two-ports one-address; do')
    expect(wait?.run).toContain('.exit")" = 0')
    // Each run's output is shown, whole, in the log.
    expect(wait?.run).toMatch(/tail -n \+1 -f --pid=/)
    // A run whose process ended without an exit code (killed, reaped) fails with a message.
    expect(wait?.run).toContain('did not finish')
    // The background command writes the exit code the wait step reads.
    const start = stepWith('bun run conformance')?.run ?? ''
    expect(start).toContain(
      'bun run conformance > "$RUNNER_TEMP/$0.log" 2>&1; echo $? > "$RUNNER_TEMP/$0.exit"'
    )
  })

  test('every step that starts or reports on the stacks stops at its first failed command', () => {
    // Without it a failed `grep` or `test` in the middle of a script would be ignored, and only
    // the last command's status would be the step's.
    for (const step of steps()) {
      const script = step.run ?? ''
      if (step.name === undefined || script === '' || !script.includes('\n')) {
        continue
      }
      const strict =
        (step as Step & { shell?: string }).shell === 'bash -euo pipefail {0}' ||
        script.trimStart().startsWith('set -euo pipefail') ||
        /^(# [^\n]*\n)+set -euo pipefail/.test(script.trimStart())
      expect({ step: step.name, strict }).toEqual({ step: step.name, strict: true })
    }
  })

  test('the runs are reported even when the worker check before them failed', () => {
    const runs = steps().find((step) => step.run?.includes('bun run conformance'))
    const check = indexOf('scripts/worker-check/check.ts')
    expect(runs?.id).toBe('runs')
    // The worker check runs while the conformance runs wait, after they were started.
    expect(check).toBeGreaterThan(indexOf('bun run conformance'))
    const after = steps().filter(
      (step, index) => index > check && step.if !== 'failure()' && step.run !== undefined
    )
    expect(after.length).toBe(3)
    for (const step of after) {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a template
      expect(step.if).toBe("${{ !cancelled() && steps.runs.outcome == 'success' }}")
    }
  })

  test('the conformance runs still name the scenarios they skip, all nine, both modes', () => {
    // The worker check replaces none of that: a receiver on the runner is still out of reach
    // for a server in a container, and the skip is still checked by name. The ninth waits a
    // day, which a live server cannot be made to do.
    const run = stepWith('if [ "$skipped" != "$expected" ]; then')
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
    expect(run?.run).toContain('for mode in two-ports one-address; do')
    // And the count in both summary lines is the list's own, against each mode's addresses.
    expect(run?.run?.match(/ 0 failed, 9 skipped against /g)).toHaveLength(2)
    const port = (file: string, name: string) => settings(file)[name]
    expect(run?.run).toContain(
      ` 0 failed, 9 skipped against http://localhost:${port('two-ports', 'API_PORT')} and http://localhost:${port('two-ports', 'API_2_PORT')}$`
    )
    expect(run?.run).toContain(
      ` 0 failed, 9 skipped against http://localhost:${port('one-address', 'LB_PORT')} \\(one address, 6000 ms after each settings change\\)$`
    )
  })

  test('every scenario either mode had to see pass is still required, in both', () => {
    const run = stepWith('if [ "$skipped" != "$expected" ]; then')?.run ?? ''
    for (const name of [
      'two instances',
      'webhook endpoint on a refused address',
      'phone number on an account',
      'text messages to a blocked destination',
      'text messages past the daily limit',
      'sign in with a texted code',
      'a texted sign-in code for an unknown number',
      'a texted sign-in code after the method is switched off',
      'text message wording',
      'a texted code as the second factor',
      'a texted code is never used beside an authenticator app',
      'a texted sign-in code is not completed by a texted second step',
    ]) {
      expect(run).toContain(`must '(^|: )PASSED ${name}$'`)
    }
  })

  test('the checks of one mode alone are still made, on that mode’s stack', () => {
    const dashboard = stepWith('/dashboard/')?.run ?? ''
    expect(dashboard).toContain(`${at('two-ports', 'API_PORT')}/dashboard/`)
    expect(dashboard).toContain('grep -F "script-src \'self\'"')
    expect(dashboard).toContain('$TWO_PORTS run --rm -T api sh -c')
    const proxy = stepWith('upstream=')?.run ?? ''
    expect(proxy).toContain('$ONE_ADDRESS logs --no-color --no-log-prefix lb')
    expect(proxy).toContain('test "$((count * 3))" -ge "$total"')
  })

  test('the worker stack is started without the worker: the check has to see nothing delivered first', () => {
    expect(job('self-host').env?.WORKER_STACK).not.toContain('--profile worker')
    // The check starts the worker itself, after it has seen the event wait.
    expect(scripts().filter((script) => /up -d[^\n]*\bworker\b/.test(script))).toEqual([])
  })

  test('the check runs against that stack, with the receiver’s file laid over it', () => {
    const check = indexOf('scripts/worker-check/check.ts')
    expect(check).toBeGreaterThan(indexOf('up -d'))
    expect(scripts()[check]).toContain(`bun run scripts/worker-check/check.ts -- ${WORKER_CHECK}`)
    // Its exit code is the step's: nothing after it on the line, nothing that swallows it.
    expect(scripts()[check]).not.toMatch(/check\.ts[^\n]*(\|\||\|\s|;)/)
    const env = (steps()[check] as Step & { env?: Record<string, string> }).env
    expect(env?.WORKER_CHECK_API_URLS).toBe(
      `${at('worker', 'API_PORT')},${at('worker', 'API_2_PORT')}`
    )
  })

  test('the instance token is generated for the run, and only the worker stack is given it', () => {
    const token = indexOf('WORKER_CHECK_ADMIN_TOKEN=')
    expect(token).toBeGreaterThan(-1)
    expect(token).toBeLessThan(indexOf('up -d'))
    expect(scripts()[token]).toContain('openssl rand -hex 32')
    expect(scripts()[token]).toContain('::add-mask::')
    // Under the name the API reads, it is set only beside the worker stack's own commands.
    const given = scripts().flatMap((script) =>
      script.split('\n').filter((line) => line.includes('TULA_ADMIN_TOKEN='))
    )
    expect(given.length).toBe(2)
    for (const line of given) {
      expect(line).toContain('TULA_ADMIN_TOKEN="$WORKER_CHECK_ADMIN_TOKEN"')
      expect(line).toMatch(/\$WORKER_STACK up -d|^\s*export TULA_ADMIN_TOKEN=/)
    }
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

  // The Compose screens (ADR 0061): the library, the example app and the example's UI tests
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
