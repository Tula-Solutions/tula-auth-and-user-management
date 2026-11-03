import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// What the two UI-test runners (native/swift/fixture/ui-tests.ts, native/android/fixture/ui-tests.ts)
// share when they are asked for `--screenshots <dir>`: the flag, the names of the pictures, the
// step that turns the screens' raw screenshots into the files the documentation serves, and the
// manifest that says what made them.
//
// The pictures are the platform's own screenshots of the real screens, taken by the example
// app's UI tests against the real API. Nothing here draws, edits, composes or invents one: the
// only changes are a smaller width and WebP, so that a page stays light. The documentation site
// reads the manifest (apps/docs/src/lib/native-captures.ts) and shows exactly what it lists.
//
// By hand only, like the runners: no workflow runs a simulator or an emulator.

/** The platforms that have captures. */
export const CAPTURE_PLATFORMS = ['ios', 'android'] as const

/** One of {@link CAPTURE_PLATFORMS}. */
export type CapturePlatform = (typeof CAPTURE_PLATFORMS)[number]

/** The colour schemes every screen is captured in. */
export const CAPTURE_THEMES = ['light', 'dark'] as const

/** One of {@link CAPTURE_THEMES}. */
export type CaptureTheme = (typeof CAPTURE_THEMES)[number]

/**
 * The screens and steps the UI tests photograph, in the order the documentation lists them.
 * A name here is the first two parts of a picture's file name, so the tests of both platforms
 * and the documentation agree on one vocabulary.
 */
export const CAPTURE_SCREENS = [
  { screen: 'sign-in', step: 'email', label: 'Sign in', stepLabel: 'Address' },
  { screen: 'sign-in', step: 'password', label: 'Sign in', stepLabel: 'Password' },
  { screen: 'sign-up', step: 'create', label: 'Sign up', stepLabel: 'Create account' },
  { screen: 'sign-up', step: 'verify', label: 'Sign up', stepLabel: 'Check your email' },
  { screen: 'reset', step: 'request', label: 'Reset password', stepLabel: 'Request' },
  { screen: 'reset', step: 'new-password', label: 'Reset password', stepLabel: 'New password' },
  { screen: 'second-step', step: 'setup', label: 'Second step', stepLabel: 'Set up' },
  {
    screen: 'second-step',
    step: 'authenticator',
    label: 'Second step',
    stepLabel: 'Authenticator',
  },
  { screen: 'second-step', step: 'backup-codes', label: 'Second step', stepLabel: 'Backup codes' },
  { screen: 'second-step', step: 'verify', label: 'Second step', stepLabel: 'Verify' },
  { screen: 'account', step: 'overview', label: 'Account', stepLabel: 'Overview' },
] as const

/** The most a served picture may weigh, in bytes. A manifest with a bigger one is not written. */
export const MAX_CAPTURE_BYTES = 80_000

/** The width, in pixels, a served picture is scaled to: twice the width it is drawn at. */
export const CAPTURE_WIDTH = 560

/** How long a tool that only answers a question, or converts one picture, may take. */
const ASK_TIMEOUT_MS = 60_000
/** How long a device may take to start. */
const BOOT_TIMEOUT_MS = 6 * 60_000

/** The `--screenshots` flag as parsed. */
export interface CaptureArgs {
  /** The directory the served pictures and the manifest go to, or `null` without the flag. */
  directory: string | null
  /** A sentence when the flag was given wrongly. */
  problem?: string
}

/**
 * Read `--screenshots <dir>` from a runner's own arguments (the ones before `--`).
 *
 * @param args - The runner's arguments.
 * @returns The directory, `null` when the flag is absent, or a problem when it has no value
 *   (it is last, or the next argument is another flag) or is given twice.
 */
export function parseCaptureArgs(args: readonly string[]): CaptureArgs {
  const at = args.indexOf('--screenshots')
  if (at < 0) {
    return { directory: null }
  }
  const value = args[at + 1]
  if (value === undefined || value === '' || value.startsWith('-')) {
    return { directory: null, problem: '--screenshots needs a directory: --screenshots <dir>' }
  }
  if (args.indexOf('--screenshots', at + 1) >= 0) {
    return { directory: null, problem: '--screenshots was given twice' }
  }
  return { directory: value }
}

/** What a picture's file name says. */
export interface CaptureName {
  screen: string
  step: string
  theme: CaptureTheme
}

/**
 * The raw file name of a picture the UI tests wrote: `<screen>.<step>.<theme>.png`.
 *
 * @param name - What the screen is, which step of it, and the colour scheme.
 * @returns The file name.
 */
