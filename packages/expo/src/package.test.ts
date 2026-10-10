import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { toTulaError } from './errors'
import { type FlowScreen, flowScreen } from './screens'

// The package as it would be published, and the rules its sources keep.

const root = join(import.meta.dir, '..')
// Inside the package and relative (bunup refuses anything else), and ignored by git.
const OUT_DIR = 'node_modules/.cache/tula-expo-build'
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
  const walk = async (directory: string, prefix: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = `${prefix}${entry.name}`
      if (entry.isDirectory()) {
        if (file !== 'testing') {
          await walk(join(directory, entry.name), `${file}/`)
        }
      } else if (/\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.endsWith('.d.ts')) {
        found.push({ file, code: await Bun.file(join(directory, entry.name)).text() })
      }
    }
  }
  await walk(join(root, 'src'), '')
  return found
}

describe('the built package', () => {
  /** What each built entry point imports. */
  const ENTRIES: Record<string, string[]> = {
    // An app that uses neither passkeys nor providers installs neither optional module:
    // the main entry reaches for the secure store and the platform's name, and that is all.
    'index.js': ['@tula/core', 'expo-secure-store', 'react', 'react-native'],
    'passkeys.js': ['react-native-passkey'],
    'browser.js': ['expo-web-browser'],
  }

  test('is one file an entry point, each importing only its own native module, and bundles none of them', async () => {
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
      peerDependencies: Record<string, string>
    }
    expect(Object.keys(manifest.exports)).toEqual(['.', './passkeys', './browser'])
    expect(Object.keys(manifest.publishConfig.exports)).toEqual([
      '.',
      './passkeys',
      './browser',
      './package.json',
    ])
    // Published, the two modules behind an entry point of their own stay optional; the
    // secure store and React Native do not.
    expect(manifest.publishConfig.peerDependenciesMeta).toEqual({
      'expo-web-browser': { optional: true },
      'react-native-passkey': { optional: true },
    })
    expect(Object.keys(manifest.peerDependencies).sort()).toEqual([
      'expo-secure-store',
      'expo-web-browser',
      'react',
      'react-native',
      'react-native-passkey',
    ])
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
  test('a native module is imported by the one file of its entry point, so everything else runs without a device', async () => {
    const native = ['expo-secure-store', 'expo-web-browser', 'react-native', 'react-native-passkey']
    const importers = Object.fromEntries(
      (await sources())
        .map(({ file, code }) => [
          file,
          importsOf(code, file.endsWith('x') ? 'tsx' : 'ts').filter((path) =>
            native.includes(path)
          ),
        ])
        .filter(([, found]) => (found as string[]).length > 0)
    )
    expect(importers).toEqual({
      'browser.ts': ['expo-web-browser'],
      'native.ts': ['expo-secure-store', 'react-native'],
      'passkeys.ts': ['react-native-passkey'],
    })
  })

  test('nothing the main entry point reaches imports an optional native module', async () => {
    // `passkeys.ts` and `browser.ts` are entry points; no other source may import either.
    for (const { file, code } of await sources()) {
      for (const path of importsOf(code, file.endsWith('x') ? 'tsx' : 'ts')) {
        expect(/^\.{1,2}\/(passkeys|browser)$/.test(path), `${file} imports ${path}`).toBe(false)
      }
    }
  })

  test('import nothing but React, @tula/core, the native modules and each other', async () => {
    const allowed = new Set([
      'react',
      '@tula/core',
      'expo-secure-store',
      'expo-web-browser',
      'react-native',
      'react-native-passkey',
    ])
    for (const { file, code } of await sources()) {
      for (const path of importsOf(code, file.endsWith('x') ? 'tsx' : 'ts')) {
        expect(path.startsWith('.') || allowed.has(path), `${file} imports ${path}`).toBe(true)
        // A relative import stays inside the package: no other package's sources by path.
        expect(/^(\.\.\/){2}/.test(path), `${file} imports ${path}`).toBe(false)
      }
    }
  })

  test('never write to a log and never name plain app storage', async () => {
    for (const { file, code } of await sources()) {
      // The code, not its comments: the JSDoc says in words what is never used.
      const loader = file.endsWith('x') ? 'tsx' : 'ts'
      const compiled = new Bun.Transpiler({ loader }).transformSync(code)
      expect(compiled, file).not.toMatch(/\bconsole\s*\./)
      expect(compiled, file).not.toMatch(/AsyncStorage|async-storage|localStorage|sessionStorage/)
    }
  })
})

describe('flowScreen', () => {
  const cases: [object, FlowScreen][] = [
    [{ status: 'needs_password' }, 'needs_password'],
    [{ status: 'needs_email_verification', destination: 'm***@x.app' }, 'needs_email_verification'],
    [{ status: 'complete', userId: 'u', sessionId: 's' }, 'complete'],
    [{ status: 'needs_first_factor', strategies: ['password'] }, 'needs_first_factor'],
    [
      { status: 'needs_first_factor', strategies: ['email_link', 'email_code'] },
      'needs_first_factor',
    ],
    [{ status: 'needs_first_factor', strategies: ['sms_code'] }, 'needs_first_factor'],
    // Offered only what an app without a browser cannot do.
    [{ status: 'needs_first_factor', strategies: ['email_link'] }, 'not_supported'],
    [{ status: 'needs_first_factor', strategies: ['passkey', 'google'] }, 'not_supported'],
    [{ status: 'needs_first_factor', strategies: [] }, 'not_supported'],
    [{ status: 'needs_first_factor' }, 'not_supported'],
    [{ status: 'needs_first_factor', strategies: 'password' }, 'not_supported'],
    [{ status: 'needs_second_factor', options: ['passkey', 'totp'] }, 'needs_second_factor'],
    [{ status: 'needs_second_factor', options: ['backup_code'] }, 'needs_second_factor'],
    [{ status: 'needs_second_factor', options: ['sms_code'] }, 'needs_second_factor'],
    [{ status: 'needs_second_factor', options: ['passkey'] }, 'not_supported'],
    [{ status: 'needs_second_factor', options: [{ method: 'totp' }] }, 'not_supported'],
    [{ status: 'needs_factor_enrolment', methods: ['totp'] }, 'needs_factor_enrolment'],
    [{ status: 'needs_factor_enrolment', methods: ['passkey'] }, 'not_supported'],
    [{ status: 'needs_new_password', strategies: ['email_code'] }, 'needs_new_password'],
    [{ status: 'needs_new_password', reason: 'expired', strategies: [] }, 'needs_new_password'],
    [{ status: 'needs_new_password', reason: 'breached', strategies: [] }, 'not_supported'],
    [{ status: 'needs_new_password', reason: null }, 'not_supported'],
    [{ status: 'needs_device_approval' }, 'not_supported'],
    [{ status: 'toString' }, 'not_supported'],
    [{ status: 7 }, 'not_supported'],
    [{}, 'not_supported'],
  ]

  test.each(cases)('%j is %s', (step, screen) => {
    const before = JSON.stringify(step)
    expect(flowScreen(step as never)).toBe(screen)
    expect(JSON.stringify(step)).toBe(before)
  })
})

describe('toTulaError', () => {
  test('keeps a TulaError and wraps anything else without showing its message', () => {
    const original = toTulaError(new RangeError('secret detail'))
    expect(original).toMatchObject({ code: 'internal', status: 0 })
    expect(original.message).not.toContain('secret detail')
    expect(toTulaError(original)).toBe(original)
  })
})
