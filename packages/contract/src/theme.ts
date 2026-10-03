/**
 * The theme tokens every Tula front end shares: names, types and default values for light and
 * dark.
 *
 * This module is plain data and pure functions with no dependency (no Zod), so `@tula/react`
 * loads it at run time from `@tula/contract/theme`, and the Swift and Kotlin SDKs generate
 * their constants from the same table. Everything here is JSON-serialisable on purpose: a
 * theme can be written in `tula.config.ts`, stored by the dashboard's editor, or read by a
 * code generator in another language.
 *
 * Tokens are append-only, like error codes: removing or renaming one is a breaking change for
 * every app that sets it.
 */

/**
 * The tokens that differ between light and dark: colours and the card's shadow.
 *
 * Colours are `#rrggbb` (or any CSS colour, for a web-only theme); the defaults are all
 * `#rrggbb` so that every platform can parse them and their contrast can be checked.
 */
export interface ThemeScheme {
  /** Behind a component: the card, the menu, the dialog. */
  background: string
  /** A quieter panel on top of the background: list rows, the hover state of a menu item. */
  surface: string
  /** The inside of a text field. */
  input: string
  /** Body text and headings. */
  text: string
  /** Secondary text: hints, descriptions, an unmet checklist rule. */
  textMuted: string
  /** The brand colour: the main button, the selected state. */
  primary: string
  /** The main button while hovered or pressed. */
  primaryHover: string
  /** Text and icons on top of `primary`. */
  primaryText: string
  /** Links and text buttons. */
  link: string
  /** Hairlines: the card's edge, dividers. */
  border: string
  /** The edge of a control (a text field, a secondary button). At least 3:1 on `background`. */
  borderStrong: string
  /** Error text, the edge of an invalid field, destructive actions. */
  danger: string
  /** Behind an error message. */
  dangerSurface: string
  /** A met checklist rule, a success message. */
  success: string
  /** The keyboard focus ring. At least 3:1 on `background`. */
  focus: string
  /** Dims the page behind a dialog. */
  overlay: string
  /** The card's shadow (a CSS `box-shadow` value; other platforms map it to an elevation). */
  shadow: string
}

/**
 * A complete theme: one {@link ThemeScheme} for light, one for dark, and the tokens both share.
 *
 * @example
 * ```ts
 * const theme: Theme = { ...DEFAULT_THEME, radius: '6px' }
 * ```
 */
export interface Theme {
  /** Colours and shadow in the light scheme. */
  light: ThemeScheme
  /** Colours and shadow in the dark scheme. */
  dark: ThemeScheme
  /** Corner radius of cards, fields and buttons. */
  radius: string
  /** Corner radius of small parts: badges, menu items, the checklist bar. */
  radiusSmall: string
  /** The typeface of everything. */
  fontFamily: string
  /** The typeface of codes and keys. */
  fontFamilyMono: string
  /** Body text size. */
  fontSize: string
  /** Size of hints, badges and the checklist. */
  fontSizeSmall: string
  /** Size of a card's title. */
  fontSizeTitle: string
  /** The spacing unit: gaps and paddings are multiples of it. */
  spacing: string
}

/**
 * Part of a theme: only the tokens an app wants to change. What it leaves out keeps the
 * default.
 *
 * @example
 * ```ts
 * const brand: ThemeOverrides = {
 *   light: { primary: '#0f766e', primaryHover: '#115e59' },
 *   dark: { primary: '#5eead4', primaryText: '#042f2e' },
 *   radius: '6px',
 * }
 * ```
 */
export type ThemeOverrides = Partial<Omit<Theme, 'light' | 'dark'>> & {
  /** Tokens to change in the light scheme. */
  light?: Partial<ThemeScheme>
  /** Tokens to change in the dark scheme. */
  dark?: Partial<ThemeScheme>
}

/** What kind of value a token holds, for a generator that has to map it to a platform type. */
export type ThemeTokenType = 'color' | 'shadow' | 'length' | 'fontFamily'

/** One token of the theme, described for code generators and documentation. */
export interface ThemeTokenDefinition {
  /** The token's key in {@link ThemeScheme} (`scope: 'scheme'`) or {@link Theme} (`'shared'`). */
  readonly key: string
  /** `scheme`: a value per colour scheme. `shared`: one value for both. */
  readonly scope: 'scheme' | 'shared'
  /** The kind of value. */
  readonly type: ThemeTokenType
  /**
   * The CSS custom property an app sets to change the token (in the light scheme, for a
   * `scheme` token). A `scheme` token's dark value is set with {@link darkCssVariable}.
   */
  readonly cssVariable: `--tula-${string}`
  /** What the token is used for. */
  readonly description: string
}

