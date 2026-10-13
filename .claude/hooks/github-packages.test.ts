import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  copiedVersion,
  GITHUB_REGISTRY,
  MIRROR_SCOPE,
  mirrorManifest,
  mirrorName,
  mirrorReadme,
  tarballName,
  uploadCommand,
  versionsPath,
} from '../../scripts/github-packages'
import { type Manifest, RELEASED_PACKAGES } from '../../scripts/publish-manifest'

// The copy on GitHub Packages is made by a workflow that runs only on `main`, where no pull
// request exercises it. These tests are what runs before a merge: what a copy is called and
// holds, and the rules the workflow is held to. Above all: it can reach GitHub Packages and
// nothing else, and it is not a second way to publish to npm.

const root = join(import.meta.dir, '..', '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')

interface Step {
  uses?: string
  run?: string
  with?: Record<string, unknown>
  env?: Record<string, string>
}
interface Workflow {
  on: unknown
  permissions: Record<string, string>
  jobs: Record<string, { permissions?: Record<string, string>; steps: Step[] }>
}

const source = read('.github/workflows/github-packages.yml')
const workflow = Bun.YAML.parse(source) as Workflow
// Comments explain what is absent; only the lines that do something are checked.
const active = source
  .split('\n')
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n')

describe('what a copy is called', () => {
  test('the scope is the repository owner’s, the only one GitHub accepts from it', () => {
    expect(MIRROR_SCOPE).toBe('@tula-solutions')
    expect(GITHUB_REGISTRY).toBe('https://npm.pkg.github.com')
  })

  test('every released package has a name there, each its own', () => {
    const names = RELEASED_PACKAGES.map(
      (dir) => (JSON.parse(read(join(dir, 'package.json'))) as Manifest).name
    )
    expect(names).toHaveLength(9)
    const copies = names.map(mirrorName)
    expect(copies).toEqual([
      '@tula-solutions/contract',
      '@tula-solutions/core',
      '@tula-solutions/react',
      '@tula-solutions/nextjs',
      '@tula-solutions/admin',
      '@tula-solutions/config',
      '@tula-solutions/mcp',
      '@tula-solutions/cli',
      '@tula-solutions/create-tula',
    ])
    expect(new Set(copies).size).toBe(copies.length)
  })

  test.each([
    'react',
    '@tula-tech/',
    '@tula-tech/core/extra',
    '@tula-tech/../core',
    '@tula-solutions/core',
    '@other/core',
    'create-tula-extra',
    '@tula-tech/Core',
    '',
  ])('%j is not a package that is copied', (name) => {
    expect(() => mirrorName(name)).toThrow('is not a package of this repository')
  })

  test('the versions of a copy are asked for under its own name', () => {
    expect(versionsPath('@tula-tech/core')).toBe('/orgs/tula-solutions/packages/npm/core/versions')
    expect(versionsPath('create-tula')).toBe(
      '/orgs/tula-solutions/packages/npm/create-tula/versions'
    )
  })

  test('the tarball is the one the release wrote', () => {
    expect(tarballName({ name: '@tula-tech/core', version: '0.1.1' })).toBe(
      'tula-tech-core-0.1.1.tgz'
    )
    expect(tarballName({ name: 'create-tula', version: '0.1.1' })).toBe('create-tula-0.1.1.tgz')
    // The same expression as the packing script's: a renamed tarball there fails here.
    expect(read('scripts/packages.ts')).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text of a template, quoted
      "manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz"
    )
  })
})

describe('what a copy holds', () => {
  const packed: Manifest = {
    name: '@tula-tech/react',
    version: '0.1.1',
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    dependencies: { '@tula-tech/core': '0.1.1' },
    peerDependencies: { react: '^19.0.0' },
  }

  test('the packed manifest under the copy’s name, pinned to GitHub’s registry', () => {
    expect(mirrorManifest(packed)).toEqual({
      ...packed,
      name: '@tula-solutions/react',
      publishConfig: { registry: 'https://npm.pkg.github.com' },
    })
  })

  // The copies are listings, not a second family of packages: a copy that depended on
  // another copy could only be installed from GitHub, with a token.
  test('its dependencies keep their npm names', () => {
    expect(mirrorManifest(packed).dependencies).toEqual({ '@tula-tech/core': '0.1.1' })
  })

  test.each<[string, Partial<Manifest>, string]>([
    ['a private manifest', { private: true }, 'is private, so it was not released'],
    ['version 0.0.0-stage', { version: '0.0.0-stage' }, 'is not a plain release'],
    ['an alpha', { version: '0.1.0-alpha.1' }, 'is not a plain release'],
    [
      'a registry of its own',
      { publishConfig: { registry: 'https://registry.npmjs.org' } },
      'has a publishConfig of its own',
    ],
  ])('%s is refused', (_what, change, message) => {
    expect(() => mirrorManifest({ ...packed, ...change })).toThrow(message)
  })

  test('its README says first that it is a copy, and where to install from', () => {
    const readme = mirrorReadme('@tula-tech/react', '# @tula-tech/react\n\nThe components.\n')
    expect(readme.startsWith('> **This is a copy.** `@tula-solutions/react`')).toBe(true)
    expect(readme).toContain(
      '[`@tula-tech/react` on npm](https://www.npmjs.com/package/@tula-tech/react)'
    )
    expect(readme.endsWith('\n# @tula-tech/react\n\nThe components.\n')).toBe(true)
  })
})

