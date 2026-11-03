import { join, resolve } from 'node:path'
import {
  finishCaptures,
  parseCaptureArgs,
  prepareSimulator,
  rawDirectory,
  removeRaw,
  restoreSimulator,
  simulatorFacts,
} from '../../fixture/captures'

// Runs the UI tests of the SwiftUI screens (examples/swiftui/TulaExampleUITests) on an iOS
// simulator, against the real API on this machine.
//
//   bun run native/swift/fixture/ui-tests.ts                       an iPhone simulator it picks
//   bun run native/swift/fixture/ui-tests.ts --simulator <udid>    this one
//   bun run native/swift/fixture/ui-tests.ts -- -only-testing:TulaExampleUITests/AuthScreensUITests/testPasswordReset
//   bun run native/swift/fixture/ui-tests.ts --screenshots apps/docs/public/native/ios
//                                                                  not a test run: photographs the
//                                                                  screens in both colour schemes
//                                                                  and writes the files and the
//                                                                  manifest the documentation shows
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

/**
 * Read the port the fixture says it listens on: the `"port":<n>` of the first line it prints.
 *
 * The line is read whole, however the pipe cuts it into chunks, and only the first line is
 * looked at. On a port the rest of the stream is read and dropped in the background, so that
 * a fixture that prints more never waits on a full pipe; otherwise the stream is cancelled.
 *
 * @param stream - The fixture's standard output.
 * @param deadlineMs - How long to wait for the line.
 * @returns The port, or `null` when the first line names none, the stream ended before a
 *   whole line, or the deadline passed.
 */
export async function readyPort(
  stream: ReadableStream<Uint8Array>,
  deadlineMs: number
): Promise<number | null> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), deadlineMs)
  })
  let text = ''
  let port: number | null = null
  try {
    while (!text.includes('\n')) {
      const chunk = await Promise.race([reader.read(), late])
      if (chunk === null || chunk.done) {
        break
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
    const end = text.indexOf('\n')
    const match = end < 0 ? null : /"port":(\d+)/.exec(text.slice(0, end))
    port = match ? Number(match[1]) : null
  } finally {
    clearTimeout(timer)
  }
  if (port === null) {
    // Nothing more is wanted of it. A cancel that fails changes nothing the caller does.
    await reader.cancel().catch(() => undefined)
    return null
  }
  void (async () => {
    try {
      while (!(await reader.read()).done) {
        // Read and dropped.
      }
    } catch {
      // The fixture went away while its output was being dropped: there is nothing to keep.
    }
  })()
  return port
}

/** How long a tool that only answers a question may take. */
const ASK_TIMEOUT_MS = 60_000
/** How long the build and the tests may take together. */
const TEST_TIMEOUT_MS = 40 * 60_000
/** How long the fixture may take to say it listens. */
const READY_TIMEOUT_MS = 60_000
/** How long the fixture may live at most: the tests' time and a margin to start in. */
const FIXTURE_TIMEOUT_MS = TEST_TIMEOUT_MS + 5 * 60_000

if (import.meta.main) {
  const root = join(import.meta.dir, '../../..')
  const args = process.argv.slice(2)
  const own = args.includes('--') ? args.slice(0, args.indexOf('--')) : args
  const captures = parseCaptureArgs(own)
  if (captures.problem !== undefined) {
    process.stderr.write(`${captures.problem}\n`)
    process.exit(1)
  }
  // A capture run is the capture tests alone; every other test skips itself without the
  // directory, and the others are not what the caller asked for.
  const rest = [
    ...(captures.directory === null ? [] : ['-only-testing:TulaExampleUITests/CaptureUITests']),
    ...(args.includes('--') ? args.slice(args.indexOf('--') + 1) : []),
  ]
  const rawCaptures = captures.directory === null ? null : rawDirectory()
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
    // Longer than the tests may take: the fixture is ended below, and this ends it when this
    // process is no longer there to do it in time.
    timeout: FIXTURE_TIMEOUT_MS,
  })
  let tests: ReturnType<typeof Bun.spawn> | undefined

  /** End what this run started. Safe to call twice: on a signal and again in the `finally`. */
  const stop = (): void => {
    tests?.kill()
    if (rawCaptures !== null) {
      removeRaw(rawCaptures)
    }
    if (captures.directory !== null && udid !== undefined) {
      restoreSimulator(udid)
    }
    try {
      // The fixture ends when its standard input closes.
      fixture.stdin.end()
    } catch {
      // Already closed, by an earlier call or because the fixture is gone: it is killed next.
    }
    fixture.kill()
  }
  // 128 + the signal's number, as a shell reports a process a signal ended.
  const SIGNAL_EXITS = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const
  for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      stop()
      process.exit(SIGNAL_EXITS[signal])
    })
  }

  let code = 1
  try {
    // The fixture prints one line when it listens.
    const port = await readyPort(fixture.stdout, READY_TIMEOUT_MS)
    if (port === null) {
      process.stderr.write('the fixture did not start\n')
    } else {
      const origin = `http://127.0.0.1:${port}`
      process.stdout.write(`fixture: ${origin}\n`)

      const derivedData = join(root, 'examples/swiftui/build')
      const ready = captures.directory === null || prepareSimulator(udid as string)
      if (!ready) {
        process.stderr.write('the simulator did not boot, or took no status bar override\n')
      }
      if (ready) {
        tests = Bun.spawn(xcodebuildArguments(udid as string, derivedData, rest), {
          cwd: root,
          // `xcodebuild` hands a variable named TEST_RUNNER_<NAME> to the test runner as <NAME>.
          env: {
            ...process.env,
            TEST_RUNNER_TULA_FIXTURE_ORIGIN: origin,
            // Where a failed test keeps a picture of the screen, when the caller named a directory.
            ...(process.env.TULA_SCREENSHOT_DIR
              ? { TEST_RUNNER_TULA_SCREENSHOT_DIR: process.env.TULA_SCREENSHOT_DIR }
              : {}),
            ...(rawCaptures !== null ? { TEST_RUNNER_TULA_CAPTURE_DIR: rawCaptures } : {}),
          },
          stdout: 'inherit',
          stderr: 'inherit',
          timeout: TEST_TIMEOUT_MS,
        })
        code = await tests.exited
        if (code === 0 && rawCaptures !== null && captures.directory !== null) {
          const outDirectory = resolve(root, captures.directory)
          const made = finishCaptures({
            platform: 'ios',
            rawDirectory: rawCaptures,
            outDirectory,
            root,
            ...simulatorFacts(udid as string),
          })
          process.stdout.write(`captures: ${made.captures.length} in ${outDirectory}\n`)
        }
      }
    }
  } finally {
    stop()
  }
  process.exit(code)
}
