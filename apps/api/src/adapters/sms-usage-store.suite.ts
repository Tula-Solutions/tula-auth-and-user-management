import { beforeEach, describe, expect, test } from 'bun:test'
import type { SmsUsageScope, SmsUsageStore } from '~/ports/sms-usage-store'

/** What the store under test provides. */
export interface SmsUsageSuiteContext {
  store: SmsUsageStore
  a: SmsUsageScope
  b: SmsUsageScope
}

/**
 * Behaviour every `SmsUsageStore` must have. Run against each adapter so the memory store
 * used by unit tests can't drift from Postgres.
 *
 * @param name - Adapter name for the report.
 * @param setup - Builds a fresh context; called before each test.
 */
export function describeSmsUsageStore(
  name: string,
  setup: () => Promise<SmsUsageSuiteContext>
): void {
  const at = new Date('2026-10-08T12:00:00.000Z')
  const DAY = '2026-10-08'
  const NEXT = '2026-10-09'
  const BEFORE = '2026-10-07'
  let ctx: SmsUsageSuiteContext

  // The scope of a real-server fixture carries helpers of its own: only its two ids are taken.
  const scope = (tenant: SmsUsageScope): SmsUsageScope => ({
    projectId: tenant.projectId,
    environmentId: tenant.environmentId,
  })

  async function sent(tenant: SmsUsageScope, day: string, prefix: string, times = 1) {
    for (let i = 0; i < times; i += 1) {
      await ctx.store.recordSent(scope(tenant), day, prefix, at)
    }
  }

  describe(`${name} SMS usage store`, () => {
    beforeEach(async () => {
      ctx = await setup()
    })

    test('an environment that sent nothing has no counts', async () => {
      expect(await ctx.store.summary(ctx.a.environmentId, BEFORE, 10)).toEqual({
        sent: 0,
        used: 0,
        prefixes: [],
        truncated: false,
      })
    })

    test('sent codes are counted per prefix, and a used one against its own prefix and day', async () => {
      await sent(ctx.a, DAY, '+1', 3)
      await sent(ctx.a, DAY, '+49')
      await ctx.store.recordUsed(ctx.a.environmentId, DAY, '+1', at)
      expect(await ctx.store.summary(ctx.a.environmentId, DAY, 10)).toEqual({
        sent: 4,
        used: 1,
        prefixes: [
          { prefix: '+1', sent: 3, used: 1 },
          { prefix: '+49', sent: 1, used: 0 },
        ],
        truncated: false,
      })
    })

    test('no more codes are used than were sent, and none where none was sent', async () => {
      await sent(ctx.a, DAY, '+1')
      await ctx.store.recordUsed(ctx.a.environmentId, DAY, '+1', at)
      await ctx.store.recordUsed(ctx.a.environmentId, DAY, '+1', at)
      // Another day, and another prefix, of which nothing was sent.
      await ctx.store.recordUsed(ctx.a.environmentId, NEXT, '+1', at)
      await ctx.store.recordUsed(ctx.a.environmentId, DAY, '+44', at)
      expect(await ctx.store.summary(ctx.a.environmentId, BEFORE, 10)).toEqual({
        sent: 1,
        used: 1,
        prefixes: [{ prefix: '+1', sent: 1, used: 1 }],
        truncated: false,
      })
    })

    test('a span adds the days from its first on, and leaves out the days before', async () => {
      await sent(ctx.a, BEFORE, '+1', 5)
      await sent(ctx.a, DAY, '+1', 2)
      await sent(ctx.a, NEXT, '+1')
      await ctx.store.recordUsed(ctx.a.environmentId, NEXT, '+1', at)
      expect(await ctx.store.summary(ctx.a.environmentId, DAY, 10)).toEqual({
        sent: 3,
        used: 1,
        prefixes: [{ prefix: '+1', sent: 3, used: 1 }],
        truncated: false,
      })
      expect((await ctx.store.summary(ctx.a.environmentId, BEFORE, 10)).sent).toBe(8)
    })

    test('the prefixes with the most unused codes come first, and the list is cut at the limit', async () => {
      // Unused: +3 has 3, +2 has 2 (of 4 sent), +1 has 2 (of 2 sent), +4 has 1.
      await sent(ctx.a, DAY, '+3', 3)
      await sent(ctx.a, DAY, '+2', 4)
      await ctx.store.recordUsed(ctx.a.environmentId, DAY, '+2', at)
      await ctx.store.recordUsed(ctx.a.environmentId, DAY, '+2', at)
      await sent(ctx.a, DAY, '+1', 2)
      await sent(ctx.a, DAY, '+4')
      const all = await ctx.store.summary(ctx.a.environmentId, DAY, 10)
      // A tie in unused codes goes to the prefix that was sent more, then to the smaller one.
      expect(all.prefixes.map((entry) => entry.prefix)).toEqual(['+3', '+2', '+1', '+4'])
      expect(all.truncated).toBe(false)
      const cut = await ctx.store.summary(ctx.a.environmentId, DAY, 2)
      expect(cut.prefixes.map((entry) => entry.prefix)).toEqual(['+3', '+2'])
      expect(cut.truncated).toBe(true)
      // The totals are of every prefix, listed or not.
      expect(cut).toMatchObject({ sent: 10, used: 2 })
      expect((await ctx.store.summary(ctx.a.environmentId, DAY, 4)).truncated).toBe(false)
    })

    test('one environment’s counts are not another’s', async () => {
      await sent(ctx.a, DAY, '+1', 2)
      await sent(ctx.b, DAY, '+1')
      await ctx.store.recordUsed(ctx.b.environmentId, DAY, '+1', at)
      expect(await ctx.store.summary(ctx.a.environmentId, DAY, 10)).toMatchObject({
        sent: 2,
        used: 0,
      })
      expect(await ctx.store.summary(ctx.b.environmentId, DAY, 10)).toMatchObject({
        sent: 1,
        used: 1,
      })
    })

    test('a day’s count is of every prefix, of that day and of that environment', async () => {
      expect(await ctx.store.sentOn(ctx.a.environmentId, DAY)).toBe(0)
      await sent(ctx.a, DAY, '+1', 2)
      await sent(ctx.a, DAY, '+1242')
      await sent(ctx.a, BEFORE, '+1', 4)
      await sent(ctx.a, NEXT, '+49')
      await sent(ctx.b, DAY, '+1', 7)
      // A used code is still a sent one.
      await ctx.store.recordUsed(ctx.a.environmentId, DAY, '+1', at)
      expect(await ctx.store.sentOn(ctx.a.environmentId, DAY)).toBe(3)
      expect(await ctx.store.sentOn(ctx.a.environmentId, NEXT)).toBe(1)
      expect(await ctx.store.sentOn(ctx.b.environmentId, DAY)).toBe(7)
    })

    test('a code that was not sent after all is taken back, never below the used ones', async () => {
      await sent(ctx.a, DAY, '+1', 2)
      await ctx.store.recordUsed(ctx.a.environmentId, DAY, '+1', at)
      await ctx.store.recordNotSent(ctx.a.environmentId, DAY, '+1', at)
      expect(await ctx.store.sentOn(ctx.a.environmentId, DAY)).toBe(1)
      // The one left was used: nothing more to take back.
      await ctx.store.recordNotSent(ctx.a.environmentId, DAY, '+1', at)
      // Another day, another prefix and another environment, of which nothing was counted.
      await ctx.store.recordNotSent(ctx.a.environmentId, NEXT, '+1', at)
      await ctx.store.recordNotSent(ctx.a.environmentId, DAY, '+44', at)
      await ctx.store.recordNotSent(ctx.b.environmentId, DAY, '+1', at)
      expect(await ctx.store.summary(ctx.a.environmentId, BEFORE, 10)).toEqual({
        sent: 1,
        used: 1,
        prefixes: [{ prefix: '+1', sent: 1, used: 1 }],
        truncated: false,
      })
    })

    test.each([
      ['a whole number', '+14155550100'],
      ['five digits', '+14155'],
      ['no plus', '141555'],
      ['nothing', ''],
      ['a letter', '+1415a'],
    ])('%s is not stored as a prefix', async (_name, prefix) => {
      const outcome = await ctx.store.recordSent(scope(ctx.a), DAY, prefix, at).then(
        () => 'stored',
        () => 'refused'
      )
      expect(outcome).toBe('refused')
      expect((await ctx.store.summary(ctx.a.environmentId, BEFORE, 10)).sent).toBe(0)
    })

    test('counts of days before a day are deleted in batches, in one environment only', async () => {
      await sent(ctx.a, BEFORE, '+1')
      await sent(ctx.a, BEFORE, '+2')
      await sent(ctx.a, BEFORE, '+3')
      await sent(ctx.a, DAY, '+1')
      await sent(ctx.b, BEFORE, '+1')
      expect(await ctx.store.deleteBefore(ctx.a.environmentId, DAY, 2)).toBe(2)
      expect(await ctx.store.deleteBefore(ctx.a.environmentId, DAY, 2)).toBe(1)
      expect(await ctx.store.deleteBefore(ctx.a.environmentId, DAY, 2)).toBe(0)
      // The day itself is kept, and so is the other environment's.
      expect((await ctx.store.summary(ctx.a.environmentId, BEFORE, 10)).sent).toBe(1)
      expect((await ctx.store.summary(ctx.b.environmentId, BEFORE, 10)).sent).toBe(1)
    })
  })
}
