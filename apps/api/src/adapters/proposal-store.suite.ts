import { beforeEach, describe, expect, test } from 'bun:test'
import * as Audit from '~/modules/audit/service'
import type { Activity } from '~/ports/activity-log'
import type { NewProposalRecord, ProposalStore } from '~/ports/proposal-store'

/** A tenant for the suite. */
export interface ProposalSuiteTenant {
  projectId: string
  environmentId: string
}

/** What the store under test provides. */
export interface ProposalSuiteContext {
  store: ProposalStore
  /** Store an unrevoked API key of that kind in the tenant, and answer its id. */
  key: (tenant: ProposalSuiteTenant, kind: 'agent' | 'secret') => Promise<string>
  /** Revoke a key of the tenant. */
  revokeKey: (tenant: ProposalSuiteTenant, id: string) => Promise<void>
  /** The audit actions recorded so far in tenant `a`, oldest first. */
  recorded: () => Promise<string[]>
  a: ProposalSuiteTenant
  b: ProposalSuiteTenant
}

const USER = '00000000-0000-7000-8000-0000000000c1'
const ADMIN = '00000000-0000-7000-8000-0000000000ad'

/**
 * Behaviour every `ProposalStore` must have. Run against each adapter so the memory store used
 * by unit tests can't drift from Postgres.
 *
 * @param name - Adapter name for the report.
 * @param setup - Builds a fresh context; called before each test.
 */