export function captureFileName(name: CaptureName): string {
  return `${name.screen}.${name.step}.${name.theme}.png`
}

/**
 * Read the name of a picture the UI tests wrote.
 *
 * Only a screen and step of {@link CAPTURE_SCREENS} and a theme of {@link CAPTURE_THEMES}
 * are names: a stray file in the directory is never listed in the manifest.
 *
 * @param file - A file name.
 * @returns What it says, or `null` when it is not the name of a picture.
 */
export function parseCaptureFileName(file: string): CaptureName | null {
  const match = /^([a-z-]+)\.([a-z-]+)\.(light|dark)\.png$/.exec(file)
  if (!match) {
    return null
  }
  const [, screen, step, theme] = match as unknown as [string, string, string, CaptureTheme]
  return CAPTURE_SCREENS.some((known) => known.screen === screen && known.step === step)
    ? { screen, step, theme }
    : null
}

/** One picture of the manifest. */
export interface ManifestCapture {
  /** The served file, next to the manifest. */
  file: string
  screen: string
  step: string
  theme: CaptureTheme
  /** What the documentation calls the screen: `Sign in`. */
  screenLabel: string
  /** What it calls the step: `Address`. */
  stepLabel: string
  width: number
  height: number
  bytes: number
  /** SHA-256 of the served file, in hexadecimal. */
  sha256: string
}

/** The manifest written beside the pictures. */
export interface CaptureManifest {
  version: 1
  platform: CapturePlatform
  /** The commit the tests ran at. */
  commit: string
  /** Whether the checkout had changes outside the captures' own directory. */
  dirty: boolean
  /** When the capture ran, ISO 8601 in UTC. */
  capturedAt: string
  /** The device the screenshots came from. */
  device: { name: string; os: string }
  /** The versions of the tools: `{ xcode: '16.4' }`, `{ androidApi: '36' }`. */
  tools: Record<string, string>
  captures: ManifestCapture[]
}

/** What {@link buildManifest} is given. */
export interface ManifestInput {
  platform: CapturePlatform
  commit: string
  dirty: boolean
  now: Date
  device: { name: string; os: string }
  tools: Record<string, string>
  /** The served files, read: name, size, hash and dimensions. */
  files: Array<{ file: string; width: number; height: number; bytes: number; sha256: string }>
}

/**
 * Build the manifest of a capture run.
 *
 * Every file is named for a screen, a step and a theme the vocabulary knows (its served name is
 * the raw name with `.webp`), is listed once and weighs at most {@link MAX_CAPTURE_BYTES}; the
 * list is in the vocabulary's order, light before dark.
 *
 * @param input - The run.
 * @returns The manifest.
 * @throws Error naming the file, when one is not a picture of the vocabulary, is listed twice
 *   or is over the budget, and when there is none.
 */
export function buildManifest(input: ManifestInput): CaptureManifest {
  const seen = new Set<string>()
  const captures: ManifestCapture[] = []
  for (const file of input.files) {
    const name = parseCaptureFileName(file.file.replace(/\.webp$/, '.png'))
    if (!file.file.endsWith('.webp') || name === null) {
      throw new Error(`not a capture of the vocabulary: ${file.file}`)
    }
    if (seen.has(file.file)) {
      throw new Error(`listed twice: ${file.file}`)
    }
    if (file.bytes > MAX_CAPTURE_BYTES) {
      throw new Error(
        `${file.file} is ${file.bytes} bytes, over the budget of ${MAX_CAPTURE_BYTES}`
      )
    }
    seen.add(file.file)
    const known = CAPTURE_SCREENS.find(
      (one) => one.screen === name.screen && one.step === name.step
    )
    captures.push({
      ...file,
      ...name,
      screenLabel: known?.label ?? name.screen,
      stepLabel: known?.stepLabel ?? name.step,
    })
  }
  if (captures.length === 0) {
    throw new Error('no capture to list')
  }
  const order = (capture: ManifestCapture): number =>
    CAPTURE_SCREENS.findIndex((s) => s.screen === capture.screen && s.step === capture.step) * 2 +
    CAPTURE_THEMES.indexOf(capture.theme)
  captures.sort((a, b) => order(a) - order(b))
  return {
    version: 1,
    platform: input.platform,
    commit: input.commit,
    dirty: input.dirty,
    capturedAt: input.now.toISOString(),
    device: input.device,
    tools: input.tools,
    captures,
  }
}

