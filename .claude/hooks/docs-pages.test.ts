import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveBase } from '../../apps/docs/src/lib/paths'

// The docs site is published to GitHub Pages by a workflow that runs only on `develop`, where
// no pull request exercises it. These tests are what runs before a merge: the rules the
// workflow is held to. Above all: the job that runs the repository's code can write nothing,
// the job that can write runs none of it, and the site is built under the path Pages serves.

const root = join(import.meta.dir, '..', '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')

interface Step {
  id?: string
  name?: string
  uses?: string
  run?: string
  with?: Record<string, unknown>
  env?: Record<string, string>
}
interface Job {
  if?: string
  needs?: string | string[]
  'timeout-minutes'?: number
  permissions?: Record<string, string>
  environment?: { name: string; url?: string }
  env?: Record<string, string>
  steps: Step[]
}
interface Workflow {
  on: unknown
  permissions: Record<string, string>
  concurrency: { group: string; 'cancel-in-progress': boolean }
  jobs: Record<string, Job>
}

const source = read('.github/workflows/docs-pages.yml')
const workflow = Bun.YAML.parse(source) as Workflow
// Comments explain what is absent; only the lines that do something are checked.
const active = source
  .split('\n')
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n')
const job = (name: string) => workflow.jobs[name] as Job

/** The path GitHub Pages serves this repository's site under: its name. */
const PAGES_BASE = '/tula-auth-and-user-management/'
const PAGES_URL = 'https://tula-solutions.github.io/tula-auth-and-user-management/'

describe('the docs site workflow', () => {
  test('runs for a push to develop and by hand, and for nothing else', () => {
    expect(workflow.on).toEqual({ push: { branches: ['develop'] }, workflow_dispatch: null })
    expect(active).not.toMatch(
      /pull_request|workflow_run|workflow_call|schedule:|repository_dispatch|\btags:/
    )
  })

  test('a run by hand from another branch builds and deploys nothing', () => {
    expect(job('build').if).toBe("github.ref == 'refs/heads/develop'")
    expect(job('deploy').needs).toBe('build')
  })

  test('two jobs: the build reads, and only the deploy holds what Pages needs', () => {
    expect(Object.keys(workflow.jobs)).toEqual(['build', 'deploy'])
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(job('build').permissions).toEqual({ contents: 'read' })
    expect(job('deploy').permissions).toEqual({ pages: 'write', 'id-token': 'write' })
    expect(active.match(/:\s*write\b/g)).toEqual([': write', ': write'])
  })

  test('the deploy job runs no code of the repository: it deploys the artifact and that is all', () => {
    const steps = job('deploy').steps
    expect(steps).toEqual([{ id: 'deployment', uses: 'actions/deploy-pages@v5' }])
    expect(job('deploy').environment).toEqual({
      name: 'github-pages',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a template
      url: '${{ steps.deployment.outputs.page_url }}',
    })
  })

  test('stores no secret, has no cache and lets no step fail quietly', () => {
    expect(active).not.toMatch(
      /secrets\.|GITHUB_TOKEN|github\.token|actions\/cache|continue-on-error/
    )
    // The checkout leaves no token behind for the install and the build that follow it.
    const checkout = job('build').steps.find((step) => step.uses?.startsWith('actions/checkout@'))
    expect(checkout?.with).toEqual({ 'persist-credentials': false })
  })

  test('every action is pinned to a major version, as the other workflows pin theirs', () => {
    const uses = Object.values(workflow.jobs).flatMap((one) =>
      one.steps.map((step) => step.uses).filter((value): value is string => value !== undefined)
    )
    expect(uses).toEqual([
      'actions/checkout@v7',
      'oven-sh/setup-bun@v2',
      'actions/upload-pages-artifact@v5',
      'actions/deploy-pages@v5',
    ])
  })

  test('one deployment at a time, never cancelled midway, and every job has a deadline', () => {
    expect(workflow.concurrency).toEqual({ group: 'docs-pages', 'cancel-in-progress': false })
    for (const [name, one] of Object.entries(workflow.jobs)) {
      expect(one['timeout-minutes'], name).toBeGreaterThan(0)
      expect(one['timeout-minutes'], name).toBeLessThanOrEqual(15)
    }
  })

  test('it builds the site under the path Pages serves, a base apps/docs accepts', () => {
    const steps = job('build').steps
    const build = steps.find((step) => step.run === 'bun run docs-site:build')
    expect(build?.env).toEqual({ DOCS_BASE: PAGES_BASE })
    expect(resolveBase({ DOCS_BASE: PAGES_BASE })).toBe(PAGES_BASE)
    // The base is the repository's name, the one apps/docs links to on GitHub.
    expect(read('apps/docs/src/lib/config.ts')).toContain(
      `REPO_URL = 'https://github.com/Tula-Solutions${PAGES_BASE.slice(0, -1)}'`
    )
    const runs = steps.map((step) => step.run).filter(Boolean)
    expect(runs).toEqual([
      'bun install --frozen-lockfile',
      'bun run docs-site:build',
      'rm -rf apps/docs/dist/.vite && touch apps/docs/dist/.nojekyll',
    ])
    for (const run of runs) {
      expect(run).not.toContain('${{')
    }
  })

  test('it uploads the built site, with .nojekyll and without the bundler’s manifest', () => {
    const steps = job('build').steps
    const upload = steps.findIndex((step) =>
      step.uses?.startsWith('actions/upload-pages-artifact@')
    )
    const prepare = steps.findIndex((step) => step.run?.includes('.nojekyll'))
    expect(prepare).toBeGreaterThan(-1)
    expect(upload).toBe(steps.length - 1)
    expect(prepare).toBeLessThan(upload)
    // The action leaves out dot files unless told: `.nojekyll` would not reach Pages.
    expect(steps[upload]?.with).toEqual({ path: 'apps/docs/dist', 'include-hidden-files': true })
  })

  test('the browser tests run the site under the same path', () => {
    const ci = Bun.YAML.parse(read('.github/workflows/ci.yml')) as Workflow
    expect(ci.jobs['e2e-docs']?.env).toEqual({ DOCS_BASE: PAGES_BASE })
  })
})

describe('where the docs say the site is published', () => {
  test.each(['apps/docs/README.md', 'docs/README.md', 'README.md'])(
    '%s gives the address',
    (file) => {
      expect(read(file)).toContain(PAGES_URL)
    }
  )

  test('the area rule says how the site is published, and no longer that nothing deploys it', () => {
    const rule = read('.claude/rules/docs-site.md').replace(/\s+/g, ' ')
    expect(rule).toContain('.github/workflows/docs-pages.yml')
    expect(rule).not.toContain('nothing deploys it')
  })
})
