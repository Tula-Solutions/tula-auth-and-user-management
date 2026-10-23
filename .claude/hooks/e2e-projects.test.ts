import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type Job = { steps: { run?: string }[] }

const root = join(import.meta.dir, '..', '..')
const config = readFileSync(join(root, 'e2e/playwright.config.ts'), 'utf8')
const { jobs } = Bun.YAML.parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')) as {
  jobs: Record<string, Job>
}

/** The names of the Playwright projects of the config. */
function projectNames(): string[] {
  const start = config.indexOf('const projects')
  const end = config.indexOf('const servers', start)
  const block = config.slice(start, end)
  return [...block.matchAll(/^\s{4}name:\s*'([^']+)'/gm)].map((match) => match[1] as string)
}

/** The projects a job's Playwright command line names (`--project=x`, `--project x`). */
function projectsRunBy(name: string): string[] {
  const commands = (jobs[name]?.steps ?? [])
    .map((step) => step.run ?? '')
    .filter((run) => /\b(bun run e2e|playwright test)\b/.test(run))
  return commands.flatMap(projectsIn)
}

/** The projects one command line names. */
function projectsIn(run: string): string[] {
  const found: string[] = []
  const words = run.split(/\s+/)
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] as string
    if (word.startsWith('--project=')) {
      found.push(word.slice('--project='.length))
    } else if (word === '--project') {
      // Variadic: every word up to the next option is a project.
      while (index + 1 < words.length && !(words[index + 1] as string).startsWith('-')) {
        index += 1
        found.push(words[index] as string)
      }
    }
  }
  return found
}

// The browser tests run in two CI jobs, split by project because the docs project is slow and
// needs no API (`e2e` and `e2e-docs`, each a set of shards: `e2e-shard` and `e2e-docs-shard`). A project in neither job is never run in CI, and one in
// both runs twice; a new project must be given to exactly one of them.
describe('the Playwright projects and the CI jobs that run them', () => {
  test('the config has projects, and the two jobs name some', () => {
    expect(projectNames().length).toBeGreaterThanOrEqual(4)
    expect(projectsRunBy('e2e-shard').length).toBeGreaterThan(0)
    expect(projectsRunBy('e2e-docs-shard').length).toBeGreaterThan(0)
  })

  test.each(projectNames())(
    'the project %s is run by exactly one of e2e-shard and e2e-docs-shard',
    (name) => {
      const runners = ['e2e-shard', 'e2e-docs-shard'].filter((job) =>
        projectsRunBy(job).includes(name)
      )
      expect(runners, `${name} runs in: ${runners.join(', ') || 'no job'}`).toHaveLength(1)
    }
  )

  test('the jobs name no project the config does not have', () => {
    const known = projectNames()
    for (const job of ['e2e-shard', 'e2e-docs-shard']) {
      for (const name of projectsRunBy(job)) {
        expect(known, `${job} runs ${name}`).toContain(name)
      }
    }
  })

  test('a variadic --project is read in full', () => {
    expect(projectsIn('bun run e2e --project docs chromium --workers=4')).toEqual([
      'docs',
      'chromium',
    ])
    expect(projectsIn('bun run e2e --project=docs --project=chromium')).toEqual([
      'docs',
      'chromium',
    ])
  })
})

// The fixture is one in-memory world (settings, clock, organizations). A run that attaches to
// another run's fixture, in another checkout or another agent's, has its state changed under it
// and fails with errors no test explains (TULA-129): a busy port stops the run, unless the
// developer asks for the reuse on purpose.
describe('the fixture servers of the Playwright config', () => {
  test('the API and the Next.js server are never attached to by default', () => {
    expect(config).toContain("const reuseFixture = process.env.E2E_REUSE_SERVER === '1'")
    const start = config.indexOf('function apiServers()')
    const block = config.slice(start, config.indexOf('\n}\n', start))
    const flags = [...block.matchAll(/reuseExistingServer:\s*([^,\n]+)/g)].map((m) => m[1])
    expect(flags.length).toBeGreaterThanOrEqual(2)
    expect(flags.every((flag) => flag === 'reuseFixture')).toBe(true)
  })
})
