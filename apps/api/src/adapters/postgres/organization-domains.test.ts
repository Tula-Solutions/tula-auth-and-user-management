import { afterAll, beforeAll } from 'bun:test'
import { organizations, withTenant } from '@tula-tech/db'
import { createTestDatabase, createTestTenant, type TestDatabase } from '@tula-tech/db/testing'
import { and, eq } from 'drizzle-orm'
import { describeOrganizationDomainStore } from '~/adapters/organization-domain-store.suite'
import { PostgresActivityLog } from '~/adapters/postgres/activity'
import { PostgresOrganizationDomainStore } from '~/adapters/postgres/organization-domains'

// PGlite: real Postgres with every migration, connected as the runtime role (RLS applies).
let testDb: TestDatabase

beforeAll(async () => {
  testDb = await createTestDatabase()
})

afterAll(() => testDb.close())

describeOrganizationDomainStore('Postgres', async () => {
  const a = await createTestTenant(testDb.db)
  const b = await createTestTenant(testDb.db, 'production')
  const log = new PostgresActivityLog(testDb.db)
  return {
    store: new PostgresOrganizationDomainStore(testDb.db),
    recorded: async () =>
      (await log.listAudit(a.environmentId, { page: 1, size: 50 })).entries
        .map((entry) => entry.type)
        .reverse(),
    organization: async (tenant) => {
      const id = Bun.randomUUIDv7()
      await withTenant(testDb.db, tenant.environmentId, (tx) =>
        tx.insert(organizations).values({
          id,
          projectId: tenant.projectId,
          environmentId: tenant.environmentId,
          name: 'Acme',
          slug: `acme-${id.slice(-8)}`,
        })
      )
      return id
    },
    deleteOrganization: async (tenant, id) => {
      await withTenant(testDb.db, tenant.environmentId, (tx) =>
        tx
          .delete(organizations)
          .where(
            and(eq(organizations.id, id), eq(organizations.environmentId, tenant.environmentId))
          )
      )
    },
    a: { projectId: a.projectId, environmentId: a.environmentId },
    b: { projectId: b.projectId, environmentId: b.environmentId },
  }
})
