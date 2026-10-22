import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseManifest } from '../../apps/docs/src/lib/native-captures'
import { gradleArguments } from '../../native/android/fixture/ui-tests'
import {
  ANDROID_CAPTURE_DIRECTORY,
  buildManifest,
  CAPTURE_SCREENS,
  CAPTURE_THEMES,
  captureFileName,
  MAX_CAPTURE_BYTES,
  type ManifestInput,
  parseCaptureArgs,
  parseCaptureFileName,
  pngSize,
} from '../../native/fixture/captures'

// The screenshot mode of the two UI-test runners (`--screenshots <dir>`): the flag, the names of
// the pictures and the manifest that lists them. Nothing here starts a simulator or an emulator;
// that is by hand, like the runners.

const SHARED = new URL('../../native/fixture/captures.ts', import.meta.url)
const RUNNERS = [
  new URL('../../native/swift/fixture/ui-tests.ts', import.meta.url),
  new URL('../../native/android/fixture/ui-tests.ts', import.meta.url),
]

function input(files: ManifestInput['files']): ManifestInput {
  return {
    platform: 'ios',
    commit: 'abc123',
    dirty: false,
    now: new Date('2026-10-22T20:00:00Z'),
    device: { name: 'iPhone 16', os: 'iOS 18.5' },
    tools: { xcode: '16.4' },
    files,
  }
}

function file(name: string, bytes = 20_000) {
  return { file: name, width: 560, height: 1213, bytes, sha256: 'f'.repeat(64) }
}

describe('--screenshots', () => {
  test('is absent, or names a directory', () => {
    expect(parseCaptureArgs([])).toEqual({ directory: null })
    expect(parseCaptureArgs(['--simulator', 'x'])).toEqual({ directory: null })
    expect(parseCaptureArgs(['--screenshots', 'apps/docs/public/native/ios'])).toEqual({
      directory: 'apps/docs/public/native/ios',
    })
    expect(parseCaptureArgs(['--avd', 'a', '--screenshots', '/tmp/x', '--allow-physical'])).toEqual(
      { directory: '/tmp/x' }
    )
  })

  test('is refused without a directory, with a flag in its place, and twice', () => {
    for (const args of [
      ['--screenshots'],
      ['--screenshots', ''],
      ['--screenshots', '--avd', 'a'],
    ]) {
      expect(parseCaptureArgs(args).problem).toContain('needs a directory')
    }
    expect(parseCaptureArgs(['--screenshots', 'a', '--screenshots', 'b']).problem).toContain(
      'twice'
    )
    // A refused flag names no directory: nothing is written anywhere on a guess.
    expect(parseCaptureArgs(['--screenshots']).directory).toBeNull()
  })
})

