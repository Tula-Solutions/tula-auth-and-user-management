import { describe, expect, test } from 'bun:test'
import {
  fixtureOrigin,
  gradleArguments,
  PHYSICAL_DEVICE_REFUSAL,
  pickDevice,
  sdkDirectory,
} from '../../native/android/fixture/ui-tests'

// The runner of the Compose screens' UI tests (native/android/fixture/ui-tests.ts) starts the
// real API, an emulator and Gradle on a developer's machine. Nothing of `verify` runs it, so
// what it must never do is held here, from its source and its pure parts.

const RUNNER = new URL('../../native/android/fixture/ui-tests.ts', import.meta.url)

function stream(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk))
      }
      controller.close()
    },
  })
}

/** The text of every `Bun.spawn(…)` and `Bun.spawnSync(…)` call, to its closing parenthesis. */
function spawnCalls(source: string): string[] {
  const calls: string[] = []
  for (const match of source.matchAll(/Bun\.spawn(?:Sync)?\(/g)) {
    const open = match.index + match[0].length
    let depth = 1
    let end = open
    while (end < source.length && depth > 0) {
      const character = source[end]
      depth += character === '(' ? 1 : character === ')' ? -1 : 0
      end += 1
    }
    calls.push(source.slice(match.index, end))
  }
  return calls
}

describe('the runner of the Compose UI tests', () => {
  test('the scan of spawn calls finds both kinds, each whole', () => {
    expect(
      spawnCalls(
        "Bun.spawnSync(['a', f(1)], { timeout: 1 })\nBun.spawn(['b'], {\n  cwd: g(),\n})\n"
      )
    ).toEqual(["Bun.spawnSync(['a', f(1)], { timeout: 1 })", "Bun.spawn(['b'], {\n  cwd: g(),\n})"])
  })

  test('every Bun.spawn and Bun.spawnSync call of the run names a timeout among its arguments', async () => {
    const calls = spawnCalls(await Bun.file(RUNNER).text())
    // Removing the forward, the emulator's shutdown, the boot question, the emulator, the
    // device list, the fixture, the forward and Gradle.
    expect(calls.length).toBe(8)
    expect(calls.filter((call) => !/\btimeout: [A-Z_]+_TIMEOUT_MS\b/.test(call))).toEqual([])
  })

  test('the fixture keeps its guard, and everything is ended in a finally and on a signal', async () => {
    const source = await Bun.file(RUNNER).text()
    expect(source).toContain("KOTLIN_FIXTURE: '1'")
    expect(source).toMatch(/finally \{\s+stop\(\)/)
    // One list is what the handlers are put on: a signal named only in a comment or in the
    // table of exit codes would not be listened for.
    expect(source).toContain("for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'] as const)")
    expect(source).toMatch(/process\.on\(signal, \(\) => \{\s+stop\(\)/)
    // What `stop` ends: Gradle, the forward, the fixture and an emulator this run started.
    const stop = source.slice(
      source.indexOf('const stop = (): void => {'),
      source.indexOf('SIGNAL_EXITS')
    )
    for (const ended of [
      'tests?.kill()',
      "'reverse', '--remove'",
      'fixture?.kill()',
      "'emu', 'kill'",
      'emulator.kill()',
    ]) {
      expect(stop).toContain(ended)
    }
  })

  test('the fixture is reached through a forwarded port, never a wider bind or another host', async () => {
    const source = await Bun.file(RUNNER).text()
    // The fixture decides its own address (127.0.0.1): the runner hands it no host and no port.
    expect(source).not.toMatch(/KOTLIN_FIXTURE_(HOST|PORT)|0\.0\.0\.0|10\.0\.2\.2/)
    expect(source).toContain("'reverse', `tcp:${listening.port}`, `tcp:${listening.port}`")
  })

  test('an emulator this run starts has no window, no sound, and keeps nothing', async () => {
    const source = await Bun.file(RUNNER).text()
    for (const flag of ['-no-window', '-no-audio', '-no-boot-anim', '-no-snapshot-save']) {
      expect(source).toContain(`'${flag}'`)
    }
  })

  test('the fixture’s line is read whole, however it is cut, and only a loopback origin is one', async () => {
    expect(
      await fixtureOrigin(
        stream('TULA_FIXTURE_URL=http://127.0', '.0.1:51', '234\nlater output\n'),
        1_000
      )
    ).toEqual({ origin: 'http://127.0.0.1:51234', port: 51234 })
    // Cut before the end of the line: `5` is not the port `51234`.
    expect(await fixtureOrigin(stream('TULA_FIXTURE_URL=http://127.0.0.1:5'), 1_000)).toBeNull()
    expect(
      await fixtureOrigin(stream('other\nTULA_FIXTURE_URL=http://127.0.0.1:8\n'), 1_000)
    ).toEqual({
      origin: 'http://127.0.0.1:8',
      port: 8,
    })
    for (const line of [
      'TULA_FIXTURE_URL=http://0.0.0.0:51234\n',
      'TULA_FIXTURE_URL=http://example.test:51234\n',
      'TULA_FIXTURE_URL=https://127.0.0.1:51234\n',
      'TULA_FIXTURE_URL=http://127.0.0.1:51234/x\n',
      'nothing\n',
      '',
    ]) {
      expect(await fixtureOrigin(stream(line), 1_000)).toBeNull()
    }
  })

  test('a fixture that says nothing is waited for no longer than said', async () => {
    const silent = new ReadableStream<Uint8Array>({ start() {} })
    const began = Date.now()
    expect(await fixtureOrigin(silent, 50)).toBeNull()
    expect(Date.now() - began).toBeLessThan(2_000)
  })

  test('the device is the one that was named, or the only one that is ready', () => {
    const one = 'List of devices attached\nemulator-5554\tdevice\n\n'
    const two = `${one}R58M123\tdevice\n`
    expect(pickDevice(one)).toEqual({ serial: 'emulator-5554' })
    expect(pickDevice(two, 'emulator-5554')).toEqual({ serial: 'emulator-5554' })
    expect(pickDevice(two)).toEqual({
      problem: 'more than one device is attached: pass --device <serial>',
    })
    expect(pickDevice('List of devices attached\n\n')).toEqual({
      problem: 'no device is attached: start an emulator, or pass --avd <name>',
    })
    // Attached and not ready is not a device to run on, and a refusal repeats no serial.
    for (const state of ['offline', 'unauthorized']) {
      expect(pickDevice(`List of devices attached\nemulator-5554\t${state}\n`)).toHaveProperty(
        'problem'
      )
    }
    expect(pickDevice(one, 'canary-serial')).toEqual({
      problem: 'the device that was named is not attached and ready',
    })
  })

  test('a device that is no emulator is refused unless one was allowed, and told why', () => {
    // `adb reverse` puts the fixture and its admin relay on the device's own loopback, where
    // every app installed on a phone can open them.
    const phone = 'List of devices attached\nR58M123\tdevice\n'
    const both = `${phone}emulator-5554\tdevice\n`
    for (const refused of [
      pickDevice(both, 'R58M123'),
      pickDevice(phone),
      pickDevice(phone, 'R58M123', false),
    ]) {
      expect(refused).toEqual({ problem: PHYSICAL_DEVICE_REFUSAL })
    }
    expect(PHYSICAL_DEVICE_REFUSAL).toContain('every app')
    expect(PHYSICAL_DEVICE_REFUSAL).toContain('--allow-physical')
    expect(PHYSICAL_DEVICE_REFUSAL).not.toContain('R58M123')
    // Asked for, a phone is run on; an emulator needs no asking, and a name that only holds the
    // word is not one.
    expect(pickDevice(both, 'R58M123', true)).toEqual({ serial: 'R58M123' })
    expect(pickDevice(phone, undefined, true)).toEqual({ serial: 'R58M123' })
    expect(pickDevice(both, 'emulator-5554')).toEqual({ serial: 'emulator-5554' })
    expect(pickDevice('List of devices attached\nmy-emulator-1\tdevice\n')).toEqual({
      problem: PHYSICAL_DEVICE_REFUSAL,
    })
  })

  test('the run hands the pick what the command line allowed, and nothing else allows a phone', async () => {
    const source = await Bun.file(RUNNER).text()
    expect(source).toContain("own.includes('--allow-physical')")
    expect(source.match(/pickDevice\(/g)?.length).toBe(2)
  })

  test('the SDK is what the environment names, then where Android Studio puts one', () => {
    const none = () => false
    expect(sdkDirectory({ ANDROID_HOME: '/sdk' }, none, '/home/u')).toBe('/sdk')
    expect(sdkDirectory({ ANDROID_HOME: ' ', ANDROID_SDK_ROOT: '/root' }, none, '/home/u')).toBe(
      '/root'
    )
    expect(sdkDirectory({}, (path) => path === '/home/u/Android/Sdk', '/home/u')).toBe(
      '/home/u/Android/Sdk'
    )
    expect(sdkDirectory({}, (path) => path === '/home/u/Library/Android/sdk', '/home/u')).toBe(
      '/home/u/Library/Android/sdk'
    )
    expect(sdkDirectory({}, none, '/home/u')).toBeNull()
  })

  test('Gradle is given the tests to run and where the fixture is, and nothing else of its own', () => {
    expect(gradleArguments('http://127.0.0.1:51234', ['--info'])).toEqual([
      './gradlew',
      '--console=plain',
      ':compose-example:connectedDebugAndroidTest',
      '-Pandroid.testInstrumentationRunnerArguments.tulaFixtureUrl=http://127.0.0.1:51234',
      '--info',
    ])
  })
})
