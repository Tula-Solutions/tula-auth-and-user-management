import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  ANDROID_CAPTURE_DIRECTORY,
  deviceFacts,
  finishCaptures,
  parseCaptureArgs,
  prepareDevice,
  pullCaptures,
  rawDirectory,
  removeRaw,
  restoreDevice,
} from '../../fixture/captures'

// Runs the UI tests of the Compose screens (examples/compose/src/androidTest) on an Android
// device or emulator, against the real API on this machine.
//
//   bun run native/android/fixture/ui-tests.ts                    the one device `adb` sees
//   bun run native/android/fixture/ui-tests.ts --device <serial>  this one
//   bun run native/android/fixture/ui-tests.ts --allow-physical   also where the device is no
//                                                                 emulator (read below first)
//   bun run native/android/fixture/ui-tests.ts --avd <name>       starts that emulator without a
//                                                                 window, and shuts it down again
//   bun run native/android/fixture/ui-tests.ts -- <gradle arguments>
//   bun run native/android/fixture/ui-tests.ts --avd <name> --screenshots apps/docs/public/native/android
//                                                                 not a test run: photographs the
//                                                                 screens in both colour schemes
//                                                                 and writes the files and the
//                                                                 manifest the documentation shows
//
// A test on a device cannot start a process of the machine, so this does: it starts
// e2e/kotlin-fixture.ts (the real API in memory, on a loopback port the system picks), forwards
// that port into the device with `adb reverse`, hands the address to the tests as the
// instrumentation argument `tulaFixtureUrl`, and ends everything it started when Gradle has.
// The fixture stays bound to 127.0.0.1 and its test routes keep insisting on that `Host`:
// inside the device the address is the same, because the port is forwarded, not exposed.
//
// Forwarded into a device, the port is that device's own 127.0.0.1, and every app on it can
// open it: the fixture's test routes, and through them its relay to the admin API of the run's
// environments. On an emulator this run started, or one a developer keeps for tests, those apps
// are the image's. On a phone they are whatever is installed on it. So a device whose serial
// does not start with `emulator-` is refused unless --allow-physical is given, and the refusal
// says why. Nothing was run on a phone.
//
// Needs a JDK, an Android SDK (ANDROID_HOME, ANDROID_SDK_ROOT or the default place Android
// Studio installs one) and a device or an emulator image. Not part of `verify` and in no
// workflow; docs/kotlin.md, "Screens", and docs/plans/phase-2-unverified.md say what was run.

/**
 * Where the Android SDK is: what the environment names, or the place Android Studio puts one.
 *
 * @param env - The environment's variables.
 * @param exists - Whether a directory is there.
 * @param home - The user's home directory.
 * @returns The SDK's directory, or `null` when none is named and none is in a default place.
 */
export function sdkDirectory(
  env: Record<string, string | undefined>,
  exists: (path: string) => boolean,
  home: string
): string | null {
  const named = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT].find(
    (value) => value !== undefined && value.trim() !== ''
  )
  if (named !== undefined) {
    return named
  }
  const defaults = [join(home, 'Library/Android/sdk'), join(home, 'Android/Sdk')]
  return defaults.find((path) => exists(path)) ?? null
}

/**
 * Pick the device to run on from what `adb devices` printed.
 *
 * A device that is no emulator is refused unless the caller allowed one: `adb reverse` puts
 * the fixture, and its relay to the admin API, on the device's own loopback address, where
 * every app installed on it can reach them. That holds for the one device `adb` sees as much
 * as for one that was named.
 *
 * @param listing - The output of `adb devices`.
 * @param wanted - A serial the caller asked for.
 * @param allowPhysical - Whether a device that is no emulator may be picked.
 * @returns The serial, or a sentence that says why there is none: the caller's serial is not
 *   attached and ready, nothing is attached, more than one is and none was named, or the
 *   device is no emulator and none was allowed. A refusal repeats no serial.
 */
