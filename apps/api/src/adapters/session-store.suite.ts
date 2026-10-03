import { beforeEach, describe, expect, test } from 'bun:test'
import type { NewRefreshToken, NewSession, SessionStore } from '~/ports/session-store'

/** A tenant plus the rows the store's foreign keys need. */
export interface SessionSuiteTenant {
  projectId: string
  environmentId: string
  /** Create a user (a real row for Postgres) and return its id. */
  user: () => Promise<string>
}

/** What a store under test provides. */
export interface SessionSuiteContext {
  store: SessionStore
  a: SessionSuiteTenant
  b: SessionSuiteTenant
}

/**
 * Behaviour every `SessionStore` must have. Run against each adapter so the memory store used by
 * unit tests can't drift from Postgres.
 *
 * @param name - Adapter name for the report.
 * @param setup - Builds a fresh context; called before each test.
 */
export function describeSessionStore(
  name: string,
  setup: () => Promise<SessionSuiteContext>
): void {
  describe(`${name} (SessionStore)`, () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    const later = (ms: number) => new Date(now.getTime() + ms)
    const DAY = 86_400_000
    let ctx: SessionSuiteContext
    let counter = 0

    beforeEach(async () => {
      ctx = await setup()
    })

    function session(
      tenant: SessionSuiteTenant,
      userId: string,
      overrides: Partial<NewSession> = {}
    ): NewSession {
      return {
        id: Bun.randomUUIDv7(),
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        userId,
        profile: 'web',
        client: 'web',
        userAgent: 'Mozilla/5.0',
        ipAddress: '203.0.113.7',
        lastActiveAt: now,
        idleExpiresAt: later(7 * DAY),
        absoluteExpiresAt: later(30 * DAY),
        createdAt: now,
        ...overrides,
      }
    }

    function token(sessionId: string, overrides: Partial<NewRefreshToken> = {}): NewRefreshToken {
      counter += 1
      return {
        id: Bun.randomUUIDv7(),
        sessionId,
        tokenHash: `hash-${Bun.randomUUIDv7()}-${counter}`,
        parentId: null,
        expiresAt: later(7 * DAY),
        createdAt: now,
        ...overrides,
      }
    }

    async function seed(tenant: SessionSuiteTenant, overrides: Partial<NewSession> = {}) {
      const userId = overrides.userId ?? (await tenant.user())
      const s = session(tenant, userId, overrides)
      const root = token(s.id)
      await ctx.store.create(s, root)
      return { session: s, root, userId }
    }

    test('stores a session with its root token and finds both', async () => {
      const { session: s, root } = await seed(ctx.a)
      expect(await ctx.store.findById(ctx.a.environmentId, s.id)).toEqual({
        ...s,
        revokedAt: null,
        revokeReason: null,
      })
      const found = await ctx.store.findToken(ctx.a.environmentId, root.tokenHash)
      expect(found?.token).toEqual({ ...root, replacedById: null, usedAt: null })
      expect(found?.session.id).toBe(s.id)
      expect(await ctx.store.findTokenById(ctx.a.environmentId, root.id)).toEqual(
        found?.token ?? null
      )
      expect(await ctx.store.findToken(ctx.a.environmentId, 'missing')).toBeNull()
      expect(await ctx.store.findTokenById(ctx.a.environmentId, Bun.randomUUIDv7())).toBeNull()
    })

    test('stores sessions with no absolute limit, user agent or IP', async () => {
      const { session: s } = await seed(ctx.a, {
        absoluteExpiresAt: null,
        userAgent: null,
        ipAddress: null,
        client: 'ios',
      })
      expect(await ctx.store.findById(ctx.a.environmentId, s.id)).toMatchObject({
        absoluteExpiresAt: null,
        userAgent: null,
        ipAddress: null,
        client: 'ios',
      })
    })

    test('rotation marks the parent used, links the child and extends the session', async () => {
      const { session: s, root } = await seed(ctx.a)
      const child = token(s.id, { parentId: root.id, createdAt: later(60_000) })
      const rotated = await ctx.store.rotate(ctx.a.environmentId, {
        parentId: root.id,
        child,
        at: later(60_000),
        idleExpiresAt: later(60_000 + 7 * DAY),
      })
      expect(rotated).toBe(true)
      expect(await ctx.store.findTokenById(ctx.a.environmentId, root.id)).toMatchObject({
        usedAt: later(60_000),
        replacedById: child.id,
      })
      expect((await ctx.store.findToken(ctx.a.environmentId, child.tokenHash))?.token).toEqual({
        ...child,
        replacedById: null,
        usedAt: null,
      })
      expect(await ctx.store.findById(ctx.a.environmentId, s.id)).toMatchObject({
        lastActiveAt: later(60_000),
        idleExpiresAt: later(60_000 + 7 * DAY),
      })
    })

    test('a token rotates once: a second rotation writes nothing', async () => {
      const { session: s, root } = await seed(ctx.a)
      const rotation = (child: NewRefreshToken) => ({
        parentId: root.id,
        child,
        at: later(1_000),
        idleExpiresAt: later(8 * DAY),
      })
      const first = token(s.id, { parentId: root.id })
      const second = token(s.id, { parentId: root.id })
      expect(await ctx.store.rotate(ctx.a.environmentId, rotation(first))).toBe(true)
      expect(await ctx.store.rotate(ctx.a.environmentId, rotation(second))).toBe(false)
      expect(await ctx.store.findToken(ctx.a.environmentId, second.tokenHash)).toBeNull()
      expect((await ctx.store.findTokenById(ctx.a.environmentId, root.id))?.replacedById).toBe(
        first.id
      )
    })

    test('of concurrent rotations of one token exactly one wins', async () => {
      const { session: s, root } = await seed(ctx.a)
      // Real children share the hash (it is derived from the parent), so the store sees a
      // unique-hash conflict as well as the used-parent guard.
      const tokenHash = `derived-${root.id}`
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          ctx.store.rotate(ctx.a.environmentId, {
            parentId: root.id,
            child: token(s.id, { parentId: root.id, tokenHash }),
            at: later(1_000),
            idleExpiresAt: later(8 * DAY),
          })
        )
      )
      expect(results.filter(Boolean)).toHaveLength(1)
    })

    test('a revoked session cannot be rotated', async () => {
      const { session: s, root } = await seed(ctx.a)
      expect(await ctx.store.revoke(ctx.a.environmentId, s.id, 'sign_out', later(1_000))).toBe(true)
      const child = token(s.id, { parentId: root.id })
      expect(
        await ctx.store.rotate(ctx.a.environmentId, {
          parentId: root.id,
          child,
          at: later(2_000),
          idleExpiresAt: later(8 * DAY),
        })
      ).toBe(false)
      expect(await ctx.store.findToken(ctx.a.environmentId, child.tokenHash)).toBeNull()
      expect((await ctx.store.findTokenById(ctx.a.environmentId, root.id))?.usedAt).toBeNull()
    })

    test('revoke records the reason once', async () => {
      const { session: s } = await seed(ctx.a)
      expect(
        await ctx.store.revoke(ctx.a.environmentId, s.id, 'reuse_detected', later(5_000))
      ).toBe(true)
      expect(await ctx.store.revoke(ctx.a.environmentId, s.id, 'sign_out', later(6_000))).toBe(
        false
      )
      expect(await ctx.store.findById(ctx.a.environmentId, s.id)).toMatchObject({
        revokedAt: later(5_000),
        revokeReason: 'reuse_detected',
      })
      expect(
        await ctx.store.revoke(ctx.a.environmentId, Bun.randomUUIDv7(), 'sign_out', later(1))
      ).toBe(false)
    })

    test('lists only active sessions of the user, most recently active first', async () => {
      const userId = await ctx.a.user()
      const old = await seed(ctx.a, { userId, lastActiveAt: later(1_000) })
      const recent = await seed(ctx.a, { userId, lastActiveAt: later(5_000) })
      const revoked = await seed(ctx.a, { userId })
      await ctx.store.revoke(ctx.a.environmentId, revoked.session.id, 'sign_out', later(1))
      await seed(ctx.a, { userId, idleExpiresAt: later(10_000) })
      await seed(ctx.a, { userId, absoluteExpiresAt: later(10_000) })
      await seed(ctx.a)

      const active = await ctx.store.listActiveByUser(ctx.a.environmentId, userId, later(10_000))
      expect(active.map((s) => s.id)).toEqual([recent.session.id, old.session.id])
      // One millisecond earlier the two expiring sessions are still active.
      expect(
        await ctx.store.listActiveByUser(ctx.a.environmentId, userId, later(9_999))
      ).toHaveLength(4)
    })

    test('revokes all of a user’s sessions except one', async () => {
      const userId = await ctx.a.user()
      const keep = await seed(ctx.a, { userId })
      const first = await seed(ctx.a, { userId })
      const second = await seed(ctx.a, { userId })
      const bystander = await seed(ctx.a)

      const revoked = await ctx.store.revokeByUser(
        ctx.a.environmentId,
        userId,
        'revoked_by_user',
        later(1_000),
        { exceptSessionId: keep.session.id }
      )
      expect(revoked.sort()).toEqual([first.session.id, second.session.id].sort())
      expect((await ctx.store.findById(ctx.a.environmentId, keep.session.id))?.revokedAt).toBeNull()
      expect(
        (await ctx.store.findById(ctx.a.environmentId, bystander.session.id))?.revokedAt
      ).toBeNull()
      // Already-revoked sessions are not reported again; without an exception the rest go too.
      expect(
        await ctx.store.revokeByUser(ctx.a.environmentId, userId, 'password_changed', later(2_000))
      ).toEqual([keep.session.id])
      expect(await ctx.store.findById(ctx.a.environmentId, first.session.id)).toMatchObject({
        revokeReason: 'revoked_by_user',
      })
    })

    test('purges sessions that had ended by a moment, with their token chains, in batches', async () => {
      // Times earlier than any other test's, because a shared database keeps their rows.
      const ended = later(-50 * DAY)
      const cutoff = later(-40 * DAY)
      const idle = await seed(ctx.a, { idleExpiresAt: ended, absoluteExpiresAt: null })
      const absolute = await seed(ctx.a, { absoluteExpiresAt: ended })
      const revokedLongAgo = await seed(ctx.a)
      const revokedSince = await seed(ctx.a)
      const live = await seed(ctx.a)
      const foreign = await seed(ctx.b, { idleExpiresAt: ended })
      // A chain of two tokens, so the purge has to remove links that reference each other.
      const child = token(idle.session.id, { parentId: idle.root.id })
      expect(
        await ctx.store.rotate(ctx.a.environmentId, {
          parentId: idle.root.id,
          child,
          at: later(-51 * DAY),
          idleExpiresAt: ended,
        })
      ).toBe(true)
      await ctx.store.revoke(ctx.a.environmentId, revokedLongAgo.session.id, 'sign_out', ended)
      await ctx.store.revoke(
        ctx.a.environmentId,
        revokedSince.session.id,
        'sign_out',
        later(-39 * DAY)
      )

      const found = (tenant: SessionSuiteTenant, id: string) =>
        ctx.store.findById(tenant.environmentId, id)
      expect(await ctx.store.deleteEnded(ctx.a.environmentId, later(-50 * DAY - 1), 100)).toBe(0)
      expect(await ctx.store.deleteEnded(ctx.a.environmentId, cutoff, 2)).toBe(2)
      expect(await ctx.store.deleteEnded(ctx.a.environmentId, cutoff, 2)).toBe(1)
      expect(await ctx.store.deleteEnded(ctx.a.environmentId, cutoff, 2)).toBe(0)

      for (const gone of [idle, absolute, revokedLongAgo]) {
        expect(await found(ctx.a, gone.session.id)).toBeNull()
        expect(await ctx.store.findTokenById(ctx.a.environmentId, gone.root.id)).toBeNull()
        expect(await ctx.store.findToken(ctx.a.environmentId, gone.root.tokenHash)).toBeNull()
      }
      expect(await ctx.store.findTokenById(ctx.a.environmentId, child.id)).toBeNull()
      // Revoked after the cutoff, or still usable: kept, tokens and all.
      for (const kept of [revokedSince, live]) {
        expect(await found(ctx.a, kept.session.id)).not.toBeNull()
        expect(await ctx.store.findTokenById(ctx.a.environmentId, kept.root.id)).not.toBeNull()
      }
      // Environment A's purge never touched environment B's ended session.
      expect(await found(ctx.b, foreign.session.id)).not.toBeNull()
      expect(await ctx.store.deleteEnded(ctx.b.environmentId, cutoff, 100)).toBe(1)
    })

    test('a session that can still be refreshed is never purged', async () => {
      const { session: s, root } = await seed(ctx.a)
      // One millisecond before its idle expiry it is still usable, so it stays.
      const justBefore = new Date(s.idleExpiresAt.getTime() - 1)
      await ctx.store.deleteEnded(ctx.a.environmentId, justBefore, 100)
      expect(await ctx.store.findById(ctx.a.environmentId, s.id)).not.toBeNull()
      expect(await ctx.store.findToken(ctx.a.environmentId, root.tokenHash)).not.toBeNull()
    })

    test('one environment cannot read, rotate, list or revoke another’s sessions', async () => {
      const { session: s, root, userId } = await seed(ctx.a)
      const foreign = ctx.b.environmentId
      expect(await ctx.store.findById(foreign, s.id)).toBeNull()
      expect(await ctx.store.findToken(foreign, root.tokenHash)).toBeNull()
      expect(await ctx.store.findTokenById(foreign, root.id)).toBeNull()
      expect(await ctx.store.listActiveByUser(foreign, userId, later(1))).toEqual([])
      expect(await ctx.store.revoke(foreign, s.id, 'sign_out', later(1))).toBe(false)
      expect(await ctx.store.revokeByUser(foreign, userId, 'sign_out', later(1))).toEqual([])
      expect((await ctx.store.findById(ctx.a.environmentId, s.id))?.revokedAt).toBeNull()
    })
  })
}
