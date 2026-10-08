import { beforeEach, describe, expect, test } from 'bun:test'
import type { FixedClock } from '~/adapters/memory/clock'
import { CREDENTIAL_LOCKOUT, type Lockout, type LockoutPolicy } from '~/ports/lockout'

/** What a lockout under test provides. */
export interface LockoutSuiteContext {
  lockout: Lockout
  /**
   * A second API instance counting in the same storage. For process memory, which is not
   * shared, this is the same object as `lockout`.
   */
  peer: Lockout
  clock: FixedClock
}

/** A short schedule so the suite reads easily: 3 free tries, then 1s, 2s, 4s, 8s, 8s… */
export const SUITE_LOCKOUT_POLICY: LockoutPolicy = {
  freeAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 8_000,
  forgetAfterMs: 60_000,
}

/**
 * Behaviour every `Lockout` must have. Run against each adapter so the memory lockout used by
 * unit tests can't drift from Redis.
 *
 * @param name - Adapter name for the report.
 * @param setup - Builds a fresh context; called before each test.
 */
export function describeLockout(name: string, setup: () => Promise<LockoutSuiteContext>): void {
  describe(`${name} (Lockout)`, () => {
    const policy = SUITE_LOCKOUT_POLICY
    let ctx: LockoutSuiteContext
    let key: string

    beforeEach(async () => {
      ctx = await setup()
      // A fresh key per test: a real Redis keeps the previous test's failures.
      key = `suite:${Bun.randomUUIDv7()}`
    })

    function attempt(on: Lockout = ctx.lockout, target: string = key) {
      return on.attempt(target, policy, ctx.clock.now())
    }

    test('allows the free attempts, then imposes a doubling wait', async () => {
      for (let i = 0; i < 3; i++) {
        expect(await attempt()).toEqual({ allowed: true, retryAfterMs: 0 })
      }
      // The 4th attempt is allowed and starts the first wait.
      expect(await attempt()).toEqual({ allowed: true, retryAfterMs: 0 })
      expect(await attempt()).toEqual({ allowed: false, retryAfterMs: 1_000 })
      ctx.clock.advance(999)
      expect(await attempt()).toEqual({ allowed: false, retryAfterMs: 1 })
      ctx.clock.advance(1)
      expect((await attempt()).allowed).toBe(true)
      expect(await attempt()).toEqual({ allowed: false, retryAfterMs: 2_000 })
    })

    test('refused attempts are not counted, so waiting is never extended by retrying', async () => {
      for (let i = 0; i < 4; i++) {
        await attempt()
      }
      for (let i = 0; i < 50; i++) {
        expect((await attempt()).allowed).toBe(false)
      }
      ctx.clock.advance(1_000)
      expect((await attempt()).allowed).toBe(true)
      // Still the second wait (2s), not one inflated by the 50 refused tries.
      expect(await attempt()).toEqual({ allowed: false, retryAfterMs: 2_000 })
    })

    test('the wait is capped, however many failures there are', async () => {
      const waits: number[] = []
      for (let i = 0; i < 40; i++) {
        const decision = await attempt()
        if (!decision.allowed) {
          waits.push(decision.retryAfterMs)
          ctx.clock.advance(decision.retryAfterMs)
        }
      }
      expect(waits.slice(0, 5)).toEqual([1_000, 2_000, 4_000, 8_000, 8_000])
      expect(Math.max(...waits)).toBe(8_000)
    })

    test('concurrent attempts cannot exceed the free attempts plus one', async () => {
      const decisions = await Promise.all(Array.from({ length: 50 }, () => attempt()))
      expect(decisions.filter((decision) => decision.allowed)).toHaveLength(4)
    })

    test('clear forgets the failures', async () => {
      for (let i = 0; i < 4; i++) {
        await attempt()
      }
      expect((await attempt()).allowed).toBe(false)
      await ctx.lockout.clear(key)
      for (let i = 0; i < 3; i++) {
        expect((await attempt()).allowed).toBe(true)
      }
      await ctx.lockout.clear(`${key}:never-seen`)
    })

    test('failures are forgotten after a quiet period', async () => {
      for (let i = 0; i < 3; i++) {
        await attempt()
      }
      ctx.clock.advance(59_999)
      // Not yet forgotten: this is the 4th failure and starts a wait.
      await attempt()
      expect((await attempt()).allowed).toBe(false)

      // The quiet period runs from the end of that 1s wait.
      ctx.clock.advance(1_000 + 59_999)
      expect((await attempt()).allowed).toBe(true)
      expect((await attempt()).allowed).toBe(false)

      ctx.clock.advance(2_000 + 60_000)
      for (let i = 0; i < 3; i++) {
        expect((await attempt()).allowed).toBe(true)
      }
    })

    test('keys are independent', async () => {
      for (let i = 0; i < 5; i++) {
        await attempt()
      }
      expect((await attempt()).allowed).toBe(false)
      expect((await attempt(ctx.lockout, `${key}:other`)).allowed).toBe(true)
    })

    test('an attempt is counted once, whichever instance takes it', async () => {
      // Four failures spread over two instances are four failures, not two on each.
      expect((await attempt(ctx.lockout)).allowed).toBe(true)
      expect((await attempt(ctx.peer)).allowed).toBe(true)
      expect((await attempt(ctx.lockout)).allowed).toBe(true)
      expect((await attempt(ctx.peer)).allowed).toBe(true)
      expect(await attempt(ctx.lockout)).toEqual({ allowed: false, retryAfterMs: 1_000 })
      expect(await attempt(ctx.peer)).toEqual({ allowed: false, retryAfterMs: 1_000 })
    })

    test('concurrent attempts across two instances cannot exceed the free attempts plus one', async () => {
      const decisions = await Promise.all(
        Array.from({ length: 50 }, (_, i) => attempt(i % 2 === 0 ? ctx.lockout : ctx.peer))
      )
      expect(decisions.filter((decision) => decision.allowed)).toHaveLength(4)
    })

    test('a success on one instance clears the failures seen by the other', async () => {
      for (let i = 0; i < 4; i++) {
        await attempt(ctx.lockout)
      }
      expect((await attempt(ctx.peer)).allowed).toBe(false)
      await ctx.peer.clear(key)
      expect((await attempt(ctx.lockout)).allowed).toBe(true)
    })

    test('the credential policy answers 5 guesses at once, 5 more within 15 minutes, then 4 an hour', async () => {
      const start = ctx.clock.now().getTime()
      const answeredAt: number[] = []
      // Guess as fast as the lockout allows for two hours.
      while (ctx.clock.now().getTime() - start < 2 * 3_600_000) {
        const decision = await ctx.lockout.attempt(key, CREDENTIAL_LOCKOUT, ctx.clock.now())
        if (decision.allowed) {
          answeredAt.push((ctx.clock.now().getTime() - start) / 1000)
        } else {
          ctx.clock.advance(decision.retryAfterMs)
        }
      }
      expect(answeredAt.slice(0, 10)).toEqual([0, 0, 0, 0, 0, 0, 30, 90, 210, 450])
      expect(answeredAt.filter((t) => t < 900)).toHaveLength(CREDENTIAL_LOCKOUT.freeAttempts + 5)
      expect(answeredAt.filter((t) => t >= 3_600)).toHaveLength(4)
    })
  })
}