export function pickDevice(
  listing: string,
  wanted?: string,
  allowPhysical = false
): { serial: string } | { problem: string } {
  const picked = attachedDevice(listing, wanted)
  if ('serial' in picked && !allowPhysical && !picked.serial.startsWith(EMULATOR_SERIAL_PREFIX)) {
    return { problem: PHYSICAL_DEVICE_REFUSAL }
  }
  return picked
}

/** How `adb` names an emulator: `emulator-<console port>`. Anything else is taken for a device. */
const EMULATOR_SERIAL_PREFIX = 'emulator-'

/** Why a device that is no emulator is not run on unasked. */
export const PHYSICAL_DEVICE_REFUSAL =
  'the device is not an emulator: forwarding the fixture’s port into it would let every app ' +
  'installed on it reach the fixture and its relay to the admin API. Use an emulator ' +
  '(--avd <name>), or pass --allow-physical for a device that holds only what you trust'

/** The device that was named, or the only one that is attached and ready. */
function attachedDevice(
  listing: string,
  wanted?: string
): { serial: string } | { problem: string } {
  const ready = listing
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length === 2 && parts[1] === 'device')
    .map((parts) => parts[0] as string)
  if (wanted !== undefined) {
    return ready.includes(wanted)
      ? { serial: wanted }
      : { problem: 'the device that was named is not attached and ready' }
  }
  if (ready.length === 1) {
    return { serial: ready[0] as string }
  }
  return {
    problem:
      ready.length === 0
        ? 'no device is attached: start an emulator, or pass --avd <name>'
        : 'more than one device is attached: pass --device <serial>',
  }
}

const ADDRESS = /^TULA_FIXTURE_URL=(http:\/\/127\.0\.0\.1:(\d+))$/m

/**
 * Read where the fixture listens from what it prints: the line `TULA_FIXTURE_URL=<origin>`.
 *
 * The line is read whole, however the pipe cuts it into chunks. Once it is found the rest of
 * the stream is read and dropped in the background, so that the fixture never waits on a full
 * pipe; otherwise the stream is cancelled.
 *
 * @param stream - The fixture's standard output.
 * @param deadlineMs - How long to wait for the line.
 * @returns The origin and its port, or `null` when the stream ended or the deadline passed
 *   without the line. Only a loopback origin is one.
 */
export async function fixtureOrigin(
  stream: ReadableStream<Uint8Array>,
  deadlineMs: number
): Promise<{ origin: string; port: number } | null> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), deadlineMs)
  })
  let text = ''
  let found: RegExpExecArray | null = null
  try {
    while (found === null) {
      const chunk = await Promise.race([reader.read(), late])
      if (chunk === null || chunk.done) {
        break
      }
      text += decoder.decode(chunk.value, { stream: true })
      // Only a whole line counts: the address may be cut anywhere.
      found = ADDRESS.exec(text.slice(0, text.lastIndexOf('\n') + 1))
    }
  } finally {
    clearTimeout(timer)
  }
  if (found === null) {
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
  return { origin: found[1] as string, port: Number(found[2]) }
}

/**
 * The Gradle command that builds the example and its tests, installs both and runs the tests.
 *
 * @param origin - The fixture's origin, handed to the tests as an instrumentation argument.
 * @param extra - Arguments of the caller's, put last.
 * @param capture - Whether this is a capture run: only the capture tests, told where to write.
 * @returns The argument vector.
 */
export function gradleArguments(
  origin: string,
  extra: readonly string[],
  capture = false
): string[] {
  return [
    './gradlew',
    '--console=plain',
    ':compose-example:connectedDebugAndroidTest',
    `-Pandroid.testInstrumentationRunnerArguments.tulaFixtureUrl=${origin}`,
    // A capture run is the capture tests alone; they write where the device lets the shell.
    ...(capture
      ? [
          '-Pandroid.testInstrumentationRunnerArguments.class=dev.tula.example.compose.CaptureTest',
          `-Pandroid.testInstrumentationRunnerArguments.tulaCaptureDir=${ANDROID_CAPTURE_DIRECTORY}`,
        ]
      : []),
    ...extra,
  ]
}

