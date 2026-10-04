import { join } from 'node:path'
import { DEFAULT_THEME } from '@tula/contract/theme'

// Regenerates everything in this package that a generator owns:
//   1. src/api/generated/api.gen.ts  Orval's hooks and types, from the contract's openapi.json
//   2. src/routeTree.gen.ts          TanStack Router's route tree, from src/routes
//   3. src/styles/tokens.gen.css     the product's colours, from @tula/contract/theme
//
//   bun run dashboard:generate          rewrite them
//   bun run generate:check              fail when a committed file is out of date (verify)

const root = join(import.meta.dir, '..')
const GENERATED = [
  'src/api/generated/api.gen.ts',
  'src/routeTree.gen.ts',
  'src/styles/tokens.gen.css',
] as const

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

function block(selector: string, prefix: string, scheme: object, indent = ''): string {
  const lines = Object.entries(scheme).map(
    ([name, value]) => `${indent}  --tula-${prefix}${kebab(name)}: ${value};`
  )
  return `${indent}${selector} {\n${lines.join('\n')}\n${indent}}`
}

/**
 * The stylesheet of design tokens: the contract's default theme as CSS custom properties.
 * `--tula-*` follows the reader's colour scheme; `--tula-dark-*` is always the dark scheme
 * (the navigation is dark in both).
 *
 * @returns The file's contents.
 */
function tokensCss(): string {
  const { light, dark, ...rest } = DEFAULT_THEME
  return [
    '/* Generated from @tula/contract/theme by `bun run dashboard:generate`. Do not edit. */',
    block(':root', '', { ...light, ...rest }),
    block(':root', 'dark-', dark),
    `@media (prefers-color-scheme: dark) {\n${block(':root', '', dark, '  ')}\n}`,
    '',
  ].join('\n\n')
}

async function run(command: string[]): Promise<void> {
  // A generator that hangs must fail this script, not the run that called it.
  const child = Bun.spawn(command, {
    cwd: root,
    stdout: 'ignore',
    stderr: 'inherit',
    timeout: 120_000,
  })
  if ((await child.exited) !== 0) {
    throw new Error(`${command.join(' ')} failed`)
  }
}

async function read(path: string): Promise<string | null> {
  const file = Bun.file(join(root, path))
  return (await file.exists()) ? file.text() : null
}

async function generate(): Promise<void> {
  await run(['bunx', '--bun', 'orval', '--config', 'orval.config.ts'])
  await run(['bunx', '--bun', 'tsr', 'generate'])
  await Bun.write(join(root, 'src/styles/tokens.gen.css'), tokensCss())
}

if (process.argv.includes('--check')) {
  const before = await Promise.all(GENERATED.map(read))
  await generate()
  const after = await Promise.all(GENERATED.map(read))
  const stale = GENERATED.filter((_, index) => before[index] !== after[index])
  // Put back what was committed: a check must not leave the tree changed.
  await Promise.all(
    GENERATED.map((path, index) => {
      const content = before[index]
      return content === null || content === undefined
        ? Promise.resolve(0)
        : Bun.write(join(root, path), content)
    })
  )
  if (stale.length > 0) {
    console.error(`Out of date: ${stale.join(', ')}. Run \`bun run dashboard:generate\`.`)
    process.exit(1)
  }
  console.log('dashboard: generated files are up to date')
} else {
  await generate()
  console.log(`dashboard: wrote ${GENERATED.join(', ')}`)
}
