import { join } from 'node:path'
import {
  DEFAULT_THEME,
  darkCssVariable,
  THEME_TOKENS,
  type ThemeScheme,
} from '@tula/contract/theme'

// Writes the stylesheet's token block from the contract's theme, so the CSS defaults cannot
// drift from the defaults every other platform generates from the same table.
//
//   bun run --filter @tula/react generate         rewrite the block in src/styles.css
//   bun run --filter @tula/react generate:check   fail if it is out of date (part of verify)
//
// How the block works. An app sets the public properties (`--tula-color-primary`,
// `--tula-dark-color-primary`, `--tula-radius`, …) anywhere above a component, or through the
// `appearance` prop, which writes them inline. The components' rules only read the private
// `--_tula-*` properties, which resolve here to the public one for the active scheme or to
// the default. Light and dark have separate public properties so that both can be set in one
// place, an inline style included, with no media query.

const START =
  '/* tokens:start (generated from @tula/contract/theme by `bun run generate`; do not edit) */'
const END = '/* tokens:end */'

function privateName(cssVariable: string): string {
  return `--_${cssVariable.slice(2)}`
}

function declarations(scheme: 'light' | 'dark', indent: string): string {
  const values: ThemeScheme = DEFAULT_THEME[scheme]
  const lines = [`${indent}color-scheme: ${scheme};`]
  for (const token of THEME_TOKENS) {
    if (token.scope === 'scheme') {
      const source = scheme === 'dark' ? darkCssVariable(token.cssVariable) : token.cssVariable
      const fallback = values[token.key as keyof ThemeScheme]
      lines.push(`${indent}${privateName(token.cssVariable)}: var(${source}, ${fallback});`)
    } else if (scheme === 'light') {
      const fallback = DEFAULT_THEME[token.key as 'radius']
      lines.push(
        `${indent}${privateName(token.cssVariable)}: var(${token.cssVariable}, ${fallback});`
      )
    }
  }
  return lines.join('\n')
}

/** @returns The generated block, markers included. */
export function tokenBlock(): string {
  return [
    START,
    ':where(.tula-root) {',
    declarations('light', '  '),
    '}',
    '',
    '@media (prefers-color-scheme: dark) {',
    '  :where(.tula-root:not([data-tula-theme="light"], [data-tula-theme="light"] *)) {',
    declarations('dark', '    '),
    '  }',
    '}',
    '',
    ':where(.tula-root[data-tula-theme="dark"], [data-tula-theme="dark"] .tula-root) {',
    declarations('dark', '  '),
    '}',
    END,
  ].join('\n')
}

function blockOf(stylesheet: string): { start: number; end: number } {
  const start = stylesheet.indexOf(START)
  const end = stylesheet.indexOf(END)
  if (start === -1 || end === -1) {
    throw new Error('styles.css: the tokens:start / tokens:end markers are missing')
  }
  return { start, end: end + END.length }
}

/**
 * @param stylesheet - The stylesheet's text.
 * @returns The text with its token block replaced by the current one.
 * @throws Error when the markers are missing.
 */
export function withTokenBlock(stylesheet: string): string {
  const { start, end } = blockOf(stylesheet)
  return `${stylesheet.slice(0, start)}${tokenBlock()}${stylesheet.slice(end)}`
}

/** Biome wraps long declarations; the comparison ignores how the block is laid out. */
function normalized(css: string): string {
  return css.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim()
}

/**
 * @param stylesheet - The stylesheet's text.
 * @returns Whether its token block declares exactly what the contract's theme says.
 * @throws Error when the markers are missing.
 */
export function tokenBlockIsCurrent(stylesheet: string): boolean {
  const { start, end } = blockOf(stylesheet)
  return normalized(stylesheet.slice(start, end)) === normalized(tokenBlock())
}

if (import.meta.main) {
  const path = join(import.meta.dir, '..', 'src', 'styles.css')
  const current = await Bun.file(path).text()
  if (process.argv.includes('--check')) {
    if (!tokenBlockIsCurrent(current)) {
      console.error(
        'src/styles.css is out of date with @tula/contract/theme: run `bun run --filter @tula/react generate`'
      )
      process.exit(1)
    }
    console.log('src/styles.css matches @tula/contract/theme')
  } else if (tokenBlockIsCurrent(current)) {
    console.log('src/styles.css already up to date')
  } else {
    await Bun.write(path, withTokenBlock(current))
    // The repository's formatter decides the layout (it wraps long values).
    const format = Bun.spawnSync(['bunx', 'biome', 'format', '--write', path], { timeout: 60_000 })
    if (format.exitCode !== 0) {
      console.error(format.stderr.toString())
      process.exit(1)
    }
    console.log('src/styles.css updated')
  }
}