function scheme(
  key: keyof ThemeScheme,
  css: string,
  description: string,
  type: ThemeTokenType = 'color'
): ThemeTokenDefinition {
  return { key, scope: 'scheme', type, cssVariable: `--tula-${css}`, description }
}

function shared(
  key: Exclude<keyof Theme, 'light' | 'dark'>,
  css: string,
  type: ThemeTokenType,
  description: string
): ThemeTokenDefinition {
  return { key, scope: 'shared', type, cssVariable: `--tula-${css}`, description }
}

/**
 * Every token, in the order stylesheets and generated constants list them.
 *
 * @example
 * ```ts
 * for (const token of THEME_TOKENS) {
 *   // token.key 'primary', token.cssVariable '--tula-color-primary', token.type 'color'
 * }
 * ```
 */
export const THEME_TOKENS: readonly ThemeTokenDefinition[] = [
  scheme('background', 'color-background', 'Behind a component: the card, the menu, the dialog.'),
  scheme('surface', 'color-surface', 'A quieter panel: list rows, a hovered menu item.'),
  scheme('input', 'color-input', 'The inside of a text field.'),
  scheme('text', 'color-text', 'Body text and headings.'),
  scheme('textMuted', 'color-text-muted', 'Secondary text: hints, an unmet checklist rule.'),
  scheme('primary', 'color-primary', 'The brand colour: the main button.'),
  scheme('primaryHover', 'color-primary-hover', 'The main button while hovered or pressed.'),
  scheme('primaryText', 'color-primary-text', 'Text and icons on the primary colour.'),
  scheme('link', 'color-link', 'Links and text buttons.'),
  scheme('border', 'color-border', 'Hairlines: the card edge, dividers.'),
  scheme('borderStrong', 'color-border-strong', 'The edge of a text field or secondary button.'),
  scheme('danger', 'color-danger', 'Error text, invalid fields, destructive actions.'),
  scheme('dangerSurface', 'color-danger-surface', 'Behind an error message.'),
  scheme('success', 'color-success', 'A met checklist rule, a success message.'),
  scheme('focus', 'color-focus', 'The keyboard focus ring.'),
  scheme('overlay', 'color-overlay', 'Dims the page behind a dialog.'),
  scheme('shadow', 'shadow', 'The card shadow.', 'shadow'),
  shared('radius', 'radius', 'length', 'Corner radius of cards, fields and buttons.'),
  shared('radiusSmall', 'radius-small', 'length', 'Corner radius of badges and menu items.'),
  shared('fontFamily', 'font-family', 'fontFamily', 'The typeface of everything.'),
  shared('fontFamilyMono', 'font-family-mono', 'fontFamily', 'The typeface of codes.'),
  shared('fontSize', 'font-size', 'length', 'Body text size.'),
  shared('fontSizeSmall', 'font-size-small', 'length', 'Size of hints and the checklist.'),
  shared('fontSizeTitle', 'font-size-title', 'length', 'Size of a card title.'),
  shared('spacing', 'spacing', 'length', 'The spacing unit.'),
]

/**
 * The default theme. Every text colour has a contrast of at least 4.5:1 on the backgrounds it
 * is drawn on, and control edges and the focus ring at least 3:1, in both schemes (WCAG 2.2
 * AA); the contract's tests compute it.
 *
 * @example
 * ```ts
 * DEFAULT_THEME.light.primary // '#5b4cf0'
 * ```
 */
