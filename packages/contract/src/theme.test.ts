import { describe, expect, test } from 'bun:test'
import {
  contrastRatio,
  DEFAULT_THEME,
  darkCssVariable,
  THEME_TOKENS,
  type ThemeScheme,
  themeToCssVariables,
} from './theme'

const SCHEMES = [
  ['light', DEFAULT_THEME.light],
  ['dark', DEFAULT_THEME.dark],
] as [string, ThemeScheme][]

describe('theme tokens', () => {
  test('every key of the default theme is described exactly once, with a unique CSS variable', () => {
    const schemeKeys = THEME_TOKENS.filter((token) => token.scope === 'scheme').map((t) => t.key)
    const sharedKeys = THEME_TOKENS.filter((token) => token.scope === 'shared').map((t) => t.key)
    expect(schemeKeys.sort()).toEqual(Object.keys(DEFAULT_THEME.light).sort())
    expect(Object.keys(DEFAULT_THEME.dark).sort()).toEqual(Object.keys(DEFAULT_THEME.light).sort())
    const { light: _light, dark: _dark, ...rest } = DEFAULT_THEME
    expect(sharedKeys.sort()).toEqual(Object.keys(rest).sort())
    const variables = THEME_TOKENS.map((token) => token.cssVariable)
    expect(new Set(variables).size).toBe(variables.length)
    for (const variable of variables) {
      expect(variable).toMatch(/^--tula-[a-z]+(-[a-z]+)*$/)
      // The dark namespace must not collide with a token's own name.
      expect(variable.startsWith('--tula-dark-')).toBe(false)
    }
  })

  test('the theme is plain JSON: it survives serialisation unchanged', () => {
    expect(JSON.parse(JSON.stringify(DEFAULT_THEME))).toEqual(DEFAULT_THEME)
    expect(JSON.parse(JSON.stringify(THEME_TOKENS))).toEqual([...THEME_TOKENS])
  })
})

describe('default colours meet WCAG 2.2 AA', () => {
  // Text pairs need 4.5:1 (1.4.3). Each foreground is checked on every background it is
  // drawn on in the components.
  const TEXT_PAIRS: [keyof ThemeScheme, keyof ThemeScheme][] = [
    ['text', 'background'],
    ['text', 'surface'],
    ['text', 'input'],
    ['textMuted', 'background'],
    ['textMuted', 'surface'],
    ['primaryText', 'primary'],
    ['primaryText', 'primaryHover'],
    ['link', 'background'],
    ['link', 'surface'],
    ['danger', 'background'],
    ['danger', 'dangerSurface'],
    ['danger', 'surface'],
    ['success', 'background'],
    ['success', 'surface'],
    ['text', 'dangerSurface'],
  ]
  // Control edges and the focus ring need 3:1 against what is next to them (1.4.11).
  const EDGE_PAIRS: [keyof ThemeScheme, keyof ThemeScheme][] = [
    ['borderStrong', 'background'],
    ['borderStrong', 'input'],
    ['focus', 'background'],
    ['focus', 'surface'],
    ['primary', 'background'],
    ['danger', 'input'],
  ]

  for (const [name, scheme] of SCHEMES) {
    test.each(TEXT_PAIRS)(`${name}: %s on %s is at least 4.5:1`, (foreground, background) => {
      expect(contrastRatio(scheme[foreground], scheme[background])).toBeGreaterThanOrEqual(4.5)
    })
    test.each(EDGE_PAIRS)(`${name}: %s against %s is at least 3:1`, (foreground, background) => {
      expect(contrastRatio(scheme[foreground], scheme[background])).toBeGreaterThanOrEqual(3)
    })
  }
})

describe('contrastRatio', () => {
  test('is 21 for black on white, 1 for a colour on itself, and symmetric', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrastRatio('#5b4cf0', '#5b4cf0')).toBe(1)
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5)
  })

  test.each(['#fff', 'red', 'rgba(0, 0, 0, 0.5)', ''])('refuses %p', (colour) => {
    expect(() => contrastRatio(colour, '#000000')).toThrow(TypeError)
  })
})

describe('themeToCssVariables', () => {
  test('the whole default theme: a light and a dark property per scheme token, one per shared token', () => {
    const variables = themeToCssVariables(DEFAULT_THEME)
    const schemeTokens = THEME_TOKENS.filter((token) => token.scope === 'scheme')
    expect(Object.keys(variables)).toHaveLength(THEME_TOKENS.length + schemeTokens.length)
    expect(variables['--tula-color-primary']).toBe(DEFAULT_THEME.light.primary)
    expect(variables['--tula-dark-color-primary']).toBe(DEFAULT_THEME.dark.primary)
    expect(variables['--tula-radius']).toBe(DEFAULT_THEME.radius)
    expect(variables['--tula-dark-shadow']).toBe(DEFAULT_THEME.dark.shadow)
  })

  test('a partial theme yields only what it sets', () => {
    expect(
      themeToCssVariables({
        light: { primary: '#0f766e' },
        dark: { primary: '#5eead4' },
        radius: '6px',
      })
    ).toEqual({
      '--tula-color-primary': '#0f766e',
      '--tula-dark-color-primary': '#5eead4',
      '--tula-radius': '6px',
    })
    expect(themeToCssVariables({})).toEqual({})
  })

  test('unknown keys, inherited keys and non-string values are ignored', () => {
    const hostile = JSON.parse(
      '{"light":{"primary":7,"nope":"x","constructor":"y"},"radius":"","toString":"z"}'
    )
    expect(themeToCssVariables(hostile)).toEqual({})
  })

  test('darkCssVariable keeps the token’s name', () => {
    expect(darkCssVariable('--tula-shadow')).toBe('--tula-dark-shadow')
  })
})