/** How long a tool that only answers a question, or does one small thing, may take. */
const ASK_TIMEOUT_MS = 60_000
/** How long an emulator may take to have started Android. */
const BOOT_TIMEOUT_MS = 6 * 60_000
/** How long the build, the install and the tests may take together. */
const TEST_TIMEOUT_MS = 40 * 60_000
/** How long the fixture may take to say where it listens. It loads the whole API first. */
const READY_TIMEOUT_MS = 60_000
/** How long the fixture may live at most: the tests' time and a margin to start in. */
const FIXTURE_TIMEOUT_MS = TEST_TIMEOUT_MS + BOOT_TIMEOUT_MS + 5 * 60_000
/** How long an emulator this run started may live at most. */
const EMULATOR_TIMEOUT_MS = FIXTURE_TIMEOUT_MS
/** The console port of an emulator this run starts, and so its serial. */
const EMULATOR_PORT = 5580

if (import.meta.main) {
  const root = join(import.meta.dir, '../../..')
  const args = process.argv.slice(2)
  const own = args.includes('--') ? args.slice(0, args.indexOf('--')) : args
  const rest = args.includes('--') ? args.slice(args.indexOf('--') + 1) : []
  const option = (name: string): string | undefined => {
    const at = own.indexOf(name)
    return at >= 0 ? own[at + 1] : undefined
  }
  const avd = option('--avd')
  const captures = parseCaptureArgs(own)
  if (captures.problem !== undefined) {
    process.stderr.write(`${captures.problem}\n`)
    process.exit(1)
  }
  const rawCaptures = captures.directory === null ? null : rawDirectory()

  const sdk = sdkDirectory(process.env, existsSync, homedir())
  if (sdk === null) {
    process.stderr.write('no Android SDK: set ANDROID_HOME\n')
    process.exit(1)
  }
  const adb = join(sdk, 'platform-tools/adb')

  let emulator: ReturnType<typeof Bun.spawn> | undefined
  let fixture: ReturnType<typeof Bun.spawn> | undefined
  let tests: ReturnType<typeof Bun.spawn> | undefined
  let serial: string | undefined
  let forwarded: number | undefined

  /** End what this run started. Safe to call twice: on a signal and again in the `finally`. */
  const stop = (): void => {
    tests?.kill()
    if (rawCaptures !== null) {
      removeRaw(rawCaptures)
    }
    if (captures.directory !== null && serial !== undefined) {
      restoreDevice(adb, serial)
    }
    if (serial !== undefined && forwarded !== undefined) {
      // The forward is the device's, not this process's: taken away by name.
      Bun.spawnSync([adb, '-s', serial, 'reverse', '--remove', `tcp:${forwarded}`], {
        timeout: ASK_TIMEOUT_MS,
      })
      forwarded = undefined
    }
    fixture?.kill()
    if (emulator !== undefined) {
      // Asked to shut down first, so that the image is left as an emulator leaves it; killed
      // whether or not it listened.
      Bun.spawnSync([adb, '-s', `emulator-${EMULATOR_PORT}`, 'emu', 'kill'], {
        timeout: ASK_TIMEOUT_MS,
      })
      emulator.kill()
      emulator = undefined
    }
  }
  // 128 + the signal's number, as a shell reports a process a signal ended.
  const SIGNAL_EXITS = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const
  for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      stop()
      process.exit(SIGNAL_EXITS[signal])
    })
  }

  /** Whether the device says Android has started. */
  const booted = (device: string): boolean => {
    const asked = Bun.spawnSync([adb, '-s', device, 'shell', 'getprop', 'sys.boot_completed'], {
      timeout: ASK_TIMEOUT_MS,
    })
    return asked.exitCode === 0 && asked.stdout.toString().trim() === '1'
  }

  let code = 1
  try {
    if (avd !== undefined) {
      emulator = Bun.spawn(
        [
          join(sdk, 'emulator/emulator'),
          '-avd',
          avd,
          '-port',
          String(EMULATOR_PORT),
          '-no-window',
          '-no-audio',
          '-no-boot-anim',
          // What the tests do to the device is not kept in the image.
          '-no-snapshot-save',
        ],
        { stdout: 'ignore', stderr: 'inherit', timeout: EMULATOR_TIMEOUT_MS }
      )
      const deadline = Date.now() + BOOT_TIMEOUT_MS
      while (!booted(`emulator-${EMULATOR_PORT}`) && Date.now() < deadline) {
        await Bun.sleep(2_000)
      }
    }
    const listed = Bun.spawnSync([adb, 'devices'], { timeout: ASK_TIMEOUT_MS })
    const picked = pickDevice(
      listed.exitCode === 0 ? listed.stdout.toString() : '',
      avd !== undefined ? `emulator-${EMULATOR_PORT}` : option('--device'),
      own.includes('--allow-physical')
    )
    if ('problem' in picked) {
      process.stderr.write(`${picked.problem}\n`)
    } else if (!booted(picked.serial)) {
      process.stderr.write('the device has not started Android\n')
    } else {
      serial = picked.serial
      process.stdout.write(`device: ${serial}\n`)

      fixture = Bun.spawn(['bun', 'run', 'e2e/kotlin-fixture.ts'], {
        cwd: root,
        env: { ...process.env, KOTLIN_FIXTURE: '1', LOG_LEVEL: 'silent' },
        stdout: 'pipe',
        stderr: 'inherit',
        // Longer than the tests may take: the fixture is ended below, and this ends it when
        // this process is no longer there to do it in time.
        timeout: FIXTURE_TIMEOUT_MS,
      })
      const listening = await fixtureOrigin(
        fixture.stdout as ReadableStream<Uint8Array>,
        READY_TIMEOUT_MS
      )
      if (listening === null) {
        process.stderr.write('the fixture did not start\n')
      } else {
        process.stdout.write(`fixture: ${listening.origin}\n`)
        // The device's own 127.0.0.1:<port> is this machine's: nothing is bound wider.
        const reversed = Bun.spawnSync(
          [adb, '-s', serial, 'reverse', `tcp:${listening.port}`, `tcp:${listening.port}`],
          { timeout: ASK_TIMEOUT_MS }
        )
        if (reversed.exitCode !== 0) {
          process.stderr.write('the fixture’s port could not be forwarded into the device\n')
        } else {
          forwarded = listening.port
          if (captures.directory !== null) {
            prepareDevice(adb, serial)
          }
          tests = Bun.spawn(gradleArguments(listening.origin, rest, captures.directory !== null), {
            cwd: join(root, 'native/android'),
            env: { ...process.env, ANDROID_HOME: sdk, ANDROID_SERIAL: serial },
            stdout: 'inherit',
            stderr: 'inherit',
            timeout: TEST_TIMEOUT_MS,
          })
          code = await tests.exited
          if (code === 0 && rawCaptures !== null && captures.directory !== null) {
            if (!pullCaptures(adb, serial, rawCaptures)) {
              process.stderr.write('the pictures could not be copied from the device\n')
              code = 1
            } else {
              const outDirectory = resolve(root, captures.directory)
              const made = finishCaptures({
                platform: 'android',
                rawDirectory: rawCaptures,
                outDirectory,
                root,
                ...deviceFacts(adb, serial),
              })
              process.stdout.write(`captures: ${made.captures.length} in ${outDirectory}\n`)
            }
          }
        }
      }
    }
  } finally {
    stop()
  }
  process.exit(code)
}
