import { join } from 'node:path'
// One renderer for both halves of the API: the client half is @tula/core's, the admin half is
// this package's. It lives with core because core had it first; it is a build script, not part
// of either package's published sources.
import { type OpenApiDocument, renderAdminApi } from '../../core/scripts/openapi-types'

// Writes src/generated/api.gen.ts from the contract's OpenAPI snapshot. `--check` fails instead
// of writing when the committed file is out of date (part of `bun run verify`), so the admin
// client's types can never drift from the API it calls.
const source = join(import.meta.dir, '../../contract/openapi.json')
const target = join(import.meta.dir, '../src/generated/api.gen.ts')
const label = 'packages/admin/src/generated/api.gen.ts'

const rendered = renderAdminApi((await Bun.file(source).json()) as OpenApiDocument)

if (process.argv.includes('--check')) {
  const file = Bun.file(target)
  if (!(await file.exists()) || (await file.text()) !== rendered) {
    process.stderr.write(`${label} is out of date: run \`bun run admin:generate\`\n`)
    process.exit(1)
  }
  process.stdout.write(`${label} is up to date\n`)
} else {
  await Bun.write(target, rendered)
  process.stdout.write(`wrote ${label}\n`)
}
