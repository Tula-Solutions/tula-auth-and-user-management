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
  test('is one file that imports React, @tula/core and the two native modules, and bundles none of them', async () => {
    const files = (await readdir(out)).filter((file) => file.endsWith('.js'))
    expect(files).toEqual(['index.js'])
    const code = await Bun.file(join(out, 'index.js')).text()
    expect([...new Set(importsOf(code, 'js'))]).toEqual([
      '@tula/core',
      'expo-secure-store',
      'react',
      'react-native',
    ])
  })

  test('has nothing of a browser, of plain app storage or of a log in it', async () => {
    const code = await Bun.file(join(out, 'index.js')).text()
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
  })
})

describe('the sources', () => {
  test('only native.ts imports a native module, so everything else runs without a device', async () => {
    const native = ['expo-secure-store', 'react-native']
    const importers = (await sources())
      .filter(({ file, code }) =>
        importsOf(code, file.endsWith('x') ? 'tsx' : 'ts').some((path) => native.includes(path))
      )
      .map(({ file }) => file)
    expect(importers).toEqual(['native.ts'])
  })

  test('import nothing but React, @tula/core, the native modules and each other', async () => {
    const allowed = new Set(['react', '@tula/core', 'expo-secure-store', 'react-native'])
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
