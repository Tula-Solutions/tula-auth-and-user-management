import { beforeEach, describe, expect, test } from 'bun:test'
import type { FixedClock } from '~/adapters/memory/clock'
import type { RateLimiter } from '~/ports/rate-limiter'

/** What a rate limiter under test provides. */
export interface RateLimiterSuiteContext {
  limiter: RateLimiter
  /**
   * A second API instance counting in the same storage. For process memory, which is not
   * shared, this is the same object as `limiter`.
   */
  peer: RateLimiter
  /** The clock both instances read. */
  clock: FixedClock
}

/**
 * Behaviour every `RateLimiter` must have. Run against each adapter so the memory limiter used
 * by unit tests can't drift from Redis.
 *
 * @param name - Adapter name for the report.
 * @param setup - Builds a fresh context; called before each test.
 */
export function describeRateLimiter(
  name: string,
  setup: () => Promise<RateLimiterSuiteContext>
): void {
  describe(`${name} (RateLimiter)`, () => {
    let ctx: RateLimiterSuiteContext
    let key: string

    beforeEach(async () => {
      ctx = await setup()
      // A fresh bucket per test: a real Redis keeps the previous test's counts.
      key = `suite:ip:${Bun.randomUUIDv7()}`
    })

    test('allows up to the limit per window, then reports time to reset', async () => {
      expect(await ctx.limiter.hit(key, 2, 60_000)).toEqual({
        allowed: true,
        remaining: 1,
        retryAfterMs: 60_000,
      })
      expect(await ctx.limiter.hit(key, 2, 60_000)).toEqual({
        allowed: true,
        remaining: 0,
        retryAfterMs: 60_000,
      })
      ctx.clock.advance('15s')
      expect(await ctx.limiter.hit(key, 2, 60_000)).toEqual({
        allowed: false,
        remaining: 0,
        retryAfterMs: 45_000,
      })
    })

    test('buckets are independent', async () => {
      await ctx.limiter.hit(key, 1, 60_000)
      expect((await ctx.limiter.hit(key, 1, 60_000)).allowed).toBe(false)
      expect((await ctx.limiter.hit(`${key}:other`, 1, 60_000)).allowed).toBe(true)
    })

    test('starts a new window once the old one ends', async () => {
      await ctx.limiter.hit(key, 1, 1_000)
      ctx.clock.advance(999)
      expect(await ctx.limiter.hit(key, 1, 1_000)).toEqual({
        allowed: false,
        remaining: 0,
        retryAfterMs: 1,
      })
      ctx.clock.advance(1)
      expect(await ctx.limiter.hit(key, 1, 1_000)).toEqual({
        allowed: true,
        remaining: 0,
        retryAfterMs: 1_000,
      })
    })

    test('a window keeps the length it was opened with', async () => {
      await ctx.limiter.hit(key, 5, 1_000)
      ctx.clock.advance(400)
      expect((await ctx.limiter.hit(key, 5, 60_000)).retryAfterMs).toBe(600)
    })

    test('requests refused over the limit keep being refused until the window ends', async () => {
      for (let i = 0; i < 10; i++) {
        await ctx.limiter.hit(key, 3, 10_000)
      }
      ctx.clock.advance(9_999)
      expect((await ctx.limiter.hit(key, 3, 10_000)).allowed).toBe(false)
    })

    test('a second instance counts in the same window', async () => {
      expect((await ctx.limiter.hit(key, 2, 60_000)).remaining).toBe(1)
      expect((await ctx.peer.hit(key, 2, 60_000)).remaining).toBe(0)
      expect((await ctx.limiter.hit(key, 2, 60_000)).allowed).toBe(false)
      expect((await ctx.peer.hit(key, 2, 60_000)).allowed).toBe(false)
    })

    test('concurrent hits across two instances never exceed the limit', async () => {
      const decisions = await Promise.all(
        Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? ctx.limiter : ctx.peer)).map(
          (instance) => instance.hit(key, 10, 60_000)
        )
      )
      const allowed = decisions.filter((decision) => decision.allowed)
      expect(allowed).toHaveLength(10)
      // Each allowed request took a different slot: none was counted twice or skipped.
      expect(allowed.map((decision) => decision.remaining).sort((a, b) => a - b)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
      ])
    })
  })
}
