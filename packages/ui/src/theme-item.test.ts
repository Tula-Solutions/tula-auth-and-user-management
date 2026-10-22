import { describe, expect, test } from 'bun:test'
import { DEFAULT_THEME, darkCssVariable, THEME_TOKENS } from '@tula-tech/contract/theme'
import { COLOR_MAP, reference, themeItemBody } from './theme-item'

describe('the theme item', () => {
  const body = themeItemBody()

  test('every value is a reference to a --tula-* property with the contract default', () => {
    for (const scheme of ['light', 'dark'] as const) {
      for (const [name, value] of Object.entries(body.cssVars[scheme])) {
        if (name === 'radius') {
          expect(value).toBe(`var(--tula-radius, ${DEFAULT_THEME.radius})`)
          continue
        }
        expect(value).toMatch(/^var\(--tula-[a-z-]+, [^)]+\)$/)
      }
    }
  })

  test('it holds no tenant value: only what the contract defines', () => {
    // A tenant's colour reaches the page through themeToCssVariables, which writes --tula-*.
    const allowed = new Set<string>()
    for (const scheme of ['light', 'dark'] as const) {
      for (const [, token] of COLOR_MAP) {
        allowed.add(reference(token, scheme))
      }
    }
    for (const scheme of ['light', 'dark'] as const) {
      for (const [name, value] of Object.entries(body.cssVars[scheme])) {
        if (name !== 'radius') {
          expect(allowed.has(value)).toBe(true)
        }
      }
    }
  })

  test('dark mode reads the dark spelling of a token', () => {
    const background = THEME_TOKENS.find((entry) => entry.key === 'background')
    if (!background) {
      throw new Error('no background token')
    }
    expect(body.cssVars.light.background).toContain(`var(${background.cssVariable},`)
    expect(body.cssVars.dark.background).toContain(
      `var(${darkCssVariable(background.cssVariable)},`
    )
    expect(body.cssVars.dark.background).toContain(DEFAULT_THEME.dark.background)
  })

  test('the radius is set in light only (dark inherits it)', () => {
    expect(body.cssVars.light.radius).toBeDefined()
    expect(body.cssVars.dark.radius).toBeUndefined()
  })

  test('every colour variable has its Tailwind utility mapping, never to itself', () => {
    for (const [name] of COLOR_MAP) {
      expect(body.cssVars.theme[`color-${name}`]).toBe(`var(--${name})`)
    }
  })

  test('data-tula-theme switches both ways, and the dark variant follows it and .dark', () => {
    const css = JSON.stringify(body.css)
    expect(css).toContain('[data-tula-theme=\\"dark\\"]')
    expect(css).toContain('[data-tula-theme=\\"light\\"]')
    expect(css).toContain('.dark *')
  })

  test('it names no font', () => {
    expect(JSON.stringify(body)).not.toMatch(/font/i)
  })

  test('a token the contract does not have is an error', () => {
    // biome-ignore lint/suspicious/noExplicitAny: a name the type refuses, on purpose
    expect(() => reference('nope' as any, 'light')).toThrow('has no token')
  })
})
