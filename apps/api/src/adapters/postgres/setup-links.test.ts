import { afterAll, beforeAll, expect, test } from 'bun:test'
import { organizations, setupLinks, withTenant } from '@tula-tech/db'
import { createTestDatabase, createTestTenant, type TestDatabase } from '@tula-tech/db/testing'
import { and, eq } from 'drizzle-orm'
import { PostgresActivityLog } from '~/adapters/postgres/activity'
import { PostgresSetupLinkStore } from '~/adapters/postgres/setup-links'
import {
  describeSetupLinkStore,
  type SetupLinkSuiteTenant,
} from '~/adapters/setup-link-store.suite'

// PGlite: real Postgres with every migration, connected as the runtime role (RLS applies).
let testDb: TestDatabase

beforeAll(async () => {
  testDb = await createTestDatabase()
})

afterAll(() => testDb.close())

async function organization(tenant: SetupLinkSuiteTenant): Promise<string> {
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
}

describeSetupLinkStore('Postgres', async () => {
  const a = await createTestTenant(testDb.db)
  const b = await createTestTenant(testDb.db, 'production')
  const log = new PostgresActivityLog(testDb.db)
  return {
    store: new PostgresSetupLinkStore(testDb.db),
    recorded: async () =>
      (await log.listAudit(a.environmentId, { page: 1, size: 50 })).entries
        .map((entry) => entry.type)
        .reverse(),
    organization,
    deleteOrganization: async (tenant: SetupLinkSuiteTenant, id: string) => {
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

test('row-level security hides another environment’s setup link from a direct query', async () => {
  const a = await createTestTenant(testDb.db)
  const b = await createTestTenant(testDb.db, 'production')
  const organizationId = await organization(a)
  await withTenant(testDb.db, a.environmentId, (tx) =>
    tx.insert(setupLinks).values({
      id: Bun.randomUUIDv7(),
      projectId: a.projectId,
      environmentId: a.environmentId,
      organizationId,
      name: 'SSO setup',
      prefix: 'tula_setup_',
      tokenHash: 'hash',
      expiresAt: new Date(),
      createdByType: 'admin',
    })
  )
  expect(
    await withTenant(testDb.db, b.environmentId, (tx) => tx.select().from(setupLinks))
  ).toEqual([])
  expect(await testDb.db.select().from(setupLinks)).toEqual([])
})
