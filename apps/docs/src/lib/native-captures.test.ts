import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeEnvironment } from '../testing/environment'
import { createCodeHighlighter, type Highlighter, parseMarkdown, renderMarkdown } from './markdown'
import {
  altText,
  galleryElement,
  groupScreens,
  ManifestError,
  type NativeManifest,
  parseManifest,
  provenance,
} from './native-captures'
import { nativeCapturesOf } from './site'

const SHA = 'a'.repeat(64)

function capture(
  screen: string,
  step: string,
  theme: 'light' | 'dark',
  labels = ['Sign in', 'Address']
) {
  return {
    file: `${screen}.${step}.${theme}.webp`,
    screen,
    step,
    theme,
    screenLabel: labels[0],
    stepLabel: labels[1],
    width: 560,
    height: 1215,
    bytes: 12_000,
    sha256: SHA,
  }
}

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    platform: 'ios',
    commit: 'b'.repeat(40),
    dirty: false,
    capturedAt: '2026-10-22T20:00:00.000Z',
    device: { name: 'iPhone 16', os: 'iOS 18.5' },
    tools: { xcode: '16.4' },
    captures: [
      capture('sign-in', 'email', 'light'),
      capture('sign-in', 'email', 'dark'),
      capture('sign-in', 'password', 'light', ['Sign in', 'Password']),
      capture('sign-in', 'password', 'dark', ['Sign in', 'Password']),
      capture('account', 'overview', 'light', ['Account', 'Overview']),
      capture('account', 'overview', 'dark', ['Account', 'Overview']),
    ],
    ...overrides,
  }
}

function parsed(overrides: Record<string, unknown> = {}): NativeManifest {
  return parseManifest('m.json', JSON.stringify(manifest(overrides)), 'ios')
}

describe('parseManifest', () => {
  test('reads what the runners write', () => {
    const read = parsed()
    expect(read.captures).toHaveLength(6)
    expect(read.device).toEqual({ name: 'iPhone 16', os: 'iOS 18.5' })
  })

  test.each([
    ['not JSON', 'nope', /is not JSON/],
    ['another version', JSON.stringify(manifest({ version: 2 })), /version 1/],
    ['another platform', JSON.stringify(manifest({ platform: 'android' })), /not "ios"/],
    ['no dirty flag', JSON.stringify(manifest({ dirty: 'no' })), /dirty/],
    ['a short commit', JSON.stringify(manifest({ commit: 'abc' })), /full commit/],
    ['an invalid date', JSON.stringify(manifest({ capturedAt: 'later' })), /not a date/],
    ['no capture', JSON.stringify(manifest({ captures: [] })), /no capture/],
    [
      'markup in the device',
      JSON.stringify(manifest({ device: { name: '<b>x</b>', os: 'iOS' } })),
      /short line/,
    ],
    [
      'markup in a tool',
      JSON.stringify(manifest({ tools: { xcode: '"><script>' } })),
      /short line/,
    ],
  ])('refuses %s', (_name, source, message) => {
    expect(() => parseManifest('m.json', source, 'ios')).toThrow(message)
  })

  test('refuses a capture that is not a plain name, does not match itself or is listed twice', () => {
    const base = capture('sign-in', 'email', 'light')
    for (const [bad, message] of [
      [{ ...base, file: '../x.webp' }, /not a <screen>/],
      [{ ...base, file: 'sign-in.email.light.png' }, /not a <screen>/],
      [{ ...base, step: 'password' }, /does not match/],
      [{ ...base, theme: 'dark' }, /does not match/],
      [{ ...base, sha256: 'xyz' }, /SHA-256/],
      [{ ...base, width: 0 }, /positive whole number/],
      [{ ...base, screenLabel: '<img>' }, /short line/],
    ] as const) {
      expect(() => parsed({ captures: [bad] })).toThrow(message)
    }
    expect(() => parsed({ captures: [base, base] })).toThrow(/twice/)
    expect(() => parsed({ captures: [base, base] })).toThrow(ManifestError)
  })
})

describe('the gallery model', () => {
  test('groups the captures by screen and step, in the manifest order, a picture per scheme', () => {
    const screens = groupScreens(parsed())
    expect(screens.map((screen) => screen.screen)).toEqual(['sign-in', 'account'])
    expect(screens[0]?.steps.map((step) => step.step)).toEqual(['email', 'password'])
    expect(Object.keys(screens[0]?.steps[0]?.pictures ?? {})).toEqual(['light', 'dark'])
  })

  test('alternative text names the platform, the screen, the step and the theme', () => {
    const first = parsed().captures[0] as NativeManifest['captures'][number]
    expect(altText('ios', first)).toBe('SwiftUI Sign in screen, Address step, light theme')
    expect(altText('android', { ...first, theme: 'dark' })).toBe(
      'Compose Sign in screen, Address step, dark theme'
    )
  })

  test('says what made the pictures: device, tools, commit and date, and when the tree had changes', () => {
    expect(provenance(parsed())).toBe(
      'iPhone 16, iOS 18.5, Xcode 16.4. Commit bbbbbbb, 22 Oct 2026.'
    )
    expect(provenance(parsed({ dirty: true }))).toContain('(with changes)')
  })
})

