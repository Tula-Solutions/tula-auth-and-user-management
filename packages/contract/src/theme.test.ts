import { describe, expect, test } from 'bun:test'
import {
  contrastRatio,
  DEFAULT_THEME,
  darkCssVariable,
  isValidThemeValue,
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

describe('theme values are untrusted: anything that is not a plain value of its type is dropped (F1)', () => {
  test('a value that would add a declaration or close the rule yields no entry', () => {
    expect(
      themeToCssVariables({
        light: { primary: 'red; background:url(https://evil.example/x)' },
        radius: '1px}',
      })
    ).toEqual({})
  })

  test('every default value passes the validator of its own type', () => {
    for (const token of THEME_TOKENS) {
      const values =
        token.scope === 'scheme'
          ? [
              DEFAULT_THEME.light[token.key as keyof ThemeScheme],
              DEFAULT_THEME.dark[token.key as keyof ThemeScheme],
            ]
          : [DEFAULT_THEME[token.key as 'radius']]
      for (const value of values) {
        expect(`${token.key}: ${isValidThemeValue(token.type, value)}`).toBe(`${token.key}: true`)
      }
    }
  })

  test.each([
    ['color', '#0f766e'],
    ['color', '#FFF'],
    ['color', '#0f766e80'],
    ['color', 'rgb(15, 118, 110)'],
    ['color', 'rgba(15 118 110 / 0.5)'],
    ['color', 'hsl(175deg 77% 26%)'],
    ['color', 'oklch(0.7 0.1 180 / 50%)'],
    ['color', 'rebeccapurple'],
    ['color', 'transparent'],
    ['length', '12px'],
    ['length', '0'],
    ['length', '0.9375rem'],
    ['length', '.5em'],
    ['length', '100%'],
    ['fontFamily', 'Inter'],
    ['fontFamily', '"Helvetica Neue", Arial, sans-serif'],
    ['fontFamily', "'Segoe UI', -apple-system, system-ui"],
    ['fontFamily', 'Source Sans 3, sans-serif'],
    ['shadow', 'none'],
    ['shadow', '0 1px 2px rgba(0, 0, 0, 0.4)'],
    ['shadow', 'inset 0 0 0 1px #e3e0d8, 0 12px 32px -4px rgb(23 23 28 / 10%)'],
  ] as ['color' | 'length' | 'fontFamily' | 'shadow', string][])('%s %p is kept', (type, value) => {
    expect(isValidThemeValue(type, value)).toBe(true)
  })

  test.each([
    ['color', 'red; background: blue'],
    ['color', 'url(https://evil.example/x)'],
    ['color', 'rgb(0,0,0) url(x)'],
    ['color', 'rgb(url(x))'],
    ['color', 'var(--anything)'],
    ['color', 'expression(alert(1))'],
    ['color', '#12345'],
    ['color', '#ggg'],
    ['color', 'red}'],
    ['color', 'red/*'],
    ['color', 'r\\65 d'],
    ['color', 'red\n'],
    ['color', '</style><script>'],
    ['color', 'red !important'],
    ['color', ''],
    ['color', `#${'a'.repeat(300)}`],
    ['length', '1px}'],
    ['length', '1px; color: red'],
    ['length', 'calc(1px + 1px)'],
    ['length', '12'],
    ['length', '1px 2px'],
    ['length', '@import'],
    ['fontFamily', 'Inter; color: red'],
    ['fontFamily', '"Inter'],
    ['fontFamily', '"In"ter"'],
    ['fontFamily', 'Inter, url(x)'],
    ['fontFamily', 'Inter,, Arial'],
    ['fontFamily', '<b>'],
    ['shadow', '0 1px 2px red; color: red'],
    ['shadow', '0 1px 2px url(x)'],
    ['shadow', '1px'],
    ['shadow', '0 1px 2px 3px 4px red'],
    ['shadow', '0 1px red blue'],
    ['shadow', '0 1px 2px rgba(0,0,0,0.4)) , x'],
  ] as ['color' | 'length' | 'fontFamily' | 'shadow', string][])(
    '%s %p is dropped',
    (type, value) => {
      expect(isValidThemeValue(type, value)).toBe(false)
    }
  )

  test('a non-string is never valid', () => {
    expect(isValidThemeValue('color', 7 as unknown as string)).toBe(false)
  })
})
