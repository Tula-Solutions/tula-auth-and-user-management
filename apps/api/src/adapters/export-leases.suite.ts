import { beforeEach, describe, expect, test } from 'bun:test'
import type { FixedClock } from '~/adapters/memory/clock'
import type { ExportLeases } from '~/ports/export-leases'

/** What an export-lease store under test provides. */
export interface ExportLeasesSuiteContext {
  leases: ExportLeases
  /**
   * A second API instance on the same storage. For process memory, which is not shared, this
   * is the same object as `leases`.
   */
  peer: ExportLeases
  clock: FixedClock
  /**
   * Whether the storage forgets by the test clock. A real Redis expires keys by its own
   * clock, so the tests that move time are skipped for it.
   */
  movesTime: boolean
}

const TTL = 60_000

/**
 * Behaviour every `ExportLeases` must have. Run against each adapter so the memory store used
 * by unit tests can't drift from Redis.
 *
 * @param name - Adapter name for the report.
 * @param setup - Builds a fresh context; called before each test.
 */
export function describeExportLeases(
  name: string,
  setup: () => Promise<ExportLeasesSuiteContext>
): void {
  describe(`${name} (ExportLeases)`, () => {
    let ctx: ExportLeasesSuiteContext
    let env: string

    beforeEach(async () => {
      ctx = await setup()
      env = Bun.randomUUIDv7()
    })

    test('grants up to the limit, then refuses', async () => {
      expect(await ctx.leases.acquire(env, 2, TTL)).toBeString()
      expect(await ctx.leases.acquire(env, 2, TTL)).toBeString()
      expect(await ctx.leases.acquire(env, 2, TTL)).toBeNull()
    })

    test('the limit is shared by instances', async () => {
      await ctx.leases.acquire(env, 2, TTL)
      await ctx.peer.acquire(env, 2, TTL)
      expect(await ctx.leases.acquire(env, 2, TTL)).toBeNull()
      expect(await ctx.peer.acquire(env, 2, TTL)).toBeNull()
    })

    test('concurrent acquires across instances yield exactly the limit', async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => (i % 2 ? ctx.leases : ctx.peer).acquire(env, 3, TTL))
      )
      expect(results.filter((id) => id !== null)).toHaveLength(3)
    })

    test('environments count apart', async () => {
      await ctx.leases.acquire(env, 1, TTL)
      expect(await ctx.leases.acquire(Bun.randomUUIDv7(), 1, TTL)).toBeString()
    })

    test('a released slot can be taken again, from either instance', async () => {
      const first = await ctx.leases.acquire(env, 1, TTL)
      expect(await ctx.peer.acquire(env, 1, TTL)).toBeNull()
      await ctx.peer.release(env, first as string)
      expect(await ctx.leases.acquire(env, 1, TTL)).toBeString()
    })

    test('releasing twice, or an unknown lease, frees nothing else', async () => {
      const first = await ctx.leases.acquire(env, 2, TTL)
      await ctx.leases.acquire(env, 2, TTL)
      await ctx.leases.release(env, first as string)
      await ctx.leases.release(env, first as string)
      await ctx.leases.release(env, 'unknown')
      expect(await ctx.leases.acquire(env, 2, TTL)).toBeString()
      expect(await ctx.leases.acquire(env, 2, TTL)).toBeNull()
    })

    test('a live lease renews, and a released one does not', async () => {
      const id = (await ctx.leases.acquire(env, 1, TTL)) as string
      expect(await ctx.peer.renew(env, id, TTL)).toBe(true)
      await ctx.leases.release(env, id)
      expect(await ctx.leases.renew(env, id, TTL)).toBe(false)
    })

    test('a lease that is not renewed expires, and a renewed one outlasts it', async () => {
      if (!ctx.movesTime) {
        return
      }
      const dead = await ctx.leases.acquire(env, 2, TTL)
      const kept = (await ctx.leases.acquire(env, 2, TTL)) as string
      expect(dead).toBeString()
      ctx.clock.advance(TTL - 1)
      expect(await ctx.leases.renew(env, kept, TTL)).toBe(true)
      ctx.clock.advance(2)
      // `dead` expired; `kept` still holds a slot.
      expect(await ctx.leases.acquire(env, 2, TTL)).toBeString()
      expect(await ctx.leases.acquire(env, 2, TTL)).toBeNull()
      expect(await ctx.leases.renew(env, dead as string, TTL)).toBe(false)
    })
  })
}
