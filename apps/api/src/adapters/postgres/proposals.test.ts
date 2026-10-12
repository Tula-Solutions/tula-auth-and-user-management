import { afterAll, beforeAll, expect, test } from 'bun:test'
import { proposals, withTenant } from '@tula/db'
import {
  createTestDatabase,
  createTestTenant,
  type TestDatabase,
  type TestTenant,
} from '@tula/db/testing'
import { eq, sql } from 'drizzle-orm'
import { PostgresActivityLog } from '~/adapters/postgres/activity'
import { PostgresProposalStore } from '~/adapters/postgres/proposals'
import { describeProposalStore } from '~/adapters/proposal-store.suite'
import * as Audit from '~/modules/audit/service'
import type { ProposalRecord } from '~/ports/proposal-store'

// PGlite: real Postgres with every migration, connected as the runtime role (RLS applies).
let testDb: TestDatabase

beforeAll(async () => {
  testDb = await createTestDatabase()
})

afterAll(() => testDb.close())

async function tenants(): Promise<{ a: TestTenant; b: TestTenant }> {
  return {
    a: await createTestTenant(testDb.db),
    b: await createTestTenant(testDb.db, 'production'),
  }
}

describeProposalStore('Postgres', async () => {
  const { a, b } = await tenants()
  const log = new PostgresActivityLog(testDb.db)
  return {
    store: new PostgresProposalStore(testDb.db),
    recorded: async () =>
      (await log.listAudit(a.environmentId, { page: 1, size: 50 })).entries
        .map((entry) => entry.type)
        .reverse(),
    a: { projectId: a.projectId, environmentId: a.environmentId },
    b: { projectId: b.projectId, environmentId: b.environmentId },
  }
})

function proposal(tenant: TestTenant, overrides: Partial<ProposalRecord> = {}): ProposalRecord {
  const at = new Date('2026-01-01T00:00:00.000Z')
  return {
    id: Bun.randomUUIDv7(),
    projectId: tenant.projectId,
    environmentId: tenant.environmentId,
    operation: 'ban_user',
    targetType: 'user',
    targetId: Bun.randomUUIDv7(),
    proposedBy: Bun.randomUUIDv7(),
    status: 'pending',
    expiresAt: new Date('2026-01-01T00:10:00.000Z'),
    approvedByType: null,
    approvedById: null,
    approvedAt: null,
    failureReason: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  }
}

/** The database's own words for why it refused a statement. */
async function refusal(work: Promise<unknown>): Promise<string | null> {
  return work.then(
    () => null,
    (error: unknown) => {
      const cause = (error as { cause?: { message?: string } }).cause?.message
      return String(cause ?? (error as Error).message)
    }
  )
}

test('row-level security hides another environment’s proposal even from a direct query', async () => {
  const { a, b } = await tenants()
  const store = new PostgresProposalStore(testDb.db)
  await store.insert(proposal(a), Audit.none('fixture'))
  const seen = await withTenant(testDb.db, b.environmentId, (tx) => tx.select().from(proposals))
  expect(seen).toEqual([])
  expect(await testDb.db.select().from(proposals)).toEqual([])
})

test('the database refuses a proposal that could be approved more than an hour later', async () => {
  const { a } = await tenants()
  const store = new PostgresProposalStore(testDb.db)
  expect(
    await refusal(
      store.insert(
        proposal(a, { expiresAt: new Date('2026-01-01T01:00:00.001Z') }),
        Audit.none('fixture')
      )
    )
  ).toContain('proposals_lifetime_bounds')
})

test('the database refuses a proposal stored as already approved by nobody', async () => {
  const { a } = await tenants()
  const store = new PostgresProposalStore(testDb.db)
  expect(
    await refusal(store.insert(proposal(a, { status: 'approved' }), Audit.none('fixture')))
  ).toContain('proposals_approval_whole')
  expect(
    await refusal(
      store.insert(
        proposal(a, {
          status: 'approved',
          approvedByType: 'agent' as never,
          approvedById: 'x',
          approvedAt: new Date('2026-01-01T00:01:00.000Z'),
        }),
        Audit.none('fixture')
      )
    )
  ).toContain('proposals_approval_whole')
})

test('the runtime role cannot rewrite what a proposal would do, to what, for whom or until when', async () => {
  const { a } = await tenants()
  const store = new PostgresProposalStore(testDb.db)
  const row = await store.insert(proposal(a), Audit.none('fixture'))
  const attempts = {
    operation: { operation: 'delete_user' },
    target_id: { targetId: Bun.randomUUIDv7() },
    target_type: { targetType: 'session' },
    proposed_by: { proposedBy: Bun.randomUUIDv7() },
    expires_at: { expiresAt: new Date('2026-01-01T00:59:00.000Z') },
    created_at: { createdAt: new Date('2026-01-01T00:05:00.000Z') },
  }
  for (const set of Object.values(attempts)) {
    const said = await refusal(
      withTenant(testDb.db, a.environmentId, (tx) =>
        tx.update(proposals).set(set).where(eq(proposals.id, row.id))
      )
    )
    expect(said).toContain('permission denied')
  }
  const after = await store.find(a.environmentId, row.id)
  expect(after).toMatchObject({
    operation: row.operation,
    targetType: row.targetType,
    targetId: row.targetId,
    proposedBy: row.proposedBy,
  })
  expect(after?.expiresAt.toISOString()).toBe(row.expiresAt.toISOString())
  // What an approval writes is allowed.
  await withTenant(testDb.db, a.environmentId, (tx) =>
    tx.update(proposals).set({ updatedAt: sql`now()` }).where(eq(proposals.id, row.id))
  )
})
