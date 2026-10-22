import {
  DEFAULT_THEME,
  darkCssVariable,
  THEME_TOKENS,
  type ThemeScheme,
} from '@tula-tech/contract/theme'

/**
 * The theme bridge: shadcn's CSS variables, set from Tula's public `--tula-*` properties.
 *
 * It is generated from `@tula-tech/contract/theme`, the one place a theme is defined, so the
 * defaults cannot drift from the prebuilt components' or the native SDKs'. It maps token
 * **names**: every value it writes is `var(--tula-<token>, <the contract's default>)`. It holds
 * no tenant value, and a tenant's colour still reaches the page only through
 * `themeToCssVariables`, which writes the `--tula-*` properties this reads and drops any value
 * the contract's grammar refuses.
 */

/**
 * Which Tula token drives each shadcn variable. shadcn's `input` is the colour of a field's
 * edge, which is Tula's `borderStrong` (a control's edge must reach 3:1); `muted`, `secondary`
 * and `accent` are the quiet panels, which is Tula's `surface`.
 */
export const COLOR_MAP: ReadonlyArray<readonly [variable: string, token: keyof ThemeScheme]> = [
  ['background', 'background'],
  ['foreground', 'text'],
  ['card', 'background'],
  ['card-foreground', 'text'],
  ['popover', 'background'],
  ['popover-foreground', 'text'],
  ['primary', 'primary'],
  ['primary-foreground', 'primaryText'],
  ['secondary', 'surface'],
  ['secondary-foreground', 'text'],
  ['muted', 'surface'],
  ['muted-foreground', 'textMuted'],
  ['accent', 'surface'],
  ['accent-foreground', 'text'],
  ['destructive', 'danger'],
  ['border', 'border'],
  ['input', 'borderStrong'],
  ['ring', 'focus'],
  // Not a shadcn variable: the colour of links and text buttons. Tula's components read it with
  // a fallback to `--primary`, so they work without this item.
  ['link', 'link'],
]

/** The CSS custom property of a scheme token, in the scheme's own spelling. */
function property(token: keyof ThemeScheme, scheme: 'light' | 'dark'): string {
  const definition = THEME_TOKENS.find((entry) => entry.key === token)
  if (!definition) {
    throw new Error(`theme item: the contract has no token "${token}"`)
  }
  return scheme === 'dark' ? darkCssVariable(definition.cssVariable) : definition.cssVariable
}

/**
 * The value of a shadcn variable in one scheme.
 *
 * @param token - The Tula token.
 * @param scheme - Light or dark.
 * @returns `var(--tula-color-…, <default>)`.
 */
export function reference(token: keyof ThemeScheme, scheme: 'light' | 'dark'): string {
  return `var(${property(token, scheme)}, ${DEFAULT_THEME[scheme][token]})`
}

function variables(scheme: 'light' | 'dark'): Record<string, string> {
  return Object.fromEntries(COLOR_MAP.map(([name, token]) => [name, reference(token, scheme)]))
}

const RADIUS = THEME_TOKENS.find((entry) => entry.key === 'radius')

/** What `cssVars` and `css` of the theme item hold; the build adds the item's name and type. */
export interface ThemeItemBody {
  cssVars: {
    /** Tailwind's colour utilities for each variable (`bg-background` reads `--background`). */
    theme: Record<string, string>
    light: Record<string, string>
    dark: Record<string, string>
  }
  css: Record<string, unknown>
}

/** @returns The variables of the theme item, and the rules for `data-tula-theme`. */
export function themeItemBody(): ThemeItemBody {
  if (!RADIUS) {
    throw new Error('theme item: the contract has no radius token')
  }
  const light = {
    ...variables('light'),
    radius: `var(${RADIUS.cssVariable}, ${DEFAULT_THEME.radius})`,
  }
  const dark = variables('dark')
  const asProperties = (values: Record<string, string>) =>
    Object.fromEntries(Object.entries(values).map(([name, value]) => [`--${name}`, value]))
  return {
    cssVars: {
      // Without these the CLI writes `--ring: var(--ring)` into `@theme inline`, a variable that
      // refers to itself. With them it finds the colour utilities it would have added.
      theme: Object.fromEntries(COLOR_MAP.map(([name]) => [`color-${name}`, `var(--${name})`])),
      light,
      dark,
    },
    css: {
      // `.dark` is shadcn's own mechanism; Tula's is `data-tula-theme` (on any ancestor, so one
      // part of a page can be dark). Both make Tailwind's `dark:` variant apply.
      '@custom-variant dark (&:is(.dark *, [data-tula-theme="dark"] *))': {},
      '@layer base': {
        '[data-tula-theme="dark"]': { 'color-scheme': 'dark', ...asProperties(dark) },
        // A part of a dark page can be light again.
        '[data-tula-theme="light"]': {
          'color-scheme': 'light',
          ...asProperties(light),
        },
      },
    },
  }
}
