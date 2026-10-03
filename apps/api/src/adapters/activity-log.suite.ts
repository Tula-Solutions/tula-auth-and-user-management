import { beforeEach, describe, expect, test } from 'bun:test'
import type { ActivityType, AuditTargetType } from '@tula/contract'
import { sha256Hex } from '~/lib/crypto'
import type { Activity, ActivityLog } from '~/ports/activity-log'
import type { ApiKeyRepository } from '~/ports/api-key-repository'
import type { SessionStore } from '~/ports/session-store'
import type { NewSigningKey, SigningKeyStore } from '~/ports/signing-key-store'
import type { UserRepository } from '~/ports/user-repository'

/** A tenant for the suite. */
export interface ActivitySuiteTenant {
  projectId: string
  environmentId: string
}

/** The log and every store that writes to it, all backed by the same storage. */
export interface ActivitySuiteContext {
  log: ActivityLog
  sessions: SessionStore
  users: UserRepository
  apiKeys: ApiKeyRepository
  signingKeys: SigningKeyStore
  a: ActivitySuiteTenant
  b: ActivitySuiteTenant
  /** A tenant nothing else uses (signing keys allow one active key per environment). */
  freshTenant: () => Promise<ActivitySuiteTenant>
}

/**
 * How activity must be recorded and read, for every adapter: each store records the activity it
 * is given if, and only if, its write took effect. Run against memory and Postgres so the stores
 * unit tests use can't drift from the real ones.
 *
 * @param name - Adapter name for the report.
 * @param setup - Builds a fresh context; called before each test.
 */
