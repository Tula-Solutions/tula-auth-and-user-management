import { join } from 'node:path'
import { z } from 'zod'
import { ScenarioSchema } from '../scenario'

// Writes /conformance/scenario.schema.json from the Zod schema, so SDK test suites in other
// languages (and editors) validate scenarios against the same definition. `--check` fails
// instead of writing when the committed file is out of date.
const path = join(import.meta.dir, '../../../../conformance/scenario.schema.json')
const schema = JSON.parse(JSON.stringify(z.toJSONSchema(ScenarioSchema, { io: 'input' })))

if (process.argv.includes('--check')) {
  const file = Bun.file(path)
  // Compared as data, not text: the formatter owns the file's layout.
  if (!(await file.exists()) || !Bun.deepEquals(await file.json(), schema, true)) {
    process.stderr.write(
      'conformance/scenario.schema.json is out of date: run `bun run --filter @tula/conformance schema:generate`\n'
    )
    process.exit(1)
  }
  process.stdout.write('conformance/scenario.schema.json is up to date\n')
} else {
  await Bun.write(path, `${JSON.stringify(schema, null, 2)}\n`)
  process.stdout.write(`wrote ${path}\n`)
}
