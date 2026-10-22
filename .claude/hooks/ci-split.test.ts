import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

type Step = {
  name?: string
  run?: string
  uses?: string
  env?: Record<string, string>
  with?: Record<string, unknown>
}
type Job = {
  name?: string
  needs?: string | string[]
  if?: string
  env?: Record<string, string>
  container?: { image?: string; options?: string }
  services?: Record<string, unknown>
  strategy?: {
    'fail-fast'?: boolean
    matrix?: { shard?: number[]; include?: Record<string, string>[] }
  }
  steps: Step[]
}

const root = join(import.meta.dir, '..', '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const { jobs } = Bun.YAML.parse(read('.github/workflows/ci.yml')) as { jobs: Record<string, Job> }
const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
const job = (name: string): Job => jobs[name] ?? { steps: [] }
const runs = (name: string) => job(name).steps.map((step) => step.run ?? '')
const needs = (name: string) => [job(name).needs ?? []].flat()

// `verify`, `e2e` and `e2e-docs` took 10 to 19 minutes as single jobs. Each is now a set of
// jobs that run side by side and an aggregate that keeps the old name: the repository's
// ruleset requires the checks named `verify` and `e2e`.
const SPLIT: Record<string, string[]> = {
  verify: ['verify-static', 'verify-tests', 'verify-integration'],
  e2e: ['e2e-shard'],
  'e2e-docs': ['e2e-docs-shard'],
}

/** The step of an aggregate job that reads the results of the jobs it waited for. */
const resultsStep = (name: string) =>
  job(name).steps.find((step) => (step.run ?? '').includes('RESULTS'))

describe('the aggregate jobs keep the names the ruleset requires', () => {
  test.each(Object.keys(SPLIT))(
    '%s is a job of that exact name, and waits for its parts',
    (name) => {
      expect(jobs[name]).toBeDefined()
      expect(job(name).name ?? name).toBe(name)
      expect(needs(name).sort()).toEqual(['duplicate', ...(SPLIT[name] as string[])].sort())
    }
  )

  test.each(Object.keys(SPLIT))('%s runs after a part failed, to fail itself', (name) => {
    // A job whose needed job failed is skipped, and a skipped required check reads as passed:
    // the aggregate has to run and say it failed.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a template
    expect(job(name).if).toBe("${{ !cancelled() && needs.duplicate.outputs.skip != 'true' }}")
  })

  test.each(Object.keys(SPLIT))('%s reads the result of every job it waited for', (name) => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a template
    expect(resultsStep(name)?.env?.RESULTS).toBe("${{ join(needs.*.result, ' ') }}")
  })

  function verdict(results: string, name = 'verify') {
    return Bun.spawnSync(['bash', '-euo', 'pipefail', '-c', resultsStep(name)?.run ?? 'true'], {
      env: { PATH: process.env.PATH ?? '', RESULTS: results },
      timeout: 10_000,
    }).exitCode
  }

  test.each(Object.keys(SPLIT))(
    'the script of %s passes only for results that are all "success"',
    (name) => {
      expect(verdict('success success success success', name)).toBe(0)
      expect(verdict('success failure success success', name)).not.toBe(0)
      expect(verdict('success skipped success success', name)).not.toBe(0)
      expect(verdict('success cancelled success success', name)).not.toBe(0)
      expect(verdict('', name)).not.toBe(0)
    }
  )

  test('`passed` still waits for the three names and not for their parts', () => {
    const waits = needs('passed')
    for (const name of Object.keys(SPLIT)) {
      expect(waits).toContain(name)
    }
    for (const part of Object.values(SPLIT).flat()) {
      expect(waits).not.toContain(part)
    }
  })

  test('each part waits for the decision and follows it', () => {
    for (const part of Object.values(SPLIT).flat()) {
      expect(needs(part)).toEqual(['duplicate'])
      expect(job(part).if).toBe("needs.duplicate.outputs.skip != 'true'")
    }
  })
})

