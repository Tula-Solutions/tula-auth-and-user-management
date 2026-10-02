import { afterAll, beforeAll } from 'bun:test'
import { flowAttempts, users, withTenant } from '@tula/db'
import {
  createTestDatabase,
  createTestTenant,
  type TestDatabase,
  type TestTenant,
} from '@tula/db/testing'
import { PostgresVerificationTokenStore } from '~/adapters/postgres/verification-tokens'
import {
  describeVerificationTokenStore,
  type SuiteTenant,
} from '~/adapters/verification-token-store.suite'

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

function suiteTenant(tenant: TestTenant): SuiteTenant {
  const scope = { projectId: tenant.projectId, environmentId: tenant.environmentId }
  return {
    ...scope,
    flowAttempt: () =>
      withTenant(testDb.db, tenant.environmentId, async (tx) => {
        const id = Bun.randomUUIDv7()
        await tx.insert(flowAttempts).values({
          id,
          ...scope,
          kind: 'sign_up',
          status: 'needs_email_verification',
          identifier: 'maya@northline.app',
          expiresAt: new Date('2026-01-01T00:10:00Z'),
        })
        return id
      }),
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

describeVerificationTokenStore('PostgresVerificationTokenStore', async () => ({
  store: new PostgresVerificationTokenStore(testDb.db),
  a: suiteTenant(a),
  b: suiteTenant(b),
}))
