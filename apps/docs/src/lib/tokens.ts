import { DEFAULT_THEME } from '@tula-tech/contract/theme'

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

function declarations(prefix: string, scheme: object): string {
  return Object.entries(scheme)
    .map(([name, value]) => `  --tula-${prefix}${kebab(name)}: ${value};`)
    .join('\n')
}

/**
 * The product's colours and type as CSS custom properties, from `@tula-tech/contract/theme`.
 *
 * Light is the default; dark applies when the reader's system asks for it, unless the page was
 * set to light, and always when the page was set to dark (`data-theme` on the root). The
 * site therefore needs no colour of its own: it shares the palette of the sign-in components
 * and the dashboard.
 *
 * @returns A stylesheet.
 */
export function tokensCss(): string {
  const { light, dark, ...rest } = DEFAULT_THEME
  const darkBlock = declarations('', dark)
  return [
    '/* Generated from @tula-tech/contract/theme at build time. */',
    `:root {\n${declarations('', { ...light, ...rest })}\n}`,
    `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme='light']) {\n${darkBlock.replace(/^/gm, '  ')}\n  }\n}`,
    `:root[data-theme='dark'] {\n${darkBlock}\n}`,
    '',
  ].join('\n\n')
}
