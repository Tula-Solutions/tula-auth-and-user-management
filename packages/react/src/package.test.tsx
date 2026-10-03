import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { DEFAULT_THEME, THEME_TOKENS } from '@tula/contract/theme'
import { tokenBlockIsCurrent } from '../scripts/generate-tokens'
import { ELEMENT_NAMES } from './appearance'

const stylesheet = await Bun.file(join(import.meta.dir, 'styles.css')).text()
const sources = await Promise.all(
  [...new Bun.Glob('**/*.{ts,tsx}').scanSync(import.meta.dir)]
    .filter((path) => !path.includes('.test.') && !path.startsWith('testing/'))
    .map(async (path) => ({ path, text: await Bun.file(join(import.meta.dir, path)).text() }))
)

describe('the stylesheet', () => {
  test('its token defaults are the contract’s theme (run `bun run generate` after changing a token)', () => {
    expect(tokenBlockIsCurrent(stylesheet)).toBe(true)
    expect(tokenBlockIsCurrent(stylesheet.replace(DEFAULT_THEME.light.primary, '#000000'))).toBe(
      false
    )
    const compact = stylesheet.replace(/\s+/g, '')
    const missing = THEME_TOKENS.filter((token) => !compact.includes(`var(${token.cssVariable},`))
    expect(missing).toEqual([])
  })

  test('every rule reads the resolved tokens, never a public property or a literal colour', () => {
    const rules = stylesheet.slice(stylesheet.indexOf('/* tokens:end */'))
    expect(rules).not.toMatch(/var\(--tula-/)
    // The one literal is the backdrop's fallback for browsers whose ::backdrop does not inherit.
    const colours = rules.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi) ?? []
    expect(colours).toEqual(['rgba(0, 0, 0, 0.55)'])
  })

  test('every selector has no specificity (wrapped in :where) and every class is prefixed', () => {
    const rules = stylesheet
      .slice(stylesheet.indexOf('/* tokens:end */'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
    const selectors = [...rules.matchAll(/(^|\})\s*([^{}@]+)\{/g)]
      .map((match) => (match[2] ?? '').trim())
      .filter((selector) => selector !== '' && selector !== 'to')
    expect(selectors.length).toBeGreaterThan(60)
    for (const selector of selectors) {
      for (const part of selector.split(/,\s*(?![^()]*\))/)) {
        // Outside :where() only pseudo-classes, pseudo-elements, attributes and combinators.
        const outside = part.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, '')
        expect(`${part} → ${outside}`).not.toMatch(/→.*[.#][a-z]/i)
        expect(`${part} → ${outside}`).not.toMatch(/→\s*[a-z]/)
      }
    }
    const classes = rules.match(/\.[a-z][a-z0-9-]*/gi) ?? []
    expect(classes.filter((name) => !name.startsWith('.tula-'))).toEqual([])
  })

  test('respects reduced motion', () => {
    expect(stylesheet.includes('@media (prefers-reduced-motion: reduce)')).toBe(true)
  })

  test('every element name’s class is styled or deliberately bare', () => {
    const kebab = (name: string) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
    const bare = ELEMENT_NAMES.filter((name) => !stylesheet.includes(`.tula-${kebab(name)}`))
    // These take their look from their parents; they exist as hooks for an app's own CSS.
    expect(bare).toEqual(['inputGroup', 'hint'].filter(() => false) as typeof bare)
  })
})

describe('what the sources must never do', () => {
  test.each([
    ['render HTML from a string', /dangerouslySetInnerHTML|innerHTML\s*=|insertAdjacentHTML/],
    ['use web storage', /\b(localStorage|sessionStorage)\b/],
    ['log', /\bconsole\./],
    ['read a destination from the address bar', /location\.(search|hash)|URLSearchParams/],
    ['import a router or a CSS runtime', /from '(react-router|next\/|@emotion|styled-components)/],
  ] as [string, RegExp][])('%s', (_name, pattern) => {
    for (const { path, text } of sources) {
      expect(`${path}: ${pattern.test(text)}`).toBe(`${path}: false`)
    }
  })

  test('the check above covers every source file', () => {
    expect(sources.length).toBeGreaterThan(15)
  })
})

describe('server rendering', () => {
  test('the provider and every component render without a DOM, in the loading state', () => {
    // A process of its own, without this suite's DOM preload: see `testing/ssr-render.tsx`.
    const rendered = Bun.spawnSync(
      ['bun', 'run', join(import.meta.dir, 'testing', 'ssr-render.tsx')],
      {
        timeout: 30_000,
      }
    )
    expect(rendered.exitedDueToTimeout).toBeFalsy()
    expect(rendered.stderr.toString()).toBe('')
    expect(rendered.exitCode).toBe(0)
    const html = rendered.stdout.toString()
    const has = (text: string) => html.includes(text)
    expect(has('<p>loading</p>')).toBe(true)
    expect(has('<p>in</p>')).toBe(false)
    expect(has('<p>out</p>')).toBe(false)
    expect(has('Create your account')).toBe(true)
    expect(has('href="/sign-up"')).toBe(true)
    expect(has('--tula-color-primary:#0f766e')).toBe(true)
  })
})

describe('what @tula/react costs a browser bundle', () => {
  /** Minified and gzipped, with `@tula/core` and its part of the contract, without React. */
  const GZIP_BUDGET_BYTES = 26_000

  test('the components stay within their size budget and bring no schema library', async () => {
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, 'index.ts')],
      target: 'browser',
      minify: true,
      external: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
    })
    expect(built.success).toBe(true)
    const code = (await built.outputs[0]?.text()) ?? ''
    expect(code.includes('data-tula-element')).toBe(true)
    expect(Bun.gzipSync(Buffer.from(code)).byteLength).toBeLessThan(GZIP_BUDGET_BYTES)
    expect(['ZodType', '_zod', 'safeParse'].filter((marker) => code.includes(marker))).toEqual([])
  })

  test('the stylesheet is small', () => {
    expect(Bun.gzipSync(Buffer.from(stylesheet)).byteLength).toBeLessThan(6_000)
  })
})
