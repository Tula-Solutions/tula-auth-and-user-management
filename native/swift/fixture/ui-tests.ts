import { join } from 'node:path'

// Runs the UI tests of the SwiftUI screens (examples/swiftui/TulaExampleUITests) on an iOS
// simulator, against the real API on this machine.
//
//   bun run native/swift/fixture/ui-tests.ts                       an iPhone simulator it picks
//   bun run native/swift/fixture/ui-tests.ts --simulator <udid>    this one
//   bun run native/swift/fixture/ui-tests.ts -- -only-testing:TulaExampleUITests/AuthScreensUITests/testPasswordReset
//
// A test runner on a simulator cannot start a process of the machine, so this does what the
// Swift journey tests do for themselves: it starts native/swift/fixture/server.ts (the real
// API in memory, on a loopback port the system picks), hands its address to the tests as
// TULA_FIXTURE_ORIGIN and ends it when `xcodebuild` has. A simulator shares the machine's
// loopback address, which is why 127.0.0.1 is enough and the fixture stays bound to it.
//
// Needs Xcode with an iOS simulator runtime of iOS 17 or later (it was run with Xcode 16.4).
// Not part of `verify`, which has no Swift toolchain, and in no workflow; docs/swift.md,
// "Tests", and docs/plans/phase-2-unverified.md say what was run.

/** One simulator, as far as `xcrun simctl list devices available -j` is read. */
interface SimulatorDevice {
  udid: string
  name: string
  isAvailable?: boolean
}

/** A simulator this script can run the tests on. */
export interface Simulator {
  /** The device's id, for `-destination`. */
  udid: string
  /** Its name, for the log: `iPhone 16`. */
  name: string
  /** The iOS version of its runtime: `18.5`. */
  version: string
}

/** The numbers of a runtime's version, for an order: `18.10` is after `18.9`. */
function versionParts(version: string): number[] {
  return version.split('.').map((part) => Number.parseInt(part, 10) || 0)
}

function compareVersions(a: string, b: string): number {
  const [left, right] = [versionParts(a), versionParts(b)]
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) {
      return difference
    }
  }
  return 0
}

/**
 * Pick the simulator to run on: an iPhone of the newest iOS runtime that has one, the first
 * by name so that the choice is the same on every run of one machine.
 *
 * @param list - The parsed output of `xcrun simctl list devices available -j`.
 * @returns The simulator, or `null` when the machine has no available iPhone simulator.
 */
export function pickSimulator(list: unknown): Simulator | null {
  const devices = (list as { devices?: Record<string, SimulatorDevice[]> }).devices ?? {}
  const phones: Simulator[] = []
  for (const runtime of Object.keys(devices)) {
    const match = /SimRuntime\.iOS-(\d+(?:-\d+)*)$/.exec(runtime)
    if (!match) {
      continue
    }
    const version = (match[1] as string).replaceAll('-', '.')
    for (const device of devices[runtime] ?? []) {
      if (device.isAvailable !== false && device.name.startsWith('iPhone')) {
        phones.push({ udid: device.udid, name: device.name, version })
      }
    }
  }
  phones.sort((a, b) => compareVersions(b.version, a.version) || (a.name < b.name ? -1 : 1))
  return phones[0] ?? null
}

/**
 * The arguments of the `xcodebuild` run.
 *
 * @param udid - The simulator.
 * @param derivedData - Where the build goes: a directory git ignores.
 * @param extra - Anything passed after `--` (`-only-testing:…`).
 * @returns The argument vector.
 */
export function xcodebuildArguments(udid: string, derivedData: string, extra: string[]): string[] {
  return [
    'xcodebuild',
    'test',
    '-project',
    'examples/swiftui/TulaExample.xcodeproj',
    '-scheme',
    'TulaExample',
    '-destination',
    `platform=iOS Simulator,id=${udid}`,
    '-derivedDataPath',
    derivedData,
    // One simulator, one test at a time: every test has an API of its own, and the device's
    // colour scheme is the device's.
    '-parallel-testing-enabled',
    'NO',
    ...extra,
  ]
}

/** How long a tool that only answers a question may take. */
const ASK_TIMEOUT_MS = 60_000
/** How long the build and the tests may take together. */
const TEST_TIMEOUT_MS = 40 * 60_000

if (import.meta.main) {
  const root = join(import.meta.dir, '../../..')
  const args = process.argv.slice(2)
  const rest = args.includes('--') ? args.slice(args.indexOf('--') + 1) : []
  const named = args.indexOf('--simulator')
  let udid = named >= 0 ? args[named + 1] : undefined

  if (udid === undefined) {
    const asked = Bun.spawnSync(['xcrun', 'simctl', 'list', 'devices', 'available', '-j'], {
      timeout: ASK_TIMEOUT_MS,
    })
    const picked = asked.exitCode === 0 ? pickSimulator(JSON.parse(asked.stdout.toString())) : null
    if (picked === null) {
      process.stderr.write(
        'no available iPhone simulator: install an iOS simulator runtime in Xcode, or pass --simulator <udid>\n'
      )
      process.exit(1)
    }
    process.stdout.write(`simulator: ${picked.name}, iOS ${picked.version} (${picked.udid})\n`)
    udid = picked.udid
  }

  const fixture = Bun.spawn(['bun', 'run', 'native/swift/fixture/server.ts'], {
    cwd: root,
    env: { ...process.env, TULA_NATIVE_FIXTURE: '1', LOG_LEVEL: 'silent' },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  })
  // The fixture prints one line when it listens.
  const first = await fixture.stdout.getReader().read()
  const ready = /"port":(\d+)/.exec(new TextDecoder().decode(first.value))
  if (!ready) {
    process.stderr.write('the fixture did not start\n')
    fixture.kill()
    process.exit(1)
  }
  const origin = `http://127.0.0.1:${ready[1]}`
  process.stdout.write(`fixture: ${origin}\n`)

  const derivedData = join(root, 'examples/swiftui/build')
  const tests = Bun.spawn(xcodebuildArguments(udid as string, derivedData, rest), {
    cwd: root,
    // `xcodebuild` hands a variable named TEST_RUNNER_<NAME> to the test runner as <NAME>.
    env: {
      ...process.env,
      TEST_RUNNER_TULA_FIXTURE_ORIGIN: origin,
      // Where a failed test keeps a picture of the screen, when the caller named a directory.
      ...(process.env.TULA_SCREENSHOT_DIR
        ? { TEST_RUNNER_TULA_SCREENSHOT_DIR: process.env.TULA_SCREENSHOT_DIR }
        : {}),
    },
    stdout: 'inherit',
    stderr: 'inherit',
    timeout: TEST_TIMEOUT_MS,
  })
  const code = await tests.exited
  // The fixture ends when its standard input closes.
  fixture.stdin.end()
  fixture.kill()
  process.exit(code)
}