/**
 * Read a PNG's size from its header.
 *
 * @param bytes - The file.
 * @returns Width and height in pixels, or `null` when it is not a PNG.
 */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 24 || signature.some((byte, index) => bytes[index] !== byte)) {
    return null
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/** Run a short tool and return its output, or `null` when it failed or did not answer in time. */
function ask(command: string[], timeout = ASK_TIMEOUT_MS): string | null {
  const done = Bun.spawnSync(command, { timeout })
  return done.exitCode === 0 ? done.stdout.toString().trim() : null
}

/**
 * The commit the checkout is at and whether it has changes outside `ignoring`.
 *
 * @param root - The repository's root.
 * @param ignoring - A path (relative to the root) whose changes do not count: the captures'.
 * @returns The commit, or `unknown`, and the flag.
 */
export function checkout(root: string, ignoring: string): { commit: string; dirty: boolean } {
  const commit = ask(['git', '-C', root, 'rev-parse', 'HEAD']) ?? 'unknown'
  const changed =
    ask(['git', '-C', root, 'status', '--porcelain', '--', '.', `:(exclude)${ignoring}`]) ?? ''
  return { commit, dirty: changed !== '' }
}

/**
 * Turn the raw screenshots a run wrote into the served files and the manifest.
 *
 * Each picture named by the vocabulary is scaled to {@link CAPTURE_WIDTH} and written as WebP
 * with `cwebp` (`brew install webp`); a file of another name is ignored. The directory is
 * emptied of earlier captures first, so that the manifest lists what is there and no more.
 *
 * @param options - The platform, the raw directory, the output directory and what made them.
 * @returns The manifest, also written to `manifest.json` in the output directory.
 * @throws Error when `cwebp` is missing or fails, when there is nothing to convert, or when a
 *   picture is over the budget.
 */
export function finishCaptures(options: {
  platform: CapturePlatform
  rawDirectory: string
  outDirectory: string
  root: string
  device: { name: string; os: string }
  tools: Record<string, string>
}): CaptureManifest {
  if (ask(['cwebp', '-version']) === null) {
    throw new Error('cwebp is needed to write the pictures: brew install webp')
  }
  mkdirSync(options.outDirectory, { recursive: true })
  for (const old of readdirSync(options.outDirectory)) {
    if (old.endsWith('.webp') || old === 'manifest.json') {
      rmSync(join(options.outDirectory, old))
    }
  }
  const files: ManifestInput['files'] = []
  for (const raw of readdirSync(options.rawDirectory).sort()) {
    if (parseCaptureFileName(raw) === null) {
      continue
    }
    const png = readFileSync(join(options.rawDirectory, raw))
    const size = pngSize(png)
    if (size === null) {
      throw new Error(`${raw} is not a PNG`)
    }
    const file = raw.replace(/\.png$/, '.webp')
    const target = join(options.outDirectory, file)
    const height = Math.round((size.height * CAPTURE_WIDTH) / size.width)
    // Lossy at a high quality: a screen is flat colour and text, which WebP keeps sharp.
    const converted = Bun.spawnSync(
      [
        'cwebp',
        '-quiet',
        '-q',
        '86',
        '-m',
        '6',
        '-resize',
        String(CAPTURE_WIDTH),
        String(height),
        join(options.rawDirectory, raw),
        '-o',
        target,
      ],
      { timeout: ASK_TIMEOUT_MS }
    )
    if (converted.exitCode !== 0) {
      throw new Error(`cwebp failed for ${raw}`)
    }
    const webp = readFileSync(target)
    files.push({
      file,
      width: CAPTURE_WIDTH,
      height,
      bytes: webp.length,
      sha256: createHash('sha256').update(webp).digest('hex'),
    })
  }
  const state = checkout(options.root, 'apps/docs/public/native')
  const manifest = buildManifest({
    platform: options.platform,
    ...state,
    now: new Date(),
    device: options.device,
    tools: options.tools,
    files,
  })
  writeFileSync(
    join(options.outDirectory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  )
  return manifest
}

/** A fresh directory for the raw screenshots, which {@link removeRaw} deletes. */
export function rawDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'tula-captures-'))
}

/** Delete a directory made by {@link rawDirectory}. */
export function removeRaw(directory: string): void {
  rmSync(directory, { recursive: true, force: true })
}

/**
 * Put the status bar of a booted iOS simulator in the state a store screenshot has: 9:41, full
 * battery and bars, so that a capture shows no time of day.
 *
 * @param udid - The simulator.
 * @returns Whether the simulator booted and took the override.
 */