export const DEFAULT_THEME: Theme = {
  light: {
    background: '#ffffff',
    surface: '#f5f4f0',
    input: '#ffffff',
    text: '#17171c',
    textMuted: '#5c5a55',
    primary: '#5b4cf0',
    primaryHover: '#4a3bdc',
    primaryText: '#ffffff',
    link: '#4a3bdc',
    border: '#e3e0d8',
    borderStrong: '#8a877e',
    danger: '#b42318',
    dangerSurface: '#fdecea',
    success: '#1a6b3c',
    focus: '#5b4cf0',
    overlay: 'rgba(23, 23, 28, 0.55)',
    shadow: '0 1px 2px rgba(23, 23, 28, 0.06), 0 12px 32px rgba(23, 23, 28, 0.1)',
  },
  dark: {
    background: '#17171c',
    surface: '#202128',
    input: '#101014',
    text: '#f4f4f6',
    textMuted: '#a9a9b4',
    primary: '#8f84ff',
    primaryHover: '#a59cff',
    primaryText: '#121117',
    link: '#aaa2ff',
    border: '#2e2f39',
    borderStrong: '#74758a',
    danger: '#ff8a80',
    dangerSurface: '#3a1a1c',
    success: '#6fd49a',
    focus: '#aaa2ff',
    overlay: 'rgba(0, 0, 0, 0.65)',
    shadow: '0 1px 2px rgba(0, 0, 0, 0.4), 0 12px 32px rgba(0, 0, 0, 0.5)',
  },
  radius: '12px',
  radiusSmall: '8px',
  fontFamily:
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  fontFamilyMono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  fontSize: '0.9375rem',
  fontSizeSmall: '0.8125rem',
  fontSizeTitle: '1.5rem',
  spacing: '1rem',
}

/**
 * The CSS custom property that sets a `scheme` token's value in the dark scheme.
 *
 * Light and dark have separate properties so that an app can set both in one place (a
 * stylesheet rule or an inline style) without a media query.
 *
 * @param cssVariable - The token's `cssVariable`.
 * @returns The dark property's name.
 *
 * @example
 * ```ts
 * darkCssVariable('--tula-color-primary') // '--tula-dark-color-primary'
 * ```
 */
export function darkCssVariable(cssVariable: `--tula-${string}`): `--tula-dark-${string}` {
  return `--tula-dark-${cssVariable.slice('--tula-'.length)}`
}

/**
 * Turn a theme, or part of one, into CSS custom properties.
 *
 * Only the tokens present in `theme` are returned, so the result of a partial theme can be
 * applied as an inline style on top of the stylesheet's defaults. Unknown keys are ignored.
 * Light values use each token's `cssVariable`; dark values its {@link darkCssVariable}.
 *
 * @param theme - A theme or overrides.
 * @returns Property names and values, in the order of {@link THEME_TOKENS}.
 *
 * @example
 * ```ts
 * themeToCssVariables({ light: { primary: '#0f766e' }, dark: { primary: '#5eead4' }, radius: '6px' })
 * // { '--tula-color-primary': '#0f766e', '--tula-dark-color-primary': '#5eead4', '--tula-radius': '6px' }
 * ```
 */
export function themeToCssVariables(theme: ThemeOverrides): Record<string, string> {
  const variables: Record<string, string> = {}
  const own = (source: object | undefined, key: string): string | undefined => {
    const value =
      source && Object.hasOwn(source, key) ? (source as Record<string, unknown>)[key] : undefined
    return typeof value === 'string' && value !== '' ? value : undefined
  }
  for (const token of THEME_TOKENS) {
    if (token.scope === 'shared') {
      const value = own(theme, token.key)
      if (value !== undefined) {
        variables[token.cssVariable] = value
      }
      continue
    }
    const light = own(theme.light, token.key)
    if (light !== undefined) {
      variables[token.cssVariable] = light
    }
    const dark = own(theme.dark, token.key)
    if (dark !== undefined) {
      variables[darkCssVariable(token.cssVariable)] = dark
    }
  }
  return variables
}

function channel(value: number): number {
  const scaled = value / 255
  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!match) {
    throw new TypeError(`contrastRatio: expected a #rrggbb colour, got "${hex}"`)
  }
  const [red, green, blue] = match.slice(1).map((part) => channel(Number.parseInt(part, 16)))
  return 0.2126 * (red ?? 0) + 0.7152 * (green ?? 0) + 0.0722 * (blue ?? 0)
}

/**
 * The WCAG contrast ratio of two opaque colours, from 1 (the same colour) to 21 (black on
 * white). Body text needs 4.5; large text, control edges and focus rings need 3.
 *
 * @param foreground - A `#rrggbb` colour.
 * @param background - A `#rrggbb` colour.
 * @returns The ratio.
 * @throws TypeError for a colour that is not `#rrggbb`.
 *
 * @example
 * ```ts
 * contrastRatio('#ffffff', '#5b4cf0') >= 4.5 // white text on the default primary passes AA
 * ```
 */
export function contrastRatio(foreground: string, background: string): number {
  const a = luminance(foreground)
  const b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}
