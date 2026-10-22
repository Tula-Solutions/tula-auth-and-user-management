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
  return commands.flatMap((run) =>
    [...run.matchAll(/--project[= ]([\w*-]+)/g)].map((match) => match[1] as string)
  )
}

// The browser tests run in two CI jobs, split by project because the docs project is slow and
// needs no API (`e2e` and `e2e-docs`). A project in neither job is never run in CI, and one in
// both runs twice; a new project must be given to exactly one of them.
describe('the Playwright projects and the CI jobs that run them', () => {
  test('the config has projects, and the two jobs name some', () => {
    expect(projectNames().length).toBeGreaterThanOrEqual(4)
    expect(projectsRunBy('e2e').length).toBeGreaterThan(0)
    expect(projectsRunBy('e2e-docs').length).toBeGreaterThan(0)
  })

  test.each(projectNames())('the project %s is run by exactly one of e2e and e2e-docs', (name) => {
    const runners = ['e2e', 'e2e-docs'].filter((job) => projectsRunBy(job).includes(name))
    expect(runners, `${name} runs in: ${runners.join(', ') || 'no job'}`).toHaveLength(1)
  })

  test('the jobs name no project the config does not have', () => {
    const known = projectNames()
    for (const job of ['e2e', 'e2e-docs']) {
      for (const name of projectsRunBy(job)) {
        expect(known, `${job} runs ${name}`).toContain(name)
      }
    }
  })
})