describe('what `bun run verify` checks is split, not weakened', () => {
  const commands = (script: string) => script.split('&&').map((part) => part.trim())

  test('the static checks and the tests are exactly the commands of `verify`', () => {
    const verify = commands(
      (pkg.scripts.verify as string).replace(
        'turbo run typecheck generate:check test:coverage',
        'turbo run typecheck generate:check && turbo run test:coverage'
      )
    )
    const parts = [...commands(pkg.scripts['verify:static'] as string), 'turbo run test:coverage']
    expect(parts.sort()).toEqual(verify.sort())
  })

  test('verify-static runs the static checks, once', () => {
    expect(runs('verify-static').filter((run) => run === 'bun run verify:static')).toHaveLength(1)
  })

  // The tests run in one job a package group, each a root script that filters Turborepo.
  const groups = () => job('verify-tests').strategy?.matrix?.include ?? []
  const filtersOf = (script: string) =>
    [...script.matchAll(/--filter=(\S+)/g)].map((match) => match[1] as string)

  function workspacePackages() {
    const found: string[] = []
    for (const dir of ['apps', 'packages']) {
      for (const entry of readdirSync(join(root, dir))) {
        try {
          const manifest = JSON.parse(read(`${dir}/${entry}/package.json`)) as {
            name: string
            scripts?: Record<string, string>
          }
          if (manifest.scripts?.['test:coverage']) {
            found.push(manifest.name)
          }
        } catch {
          // Not a package.
        }
      }
    }
    return found
  }

  test('the test groups run every package with coverage exactly once', () => {
    expect(groups().length).toBeGreaterThanOrEqual(2)
    const scripts = groups().map((group) => pkg.scripts[group.script as string] as string)
    for (const script of scripts) {
      expect(script).toMatch(/^turbo run test:coverage --filter=/)
    }
    for (const name of workspacePackages()) {
      const taking = scripts.filter((script) => {
        const filters = filtersOf(script)
        const only = filters.filter((filter) => !filter.startsWith('!'))
        return only.length > 0 ? only.includes(name) : !filters.includes(`!${name}`)
      })
      expect(taking, `${name} is tested by ${taking.length} groups`).toHaveLength(1)
    }
  })

  test('each group runs its own root script', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a template
    expect(runs('verify-tests')).toContain('bun run ${{ matrix.script }}')
    for (const group of groups()) {
      expect(pkg.scripts[group.script as string]).toBeDefined()
    }
  })

  test('the integration tests still run against Postgres and Redis, after the migration', () => {
    expect(Object.keys(job('verify-integration').services ?? {}).sort()).toEqual([
      'postgres',
      'redis',
    ])
    const all = runs('verify-integration')
    const migrate = all.indexOf('bun run db:migrate')
    expect(migrate).toBeGreaterThan(-1)
    expect(all.indexOf('bun run test:integration')).toBeGreaterThan(migrate)
  })

  test('the API tests run on several workers, and keep the limit the journeys need', () => {
    const api = JSON.parse(read('apps/api/package.json')) as { scripts: Record<string, string> }
    for (const name of ['test', 'test:coverage']) {
      expect(api.scripts[name]).toMatch(/--parallel=4/)
      expect(api.scripts[name]).toMatch(/--timeout 20000/)
    }
    expect(api.scripts['test:coverage']).toContain('--coverage')
  })
})

describe('the browser jobs: a pinned image, and shards that each have their own servers', () => {
  const lockedVersion = () => /"@playwright\/test@(\d+\.\d+\.\d+)"/.exec(read('bun.lock'))?.[1]
  const e2eCommand = (name: string) => runs(name).find((run) => /\bbun run e2e\b/.test(run)) ?? ''

  test.each(['e2e-shard', 'e2e-docs-shard'])(
    '%s runs in the Playwright image of the installed version',
    (name) => {
      const version = lockedVersion()
      expect(version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(job(name).container?.image).toBe(`mcr.microsoft.com/playwright:v${version}-noble`)
      // Chromium shares memory with the page; the default 64 MB /dev/shm crashes it.
      expect(job(name).container?.options).toContain('--ipc=host')
    }
  )

  test.each(['e2e-shard', 'e2e-docs-shard'])(
    '%s installs unzip before setup-bun needs it',
    (name) => {
      // The Playwright image has none, and setup-bun fails without it ("Unable to locate
      // executable file: unzip").
      const steps = job(name).steps
      const install = steps.findIndex((step) =>
        /apt-get\b.*\binstall\b.*\bunzip\b/.test(step.run ?? '')
      )
      const setup = steps.findIndex((step) => step.uses?.startsWith('oven-sh/setup-bun@'))
      expect(install).toBeGreaterThan(-1)
      expect(install).toBeLessThan(setup)
    }
  )

  test('no job downloads a browser: that was the step a dropped connection failed', () => {
    for (const name of Object.keys(jobs)) {
      for (const run of runs(name)) {
        expect(run, name).not.toMatch(/playwright install/)
      }
    }
  })

  test.each(['e2e-shard', 'e2e-docs-shard'])(
    '%s: every shard runs, none is cancelled by another failing, and each keeps its report',
    (name) => {
      const strategy = job(name).strategy
      expect(strategy?.['fail-fast']).toBe(false)
      const shards = strategy?.matrix?.shard ?? []
      expect(shards.length).toBeGreaterThanOrEqual(2)
      expect(shards).toEqual(shards.map((_, index) => index + 1))
      expect(e2eCommand(name)).toContain(`--shard=\${{ matrix.shard }}/${shards.length}`)
      const upload = job(name).steps.find((step) =>
        step.uses?.startsWith('actions/upload-artifact@')
      )
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a template
      expect(String(upload?.with?.name)).toContain('${{ matrix.shard }}')
    }
  )

  test('the documentation shards run the docs project, and the others run no docs', () => {
    expect(e2eCommand('e2e-docs-shard')).toContain('--project=docs')
    expect(e2eCommand('e2e-shard')).not.toContain('docs')
  })

  test('the documentation shards still build and serve the site under the Pages base', () => {
    expect(job('e2e-docs-shard').env?.DOCS_BASE).toBe('/tula-auth-and-user-management/')
  })
})
