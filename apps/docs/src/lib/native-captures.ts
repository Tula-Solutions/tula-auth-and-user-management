import type { Element, ElementContent } from 'hast'

// The gallery of `:::native-screens{platform="ios"}` (see `docs/writing-docs.md`): what the
// native SDKs' prebuilt screens look like, as captured from the real example apps by the UI-test
// runners' `--screenshots` mode (`native/fixture/captures.ts`) and listed in a manifest next to
// the pictures (`apps/docs/public/native/<platform>/manifest.json`).
//
// Nothing here draws a screen. A page shows exactly what the manifest lists; with no manifest the
// gallery says the platform has not been captured and gives the command to run.

/** The platforms that have captures. */
export const NATIVE_PLATFORMS = ['ios', 'android'] as const

/** One of {@link NATIVE_PLATFORMS}. */
export type NativePlatform = (typeof NATIVE_PLATFORMS)[number]

/** The colour schemes of a capture. */
export type NativeTheme = 'light' | 'dark'

/** How a platform is named on the page. */
export const PLATFORM_LABELS: Record<
  NativePlatform,
  { ui: string; device: string; command: string; directory: string }
> = {
  ios: {
    ui: 'SwiftUI',
    device: 'iPhone',
    command: 'bun run native/swift/fixture/ui-tests.ts --screenshots apps/docs/public/native/ios',
    directory: 'apps/docs/public/native/ios',
  },
  android: {
    ui: 'Compose',
    device: 'Android phone',
    command:
      'bun run native/android/fixture/ui-tests.ts --avd <name> --screenshots apps/docs/public/native/android',
    directory: 'apps/docs/public/native/android',
  },
}

/** One picture of a manifest. */
export interface NativeCapture {
  file: string
  screen: string
  step: string
  theme: NativeTheme
  screenLabel: string
  stepLabel: string
  width: number
  height: number
  bytes: number
  sha256: string
}

/** A manifest, as the runners write it. */
export interface NativeManifest {
  version: 1
  platform: NativePlatform
  commit: string
  dirty: boolean
  capturedAt: string
  device: { name: string; os: string }
  tools: Record<string, string>
  captures: NativeCapture[]
}

/** A manifest that cannot be shown: the build stops, and names the file and the reason. */
export class ManifestError extends Error {
  constructor(file: string, reason: string) {
    super(`${file}: ${reason}`)
    this.name = 'ManifestError'
  }
}

const FILE_NAME = /^[a-z][a-z-]*\.[a-z][a-z-]*\.(light|dark)\.webp$/
const SAFE_TEXT = /^[^<>"\p{Cc}]{1,120}$/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(file: string, what: string, value: unknown): string {
  if (typeof value !== 'string' || !SAFE_TEXT.test(value)) {
    throw new ManifestError(file, `${what} is not a short line of text`)
  }
  return value
}

function size(file: string, what: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100_000) {
    throw new ManifestError(file, `${what} is not a positive whole number`)
  }
  return value
}

/**
 * Read and check a capture manifest.
 *
 * The page writes what it reads into its HTML, so every text is a short line with no markup, a
 * file name is a plain `<screen>.<step>.<theme>.webp`, and the pictures of a platform are each
 * listed once. A manifest that fails any of that stops the build rather than showing less.
 *
 * @param file - The manifest's path, for messages.
 * @param source - Its text.
 * @param platform - The platform whose directory it is in; the manifest must say the same.
 * @returns The manifest.
 * @throws ManifestError for anything unexpected.
 */
