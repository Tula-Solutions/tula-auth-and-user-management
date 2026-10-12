import { mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ERROR_DEFINITIONS } from '@tula/contract/error-codes'
import { DEFAULT_THEME, THEME_TOKENS } from '@tula/contract/theme'
import { KOTLIN_DIRECTORY, nativeDrift, renderNativeFiles, SWIFT_DIRECTORY } from './native/index'
import type { OpenApiDocument } from './openapi-types'

// Writes the generated Swift and Kotlin sources of the native SDKs (ADR 0050) from the
// contract's OpenAPI snapshot, its error codes and its default theme.
//
//   bun run native:generate   rewrite the two generated directories under native/
//   bun run native:check      fail if they are out of date (part of `bun run verify`)
//
// The two directories hold generated files and nothing else: a file the generator does not
// write is removed by the first command and reported by the second.
//
// The directory is named here, not only the repository's root: the guard of the Turborepo
// cache (.claude/hooks/turbo-inputs.test.ts) reads this path and holds `native/**` to be an
// input of this package's cached tasks, so that a hand edit under it runs the check again.
const root = dirname(join(import.meta.dir, '../../../native'))
const source = join(import.meta.dir, '../../contract/openapi.json')

const files = renderNativeFiles({
  document: (await Bun.file(source).json()) as OpenApiDocument,
  errorDefinitions: ERROR_DEFINITIONS,
  theme: { theme: DEFAULT_THEME, tokens: THEME_TOKENS },
})

async function existing(): Promise<Record<string, string>> {
  const found: Record<string, string> = {}
  for (const directory of [SWIFT_DIRECTORY, KOTLIN_DIRECTORY]) {
    const names = await readdir(join(root, directory)).catch(() => [])
    for (const name of names.sort()) {
      found[`${directory}/${name}`] = await Bun.file(join(root, directory, name)).text()
    }
  }
  return found
}

const drift = nativeDrift(files, await existing())

if (process.argv.includes('--check')) {
  if (drift.length > 0) {
    process.stderr.write(`${drift.join('\n')}\nrun \`bun run native:generate\`\n`)
    process.exit(1)
  }
  process.stdout.write(`${Object.keys(files).length} generated native files are up to date\n`)
} else {
  for (const line of drift) {
    const path = line.slice(0, line.indexOf(' is '))
    if (Object.hasOwn(files, path)) {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await Bun.write(join(root, path), files[path] as string)
      process.stdout.write(`wrote ${path}\n`)
    } else {
      await rm(join(root, path))
      process.stdout.write(`removed ${path}\n`)
    }
  }
  if (drift.length === 0) {
    process.stdout.write('the generated native files were already up to date\n')
  }
}
