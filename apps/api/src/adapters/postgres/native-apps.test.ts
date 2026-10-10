import { afterAll, beforeAll, expect, test } from 'bun:test'
import { nativeApps, withTenant } from '@tula/db'
import {
  createTestDatabase,
  createTestTenant,
  type TestDatabase,
  type TestTenant,
} from '@tula/db/testing'
import { describeNativeAppStore } from '~/adapters/native-app-store.suite'
import { PostgresActivityLog } from '~/adapters/postgres/activity'
import { PostgresNativeAppStore } from '~/adapters/postgres/native-apps'
import * as Audit from '~/modules/audit/service'
import type { NativeAppRecord } from '~/ports/native-app-store'

// PGlite: real Postgres with every migration, connected as the runtime role (RLS applies).
let testDb: TestDatabase

beforeAll(async () => {
  testDb = await createTestDatabase()
})

afterAll(() => testDb.close())

/** Fresh tenants per test: an environment has one app per platform and identifier. */
async function tenants(): Promise<{ a: TestTenant; b: TestTenant }> {
  return {
    a: await createTestTenant(testDb.db),
    b: await createTestTenant(testDb.db, 'production'),
  }
}

describeNativeAppStore('Postgres', async () => {
  const { a, b } = await tenants()
  const log = new PostgresActivityLog(testDb.db)
  return {
    store: new PostgresNativeAppStore(testDb.db),
    recorded: async () =>
      (await log.listAudit(a.environmentId, { page: 1, size: 50 })).entries
        .map((entry) => entry.type)
        .reverse(),
    a: { projectId: a.projectId, environmentId: a.environmentId },
    b: { projectId: b.projectId, environmentId: b.environmentId },
  }
})

function app(tenant: TestTenant, overrides: Partial<NativeAppRecord> = {}): NativeAppRecord {
  const at = new Date('2026-01-01T00:00:00.000Z')
  return {
    id: Bun.randomUUIDv7(),
    projectId: tenant.projectId,
    environmentId: tenant.environmentId,
    platform: 'ios',
    identifier: 'com.example.app',
    teamId: 'A1B2C3D4E5',
    sha256CertFingerprints: [],
    appLinkPaths: [],
    createdAt: at,
    updatedAt: at,
    ...overrides,
  }
}

test('row-level security hides another environment’s app even from a direct query', async () => {
  const { a, b } = await tenants()
  const store = new PostgresNativeAppStore(testDb.db)
  await store.insert(app(a), Audit.none('fixture'))
  const seen = await withTenant(testDb.db, b.environmentId, (tx) => tx.select().from(nativeApps))
  expect(seen).toEqual([])
  expect(await testDb.db.select().from(nativeApps)).toEqual([])
})

test('the store cannot write an app the files must not carry: the database refuses it', async () => {
  const { a } = await tenants()
  const store = new PostgresNativeAppStore(testDb.db)
  const refused = async (work: Promise<unknown>) =>
    work.then(
      () => null,
      (error: unknown) => String((error as { cause?: { message?: string } }).cause?.message)
    )
  expect(
    await refused(store.insert(app(a, { identifier: 'com.example."app' }), Audit.none('fixture')))
  ).toContain('native_apps_identifier_shape')
  expect(
    await refused(store.insert(app(a, { teamId: 'not-a-team' }), Audit.none('fixture')))
  ).toContain('native_apps_ios_whole')
  const stored = app(a)
  await store.insert(stored, Audit.none('fixture'))
  expect(
    await refused(
      store.update(
        a.environmentId,
        stored.id,
        stored,
        { sha256CertFingerprints: ['nonsense'] },
        new Date(),
        Audit.none('fixture')
      )
    )
  ).toContain('native_apps_')
  expect(await store.find(a.environmentId, stored.id)).toEqual(stored)
})