export function prepareSimulator(udid: string): boolean {
  const booted = Bun.spawnSync(['xcrun', 'simctl', 'bootstatus', udid, '-b'], {
    timeout: BOOT_TIMEOUT_MS,
  })
  if (booted.exitCode !== 0) {
    return false
  }
  const overridden = Bun.spawnSync(
    [
      'xcrun',
      'simctl',
      'status_bar',
      udid,
      'override',
      '--time',
      '9:41',
      '--batteryState',
      'charged',
      '--batteryLevel',
      '100',
      '--cellularMode',
      'active',
      '--cellularBars',
      '4',
      '--wifiBars',
      '3',
    ],
    { timeout: ASK_TIMEOUT_MS }
  )
  return overridden.exitCode === 0
}

/** Take the status bar override off the simulator and put it light again. */
export function restoreSimulator(udid: string): void {
  Bun.spawnSync(['xcrun', 'simctl', 'status_bar', udid, 'clear'], { timeout: ASK_TIMEOUT_MS })
  Bun.spawnSync(['xcrun', 'simctl', 'ui', udid, 'appearance', 'light'], { timeout: ASK_TIMEOUT_MS })
}

/**
 * What tools and device produced an iOS run.
 *
 * @param udid - The simulator.
 * @returns The device's name and iOS version, and Xcode's version.
 */
export function simulatorFacts(udid: string): {
  device: { name: string; os: string }
  tools: Record<string, string>
} {
  const listing = ask(['xcrun', 'simctl', 'list', 'devices', '-j'])
  let name = 'iOS simulator'
  let os = 'unknown'
  if (listing !== null) {
    const devices = (
      JSON.parse(listing) as { devices: Record<string, Array<{ udid: string; name: string }>> }
    ).devices
    for (const runtime of Object.keys(devices)) {
      const found = devices[runtime]?.find((device) => device.udid === udid)
      const match = /SimRuntime\.iOS-(\d+(?:-\d+)*)$/.exec(runtime)
      if (found && match) {
        name = found.name
        os = `iOS ${(match[1] as string).replaceAll('-', '.')}`
      }
    }
  }
  const xcode = /Xcode (\S+)/.exec(ask(['xcodebuild', '-version']) ?? '')?.[1] ?? 'unknown'
  return { device: { name, os }, tools: { xcode } }
}

/** Where on the device the Android UI tests write their screenshots. */
export const ANDROID_CAPTURE_DIRECTORY = '/data/local/tmp/tula-captures'

/**
 * Clear the directory on the device that the tests write to. The status bar is left as the
 * device draws it: demo mode left it blank on the emulator it was tried on.
 *
 * @param adb - The `adb` executable.
 * @param serial - The device.
 */
export function prepareDevice(adb: string, serial: string): void {
  const shell = (...command: string[]): void => {
    Bun.spawnSync([adb, '-s', serial, 'shell', ...command], { timeout: ASK_TIMEOUT_MS })
  }
  shell('rm', '-rf', ANDROID_CAPTURE_DIRECTORY)
  shell('mkdir', '-p', ANDROID_CAPTURE_DIRECTORY)
}

/**
 * Undo {@link prepareDevice}: put the day scheme back, which the dark captures changed.
 *
 * @param adb - The `adb` executable.
 * @param serial - The device.
 */
export function restoreDevice(adb: string, serial: string): void {
  Bun.spawnSync([adb, '-s', serial, 'shell', 'cmd', 'uimode', 'night', 'no'], {
    timeout: ASK_TIMEOUT_MS,
  })
}

/**
 * Copy the screenshots the tests wrote on a device into a local directory, and remove them
 * from the device.
 *
 * @param adb - The `adb` executable.
 * @param serial - The device.
 * @param directory - The local directory.
 * @returns Whether the copy succeeded.
 */
export function pullCaptures(adb: string, serial: string, directory: string): boolean {
  const pulled = Bun.spawnSync(
    [adb, '-s', serial, 'pull', `${ANDROID_CAPTURE_DIRECTORY}/.`, directory],
    { timeout: ASK_TIMEOUT_MS }
  )
  Bun.spawnSync([adb, '-s', serial, 'shell', 'rm', '-rf', ANDROID_CAPTURE_DIRECTORY], {
    timeout: ASK_TIMEOUT_MS,
  })
  return pulled.exitCode === 0
}

/**
 * What device and tools produced an Android run.
 *
 * @param adb - The `adb` executable.
 * @param serial - The device.
 * @returns The device's model and Android version, and its API level.
 */
export function deviceFacts(
  adb: string,
  serial: string
): { device: { name: string; os: string }; tools: Record<string, string> } {
  const property = (name: string): string =>
    ask([adb, '-s', serial, 'shell', 'getprop', name]) ?? 'unknown'
  return {
    device: {
      name: property('ro.product.model'),
      os: `Android ${property('ro.build.version.release')}`,
    },
    tools: { androidApi: property('ro.build.version.sdk') },
  }
}