describe('the gallery of a page', () => {
  let highlighter: Highlighter
  beforeAll(async () => {
    highlighter = await createCodeHighlighter()
  })

  const environment = fakeEnvironment({}, [], {}, '/base/')

  function render(source: string, captures = (): NativeManifest | null => parsed()) {
    return renderMarkdown(parseMarkdown('docs/a.md', source), environment, highlighter, captures)
      .html
  }

  const PAGE =
    '# T\n\n:::native-screens{platform="ios"}\n\nThe caption, with [a link](#t).\n\n:::\n'

  test('lists every picture with its alternative text, size and lazy loading, with no script', () => {
    const html = render(PAGE)
    const images = [...html.matchAll(/<img [^>]*>/g)].map((match) => match[0])
    expect(images).toHaveLength(6)
    for (const image of images) {
      expect(image).toContain('loading="lazy"')
      expect(image).toContain('width="560"')
      expect(image).toContain('height="1215"')
      expect(image).toMatch(/alt="SwiftUI [A-Za-z ]+ screen, [A-Za-z ]+ step, (light|dark) theme"/)
      expect(image).toContain('src="/base/native/ios/')
    }
    expect(html).toContain('alt="SwiftUI Sign in screen, Address step, light theme"')
    expect(html).toContain('alt="SwiftUI Account screen, Overview step, dark theme"')
    expect(html).toContain('The caption, with <a href="#t">a link</a>.')
  })

  test('the toolbar is hidden until the script shows it, and ties each tab to its panel', () => {
    const html = render(PAGE)
    expect(html).toMatch(/class="ns-toolbar" hidden/)
    expect(html).toContain('role="tablist"')
    expect(html).toContain('aria-selected="true"')
    for (const screen of ['sign-in', 'account']) {
      expect(html).toContain(`aria-controls="ns-ios-1-panel-${screen}"`)
      expect(html).toContain(`id="ns-ios-1-panel-${screen}"`)
      expect(html).toContain(`aria-labelledby="ns-ios-1-tab-${screen}"`)
    }
    // A heading would skip a level on a page: the gallery writes none.
    expect(html).not.toMatch(/<h[2-6][ >]/)
  })

  test('two galleries of one page have ids of their own', () => {
    const html = render(`${PAGE}\n${PAGE.replace('# T\n\n', '')}`)
    expect(html).toContain('id="ns-ios-1-panel-sign-in"')
    expect(html).toContain('id="ns-ios-2-panel-sign-in"')
  })

  test('says plainly that a platform with no manifest was not captured, with the command, and shows no picture', () => {
    const html = render(PAGE, () => null)
    expect(html).toContain('Not captured yet')
    expect(html).toContain(
      'bun run native/swift/fixture/ui-tests.ts --screenshots apps/docs/public/native/ios'
    )
    expect(html).not.toContain('<img')
    expect(html).not.toContain('ns-toolbar')
  })

  test('an android gallery names Compose and its directory', () => {
    const html = render(PAGE.replace('ios', 'android'), () => null)
    expect(html).toContain('Compose')
    expect(html).toContain('--screenshots apps/docs/public/native/android')
  })

  test('a block with no platform, or another one, is refused with its line', () => {
    for (const fence of [':::native-screens', ':::native-screens{platform="windows"}']) {
      expect(() => render(`# T\n\n${fence}\n\n:::\n`)).toThrow(
        /line 3: :::native-screens needs platform=/
      )
    }
  })

  test('the markup is the gallery only: nothing of the manifest is written but its checked values', () => {
    const element = galleryElement('ios', parsed(), '/', [], 1)
    expect(JSON.stringify(element)).not.toContain('sha256')
  })
})

describe('the manifests of a repository', () => {
  const root = mkdtempSync(join(tmpdir(), 'docs-captures-'))

  test('a platform with no manifest is not captured, and one that is there is read once', () => {
    const directory = join(root, 'apps/docs/public/native/ios')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest()))
    const read = nativeCapturesOf(root)
    expect(read('android')).toBeNull()
    expect(read('ios')?.captures).toHaveLength(6)
    expect(read('ios')).toBe(read('ios'))
  })

  test('a manifest that is wrong stops the build rather than showing less', () => {
    const wrong = mkdtempSync(join(tmpdir(), 'docs-captures-'))
    const directory = join(wrong, 'apps/docs/public/native/android')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest()))
    expect(() => nativeCapturesOf(wrong)('android')).toThrow(/not "android"|is for "ios"/)
  })
})
