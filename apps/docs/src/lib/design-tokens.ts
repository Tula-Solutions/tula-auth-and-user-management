/**
 * The documentation site's design tokens: the one place its colours, type scale, shape,
 * elevation and motion are written (`tokensCss()` turns them into custom properties, and
 * `contrast.test.ts` measures every pair of them the site draws text or a control with).
 *
 * "Ink and paper, in balance": warm neutrals from the logo kit (`#1A1A18` ink, `#F1EFE8`
 * paper), one restrained accent used only for interaction (links, focus, the current page),
 * and dark mode as ink surfaces with paper text. The values are those of
 * `docs/plans/docs-overhaul.md`, section (e). The sign-in components' default theme
 * (`@tula-tech/contract/theme`) is a separate, product-wide decision; the site does not read it.
 */

/** The colour roles of one scheme. */
export interface ColorScheme {
  /** The page. */
  bg: string
  /** Code blocks, cards, table heads. */
  surface: string
  /** Popovers, the search results, inputs. */
  raised: string
  /** Headings and strong text. */
  ink: string
  /** Paragraphs. */
  body: string
  /** Captions, idle navigation, the lead. */
  muted: string
  /** Metadata and placeholders. Still AA, but never for body text. */
  faint: string
  /** Hairlines: decorative only. */
  border: string
  /** The edge of a control, which must be seen (3:1). */
  borderStrong: string
  /** Links, the focus ring, the current page. */
  accent: string
  /** The selected row. */
  accentSoft: string
  /** Text on a solid accent. */
  onAccent: string
  ok: string
  warn: string
  danger: string
  /** The primary button: ink on paper, the brand's own two tones. */
  btnBg: string
  btnFg: string
}

/** Light and dark palettes. */
export const COLORS: { light: ColorScheme; dark: ColorScheme } = {
  light: {
    bg: '#FAF9F5',
    surface: '#F1EFE8',
    raised: '#FFFFFF',
    ink: '#1A1A18',
    body: '#3A3935',
    muted: '#5F5E5A',
    faint: '#6E6C66',
    border: '#D9D6CB',
    borderStrong: '#8A877E',
    accent: '#4A3BDC',
    accentSoft: '#E9E6FC',
    onAccent: '#FFFFFF',
    ok: '#1A6B3C',
    warn: '#8A5300',
    danger: '#B42318',
    btnBg: '#1A1A18',
    btnFg: '#F1EFE8',
  },
  dark: {
    bg: '#141412',
    surface: '#1C1C19',
    raised: '#232320',
    ink: '#F1EFE8',
    body: '#D6D3C8',
    muted: '#A3A096',
    faint: '#8E8B81',
    border: '#34332E',
    borderStrong: '#7A776D',
    accent: '#A69DFF',
    accentSoft: '#2A2650',
    onAccent: '#141412',
    ok: '#5FCB8A',
    warn: '#E0A64A',
    danger: '#FF8A7A',
    btnBg: '#F1EFE8',
    btnFg: '#141412',
  },
}

/** One step of the type scale. Sizes and line heights are in px; tracking in em. */
export interface TypeStep {
  size: number
  line: number
  weight: number
  tracking: number
}

/**
 * The type scale. Geist for text, Geist Mono for code; the `h1` and the lead are one step
 * smaller below 640 px (`styles.css`).
 */
export const TYPE: Record<string, TypeStep> = {
  display: { size: 64, line: 67, weight: 600, tracking: -0.035 },
  h1: { size: 40, line: 48, weight: 600, tracking: -0.03 },
  lead: { size: 18, line: 28, weight: 400, tracking: -0.005 },
  h2: { size: 26, line: 34, weight: 600, tracking: -0.02 },
  h3: { size: 20, line: 28, weight: 600, tracking: -0.012 },
  h4: { size: 15, line: 22, weight: 600, tracking: 0 },
  body: { size: 16, line: 28, weight: 400, tracking: 0 },
  small: { size: 14, line: 20, weight: 450, tracking: 0 },
  code: { size: 13.5, line: 22, weight: 400, tracking: 0 },
}

/** Corner radii: inputs and chips, buttons and code blocks, cards and the search results. */
export const RADIUS = { sm: 6, md: 10, lg: 16 } as const

/** The 4 px spacing scale. */
export const SPACE = [4, 8, 12, 16, 24, 32, 48, 64, 96] as const

