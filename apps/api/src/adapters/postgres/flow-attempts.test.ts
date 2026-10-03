import { afterAll, beforeAll, expect, test } from 'bun:test'
import { users, withTenant } from '@tula/db'
import {
  createTestDatabase,
  createTestTenant,
  type TestDatabase,
  type TestTenant,
} from '@tula/db/testing'
import { describeFlowAttemptStore, type FlowSuiteTenant } from '~/adapters/flow-attempt-store.suite'
import { PostgresFlowAttemptStore } from '~/adapters/postgres/flow-attempts'
import { describeError } from '~/lib/safe-error'

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

test('a NUL character in a stored value is reported as SQLSTATE 22021, which the API answers with 400', async () => {
  const store = new PostgresFlowAttemptStore(testDb.db)
  const now = new Date('2026-01-01T00:00:00.000Z')
  const attempt = store.create({
    id: Bun.randomUUIDv7(),
    projectId: a.projectId,
    environmentId: a.environmentId,
    kind: 'sign_in',
    status: 'needs_password',
    identifier: 'a\u0000b',
    userId: null,
    state: { client: 'web' },
    expiresAt: new Date(now.getTime() + 60_000),
    createdAt: now,
  })
  const error = await attempt.then(
    () => null,
    (thrown: unknown) => thrown
  )
  expect(describeError(error)).toMatchObject({ name: 'DatabaseError', code: '22021' })
})
