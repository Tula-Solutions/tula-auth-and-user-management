import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..')

/**
 * How long a spawned script may run. `Bun.spawnSync` blocks the thread the test runner's own
 * timeout runs on, so a child that never exits would hang `bun run verify` for ever instead of
 * failing one test; only a timeout on the spawn itself can stop it. These scripts take
 * milliseconds.
 */
const SPAWN_TIMEOUT_MS = 10_000

/** Run a command to completion, or fail the test naming it if it had to be killed. */
function spawn(command: string[], options: { stdin?: Buffer; env?: Record<string, string> } = {}) {
  const proc = Bun.spawnSync(command, { ...options, timeout: SPAWN_TIMEOUT_MS })
  if (proc.exitedDueToTimeout) {
    throw new Error(`timed out after ${SPAWN_TIMEOUT_MS} ms: ${command.join(' ')}`)
  }
  return proc
}

function run(script: string, stdin: string, args: string[] = []) {
  const proc = spawn(['bash', join(root, script), ...args], {
    stdin: Buffer.from(stdin),
    env: { ...(process.env as Record<string, string>), CLAUDE_PROJECT_DIR: root },
  })
  return { code: proc.exitCode, stderr: proc.stderr.toString() }
}

function protect(path: string) {
  return run('.claude/hooks/protect-files.sh', JSON.stringify({ tool_input: { file_path: path } }))
    .code
}

