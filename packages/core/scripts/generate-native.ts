import { dirname, join } from 'node:path'
import { ERROR_DEFINITIONS } from '@tula/contract/error-codes'
import { DEFAULT_THEME, THEME_TOKENS } from '@tula/contract/theme'
import { KOTLIN_DIRECTORY, renderNativeFiles, SWIFT_DIRECTORY } from './native/index'
import { syncGenerated } from './native/tree'
import type { OpenApiDocument } from './openapi-types'

// Writes the generated Swift and Kotlin sources of the native SDKs (ADR 0050) from the
// contract's OpenAPI snapshot, its error codes and its default theme.
//
//   bun run native:generate   rewrite the two generated directories under native/
//   bun run native:check      fail if they are out of date (part of `bun run verify`)
//
// The two directories are generated whole: whatever is in one that the generator does not
// write (a file, a `.DS_Store`, a directory, a symbolic link) is removed by the first
// command and reported by the second (`./native/tree.ts`, which has the tests).
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

const check = process.argv.includes('--check')
const result = await syncGenerated(
  root,
  [SWIFT_DIRECTORY, KOTLIN_DIRECTORY],
  files,
  check ? 'check' : 'write'
)
const stream = result.ok ? process.stdout : process.stderr
stream.write(`${result.lines.join('\n')}\n`)
if (!result.ok) {
  process.exit(1)
}