export function parseManifest(
  file: string,
  source: string,
  platform: NativePlatform
): NativeManifest {
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch {
    throw new ManifestError(file, 'is not JSON')
  }
  if (!isRecord(raw) || raw.version !== 1) {
    throw new ManifestError(file, 'is not a version 1 capture manifest')
  }
  if (raw.platform !== platform) {
    throw new ManifestError(file, `is for "${String(raw.platform)}", not "${platform}"`)
  }
  if (typeof raw.dirty !== 'boolean') {
    throw new ManifestError(file, 'has no "dirty" flag')
  }
  const commit = text(file, 'commit', raw.commit)
  if (!/^([0-9a-f]{40}|unknown)$/.test(commit)) {
    throw new ManifestError(file, 'commit is not a full commit id')
  }
  const capturedAt = text(file, 'capturedAt', raw.capturedAt)
  if (Number.isNaN(Date.parse(capturedAt))) {
    throw new ManifestError(file, 'capturedAt is not a date')
  }
  const device = raw.device
  if (!isRecord(device)) {
    throw new ManifestError(file, 'has no device')
  }
  const tools: Record<string, string> = {}
  if (!isRecord(raw.tools)) {
    throw new ManifestError(file, 'has no tools')
  }
  for (const [name, version] of Object.entries(raw.tools)) {
    tools[text(file, 'a tool name', name)] = text(file, `the version of ${name}`, version)
  }
  if (!Array.isArray(raw.captures) || raw.captures.length === 0) {
    throw new ManifestError(file, 'lists no capture')
  }
  const seen = new Set<string>()
  const captures = raw.captures.map((one: unknown, index): NativeCapture => {
    if (!isRecord(one)) {
      throw new ManifestError(file, `capture ${index} is not an object`)
    }
    const name = text(file, `capture ${index}'s file`, one.file)
    if (!FILE_NAME.test(name)) {
      throw new ManifestError(file, `"${name}" is not a <screen>.<step>.<theme>.webp name`)
    }
    if (seen.has(name)) {
      throw new ManifestError(file, `lists "${name}" twice`)
    }
    seen.add(name)
    const [screen, step, theme] = name.replace(/\.webp$/, '').split('.') as [
      string,
      string,
      NativeTheme,
    ]
    if (one.screen !== screen || one.step !== step || one.theme !== theme) {
      throw new ManifestError(file, `"${name}" does not match its screen, step and theme`)
    }
    const sha256 = text(file, `${name}'s sha256`, one.sha256)
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new ManifestError(file, `${name}'s sha256 is not a SHA-256`)
    }
    return {
      file: name,
      screen,
      step,
      theme,
      screenLabel: text(file, `${name}'s screenLabel`, one.screenLabel),
      stepLabel: text(file, `${name}'s stepLabel`, one.stepLabel),
      width: size(file, `${name}'s width`, one.width),
      height: size(file, `${name}'s height`, one.height),
      bytes: size(file, `${name}'s bytes`, one.bytes),
      sha256,
    }
  })
  return {
    version: 1,
    platform,
    commit,
    dirty: raw.dirty,
    capturedAt,
    device: {
      name: text(file, 'device.name', device.name),
      os: text(file, 'device.os', device.os),
    },
    tools,
    captures,
  }
}

/** A step of a screen, with its picture in each scheme. */
export interface GalleryStep {
  step: string
  label: string
  pictures: Partial<Record<NativeTheme, NativeCapture>>
}

/** A screen of the gallery: its steps, in the order the manifest lists them. */
export interface GalleryScreen {
  screen: string
  label: string
  steps: GalleryStep[]
}

/**
 * Group a manifest's captures by screen and step, keeping the manifest's order.
 *
 * @param manifest - A checked manifest.
 * @returns The screens, each with its steps.
 */
export function groupScreens(manifest: NativeManifest): GalleryScreen[] {
  const screens: GalleryScreen[] = []
  for (const capture of manifest.captures) {
    let screen = screens.find((one) => one.screen === capture.screen)
    if (screen === undefined) {
      screen = { screen: capture.screen, label: capture.screenLabel, steps: [] }
      screens.push(screen)
    }
    let step = screen.steps.find((one) => one.step === capture.step)
    if (step === undefined) {
      step = { step: capture.step, label: capture.stepLabel, pictures: {} }
      screen.steps.push(step)
    }
    step.pictures[capture.theme] = capture
  }
  return screens
}

/**
 * The alternative text of a picture: the platform's screen, the step and the scheme, so that a
 * reader who cannot see it knows which one it is.
 *
 * @param platform - The platform.
 * @param capture - The picture.
 * @returns For example `SwiftUI Sign in screen, Address step, light theme`.
 */
export function altText(platform: NativePlatform, capture: NativeCapture): string {
  return `${PLATFORM_LABELS[platform].ui} ${capture.screenLabel} screen, ${capture.stepLabel} step, ${capture.theme} theme`
}

function h(
  tagName: string,
  properties: Element['properties'],
  children: ElementContent[] = []
): Element {
  return { type: 'element', tagName, properties, children }
}

function t(value: string): ElementContent {
  return { type: 'text', value }
}

