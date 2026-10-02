import { parseArgs } from 'node:util'
import { createContainer } from '~/container'
import { loadEnv } from '~/env'
import { systemActor } from '~/lib/actor'
import * as Project from '~/modules/project/service'

// Bootstrap: admin routes need a secret key, and keys are minted by admin routes. This mints the
// first one through the same service function the API uses. The key is printed once, to stdout.
//
//   bun run api-key:create --environment <uuid> [--kind secret|publishable] [--name "Backend"]

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function fail(message: string): never {
  process.stderr.write(`api-key:create: ${message}\n`)
  process.exit(1)
}

const { values } = parseArgs({
  options: {
    environment: { type: 'string' },
    kind: { type: 'string', default: 'secret' },
    name: { type: 'string', default: 'Bootstrap key' },
  },
})
if (!values.environment || !UUID.test(values.environment)) {
  fail('pass --environment <uuid> (`bun run seed` prints the environment ids)')
}
if (values.kind !== 'secret' && values.kind !== 'publishable') {
  fail('--kind must be secret or publishable')
}
const name = values.name.trim()
if (name.length < 1 || name.length > 100) {
  fail('--name must be 1 to 100 characters')
}

const container = createContainer(loadEnv())
try {
  const environment = await container.deps.environments.findById(values.environment)
  if (!environment) {
    fail(`no environment ${values.environment}`)
  }
  const created = await Project.createApiKey(
    container.deps,
    { projectId: environment.projectId, environmentId: environment.id },
    { kind: values.kind, name },
    // Run by an operator with database access, not through the API: there is no key to name.
    systemActor()
  )
  process.stderr.write(
    `api-key:create: ${created.kind} key "${created.name}" (${created.id}) for the ${environment.kind} environment. It is shown only once:\n`
  )
  process.stdout.write(`${created.key}\n`)
} finally {
  await container.close()
}
