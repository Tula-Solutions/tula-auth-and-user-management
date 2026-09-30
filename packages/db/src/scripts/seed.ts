import { and, eq } from 'drizzle-orm'
import { createDatabase } from '../client'
import { environments, projects, workspaces } from '../schema'

// Local bootstrap: one workspace, a default project and its development + production
// environments. Idempotent. API keys are created through the API (Step 5), not here.
const url = process.env.DATABASE_URL
if (!url) {
  process.stderr.write('seed: set DATABASE_URL\n')
  process.exit(1)
}

const { db, close } = createDatabase(url, { max: 1 })
try {
  const workspace =
    (await db.query.workspaces.findFirst({ where: eq(workspaces.name, 'Local') })) ??
    (await db.insert(workspaces).values({ name: 'Local' }).returning())[0]!
  const project =
    (await db.query.projects.findFirst({
      where: and(eq(projects.workspaceId, workspace.id), eq(projects.name, 'Default project')),
    })) ??
    (
      await db
        .insert(projects)
        .values({ workspaceId: workspace.id, name: 'Default project' })
        .returning()
    )[0]!
  for (const kind of ['development', 'production'] as const) {
    await db.insert(environments).values({ projectId: project.id, kind }).onConflictDoNothing()
  }
  const envs = await db.query.environments.findMany({
    where: eq(environments.projectId, project.id),
  })
  process.stdout.write(`seed: workspace ${workspace.id}\nseed: project ${project.id}\n`)
  for (const env of envs) {
    process.stdout.write(`seed: ${env.kind} environment ${env.id}\n`)
  }
} finally {
  await close()
}
