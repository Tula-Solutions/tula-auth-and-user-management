import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  type Manifest,
  PUBLISHABLE_PACKAGES,
  publishManifest,
} from '../../scripts/publish-manifest'

const root = join(import.meta.dir, '..', '..')

const read = (path: string) => Bun.file(join(root, path)).text()
const manifest = async (dir: string) =>
  (await Bun.file(join(root, dir, 'package.json')).json()) as Manifest

const workspaceDirs = ['apps', 'packages']
  .filter((group) => existsSync(join(root, group)))
  .flatMap((group) =>
    readdirSync(join(root, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(group, entry.name))
  )

// `actions/upload-artifact` skips hidden files and directories unless told otherwise, so an
// upload from a dot directory (`.release`) finds nothing. The release workflow runs only on
// `main`, where no pull request exercises it: this is the check that runs before a merge.
describe('artifact uploads', () => {
  const workflows = readdirSync(join(root, '.github', 'workflows')).filter((name) =>
    /\.ya?ml$/.test(name)
  )

  // The upload steps of a workflow, without their comment lines.
  const uploadSteps = (workflow: string) =>
    workflow
      .split(/\n\s*- /)
      .filter((step) => step.includes('uses: actions/upload-artifact'))
      .map((step) =>
        step
          .split('\n')
          .filter((line) => !line.trim().startsWith('#'))
          .join('\n')
      )

  // A path segment that starts with a dot, with or without anything after it. `./x` and
  // `../x` are not hidden.
  const namesHiddenPath = (step: string) => /(?:^|[\s/'"!])\.[\w-]/m.test(step)

  test.each([
    ['path: .release/*.tgz', true],
    ['path: .release', true],
    ['path: build/.cache/out', true],
    ['path: "!.cache/x"', true],
    ['path: |\n  dist\n  .release/', true],
    ['path: ./dist/*.tgz', false],
    ['path: ../dist', false],
    ['path: e2e/playwright-report', false],
  ])('%j names a hidden path: %p', (step, hidden) => {
    expect(namesHiddenPath(step)).toBe(hidden)
  })

  test.each(workflows)(
    '%s uploads from a dot directory only with hidden files included',
    async (name) => {
      const workflow = await read(join('.github', 'workflows', name))
      for (const step of uploadSteps(workflow)) {
        if (namesHiddenPath(step)) {
          expect(step).toContain('include-hidden-files: true')
        }
      }
    }
  )

  test('the release workflow keeps its tarballs', async () => {
    const [upload, ...others] = uploadSteps(await read('.github/workflows/release.yml'))
    // Exactly one step is found: a re-indented workflow must not make this check empty.
    expect(others).toEqual([])
    expect(upload).toContain('path: .release/*.tgz')
    expect(upload).toContain('include-hidden-files: true')
  })
})

// Nothing may be published until the licence and the npm scope are decided
// (docs/releasing.md). These tests are the tripwire: turning publishing on means changing
// them on purpose, in the same change as the rest of the checklist.
describe('nothing can be published yet', () => {
  test.each(workspaceDirs)('%s is private', async (dir) => {
    expect((await manifest(dir)).private).toBe(true)
  })

  test('the release workflow has no credentials, no write permission and no publish command', async () => {
    const workflow = await read('.github/workflows/release.yml')
    for (const forbidden of [
      /secrets\./,
      /NPM_TOKEN/i,
      /NODE_AUTH_TOKEN/,
      /id-token/,
      /\bnpm publish\b/,
      /\bbun publish\b/,
      /changeset publish/,
      /:\s*write\b/,
    ]) {
      // Comments explain what is absent; only the lines that do something are checked.
      const active = workflow
        .split('\n')
        .filter((line) => !line.trim().startsWith('#'))
        .join('\n')
      expect(active).not.toMatch(forbidden)
    }
    expect(workflow).toContain('permissions:\n  contents: read')
    expect(workflow).toContain('bun run release:dry-run')
  })

  test('the release script spawns no publish command', async () => {
    const script = await read('scripts/packages.ts')
    const commands = [...script.matchAll(/run\(\[([^\]]*)\]/g)].map((match) => match[1] ?? '')
    expect(commands.length).toBeGreaterThan(3)
    for (const command of commands) {
      expect(command).not.toMatch(/publish/)
    }
  })

  test('changesets would publish to a restricted scope, from main, and never tag a private package', async () => {
    const config = JSON.parse(await read('.changeset/config.json'))
    expect(config).toMatchObject({
      access: 'restricted',
      baseBranch: 'main',
      privatePackages: { version: true, tag: false },
    })
  })
})

describe('publishable packages', () => {
  test('are the contract, the SDKs, the admin client, the config package, the MCP server, the CLI and create-tula, dependencies first', () => {
    expect([...PUBLISHABLE_PACKAGES]).toEqual([
      'packages/contract',
      'packages/core',
      'packages/react',
      'packages/nextjs',
      'packages/expo',
      'packages/admin',
      'packages/config',
      'packages/mcp',
      'packages/cli',
      'packages/create-tula',
    ])
  })

  test.each([...PUBLISHABLE_PACKAGES])(
    '%s resolves from source in the repository and from dist when published',
    async (dir) => {
      const pkg = await manifest(dir)
      // Nothing but a stylesheet may have side effects: a bundler must keep
      // `import '@tula/react/styles.css'` and may drop any script that is not used.
      expect([false, ['**/*.css']] as unknown[]).toContainEqual(pkg.sideEffects)
      expect(pkg.type).toBe('module')
      expect(pkg.files).toContain('dist')
      const source = pkg.exports as Record<string, string>
      const published = pkg.publishConfig?.exports as Record<string, unknown>
      expect(source['.']).toBe('./src/index.ts')
      for (const [subpath, target] of Object.entries(source)) {
        // Every entry point the repository uses is also published.
        expect(published).toHaveProperty([subpath])
        if (target.endsWith('.ts')) {
          const name = target.slice('./src/'.length, -'.ts'.length)
          // The entry itself, and nothing else unless the package adds conditions of its own
          // (`@tula/admin` sends a `browser` bundle to a module that refuses to load): each
          // of those is an entry of the same shape, with the same types, inside dist.
          const {
            types,
            default: main,
            ...conditions
          } = published[subpath] as Record<string, unknown>
          expect({ types, default: main }).toEqual({
            types: `./dist/${name}.d.ts`,
            default: `./dist/${name}.js`,
          })
          for (const condition of Object.values(conditions)) {
            expect(condition).toEqual({
              types: `./dist/${name}.d.ts`,
              default: expect.stringMatching(/^\.\/dist\/[a-z-]+\.js$/),
            })
          }
          expect(existsSync(join(root, dir, target))).toBe(true)
        } else if (target.startsWith('./src/')) {
          // A file shipped as it is (a stylesheet): the build copies it into dist.
          expect(published[subpath]).toBe(`./dist/${target.slice('./src/'.length)}`)
          expect(existsSync(join(root, dir, target))).toBe(true)
        }
      }
      expect(published['./package.json']).toBe('./package.json')
      expect((pkg.scripts as Record<string, string>).build).toBe('bunup')
    }
  )

  // The repository installs neither React Native nor Expo (about 500 packages for two
  // imports; ADR 0046), which it gets by marking those two peers optional. An application
  // must be told to have them: the published manifest drops the marking.
  test('@tula/expo: the native peers are optional here and required when published', async () => {
    const pkg = await manifest('packages/expo')
    expect(pkg.peerDependenciesMeta).toEqual({
      'expo-secure-store': { optional: true },
      'react-native': { optional: true },
    })
    const installed = {
      ...(pkg.dependencies as Record<string, string>),
      ...(pkg.devDependencies as Record<string, string>),
    }
    expect(Object.keys(installed).filter((name) => /^(expo|react-native)/.test(name))).toEqual([])

    const published = publishManifest(pkg, new Map([['@tula/core', '1.2.3']]))
    expect(published.peerDependenciesMeta).toEqual({})
    expect(Object.keys(published.peerDependencies as object).sort()).toEqual([
      'expo-secure-store',
      'react',
      'react-native',
    ])
    expect(published.dependencies).toEqual({ '@tula/core': '1.2.3' })
  })

  test('verify builds and checks them', async () => {
    const scripts = (await manifest('.')).scripts as Record<string, string>
    expect(scripts.verify).toContain('bun run packages:check')
    expect(scripts['packages:check']).toBe('bun run scripts/packages.ts check')
    expect(scripts['release:dry-run']).toBe('bun run scripts/packages.ts release')
  })
})

describe('publishManifest', () => {
  const versions = new Map([
    ['@tula/contract', '0.1.0-alpha.0'],
    ['@tula/core', '0.1.0-alpha.0'],
  ])
  const base: Manifest = {
    name: '@tula/core',
    version: '0.1.0-alpha.0',
    private: true,
    exports: { '.': './src/index.ts' },
    publishConfig: { exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } } },
    files: ['dist'],
    scripts: { build: 'bunup' },
    dependencies: { '@tula/contract': 'workspace:*', zod: '^4.6.5' },
    devDependencies: { '@tula/tsconfig': 'workspace:*' },
  }

  test('takes publishConfig’s fields, drops repository-only ones, and keeps `private`', () => {
    expect(publishManifest(base, versions)).toEqual({
      name: '@tula/core',
      version: '0.1.0-alpha.0',
      private: true,
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
      files: ['dist'],
      dependencies: { '@tula/contract': '0.1.0-alpha.0', zod: '^4.6.5' },
    })
  })

  test.each([
    ['workspace:*', '0.1.0-alpha.0'],
    ['workspace:^', '^0.1.0-alpha.0'],
    ['workspace:~', '~0.1.0-alpha.0'],
  ])('resolves %s to %s, in peer dependencies too', (range, expected) => {
    const published = publishManifest(
      { ...base, dependencies: undefined, peerDependencies: { '@tula/contract': range } },
      versions
    )
    expect(published.peerDependencies).toEqual({ '@tula/contract': expected })
    expect(published.dependencies).toBeUndefined()
  })

  test('refuses a workspace dependency that is not itself published', () => {
    expect(() =>
      publishManifest({ ...base, dependencies: { '@tula/db': 'workspace:*' } }, versions)
    ).toThrow('@tula/db is a workspace dependency but not a publishable package')
  })
})
