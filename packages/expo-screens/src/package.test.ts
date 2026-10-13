import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

// The package as it would be published, and the rules its sources keep.

const root = join(import.meta.dir, '..')
// Inside the package and relative (bunup refuses anything else), and ignored by git.
const OUT_DIR = 'node_modules/.cache/tula-expo-screens-build'
const out = join(root, OUT_DIR)

beforeAll(async () => {
  const build = Bun.spawnSync(['bunx', 'bunup', '--out-dir', OUT_DIR, '--no-dts'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    // `spawnSync` blocks the thread the runner's own timeout runs on.
    timeout: 60_000,
  })
  if (build.exitCode !== 0) {
    throw new Error(`bunup failed: ${build.stderr.toString()}`)
  }
  // `bunx` and then a build: more than the default five seconds of a hook on a slow runner.
}, 90_000)

afterAll(async () => {
  await rm(out, { recursive: true, force: true })
})

/** Every module a file imports, by any form Bun's parser reports. */
function importsOf(code: string, loader: 'js' | 'ts' | 'tsx'): string[] {
  return new Bun.Transpiler({ loader })
    .scanImports(code)
    .map((entry) => entry.path)
    .sort()
}

/** The package's own sources, tests and test support left out. */
async function sources(): Promise<{ file: string; code: string }[]> {
  const found: { file: string; code: string }[] = []
  for (const entry of await readdir(join(root, 'src'), { withFileTypes: true })) {
    const file = entry.name
    if (
      entry.isFile() &&
      /\.tsx?$/.test(file) &&
      !/\.test\.tsx?$/.test(file) &&
      !file.endsWith('.d.ts')
    ) {
      found.push({ file, code: await Bun.file(join(root, 'src', file)).text() })
    }
  }
  return found
}

describe('the built package', () => {
  /** What each built entry point imports. */
  const ENTRIES: Record<string, string[]> = {
    // The one entry point that loads `expo`, for this package's own native module. It
    // reaches for nothing of the headless client: no `@tula-tech/expo`, no secure store.
    'index.js': ['@tula-tech/contract/theme', '@tula-tech/core', 'expo', 'react', 'react-native'],
    // The config plugin as a module; `plugin.cjs` is the same file as Expo loads it.
    'plugin.js': [],
  }

  test('every entry point is one file that imports only what it is for', async () => {
    const files = (await readdir(out)).filter((file) => file.endsWith('.js')).sort()
    expect(files).toEqual(Object.keys(ENTRIES).sort())
    for (const [file, imports] of Object.entries(ENTRIES)) {
      const code = await Bun.file(join(out, file)).text()
      expect([...new Set(importsOf(code, 'js'))], file).toEqual(imports)
    }
  })

  test('the package says where each entry point is, in the workspace and when published', async () => {
    const manifest = (await Bun.file(join(root, 'package.json')).json()) as {
      exports: Record<string, string>
      publishConfig: { exports: Record<string, unknown>; peerDependenciesMeta: object }
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
      peerDependencies: Record<string, string>
      peerDependenciesMeta: object
    }
    const entries = ['.', './plugin']
    expect(Object.keys(manifest.exports)).toEqual(entries)
    expect(Object.keys(manifest.publishConfig.exports)).toEqual([...entries, './package.json'])
    // The plugin is loaded by Expo with `require`, in Node: published it is CommonJS for
    // that, and a module for an `import`.
    expect(manifest.publishConfig.exports['./plugin']).toEqual({
      import: { types: './dist/plugin.d.ts', default: './dist/plugin.js' },
      require: { types: './dist/plugin.d.cts', default: './dist/plugin.cjs' },
    })
    // Published, every peer is required: this package is nothing without Expo. In the
    // workspace the two the repository never installs are optional.
    expect(manifest.publishConfig.peerDependenciesMeta).toEqual({})
    expect(manifest.peerDependenciesMeta).toEqual({
      expo: { optional: true },
      'react-native': { optional: true },
    })
    expect(Object.keys(manifest.peerDependencies).sort()).toEqual(['expo', 'react', 'react-native'])
    // It is not built on the headless SDK, and nothing of Expo or React Native is ever
    // installed by the repository.
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      '@tula-tech/contract',
      '@tula-tech/core',
    ])
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
      expect(/^(expo|react-native)($|-)|^@tula-tech\/expo$/.test(name), name).toBe(false)
    }
  })

  test('the config plugin is one CommonJS file that imports nothing and can be required', async () => {
    const file = join(out, 'plugin.cjs')
    const code = await Bun.file(file).text()
    expect(importsOf(code, 'js')).toEqual([])
    // What Expo does with a plugin named in `plugins`: `require` it and call its default
    // export (or the module itself) with the configuration and the props.
    const loaded = require(file) as {
      default: (
        config: object,
        props?: object
      ) => { mods?: { android?: { gradleProperties?: (config: object) => Promise<object> } } }
      withTulaScreens: unknown
    }
    expect(loaded.withTulaScreens).toBe(loaded.default)
    const mod = loaded.default({ name: 'Example' }).mods?.android?.gradleProperties
    expect(await mod?.({ modResults: [] })).toEqual({
      modResults: [{ type: 'property', key: 'android.minSdkVersion', value: '28' }],
    })
  })

  test.each(Object.keys(ENTRIES))(
    '%s has nothing of a browser page, of plain app storage or of a log in it',
    async (entry) => {
      const code = await Bun.file(join(out, entry)).text()
      for (const marker of [
        'react-dom',
        'document.',
        'window.',
        'localStorage',
        'sessionStorage',
        'AsyncStorage',
        'async-storage',
        'console.',
        'navigator.',
        'node:',
        'Buffer.',
        'TextEncoder',
        'requireAuthentication',
      ]) {
        expect(code).not.toContain(marker)
      }
    }
  )
})

describe('the sources', () => {
  test('the native module is loaded by the one file of the entry point, so everything else runs without a device', async () => {
    const native = ['expo', 'react-native']
    const found: Record<string, string[]> = {}
    for (const { file, code } of await sources()) {
      const imported = importsOf(code, file.endsWith('x') ? 'tsx' : 'ts').filter((path) =>
        native.includes(path)
      )
      if (imported.length > 0) {
        found[file] = imported
      }
    }
    expect(found).toEqual({ 'index.ts': ['expo', 'react-native'] })
  })

  test('no source imports an entry point, and the plugin imports nothing at all', async () => {
    for (const { file, code } of await sources()) {
      const imports = importsOf(code, file.endsWith('x') ? 'tsx' : 'ts')
      if (file === 'plugin.ts') {
        expect(imports).toEqual([])
      }
      for (const path of imports) {
        expect(/^\.{1,2}\/(index|plugin)$/.test(path), `${file} imports ${path}`).toBe(false)
      }
    }
  })

  test('import nothing but React, @tula-tech/core, the theme of the contract, the two native modules and each other', async () => {
    const allowed = new Set([
      'react',
      '@tula-tech/core',
      // Zod-free: the tokens and the grammar a theme value is checked with.
      '@tula-tech/contract/theme',
      'expo',
      'react-native',
    ])
    for (const { file, code } of await sources()) {
      for (const path of importsOf(code, file.endsWith('x') ? 'tsx' : 'ts')) {
        expect(allowed.has(path) || path.startsWith('./'), `${file} imports ${path}`).toBe(true)
      }
    }
  })
})
