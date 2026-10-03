import { join } from 'node:path'
import { type OpenApiDocument, renderClientApi } from './openapi-types'

// Writes src/generated/api.gen.ts from the contract's OpenAPI snapshot. `--check` fails instead
// of writing when the committed file is out of date (part of `bun run verify`), so the SDK's
// types can never drift from the API it calls.
const source = join(import.meta.dir, '../../contract/openapi.json')
const target = join(import.meta.dir, '../src/generated/api.gen.ts')
const label = 'packages/core/src/generated/api.gen.ts'

const rendered = renderClientApi((await Bun.file(source).json()) as OpenApiDocument)

if (process.argv.includes('--check')) {
  const file = Bun.file(target)
  if (!(await file.exists()) || (await file.text()) !== rendered) {
    process.stderr.write(`${label} is out of date: run \`bun run --filter @tula/core generate\`\n`)
    process.exit(1)
  }
  process.stdout.write(`${label} is up to date\n`)
} else {
  await Bun.write(target, rendered)
  process.stdout.write(`wrote ${label}\n`)
}
