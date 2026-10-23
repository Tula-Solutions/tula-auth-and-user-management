import { afterAll, beforeAll, expect, test } from 'bun:test'
import { testAddress } from '@tula-tech/contract'
import { organizations, users, withTenant } from '@tula-tech/db'
import {
  createTestDatabase,
  createTestTenant,
  type TestDatabase,
  type TestTenant,
} from '@tula-tech/db/testing'
import { eq } from 'drizzle-orm'
import { describeOrganizationStore, userDeletion } from '~/adapters/organization-store.suite'
import { PostgresActivityLog } from '~/adapters/postgres/activity'
import { PostgresOrganizationStore } from '~/adapters/postgres/organizations'
import { PostgresUserRepository } from '~/adapters/postgres/users'
import * as Audit from '~/modules/audit/service'

// PGlite: real Postgres with every migration, connected as the runtime role (RLS applies).
let testDb: TestDatabase

beforeAll(async () => {
  testDb = await createTestDatabase()
})

afterAll(() => testDb.close())

/** Fresh tenants per test: an environment has one organization per slug. */
async function tenants(): Promise<{ a: TestTenant; b: TestTenant }> {
  return {
    a: await createTestTenant(testDb.db),
    b: await createTestTenant(testDb.db, 'production'),
  }
}

describeOrganizationStore('Postgres', async () => {
  const { a, b } = await tenants()
  const log = new PostgresActivityLog(testDb.db)
  return {
    store: new PostgresOrganizationStore(testDb.db),
    recorded: async () =>
      (await log.listAudit(a.environmentId, { page: 1, size: 50 })).entries
        .map((entry) => entry.type)
        .reverse(),
    user: async (tenant) => {
      const id = Bun.randomUUIDv7()
      await withTenant(testDb.db, tenant.environmentId, (tx) =>
        tx
          .insert(users)
          .values({ id, projectId: tenant.projectId, environmentId: tenant.environmentId })
      )
      return id
    },
    deleteUser: (tenant, userId) =>
      new PostgresUserRepository(testDb.db).delete(
        tenant.environmentId,
        userId,
        Audit.none('fixture')
      ),
    testUser: async (tenant) => {
      const id = Bun.randomUUIDv7()
      const address = testAddress(id.replaceAll('-', ''))
      await new PostgresUserRepository(testDb.db).create(
        {
          id,
          projectId: tenant.projectId,
          environmentId: tenant.environmentId,
          email: address,
          emailNormalized: address,
          emailVerifiedAt: null,
          firstName: null,
          lastName: null,
          createdAt: new Date(0),
          identityId: Bun.randomUUIDv7(),
          credentialId: Bun.randomUUIDv7(),
          passwordHash: null,
        },
        Audit.none('fixture')
      )
      return id
    },
    purgeTestUsers: (tenant) =>
      new PostgresUserRepository(testDb.db).deleteTestUsersBefore(
        tenant.environmentId,
        new Date(Date.now() + 60_000),
        100,
        (userId) => userDeletion(tenant, userId)
      ),

    a: { projectId: a.projectId, environmentId: a.environmentId },
    b: { projectId: b.projectId, environmentId: b.environmentId },
  }
})

test('row-level security hides another environment’s organization even from a direct query', async () => {
  const { a, b } = await tenants()
  const store = new PostgresOrganizationStore(testDb.db)
  const at = new Date('2026-01-01T00:00:00.000Z')
  await store.insert(
    {
      id: Bun.randomUUIDv7(),
      projectId: a.projectId,
      environmentId: a.environmentId,
      name: 'Acme',
      slug: 'acme',
      createdBy: null,
      createdAt: at,
      updatedAt: at,
    },
    Audit.none('fixture')
  )
  const seen = await withTenant(testDb.db, b.environmentId, (tx) => tx.select().from(organizations))
  expect(seen).toEqual([])
  expect(
    await testDb.db
      .select()
      .from(organizations)
      .where(eq(organizations.environmentId, a.environmentId))
  ).toEqual([])
})
