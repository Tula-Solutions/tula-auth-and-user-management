import { beforeEach, describe, expect, test } from 'bun:test'
import type { FixedClock } from '~/adapters/memory/clock'
import type { ProofReplayGuard } from '~/ports/proof-replay'

/** What a replay guard under test provides. */
export interface ProofReplaySuiteContext {
  guard: ProofReplayGuard
  /**
   * A second API instance on the same storage. For process memory, which is not shared, this
   * is the same object as `guard`.
   */
  peer: ProofReplayGuard
  clock: FixedClock
  /**
   * How long past `until` an adapter may still remember an id (Redis keeps a key a little
   * longer, for instances whose clocks disagree). Zero for process memory.
   */
  allowanceMs: number
  /**
   * Whether the storage forgets by the test clock. A real Redis expires keys by its own
   * clock, so the tests that move time are skipped for it.
   */
  movesTime: boolean
}

/**
 * Behaviour every `ProofReplayGuard` must have. Run against each adapter so the memory guard
 * used by unit tests can't drift from Redis.
 *
 * @param name - Adapter name for the report.
 * @param setup - Builds a fresh context; called before each test.
 */
export function describeProofReplayGuard(
  name: string,
  setup: () => Promise<ProofReplaySuiteContext>
): void {
  describe(`${name} (ProofReplayGuard)`, () => {
    let ctx: ProofReplaySuiteContext
    let id: string

    beforeEach(async () => {
      ctx = await setup()
      id = Bun.randomUUIDv7()
    })

    function later(ms: number): Date {
      return new Date(ctx.clock.now().getTime() + ms)
    }

    test('an id is new once, and a replay after that', async () => {
      expect(await ctx.guard.remember(id, later(60_000))).toBe(true)
      expect(await ctx.guard.remember(id, later(60_000))).toBe(false)
      expect(await ctx.guard.remember(id, later(600_000))).toBe(false)
    })

    test('another id is not a replay', async () => {
      expect(await ctx.guard.remember(id, later(60_000))).toBe(true)
      expect(await ctx.guard.remember(Bun.randomUUIDv7(), later(60_000))).toBe(true)
    })

    test('an id is remembered for as long as it was asked to be', async () => {
      if (!ctx.movesTime) {
        return
      }
      await ctx.guard.remember(id, later(60_000))
      ctx.clock.advance(59_999)
      expect(await ctx.guard.remember(id, later(60_000))).toBe(false)
    })

    test('an id is forgotten once its time, and the allowance, have passed', async () => {
      if (!ctx.movesTime) {
        return
      }
      await ctx.guard.remember(id, later(60_000))
      ctx.clock.advance(60_000 + ctx.allowanceMs)
      expect(await ctx.guard.remember(id, later(60_000))).toBe(true)
    })

    test('a refused replay does not lengthen the entry', async () => {
      if (!ctx.movesTime) {
        return
      }
      await ctx.guard.remember(id, later(60_000))
      await ctx.guard.remember(id, later(3_600_000))
      ctx.clock.advance(60_000 + ctx.allowanceMs)
      expect(await ctx.guard.remember(id, later(60_000))).toBe(true)
    })

    test('an id accepted through one instance is a replay on the other', async () => {
      expect(await ctx.guard.remember(id, later(60_000))).toBe(true)
      expect(await ctx.peer.remember(id, later(60_000))).toBe(false)
    })

    test('of several at once, on two instances, exactly one is new', async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          (i % 2 === 0 ? ctx.guard : ctx.peer).remember(id, later(60_000))
        )
      )
      expect(results.filter(Boolean)).toHaveLength(1)
    })
  })
}
