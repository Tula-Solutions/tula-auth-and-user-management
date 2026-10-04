import { afterAll, beforeAll } from 'bun:test'
import { createTestDatabase, type TestDatabase } from '@tula/db/testing'
import { describeControlPlane } from '~/adapters/control-plane.suite'
import { PostgresControlPlane } from '~/adapters/postgres/control-plane'

// PGlite: real Postgres with every migration, connected as the runtime role, so the grants of
// the instance audit table are exercised too.
let testDb: TestDatabase

beforeAll(async () => {
  testDb = await createTestDatabase()
})

afterAll(() => testDb.close())

describeControlPlane('PostgresControlPlane', async () => new PostgresControlPlane(testDb.db))
