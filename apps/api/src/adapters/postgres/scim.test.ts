import { afterAll, beforeAll, expect, test } from 'bun:test'
import { organizations, scimGroups, scimTokens, users, withTenant } from '@tula-tech/db'
import { createTestDatabase, createTestTenant, type TestDatabase } from '@tula-tech/db/testing'
import { and, eq } from 'drizzle-orm'
import { PostgresActivityLog } from '~/adapters/postgres/activity'
import { PostgresScimStore } from '~/adapters/postgres/scim'
import { describeScimStore, type ScimSuiteTenant } from '~/adapters/scim-store.suite'

// PGlite: real Postgres with every migration, connected as the runtime role (RLS applies).
let testDb: TestDatabase

beforeAll(async () => {
  testDb = await createTestDatabase()
})

afterAll(() => testDb.close())

async function organization(tenant: ScimSuiteTenant): Promise<string> {
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

describeScimStore('Postgres', async () => {
  const a = await createTestTenant(testDb.db)
  const b = await createTestTenant(testDb.db, 'production')
  const log = new PostgresActivityLog(testDb.db)
  return {
    store: new PostgresScimStore(testDb.db),
    recorded: async () =>
      (await log.listAudit(a.environmentId, { page: 1, size: 50 })).entries
        .map((entry) => entry.type)
        .reverse(),
    organization,
    deleteOrganization: async (tenant: ScimSuiteTenant, id: string) => {
      await withTenant(testDb.db, tenant.environmentId, (tx) =>
        tx
          .delete(organizations)
          .where(
            and(eq(organizations.id, id), eq(organizations.environmentId, tenant.environmentId))
          )
      )
    },
    user: (tenant: ScimSuiteTenant) =>
      withTenant(testDb.db, tenant.environmentId, async (tx) => {
        const id = Bun.randomUUIDv7()
        await tx.insert(users).values({
          id,
          projectId: tenant.projectId,
          environmentId: tenant.environmentId,
          email: `${id}@acme.test`,
          emailNormalized: `${id}@acme.test`,
        })
        return id
      }),
    a: { projectId: a.projectId, environmentId: a.environmentId },
    b: { projectId: b.projectId, environmentId: b.environmentId },
  }
})

test('row-level security hides another environment’s SCIM token from a direct query', async () => {
  const a = await createTestTenant(testDb.db)
  const b = await createTestTenant(testDb.db, 'production')
  const organizationId = await organization(a)
  await withTenant(testDb.db, a.environmentId, (tx) =>
    tx.insert(scimTokens).values({
      id: Bun.randomUUIDv7(),
      projectId: a.projectId,
      environmentId: a.environmentId,
      organizationId,
      name: 'Okta',
      prefix: 'tula_scim_dev',
      tokenHash: 'hash',
    })
  )
  expect(
    await withTenant(testDb.db, b.environmentId, (tx) => tx.select().from(scimTokens))
  ).toEqual([])
  expect(await testDb.db.select().from(scimTokens)).toEqual([])
})

test('row-level security hides another environment’s SCIM group from a direct query', async () => {
  const a = await createTestTenant(testDb.db)
  const b = await createTestTenant(testDb.db, 'production')
  const organizationId = await organization(a)
  await withTenant(testDb.db, a.environmentId, (tx) =>
    tx.insert(scimGroups).values({
      id: Bun.randomUUIDv7(),
      projectId: a.projectId,
      environmentId: a.environmentId,
      organizationId,
      displayName: 'Engineering',
    })
  )
  expect(
    await withTenant(testDb.db, b.environmentId, (tx) => tx.select().from(scimGroups))
  ).toEqual([])
  expect(await testDb.db.select().from(scimGroups)).toEqual([])
})