export function describeProposalStore(
  name: string,
  setup: () => Promise<ProposalSuiteContext>
): void {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const expiry = new Date('2026-01-01T00:10:00.000Z')
  const beforeExpiry = new Date('2026-01-01T00:09:59.999Z')
  const approval = { type: 'admin', id: ADMIN } as const
  let ctx: ProposalSuiteContext
  /** Tenant `a`'s agent key, unrevoked when a test starts. */
  let AGENT: string
  /** Tenant `b`'s. */
  let OTHER_AGENT: string

  function proposal(
    tenant: ProposalSuiteTenant,
    overrides: Partial<NewProposalRecord> = {}
  ): NewProposalRecord {
    return {
      id: Bun.randomUUIDv7(),
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      operation: 'ban_user',
      targetType: 'user',
      targetId: USER,
      proposedBy: tenant.environmentId === ctx.a.environmentId ? AGENT : OTHER_AGENT,
      status: 'pending',
      expiresAt: expiry,
      approvedByType: null,
      approvedById: null,
      approvedAt: null,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    }
  }

  function activity(
    tenant: ProposalSuiteTenant,
    type: 'proposal.created' | 'proposal.approved' | 'proposal.executed' | 'proposal.failed',
    id: string
  ): Activity {
    const scope = { projectId: tenant.projectId, environmentId: tenant.environmentId }
    const deps = { ids: { next: () => Bun.randomUUIDv7() }, clock: { now: () => now } }
    const agent = { type: 'agent', id: AGENT, ipAddress: null, userAgent: null } as const
    const admin = { type: 'admin', id: ADMIN, ipAddress: null, userAgent: null } as const
    const target = { type: 'proposal', id } as const
    const proposed = { operation: 'ban_user', targetType: 'user', targetId: USER } as const
    if (type === 'proposal.created') {
      return Audit.entry(deps, scope, { type, actor: agent, target, data: proposed })
    }
    if (type === 'proposal.approved') {
      return Audit.entry(deps, scope, {
        type,
        actor: admin,
        target,
        data: { ...proposed, proposedBy: AGENT },
      })
    }
    if (type === 'proposal.executed') {
      return Audit.entry(deps, scope, {
        type,
        actor: agent,
        target,
        data: { ...proposed, approvedBy: approval },
      })
    }
    return Audit.entry(deps, scope, {
      type,
      actor: agent,
      target,
      data: { ...proposed, approvedBy: approval, reason: 'target_not_found' },
    })
  }

  async function stored(tenant: ProposalSuiteTenant, overrides: Partial<NewProposalRecord> = {}) {
    const record = proposal(tenant, overrides)
    return ctx.store.insert(record, activity(tenant, 'proposal.created', record.id))
  }

  function approve(tenant: ProposalSuiteTenant, id: string, at: Date = beforeExpiry) {
    return ctx.store.approve(
      tenant.environmentId,
      id,
      approval,
      at,
      activity(tenant, 'proposal.approved', id)
    )
  }

  describe(`${name} ProposalStore`, () => {
    beforeEach(async () => {
      ctx = await setup()
      AGENT = await ctx.key(ctx.a, 'agent')
      OTHER_AGENT = await ctx.key(ctx.b, 'agent')
    })

    // What a revoked key asked for is never carried out. The condition is the store's, in
    // the statement that approves: a check made before it could be passed by a revocation
    // that lands between the two.
    test('a proposal says whether the key that asked is still an agent key of its environment', async () => {
      const row = await stored(ctx.a)
      expect(row.proposerActive).toBe(true)
      expect((await ctx.store.find(ctx.a.environmentId, row.id))?.proposerActive).toBe(true)
      await ctx.revokeKey(ctx.a, AGENT)
      expect((await ctx.store.find(ctx.a.environmentId, row.id))?.proposerActive).toBe(false)
      expect((await ctx.store.list(ctx.a.environmentId, 10))[0]?.proposerActive).toBe(false)
      // Nothing was written to the proposal: the revocation is what ended it.
      expect((await ctx.store.find(ctx.a.environmentId, row.id))?.status).toBe('pending')
    })

    test('a proposal of a revoked agent key is not approved, and nothing is recorded', async () => {
      const row = await stored(ctx.a)
      await ctx.revokeKey(ctx.a, AGENT)
      expect(await approve(ctx.a, row.id)).toBeNull()
      expect((await ctx.store.find(ctx.a.environmentId, row.id))?.status).toBe('pending')
      expect(await ctx.recorded()).toEqual(['proposal.created'])
    })

    test('revoking another key, or the other environment’s agent key, ends nothing here', async () => {
      const row = await stored(ctx.a)
      await ctx.revokeKey(ctx.b, OTHER_AGENT)
      await ctx.revokeKey(ctx.a, await ctx.key(ctx.a, 'agent'))
      expect((await ctx.store.find(ctx.a.environmentId, row.id))?.proposerActive).toBe(true)
      expect(await approve(ctx.a, row.id)).not.toBeNull()
    })

    test.each([
      ['no key at all', async () => Bun.randomUUIDv7()],
      ['a key that is not an agent key', () => ctx.key(ctx.a, 'secret')],
      ['an agent key of another environment', async () => OTHER_AGENT],
    ])('a proposal that names %s as its agent is not approved', async (_what, proposer) => {
      const row = await stored(ctx.a, { proposedBy: await proposer() })
      expect(row.proposerActive).toBe(false)
      expect(await approve(ctx.a, row.id)).toBeNull()
      expect(await ctx.recorded()).toEqual(['proposal.created'])
    })

    test('an approval and a revocation at once: an approval that was written came first', async () => {
      const row = await stored(ctx.a)
      const again = await stored(ctx.a, { targetId: '00000000-0000-7000-8000-0000000000c2' })
      const [approved] = await Promise.all([approve(ctx.a, row.id), ctx.revokeKey(ctx.a, AGENT)])
      const after = await ctx.store.find(ctx.a.environmentId, row.id)
      // Either order is a true history. What may never be seen is a refusal that still
      // wrote, or an approval after the revocation.
      expect(after?.status).toBe(approved === null ? 'pending' : 'approved')
      expect(await ctx.recorded()).toEqual(
        approved === null
          ? ['proposal.created', 'proposal.created']
          : ['proposal.created', 'proposal.created', 'proposal.approved']
      )
      expect(await approve(ctx.a, again.id)).toBeNull()
    })

    test('a stored proposal is pending, found by id, and recorded', async () => {
      const row = await stored(ctx.a)
      expect(row).toMatchObject({ status: 'pending', operation: 'ban_user', targetId: USER })
      expect(row.expiresAt.toISOString()).toBe(expiry.toISOString())
      expect((await ctx.store.find(ctx.a.environmentId, row.id))?.id).toBe(row.id)
      expect(await ctx.recorded()).toEqual(['proposal.created'])
    })

    test('the list is newest first and holds no more than the limit', async () => {
      const first = await stored(ctx.a, { createdAt: new Date('2026-01-01T00:00:01.000Z') })
      const second = await stored(ctx.a, { createdAt: new Date('2026-01-01T00:00:02.000Z') })
      const third = await stored(ctx.a, { createdAt: new Date('2026-01-01T00:00:03.000Z') })
      const all = await ctx.store.list(ctx.a.environmentId, 10)
      expect(all.map((row) => row.id)).toEqual([third.id, second.id, first.id])
      const some = await ctx.store.list(ctx.a.environmentId, 2)
      expect(some.map((row) => row.id)).toEqual([third.id, second.id])
    })

    test('another environment neither sees nor decides a proposal', async () => {
      const row = await stored(ctx.a)
      expect(await ctx.store.find(ctx.b.environmentId, row.id)).toBeNull()
      expect(await ctx.store.list(ctx.b.environmentId, 10)).toEqual([])
      expect(await approve(ctx.b, row.id)).toBeNull()
      expect(
        await ctx.store.finish(
          ctx.b.environmentId,
          row.id,
          { status: 'executed' },
          now,
          activity(ctx.b, 'proposal.executed', row.id)
        )
      ).toBeNull()
      expect(
        await ctx.store.deleteExpiredBefore(ctx.b.environmentId, new Date('2030-01-01'), 10)
      ).toBe(0)
      expect((await ctx.store.find(ctx.a.environmentId, row.id))?.status).toBe('pending')
      expect(await ctx.recorded()).toEqual(['proposal.created'])
    })

    test('an approval is written once, with who approved and when', async () => {
      const row = await stored(ctx.a)
      const approved = await approve(ctx.a, row.id)
      expect(approved).toMatchObject({
        status: 'approved',
        approvedByType: 'admin',
        approvedById: ADMIN,
        failureReason: null,
      })
      expect(approved?.approvedAt?.toISOString()).toBe(beforeExpiry.toISOString())
      // What was proposed is what was approved.
      expect(approved).toMatchObject({
        operation: row.operation,
        targetType: row.targetType,
        targetId: row.targetId,
        proposedBy: row.proposedBy,
      })
      expect(approved?.expiresAt.toISOString()).toBe(expiry.toISOString())
      expect(await ctx.recorded()).toEqual(['proposal.created', 'proposal.approved'])
    })

    test('a proposal cannot be approved twice, and the second try records nothing', async () => {
      const row = await stored(ctx.a)
      expect(await approve(ctx.a, row.id)).not.toBeNull()
      expect(await approve(ctx.a, row.id)).toBeNull()
      expect(await ctx.recorded()).toEqual(['proposal.created', 'proposal.approved'])
    })

    test('of two approvals at once exactly one is written', async () => {
      const row = await stored(ctx.a)
      const results = await Promise.all([approve(ctx.a, row.id), approve(ctx.a, row.id)])
      expect(results.filter((result) => result !== null)).toHaveLength(1)
      expect(await ctx.recorded()).toEqual(['proposal.created', 'proposal.approved'])
    })

    test('an expired proposal is not approved: at its expiry and after it', async () => {
      const row = await stored(ctx.a)
      expect(await approve(ctx.a, row.id, expiry)).toBeNull()
      expect(await approve(ctx.a, row.id, new Date('2026-01-02T00:00:00.000Z'))).toBeNull()
      expect((await ctx.store.find(ctx.a.environmentId, row.id))?.status).toBe('pending')
      expect(await ctx.recorded()).toEqual(['proposal.created'])
      // One millisecond earlier it still is.
      expect(await approve(ctx.a, row.id, beforeExpiry)).not.toBeNull()
    })

    test('an unknown proposal is not approved', async () => {
      expect(await approve(ctx.a, Bun.randomUUIDv7())).toBeNull()
      expect(await ctx.recorded()).toEqual([])
    })

    test('an outcome is recorded only for an approved proposal, and once', async () => {
      const row = await stored(ctx.a)
      const executed = () =>
        ctx.store.finish(
          ctx.a.environmentId,
          row.id,
          { status: 'executed' },
          expiry,
          activity(ctx.a, 'proposal.executed', row.id)
        )
      // Nobody approved it: nothing is written.
      expect(await executed()).toBeNull()
      await approve(ctx.a, row.id)
      expect(await executed()).toMatchObject({ status: 'executed', failureReason: null })
      expect(await executed()).toBeNull()
      // An executed proposal is not approved again.
      expect(await approve(ctx.a, row.id)).toBeNull()
      expect(await ctx.recorded()).toEqual([
        'proposal.created',
        'proposal.approved',
        'proposal.executed',
      ])
    })

    test('a failed outcome keeps its reason and the approver', async () => {
      const row = await stored(ctx.a)
      await approve(ctx.a, row.id)
      const failed = await ctx.store.finish(
        ctx.a.environmentId,
        row.id,
        { status: 'failed', reason: 'target_not_found' },
        expiry,
        activity(ctx.a, 'proposal.failed', row.id)
      )
      expect(failed).toMatchObject({
        status: 'failed',
        failureReason: 'target_not_found',
        approvedByType: 'admin',
        approvedById: ADMIN,
      })
      expect(await approve(ctx.a, row.id)).toBeNull()
      expect(await ctx.recorded()).toEqual([
        'proposal.created',
        'proposal.approved',
        'proposal.failed',
      ])
    })

    test('a waiting proposal is found only for the same operation, target and agent', async () => {
      const row = await stored(ctx.a)
      const like = {
        operation: 'ban_user',
        targetType: 'user',
        targetId: USER,
        proposedBy: AGENT,
      } as const
      expect((await ctx.store.findPending(ctx.a.environmentId, like, now))?.id).toBe(row.id)
      expect(
        await ctx.store.findPending(
          ctx.a.environmentId,
          { ...like, targetId: '00000000-0000-7000-8000-0000000000c2' },
          now
        )
      ).toBeNull()
      expect(
        await ctx.store.findPending(
          ctx.a.environmentId,
          { ...like, proposedBy: '00000000-0000-7000-8000-0000000000aa' },
          now
        )
      ).toBeNull()
      expect(await ctx.store.findPending(ctx.b.environmentId, like, now)).toBeNull()
      // Expired: not waiting.
      expect(await ctx.store.findPending(ctx.a.environmentId, like, expiry)).toBeNull()
      // Approved: not waiting.
      await approve(ctx.a, row.id)
      expect(await ctx.store.findPending(ctx.a.environmentId, like, now)).toBeNull()
    })

    // A provider is named as the admin API names one, by its name: the target's column
    // holds a UUID or such a name, and is compared as the text it is.
    test('a proposal about a provider is stored under the provider’s name, and one about a session under its id', async () => {
      const SESSION = '00000000-0000-7000-8000-0000000000d1'
      const provider = await stored(ctx.a, {
        operation: 'disable_oauth_provider',
        targetType: 'oauth_provider',
        targetId: 'google',
      })
      const session = await stored(ctx.a, {
        operation: 'end_session',
        targetType: 'session',
        targetId: SESSION,
      })
      expect(await ctx.store.find(ctx.a.environmentId, provider.id)).toMatchObject({
        operation: 'disable_oauth_provider',
        targetType: 'oauth_provider',
        targetId: 'google',
      })
      expect(await ctx.store.find(ctx.a.environmentId, session.id)).toMatchObject({
        operation: 'end_session',
        targetType: 'session',
        targetId: SESSION,
      })
      const like = {
        operation: 'disable_oauth_provider',
        targetType: 'oauth_provider',
        targetId: 'google',
        proposedBy: AGENT,
      } as const
      expect((await ctx.store.findPending(ctx.a.environmentId, like, now))?.id).toBe(provider.id)
      // Another provider, and the same name under another operation or kind, wait for nothing.
      for (const other of [
        { ...like, targetId: 'github' },
        { ...like, operation: 'end_session' },
        { ...like, targetType: 'session' },
      ] as const) {
        expect(await ctx.store.findPending(ctx.a.environmentId, other, now)).toBeNull()
      }
      expect(await ctx.store.findPending(ctx.b.environmentId, like, now)).toBeNull()
      // Approved and finished like any other.
      expect((await approve(ctx.a, provider.id))?.targetId).toBe('google')
    })

    test('the purge deletes what expired strictly before the cutoff, a batch at a time', async () => {
      const old = new Date('2025-06-01T00:10:00.000Z')
      const oldCreated = new Date('2025-06-01T00:00:00.000Z')
      const one = await stored(ctx.a, { expiresAt: old, createdAt: oldCreated })
      const two = await stored(ctx.a, { expiresAt: old, createdAt: oldCreated })
      const kept = await stored(ctx.a)
      // At the cutoff itself: kept.
      expect(await ctx.store.deleteExpiredBefore(ctx.a.environmentId, old, 10)).toBe(0)
      const cutoff = new Date('2025-12-01T00:00:00.000Z')
      expect(await ctx.store.deleteExpiredBefore(ctx.a.environmentId, cutoff, 1)).toBe(1)
      expect(await ctx.store.deleteExpiredBefore(ctx.a.environmentId, cutoff, 10)).toBe(1)
      expect(await ctx.store.deleteExpiredBefore(ctx.a.environmentId, cutoff, 10)).toBe(0)
      expect(await ctx.store.find(ctx.a.environmentId, one.id)).toBeNull()
      expect(await ctx.store.find(ctx.a.environmentId, two.id)).toBeNull()
      expect((await ctx.store.find(ctx.a.environmentId, kept.id))?.id).toBe(kept.id)
    })
  })
}
