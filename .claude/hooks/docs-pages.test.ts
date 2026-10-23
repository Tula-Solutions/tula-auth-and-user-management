import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveBase } from '../../apps/docs/src/lib/paths'
import { resolveRelease } from '../../apps/docs/src/lib/release'

// The docs site is published to GitHub Pages by a workflow that runs only for a push to `main`
// (a release) or `develop`, where no pull request exercises it. These tests are what runs before
// a merge: the rules the workflow is held to. Above all: the job that runs the repository's code
// can write nothing, the job that can write runs none of it, the site is built under the path
// Pages serves, and it holds two versions, the latest release's at the root and `develop`'s
// under `next/`.

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

/** The one step that builds both versions: a shell script, read as text. */
const buildStep = () =>
  job('build').steps.find((step) => step.name?.startsWith('Build the released docs')) as Step
const script = () => buildStep().run as string
const ORIGIN = PAGES_URL.slice(0, PAGES_URL.indexOf(PAGES_BASE))

describe('the docs site workflow', () => {
  test('runs for a push to main (a release) or develop and by hand, and for nothing else', () => {
    expect(workflow.on).toEqual({
      push: { branches: ['develop', 'main'] },
      workflow_dispatch: null,
    })
    expect(active).not.toMatch(
      /pull_request|workflow_run|workflow_call|schedule:|repository_dispatch|\btags:|^\s*release:/m
    )
  })

  test('a release is a push to main: the workflows that make one start on that event', () => {
    // No tag and no GitHub Release is made (`release:` and `tags:` are in no workflow), so the
    // docs follow the event the release workflows themselves follow. A merge made by a person
    // starts this workflow; a run made with GITHUB_TOKEN would not, and none is involved.
    for (const file of ['release.yml', 'github-packages.yml']) {
      const other = Bun.YAML.parse(read(`.github/workflows/${file}`)) as Workflow
      expect(other.on, file).toEqual({ push: { branches: ['main'] } })
    }
    for (const file of ['release.yml', 'github-packages.yml', 'docs-pages.yml']) {
      const lines = read(`.github/workflows/${file}`)
        .split('\n')
        .filter((line) => !line.trim().startsWith('#'))
        .join('\n')
      expect(lines, file).not.toMatch(/^\s*(release:|tags:)|gh release|git tag/m)
    }
  })

  test('a run by hand from another branch builds and deploys nothing', () => {
    expect(job('build').if).toBe(
      "github.ref == 'refs/heads/develop' || github.ref == 'refs/heads/main'"
    )
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
  })

  test('both trees are checked out at the tips of main and develop, with their whole history and no token left behind', () => {
    const checkouts = job('build').steps.filter((step) =>
      step.uses?.startsWith('actions/checkout@')
    )
    expect(checkouts.map((step) => step.with)).toEqual([
      { ref: 'main', path: 'release-src', 'fetch-depth': 0, 'persist-credentials': false },
      { ref: 'develop', path: 'next-src', 'fetch-depth': 0, 'persist-credentials': false },
    ])
  })

  test('every action is pinned to a major version, as the other workflows pin theirs', () => {
    const uses = Object.values(workflow.jobs).flatMap((one) =>
      one.steps.map((step) => step.uses).filter((value): value is string => value !== undefined)
    )
    expect(uses).toEqual([
      'actions/checkout@v7',
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
      expect(one['timeout-minutes'], name).toBeLessThanOrEqual(30)
    }
  })

  test('it builds under the path Pages serves, a base apps/docs accepts, and the site’s origin', () => {
    expect(buildStep().env).toEqual({ DOCS_BASE_PATH: PAGES_BASE, DOCS_ORIGIN: ORIGIN })
    expect(resolveBase({ DOCS_BASE: PAGES_BASE })).toBe(PAGES_BASE)
    // The base is the repository's name, the one apps/docs links to on GitHub.
    expect(read('apps/docs/src/lib/config.ts')).toContain(
      `REPO_URL = 'https://github.com/Tula-Solutions${PAGES_BASE.slice(0, -1)}'`
    )
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell text, not a template
    expect(script()).toContain('DOCS_BASE="${DOCS_BASE_PATH}next/"')
    expect(script()).toContain('DOCS_BASE="$DOCS_BASE_PATH"')
    for (const step of job('build').steps) {
      expect(step.run ?? '', step.name).not.toContain('${{')
    }
  })

  test('the three builds name channels, versions and bases apps/docs accepts', () => {
    const next = `${PAGES_BASE}next/`
    // The same variables the script sets: the unreleased docs under next/ (with the release's
    // version where there is one), the release's own at the root, and, while no release has
    // the site, the development docs at the root.
    expect(
      resolveRelease({ DOCS_CHANNEL: 'next', DOCS_VERSION: '', DOCS_ORIGIN: ORIGIN }, next)
    ).toEqual({
      channel: 'next',
      version: null,
      origin: ORIGIN,
    })
    expect(
      resolveRelease({ DOCS_CHANNEL: 'next', DOCS_VERSION: '0.1.2', DOCS_ORIGIN: ORIGIN }, next)
        ?.version
    ).toBe('0.1.2')
    expect(
      resolveRelease(
        { DOCS_CHANNEL: 'release', DOCS_VERSION: '0.1.2', DOCS_ORIGIN: ORIGIN },
        PAGES_BASE
      )?.channel
    ).toBe('release')
    expect(
      resolveRelease(
        { DOCS_CHANNEL: 'unreleased', DOCS_VERSION: '', DOCS_ORIGIN: ORIGIN },
        PAGES_BASE
      )?.channel
    ).toBe('unreleased')
    const text = script()
    expect(text).toContain('DOCS_CHANNEL=next DOCS_VERSION="$version"')
    expect(text).toContain('DOCS_CHANNEL=release DOCS_VERSION="$version"')
    expect(text).toContain('DOCS_CHANNEL=unreleased DOCS_VERSION=""')
  })

  test('the root is the release’s own build from its own tree, and the development docs where the release has none', () => {
    const text = script()
    // The release has the docs site only if its tree has the app; then, and only then, there is
    // a version to show and the root is built in release-src from its own lockfile.
    expect(text).toContain('if [ -f release-src/apps/docs/package.json ]; then')
    expect(text).toContain('release-src/packages/contract/package.json')
    const branch = text.indexOf('if [ -n "$version" ]; then')
    const otherwise = text.indexOf('else\n', branch)
    const release = text.slice(branch, otherwise)
    expect(release).toContain('cd release-src')
    expect(release).toContain('bun install --frozen-lockfile')
    expect(release).toContain('root=release-src/apps/docs/dist')
    const fallback = text.slice(otherwise, text.indexOf('fi\n', otherwise))
    expect(fallback).toContain('cd next-src')
    expect(fallback).toContain('root=next-src/apps/docs/dist')
    expect(fallback).not.toContain('release-src')
  })

  test('the two builds are put in one site, the unreleased one under next/ and out of the way of the other', () => {
    const text = script()
    // The unreleased docs are copied out before the root is built (a build empties its dist/),
    // and a docs route /next/ would be a collision, which stops the run.
    const copyNext = text.indexOf('cp -R next-src/apps/docs/dist "$site/next"')
    const buildRoot = text.indexOf('if [ -n "$version" ]; then')
    expect(copyNext).toBeGreaterThan(-1)
    expect(copyNext).toBeLessThan(buildRoot)
    expect(text).toContain('if [ -e "$root/next" ]; then')
    expect(text).toContain('cp -R "$root/." "$site/"')
    expect(text).toContain('set -euo pipefail')
  })

  test('it uploads the built site, with .nojekyll and without the bundler’s manifest', () => {
    const steps = job('build').steps
    const upload = steps.findIndex((step) =>
      step.uses?.startsWith('actions/upload-pages-artifact@')
    )
    expect(upload).toBe(steps.length - 1)
    expect(script()).toContain('rm -rf "$site/.vite" "$site/next/.vite"')
    expect(script()).toContain('touch "$site/.nojekyll"')
    expect(script()).toContain('site="$PWD/site"')
    // The action leaves out dot files unless told: `.nojekyll` would not reach Pages.
    expect(steps[upload]?.with).toEqual({ path: 'site', 'include-hidden-files': true })
  })

  test('the browser tests run both versions of the site under the same path', () => {
    const ci = Bun.YAML.parse(read('.github/workflows/ci.yml')) as Workflow
    expect(ci.jobs['e2e-docs-shard']?.env).toEqual({ DOCS_BASE: PAGES_BASE })
    expect(read('e2e/playwright.config.ts')).toContain('build:versions')
    expect(read('apps/docs/package.json')).toContain('"build:versions"')
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

  test('the docs say a release deploys the docs by itself, and where each version is', () => {
    const readme = read('apps/docs/README.md').replace(/\s+/g, ' ')
    expect(readme).toContain('push to `main`')
    expect(readme).toContain(`${PAGES_URL}next/`)
    const releasing = read('docs/releasing.md').replace(/\s+/g, ' ')
    expect(releasing).toContain('.github/workflows/docs-pages.yml')
    // Not as a link: the released build checks every address of its own, and `next/` is not its file.
    expect(releasing).toContain('with `next/` added')
  })
})
