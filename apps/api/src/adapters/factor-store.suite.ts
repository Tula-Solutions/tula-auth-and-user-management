import { beforeEach, describe, expect, test } from 'bun:test'
import type { ActivityType } from '@tula/contract'
import type { Activity, ActivityLog } from '~/ports/activity-log'
import type { FactorStore, NewBackupCode, NewFactor } from '~/ports/factor-store'

/** A tenant plus the rows the store's foreign keys need. */
export interface FactorSuiteTenant {
  projectId: string
  environmentId: string
  /** Create a user (a real row for Postgres) and return its id. */
  user: () => Promise<string>
}

/** What a store under test provides. */
export interface FactorSuiteContext {
  store: FactorStore
  /** The audit log the store records into. */
  log: ActivityLog
  a: FactorSuiteTenant
  b: FactorSuiteTenant
}

/**
 * Behaviour every `FactorStore` must have. Run against each adapter so the memory store used by
 * unit tests can't drift from Postgres.
 *
 * @param name - Adapter name for the report.
 * @param setup - Builds a fresh context; called before each test.
 */
export function describeFactorStore(name: string, setup: () => Promise<FactorSuiteContext>): void {
  describe(`${name} (FactorStore)`, () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    const later = (ms: number) => new Date(now.getTime() + ms)
    const TTL = 600_000
    let ctx: FactorSuiteContext

    beforeEach(async () => {
      ctx = await setup()
    })

    function pending(
      tenant: FactorSuiteTenant,
      userId: string,
      overrides: Partial<NewFactor> = {}
    ): NewFactor {
      const id = Bun.randomUUIDv7()
      return {
        id,
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        userId,
        type: 'totp',
        secret: `sealed-${id}`,
        createdAt: now,
        expiresAt: later(TTL),
        ...overrides,
      }
    }

    const codes = (count: number): NewBackupCode[] =>
      Array.from({ length: count }, () => ({
        id: Bun.randomUUIDv7(),
        codeHash: `hash-${Bun.randomUUIDv7()}`,
      }))

    function activity(tenant: FactorSuiteTenant, type: ActivityType, userId: string): Activity {
      return {
        id: Bun.randomUUIDv7(),
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        type,
        actor: { type: 'user', id: userId },
        target: { type: 'user', id: userId },
        ipAddress: '203.0.113.7',
        userAgent: 'suite/1.0',
        data: { method: 'totp' },
        occurredAt: now,
      }
    }

    /** Types recorded about one user. */
    async function recorded(tenant: FactorSuiteTenant, userId: string): Promise<string[]> {
      const { entries } = await ctx.log.listAudit(tenant.environmentId, {
        targetId: userId,
        page: 1,
        size: 100,
      })
      return entries.map((entry) => entry.type).sort()
    }

    /** A user with a pending enrolment. */
    async function started(tenant: FactorSuiteTenant, overrides: Partial<NewFactor> = {}) {
      const userId = overrides.userId ?? (await tenant.user())
      const factor = pending(tenant, userId, overrides)
      expect(await ctx.store.startTotp(factor)).toBe(true)
      return { userId, factor }
    }

    /** A user with a confirmed factor (last used step 100) and three backup codes. */
    async function confirmed(tenant: FactorSuiteTenant) {
      const { userId, factor } = await started(tenant)
      const backup = codes(3)
      expect(
        await ctx.store.confirmTotp(tenant.environmentId, factor.id, {
          step: 100,
          at: later(1_000),
          backupCodes: backup,
        })
      ).toBe(true)
      return { userId, factor, backup }
    }

    describe('startTotp and findTotp', () => {
      test('stores a pending factor and finds it with nothing confirmed or used', async () => {
        const { userId, factor } = await started(ctx.a)
        expect(await ctx.store.findTotp(ctx.a.environmentId, userId)).toEqual({
          ...factor,
          confirmedAt: null,
          lastUsedStep: null,
        })
        expect(await ctx.store.findTotp(ctx.a.environmentId, await ctx.a.user())).toBeNull()
        expect(await recorded(ctx.a, userId)).toEqual([])
      })

      test('starting again replaces the pending factor: the earlier secret is gone', async () => {
        const { userId, factor: first } = await started(ctx.a)
        const second = pending(ctx.a, userId, {
          createdAt: later(5_000),
          expiresAt: later(TTL * 2),
        })
        expect(await ctx.store.startTotp(second)).toBe(true)
        expect(await ctx.store.findTotp(ctx.a.environmentId, userId)).toEqual({
          ...second,
          confirmedAt: null,
          lastUsedStep: null,
        })
        // The earlier enrolment can no longer be confirmed.
        expect(
          await ctx.store.confirmTotp(ctx.a.environmentId, first.id, {
            step: 1,
            at: later(6_000),
            backupCodes: codes(1),
          })
        ).toBe(false)
        expect(await ctx.store.countBackupCodes(ctx.a.environmentId, userId)).toBe(0)
      })

      test('two concurrent starts both succeed and leave one pending factor: neither is told a factor is on', async () => {
        const userId = await ctx.a.user()
        const [first, second] = [pending(ctx.a, userId), pending(ctx.a, userId)]
        expect(
          await Promise.all([ctx.store.startTotp(first), ctx.store.startTotp(second)])
        ).toEqual([true, true])
        const kept = await ctx.store.findTotp(ctx.a.environmentId, userId)
        expect(kept?.confirmedAt).toBeNull()
        expect([first.id, second.id]).toContain(kept?.id as string)
        expect(kept?.secret).toBe(kept?.id === first.id ? first.secret : second.secret)
      })

      test('an expired pending factor is replaced like any other pending one', async () => {
        const { userId } = await started(ctx.a, { expiresAt: later(1) })
        const fresh = pending(ctx.a, userId, {
          createdAt: later(TTL * 3),
          expiresAt: later(TTL * 4),
        })
        expect(await ctx.store.startTotp(fresh)).toBe(true)
        expect((await ctx.store.findTotp(ctx.a.environmentId, userId))?.id).toBe(fresh.id)
      })

      test('is refused over a confirmed factor, which is left exactly as it was', async () => {
        const { userId, factor, backup } = await confirmed(ctx.a)
        const before = await ctx.store.findTotp(ctx.a.environmentId, userId)
        expect(await ctx.store.startTotp(pending(ctx.a, userId))).toBe(false)
        expect(await ctx.store.findTotp(ctx.a.environmentId, userId)).toEqual(before)
        expect(before).toMatchObject({ id: factor.id, secret: factor.secret })
        expect(await ctx.store.countBackupCodes(ctx.a.environmentId, userId)).toBe(backup.length)
      })
    })

    describe('confirmTotp', () => {
      test('confirms a pending factor, marks the step used, stores the codes and records the activity', async () => {
        const { userId, factor } = await started(ctx.a)
        const entry = activity(ctx.a, 'user.mfa_enabled', userId)
        expect(
          await ctx.store.confirmTotp(ctx.a.environmentId, factor.id, {
            step: 58_000_000,
            at: later(1_000),
            backupCodes: codes(10),
            activity: entry,
          })
        ).toBe(true)
        expect(await ctx.store.findTotp(ctx.a.environmentId, userId)).toEqual({
          ...factor,
          confirmedAt: later(1_000),
          expiresAt: null,
          lastUsedStep: 58_000_000,
        })
        expect(await ctx.store.countBackupCodes(ctx.a.environmentId, userId)).toBe(10)
        expect(await recorded(ctx.a, userId)).toEqual(['user.mfa_enabled'])
      })

      test('confirms without an activity, recording nothing', async () => {
        const { userId } = await confirmed(ctx.a)
        expect(await recorded(ctx.a, userId)).toEqual([])
      })

      test('an enrolment is refused from the moment it lapses, and confirmed one millisecond before', async () => {
        const { userId, factor } = await started(ctx.a)
        const attempt = (at: Date) =>
          ctx.store.confirmTotp(ctx.a.environmentId, factor.id, {
            step: 1,
            at,
            backupCodes: codes(2),
            activity: activity(ctx.a, 'user.mfa_enabled', userId),
          })
        expect(await attempt(later(TTL + 1))).toBe(false)
        expect(await attempt(later(TTL))).toBe(false)
        // Nothing was written by the refusals.
        expect(await ctx.store.findTotp(ctx.a.environmentId, userId)).toMatchObject({
          confirmedAt: null,
          lastUsedStep: null,
          expiresAt: later(TTL),
        })
        expect(await ctx.store.countBackupCodes(ctx.a.environmentId, userId)).toBe(0)
        expect(await recorded(ctx.a, userId)).toEqual([])

        expect(await attempt(later(TTL - 1))).toBe(true)
        expect(await recorded(ctx.a, userId)).toEqual(['user.mfa_enabled'])
      })

      test('a confirmed factor is not confirmed again: its codes, step and record stay', async () => {
        const { userId, factor, backup } = await confirmed(ctx.a)
        expect(
          await ctx.store.confirmTotp(ctx.a.environmentId, factor.id, {
            step: 999,
            at: later(2_000),
            backupCodes: codes(10),
            activity: activity(ctx.a, 'user.mfa_enabled', userId),
          })
        ).toBe(false)
        expect(await ctx.store.findTotp(ctx.a.environmentId, userId)).toMatchObject({
          confirmedAt: later(1_000),
          lastUsedStep: 100,
        })
        expect(await ctx.store.countBackupCodes(ctx.a.environmentId, userId)).toBe(backup.length)
        // The first set of codes still works: it was not replaced.
        expect(
          await ctx.store.consumeBackupCode(
            ctx.a.environmentId,
            userId,
            backup[0]?.codeHash as string,
            later(3_000)
          )
        ).toBe(2)
        expect(await recorded(ctx.a, userId)).toEqual([])
      })

      test('an unknown factor id confirms nothing', async () => {
        expect(
          await ctx.store.confirmTotp(ctx.a.environmentId, Bun.randomUUIDv7(), {
            step: 1,
            at: now,
            backupCodes: [],
          })
        ).toBe(false)
      })

      test('of concurrent confirmations exactly one succeeds, with exactly one set of codes', async () => {
        const { userId, factor } = await started(ctx.a)
        const sets = Array.from({ length: 5 }, () => codes(10))
        const results = await Promise.all(
          sets.map((backupCodes, index) =>
            ctx.store.confirmTotp(ctx.a.environmentId, factor.id, {
              step: 200 + index,
              at: later(1_000),
              backupCodes,
              activity: activity(ctx.a, 'user.mfa_enabled', userId),
            })
          )
        )
        expect(results.filter(Boolean)).toHaveLength(1)
        const winner = results.indexOf(true)
        expect(await ctx.store.countBackupCodes(ctx.a.environmentId, userId)).toBe(10)
        expect((await ctx.store.findTotp(ctx.a.environmentId, userId))?.lastUsedStep).toBe(
          200 + winner
        )
        expect(await recorded(ctx.a, userId)).toEqual(['user.mfa_enabled'])
        // Only the winner's codes exist.
        for (const [index, set] of sets.entries()) {
          const spent = await ctx.store.consumeBackupCode(
            ctx.a.environmentId,
            userId,
            set[0]?.codeHash as string,
            later(2_000)
          )
          expect(spent === null).toBe(index !== winner)
        }
      })
    })

    describe('useTotpStep', () => {
      test('a step is used once: the same step again writes nothing', async () => {
        const { userId, factor } = await confirmed(ctx.a)
        const use = (step: number) =>
          ctx.store.useTotpStep(ctx.a.environmentId, factor.id, step, later(2_000))
        expect(await use(101)).toBe(true)
        expect(await use(101)).toBe(false)
        expect((await ctx.store.findTotp(ctx.a.environmentId, userId))?.lastUsedStep).toBe(101)
      })

      test('the step that confirmed the enrolment is already used', async () => {
        const { factor } = await confirmed(ctx.a)
        expect(await ctx.store.useTotpStep(ctx.a.environmentId, factor.id, 100, later(2_000))).toBe(
          false
        )
      })

      test('of concurrent uses of one step exactly one succeeds', async () => {
        const { factor } = await confirmed(ctx.a)
        const results = await Promise.all(
          Array.from({ length: 6 }, () =>
            ctx.store.useTotpStep(ctx.a.environmentId, factor.id, 150, later(2_000))
          )
        )
        expect(results.filter(Boolean)).toHaveLength(1)
      })

      test('an earlier step is refused after a later one was used', async () => {
        const { userId, factor } = await confirmed(ctx.a)
        const use = (step: number) =>
          ctx.store.useTotpStep(ctx.a.environmentId, factor.id, step, later(2_000))
        expect(await use(103)).toBe(true)
        expect(await use(102)).toBe(false)
        expect(await use(101)).toBe(false)
        expect(await use(104)).toBe(true)
        expect((await ctx.store.findTotp(ctx.a.environmentId, userId))?.lastUsedStep).toBe(104)
      })

      test('a pending factor accepts no step', async () => {
        const { userId, factor } = await started(ctx.a)
        expect(await ctx.store.useTotpStep(ctx.a.environmentId, factor.id, 5, later(1))).toBe(false)
        expect((await ctx.store.findTotp(ctx.a.environmentId, userId))?.lastUsedStep).toBeNull()
      })

      test('an unknown factor id accepts no step', async () => {
        expect(await ctx.store.useTotpStep(ctx.a.environmentId, Bun.randomUUIDv7(), 5, now)).toBe(
          false
        )
      })
    })

    describe('removeForUser', () => {
      test('removes a confirmed factor and every backup code, and records the activity', async () => {
        const { userId, backup } = await confirmed(ctx.a)
        const bystander = await confirmed(ctx.a)
        expect(
          await ctx.store.removeForUser(
            ctx.a.environmentId,
            userId,
            activity(ctx.a, 'user.mfa_disabled', userId)
          )
        ).toBe(true)
        expect(await ctx.store.findTotp(ctx.a.environmentId, userId)).toBeNull()
        expect(await ctx.store.countBackupCodes(ctx.a.environmentId, userId)).toBe(0)
        expect(
          await ctx.store.consumeBackupCode(
            ctx.a.environmentId,
            userId,
            backup[0]?.codeHash as string,
            later(5_000)
          )
        ).toBeNull()
        expect(await recorded(ctx.a, userId)).toEqual(['user.mfa_disabled'])
        // Another user's factor and codes are untouched.
        expect(await ctx.store.findTotp(ctx.a.environmentId, bystander.userId)).not.toBeNull()
        expect(await ctx.store.countBackupCodes(ctx.a.environmentId, bystander.userId)).toBe(3)
      })

      test('removes a pending factor without reporting or recording a removal', async () => {
        const { userId } = await started(ctx.a)
        expect(
          await ctx.store.removeForUser(
            ctx.a.environmentId,
            userId,
            activity(ctx.a, 'user.mfa_disabled', userId)
          )
        ).toBe(false)
        expect(await ctx.store.findTotp(ctx.a.environmentId, userId)).toBeNull()
        expect(await recorded(ctx.a, userId)).toEqual([])
      })

      test('a user with nothing enrolled: nothing removed, nothing recorded', async () => {
        const userId = await ctx.a.user()
        expect(
          await ctx.store.removeForUser(
            ctx.a.environmentId,
            userId,
            activity(ctx.a, 'user.mfa_disabled', userId)
          )
        ).toBe(false)
        expect(await recorded(ctx.a, userId)).toEqual([])
      })

      test('removes a confirmed factor without an activity, recording nothing', async () => {
        const { userId } = await confirmed(ctx.a)
        expect(await ctx.store.removeForUser(ctx.a.environmentId, userId)).toBe(true)
        expect(await recorded(ctx.a, userId)).toEqual([])
      })

      test('guarded by a factor id: another factor of the user, and its codes, survive', async () => {
        const { userId, factor, backup } = await confirmed(ctx.a)
        const entry = activity(ctx.a, 'user.mfa_disabled', userId)
        // Not the row the caller means: nothing is removed and nothing recorded.
        expect(
          await ctx.store.removeForUser(ctx.a.environmentId, userId, entry, Bun.randomUUIDv7())
        ).toBe(false)
        expect((await ctx.store.findTotp(ctx.a.environmentId, userId))?.id).toBe(factor.id)
        expect(await ctx.store.countBackupCodes(ctx.a.environmentId, userId)).toBe(backup.length)
        expect(await recorded(ctx.a, userId)).toEqual([])
        // The row the caller means goes, with the codes.
        expect(await ctx.store.removeForUser(ctx.a.environmentId, userId, entry, factor.id)).toBe(
          true
        )
        expect(await ctx.store.findTotp(ctx.a.environmentId, userId)).toBeNull()
        expect(await ctx.store.countBackupCodes(ctx.a.environmentId, userId)).toBe(0)
        expect(await recorded(ctx.a, userId)).toEqual(['user.mfa_disabled'])
      })

      test('after a removal the user can enrol again', async () => {
        const { userId } = await confirmed(ctx.a)
        await ctx.store.removeForUser(ctx.a.environmentId, userId)
        expect(await ctx.store.startTotp(pending(ctx.a, userId))).toBe(true)
      })
    })

    describe('replaceBackupCodes', () => {
      const scope = (tenant: FactorSuiteTenant) => ({ projectId: tenant.projectId })

      test('replaces every code of a user with a confirmed factor and records the activity', async () => {
        const { userId, backup } = await confirmed(ctx.a)
        const fresh = codes(10)
        expect(
          await ctx.store.replaceBackupCodes(
            ctx.a.environmentId,
            userId,
            scope(ctx.a),
            fresh,
            later(5_000),
            activity(ctx.a, 'user.backup_codes_regenerated', userId)
          )
        ).toBe(true)
        expect(await ctx.store.countBackupCodes(ctx.a.environmentId, userId)).toBe(10)
        const consume = (codeHash: string) =>
          ctx.store.consumeBackupCode(ctx.a.environmentId, userId, codeHash, later(6_000))
        for (const old of backup) {
          expect(await consume(old.codeHash)).toBeNull()
        }
        expect(await consume(fresh[0]?.codeHash as string)).toBe(9)
        expect(await recorded(ctx.a, userId)).toEqual(['user.backup_codes_regenerated'])
      })

      test('used codes are replaced too: the count is the new set’s', async () => {
        const { userId, backup } = await confirmed(ctx.a)
        await ctx.store.consumeBackupCode(
          ctx.a.environmentId,
          userId,
          backup[0]?.codeHash as string,
          later(2_000)
        )
        expect(
          await ctx.store.replaceBackupCodes(
            ctx.a.environmentId,
            userId,
            scope(ctx.a),
            codes(4),
            later(5_000)
          )
        ).toBe(true)
        expect(await ctx.store.countBackupCodes(ctx.a.environmentId, userId)).toBe(4)
        expect(await recorded(ctx.a, userId)).toEqual([])
      })

      test('is refused for a user with no factor or only a pending one: nothing stored or recorded', async () => {
        const nobody = await ctx.a.user()
        const { userId: enrolling } = await started(ctx.a)
        for (const userId of [nobody, enrolling]) {
          expect(
            await ctx.store.replaceBackupCodes(
              ctx.a.environmentId,
              userId,
              scope(ctx.a),
              codes(10),
              later(5_000),
              activity(ctx.a, 'user.backup_codes_regenerated', userId)
            )
          ).toBe(false)
          expect(await ctx.store.countBackupCodes(ctx.a.environmentId, userId)).toBe(0)
          expect(await recorded(ctx.a, userId)).toEqual([])
        }
      })
    })

    describe('consumeBackupCode and countBackupCodes', () => {
      test('spends a code once, says how many are left and records the activity', async () => {
        const { userId, backup } = await confirmed(ctx.a)
        const consume = (index: number) =>
          ctx.store.consumeBackupCode(
            ctx.a.environmentId,
            userId,
            backup[index]?.codeHash as string,
            later(2_000),
            activity(ctx.a, 'user.backup_code_used', userId)
          )
        expect(await ctx.store.countBackupCodes(ctx.a.environmentId, userId)).toBe(3)
        expect(await consume(0)).toBe(2)
        expect(await consume(0)).toBeNull()
        expect(await consume(1)).toBe(1)
        expect(await consume(2)).toBe(0)
        expect(await consume(2)).toBeNull()
        expect(await ctx.store.countBackupCodes(ctx.a.environmentId, userId)).toBe(0)
        // One entry per code spent, none for the refusals.
        expect(await recorded(ctx.a, userId)).toEqual(Array(3).fill('user.backup_code_used'))
      })

      test('of concurrent submissions of one code exactly one spends it', async () => {
        const { userId, backup } = await confirmed(ctx.a)
        const results = await Promise.all(
          Array.from({ length: 6 }, () =>
            ctx.store.consumeBackupCode(
              ctx.a.environmentId,
              userId,
              backup[0]?.codeHash as string,
              later(2_000),
              activity(ctx.a, 'user.backup_code_used', userId)
            )
          )
        )
        expect(results.filter((result) => result !== null)).toEqual([2])
        expect(await ctx.store.countBackupCodes(ctx.a.environmentId, userId)).toBe(2)
        expect(await recorded(ctx.a, userId)).toEqual(['user.backup_code_used'])
      })

      test('a code belongs to its user: another user cannot spend it', async () => {
        const owner = await confirmed(ctx.a)
        const other = await confirmed(ctx.a)
        const hash = owner.backup[0]?.codeHash as string
        expect(
          await ctx.store.consumeBackupCode(
            ctx.a.environmentId,
            other.userId,
            hash,
            later(2_000),
            activity(ctx.a, 'user.backup_code_used', other.userId)
          )
        ).toBeNull()
        expect(await recorded(ctx.a, other.userId)).toEqual([])
        expect(await ctx.store.countBackupCodes(ctx.a.environmentId, other.userId)).toBe(3)
        expect(
          await ctx.store.consumeBackupCode(ctx.a.environmentId, owner.userId, hash, now)
        ).toBe(2)
      })

      test('an unknown hash spends nothing and records nothing', async () => {
        const { userId } = await confirmed(ctx.a)
        expect(
          await ctx.store.consumeBackupCode(
            ctx.a.environmentId,
            userId,
            'hash-unknown',
            later(2_000),
            activity(ctx.a, 'user.backup_code_used', userId)
          )
        ).toBeNull()
        expect(await ctx.store.countBackupCodes(ctx.a.environmentId, userId)).toBe(3)
        expect(await recorded(ctx.a, userId)).toEqual([])
      })

      test('a user with no codes has none', async () => {
        expect(await ctx.store.countBackupCodes(ctx.a.environmentId, await ctx.a.user())).toBe(0)
      })
    })

    describe('deleteExpiredPending', () => {
      // Times earlier than any other test's, because a shared database keeps their rows.
      const DAY = 86_400_000
      const lapsed = later(-50 * DAY)
      const cutoff = later(-40 * DAY)

      test('purges lapsed enrolments in batches, and nothing else', async () => {
        const old = await Promise.all(
          [0, 1, 2].map(() => started(ctx.a, { createdAt: later(-51 * DAY), expiresAt: lapsed }))
        )
        const atCutoff = await started(ctx.a, { createdAt: later(-41 * DAY), expiresAt: cutoff })
        const afterCutoff = await started(ctx.a, {
          createdAt: later(-41 * DAY),
          expiresAt: new Date(cutoff.getTime() + 1),
        })
        const valid = await started(ctx.a)
        const done = await confirmed(ctx.a)
        const foreign = await started(ctx.b, { createdAt: later(-51 * DAY), expiresAt: lapsed })

        expect(
          await ctx.store.deleteExpiredPending(ctx.a.environmentId, later(-50 * DAY - 1), 100)
        ).toBe(0)
        expect(await ctx.store.deleteExpiredPending(ctx.a.environmentId, cutoff, 3)).toBe(3)
        expect(await ctx.store.deleteExpiredPending(ctx.a.environmentId, cutoff, 3)).toBe(1)
        expect(await ctx.store.deleteExpiredPending(ctx.a.environmentId, cutoff, 3)).toBe(0)

        for (const gone of [...old, atCutoff]) {
          expect(await ctx.store.findTotp(ctx.a.environmentId, gone.userId)).toBeNull()
        }
        // Lapsing after the cutoff, still valid, or confirmed: kept.
        for (const kept of [afterCutoff, valid, done]) {
          expect(await ctx.store.findTotp(ctx.a.environmentId, kept.userId)).not.toBeNull()
        }
        expect(await ctx.store.countBackupCodes(ctx.a.environmentId, done.userId)).toBe(3)
        // Environment A's purge never touched environment B's lapsed enrolment.
        expect(await ctx.store.findTotp(ctx.b.environmentId, foreign.userId)).not.toBeNull()
        expect(await ctx.store.deleteExpiredPending(ctx.b.environmentId, cutoff, 100)).toBe(1)
      })

      test('a confirmed factor is never purged, however far the cutoff', async () => {
        const { userId } = await confirmed(ctx.a)
        await ctx.store.deleteExpiredPending(ctx.a.environmentId, later(3_650 * DAY), 1_000)
        expect(await ctx.store.findTotp(ctx.a.environmentId, userId)).toMatchObject({
          confirmedAt: later(1_000),
        })
        expect(await ctx.store.countBackupCodes(ctx.a.environmentId, userId)).toBe(3)
      })
    })

    test('one environment cannot read, confirm, use, replace, spend or remove another’s factors', async () => {
      const enrolling = await started(ctx.a)
      const { userId, factor, backup } = await confirmed(ctx.a)
      const foreign = ctx.b.environmentId
      const hash = backup[0]?.codeHash as string

      expect(await ctx.store.findTotp(foreign, userId)).toBeNull()
      expect(await ctx.store.countBackupCodes(foreign, userId)).toBe(0)
      expect(
        await ctx.store.confirmTotp(foreign, enrolling.factor.id, {
          step: 1,
          at: later(1_000),
          backupCodes: [],
          activity: activity(ctx.b, 'user.mfa_enabled', enrolling.userId),
        })
      ).toBe(false)
      expect(await ctx.store.useTotpStep(foreign, factor.id, 500, later(2_000))).toBe(false)
      expect(
        await ctx.store.replaceBackupCodes(
          foreign,
          userId,
          { projectId: ctx.b.projectId },
          [],
          later(2_000),
          activity(ctx.b, 'user.backup_codes_regenerated', userId)
        )
      ).toBe(false)
      expect(
        await ctx.store.consumeBackupCode(
          foreign,
          userId,
          hash,
          later(2_000),
          activity(ctx.b, 'user.backup_code_used', userId)
        )
      ).toBeNull()
      expect(
        await ctx.store.removeForUser(foreign, userId, activity(ctx.b, 'user.mfa_disabled', userId))
      ).toBe(false)
      expect(await ctx.store.deleteExpiredPending(foreign, later(TTL * 10), 100)).toBe(0)

      // Everything in environment A is as it was, and nothing was recorded in either.
      expect(await ctx.store.findTotp(ctx.a.environmentId, userId)).toMatchObject({
        id: factor.id,
        confirmedAt: later(1_000),
        lastUsedStep: 100,
      })
      expect(await ctx.store.findTotp(ctx.a.environmentId, enrolling.userId)).toMatchObject({
        confirmedAt: null,
      })
      expect(await ctx.store.countBackupCodes(ctx.a.environmentId, userId)).toBe(3)
      for (const tenant of [ctx.a, ctx.b]) {
        expect(await recorded(tenant, userId)).toEqual([])
        expect(await recorded(tenant, enrolling.userId)).toEqual([])
      }
      expect(
        await ctx.store.consumeBackupCode(ctx.a.environmentId, userId, hash, later(3_000))
      ).toBe(2)
    })
  })
}
