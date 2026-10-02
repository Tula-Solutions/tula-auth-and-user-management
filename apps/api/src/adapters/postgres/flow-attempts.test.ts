import { afterAll, beforeAll } from 'bun:test'
import { users, withTenant } from '@tula/db'
import {
  createTestDatabase,
  createTestTenant,
  type TestDatabase,
  type TestTenant,
} from '@tula/db/testing'
import { describeFlowAttemptStore, type FlowSuiteTenant } from '~/adapters/flow-attempt-store.suite'
import { PostgresFlowAttemptStore } from '~/adapters/postgres/flow-attempts'

// PGlite: real Postgres with every migration, connected as the runtime role (RLS applies).
let testDb: TestDatabase
let a: TestTenant
let b: TestTenant

beforeAll(async () => {
  testDb = await createTestDatabase()
  a = await createTestTenant(testDb.db)
  b = await createTestTenant(testDb.db, 'production')
})

afterAll(() => testDb.close())

function suiteTenant(tenant: TestTenant): FlowSuiteTenant {
  const scope = { projectId: tenant.projectId, environmentId: tenant.environmentId }
  return {
    ...scope,
    user: () =>
      withTenant(testDb.db, tenant.environmentId, async (tx) => {
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

describeFlowAttemptStore('PostgresFlowAttemptStore', async () => ({
  store: new PostgresFlowAttemptStore(testDb.db),
  a: suiteTenant(a),
  b: suiteTenant(b),
}))