describe('the upload goes to GitHub Packages and nowhere else', () => {
  test('the command names the registry itself', () => {
    expect(uploadCommand('/tmp/x/package')).toEqual([
      'npm',
      'publish',
      '/tmp/x/package',
      '--registry',
      'https://npm.pkg.github.com',
      '--access',
      'public',
    ])
  })

  test('the script uploads in one place, with that command, and reads no credential', () => {
    const script = read('scripts/github-packages.ts')
    expect(script.match(/uploadCommand\(/g)).toHaveLength(2)
    expect(script).toContain('run(uploadCommand(directory), directory)')
    expect(script).not.toMatch(/registry\.npmjs\.org|npmrc|_authToken|NODE_AUTH_TOKEN|process\.env/)
    // Asked before every upload, and an unanswered question is thrown, not read as "absent".
    expect(script).toContain('const versions = registryTags({')
    expect(script).toContain('if (versions.includes(source.version)) {')
    // Without the explicit flag nothing is uploaded.
    expect(script).toContain("const publish = args[0] === '--publish'")
    expect(script).toMatch(/if \(!publish\) \{\n\s+say\(`publish /)
  })

  test('no root script uploads: the workflow starts it', () => {
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>
    expect(Object.values(scripts).filter((command) => command.includes('github-packages'))).toEqual(
      []
    )
  })
})

describe('the GitHub Packages workflow', () => {
  test('runs for a push to main and for nothing else', () => {
    expect(workflow.on).toEqual({ push: { branches: ['main'] } })
    expect(active).not.toMatch(
      /pull_request|workflow_dispatch|workflow_run|workflow_call|schedule:|repository_dispatch/
    )
  })

  test('stores no secret and holds one permission to write, on its one job', () => {
    expect(active).not.toMatch(/secrets\.|NPM_TOKEN|id-token|continue-on-error/)
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(Object.keys(workflow.jobs)).toEqual(['mirror'])
    expect(workflow.jobs.mirror?.permissions).toEqual({ contents: 'read', packages: 'write' })
    expect(active.match(/:\s*write\b/g)).toEqual([': write'])
  })

  test('npm is configured for GitHub’s registry only, with the run’s own token', () => {
    const steps = workflow.jobs.mirror?.steps ?? []
    const node = steps.find((step) => step.uses?.startsWith('actions/setup-node@'))
    expect(node?.with).toEqual({ 'node-version': 24, 'registry-url': 'https://npm.pkg.github.com' })
    expect(active.match(/registry-url/g)).toHaveLength(1)
    expect(active).not.toMatch(/registry\.npmjs\.org/)
    const upload = steps.find((step) => step.run?.includes('github-packages.ts'))
    expect(upload?.run).toBe('bun run scripts/github-packages.ts --publish')
    expect(upload?.env).toEqual({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a template
      GH_TOKEN: '${{ github.token }}',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a template
      NODE_AUTH_TOKEN: '${{ github.token }}',
    })
    // The token is given to that one step: not to the install or the build before it.
    expect(steps.filter((step) => step.env !== undefined)).toHaveLength(1)
  })

  test('it copies what a release builds, and names no publish command of its own', () => {
    const runs = (workflow.jobs.mirror?.steps ?? []).map((step) => step.run).filter(Boolean)
    expect(runs).toEqual([
      'bun install --frozen-lockfile',
      'bun run packages:check',
      'bun run scripts/github-packages.ts --publish',
    ])
    expect(active).not.toMatch(/\bnpm publish\b|\bbun publish\b|changeset publish|release:publish/)
    for (const run of runs) {
      expect(run).not.toContain('${{')
    }
  })

  test('the release workflow is left as it was', () => {
    expect(read('.github/workflows/release.yml')).not.toMatch(
      /npm\.pkg\.github\.com|packages:\s*write/
    )
  })
})

// Three things a review found unsaid. Each is a sentence a reader acts on.
describe('what the runbook says about the copy', () => {
  const doc = read('docs/releasing.md').replace(/\s+/g, ' ')

  test('the table of who uploads has a row for it: npm is used in two places, not one', () => {
    const section = doc.slice(
      doc.indexOf('### Which CLI uploads'),
      doc.indexOf('## The release workflow')
    )
    expect(section).toContain(
      '`npm publish <dir> --registry https://npm.pkg.github.com --access public`'
    )
    expect(section).not.toMatch(/one exception, in one place|the one use of npm/)
    expect(read('.claude/rules/publishable-packages.md')).not.toContain(
      'the one use of npm in the repository'
    )
  })

  test('a pre-release is not copied, and that is a skipped line, not a failed run', () => {
    expect(copiedVersion('0.1.1')).toBe(true)
    expect(copiedVersion('0.2.0-alpha.1')).toBe(false)
    expect(copiedVersion('0.0.0')).toBe(false)
    const script = read('scripts/github-packages.ts')
    expect(script).toMatch(/if \(!copiedVersion\(source\.version\)\) \{\n\s+say\(`skip /)
    expect(doc).toContain('Only a plain version is copied')
  })

  test('the preview asks GitHub too, and the runbook says what it needs', () => {
    expect(doc).toContain('it asks GitHub which versions exist, so `gh` must be signed in')
  })
})
