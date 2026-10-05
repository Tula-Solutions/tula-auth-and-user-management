import { createDatabase, type DatabaseHandle, users, withTenant, workspaces } from '@tula/db'
import { createTestTenant, type TestTenant } from '@tula/db/testing'
import { inArray } from 'drizzle-orm'

/** A tenant of an integration run: its ids and a way to add a user to it. */
export interface IntegrationTenant {
  projectId: string
  environmentId: string
  /** Insert a user with no password and an unverified address. */
  user: () => Promise<string>
}

/** Real Postgres for the `*.integration.ts` files of the stores. */
export interface IntegrationDatabase {
  /** The first API instance's pool, as the runtime login. */
  first: DatabaseHandle
  /** A second instance's pool: its connections are never the first one's. */
  second: DatabaseHandle
  /**
   * Create a workspace, project and environment, remembered for {@link close}.
   *
   * @param kind - The environment's kind (default `development`).
   * @returns The tenant.
   */
  tenant: (kind?: 'development' | 'production') => Promise<IntegrationTenant>
  /** Delete every tenant created here, then close both pools. */
  close: () => Promise<void>
}

/**
 * Open two pools on the Postgres of `docker compose up -d`, standing in for two API instances.
 *
 * Both connect as the runtime login (`DATABASE_URL`), so row-level security applies as it does
 * in the API. What a run creates is removed through the owner's login
 * (`DATABASE_MIGRATION_URL`): the runtime role has no `DELETE` on the control plane.
 *
 * @param poolSize - Connections per pool. More than one, so that calls a test starts together
 *   really run on separate sessions.
 * @returns The pools, a tenant factory and the cleanup.
 * @throws Error when either URL is missing: a silently skipped suite would look green.
 */
export function openIntegrationDatabase(poolSize = 4): IntegrationDatabase {
  const runtimeUrl = process.env.DATABASE_URL
  const migrationUrl = process.env.DATABASE_MIGRATION_URL
  if (!runtimeUrl || !migrationUrl) {
    throw new Error(
      'Integration tests need DATABASE_URL and DATABASE_MIGRATION_URL (see .env.example)'
    )
  }
  const first = createDatabase(runtimeUrl, { max: poolSize })
  const second = createDatabase(runtimeUrl, { max: poolSize })
  const created: TestTenant[] = []

  async function tenant(
    kind: 'development' | 'production' = 'development'
  ): Promise<IntegrationTenant> {
    const made = await createTestTenant(first.db, kind)
    created.push(made)
    const scope = { projectId: made.projectId, environmentId: made.environmentId }
    return {
      ...scope,
      user: () =>
        withTenant(first.db, made.environmentId, async (tx) => {
          const id = Bun.randomUUIDv7()
          await tx.insert(users).values({
            id,
            ...scope,
            email: `${id}@northline.app`,
            emailNormalized: `${id}@northline.app`,
          })
          return id
        }),
    }
  }

  async function close(): Promise<void> {
    await first.close()
    await second.close()
    if (created.length > 0) {
      const owner = createDatabase(migrationUrl as string, { max: 1 })
      try {
        // Deleting a workspace cascades to everything the run created under it.
        await owner.db.delete(workspaces).where(
          inArray(
            workspaces.id,
            created.map((made) => made.workspaceId)
          )
        )
      } finally {
        await owner.close()
      }
    }
  }

  return { first, second, tenant, close }
}
