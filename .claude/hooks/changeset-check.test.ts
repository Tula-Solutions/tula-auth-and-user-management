import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AUTOMATION_BRANCHES,
  type ChangedFile,
  changesetPackages,
  decide,
  failureMessage,
  isChangesetPath,
  NO_CHANGESET_LABEL,
  parseNameStatus,
  shipsWithPackage,
} from '../../scripts/changeset-check'
import { type Manifest, PUBLISHABLE_PACKAGES } from '../../scripts/publish-manifest'

// The changeset check (.github/workflows/changeset-check.yml) decides from a diff, a label set
// and a branch name. These tests hold the decision, and the tie between "what ships" and the
// packages' own `files`.

const root = join(import.meta.dir, '..', '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')

const GROUP = ['@tula-tech/core', '@tula-tech/cli']
const modified = (path: string): ChangedFile => ({ status: 'M', path })
const added = (path: string): ChangedFile => ({ status: 'A', path })

describe('what counts as a change to a published package', () => {
  test.each([
    ['source', 'packages/core/src/session.ts', true],
    ['nested source', 'packages/react/src/components/sign-in/index.tsx', true],
    ['a deleted-file path is judged like any other', 'packages/contract/src/error-codes.ts', true],
    ['create-tula templates', 'packages/create-tula/templates/react-vite/src/main.tsx', true],
    ['expo-screens iOS sources', 'packages/expo-screens/ios/TulaScreens.swift', true],
    ['expo-screens Android sources', 'packages/expo-screens/android/src/Module.kt', true],
    ['the contract’s OpenAPI snapshot', 'packages/contract/openapi.json', true],
    ['the Expo module manifest', 'packages/expo-screens/expo-module.config.json', true],
    ['a unit test', 'packages/core/src/session.test.ts', false],
    ['a spec', 'packages/core/src/session.spec.tsx', false],
    ['an integration test', 'packages/core/src/session.integration.ts', false],
    ['a Swift test', 'packages/expo-screens/ios/ScreensTests.swift', false],
    ['a test folder', 'packages/core/src/__tests__/helpers.ts', false],
    ['test support', 'packages/react/src/testing/render.tsx', false],
    ['fixtures', 'packages/mcp/src/fixtures/user.json', false],
    ['a README', 'packages/core/README.md', false],
    ['prose inside src', 'packages/core/src/NOTES.md', false],
    ['a changelog', 'packages/core/CHANGELOG.md', false],
    ['the manifest', 'packages/core/package.json', false],
    ['the build config', 'packages/core/bunup.config.ts', false],
    ['a build script', 'packages/create-tula/scripts/sync-templates.ts', false],
    ['tsconfig', 'packages/core/tsconfig.json', false],
    ['a package that is not published', 'packages/ui/src/items/button.tsx', false],
    ['the API', 'apps/api/src/index.ts', false],
    ['an example app', 'examples/react-vite/src/main.tsx', false],
    ['docs', 'docs/releasing.md', false],
    ['a workflow', '.github/workflows/ci.yml', false],
    ['a name that only starts like a package', 'packages/core-extras/src/a.ts', false],
  ])('%s: %s -> %p', (_name, path, expected) => {
    expect(shipsWithPackage(path)).toBe(expected)
  })

  test('every publishable package is judged, and only by its own directory', () => {
    for (const dir of PUBLISHABLE_PACKAGES) {
      expect(shipsWithPackage(`${dir}/src/a.ts`)).toBe(true)
    }
  })

  test("what a package's `files` lists beyond dist is judged as shipped", () => {
    // A package that starts to ship a new top-level folder must be added to the check, or its
    // changes would never ask for a changeset.
    const judged = new Set([
      'dist',
      'templates',
      'ios',
      'android',
      'expo-module.config.json',
      'openapi.json',
    ])
    for (const dir of PUBLISHABLE_PACKAGES) {
      const manifest = JSON.parse(read(`${dir}/package.json`)) as Manifest & { files?: string[] }
      for (const entry of manifest.files ?? []) {
        expect({ dir, entry, judged: judged.has(entry) }).toEqual({ dir, entry, judged: true })
      }
    }
  })
})