export function describeActivityLog(
  name: string,
  setup: () => Promise<ActivitySuiteContext>
): void {
  describe(`${name} (activity)`, () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    const later = (ms: number) => new Date(now.getTime() + ms)
    let ctx: ActivitySuiteContext

    beforeEach(async () => {
      ctx = await setup()
    })

    function activity(
      tenant: ActivitySuiteTenant,
      type: ActivityType,
      target: { type: AuditTargetType; id: string },
      overrides: Partial<Activity> = {}
    ): Activity {
      return {
        id: Bun.randomUUIDv7(),
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        type,
        actor: { type: 'admin', id: '00000000-0000-7000-8000-0000000000ad' },
        target,
        ipAddress: '203.0.113.7',
        userAgent: 'suite/1.0',
        data: { note: 'suite' },
        occurredAt: now,
        ...overrides,
      }
    }

    /** Types recorded about one target, oldest first. */
    async function recorded(tenant: ActivitySuiteTenant, targetId: string): Promise<string[]> {
      const { entries } = await ctx.log.listAudit(tenant.environmentId, {
        targetId,
        page: 1,
        size: 100,
      })
      return entries.map((entry) => entry.type).reverse()
    }

    function newUser(tenant: ActivitySuiteTenant) {
      const id = Bun.randomUUIDv7()
      return {
        id,
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        email: `${id}@northline.app`,
        emailNormalized: `${id}@northline.app`,
        emailVerifiedAt: null,
        firstName: null,
        lastName: null,
        createdAt: now,
        identityId: Bun.randomUUIDv7(),
        credentialId: Bun.randomUUIDv7(),
        passwordHash: '$argon2id$hash',
      }
    }

    async function seedUser(tenant: ActivitySuiteTenant): Promise<string> {
      const user = newUser(tenant)
      await ctx.users.create(user)
      return user.id
    }

    async function seedSession(tenant: ActivitySuiteTenant, userId: string, record?: Activity) {
      const id = Bun.randomUUIDv7()
      await ctx.sessions.create(
        {
          id,
          ...tenant,
          userId,
          profile: 'web',
          client: 'web',
          userAgent: null,
          ipAddress: null,
          lastActiveAt: now,
          idleExpiresAt: later(86_400_000),
          absoluteExpiresAt: null,
          createdAt: now,
        },
        {
          id: Bun.randomUUIDv7(),
          sessionId: id,
          tokenHash: sha256Hex(id),
          parentId: null,
          expiresAt: later(86_400_000),
          createdAt: now,
        },
        record
      )
      return id
    }

    test('reads back exactly what was recorded', async () => {
      const userId = await seedUser(ctx.a)
      const sessionId = Bun.randomUUIDv7()
      const entry = activity(ctx.a, 'session.created', { type: 'session', id: sessionId })
      await ctx.sessions.create(
        {
          id: sessionId,
          ...ctx.a,
          userId,
          profile: 'web',
          client: 'web',
          userAgent: null,
          ipAddress: null,
          lastActiveAt: now,
          idleExpiresAt: later(1_000),
          absoluteExpiresAt: null,
          createdAt: now,
        },
        {
          id: Bun.randomUUIDv7(),
          sessionId,
          tokenHash: sha256Hex(sessionId),
          parentId: null,
          expiresAt: later(1_000),
          createdAt: now,
        },
        entry
      )
      const { entries, totalCount } = await ctx.log.listAudit(ctx.a.environmentId, {
        targetId: sessionId,
        page: 1,
        size: 10,
      })
      expect(totalCount).toBe(1)
      expect(entries).toEqual([entry])
    })

    test('a write without an activity records nothing', async () => {
      const userId = await seedUser(ctx.a)
      const sessionId = await seedSession(ctx.a, userId)
      await ctx.sessions.revoke(ctx.a.environmentId, sessionId, 'sign_out', later(1))
      expect(await recorded(ctx.a, userId)).toEqual([])
      expect(await recorded(ctx.a, sessionId)).toEqual([])
    })

    test('revoking a session is recorded once, however often it is repeated', async () => {
      const sessionId = await seedSession(ctx.a, await seedUser(ctx.a))
      const target = { type: 'session' as const, id: sessionId }
      const revoke = () =>
        ctx.sessions.revoke(
          ctx.a.environmentId,
          sessionId,
          'sign_out',
          later(1),
          activity(ctx.a, 'session.revoked', target)
        )
      expect(await revoke()).toBe(true)
      expect(await revoke()).toBe(false)
      expect(await recorded(ctx.a, sessionId)).toEqual(['session.revoked'])
      // A session that does not exist in this environment records nothing either.
      await ctx.sessions.revoke(
        ctx.b.environmentId,
        sessionId,
        'sign_out',
        later(1),
        activity(ctx.b, 'session.revoked', target)
      )
      expect(await recorded(ctx.b, sessionId)).toEqual([])
    })

    test('revoking a user’s sessions records one entry per session that ended', async () => {
      const userId = await seedUser(ctx.a)
      const kept = await seedSession(ctx.a, userId)
      const ended = [await seedSession(ctx.a, userId), await seedSession(ctx.a, userId)]
      const already = await seedSession(ctx.a, userId)
      await ctx.sessions.revoke(ctx.a.environmentId, already, 'sign_out', now)

      const revoked = await ctx.sessions.revokeByUser(
        ctx.a.environmentId,
        userId,
        'password_changed',
        later(1),
        {
          exceptSessionId: kept,
          activity: (id) => activity(ctx.a, 'session.revoked', { type: 'session', id }),
        }
      )
      expect(revoked.sort()).toEqual([...ended].sort())
      for (const id of ended) {
        expect(await recorded(ctx.a, id)).toEqual(['session.revoked'])
      }
      expect(await recorded(ctx.a, kept)).toEqual([])
      expect(await recorded(ctx.a, already)).toEqual([])
    })

    test('creating a user is recorded; a taken email is not', async () => {
      const user = newUser(ctx.a)
      const target = { type: 'user' as const, id: user.id }
      expect(await ctx.users.create(user, activity(ctx.a, 'user.created', target))).toBe(true)
      const twin = { ...newUser(ctx.a), email: user.email, emailNormalized: user.emailNormalized }
      expect(
        await ctx.users.create(twin, activity(ctx.a, 'user.created', { type: 'user', id: twin.id }))
      ).toBe(false)
      expect(await recorded(ctx.a, user.id)).toEqual(['user.created'])
      expect(await recorded(ctx.a, twin.id)).toEqual([])
    })

    test('a first password is recorded as created; a replacement is not', async () => {
      const user = { ...newUser(ctx.a), passwordHash: null }
      await ctx.users.create(user)
      const target = { type: 'user' as const, id: user.id }
      const change = () =>
        ctx.users.setPasswordHash(
          ctx.a.environmentId,
          user.id,
          '$argon2id$new',
          later(1),
          activity(ctx.a, 'user.password_changed', target, { data: { method: 'reset' } })
        )
      expect(await change()).toBe('created')
      expect(await change()).toBe('replaced')
      const { entries } = await ctx.log.listAudit(ctx.a.environmentId, {
        targetId: user.id,
        page: 1,
        size: 100,
      })
      // Newest first.
      expect(entries.map((entry) => entry.data)).toEqual([
        { method: 'reset' },
        { method: 'reset', created: true },
      ])
    })

    test('a password change is recorded only when a password was replaced', async () => {
      const userId = await seedUser(ctx.a)
      const target = { type: 'user' as const, id: userId }
      const change = (tenant: ActivitySuiteTenant) =>
        ctx.users.setPasswordHash(
          tenant.environmentId,
          userId,
          '$argon2id$new',
          later(1),
          activity(tenant, 'user.password_changed', target)
        )
      expect(await change(ctx.a)).toBe('replaced')
      // Unknown in the other environment: nothing replaced, nothing recorded.
      expect(await change(ctx.b)).toBeNull()
      expect(await recorded(ctx.a, userId)).toEqual(['user.password_changed'])
      expect(await recorded(ctx.b, userId)).toEqual([])
    })

    test('verifying an email is recorded the first time only', async () => {
      const userId = await seedUser(ctx.a)
      const verify = (at: Date) =>
        ctx.users.markEmailVerified(
          ctx.a.environmentId,
          userId,
          at,
          activity(ctx.a, 'user.email_verified', { type: 'user', id: userId })
        )
      await verify(later(1))
      await verify(later(2))
      expect(await recorded(ctx.a, userId)).toEqual(['user.email_verified'])
      expect((await ctx.users.findById(ctx.a.environmentId, userId))?.emailVerifiedAt).toEqual(
        later(1)
      )
    })

    test('banning and unbanning are recorded only when the state changes', async () => {
      const userId = await seedUser(ctx.a)
      const target = { type: 'user' as const, id: userId }
      const set = (bannedAt: Date | null, at: Date, order: number) =>
        ctx.users.setBanned(
          ctx.a.environmentId,
          userId,
          bannedAt,
          at,
          activity(ctx.a, bannedAt ? 'user.banned' : 'user.unbanned', target, {
            occurredAt: later(order),
          })
        )
      expect((await set(null, later(1), 1))?.bannedAt).toBeNull()
      expect((await set(later(2), later(2), 2))?.bannedAt).toEqual(later(2))
      // A repeated ban keeps the first ban time and is not recorded again.
      expect((await set(later(3), later(3), 3))?.bannedAt).toEqual(later(2))
      expect((await set(null, later(4), 4))?.bannedAt).toBeNull()
      expect((await set(null, later(5), 5))?.bannedAt).toBeNull()
      expect(await recorded(ctx.a, userId)).toEqual(['user.banned', 'user.unbanned'])

      const unknown = Bun.randomUUIDv7()
      expect(
        await ctx.users.setBanned(
          ctx.a.environmentId,
          unknown,
          now,
          now,
          activity(ctx.a, 'user.banned', { type: 'user', id: unknown })
        )
      ).toBeNull()
      expect(await recorded(ctx.a, unknown)).toEqual([])
    })

    test('deleting a user is recorded, and the record outlives the user', async () => {
      const userId = await seedUser(ctx.a)
      const remove = () =>
        ctx.users.delete(
          ctx.a.environmentId,
          userId,
          activity(ctx.a, 'user.deleted', { type: 'user', id: userId })
        )
      expect(await remove()).toBe(true)
      expect(await remove()).toBe(false)
      expect(await ctx.users.findById(ctx.a.environmentId, userId)).toBeNull()
      expect(await recorded(ctx.a, userId)).toEqual(['user.deleted'])
    })

    test('creating and revoking an API key are recorded, the revocation once', async () => {
      const id = Bun.randomUUIDv7()
      const target = { type: 'api_key' as const, id }
      await ctx.apiKeys.insert(
        {
          id,
          kind: 'secret',
          name: 'Server',
          ...ctx.a,
          lastFour: 'abcd',
          createdAt: now,
          keyHash: sha256Hex(id),
        },
        activity(ctx.a, 'api_key.created', target)
      )
      const revoke = (tenant: ActivitySuiteTenant, at: Date) =>
        ctx.apiKeys.revoke(
          tenant.environmentId,
          id,
          at,
          activity(tenant, 'api_key.revoked', target, { occurredAt: later(1) })
        )
      // Another environment cannot revoke it, and that attempt leaves no record.
      expect(await revoke(ctx.b, later(1))).toBeNull()
      expect((await revoke(ctx.a, later(1)))?.revokedAt).toEqual(later(1))
      expect((await revoke(ctx.a, later(2)))?.revokedAt).toEqual(later(1))
      expect(await recorded(ctx.a, id)).toEqual(['api_key.created', 'api_key.revoked'])
      expect(await recorded(ctx.b, id)).toEqual([])
    })

    test('a signing-key rotation is recorded; one that lost the race is not', async () => {
      const tenant = await ctx.freshTenant()
      const key = (status: 'active' | 'next', createdAt: Date): NewSigningKey => {
        const id = Bun.randomUUIDv7()
        return {
          id,
          ...tenant,
          status,
          publicJwk: {
            kty: 'OKP',
            crv: 'Ed25519',
            x: `x-${id}`,
            kid: id,
            alg: 'EdDSA',
            use: 'sig',
          },
          privateKeyCiphertext: 'v1.iv.ct',
          createdAt,
          activatedAt: status === 'active' ? createdAt : null,
        }
      }
      const active = key('active', now)
      const next = key('next', later(1))
      await ctx.signingKeys.insert(tenant.environmentId, [active, next])
      const rotate = () =>
        ctx.signingKeys.rotate(
          tenant.environmentId,
          { retireId: active.id, activateId: next.id, next: key('next', later(2)) },
          later(2),
          activity(tenant, 'signing_key.rotated', { type: 'signing_key', id: next.id })
        )
      expect(await rotate()).toBe(true)
      expect(await rotate()).toBe(false)
      expect(await recorded(tenant, next.id)).toEqual(['signing_key.rotated'])
    })

    describe('listAudit', () => {
      /** Records `count` entries about one fresh user, each a second after the last. */
      async function history(tenant: ActivitySuiteTenant, count: number) {
        const userId = await seedUser(tenant)
        const ids: string[] = []
        for (let index = 0; index < count; index++) {
          const entry = activity(
            tenant,
            index % 2 === 0 ? 'user.banned' : 'user.unbanned',
            { type: 'user', id: userId },
            { occurredAt: later(index * 1_000), actor: { type: 'admin', id: userId } }
          )
          await ctx.users.setBanned(
            tenant.environmentId,
            userId,
            index % 2 === 0 ? now : null,
            now,
            entry
          )
          ids.push(entry.id)
        }
        return { userId, ids }
      }

      test('lists newest first and pages through with a stable total', async () => {
        const { userId, ids } = await history(ctx.a, 5)
        const page = (number: number) =>
          ctx.log.listAudit(ctx.a.environmentId, { targetId: userId, page: number, size: 2 })
        const pages = [await page(1), await page(2), await page(3), await page(4)]
        expect(pages.map((result) => result.totalCount)).toEqual([5, 5, 5, 5])
        expect(pages.map((result) => result.entries.map((entry) => entry.id))).toEqual([
          [ids[4], ids[3]],
          [ids[2], ids[1]],
          [ids[0]],
          [],
        ] as string[][])
      })

      test('entries of the same instant are ordered by id, so paging never repeats one', async () => {
        const userId = await seedUser(ctx.a)
        const target = { type: 'user' as const, id: userId }
        const first = activity(ctx.a, 'user.banned', target)
        const second = activity(ctx.a, 'user.unbanned', target)
        await ctx.users.setBanned(ctx.a.environmentId, userId, now, now, first)
        await ctx.users.setBanned(ctx.a.environmentId, userId, null, now, second)
        const expected = [first.id, second.id].sort().reverse()
        const { entries } = await ctx.log.listAudit(ctx.a.environmentId, {
          targetId: userId,
          page: 1,
          size: 10,
        })
        expect(entries.map((entry) => entry.id)).toEqual(expected)
      })

      test('filters by action, actor and target', async () => {
        const { userId, ids } = await history(ctx.a, 3)
        const other = await history(ctx.a, 1)
        const list = async (criteria: object) =>
          (
            await ctx.log.listAudit(ctx.a.environmentId, { page: 1, size: 100, ...criteria })
          ).entries.map((entry) => entry.id)
        expect(await list({ targetId: userId, action: 'user.unbanned' })).toEqual([
          ids[1],
        ] as string[])
        expect(await list({ actorId: userId })).toEqual([ids[2], ids[1], ids[0]] as string[])
        expect(await list({ actorId: userId, targetId: other.userId })).toEqual([])
        expect(await list({ actorId: other.userId, action: 'user.banned' })).toEqual(other.ids)
      })

      test('one environment never sees another’s entries', async () => {
        const { userId, ids } = await history(ctx.a, 2)
        const fromB = await ctx.log.listAudit(ctx.b.environmentId, {
          targetId: userId,
          page: 1,
          size: 100,
        })
        expect(fromB).toEqual({ entries: [], totalCount: 0 })
        const all = await ctx.log.listAudit(ctx.b.environmentId, { page: 1, size: 100 })
        expect(all.entries.some((entry) => ids.includes(entry.id))).toBe(false)
      })
    })
  })
}
