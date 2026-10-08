import { afterAll, beforeAll } from 'bun:test'
import {
  createTestDatabase,
  createTestTenant,
  type TestDatabase,
  type TestTenant,
} from '@tula/db/testing'
import { PostgresActivityLog } from '~/adapters/postgres/activity'
import { PostgresUserRepository } from '~/adapters/postgres/users'
import { describeUserRepository } from '~/adapters/user-repository.suite'

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

describeUserRepository('PostgresUserRepository', async () => ({
  users: new PostgresUserRepository(testDb.db),
  log: new PostgresActivityLog(testDb.db),
  a: { projectId: a.projectId, environmentId: a.environmentId },
  b: { projectId: b.projectId, environmentId: b.environmentId },
}))