describe('the decision', () => {
  const none = {} as Record<string, string[]>
  const base = { labels: [], headRef: 'feat/x', changesets: none, fixedGroup: GROUP }

  test('a change that ships nothing passes without a changeset', () => {
    const verdict = decide({
      ...base,
      changed: [modified('packages/core/src/a.test.ts'), modified('docs/releasing.md')],
    })
    expect(verdict.ok).toBe(true)
    expect(verdict.needing).toEqual([])
  })

  test('a change to shipped source with no changeset fails and names the files', () => {
    const verdict = decide({ ...base, changed: [modified('packages/core/src/a.ts')] })
    expect(verdict.ok).toBe(false)
    expect(verdict.needing).toEqual(['packages/core/src/a.ts'])
    expect(failureMessage(verdict)).toContain('packages/core/src/a.ts')
    expect(failureMessage(verdict)).toContain('bunx changeset')
  })

  test('the label waives it', () => {
    const verdict = decide({
      ...base,
      labels: ['bug', NO_CHANGESET_LABEL],
      changed: [modified('packages/core/src/a.ts')],
    })
    expect(verdict).toMatchObject({ ok: true })
    expect(verdict.reason).toContain(NO_CHANGESET_LABEL)
  })

  test('an added changeset that names a package of the group passes', () => {
    const verdict = decide({
      ...base,
      changed: [modified('packages/core/src/a.ts'), added('.changeset/brave-owls.md')],
      changesets: { '.changeset/brave-owls.md': ['@tula-tech/core'] },
    })
    expect(verdict.ok).toBe(true)
  })

  test.each([
    [
      'a changeset that names only a package the group does not have',
      [added('.changeset/a.md')],
      { '.changeset/a.md': ['@tula-tech/api'] },
    ],
    ['a changeset with no front matter', [added('.changeset/a.md')], { '.changeset/a.md': [] }],
    [
      'a changeset that was only edited, not added',
      [{ status: 'M', path: '.changeset/a.md' }],
      { '.changeset/a.md': ['@tula-tech/core'] },
    ],
    [
      'a changeset that was deleted',
      [{ status: 'D', path: '.changeset/a.md' }],
      { '.changeset/a.md': ['@tula-tech/core'] },
    ],
    ['the changesets README', [added('.changeset/README.md')], {}],
    [
      'a file in a subfolder',
      [added('.changeset/pre/a.md')],
      { '.changeset/pre/a.md': ['@tula-tech/core'] },
    ],
  ])('does not pass on %s', (_name, extra, changesets) => {
    const verdict = decide({
      ...base,
      changed: [modified('packages/core/src/a.ts'), ...extra],
      changesets,
    })
    expect(verdict.ok).toBe(false)
  })

  test.each([...AUTOMATION_BRANCHES])('the automation branch %s is exempt', (headRef: string) => {
    const verdict = decide({
      ...base,
      headRef,
      changed: [modified('packages/core/src/a.ts'), modified('packages/core/package.json')],
    })
    expect(verdict.ok).toBe(true)
  })

  test.each([...AUTOMATION_BRANCHES])('%s from a fork is not exempt', (headRef: string) => {
    const verdict = decide({
      ...base,
      headRef,
      fromFork: true,
      changed: [modified('packages/core/src/a.ts')],
    })
    expect(verdict.ok).toBe(false)
  })

  test('a person’s branch with a look-alike name is not exempt', () => {
    const verdict = decide({
      ...base,
      headRef: 'release/next-fix',
      changed: [modified('packages/core/src/a.ts')],
    })
    expect(verdict.ok).toBe(false)
  })

  test('a label with a look-alike name does not waive it', () => {
    const verdict = decide({
      ...base,
      labels: ['no-changesets', 'No-Changeset'],
      changed: [modified('packages/core/src/a.ts')],
    })
    expect(verdict.ok).toBe(false)
  })

  test('the fixed group in .changeset/config.json is the publishable packages', async () => {
    const config = JSON.parse(read('.changeset/config.json')) as { fixed: string[][] }
    const names: string[] = []
    for (const dir of PUBLISHABLE_PACKAGES) {
      names.push(((await Bun.file(join(root, dir, 'package.json')).json()) as Manifest).name)
    }
    expect(config.fixed.flat().sort()).toEqual(names.sort())
  })
})

describe('reading git and changesets', () => {
  test('parseNameStatus reads status and path, tabs and blank lines included', () => {
    expect(parseNameStatus('M\ta.ts\nA\t.changeset/x.md\n\nD\tb c.ts\n')).toEqual([
      { status: 'M', path: 'a.ts' },
      { status: 'A', path: '.changeset/x.md' },
      { status: 'D', path: 'b c.ts' },
    ])
  })

  test('changesetPackages reads quoted and bare names, and ignores the text', () => {
    const text =
      '---\n"@tula-tech/core": minor\n\'create-tula\': patch\nplain: major\n---\n\n"@tula-tech/x": minor\n'
    expect(changesetPackages(text)).toEqual(['@tula-tech/core', 'create-tula', 'plain'])
    expect(changesetPackages('no front matter')).toEqual([])
    expect(changesetPackages('---\n"a": huge\n---\n')).toEqual([])
  })

  test('isChangesetPath', () => {
    expect(isChangesetPath('.changeset/brave-owls.md')).toBe(true)
    expect(isChangesetPath('.changeset/README.md')).toBe(false)
    expect(isChangesetPath('.changeset/config.json')).toBe(false)
    expect(isChangesetPath('docs/.changeset/a.md')).toBe(false)
  })
})

describe('the workflow', () => {
  const source = read('.github/workflows/changeset-check.yml')
  const workflow = Bun.YAML.parse(source) as {
    on: { pull_request: { branches: string[]; types: string[] } }
    permissions: Record<string, string>
    jobs: Record<string, { name: string; steps: { run?: string; env?: Record<string, string> }[] }>
  }
  const active = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')

  test('runs for pull requests into develop, and again when a label changes', () => {
    expect(Object.keys(workflow.on)).toEqual(['pull_request'])
    expect(workflow.on.pull_request.branches).toEqual(['develop'])
    expect(workflow.on.pull_request.types).toEqual(
      expect.arrayContaining(['opened', 'synchronize', 'reopened', 'labeled', 'unlabeled'])
    )
  })

  test('only reads, holds no secret and is a job of its own, not `verify` or `e2e`', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(active).not.toMatch(/secrets\./)
    expect(Object.keys(workflow.jobs)).toEqual(['changeset'])
    expect(workflow.jobs.changeset?.name).toBe('changeset')
  })

  test('branch and label names reach the script through the environment', () => {
    const step = workflow.jobs.changeset?.steps.find((candidate) =>
      candidate.run?.includes('changeset-check.ts')
    )
    expect(step?.env).toMatchObject({ HEAD_REF: '${{ github.head_ref }}' })
    expect(step?.run).not.toContain('${{')
    expect(step?.env).toHaveProperty('FORK')
  })

  test('is not one of the ruleset’s required checks by name', () => {
    // Required today: `verify` and `e2e`. Making this one required is a person's decision
    // (a ruleset setting); the job is named differently so that it cannot become one by accident.
    expect(['verify', 'e2e']).not.toContain(workflow.jobs.changeset?.name)
  })
})
