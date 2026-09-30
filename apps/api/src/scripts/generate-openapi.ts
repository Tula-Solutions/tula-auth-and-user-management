import { resolve } from 'node:path'

// Writes the OpenAPI snapshot every SDK is generated from; `--check` fails on drift instead (CI).
// Uses test deps because the document depends only on routes, never on data or config.
// The logger reads LOG_LEVEL when first imported, so silence it before loading the app.
process.env.LOG_LEVEL = 'silent'
const { createApp, OPENAPI_PATH } = await import('~/index')
const { createTestDeps } = await import('~/testing')

const target = resolve(import.meta.dir, '../../../../packages/contract/openapi.json')
const response = await createApp(createTestDeps()).request(OPENAPI_PATH)
if (!response.ok) {
  process.stderr.write(`contract: ${OPENAPI_PATH} returned ${response.status}\n`)
  process.exit(1)
}
const next = `${JSON.stringify(await response.json(), null, 2)}\n`
const file = Bun.file(target)

if (process.argv.includes('--check')) {
  const current = (await file.exists()) ? await file.text() : ''
  if (current !== next) {
    process.stderr.write(
      'contract: packages/contract/openapi.json is out of date. Run `bun run contract:generate`.\n'
    )
    process.exit(1)
  }
  process.stdout.write('contract: openapi.json is up to date\n')
} else {
  await Bun.write(target, next)
  process.stdout.write(`contract: wrote ${target}\n`)
}