describe('the names of the pictures', () => {
  test('a name is made and read back, for every screen, step and theme of the vocabulary', () => {
    for (const { screen, step } of CAPTURE_SCREENS) {
      for (const theme of CAPTURE_THEMES) {
        const name = captureFileName({ screen, step, theme })
        expect(parseCaptureFileName(name)).toEqual({ screen, step, theme })
      }
    }
  })

  test('a file of another name, a step the vocabulary lacks or a theme it lacks is not a picture', () => {
    for (const name of [
      'sign-in.email.sepia.png',
      'sign-in.nonsense.light.png',
      'nonsense.email.light.png',
      'sign-in.email.light.jpg',
      'sign-in.email.light.png.bak',
      '../sign-in.email.light.png',
      'manifest.json',
      '.DS_Store',
    ]) {
      expect(parseCaptureFileName(name)).toBeNull()
    }
  })

  test('the vocabulary lists no screen and step twice', () => {
    const keys = CAPTURE_SCREENS.map((one) => `${one.screen}/${one.step}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('the manifest', () => {
  test('lists each picture with its screen, step and theme, in the vocabulary order, light first', () => {
    const made = buildManifest(
      input([
        file('account.overview.dark.webp'),
        file('sign-in.email.dark.webp'),
        file('sign-in.email.light.webp'),
      ])
    )
    expect(made.captures.map((one) => one.file)).toEqual([
      'sign-in.email.light.webp',
      'sign-in.email.dark.webp',
      'account.overview.dark.webp',
    ])
    expect(made.captures[0]).toMatchObject({ screen: 'sign-in', step: 'email', theme: 'light' })
    expect(made).toMatchObject({
      version: 1,
      platform: 'ios',
      commit: 'abc123',
      dirty: false,
      capturedAt: '2026-10-22T20:00:00.000Z',
      device: { name: 'iPhone 16', os: 'iOS 18.5' },
      tools: { xcode: '16.4' },
    })
  })

  test('refuses a picture over the size budget, naming it', () => {
    expect(() =>
      buildManifest(input([file('sign-in.email.light.webp', MAX_CAPTURE_BYTES + 1)]))
    ).toThrow(/sign-in\.email\.light\.webp.*over the budget/)
    // At the budget is within it.
    expect(
      buildManifest(input([file('sign-in.email.light.webp', MAX_CAPTURE_BYTES)])).captures
    ).toHaveLength(1)
  })

  test('refuses a file that is not of the vocabulary, a repeat and an empty run', () => {
    expect(() => buildManifest(input([file('sign-in.email.light.png')]))).toThrow(/not a capture/)
    expect(() => buildManifest(input([file('stray.webp')]))).toThrow(/not a capture/)
    expect(() =>
      buildManifest(input([file('sign-in.email.light.webp'), file('sign-in.email.light.webp')]))
    ).toThrow(/twice/)
    expect(() => buildManifest(input([]))).toThrow(/no capture/)
  })
})

describe('the size of a PNG', () => {
  test('is read from the header, and a file that is no PNG has none', () => {
    const header = new Uint8Array(24)
    header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const view = new DataView(header.buffer)
    view.setUint32(16, 1179)
    view.setUint32(20, 2556)
    expect(pngSize(header)).toEqual({ width: 1179, height: 2556 })
    expect(pngSize(new Uint8Array(24))).toBeNull()
    expect(pngSize(new Uint8Array(3))).toBeNull()
  })
})

describe('the runners', () => {
  test('every process the shared module starts has a timeout', async () => {
    const source = await Bun.file(SHARED).text()
    const calls = [...source.matchAll(/Bun\.spawn(?:Sync)?\(/g)].map((match) => {
      let depth = 1
      let end = match.index + match[0].length
      while (end < source.length && depth > 0) {
        depth += source[end] === '(' ? 1 : source[end] === ')' ? -1 : 0
        end += 1
      }
      return source.slice(match.index, end)
    })
    expect(calls.length).toBeGreaterThan(5)
    expect(calls.filter((call) => !/\btimeout(: [A-Z_]+_TIMEOUT_MS|\b[,\s}])/.test(call))).toEqual(
      []
    )
  })

  test('both runners take the flag, write through the shared module and clean up in the finally', async () => {
    for (const runner of RUNNERS) {
      const source = await Bun.file(runner).text()
      expect(source).toContain('parseCaptureArgs(own)')
      expect(source).toContain('finishCaptures(')
      // The raw screenshots are deleted whether or not the run passed.
      expect(source).toMatch(/const stop = \(\): void => \{[\s\S]*removeRaw\(rawCaptures\)/)
    }
    expect(await Bun.file(RUNNERS[0] as URL).text()).toContain('CaptureUITests')
    expect(await Bun.file(RUNNERS[1] as URL).text()).toContain('CaptureTest')
  })

  test('the tests skip themselves without the directory, so that a normal run is unchanged', async () => {
    const swift = await Bun.file(
      new URL('../../examples/swiftui/TulaExampleUITests/CaptureUITests.swift', import.meta.url)
    ).text()
    expect(swift).toContain('XCTSkip')
    expect(swift).toContain('TULA_CAPTURE_DIR')
    const kotlin = await Bun.file(
      new URL(
        '../../examples/compose/src/androidTest/kotlin/dev/tula/example/compose/CaptureTest.kt',
        import.meta.url
      )
    ).text()
    expect(kotlin).toContain('assumeTrue')
    expect(kotlin).toContain('tulaCaptureDir')
  })

  test('the Android capture run names the capture class and the directory only when asked', () => {
    const plain = gradleArguments('http://127.0.0.1:1', [])
    expect(plain.join(' ')).not.toContain('CaptureTest')
    expect(plain.join(' ')).not.toContain('tulaCaptureDir')
    const capture = gradleArguments('http://127.0.0.1:1', [], true)
    expect(capture).toContain(
      '-Pandroid.testInstrumentationRunnerArguments.class=dev.tula.example.compose.CaptureTest'
    )
    expect(capture).toContain(
      `-Pandroid.testInstrumentationRunnerArguments.tulaCaptureDir=${ANDROID_CAPTURE_DIRECTORY}`
    )
  })

  test('every screen the vocabulary lists is photographed by both platforms’ tests', async () => {
    const swift = await Bun.file(
      new URL('../../examples/swiftui/TulaExampleUITests/CaptureUITests.swift', import.meta.url)
    ).text()
    const kotlin = await Bun.file(
      new URL(
        '../../examples/compose/src/androidTest/kotlin/dev/tula/example/compose/CaptureTest.kt',
        import.meta.url
      )
    ).text()
    for (const { screen, step } of CAPTURE_SCREENS) {
      for (const source of [swift, kotlin]) {
        expect(source).toContain(
          `capture("${screen}", "${step}", ${source === swift ? 'dark: dark' : 'dark'})`
        )
      }
    }
  })
})

describe('the manifests of the docs site', () => {
  const ROOT = join(import.meta.dir, '../../apps/docs/public/native')

  test('what the runners write is what the site reads', () => {
    const made = buildManifest({
      ...input([file('sign-in.email.light.webp'), file('sign-in.email.dark.webp')]),
      commit: 'a'.repeat(40),
    })
    const read = parseManifest('manifest.json', JSON.stringify(made), 'ios')
    expect(read.captures.map((one) => one.file)).toEqual(made.captures.map((one) => one.file))
  })

  test.each(['ios', 'android'] as const)(
    'the committed %s captures are the ones their manifest lists, byte for byte',
    (platform) => {
      const directory = join(ROOT, platform)
      if (!existsSync(join(directory, 'manifest.json'))) {
        // A platform nobody has captured yet: the site says so, and there is nothing to hold.
        return
      }
      const manifest = parseManifest(
        join(directory, 'manifest.json'),
        readFileSync(join(directory, 'manifest.json'), 'utf8'),
        platform
      )
      for (const one of manifest.captures) {
        const bytes = readFileSync(join(directory, one.file))
        expect(bytes.length).toBe(one.bytes)
        expect(bytes.length).toBeLessThanOrEqual(MAX_CAPTURE_BYTES)
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(one.sha256)
      }
    }
  )
})
