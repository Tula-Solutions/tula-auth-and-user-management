import { beforeEach, expect, test } from 'bun:test'
import { durationToMs } from '@tula/contract'
import * as Audit from '~/modules/audit/service'
import * as Retention from '~/modules/retention/service'
import type { ProposalRecord } from '~/ports/proposal-store'
import { createTestDeps, TEST_TENANT, type TestDeps } from '~/testing'

let deps: TestDeps

beforeEach(() => {
  deps = createTestDeps()
  for (const [id, kind] of [
    [TEST_TENANT.environmentId, 'development'],
    [TEST_TENANT.productionEnvironmentId, 'production'],
  ] as const) {
    deps.environments.add({
      id,
      projectId: TEST_TENANT.projectId,
      kind,
      createdAt: deps.clock.now(),
    })
  }
})

async function proposal(environmentId: string, overrides: Partial<ProposalRecord> = {}) {
  const now = deps.clock.now()
  return deps.proposals.insert(
    {
      id: deps.ids.next(),
      projectId: TEST_TENANT.projectId,
      environmentId,
      operation: 'ban_user',
      targetType: 'user',
      targetId: deps.ids.next(),
      proposedBy: deps.ids.next(),
      status: 'pending',
      expiresAt: new Date(now.getTime() + 600_000),
      approvedByType: null,
      approvedById: null,
      approvedAt: null,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    },
    Audit.none('fixture')
  )
}

test('a proposal goes thirty days after its expiry, approved or not, and not a millisecond sooner', async () => {
  const waiting = await proposal(TEST_TENANT.environmentId)
  const decided = await proposal(TEST_TENANT.environmentId)
  await deps.proposals.approve(
    TEST_TENANT.environmentId,
    decided.id,
    { type: 'admin', id: null },
    deps.clock.now(),
    Audit.none('fixture')
  )
  const elsewhere = await proposal(TEST_TENANT.productionEnvironmentId)
  const kept = durationToMs(Retention.EXPIRED_PROPOSAL_RETENTION)

  // At the last instant of the period: all three are still there.
  deps.clock.advance(600_000 + kept)
  expect(await Retention.purge(deps)).toMatchObject({ proposals: 0, failed: 0 })
  expect(await deps.proposals.find(TEST_TENANT.environmentId, waiting.id)).not.toBeNull()

  // A proposal made now is not touched by the purge that takes the old ones.
  const fresh = await proposal(TEST_TENANT.environmentId)
  deps.clock.advance(1)
  expect(await Retention.purge(deps)).toMatchObject({ proposals: 3, failed: 0 })
  expect(await deps.proposals.find(TEST_TENANT.environmentId, waiting.id)).toBeNull()
  expect(await deps.proposals.find(TEST_TENANT.environmentId, decided.id)).toBeNull()
  expect(await deps.proposals.find(TEST_TENANT.productionEnvironmentId, elsewhere.id)).toBeNull()
  expect((await deps.proposals.find(TEST_TENANT.environmentId, fresh.id))?.id).toBe(fresh.id)
  // Not recorded: the audit entries of a proposal are its lasting record.
  expect(deps.activityLog.entries).toEqual([])
})
