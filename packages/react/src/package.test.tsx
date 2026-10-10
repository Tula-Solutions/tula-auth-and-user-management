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
    // The page an emailed link leads to renders its waiting state: nothing read the address.
    expect(has('Signing you in…')).toBe(true)
    expect(has('href="/sign-up"')).toBe(true)
    expect(has('--tula-color-primary:#0f766e')).toBe(true)
  })
})

describe('what @tula/react costs a browser bundle', () => {
  /**
   * Minified and gzipped, with `@tula/core` and its part of the contract, without React.
   * The emailed code and link took it past the 26 kB it was first budgeted at; two-step
   * verification (the second-factor and enrolment screens, the profile section, the step-up
   * and backup-code dialogs, and the client's part) took it to about 32.7 kB. OAuth (ADR 0026:
   * the provider buttons with their three marks, the callback page, the connected-accounts
   * section, their strings, and 1.5 kB in the client) took it to about 38 kB, and the budget
   * from 35 kB to 39 kB. The step-up by emailed code (its form in the dialog, its strings and
   * the client's call) and the passwordless profile's guidance took it to about 39.3 kB, and
   * the budget to 40 kB. Passkeys (ADR 0027) took it to about 44.5 kB and the budget to 45.5 kB:
   * 2.1 kB is the client's (the ceremonies with their base64url fallback, the guards of the
   * passkey routes; measured at 41.4 kB before any screen existed) and 3.1 kB the components'
   * (the sign-in button with its autofill request, the second-factor and step-up panel, the
   * profile section with rename and remove, and their strings). No dependency was added.
   * The phase-1 review fixes took it just past that, to about 45.6 kB, and the budget to
   * 46 kB: the provider's "sign-out did not finish" dialog with its retry and strings, the
   * refusal of a destination that names a host without a scheme, and `discard()` on every flow.
   * A phone number on an account (ADR 0037) took it to 47,364 bytes and the budget to 47.8 kB:
   * about 0.25 kB is the client's (three routes, `user.phone`, four error messages) and the
   * rest the profile's section (the number form, the code form, the summary with change and
   * remove, and their strings). No dependency was added, and the contract's phone number
   * rules are not in the bundle: the server judges a number. Together with the Microsoft
   * button (TULA-12, about 0.1 kB, which landed without a change to the budget) it measures
   * 47,475 bytes, and the budget moved by those 111 bytes, to 47,911, so the room left is
   * what it was.
   * Discord's and LinkedIn's buttons (TULA-13) are two more marks, each one path, and two
   * names: with them it measures 48,362 bytes, 887 more. The budget moved by exactly those
   * bytes, to 48,798, so the 436 bytes of room there were are what is left.
   * X's and Facebook's buttons (TULA-14) are two more one-path marks and two names, and a
   * signed-in user may now have no email address (no address line, no badge, no password
   * section): with both it measures 48,885 bytes, 523 more. The budget moved by exactly
   * those bytes, to 49,321, so the 436 bytes of room are still what is left.
   * The password history (ADR 0038) is one more line of the checklist, in two states
   * (waiting for the server, refused by it), its three strings, and the rule that decides
   * between them on the profile's and the reset's password field: with it the bundle
   * measures 49,173 bytes, 288 more. The budget moved by exactly those bytes, to 49,609, so
   * the 436 bytes of room are still what is left.
   * Signing in with a texted code (TULA-27) is one more first-factor form (ask, then the
   * code with its resend), the first field that also takes a phone number, their strings,
   * and one error message in the client: with them it measures 49,879 bytes, 706 more. The
   * budget moved by exactly those bytes, to 50,315, so the 436 bytes of room are still what
   * is left.
   * Password expiry (ADR 0041) is one more screen of the sign-in (one field with the
   * checklist and its history line), four strings and the client's `submitNewPassword`:
   * with them it measures 50,200 bytes, 321 more. The budget moved by exactly those bytes,
   * to 50,636, so the 436 bytes of room are still what is left.
   * A texted code as the second step (ADR 0025, TULA-46) is one form (ask, then the code,
   * used by the sign-in and reset screen, the step-up dialog and the profile), the profile's
   * lines for it, eleven strings, and 290 bytes in the client: with them it measures 51,645
   * bytes, 1,445 more. The budget moved by exactly those bytes, to 52,081, so the 436 bytes
   * of room are still what is left.
   * Its review (TULA-46) added what a user is told: that a passkey replaces a texted code
   * and has no backup codes, that a texted code set aside comes back, the form that takes
   * its controls away when the app has switched the method off, and "Add a passkey" held
   * until the second step has been read (four strings, one changed). The first three landed
   * inside the room there was; with the fourth the bundle measures 52,272 bytes, 627 more
   * than before the review. The budget moved by exactly those bytes, to 52,708, so the 436
   * bytes of room are still what is left.
   */
  const GZIP_BUDGET_BYTES = 52_708
  /**
   * The QR encoder, in a chunk of its own: loaded when an enrolment is first drawn, so an app
   * that never shows one does not pay for it.
   */
  const QR_CHUNK_GZIP_BUDGET_BYTES = 3_000

  test('the components stay within their size budget and bring no schema library', async () => {
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, 'index.ts')],
      target: 'browser',
      minify: true,
      splitting: true,
      external: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
    })
    expect(built.success).toBe(true)
    const outputs = await Promise.all(
      built.outputs.map(async (output) => ({ kind: output.kind, code: await output.text() }))
    )
    const gzip = (code: string) => Bun.gzipSync(Buffer.from(code)).byteLength
    // What a page loads up front: the entry and whatever it imports statically.
    const eager = outputs.filter((output) => output.kind === 'entry-point')
    const lazy = outputs.filter((output) => !eager.includes(output))
    const code = eager.map((output) => output.code).join('\n')
    expect(code.includes('data-tula-element')).toBe(true)
    expect(gzip(code)).toBeLessThan(GZIP_BUDGET_BYTES)
    expect(['ZodType', '_zod', 'safeParse'].filter((marker) => code.includes(marker))).toEqual([])
    // The encoder is not in what loads up front, and is small where it is.
    expect(lazy).toHaveLength(1)
    expect(code.includes('crispEdges')).toBe(true)
    expect(gzip(lazy[0]?.code ?? '')).toBeLessThan(QR_CHUNK_GZIP_BUDGET_BYTES)
  })

  test('the stylesheet is small', () => {
    expect(Bun.gzipSync(Buffer.from(stylesheet)).byteLength).toBeLessThan(6_000)
  })
})
