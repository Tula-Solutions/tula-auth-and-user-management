import { join } from 'node:path'
import { z } from 'zod'
import { ClientJourneysSchema } from '../client-journeys'
import { ScenarioSchema } from '../scenario'

// Writes the JSON Schemas in /conformance from the Zod schemas, so SDK test suites in other
// languages (and editors) validate the scenarios and the client-journey list against the
// same definitions. `--check` fails instead of writing when a committed file is out of date.
const SCHEMAS: [file: string, schema: z.ZodType][] = [
  ['scenario.schema.json', ScenarioSchema],
  ['client-journeys.schema.json', ClientJourneysSchema],
]
const check = process.argv.includes('--check')
let stale = false

for (const [name, source] of SCHEMAS) {
  const path = join(import.meta.dir, '../../../../conformance', name)
  const schema = JSON.parse(JSON.stringify(z.toJSONSchema(source, { io: 'input' })))
  if (!check) {
    await Bun.write(path, `${JSON.stringify(schema, null, 2)}\n`)
    process.stdout.write(`wrote ${path}\n`)
    continue
  }
  const file = Bun.file(path)
  // Compared as data, not text: the formatter owns the file's layout.
  if ((await file.exists()) && Bun.deepEquals(await file.json(), schema, true)) {
    process.stdout.write(`conformance/${name} is up to date\n`)
  } else {
    stale = true
    process.stderr.write(
      `conformance/${name} is out of date: run \`bun run --filter @tula/conformance schema:generate\`\n`
    )
  }
}

if (stale) {
  process.exit(1)
}
