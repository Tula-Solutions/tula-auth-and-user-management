import { beforeEach, describe, expect, test } from 'bun:test'
import type { FlowAttemptStore, NewFlowAttempt } from '~/ports/flow-attempt-store'

/** A tenant plus the rows the store's foreign keys need. */
export interface FlowSuiteTenant {
  projectId: string
  environmentId: string
  /** Create a user (a real row for Postgres) and return its id. */
  user: () => Promise<string>
}

/** What a store under test provides. */
export interface FlowSuiteContext {
  store: FlowAttemptStore
  a: FlowSuiteTenant
  b: FlowSuiteTenant
}

/**
 * Behaviour every `FlowAttemptStore` must have. Run against each adapter so the memory store
 * used by unit tests can't drift from Postgres.
 *
 * @param name - Adapter name for the report.
 * @param setup - Builds a fresh context; called before each test.
 */
export function describeFlowAttemptStore(
  name: string,
  setup: () => Promise<FlowSuiteContext>
): void {
  describe(`${name} (FlowAttemptStore)`, () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    const later = (ms: number) => new Date(now.getTime() + ms)
    let ctx: FlowSuiteContext

    beforeEach(async () => {
      ctx = await setup()
    })

    function attempt(
      tenant: FlowSuiteTenant,
      overrides: Partial<NewFlowAttempt> = {}
    ): NewFlowAttempt {
      return {
        id: Bun.randomUUIDv7(),
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        kind: 'sign_in',
        status: 'needs_password',
        userId: null,
        identifier: 'maya@northline.app',
        secretHash: 'a'.repeat(64),
        state: { client: 'web' },
        expiresAt: later(600_000),
        createdAt: now,
        ...overrides,
      }
    }

    test('stores an attempt and finds it with its server state', async () => {
      const input = attempt(ctx.a, {
        kind: 'sign_up',
        status: 'needs_email_verification',
        state: { client: 'ios', passwordHash: '$argon2id$x', nested: { a: [1, 2] } },
      })
      await ctx.store.create(input)
      expect(await ctx.store.findById(ctx.a.environmentId, input.id)).toEqual({
        ...input,
        completedAt: null,
      })
      expect(await ctx.store.findById(ctx.a.environmentId, Bun.randomUUIDv7())).toBeNull()
    })

    test('keeps the hash of the attempt’s secret through every transition, and may hold none', async () => {
      const bound = attempt(ctx.a, { secretHash: 'b'.repeat(64) })
      const unbound = attempt(ctx.a, { secretHash: null })
      await ctx.store.create(bound)
      await ctx.store.create(unbound)
      await ctx.store.transition(
        ctx.a.environmentId,
        bound.id,
        'needs_password',
        { status: 'needs_second_factor', state: { client: 'web' } },
        later(1)
      )
      expect((await ctx.store.findById(ctx.a.environmentId, bound.id))?.secretHash).toBe(
        'b'.repeat(64)
      )
      expect((await ctx.store.findById(ctx.a.environmentId, unbound.id))?.secretHash).toBeNull()
    })

    test('a transition changes the step and only the fields it names', async () => {
      const userId = await ctx.a.user()
      const input = attempt(ctx.a)
      await ctx.store.create(input)
      expect(
        await ctx.store.transition(
          ctx.a.environmentId,
          input.id,
          'needs_password',
          { status: 'needs_email_verification', userId },
          later(1_000)
        )
      ).toBe(true)
      expect(await ctx.store.findById(ctx.a.environmentId, input.id)).toMatchObject({
        status: 'needs_email_verification',
        userId,
        state: { client: 'web' },
        completedAt: null,
      })

      expect(
        await ctx.store.transition(
          ctx.a.environmentId,
          input.id,
          'needs_email_verification',
          { status: 'complete', state: { client: 'web', done: true }, completedAt: later(2_000) },
          later(2_000)
        )
      ).toBe(true)
      expect(await ctx.store.findById(ctx.a.environmentId, input.id)).toMatchObject({
        status: 'complete',
        userId,
        state: { client: 'web', done: true },
        completedAt: later(2_000),
      })
    })

    test('a transition can give the attempt an identifier, and otherwise keeps the one it has', async () => {
      const input = { ...attempt(ctx.a), identifier: '' }
      await ctx.store.create(input)
      const move = (change: { identifier?: string }) =>
        ctx.store.transition(
          ctx.a.environmentId,
          input.id,
          'needs_password',
          { status: 'needs_password', ...change },
          later(1_000)
        )
      expect(await move({ identifier: 'maya@northline.app' })).toBe(true)
      expect((await ctx.store.findById(ctx.a.environmentId, input.id))?.identifier).toBe(
        'maya@northline.app'
      )
      expect(await move({})).toBe(true)
      expect((await ctx.store.findById(ctx.a.environmentId, input.id))?.identifier).toBe(
        'maya@northline.app'
      )
    })

    test('a transition from the wrong step writes nothing', async () => {
      const input = attempt(ctx.a)
      await ctx.store.create(input)
      expect(
        await ctx.store.transition(
          ctx.a.environmentId,
          input.id,
          'needs_email_verification',
          { status: 'complete', completedAt: later(1) },
          later(1)
        )
      ).toBe(false)
      expect((await ctx.store.findById(ctx.a.environmentId, input.id))?.status).toBe(
        'needs_password'
      )
    })

    test('of concurrent transitions from one step exactly one wins', async () => {
      const input = attempt(ctx.a)
      await ctx.store.create(input)
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          ctx.store.transition(
            ctx.a.environmentId,
            input.id,
            'needs_password',
            { status: 'complete', completedAt: later(1) },
            later(1)
          )
        )
      )
      expect(results.filter(Boolean)).toHaveLength(1)
    })

    test('a completed or expired attempt cannot transition again', async () => {
      const done = attempt(ctx.a)
      await ctx.store.create(done)
      await ctx.store.transition(
        ctx.a.environmentId,
        done.id,
        'needs_password',
        { status: 'complete', completedAt: later(1) },
        later(1)
      )
      expect(
        await ctx.store.transition(
          ctx.a.environmentId,
          done.id,
          'complete',
          { status: 'needs_password' },
          later(2)
        )
      ).toBe(false)

      const expiring = attempt(ctx.a, { expiresAt: later(1_000) })
      await ctx.store.create(expiring)
      const change = { status: 'complete' as const, completedAt: later(1_000) }
      expect(
        await ctx.store.transition(
          ctx.a.environmentId,
          expiring.id,
          'needs_password',
          change,
          later(1_000)
        )
      ).toBe(false)
      expect(
        await ctx.store.transition(
          ctx.a.environmentId,
          expiring.id,
          'needs_password',
          change,
          later(999)
        )
      ).toBe(true)
    })

    test('deletes one attempt, and only within its environment', async () => {
      const input = attempt(ctx.a)
      await ctx.store.create(input)
      await ctx.store.delete(ctx.b.environmentId, input.id)
      expect(await ctx.store.findById(ctx.a.environmentId, input.id)).not.toBeNull()
      await ctx.store.delete(ctx.a.environmentId, input.id)
      expect(await ctx.store.findById(ctx.a.environmentId, input.id)).toBeNull()
      await ctx.store.delete(ctx.a.environmentId, input.id)
    })

    test('purges attempts past their expiry, open or completed, and nothing else', async () => {
      // Times earlier than any other test's, because a shared database keeps their rows.
      const past = -3_600_000
      const expired = attempt(ctx.a, { expiresAt: later(past) })
      const completed = attempt(ctx.a, { expiresAt: later(past) })
      const live = attempt(ctx.a, { expiresAt: later(past + 5_000) })
      const foreign = attempt(ctx.b, { expiresAt: later(past) })
      for (const input of [expired, completed, live, foreign]) {
        await ctx.store.create(input)
      }
      await ctx.store.transition(
        ctx.a.environmentId,
        completed.id,
        'needs_password',
        { status: 'complete', completedAt: later(past - 500) },
        later(past - 500)
      )

      expect(await ctx.store.deleteExpired(ctx.a.environmentId, later(past - 1), 100)).toBe(0)
      expect(await ctx.store.deleteExpired(ctx.a.environmentId, later(past), 100)).toBe(2)
      expect(await ctx.store.findById(ctx.a.environmentId, expired.id)).toBeNull()
      expect(await ctx.store.findById(ctx.a.environmentId, completed.id)).toBeNull()
      expect(await ctx.store.findById(ctx.a.environmentId, live.id)).not.toBeNull()
      expect(await ctx.store.findById(ctx.b.environmentId, foreign.id)).not.toBeNull()
    })

    test('a purge removes at most its limit per call, and another environment’s purge removes none', async () => {
      const past = -7_200_000
      const expired = [1, 2, 3].map(() => attempt(ctx.a, { expiresAt: later(past) }))
      for (const input of expired) {
        await ctx.store.create(input)
      }
      // Environment B's purge, at a time when all of A's have expired, touches none of them.
      expect(await ctx.store.deleteExpired(ctx.b.environmentId, later(past), 100)).toBe(0)
      expect(await ctx.store.deleteExpired(ctx.a.environmentId, later(past), 2)).toBe(2)
      expect(await ctx.store.deleteExpired(ctx.a.environmentId, later(past), 2)).toBe(1)
      expect(await ctx.store.deleteExpired(ctx.a.environmentId, later(past), 2)).toBe(0)
    })

    test('one environment cannot read or move another’s attempts', async () => {
      const input = attempt(ctx.a)
      await ctx.store.create(input)
      const foreign = ctx.b.environmentId
      expect(await ctx.store.findById(foreign, input.id)).toBeNull()
      expect(
        await ctx.store.transition(
          foreign,
          input.id,
          'needs_password',
          { status: 'complete', completedAt: later(1) },
          later(1)
        )
      ).toBe(false)
      expect((await ctx.store.findById(ctx.a.environmentId, input.id))?.status).toBe(
        'needs_password'
      )
    })

    describe('a guarded transition (ADR 0026)', () => {
      const oauth = (phase: string) => ({ client: 'web', oauthPhase: phase })

      test('moves only while the stored state holds the guarded value', async () => {
        const input = attempt(ctx.a, { status: 'needs_first_factor', state: oauth('started') })
        await ctx.store.create(input)
        const move = (from: string, to: string) =>
          ctx.store.transition(
            ctx.a.environmentId,
            input.id,
            'needs_first_factor',
            { status: 'needs_first_factor', state: oauth(to) },
            now,
            { key: 'oauthPhase', value: from }
          )
        expect(await move('proven', 'exchanged')).toBe(false)
        expect(await move('started', 'returned')).toBe(true)
        expect(await move('started', 'returned')).toBe(false)
        expect((await ctx.store.findById(ctx.a.environmentId, input.id))?.state).toEqual(
          oauth('returned')
        )
      })

      test('of two concurrent guarded transitions exactly one succeeds, though the status does not change', async () => {
        const input = attempt(ctx.a, { status: 'needs_first_factor', state: oauth('started') })
        await ctx.store.create(input)
        const results = await Promise.all(
          [1, 2].map(() =>
            ctx.store.transition(
              ctx.a.environmentId,
              input.id,
              'needs_first_factor',
              { status: 'needs_first_factor', state: oauth('returned') },
              now,
              { key: 'oauthPhase', value: 'started' }
            )
          )
        )
        expect(results.filter(Boolean)).toHaveLength(1)
      })

      test('a guard on a key the state does not have matches nothing', async () => {
        const input = attempt(ctx.a, { status: 'needs_first_factor', state: { client: 'web' } })
        await ctx.store.create(input)
        expect(
          await ctx.store.transition(
            ctx.a.environmentId,
            input.id,
            'needs_first_factor',
            { status: 'needs_first_factor' },
            now,
            { key: 'oauthPhase', value: 'started' }
          )
        ).toBe(false)
      })

      test('a transition can replace the secret’s hash, and otherwise keeps it', async () => {
        const input = attempt(ctx.a, { status: 'needs_first_factor', secretHash: 'a'.repeat(64) })
        await ctx.store.create(input)
        const move = (change: { secretHash?: string }) =>
          ctx.store.transition(
            ctx.a.environmentId,
            input.id,
            'needs_first_factor',
            { status: 'needs_first_factor', ...change },
            now
          )
        await move({})
        expect((await ctx.store.findById(ctx.a.environmentId, input.id))?.secretHash).toBe(
          'a'.repeat(64)
        )
        await move({ secretHash: 'b'.repeat(64) })
        expect((await ctx.store.findById(ctx.a.environmentId, input.id))?.secretHash).toBe(
          'b'.repeat(64)
        )
      })
    })
  })
}
