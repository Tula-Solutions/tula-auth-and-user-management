import { parseArgs } from 'node:util'
import { createContainer } from '~/container'
import { loadEnv } from '~/env'
import { systemActor } from '~/lib/actor'
import * as ControlPlane from '~/modules/control-plane/service'
import * as Project from '~/modules/project/service'

// Bootstrap for a conformance run that goes through several environments at once
// (`CONFORMANCE_ENVIRONMENTS`, conformance/README.md): scenarios change an environment's
// settings and put them back, so two of them can run side by side only in environments of
// their own. This makes a workspace with `--count` projects and mints a publishable and a
// secret key for the development environment of each, through the same service functions the
// API uses. One line per environment goes to stdout, `<publishable key>:<secret key>`, in
// the form CONFORMANCE_ENVIRONMENTS takes. Test deployments only: the keys are printed once.
//
//   bun run src/scripts/create-environments.ts --count 7

function fail(message: string): never {
  process.stderr.write(`create-environments: ${message}\n`)
  process.exit(1)
}

const { values } = parseArgs({ options: { count: { type: 'string' } } })
const count = Number(values.count)
if (!Number.isInteger(count) || count < 1 || count > 50) {
  fail('pass --count <1 to 50>')
}

const container = createContainer(loadEnv())
try {
  const actor = systemActor()
  const workspace = await ControlPlane.createWorkspace(
    container.deps,
    { name: 'Conformance' },
    actor
  )
  for (let index = 1; index <= count; index += 1) {
    const { environments } = await ControlPlane.createProject(
      container.deps,
      { workspaceId: workspace.id, name: `Conformance environment ${index}` },
      actor
    )
    const environment = environments.find(({ kind }) => kind === 'development')
    if (!environment) {
      fail('a new project has no development environment')
    }
    const tenant = { projectId: environment.projectId, environmentId: environment.id }
    const publishable = await Project.createApiKey(
      container.deps,
      tenant,
      { kind: 'publishable', name: `Conformance ${index}` },
      actor
    )
    const secret = await Project.createApiKey(
      container.deps,
      tenant,
      { kind: 'secret', name: `Conformance ${index}` },
      actor
    )
    process.stdout.write(`${publishable.key}:${secret.key}\n`)
  }
} finally {
  await container.close()
}
