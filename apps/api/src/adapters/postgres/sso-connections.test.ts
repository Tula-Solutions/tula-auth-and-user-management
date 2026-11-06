import { afterAll, beforeAll, expect, test } from 'bun:test'
import { organizations, ssoConnections, users, withTenant } from '@tula-tech/db'
import { createTestDatabase, createTestTenant, type TestDatabase } from '@tula-tech/db/testing'
import { and, eq } from 'drizzle-orm'
import { PostgresActivityLog } from '~/adapters/postgres/activity'
import { PostgresSsoConnectionStore } from '~/adapters/postgres/sso-connections'
import {
  describeSsoConnectionStore,
  type SsoSuiteTenant,
} from '~/adapters/sso-connection-store.suite'

// PGlite: real Postgres with every migration, connected as the runtime role (RLS applies).
let testDb: TestDatabase

beforeAll(async () => {
  testDb = await createTestDatabase()
})

afterAll(() => testDb.close())

describeSsoConnectionStore('Postgres', async () => {
  const a = await createTestTenant(testDb.db)
  const b = await createTestTenant(testDb.db, 'production')
  const log = new PostgresActivityLog(testDb.db)
  return {
    store: new PostgresSsoConnectionStore(testDb.db),
    recorded: async () =>
      (await log.listAudit(a.environmentId, { page: 1, size: 50 })).entries
        .map((entry) => entry.type)
        .reverse(),
    organization: async (tenant: SsoSuiteTenant) => {
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
    deleteOrganization: async (tenant: SsoSuiteTenant, id: string) => {
      await withTenant(testDb.db, tenant.environmentId, (tx) =>
        tx
          .delete(organizations)
          .where(
            and(eq(organizations.id, id), eq(organizations.environmentId, tenant.environmentId))
          )
      )
    },
    user: (tenant: SsoSuiteTenant) =>
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

test('row-level security hides another environment’s connection from a direct query', async () => {
  const a = await createTestTenant(testDb.db)
  const b = await createTestTenant(testDb.db, 'production')
  const organizationId = Bun.randomUUIDv7()
  await withTenant(testDb.db, a.environmentId, (tx) =>
    tx.insert(organizations).values({
      id: organizationId,
      projectId: a.projectId,
      environmentId: a.environmentId,
      name: 'Acme',
      slug: `acme-${organizationId.slice(-8)}`,
    })
  )
  await withTenant(testDb.db, a.environmentId, (tx) =>
    tx.insert(ssoConnections).values({
      id: Bun.randomUUIDv7(),
      projectId: a.projectId,
      environmentId: a.environmentId,
      organizationId,
      protocol: 'oidc',
      saml: null,
      name: 'Okta',
      issuer: 'https://idp.example.com',
      clientId: 'c',
      clientSecretSealed: 's',
      defaultRole: 'member',
    })
  )
  expect(
    await withTenant(testDb.db, b.environmentId, (tx) => tx.select().from(ssoConnections))
  ).toEqual([])
  expect(await testDb.db.select().from(ssoConnections)).toEqual([])
})