/** The date of a capture as the page says it: `22 Oct 2026`, in UTC. */
export function capturedOn(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/** What a capture was made on, in a line a reader can check: device, tools, commit and date. */
export function provenance(manifest: NativeManifest): string {
  const tools = Object.entries(manifest.tools)
    .map(([name, version]) => `${TOOL_LABELS[name] ?? name} ${version}`)
    .join(', ')
  const commit = manifest.commit === 'unknown' ? 'unknown commit' : manifest.commit.slice(0, 7)
  return `${manifest.device.name}, ${manifest.device.os}${tools === '' ? '' : `, ${tools}`}. Commit ${commit}${manifest.dirty ? ' (with changes)' : ''}, ${capturedOn(manifest.capturedAt)}.`
}

const TOOL_LABELS: Record<string, string> = { xcode: 'Xcode', androidApi: 'Android API' }

/**
 * The gallery's markup.
 *
 * It is a complete page without a script: every step of every screen is listed, each with its
 * picture in both schemes (the one that does not match the page's scheme is hidden by CSS). The
 * toolbar, which is `hidden`, is what `src/client/native-screens.ts` shows and wires to choose a
 * screen, a step, the scheme and the device frame. Pictures are lazy, with their size written.
 *
 * @param platform - The platform.
 * @param manifest - Its manifest, or `null` when it has not been captured.
 * @param base - The site's base address (`/` or `/…/`), which the pictures' addresses start with.
 * @param caption - What the page wrote inside the block, shown above the gallery.
 * @param id - A number that makes this gallery's element ids unique on its page.
 * @returns The gallery's element.
 */
export function galleryElement(
  platform: NativePlatform,
  manifest: NativeManifest | null,
  base: string,
  caption: ElementContent[],
  id: number
): Element {
  const label = PLATFORM_LABELS[platform]
  const root = (children: ElementContent[]): Element =>
    h(
      'div',
      { className: ['native-screens'], dataNativeScreens: platform, dataNativeId: String(id) },
      children
    )
  const intro = caption.length === 0 ? [] : [h('div', { className: ['ns-caption'] }, caption)]
  if (manifest === null) {
    return root([
      ...intro,
      h('div', { className: ['ns-missing'], role: 'note' }, [
        h('p', { className: ['ns-missing-title'] }, [t('Not captured yet')]),
        h('p', {}, [
          t(
            `The ${label.ui} screens have not been captured on the machine that built this page, so none is shown here. To capture them, run this from the repository's root:`
          ),
        ]),
        h('pre', {}, [h('code', {}, [t(label.command)])]),
      ]),
    ])
  }
  const screens = groupScreens(manifest)
  const prefix = `ns-${platform}-${id}`
  const toolbar = h('div', { className: ['ns-toolbar'], hidden: true }, [
    h(
      'div',
      { className: ['ns-tabs'], role: 'tablist', ariaLabel: `${label.ui} screens` },
      screens.map((screen, index) =>
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            className: ['ns-tab'],
            id: `${prefix}-tab-${screen.screen}`,
            ariaControls: [`${prefix}-panel-${screen.screen}`],
            ariaSelected: index === 0 ? 'true' : 'false',
            tabIndex: index === 0 ? 0 : -1,
            dataScreen: screen.screen,
          },
          [t(screen.label)]
        )
      )
    ),
    h('div', { className: ['ns-options'] }, [
      h('div', { className: ['ns-switch'], role: 'group', ariaLabel: 'Theme' }, [
        h(
          'button',
          {
            type: 'button',
            className: ['ns-option'],
            dataThemeChoice: 'light',
            ariaPressed: 'false',
          },
          [t('Light')]
        ),
        h(
          'button',
          {
            type: 'button',
            className: ['ns-option'],
            dataThemeChoice: 'dark',
            ariaPressed: 'false',
          },
          [t('Dark')]
        ),
      ]),
      h(
        'button',
        {
          type: 'button',
          className: ['ns-option', 'ns-frame-toggle'],
          dataFrameToggle: '',
          ariaPressed: 'true',
        },
        [t('Device frame')]
      ),
    ]),
  ])
  const panels = screens.map((screen) =>
    h(
      'div',
      {
        className: ['ns-panel'],
        role: 'tabpanel',
        id: `${prefix}-panel-${screen.screen}`,
        ariaLabelledby: [`${prefix}-tab-${screen.screen}`],
        dataScreen: screen.screen,
      },
      [
        h(
          'div',
          {
            className: ['ns-steps'],
            role: 'group',
            ariaLabel: `${screen.label} step`,
            hidden: true,
          },
          screen.steps.map((step, at) =>
            h(
              'button',
              {
                type: 'button',
                className: ['ns-step'],
                dataStep: step.step,
                ariaPressed: at === 0 ? 'true' : 'false',
              },
              [t(step.label)]
            )
          )
        ),
        h(
          'ul',
          { className: ['ns-shots'] },
          screen.steps.map((step) => {
            const first = step.pictures.light ?? step.pictures.dark
            return h('li', { className: ['ns-shot'], dataStep: step.step }, [
              h('figure', { className: ['ns-device'] }, [
                h(
                  'div',
                  {
                    className: ['ns-screen'],
                    style:
                      first === undefined
                        ? undefined
                        : `aspect-ratio: ${first.width} / ${first.height}`,
                  },
                  (['light', 'dark'] as const).flatMap((theme) => {
                    const capture = step.pictures[theme]
                    return capture === undefined
                      ? []
                      : [
                          h('img', {
                            className: ['ns-img'],
                            dataTheme: theme,
                            src: `${base}native/${platform}/${capture.file}`,
                            alt: altText(platform, capture),
                            width: capture.width,
                            height: capture.height,
                            loading: 'lazy',
                            decoding: 'async',
                          }),
                        ]
                  })
                ),
                h('figcaption', { className: ['ns-label'] }, [t(`${screen.label}: ${step.label}`)]),
              ]),
            ])
          })
        ),
      ]
    )
  )
  return root([
    ...intro,
    toolbar,
    h('div', { className: ['ns-panels'] }, panels),
    h('p', { className: ['ns-provenance'] }, [
      t(`Captured from the ${label.ui} example app on ${provenance(manifest)} Refresh them with `),
      h('code', {}, [t(label.command)]),
      t('.'),
    ]),
  ])
}
