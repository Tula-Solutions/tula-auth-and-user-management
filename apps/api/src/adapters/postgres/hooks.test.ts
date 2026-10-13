import { afterAll, beforeAll, expect, test } from 'bun:test'
import { hooks, withTenant } from '@tula/db'
import {
  createTestDatabase,
  createTestTenant,
  type TestDatabase,
  type TestTenant,
} from '@tula/db/testing'
import { describeHookStore } from '~/adapters/hook-store.suite'
import { PostgresActivityLog } from '~/adapters/postgres/activity'
import { PostgresHookStore } from '~/adapters/postgres/hooks'
import * as Audit from '~/modules/audit/service'
import type { HookRecord } from '~/ports/hook-store'

// PGlite: real Postgres with every migration, connected as the runtime role (RLS applies).
let testDb: TestDatabase

beforeAll(async () => {
  testDb = await createTestDatabase()
})

afterAll(() => testDb.close())

/** Fresh tenants per test: an environment has one hook per point. */
async function tenants(): Promise<{ a: TestTenant; b: TestTenant }> {
  return {
    a: await createTestTenant(testDb.db),
    b: await createTestTenant(testDb.db, 'production'),
  }
}

describeHookStore('Postgres', async () => {
  const { a, b } = await tenants()
  const log = new PostgresActivityLog(testDb.db)
  return {
    store: new PostgresHookStore(testDb.db),
    recorded: async () =>
      (await log.listAudit(a.environmentId, { page: 1, size: 50 })).entries
        .map((entry) => entry.type)
        .reverse(),
    a: { projectId: a.projectId, environmentId: a.environmentId },
    b: { projectId: b.projectId, environmentId: b.environmentId },
  }
})

function hook(tenant: TestTenant, overrides: Partial<HookRecord> = {}): HookRecord {
  const at = new Date('2026-01-01T00:00:00.000Z')
  return {
    id: Bun.randomUUIDv7(),
    projectId: tenant.projectId,
    environmentId: tenant.environmentId,
    point: 'before_sign_up',
    url: 'https://app.example.com/tula/before-sign-up',
    secret: 'v1.sealed.secret',
    enabled: true,
    deadlineMs: 2000,
    failureMode: 'deny',
    lastFailedAt: null,
    lastFailureReason: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  }
}

test('row-level security hides another environment’s hook even from a direct query', async () => {
  const { a, b } = await tenants()
  const store = new PostgresHookStore(testDb.db)
  await store.insert(hook(a), Audit.none('fixture'))
  const seen = await withTenant(testDb.db, b.environmentId, (tx) => tx.select().from(hooks))
  expect(seen).toEqual([])
  expect(await testDb.db.select().from(hooks)).toEqual([])
})

test('the store cannot write a deadline past five seconds: the database refuses it', async () => {
  const { a } = await tenants()
  const store = new PostgresHookStore(testDb.db)
  const refused = async (work: Promise<unknown>) =>
    work.then(
      () => null,
      (error: unknown) => String((error as { cause?: { message?: string } }).cause?.message)
    )
  expect(
    await refused(store.insert(hook(a, { deadlineMs: 5001 }), Audit.none('fixture')))
  ).toContain('hooks_deadline_bounds')
  const stored = hook(a)
  await store.insert(stored, Audit.none('fixture'))
  expect(
    await refused(
      store.update(
        a.environmentId,
        stored.id,
        { enabled: true, failureMode: 'deny' },
        { deadlineMs: 60_000 },
        new Date(),
        Audit.none('fixture')
      )
    )
  ).toContain('hooks_deadline_bounds')
  expect((await store.find(a.environmentId, stored.id))?.deadlineMs).toBe(2000)
})
