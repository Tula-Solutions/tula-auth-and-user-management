import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  contrastRatio,
  DEFAULT_THEME,
  THEME_TOKENS,
  themeToCssVariables,
} from '@tula-tech/contract/theme'
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

  test('no entrance animation is declared after the reduced-motion block, which must name [open]', () => {
    // Same specificity (:where), so a later `animation: tula-in` would beat the reset: the
    // modal kept sliding in under prefers-reduced-motion.
    const start = stylesheet.indexOf('@media (prefers-reduced-motion: reduce)')
    const end = stylesheet.indexOf('\n}\n', start)
    const after = stylesheet.slice(end)
    expect(after.match(/animation:\s*tula-/g) ?? []).toEqual([])
    expect(stylesheet.slice(start, end)).toContain(':where(.tula-modal)[open]')
  })

  test('a card’s header and footer are centred, like the native screens', () => {
    const rule = (selector: string) => {
      const start = stylesheet.indexOf(`:where(${selector}) {`)
      return stylesheet.slice(start, stylesheet.indexOf('}', start))
    }
    for (const selector of ['.tula-header', '.tula-footer']) {
      expect(rule(selector)).toContain('align-items: center')
      expect(rule(selector)).toContain('text-align: center')
    }
    expect(rule('.tula-branding')).toContain('justify-content: center')
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

describe('what the step renderer teaches a copy about hooks', () => {
  const source = sources.find((entry) => entry.path === 'components/step-renderer.tsx')?.text ?? ''
  // The `@example` blocks of the JSDoc of `StepScreens` and `StepRenderer`.
  const examples = [
    ...source
      .split('/**')
      .filter((block) => /@example/.test(block) && /\bStep(Screens|Renderer)\b/.test(block))
      .flatMap((block) =>
        [...block.matchAll(/```tsx([\s\S]*?)```/g)].map((match) => match[1] ?? '')
      ),
  ]

  test('the examples are found', () => {
    expect(examples.length).toBeGreaterThanOrEqual(2)
  })

  test('no example calls a hook inside a screen: the pattern is a component that holds them', () => {
    for (const example of examples) {
      // What follows `screens`: a hook above it (`useSignUp()` for the flow) is the app's own.
      const inScreens = example.slice(example.indexOf('screens'))
      expect(inScreens).not.toMatch(/\buse[A-Z]\w*\(/)
    }
  })

  test('the screens example shows a component screen', () => {
    const screens = examples.find((text) => /StepScreens/.test(text)) ?? ''
    // Any arrow that returns a component element: renaming the parameter or adding a prop to
    // the example must not fail this.
    expect(screens).toMatch(/=> <[A-Z]\w*\b/)
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
    // The headless layer a copied component uses renders without a DOM too: the hooks ask the
    // browser nothing during render (support is not known yet), the step renderer draws a
    // screen from the map and the "not supported" screen for a status it has none for.
    expect(has('passkey:undefined')).toBe(true)
    expect(has('wait:0')).toBe(true)
    expect(has('changed:false|strategies:password')).toBe(true)
    expect(has('retry:Try again in 1m 5s.')).toBe(true)
    expect(has('<p>copied password screen</p>')).toBe(true)
    expect(has('data-tula-unsupported')).toBe(true)
  })
})

describe('what @tula-tech/react costs a browser bundle', () => {
  /**
   * Minified and gzipped, with `@tula-tech/core` and its part of the contract, without React.
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
   * Device binding (ADR 0043) adds no component and no string of this package: what grew is
   * `@tula-tech/core` inside the bundle (three error messages, making a proof and the
   * transport's repeat after a nonce challenge; a `web` client, which is what these
   * components run in, is refused a device key, but the code is the client's and is not
   * split out). Measured on the tree that has both this and the texted second step, the
   * bundle is 52,835 bytes, 563 more than the 52,272 before. The budget was set from that
   * measurement, to 53,271, so the 436 bytes of room are still what is left.
   * An email address for an account without one (ADR 0059, TULA-69) came in two parts. The
   * client's two calls and the message of `email.already_set` are `@tula-tech/core`'s and landed
   * inside the room there was: the bundle then measured 53,175 bytes, 340 more, with 96
   * bytes of room left. The profile's section (a form, the code step, "sign in again" for a
   * user with nothing to step up with, ten strings) is this package's: with it the bundle
   * measures 53,997 bytes, 822 more. The budget was set from that measurement, to 54,433,
   * so the 436 bytes of room are what is left again. The headless layer made public for the
   * copy-in components (ADR 0064: the step renderer, the first-factor table's helper, five
   * hooks) took it to 54,436 bytes, 439 more. The budget moved by exactly those bytes, to
   * 54,872, so the 436 bytes of room are still what is left.
   * The client side of organizations (ADR 0065, Orgs 02) is `@tula-tech/core`'s: the three
   * calls, the `org_id` read and `setActiveOrganization`, with the four error messages; the
   * four messages of custom roles (Orgs 03) arrive with them. The bundle then measured 55,248
   * bytes, 812 more. The budget moved by exactly the measurement, to 55,684, so the 436 bytes
   * of room are still what is left.
   * The organization hooks (ADR 0065, Orgs 06: `useOrganization`, `useOrganizationList`, the
   * per-client store behind them that keeps a list for the session it was fetched for, and
   * `has()` with the contract's claim grammar it checks a role against) took it to 56,654
   * bytes, 1,406 more. The budget moved by exactly those bytes, to 57,090, so the 436 bytes
   * of room are still what is left.
   * Invitations by email (ADR 0065, Orgs 04) are `@tula-tech/core`'s: the ten error messages
   * and the `organizations.invitations` calls, with the message of
   * `user.last_organization_manager` that arrived with it from `develop`. The bundle then
   * measured 57,090 bytes, 436 more. The budget moved by exactly those bytes, to 57,526, so
   * the 436 bytes of room are still what is left.
   * The words of the Tula UI organization items (ADR 0064, ADR 0065, Orgs 10: the
   * `organizations` group of the localization, 29 strings) took it to 57,504 bytes, 414 more.
   * The budget moved by exactly those bytes, to 57,940, so the 436 bytes of room are still
   * what is left.
   * `<OrganizationSwitcher>`, `<CreateOrganization>` and `<OrganizationProfile>` (ADR 0065,
   * Orgs 07: four tabs, their words, the member, role, rename, leave, delete and domain calls
   * of `@tula-tech/core`, the three components' own forms and the re-exported `readInvitationLink`,
   * which the page an invitation link leads to reads) took it to 69,138 bytes, 11,634 more: three
   * screens with a dozen states each, not one control. The budget moved by exactly those bytes, to
   * 69,574, so the 436 bytes of room are still what is left.
   */
  const GZIP_BUDGET_BYTES = 69_574
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
    // 8 KB: the premium polish (focus halo, entrances, press feedback, narrow and coarse-pointer
    // rules) cost about 0.9 KB over the first 6 KB budget; still no CSS framework.
    expect(Bun.gzipSync(Buffer.from(stylesheet)).byteLength).toBeLessThan(8_000)
  })
})

describe('the default theme as shipped in the stylesheet', () => {
  /** Each scheme's colour defaults, read out of the generated block's own text. */
  function shipped(scheme: 'light' | 'dark'): Record<string, string> {
    const prefix = scheme === 'dark' ? '--tula-dark-color-' : '--tula-color-'
    const out: Record<string, string> = {}
    for (const match of stylesheet.matchAll(
      new RegExp(`var\\(${prefix}([a-z-]+), (#[0-9a-f]{6})\\)`, 'g')
    )) {
      // The dark block appears twice (media query and attribute); both must agree.
      const [, name, value] = match as unknown as [string, string, string]
      expect(out[name] ?? value).toBe(value)
      out[name] = value
    }
    return out
  }

  test('resolves with nothing refused: every token of the default theme passes its grammar', () => {
    const variables = themeToCssVariables(DEFAULT_THEME)
    const schemeTokens = THEME_TOKENS.filter((token) => token.scope === 'scheme')
    expect(Object.keys(variables)).toHaveLength(THEME_TOKENS.length + schemeTokens.length)
  })

  // Text on each background it is drawn on; the 4.5:1 of WCAG 1.4.3 in both schemes.
  const PAIRS: [string, string][] = [
    ['text', 'background'],
    ['text', 'surface'],
    ['text', 'input'],
    ['text-muted', 'background'],
    ['text-muted', 'surface'],
    ['text-muted', 'input'],
    ['primary-text', 'primary'],
    ['primary-text', 'primary-hover'],
    ['link', 'background'],
    ['link', 'surface'],
    ['danger', 'background'],
    ['danger', 'danger-surface'],
    ['danger', 'surface'],
    ['success', 'background'],
    ['success', 'surface'],
    ['text', 'danger-surface'],
  ]
  for (const scheme of ['light', 'dark'] as const) {
    test.each(PAIRS)(`${scheme}: %s on %s is at least 4.5:1`, (foreground, background) => {
      const colours = shipped(scheme)
      expect(colours[foreground]).toBeDefined()
      expect(colours[background]).toBeDefined()
      expect(
        contrastRatio(colours[foreground] as string, colours[background] as string)
      ).toBeGreaterThanOrEqual(4.5)
    })

    test(`${scheme}: control edges and the focus ring are at least 3:1`, () => {
      const colours = shipped(scheme) as Record<string, string>
      for (const [edge, ground] of [
        ['border-strong', 'background'],
        ['border-strong', 'input'],
        ['focus', 'background'],
        ['focus', 'surface'],
      ] as const) {
        expect(
          contrastRatio(colours[edge] as string, colours[ground] as string)
        ).toBeGreaterThanOrEqual(3)
      }
    })
  }
})
