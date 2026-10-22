import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import darkTheme from 'shiki/themes/github-dark-high-contrast.mjs'
import lightTheme from 'shiki/themes/github-light-high-contrast.mjs'
import { contrastRatio, luminance } from './contrast'
import { COLOR_PAIRS, COLORS, type ColorScheme } from './design-tokens'
import { CODE_COLOR_REPLACEMENTS, CODE_THEMES } from './markdown'
import { tokensCss } from './tokens'

// The site's stylesheet, the theme mapping it shares with the playground's, and the
// playground's own: none of the three may write a colour of its own.
const STYLESHEET = ['../styles.css', '../styles/shadcn-theme.css', '../playground/playground.css']
  .map((file) => readFileSync(join(import.meta.dir, file), 'utf8'))
  .join('\n')

describe('contrastRatio', () => {
  test('black on white is 21 and a colour on itself is 1', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5)
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5)
    expect(contrastRatio('#8A877E', '#8A877E')).toBe(1)
  })

  test('matches the values the design report measured', () => {
    expect(contrastRatio(COLORS.light.ink, COLORS.light.bg)).toBeCloseTo(16.54, 1)
    expect(contrastRatio(COLORS.light.faint, COLORS.light.surface)).toBeCloseTo(4.56, 1)
    expect(contrastRatio(COLORS.dark.accent, COLORS.dark.bg)).toBeCloseTo(7.81, 1)
  })

  test('refuses what is not a six-digit hex colour', () => {
    expect(() => luminance('#fff')).toThrow('#RRGGBB')
    expect(() => luminance('red')).toThrow('#RRGGBB')
  })
})

describe('the site’s colours', () => {
  for (const scheme of ['light', 'dark'] as const) {
    for (const pair of COLOR_PAIRS) {
      test(`${scheme}: ${pair.fg} on ${pair.bg} reaches ${pair.min}:1 (${pair.use})`, () => {
        const ratio = contrastRatio(COLORS[scheme][pair.fg], COLORS[scheme][pair.bg])
        expect(ratio).toBeGreaterThanOrEqual(pair.min)
      })
    }
  }

  test('both schemes define the same roles, each a #RRGGBB colour', () => {
    expect(Object.keys(COLORS.dark).sort()).toEqual(Object.keys(COLORS.light).sort())
    for (const scheme of [COLORS.light, COLORS.dark]) {
      for (const value of Object.values(scheme)) {
        expect(value).toMatch(/^#[0-9A-F]{6}$/)
      }
    }
  })

  test('a pair names roles that exist', () => {
    const roles = new Set(Object.keys(COLORS.light))
    for (const pair of COLOR_PAIRS) {
      expect(roles.has(pair.fg), pair.fg).toBe(true)
      expect(roles.has(pair.bg), pair.bg).toBe(true)
    }
  })

  test('every text role is measured on the page it is drawn on', () => {
    // A role used for text must appear as a foreground at least once, or it was never checked.
    const foregrounds = new Set(COLOR_PAIRS.map((pair) => pair.fg))
    for (const role of ['ink', 'body', 'muted', 'faint', 'accent', 'ok', 'warn', 'danger']) {
      expect(foregrounds.has(role as keyof ColorScheme), role).toBe(true)
    }
  })

  test('the stylesheet writes no colour of its own: every one is a token', () => {
    const withoutComments = STYLESHEET.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(withoutComments).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(withoutComments).not.toMatch(/\b(?:rgba?|hsla?|oklch|lab|lch)\(/)
  })

  test('every custom property the stylesheet reads from the tokens is written by them', () => {
    const written = tokensCss()
    const read = new Set(
      [...STYLESHEET.matchAll(/var\(--([a-z0-9-]+)/g)].map((match) => match[1] as string)
    )
    // Properties the stylesheet defines itself (fonts, the header height), Tailwind's, and shiki's own (written inline on each code block).
    const own = new Set(
      [...STYLESHEET.matchAll(/^\s*--([a-z0-9-]+):/gm)].map((match) => match[1] as string)
    )
    for (const name of read) {
      if (
        own.has(name) ||
        name.startsWith('tw-') ||
        name.startsWith('color-') ||
        name.startsWith('shiki-')
      ) {
        continue
      }
      expect(written, `--${name} is read but not written`).toContain(`--${name}:`)
    }
  })
})

describe('the colours of highlighted code', () => {
  // Every foreground colour a theme gives a token is drawn on the site's code background.
  for (const [scheme, theme, name] of [
    ['light', lightTheme, CODE_THEMES.light],
    ['dark', darkTheme, CODE_THEMES.dark],
  ] as const) {
    test(`${scheme}: every token colour of ${name} reaches 4.5:1 on the code background and its line tints`, () => {
      const replacements = CODE_COLOR_REPLACEMENTS[name] ?? {}
      const colors = new Set<string>([(theme.colors ?? {})['editor.foreground'] as string])
      for (const rule of theme.tokenColors ?? []) {
        const settings = rule.settings as { foreground?: string; background?: string } | undefined
        // A rule with its own background (a stray carriage return) is not text on the code block.
        if (settings?.foreground !== undefined && settings.background === undefined) {
          colors.add(settings.foreground)
        }
      }
      for (const color of colors) {
        const used = (replacements[color.toLowerCase()] ?? color).toUpperCase()
        // A pure white in a theme is a background the site does not draw.
        if (used === '#FFFFFF') {
          continue
        }
        // The code background, and the tints a highlighted line and an added or removed one take.
        for (const background of ['surface', 'accentSoft', 'addBg', 'removeBg'] as const) {
          expect(
            contrastRatio(used, COLORS[scheme][background]),
            `${color} as ${used} on ${background}`
          ).toBeGreaterThanOrEqual(4.5)
        }
      }
    })
  }
})
