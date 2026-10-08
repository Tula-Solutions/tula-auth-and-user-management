import { afterAll, beforeAll, expect, test } from 'bun:test'
import { oauthProviders, withTenant } from '@tula/db'
import {
  createTestDatabase,
  createTestTenant,
  type TestDatabase,
  type TestTenant,
} from '@tula/db/testing'
import { describeOAuthProviderStore } from '~/adapters/oauth-provider-store.suite'
import { PostgresActivityLog } from '~/adapters/postgres/activity'
import { PostgresOAuthProviderStore } from '~/adapters/postgres/oauth-providers'
import * as Audit from '~/modules/audit/service'

// PGlite: real Postgres with every migration, connected as the runtime role (RLS applies).
let testDb: TestDatabase

beforeAll(async () => {
  testDb = await createTestDatabase()
})

afterAll(() => testDb.close())

/** Fresh tenants per test: the suite counts rows per environment. */
async function tenants(): Promise<{ a: TestTenant; b: TestTenant }> {
  return {
    a: await createTestTenant(testDb.db),
    b: await createTestTenant(testDb.db, 'production'),
  }
}

describeOAuthProviderStore('PostgresOAuthProviderStore', async () => {
  const { a, b } = await tenants()
  const log = new PostgresActivityLog(testDb.db)
  return {
    store: new PostgresOAuthProviderStore(testDb.db),
    recorded: async () =>
      (await log.listAudit(a.environmentId, { page: 1, size: 50 })).entries
        .map((entry) => entry.type)
        .reverse(),
    a: { projectId: a.projectId, environmentId: a.environmentId },
    b: { projectId: b.projectId, environmentId: b.environmentId },
  }
})

test('row-level security hides another environment’s credentials even from a direct query', async () => {
  const { a, b } = await tenants()
  const store = new PostgresOAuthProviderStore(testDb.db)
  await store.upsert(
    {
      id: Bun.randomUUIDv7(),
      projectId: a.projectId,
      environmentId: a.environmentId,
      provider: 'google',
      clientId: 'client',
      secret: 'v1.sealed.secret',
      config: {},
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    Audit.none('fixture')
  )
  const seenFromB = await withTenant(testDb.db, b.environmentId, (tx) =>
    tx.select({ id: oauthProviders.id }).from(oauthProviders)
  )
  expect(seenFromB).toEqual([])
  const unscoped = await testDb.db.select({ id: oauthProviders.id }).from(oauthProviders)
  expect(unscoped).toEqual([])
})
