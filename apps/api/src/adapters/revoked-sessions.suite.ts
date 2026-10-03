import { beforeEach, describe, expect, test } from 'bun:test'
import type { FixedClock } from '~/adapters/memory/clock'
import type { RevokedSessions } from '~/ports/revoked-sessions'

/** What a revoked-session list under test provides. */
export interface RevokedSessionsSuiteContext {
  list: RevokedSessions
  /**
   * A second API instance reading the same storage. For process memory, which is not shared,
   * this is the same object as `list`.
   */
  peer: RevokedSessions
  clock: FixedClock
}

/**
 * Behaviour every `RevokedSessions` must have. Run against each adapter so the memory list used
 * by unit tests can't drift from Redis.
 *
 * @param name - Adapter name for the report.
 * @param setup - Builds a fresh context; called before each test.
 */
export function describeRevokedSessions(
  name: string,
  setup: () => Promise<RevokedSessionsSuiteContext>
): void {
  describe(`${name} (RevokedSessions)`, () => {
    let ctx: RevokedSessionsSuiteContext
    let sessionId: string

    beforeEach(async () => {
      ctx = await setup()
      sessionId = Bun.randomUUIDv7()
    })

    function later(ms: number): Date {
      return new Date(ctx.clock.now().getTime() + ms)
    }

    test('reports a revoked session until its access tokens have expired', async () => {
      await ctx.list.add(sessionId, later(60_000))
      expect(await ctx.list.has(sessionId, ctx.clock.now())).toBe(true)
      expect(await ctx.list.has(Bun.randomUUIDv7(), ctx.clock.now())).toBe(false)
      ctx.clock.advance(59_999)
      expect(await ctx.list.has(sessionId, ctx.clock.now())).toBe(true)
      ctx.clock.advance(1)
      expect(await ctx.list.has(sessionId, ctx.clock.now())).toBe(false)
    })

    test('re-adding never shortens an entry', async () => {
      await ctx.list.add(sessionId, later(60_000))
      await ctx.list.add(sessionId, later(10_000))
      ctx.clock.advance(30_000)
      expect(await ctx.list.has(sessionId, ctx.clock.now())).toBe(true)
    })

    test('re-adding with a later expiry extends an entry', async () => {
      await ctx.list.add(sessionId, later(10_000))
      await ctx.list.add(sessionId, later(60_000))
      ctx.clock.advance(30_000)
      expect(await ctx.list.has(sessionId, ctx.clock.now())).toBe(true)
    })

    test('an entry whose time has already passed revokes nothing', async () => {
      await ctx.list.add(sessionId, later(-1))
      expect(await ctx.list.has(sessionId, ctx.clock.now())).toBe(false)
    })

    test('a session revoked through one instance is refused by the other', async () => {
      expect(await ctx.peer.has(sessionId, ctx.clock.now())).toBe(false)
      await ctx.list.add(sessionId, later(60_000))
      expect(await ctx.peer.has(sessionId, ctx.clock.now())).toBe(true)
    })

    test('concurrent additions from two instances keep the longest entry', async () => {
      await Promise.all(
        [5_000, 60_000, 20_000, 40_000].map((ms, i) =>
          (i % 2 === 0 ? ctx.list : ctx.peer).add(sessionId, later(ms))
        )
      )
      ctx.clock.advance(59_999)
      expect(await ctx.peer.has(sessionId, ctx.clock.now())).toBe(true)
      ctx.clock.advance(1)
      expect(await ctx.list.has(sessionId, ctx.clock.now())).toBe(false)
    })
  })
}