/** Warm, ink-tinted shadows; in dark mode a hairline ring replaces most of the elevation. */
export const SHADOWS = {
  light: {
    sh1: '0 1px 2px rgb(26 26 24 / 0.06)',
    sh2: '0 1px 2px rgb(26 26 24 / 0.05), 0 8px 24px rgb(26 26 24 / 0.08)',
    sh3: '0 24px 64px rgb(26 26 24 / 0.18)',
  },
  dark: {
    sh1: '0 0 0 1px #34332E',
    sh2: '0 0 0 1px #34332E, 0 8px 24px rgb(0 0 0 / 0.4)',
    sh3: '0 0 0 1px #34332E, 0 24px 64px rgb(0 0 0 / 0.5)',
  },
} as const

/**
 * Motion. Only `opacity`, `transform`, `background-color` and `border-color` ever animate, and
 * nothing does under `prefers-reduced-motion`.
 */
export const MOTION = {
  ease: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
  fast: '120ms',
  base: '180ms',
  slow: '240ms',
} as const

/** The width of the shell, of a page's prose and of the columns around it, in px. */
export const LAYOUT = {
  shell: 1480,
  prose: 720,
  sidebar: 264,
  toc: 232,
} as const

/** A pair the site draws: its text (or control edge) colour on its background. */
export interface ColorPair {
  /** The role of the foreground, a key of {@link ColorScheme}. */
  fg: keyof ColorScheme
  /** The role of the background. */
  bg: keyof ColorScheme
  /** The ratio it must reach: 4.5 for text, 3 for a control's edge or a focus ring. */
  min: 4.5 | 3
  /** Where the site draws it. */
  use: string
}

/**
 * Every combination of the site's colours that is drawn as text or as the edge of a control.
 * `contrast.test.ts` measures each in both schemes; a new combination in the stylesheet is
 * added here in the same change.
 */
export const COLOR_PAIRS: readonly ColorPair[] = [
  { fg: 'ink', bg: 'bg', min: 4.5, use: 'headings' },
  { fg: 'ink', bg: 'surface', min: 4.5, use: 'table heads, cards' },
  { fg: 'ink', bg: 'raised', min: 4.5, use: 'inputs, search results' },
  { fg: 'ink', bg: 'accentSoft', min: 4.5, use: 'the current page of the sidebar' },
  { fg: 'body', bg: 'bg', min: 4.5, use: 'paragraphs' },
  { fg: 'body', bg: 'surface', min: 4.5, use: 'callouts, table cells, inline code' },
  { fg: 'body', bg: 'raised', min: 4.5, use: 'search results' },
  { fg: 'muted', bg: 'bg', min: 4.5, use: 'the lead, idle navigation, captions' },
  { fg: 'muted', bg: 'surface', min: 4.5, use: 'captions on a card, the docs chip' },
  { fg: 'muted', bg: 'raised', min: 4.5, use: 'search result paths' },
  { fg: 'muted', bg: 'accentSoft', min: 4.5, use: 'a hovered or current table of contents entry' },
  { fg: 'faint', bg: 'bg', min: 4.5, use: 'metadata, the search hint' },
  { fg: 'faint', bg: 'surface', min: 4.5, use: 'metadata on a card' },
  { fg: 'faint', bg: 'raised', min: 4.5, use: 'placeholders' },
  { fg: 'accent', bg: 'bg', min: 4.5, use: 'links' },
  { fg: 'accent', bg: 'surface', min: 4.5, use: 'links in a callout' },
  { fg: 'accent', bg: 'raised', min: 4.5, use: 'links in the search results' },
  { fg: 'accent', bg: 'accentSoft', min: 4.5, use: 'the current tab' },
  { fg: 'onAccent', bg: 'accent', min: 4.5, use: 'a solid accent button' },
  { fg: 'btnFg', bg: 'btnBg', min: 4.5, use: 'the primary button' },
  { fg: 'ok', bg: 'bg', min: 4.5, use: 'a success note' },
  { fg: 'ok', bg: 'surface', min: 4.5, use: 'a success callout' },
  { fg: 'warn', bg: 'bg', min: 4.5, use: 'a caution note' },
  { fg: 'warn', bg: 'surface', min: 4.5, use: 'a caution callout' },
  { fg: 'danger', bg: 'bg', min: 4.5, use: 'an error note' },
  { fg: 'danger', bg: 'surface', min: 4.5, use: 'a danger callout' },
  { fg: 'borderStrong', bg: 'bg', min: 3, use: 'the edge of a control' },
  { fg: 'borderStrong', bg: 'raised', min: 3, use: 'the edge of the search box' },
  { fg: 'accent', bg: 'bg', min: 3, use: 'the focus ring on the page' },
  { fg: 'accent', bg: 'surface', min: 3, use: 'the focus ring on a card or code block' },
]