describe('spawned scripts', () => {
  test('a script that never exits fails its test by name instead of hanging the run', () => {
    const started = Date.now()
    const hang = () => Bun.spawnSync(['bash', '-c', 'sleep 30'], { timeout: 200 })
    expect(hang().exitedDueToTimeout).toBe(true)
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})

describe('protect-files.sh', () => {
  test.each([
    'packages/contract/openapi.json',
    'conformance/scenario.schema.json',
    'conformance/client-journeys.schema.json',
    'apps/api/src/routeTree.gen.ts',
    'apps/dashboard/src/components/ui/button.tsx',
    'bun.lock',
    '.env',
    '.env.production',
    'apps/api/.env',
    'apps/api/.env.local',
  ])('blocks %s', (path) => {
    expect(protect(join(root, path))).toBe(2)
  })

  test.each(['.env.example', 'apps/api/.env.example', 'apps/api/src/index.ts', 'AGENTS.md'])(
    'allows %s',
    (path) => {
      expect(protect(join(root, path))).toBe(0)
    }
  )

  test.each([`${root}/x/../bun.lock`, `${root}/packages/./contract/openapi.json`])(
    'normalizes %s before matching (F11)',
    (path) => {
      expect(protect(path)).toBe(2)
    }
  )
})

describe('.husky/commit-msg', () => {
  function commitMsg(subject: string) {
    const file = join(tmpdir(), `commit-msg-${crypto.randomUUID()}`)
    spawn(['bash', '-c', 'printf "%s\\n" "$1" > "$2"', '_', subject, file])
    return run('.husky/commit-msg', '', [file]).code
  }

  test.each([
    'feat(api): add sessions',
    'fix: handle reuse',
    'refactor!: drop v0 claims',
    "Merge branch 'feat/sessions' into develop",
    'Merge pull request #12 from Tula-Solutions/feat/sessions',
    'Revert "feat: add sessions"',
    'fixup! feat: add sessions',
    'squash! fix: handle reuse',
  ])('accepts %p (F4)', (subject) => {
    expect(commitMsg(subject)).toBe(0)
  })

  test.each(['added stuff', 'Feat: capitalized type', 'feature: wrong type'])(
    'rejects %p',
    (subject) => {
      expect(commitMsg(subject)).toBe(1)
    }
  )
})

describe('workspace packages', () => {
  // Bun reads bunfig.toml only from the test cwd, and turbo runs tests inside each package, so a
  // root-level coverageThreshold is silently ignored (F1).
  const dirs = ['apps', 'packages']
    .filter((group) => existsSync(join(root, group)))
    .flatMap((group) =>
      readdirSync(join(root, group), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(group, entry.name))
    )

  test('at least one workspace package exists', () => {
    expect(dirs.length).toBeGreaterThan(0)
  })

  test.each(dirs)('%s enforces its own coverage threshold if it has tests', async (dir) => {
    const pkg = await Bun.file(join(root, dir, 'package.json')).json()
    if (!pkg.scripts?.['test:coverage']) {
      return
    }
    const bunfigPath = join(root, dir, 'bunfig.toml')
    if (!existsSync(bunfigPath)) {
      throw new Error(`${dir} has a test:coverage script but no bunfig.toml with coverageThreshold`)
    }
    expect(await Bun.file(bunfigPath).text()).toMatch(/coverageThreshold\s*=/)
  })

  // Bun 1.4.2 does not read a per-test timeout from bunfig.toml: with `[test] timeout = 30000`
  // a six-second test still fails with "timed out after 5000ms", and passes with
  // `bun test --timeout 30000`. The key reads as if it worked, which is how apps/dashboard ran
  // on the default for months. A timeout belongs on the command line of the package's scripts.
  const bunfigs = [...new Bun.Glob('**/bunfig.toml').scanSync({ cwd: root, dot: true })].filter(
    (path) => !path.split('/').includes('node_modules')
  )

  test('the bunfig.toml files are found', () => {
    expect(bunfigs).toContain('apps/dashboard/bunfig.toml')
  })

  test.each(bunfigs)('%s sets no [test] timeout, which Bun ignores', async (path) => {
    const config = Bun.TOML.parse(await Bun.file(join(root, path)).text()) as {
      test?: { timeout?: unknown }
    }
    expect(config.test?.timeout).toBeUndefined()
  })

  // The one package whose tests may run longer than Bun's five seconds (AGENTS.md, "Testing"):
  // its `waitFor` waits ten, and a query that gives up must fail with its own message.
  test.each(['test', 'test:coverage'])(
    'apps/dashboard passes its 30 s timeout on the command line of `%s`',
    async (script) => {
      const pkg = await Bun.file(join(root, 'apps/dashboard/package.json')).json()
      expect(pkg.scripts[script]).toMatch(/^bun test (.* )?--timeout 30000( |$)/)
    }
  )

  // The shared SDK journeys run the real API in process (Argon2 and all) and are called from
  // two packages. apps/api runs its tests with a 20 s limit; packages/expo has Bun's five, and
  // a journey that takes 0.6 s there took 5016 ms on a busy CI runner. The suite therefore
  // sets its own limit, for its own file only, and it is the API package's.
  /**
   * What is wrong with the journeys' timeout: the constant, the call that applies it and the
   * API package's own flag must say the same number. A call that is only mentioned in a comment
   * and a flag that merely starts with the number (`--timeout 200000`) do not count.
   */
  function journeyTimeoutProblems(source: string, scripts: Record<string, string | undefined>) {
    const problems: string[] = []
    const declared = /^export const JOURNEY_TIMEOUT_MS = ([\d_]+)$/m.exec(source)?.[1]
    if (declared === undefined) {
      return ['JOURNEY_TIMEOUT_MS is not declared']
    }
    const limit = Number(declared.replaceAll('_', ''))
    const body = source.slice(source.indexOf('export function sdkJourneys('))
    if (!/^\s*setDefaultTimeout\(JOURNEY_TIMEOUT_MS\)$/m.test(body)) {
      problems.push('sdkJourneys does not call setDefaultTimeout(JOURNEY_TIMEOUT_MS)')
    }
    for (const [name, command] of Object.entries(scripts)) {
      if (!new RegExp(`(^| )--timeout ${limit}( |$)`).test(command ?? '')) {
        problems.push(`${name} does not pass --timeout ${limit}`)
      }
    }
    return problems
  }

  const journeys = [
    'export const JOURNEY_TIMEOUT_MS = 20_000',
    'export function sdkJourneys(target: JourneyTarget): JourneyKit {',
    '  setDefaultTimeout(JOURNEY_TIMEOUT_MS)',
    '}',
  ].join('\n')

  test('the shared SDK journeys set the test timeout of apps/api wherever they run', async () => {
    const source = await Bun.file(join(root, 'apps/api/src/testing/sdk-journeys.ts')).text()
    const pkg = await Bun.file(join(root, 'apps/api/package.json')).json()
    const scripts = { test: pkg.scripts.test, 'test:coverage': pkg.scripts['test:coverage'] }
    expect(journeyTimeoutProblems(source, scripts)).toEqual([])
  })

  test('the journeys’ timeout check passes for the constant, its call and the same flag', () => {
    expect(journeyTimeoutProblems(journeys, { test: 'bun test --timeout 20000' })).toEqual([])
    expect(journeyTimeoutProblems(journeys, { test: 'bun test --timeout 20000 --bail' })).toEqual(
      []
    )
  })

  test.each([
    [
      'a call that is only in a comment',
      journeys.replace('  set', '  // set'),
      'bun test --timeout 20000',
    ],
    [
      'a call on a line that does something else',
      journeys.replace('  set', '  void 0, set'),
      'bun test --timeout 20000',
    ],
    ['a flag that only starts with the number', journeys, 'bun test --timeout 200000'],
    ['no flag', journeys, 'bun test'],
    [
      'no constant',
      journeys.replace('JOURNEY_TIMEOUT_MS =', 'OTHER ='),
      'bun test --timeout 20000',
    ],
  ])('the journeys’ timeout check fails for %s', (_name, source, command) => {
    expect(journeyTimeoutProblems(source, { test: command })).not.toEqual([])
  })

  // The journeys bring their limit to the file that calls them, so a package never needs a
  // flag for them; one on packages/expo would also cover tests that spawn nothing.
  test.each(['test', 'test:coverage'])(
    'packages/expo passes no --timeout in `%s`',
    async (script) => {
      const pkg = await Bun.file(join(root, 'packages/expo/package.json')).json()
      expect(pkg.scripts[script]).not.toContain('--timeout')
    }
  )
})

describe('protect-files.sh edge paths (F14)', () => {
  test.each(['bun.lock', 'packages/contract/openapi.json', './.env'])(
    'resolves relative path %p against the project root and blocks it',
    (path) => {
      expect(protect(path)).toBe(2)
    }
  )

  test.each(['/', '.', `${root}/../../..`])('does not crash on %p', (path) => {
    expect(protect(path)).toBe(0)
  })
})

describe('settings.json .env read rules (F13)', () => {
  // Minimal glob matcher for Claude Code's gitignore-style `Read(...)` patterns.
  function matches(pattern: string, path: string) {
    const body = pattern.replace(/^Read\(\.\/(.*)\)$/, '$1')
    const regex = body
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replaceAll('**/', '<GLOBSTAR>')
      .replace(/\*/g, '[^/]*')
      .replaceAll('<GLOBSTAR>', '(?:.*/)?')
    return new RegExp(`^${regex}$`).test(path)
  }

  async function denied(path: string) {
    const settings = await Bun.file(join(root, '.claude/settings.json')).json()
    return (settings.permissions.deny as string[])
      .filter((rule) => rule.startsWith('Read('))
      .some((rule) => matches(rule, path))
  }

  test.each([
    '.env',
    '.env.local',
    '.env.production',
    '.env.staging',
    '.env.development',
    '.env.test',
    '.env.dev',
    '.env.prod',
    '.env.qa',
    '.env.ci',
    '.env.production.local',
    'apps/api/.env',
    'apps/api/.env.production',
    'apps/api/.env.prod',
  ])('denies reading %s', async (path) => {
    expect(await denied(path)).toBe(true)
  })

  test.each(['.env.example', 'apps/api/.env.example'])('leaves %s readable', async (path) => {
    expect(await denied(path)).toBe(false)
  })
})
