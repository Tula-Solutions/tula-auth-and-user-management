import { beforeEach, describe, expect, test } from 'bun:test'
import type { ActivityType } from '@tula/contract'
import * as Audit from '~/modules/audit/service'
import type { Activity, ActivityLog } from '~/ports/activity-log'
import type { PasskeyChallengeRecord, PasskeyRecord, PasskeyStore } from '~/ports/passkey-store'
import type { SignInMeans } from '~/ports/user-repository'

/** A tenant plus the rows the store's foreign keys need. */
export interface PasskeySuiteTenant {
  projectId: string
  environmentId: string
  /** Create a user with no password, no verified address and no identity; return its id. */
  user: () => Promise<string>
}

/** What a store under test provides. */
export interface PasskeySuiteContext {
  store: PasskeyStore
  /** The audit log the store records into. */
  log: ActivityLog
  a: PasskeySuiteTenant
  b: PasskeySuiteTenant
}

/**
 * Behaviour every `PasskeyStore` must have. Run against each adapter so the memory store used
 * by unit tests can't drift from Postgres.
 *
 * @param name - Adapter name for the report.
 * @param setup - Builds a fresh context; called before each test.
 */
export function describePasskeyStore(
  name: string,
  setup: () => Promise<PasskeySuiteContext>
): void {
  describe(`${name} (PasskeyStore)`, () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    const later = (ms: number) => new Date(now.getTime() + ms)
    let ctx: PasskeySuiteContext

    beforeEach(async () => {
      ctx = await setup()
    })

    function passkey(
      tenant: PasskeySuiteTenant,
      userId: string,
      overrides: Partial<PasskeyRecord> = {}
    ): PasskeyRecord {
      const id = Bun.randomUUIDv7()
      return {
        id,
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        userId,
        credentialId: `credential-${id}`,
        publicKey: new Uint8Array([0xa5, 0x01, 0x02, 0x00, 0xff, 0x80]),
        signCount: 0,
        transports: ['internal', 'hybrid'],
        aaguid: '00000000-0000-0000-0000-000000000000',
        backupEligible: false,
        backedUp: false,
        userHandle: `handle-${userId}`,
        name: 'Passkey',
        lastUsedAt: null,
        createdAt: now,
        ...overrides,
      }
    }

    function challenge(
      tenant: PasskeySuiteTenant,
      userId: string,
      overrides: Partial<PasskeyChallengeRecord> = {}
    ): PasskeyChallengeRecord {
      return {
        id: Bun.randomUUIDv7(),
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        userId,
        sessionId: Bun.randomUUIDv7(),
        purpose: 'registration',
        challenge: `challenge-${Bun.randomUUIDv7()}`,
        expiresAt: later(300_000),
        createdAt: now,
        ...overrides,
      }
    }

    function activity(tenant: PasskeySuiteTenant, type: ActivityType, userId: string): Activity {
      return {
        id: Bun.randomUUIDv7(),
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        type,
        actor: { type: 'user', id: userId },
        target: { type: 'user', id: userId },
        ipAddress: '203.0.113.7',
        userAgent: 'suite/1.0',
        data: {},
        occurredAt: now,
      }
    }

    const auditOf = async (tenant: PasskeySuiteTenant, userId: string) =>
      (
        await ctx.log.listAudit(tenant.environmentId, { targetId: userId, page: 1, size: 50 })
      ).entries.map((entry) => entry.type)

    const anyway = () => true

    describe('passkeys', () => {
      test('a stored passkey reads back exactly, by user and by credential id', async () => {
        const userId = await ctx.a.user()
        const record = passkey(ctx.a, userId, { signCount: 2 ** 33, backupEligible: true })
        expect(await ctx.store.create(record, 10, Audit.none('fixture'))).toBe('created')
        expect(await ctx.store.listForUser(ctx.a.environmentId, userId)).toEqual([record])
        const found = await ctx.store.findByCredentialId(ctx.a.environmentId, record.credentialId)
        expect(found).toEqual(record)
        expect(found?.publicKey).toBeInstanceOf(Uint8Array)
      })

      test('passkeys are listed oldest first, and only the user’s own', async () => {
        const userId = await ctx.a.user()
        const other = await ctx.a.user()
        const second = passkey(ctx.a, userId, { createdAt: later(2_000), name: 'second' })
        const first = passkey(ctx.a, userId, { createdAt: later(1_000), name: 'first' })
        await ctx.store.create(second, 10, Audit.none('fixture'))
        await ctx.store.create(first, 10, Audit.none('fixture'))
        await ctx.store.create(passkey(ctx.a, other), 10, Audit.none('fixture'))
        expect(
          (await ctx.store.listForUser(ctx.a.environmentId, userId)).map((row) => row.name)
        ).toEqual(['first', 'second'])
      })

      test('a credential id is unique in its environment, and free in another', async () => {
        const userId = await ctx.a.user()
        const other = await ctx.a.user()
        const record = passkey(ctx.a, userId)
        const entry = activity(ctx.a, 'user.passkey_added', other)
        expect(await ctx.store.create(record, 10, Audit.none('fixture'))).toBe('created')
        expect(
          await ctx.store.create(
            passkey(ctx.a, other, { credentialId: record.credentialId }),
            10,
            entry
          )
        ).toBe('duplicate')
        expect(await auditOf(ctx.a, other)).toEqual([])
        const elsewhere = await ctx.b.user()
        expect(
          await ctx.store.create(
            passkey(ctx.b, elsewhere, { credentialId: record.credentialId }),
            10,
            Audit.none('fixture')
          )
        ).toBe('created')
        // And each environment finds only its own.
        expect(
          (await ctx.store.findByCredentialId(ctx.b.environmentId, record.credentialId))?.userId
        ).toBe(elsewhere)
      })

      test('the limit is enforced with the insert, and records nothing when it refuses', async () => {
        const userId = await ctx.a.user()
        expect(await ctx.store.create(passkey(ctx.a, userId), 2, Audit.none('fixture'))).toBe(
          'created'
        )
        expect(
          await ctx.store.create(
            passkey(ctx.a, userId),
            2,
            activity(ctx.a, 'user.passkey_added', userId)
          )
        ).toBe('created')
        expect(
          await ctx.store.create(
            passkey(ctx.a, userId),
            2,
            activity(ctx.a, 'user.passkey_added', userId)
          )
        ).toBe('limit')
        expect(await ctx.store.listForUser(ctx.a.environmentId, userId)).toHaveLength(2)
        expect(await auditOf(ctx.a, userId)).toEqual(['user.passkey_added'])
      })

      test('another environment sees none of it', async () => {
        const userId = await ctx.a.user()
        const record = passkey(ctx.a, userId)
        await ctx.store.create(record, 10, Audit.none('fixture'))
        expect(await ctx.store.listForUser(ctx.b.environmentId, userId)).toEqual([])
        expect(
          await ctx.store.findByCredentialId(ctx.b.environmentId, record.credentialId)
        ).toBeNull()
        expect(
          await ctx.store.rename(
            ctx.b.environmentId,
            userId,
            record.id,
            'stolen',
            later(1),
            Audit.none('fixture')
          )
        ).toBe(false)
        expect(
          await ctx.store.remove(
            ctx.b.environmentId,
            userId,
            record.id,
            anyway,
            Audit.none('fixture')
          )
        ).toBe('not_found')
        expect(
          await ctx.store.removeForUser(ctx.b.environmentId, userId, Audit.none('fixture'))
        ).toBe(0)
        expect(
          await ctx.store.recordUse(ctx.b.environmentId, record.id, {
            expectedSignCount: 0,
            signCount: 1,
            backupEligible: false,
            backedUp: false,
            at: later(1),
          })
        ).toBe(false)
        expect(await ctx.store.listForUser(ctx.a.environmentId, userId)).toEqual([record])
      })

      test('a use is recorded once per expected counter', async () => {
        const userId = await ctx.a.user()
        const record = passkey(ctx.a, userId, { signCount: 4 })
        await ctx.store.create(record, 10, Audit.none('fixture'))
        const use = {
          expectedSignCount: 4,
          signCount: 5,
          backupEligible: true,
          backedUp: true,
          at: later(5_000),
        }
        const outcomes = await Promise.all([
          ctx.store.recordUse(ctx.a.environmentId, record.id, use),
          ctx.store.recordUse(ctx.a.environmentId, record.id, use),
        ])
        expect(outcomes.sort()).toEqual([false, true])
        expect(
          await ctx.store.findByCredentialId(ctx.a.environmentId, record.credentialId)
        ).toMatchObject({
          signCount: 5,
          backupEligible: true,
          backedUp: true,
          lastUsedAt: later(5_000),
        })
        expect(await ctx.store.recordUse(ctx.a.environmentId, Bun.randomUUIDv7(), use)).toBe(false)
      })

      test('an authenticator without a counter can be used again and again', async () => {
        const userId = await ctx.a.user()
        const record = passkey(ctx.a, userId)
        await ctx.store.create(record, 10, Audit.none('fixture'))
        for (const at of [later(1_000), later(2_000)]) {
          expect(
            await ctx.store.recordUse(ctx.a.environmentId, record.id, {
              expectedSignCount: 0,
              signCount: 0,
              backupEligible: false,
              backedUp: false,
              at,
            })
          ).toBe(true)
        }
      })

      test('renaming changes the name of the owner’s passkey only, with its audit entry', async () => {
        const userId = await ctx.a.user()
        const other = await ctx.a.user()
        const record = passkey(ctx.a, userId)
        await ctx.store.create(record, 10, Audit.none('fixture'))
        expect(
          await ctx.store.rename(
            ctx.a.environmentId,
            other,
            record.id,
            'not mine',
            later(1),
            activity(ctx.a, 'user.passkey_renamed', other)
          )
        ).toBe(false)
        expect(await auditOf(ctx.a, other)).toEqual([])
        expect(
          await ctx.store.rename(
            ctx.a.environmentId,
            userId,
            record.id,
            'MacBook',
            later(1),
            activity(ctx.a, 'user.passkey_renamed', userId)
          )
        ).toBe(true)
        expect((await ctx.store.listForUser(ctx.a.environmentId, userId))[0]?.name).toBe('MacBook')
        expect(await auditOf(ctx.a, userId)).toEqual(['user.passkey_renamed'])
      })

      test('removing asks the caller with what would remain, and removes only when allowed', async () => {
        const userId = await ctx.a.user()
        const first = passkey(ctx.a, userId)
        const second = passkey(ctx.a, userId, { createdAt: later(1) })
        await ctx.store.create(first, 10, Audit.none('fixture'))
        await ctx.store.create(second, 10, Audit.none('fixture'))
        const seen: SignInMeans[] = []
        expect(
          await ctx.store.remove(
            ctx.a.environmentId,
            userId,
            first.id,
            (remaining) => {
              seen.push(remaining)
              return false
            },
            Audit.none('fixture')
          )
        ).toBe('last_method')
        expect(seen).toEqual([
          { hasPassword: false, emailVerified: false, providers: [], passkeys: 1 },
        ])
        expect(await ctx.store.listForUser(ctx.a.environmentId, userId)).toHaveLength(2)
        expect(
          await ctx.store.remove(
            ctx.a.environmentId,
            userId,
            first.id,
            anyway,
            activity(ctx.a, 'user.passkey_removed', userId)
          )
        ).toBe('removed')
        expect(await ctx.store.listForUser(ctx.a.environmentId, userId)).toEqual([second])
        expect(await auditOf(ctx.a, userId)).toEqual(['user.passkey_removed'])
        // Gone, another user's, and one that never existed: all the same.
        const other = await ctx.a.user()
        for (const [owner, id] of [
          [userId, first.id],
          [other, second.id],
          [userId, Bun.randomUUIDv7()],
        ] as const) {
          expect(
            await ctx.store.remove(ctx.a.environmentId, owner, id, anyway, Audit.none('fixture'))
          ).toBe('not_found')
        }
      })

      test('two removals at once cannot both rely on the other passkey remaining', async () => {
        const userId = await ctx.a.user()
        const first = passkey(ctx.a, userId)
        const second = passkey(ctx.a, userId, { createdAt: later(1) })
        await ctx.store.create(first, 10, Audit.none('fixture'))
        await ctx.store.create(second, 10, Audit.none('fixture'))
        const needsOne = (remaining: SignInMeans) => remaining.passkeys > 0
        const outcomes = await Promise.all([
          ctx.store.remove(ctx.a.environmentId, userId, first.id, needsOne, Audit.none('fixture')),
          ctx.store.remove(ctx.a.environmentId, userId, second.id, needsOne, Audit.none('fixture')),
        ])
        expect(outcomes.sort()).toEqual(['last_method', 'removed'])
        expect(await ctx.store.listForUser(ctx.a.environmentId, userId)).toHaveLength(1)
      })

      test('removing everything of a user removes passkeys and challenges, and records it once', async () => {
        const userId = await ctx.a.user()
        const kept = await ctx.a.user()
        await ctx.store.create(passkey(ctx.a, userId), 10, Audit.none('fixture'))
        await ctx.store.create(passkey(ctx.a, userId), 10, Audit.none('fixture'))
        const keptPasskey = passkey(ctx.a, kept)
        await ctx.store.create(keptPasskey, 10, Audit.none('fixture'))
        const pending = challenge(ctx.a, userId)
        await ctx.store.putChallenge(pending)
        expect(
          await ctx.store.removeForUser(
            ctx.a.environmentId,
            userId,
            activity(ctx.a, 'user.passkey_removed', userId)
          )
        ).toBe(2)
        expect(await ctx.store.listForUser(ctx.a.environmentId, userId)).toEqual([])
        expect(
          await ctx.store.takeChallenge(ctx.a.environmentId, pending.sessionId, 'registration', now)
        ).toBeNull()
        expect(await ctx.store.listForUser(ctx.a.environmentId, kept)).toEqual([keptPasskey])
        expect(await auditOf(ctx.a, userId)).toEqual(['user.passkey_removed'])
        // Nothing left: nothing removed and nothing recorded.
        expect(
          await ctx.store.removeForUser(
            ctx.a.environmentId,
            userId,
            activity(ctx.a, 'user.passkey_removed', userId)
          )
        ).toBe(0)
        expect(await auditOf(ctx.a, userId)).toEqual(['user.passkey_removed'])
      })

      test('a counter regression is recorded for a passkey that exists, and changes nothing', async () => {
        const userId = await ctx.a.user()
        const record = passkey(ctx.a, userId, { signCount: 9 })
        await ctx.store.create(record, 10, Audit.none('fixture'))
        await ctx.store.reportRegression(
          ctx.a.environmentId,
          record.id,
          activity(ctx.a, 'user.passkey_counter_regressed', userId)
        )
        await ctx.store.reportRegression(
          ctx.b.environmentId,
          record.id,
          activity(ctx.a, 'user.passkey_counter_regressed', userId)
        )
        expect(await auditOf(ctx.a, userId)).toEqual(['user.passkey_counter_regressed'])
        expect(await ctx.store.listForUser(ctx.a.environmentId, userId)).toEqual([record])
      })
    })

    describe('challenges', () => {
      test('a challenge is taken once, by its session and purpose', async () => {
        const userId = await ctx.a.user()
        const stored = challenge(ctx.a, userId)
        await ctx.store.putChallenge(stored)
        expect(
          await ctx.store.takeChallenge(ctx.a.environmentId, stored.sessionId, 'step_up', now)
        ).toBeNull()
        expect(
          await ctx.store.takeChallenge(
            ctx.a.environmentId,
            Bun.randomUUIDv7(),
            'registration',
            now
          )
        ).toBeNull()
        expect(
          await ctx.store.takeChallenge(ctx.b.environmentId, stored.sessionId, 'registration', now)
        ).toBeNull()
        const taken = await Promise.all([
          ctx.store.takeChallenge(ctx.a.environmentId, stored.sessionId, 'registration', now),
          ctx.store.takeChallenge(ctx.a.environmentId, stored.sessionId, 'registration', now),
        ])
        expect(taken.filter((value) => value !== null)).toEqual([
          { challenge: stored.challenge, userId },
        ])
      })

      test('asking again replaces the session’s challenge of that purpose only', async () => {
        const userId = await ctx.a.user()
        const sessionId = Bun.randomUUIDv7()
        const first = challenge(ctx.a, userId, { sessionId })
        const second = challenge(ctx.a, userId, { sessionId })
        const stepUp = challenge(ctx.a, userId, { sessionId, purpose: 'step_up' })
        await ctx.store.putChallenge(first)
        await ctx.store.putChallenge(stepUp)
        await ctx.store.putChallenge(second)
        expect(
          await ctx.store.takeChallenge(ctx.a.environmentId, sessionId, 'registration', now)
        ).toEqual({ challenge: second.challenge, userId })
        expect(
          await ctx.store.takeChallenge(ctx.a.environmentId, sessionId, 'step_up', now)
        ).toEqual({ challenge: stepUp.challenge, userId })
      })

      test('an expired challenge is not returned, and is gone afterwards', async () => {
        const userId = await ctx.a.user()
        const stored = challenge(ctx.a, userId)
        await ctx.store.putChallenge(stored)
        expect(
          await ctx.store.takeChallenge(
            ctx.a.environmentId,
            stored.sessionId,
            'registration',
            later(300_000)
          )
        ).toBeNull()
        expect(
          await ctx.store.takeChallenge(ctx.a.environmentId, stored.sessionId, 'registration', now)
        ).toBeNull()
      })

      test('the purge deletes expired challenges of one environment, a batch at a time', async () => {
        const userId = await ctx.a.user()
        const elsewhere = await ctx.b.user()
        const expired = [1, 2, 3].map((n) => challenge(ctx.a, userId, { expiresAt: later(n) }))
        const live = challenge(ctx.a, userId, { expiresAt: later(600_000) })
        const foreign = challenge(ctx.b, elsewhere, { expiresAt: later(1) })
        for (const stored of [...expired, live, foreign]) {
          await ctx.store.putChallenge(stored)
        }
        const cutoff = later(1_000)
        expect(await ctx.store.deleteExpiredChallenges(ctx.a.environmentId, cutoff, 2)).toBe(2)
        expect(await ctx.store.deleteExpiredChallenges(ctx.a.environmentId, cutoff, 2)).toBe(1)
        expect(await ctx.store.deleteExpiredChallenges(ctx.a.environmentId, cutoff, 2)).toBe(0)
        expect(
          await ctx.store.takeChallenge(ctx.a.environmentId, live.sessionId, 'registration', now)
        ).not.toBeNull()
        expect(
          await ctx.store.takeChallenge(ctx.b.environmentId, foreign.sessionId, 'registration', now)
        ).not.toBeNull()
      })
    })
  })
}
