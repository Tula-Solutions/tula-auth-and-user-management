import {
  COLORS,
  type ColorScheme,
  LAYOUT,
  MOTION,
  RADIUS,
  SHADOWS,
  SPACE,
  TYPE,
} from './design-tokens'

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

/** A px size as rem, so that the reader's own text size scales the whole site. */
function rem(px: number): string {
  return `${Number((px / 16).toFixed(4))}rem`
}

function colors(scheme: ColorScheme): string {
  return Object.entries(scheme)
    .map(([role, value]) => `  --${kebab(role)}: ${value};`)
    .join('\n')
}

function shadows(scheme: Record<string, string>): string {
  return Object.entries(scheme)
    .map(([name, value]) => `  --${name.replace(/(\d)/, '-$1')}: ${value};`)
    .join('\n')
}

function scale(): string {
  const lines: string[] = []
  for (const [name, step] of Object.entries(TYPE)) {
    lines.push(
      `  --fs-${name}: ${rem(step.size)};`,
      `  --lh-${name}: ${rem(step.line)};`,
      `  --fw-${name}: ${step.weight};`,
      `  --ls-${name}: ${step.tracking}em;`
    )
  }
  return lines.join('\n')
}

/**
 * The site's design tokens as CSS custom properties, from `design-tokens.ts`.
 *
 * Light is the default; dark applies when the reader's system asks for it, unless the page was
 * set to light, and always when the page was set to dark (`data-theme` on the root). Colours,
 * shadows, radii, the type scale, motion and the layout's widths are written here and
 * referenced by name in `styles.css`: no colour there is a literal.
 *
 * @returns A stylesheet.
 */
export function tokensCss(): string {
  const shared = [
    scale(),
    ...Object.entries(RADIUS).map(([name, px]) => `  --r-${name}: ${px}px;`),
    ...SPACE.map((px) => `  --space-${px}: ${rem(px)};`),
    `  --ease: ${MOTION.ease};`,
    `  --dur-fast: ${MOTION.fast};`,
    `  --dur-base: ${MOTION.base};`,
    `  --dur-slow: ${MOTION.slow};`,
    `  --shell: ${LAYOUT.shell}px;`,
    `  --prose: ${LAYOUT.prose}px;`,
    `  --sidebar: ${LAYOUT.sidebar}px;`,
    `  --toc: ${LAYOUT.toc}px;`,
  ].join('\n')
  const dark = `${colors(COLORS.dark)}\n${shadows(SHADOWS.dark)}`
  return [
    '/* Generated from src/lib/design-tokens.ts at build time. */',
    `:root {\n${colors(COLORS.light)}\n${shadows(SHADOWS.light)}\n${shared}\n}`,
    `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme='light']) {\n${dark.replace(/^/gm, '  ')}\n  }\n}`,
    `:root[data-theme='dark'] {\n${dark}\n}`,
    '',
  ].join('\n\n')
}
