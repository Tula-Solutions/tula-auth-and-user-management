import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { VENDORED } from '../../packages/expo-screens/scripts/vendor'
import {
  type Manifest,
  missingPackedFiles,
  PUBLISHABLE_PACKAGES,
  publishManifest,
  REQUIRED_PACKED_FILES,
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
  // Entry points published as CommonJS beside the module, each for a reason: an Expo config
  // plugin is loaded with `require`, in Node, while an app's configuration is read (ADR 0052).
  const COMMONJS_ENTRIES: Record<string, string[]> = {
    'packages/expo': ['./plugin'],
    'packages/expo-screens': ['./plugin'],
  }

  test('are the contract, the SDKs, the admin client, the config package, the MCP server, the CLI and create-tula, dependencies first', () => {
    expect([...PUBLISHABLE_PACKAGES]).toEqual([
      'packages/contract',
      'packages/core',
      'packages/react',
      'packages/nextjs',
      'packages/expo',
      'packages/expo-screens',
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
        if (COMMONJS_ENTRIES[dir]?.includes(subpath)) {
          const name = target.slice('./src/'.length, -'.ts'.length)
          expect(published[subpath]).toEqual({
            import: { types: `./dist/${name}.d.ts`, default: `./dist/${name}.js` },
            require: { types: `./dist/${name}.d.cts`, default: `./dist/${name}.cjs` },
          })
          expect(existsSync(join(root, dir, target))).toBe(true)
        } else if (target.endsWith('.ts')) {
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
  //
  // Five peers stay optional when published, and only those: each is imported by an entry
  // point of its own (`@tula/expo/passkeys`, `/browser`, `/apple`, `/google`,
  // `/device-key`), which an app that does not offer what it is for never imports (ADR
  // 0048, ADR 0052). The secure store and React Native are needed by every app.
  test('@tula/expo: the native peers are optional here; published, only those an app may leave out are', async () => {
    const pkg = await manifest('packages/expo')
    expect(pkg.peerDependenciesMeta).toEqual({
      '@pagopa/io-react-native-crypto': { optional: true },
      'expo-apple-authentication': { optional: true },
      'expo-secure-store': { optional: true },
      'expo-web-browser': { optional: true },
      'react-native': { optional: true },
      'react-native-nitro-google-signin': { optional: true },
      'react-native-passkey': { optional: true },
    })
    const installed = {
      ...(pkg.dependencies as Record<string, string>),
      ...(pkg.devDependencies as Record<string, string>),
    }
    expect(
      Object.keys(installed).filter((name) => /^(expo|react-native|@pagopa\/)/.test(name))
    ).toEqual([])

    const published = publishManifest(pkg, new Map([['@tula/core', '1.2.3']]))
    expect(published.peerDependenciesMeta).toEqual({
      '@pagopa/io-react-native-crypto': { optional: true },
      'expo-apple-authentication': { optional: true },
      'expo-web-browser': { optional: true },
      'react-native-nitro-google-signin': { optional: true },
      'react-native-passkey': { optional: true },
    })
    expect(Object.keys(published.peerDependencies as object).sort()).toEqual([
      '@pagopa/io-react-native-crypto',
      'expo-apple-authentication',
      'expo-secure-store',
      'expo-web-browser',
      'react',
      'react-native',
      'react-native-nitro-google-signin',
      'react-native-passkey',
    ])
    expect(published.dependencies).toEqual({ '@tula/core': '1.2.3' })
  })

  // The native screens are a package of their own (ADR 0063): Expo links a package's native
  // module into every app that installs it, so the module is where only an app that asked
  // for the screens installs it. It is not built on the headless SDK, and published every
  // peer is required: the package is nothing without Expo.
  test('@tula/expo-screens: Expo and React Native are optional peers here and required when published, and it does not depend on @tula/expo', async () => {
    const pkg = await manifest('packages/expo-screens')
    expect(pkg.peerDependenciesMeta).toEqual({
      expo: { optional: true },
      'react-native': { optional: true },
    })
    const installed = {
      ...(pkg.dependencies as Record<string, string>),
      ...(pkg.devDependencies as Record<string, string>),
    }
    expect(
      Object.keys(installed).filter((name) => /^(expo|react-native|@pagopa\/)/.test(name))
    ).toEqual([])
    expect(Object.keys(installed)).not.toContain('@tula/expo')

    const published = publishManifest(
      pkg,
      new Map([
        ['@tula/core', '1.2.3'],
        ['@tula/contract', '1.2.3'],
      ])
    )
    expect(published.peerDependenciesMeta).toEqual({})
    expect(Object.keys(published.peerDependencies as object).sort()).toEqual([
      'expo',
      'react',
      'react-native',
    ])
    // The contract is a dependency for its Zod-free theme: the grammar a theme value is
    // checked with before it reaches a native screen.
    expect(published.dependencies).toEqual({ '@tula/contract': '1.2.3', '@tula/core': '1.2.3' })
    // The native module travels with the package, and only with this one.
    expect(published.files).toEqual(['dist', 'android', 'ios', 'expo-module.config.json'])
    expect(existsSync(join(root, 'packages/expo-screens/expo-module.config.json'))).toBe(true)
    for (const path of ['expo-module.config.json', 'ios', 'android', 'scripts']) {
      expect({ path, exists: existsSync(join(root, 'packages/expo', path)) }).toEqual({
        path,
        exists: false,
      })
    }
    expect((await manifest('packages/expo')).files).toEqual(['dist'])
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

// `@tula/expo-screens`'s tarball holds copies of the native SDKs' sources that only its build makes
// (ADR 0063): publint and attw look at entry points and would pass a tarball without them.
describe('what a tarball must hold', () => {
  const required = REQUIRED_PACKED_FILES['@tula/expo-screens'] ?? []
  const whole = required.map((path) => `package/${path}`).join('\n')

  test('a known file of every directory the Expo screens package copies is asked for, and is a source', () => {
    expect(VENDORED).toHaveLength(6)
    for (const { from, to, extension } of VENDORED) {
      const asked = required.filter((path) => path.startsWith(`${to}/`))
      expect({ to, asked: asked.length }).toEqual({ to, asked: 1 })
      const file = (asked[0] as string).slice(to.length + 1)
      expect(file.endsWith(extension)).toBe(true)
      // The file is one the copy is made from: a renamed source fails here, not at a release.
      expect({ file, exists: existsSync(join(root, from, file)) }).toEqual({ file, exists: true })
    }
    expect(required).toHaveLength(VENDORED.length)
  })

  test('a listing with all of them has nothing missing', () => {
    expect(missingPackedFiles('@tula/expo-screens', `package/package.json\n${whole}\n`)).toEqual([])
  })

  test.each(required.map((path) => [path]))('a tarball without %s is refused by name', (path) => {
    const listing = whole
      .split('\n')
      .filter((line) => line !== `package/${path}`)
      .join('\n')
    expect(missingPackedFiles('@tula/expo-screens', listing)).toEqual([path])
  })

  test('a file of the same name somewhere else does not count', () => {
    const listing = required.map((path) => `package/dist/${path}`).join('\n')
    expect(missingPackedFiles('@tula/expo-screens', listing)).toEqual([...required])
  })

  test('a package with no required file is asked for none, also one named like a property', () => {
    expect(missingPackedFiles('@tula/core', '')).toEqual([])
    // The headless Expo SDK ships no native source: only the screens' package is asked.
    expect(missingPackedFiles('@tula/expo', '')).toEqual([])
    expect(Object.keys(REQUIRED_PACKED_FILES)).toEqual(['@tula/expo-screens'])
    expect(missingPackedFiles('constructor', '')).toEqual([])
  })

  test('the packing script refuses a tarball with a file missing', async () => {
    const script = await read('scripts/packages.ts')
    expect(script).toContain('const missing = missingPackedFiles(manifest.name, listing)')
    // In two pieces only so that the linter does not take it for a template literal.
    const thrown = ['throw new Error(`$', '{manifest.name}: the tarball does not hold'].join('')
    expect(script).toContain(thrown)
  })
})
