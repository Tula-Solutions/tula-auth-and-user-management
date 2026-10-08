import { beforeEach, describe, expect, test } from 'bun:test'
import * as Audit from '~/modules/audit/service'
import type { Activity, ActivityLog } from '~/ports/activity-log'
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
  /** The audit log the store records into. */
  log: ActivityLog
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
    /** An authentication that leaves the session without a hook's claims. */
    const NO_CLAIMS = { claims: null }
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
      await ctx.store.create(s, root, Audit.none('fixture'))
      return { session: s, root, userId }
    }

    test('stores a session with its root token and finds both', async () => {
      const { session: s, root } = await seed(ctx.a)
      expect(await ctx.store.findById(ctx.a.environmentId, s.id)).toEqual({
        ...s,
        type: 'hybrid',
        factorVerifiedAt: null,
        authMethods: [],
        hookClaims: null,
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

    function steppedUp(tenant: SessionSuiteTenant, sessionId: string): Activity {
      return {
        id: Bun.randomUUIDv7(),
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        type: 'session.stepped_up',
        actor: { type: 'user', id: null },
        target: { type: 'session', id: sessionId },
        ipAddress: '203.0.113.7',
        userAgent: 'suite/1.0',
        data: { methods: ['otp', 'mfa'] },
        occurredAt: now,
      }
    }

    /** Types recorded about one session. */
    async function recorded(tenant: SessionSuiteTenant, sessionId: string): Promise<string[]> {
      const { entries } = await ctx.log.listAudit(tenant.environmentId, {
        targetId: sessionId,
        page: 1,
        size: 100,
      })
      return entries.map((entry) => entry.type)
    }

    test('stores what a session proved at sign-in, and when', async () => {
      const { session: s } = await seed(ctx.a, {
        factorVerifiedAt: later(-5_000),
        authMethods: ['pwd', 'otp', 'mfa'],
      })
      expect(await ctx.store.findById(ctx.a.environmentId, s.id)).toMatchObject({
        factorVerifiedAt: later(-5_000),
        authMethods: ['pwd', 'otp', 'mfa'],
      })
      // A session stored without them has proven nothing.
      const { session: bare } = await seed(ctx.a)
      expect(await ctx.store.findById(ctx.a.environmentId, bare.id)).toMatchObject({
        factorVerifiedAt: null,
        authMethods: [],
      })
    })

    test('recording an authentication moves the time, merges the methods and records the activity', async () => {
      const { session: s, root } = await seed(ctx.a, {
        factorVerifiedAt: now,
        authMethods: ['pwd'],
      })
      const updated = await ctx.store.recordAuthentication(
        ctx.a.environmentId,
        s.id,
        { at: later(60_000), methods: ['otp', 'mfa'], hookClaims: NO_CLAIMS },
        steppedUp(ctx.a, s.id)
      )
      expect(updated).toEqual({
        ...s,
        type: 'hybrid',
        factorVerifiedAt: later(60_000),
        authMethods: ['pwd', 'otp', 'mfa'],
        hookClaims: null,
        revokedAt: null,
        revokeReason: null,
      })
      expect(await ctx.store.findById(ctx.a.environmentId, s.id)).toEqual(updated)
      expect(await recorded(ctx.a, s.id)).toEqual(['session.stepped_up'])
      // A step-up is not a rotation: the refresh token is untouched.
      expect(await ctx.store.findTokenById(ctx.a.environmentId, root.id)).toMatchObject({
        usedAt: null,
        replacedById: null,
      })
    })

    test('methods proven again are not listed twice, and the order is the canonical one', async () => {
      const { session: s } = await seed(ctx.a, { authMethods: ['pwd', 'otp', 'mfa'] })
      const first = await ctx.store.recordAuthentication(
        ctx.a.environmentId,
        s.id,
        {
          at: later(1_000),
          methods: ['otp', 'mfa'],
          hookClaims: NO_CLAIMS,
        },
        Audit.none('fixture')
      )
      expect(first?.authMethods).toEqual(['pwd', 'otp', 'mfa'])
      const second = await ctx.store.recordAuthentication(
        ctx.a.environmentId,
        s.id,
        {
          at: later(2_000),
          methods: ['backup_code', 'mfa', 'backup_code'],
          hookClaims: NO_CLAIMS,
        },
        Audit.none('fixture')
      )
      expect(second).toMatchObject({
        factorVerifiedAt: later(2_000),
        authMethods: ['pwd', 'otp', 'backup_code', 'mfa'],
      })
      // Without an activity nothing is recorded.
      expect(await recorded(ctx.a, s.id)).toEqual([])
    })

    test('concurrent authentications of one session merge: no method is lost', async () => {
      const { session: s } = await seed(ctx.a, { authMethods: ['pwd'] })
      await Promise.all(
        [['otp'], ['mfa'], ['backup_code']].map((methods) =>
          ctx.store.recordAuthentication(
            ctx.a.environmentId,
            s.id,
            { at: later(1_000), methods, hookClaims: NO_CLAIMS },
            Audit.none('fixture')
          )
        )
      )
      const stored = await ctx.store.findById(ctx.a.environmentId, s.id)
      expect([...(stored?.authMethods ?? [])].sort()).toEqual(['backup_code', 'mfa', 'otp', 'pwd'])
    })

    test('an ended or foreign session records no authentication and no activity', async () => {
      const revoked = await seed(ctx.a, { authMethods: ['pwd'] })
      await ctx.store.revoke(
        ctx.a.environmentId,
        revoked.session.id,
        'sign_out',
        later(1_000),
        Audit.none('fixture')
      )
      const idle = await seed(ctx.a, { authMethods: ['pwd'], idleExpiresAt: later(10_000) })
      const absolute = await seed(ctx.a, { authMethods: ['pwd'], absoluteExpiresAt: later(10_000) })
      const live = await seed(ctx.a, { authMethods: ['pwd'] })
      const record = (tenant: SessionSuiteTenant, id: string, at: Date) =>
        ctx.store.recordAuthentication(
          tenant.environmentId,
          id,
          { at, methods: ['otp', 'mfa'], hookClaims: NO_CLAIMS },
          steppedUp(tenant, id)
        )

      expect(await record(ctx.a, revoked.session.id, later(2_000))).toBeNull()
      // From the moment a session expires, by either limit.
      expect(await record(ctx.a, idle.session.id, later(10_000))).toBeNull()
      expect(await record(ctx.a, absolute.session.id, later(10_000))).toBeNull()
      // Another environment cannot step up this one's session.
      expect(await record(ctx.b, live.session.id, later(2_000))).toBeNull()
      expect(await record(ctx.a, Bun.randomUUIDv7(), later(2_000))).toBeNull()

      for (const untouched of [revoked, idle, absolute, live]) {
        expect(await ctx.store.findById(ctx.a.environmentId, untouched.session.id)).toMatchObject({
          factorVerifiedAt: null,
          authMethods: ['pwd'],
        })
        expect(await recorded(ctx.a, untouched.session.id)).toEqual([])
        expect(await recorded(ctx.b, untouched.session.id)).toEqual([])
      }
      // One millisecond before its expiry a session can still be stepped up.
      expect(await record(ctx.a, idle.session.id, later(9_999))).toMatchObject({
        factorVerifiedAt: later(9_999),
        authMethods: ['pwd', 'otp', 'mfa'],
      })
      expect(await recorded(ctx.a, idle.session.id)).toEqual(['session.stepped_up'])
    })

    describe('the claims a hook gave a session', () => {
      const CLAIMS = { role: 'admin', seats: 3, staff: false }

      test('a session is stored with them and has none otherwise', async () => {
        const plain = await seed(ctx.a)
        const withClaims = await seed(ctx.a, { hookClaims: CLAIMS })
        expect((await ctx.store.findById(ctx.a.environmentId, plain.session.id))?.hookClaims).toBe(
          null
        )
        const read = await ctx.store.findById(ctx.a.environmentId, withClaims.session.id)
        expect(read?.hookClaims).toEqual({ role: 'admin', seats: 3, staff: false })
        // A refresh reads them from here: the token lookup returns them too.
        const found = await ctx.store.findToken(ctx.a.environmentId, withClaims.root.tokenHash)
        expect(found?.session.hookClaims).toEqual({ role: 'admin', seats: 3, staff: false })
        const [listed] = await ctx.store.listActiveByUser(
          ctx.a.environmentId,
          withClaims.userId,
          now
        )
        expect(listed?.hookClaims).toEqual({ role: 'admin', seats: 3, staff: false })
      })

      test('what a caller is handed is not the store’s own copy', async () => {
        const given = { role: 'admin' }
        const { session: s } = await seed(ctx.a, { hookClaims: given })
        given.role = 'owner'
        const read = await ctx.store.findById(ctx.a.environmentId, s.id)
        expect(read?.hookClaims).toEqual({ role: 'admin' })
        ;(read?.hookClaims as Record<string, unknown>).role = 'owner'
        expect((await ctx.store.findById(ctx.a.environmentId, s.id))?.hookClaims).toEqual({
          role: 'admin',
        })
      })

      test('an authentication replaces them: with new ones, or with none', async () => {
        const { session: s } = await seed(ctx.a, { authMethods: ['pwd'], hookClaims: CLAIMS })
        const replaced = await ctx.store.recordAuthentication(
          ctx.a.environmentId,
          s.id,
          { at: later(1_000), methods: ['otp', 'mfa'], hookClaims: { claims: { role: 'owner' } } },
          Audit.none('fixture')
        )
        expect(replaced?.hookClaims).toEqual({ role: 'owner' })
        expect((await ctx.store.findById(ctx.a.environmentId, s.id))?.hookClaims).toEqual({
          role: 'owner',
        })
        const cleared = await ctx.store.recordAuthentication(
          ctx.a.environmentId,
          s.id,
          { at: later(2_000), methods: ['pwd'], hookClaims: { claims: null } },
          Audit.none('fixture')
        )
        expect(cleared?.hookClaims).toBeNull()
        expect((await ctx.store.findById(ctx.a.environmentId, s.id))?.hookClaims).toBeNull()
      })

      test('they are written only over the methods they were asked about', async () => {
        const { session: s } = await seed(ctx.a, {
          factorVerifiedAt: now,
          authMethods: ['pwd'],
          hookClaims: CLAIMS,
        })
        // Another step-up got in between: the session has proven more than the hook was told.
        await ctx.store.recordAuthentication(
          ctx.a.environmentId,
          s.id,
          { at: later(1_000), methods: ['email'], hookClaims: { claims: { role: 'member' } } },
          Audit.none('fixture')
        )
        const stale = await ctx.store.recordAuthentication(
          ctx.a.environmentId,
          s.id,
          {
            at: later(2_000),
            methods: ['otp', 'mfa'],
            hookClaims: { claims: { role: 'owner' }, ifAuthMethods: ['pwd'] },
          },
          steppedUp(ctx.a, s.id)
        )
        expect(stale).toBeNull()
        // Nothing of it was written: not the claims, not the methods, not the time, no entry.
        const untouched = await ctx.store.findById(ctx.a.environmentId, s.id)
        expect(untouched?.hookClaims).toEqual({ role: 'member' })
        expect(untouched?.authMethods).toEqual(['pwd', 'email'])
        expect(untouched?.factorVerifiedAt).toEqual(later(1_000))
        expect(await recorded(ctx.a, s.id)).toEqual([])

        // Over the methods as they are, in any order (a set), it is written.
        const fresh = await ctx.store.recordAuthentication(
          ctx.a.environmentId,
          s.id,
          {
            at: later(3_000),
            methods: ['otp', 'mfa'],
            hookClaims: { claims: { role: 'owner' }, ifAuthMethods: ['email', 'pwd'] },
          },
          steppedUp(ctx.a, s.id)
        )
        expect(fresh?.hookClaims).toEqual({ role: 'owner' })
        expect(fresh?.authMethods).toEqual(['pwd', 'email', 'otp', 'mfa'])
        expect(fresh?.factorVerifiedAt).toEqual(later(3_000))
        expect(await recorded(ctx.a, s.id)).toEqual(['session.stepped_up'])
      })

      test('a subset or a superset of the methods is not the methods', async () => {
        const { session: s } = await seed(ctx.a, { authMethods: ['pwd', 'email'] })
        for (const ifAuthMethods of [['pwd'], ['pwd', 'email', 'otp'], []]) {
          expect(
            await ctx.store.recordAuthentication(
              ctx.a.environmentId,
              s.id,
              {
                at: later(1_000),
                methods: ['otp'],
                hookClaims: { claims: { role: 'owner' }, ifAuthMethods },
              },
              Audit.none('fixture')
            )
          ).toBeNull()
        }
        expect((await ctx.store.findById(ctx.a.environmentId, s.id))?.hookClaims).toBeNull()
      })

      test('a refresh and a touch leave them as they are', async () => {
        const { session: s, root } = await seed(ctx.a, { hookClaims: CLAIMS })
        expect(
          await ctx.store.rotate(ctx.a.environmentId, {
            parentId: root.id,
            child: token(s.id, { parentId: root.id }),
            at: later(1_000),
            idleExpiresAt: later(8 * DAY),
          })
        ).toBe(true)
        expect(await ctx.store.touch(ctx.a.environmentId, s.id, later(2_000), later(8 * DAY))).toBe(
          true
        )
        expect((await ctx.store.findById(ctx.a.environmentId, s.id))?.hookClaims).toEqual({
          role: 'admin',
          seats: 3,
          staff: false,
        })
      })

      test('another environment neither reads nor replaces them', async () => {
        const { session: s } = await seed(ctx.a, { authMethods: ['pwd'], hookClaims: CLAIMS })
        expect(await ctx.store.findById(ctx.b.environmentId, s.id)).toBeNull()
        expect(
          await ctx.store.recordAuthentication(
            ctx.b.environmentId,
            s.id,
            { at: later(1_000), methods: ['otp'], hookClaims: { claims: { role: 'owner' } } },
            Audit.none('fixture')
          )
        ).toBeNull()
        expect((await ctx.store.findById(ctx.a.environmentId, s.id))?.hookClaims).toEqual({
          role: 'admin',
          seats: 3,
          staff: false,
        })
      })
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
      expect(
        await ctx.store.revoke(
          ctx.a.environmentId,
          s.id,
          'sign_out',
          later(1_000),
          Audit.none('fixture')
        )
      ).toBe(true)
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
        await ctx.store.revoke(
          ctx.a.environmentId,
          s.id,
          'reuse_detected',
          later(5_000),
          Audit.none('fixture')
        )
      ).toBe(true)
      expect(
        await ctx.store.revoke(
          ctx.a.environmentId,
          s.id,
          'sign_out',
          later(6_000),
          Audit.none('fixture')
        )
      ).toBe(false)
      expect(await ctx.store.findById(ctx.a.environmentId, s.id)).toMatchObject({
        revokedAt: later(5_000),
        revokeReason: 'reuse_detected',
      })
      expect(
        await ctx.store.revoke(
          ctx.a.environmentId,
          Bun.randomUUIDv7(),
          'sign_out',
          later(1),
          Audit.none('fixture')
        )
      ).toBe(false)
    })

    test('lists only active sessions of the user, most recently active first', async () => {
      const userId = await ctx.a.user()
      const old = await seed(ctx.a, { userId, lastActiveAt: later(1_000) })
      const recent = await seed(ctx.a, { userId, lastActiveAt: later(5_000) })
      const revoked = await seed(ctx.a, { userId })
      await ctx.store.revoke(
        ctx.a.environmentId,
        revoked.session.id,
        'sign_out',
        later(1),
        Audit.none('fixture')
      )
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

    test('lists the devices of a user’s earlier sessions, ended ones included, each once', async () => {
      const userId = await ctx.a.user()
      const first = await seed(ctx.a, { userId, userAgent: 'first', createdAt: later(1_000) })
      await ctx.store.revoke(
        ctx.a.environmentId,
        first.session.id,
        'sign_out',
        later(1_500),
        Audit.none('fixture')
      )
      await seed(ctx.a, { userId, userAgent: 'second', createdAt: later(2_000), client: 'ios' })
      await seed(ctx.a, { userId, userAgent: 'first', createdAt: later(3_000) })
      await seed(ctx.a, { userId, userAgent: null, createdAt: later(4_000), idleExpiresAt: now })
      const newest = await seed(ctx.a, { userId, userAgent: 'newest', createdAt: later(5_000) })
      await seed(ctx.a, { userId, userAgent: 'later', createdAt: later(6_000) })
      await seed(ctx.a, { userAgent: 'someone else', createdAt: later(1_000) })

      const devices = await ctx.store.listDevicesBefore(
        ctx.a.environmentId,
        userId,
        newest.session,
        10
      )
      expect(devices).toEqual([
        { client: 'web', userAgent: null },
        { client: 'web', userAgent: 'first' },
        { client: 'ios', userAgent: 'second' },
      ])
      expect(
        await ctx.store.listDevicesBefore(ctx.a.environmentId, userId, newest.session, 2)
      ).toEqual(devices.slice(0, 2))
      expect(
        await ctx.store.listDevicesBefore(ctx.a.environmentId, userId, first.session, 10)
      ).toEqual([])
    })

    test('of two sessions created in the same instant, only the later one sees the other', async () => {
      const userId = await ctx.a.user()
      const [low, high] = [
        '00000000-0000-7000-8000-000000000001',
        '00000000-0000-7000-8000-000000000002',
      ]
      const x = await seed(ctx.a, { userId, id: low, userAgent: 'x' })
      const y = await seed(ctx.a, { userId, id: high, userAgent: 'y' })
      expect(await ctx.store.listDevicesBefore(ctx.a.environmentId, userId, x.session, 10)).toEqual(
        []
      )
      expect(await ctx.store.listDevicesBefore(ctx.a.environmentId, userId, y.session, 10)).toEqual(
        [{ client: 'web', userAgent: 'x' }]
      )
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
        { activity: () => Audit.none('fixture'), exceptSessionId: keep.session.id }
      )
      expect(revoked.sort()).toEqual([first.session.id, second.session.id].sort())
      expect((await ctx.store.findById(ctx.a.environmentId, keep.session.id))?.revokedAt).toBeNull()
      expect(
        (await ctx.store.findById(ctx.a.environmentId, bystander.session.id))?.revokedAt
      ).toBeNull()
      // Already-revoked sessions are not reported again; without an exception the rest go too.
      expect(
        await ctx.store.revokeByUser(
          ctx.a.environmentId,
          userId,
          'password_changed',
          later(2_000),
          { activity: () => Audit.none('fixture') }
        )
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
      await ctx.store.revoke(
        ctx.a.environmentId,
        revokedLongAgo.session.id,
        'sign_out',
        ended,
        Audit.none('fixture')
      )
      await ctx.store.revoke(
        ctx.a.environmentId,
        revokedSince.session.id,
        'sign_out',
        later(-39 * DAY),
        Audit.none('fixture')
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

    function limited(tenant: SessionSuiteTenant, sessionId: string): Activity {
      return {
        id: Bun.randomUUIDv7(),
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        type: 'session.revoked',
        actor: { type: 'system', id: null },
        target: { type: 'session', id: sessionId },
        ipAddress: null,
        userAgent: null,
        data: { reason: 'session_limit' },
        occurredAt: later(1000),
      }
    }

    async function createLimited(
      tenant: SessionSuiteTenant,
      userId: string,
      max: number,
      end: readonly string[] = [],
      overrides: Partial<NewSession> = {}
    ) {
      const s = session(tenant, userId, { createdAt: later(1000), ...overrides })
      const result = await ctx.store.create(s, token(s.id), Audit.none('fixture'), {
        max,
        end,
        at: later(1000),
        activity: (id) => limited(tenant, id),
      })
      return { session: s, result }
    }

    test('a session keeps the type it was created with', async () => {
      const { session: s } = await seed(ctx.a, { type: 'stateful' })
      expect((await ctx.store.findById(ctx.a.environmentId, s.id))?.type).toBe('stateful')
    })

    test('creating without a limit reports the session as created', async () => {
      const userId = await ctx.a.user()
      const s = session(ctx.a, userId)
      expect(await ctx.store.create(s, token(s.id), Audit.none('fixture'))).toEqual({
        created: true,
        ended: [],
      })
    })

    test('a session under the limit is created', async () => {
      const { userId } = await seed(ctx.a)
      const { session: s, result } = await createLimited(ctx.a, userId, 2)
      expect(result).toEqual({ created: true, ended: [] })
      expect(await ctx.store.findById(ctx.a.environmentId, s.id)).not.toBeNull()
    })

    test('a session at the limit is not created, and nothing else changes', async () => {
      const { userId, session: first } = await seed(ctx.a)
      await seed(ctx.a, { userId })
      const { session: s, result } = await createLimited(ctx.a, userId, 2)
      expect(result).toEqual({ created: false })
      expect(await ctx.store.findById(ctx.a.environmentId, s.id)).toBeNull()
      expect((await ctx.store.findById(ctx.a.environmentId, first.id))?.revokedAt).toBeNull()
      expect(
        await ctx.store.listActiveByUser(ctx.a.environmentId, userId, later(1000))
      ).toHaveLength(2)
    })

    test('ending the named sessions makes room, in the same step, and is recorded', async () => {
      const { userId, session: oldest } = await seed(ctx.a)
      const { session: kept } = await seed(ctx.a, { userId, createdAt: later(10) })
      const { session: s, result } = await createLimited(ctx.a, userId, 2, [oldest.id])
      expect(result).toEqual({ created: true, ended: [oldest.id] })
      const ended = await ctx.store.findById(ctx.a.environmentId, oldest.id)
      expect(ended?.revokedAt).toEqual(later(1000))
      expect(ended?.revokeReason).toBe('session_limit')
      const active = await ctx.store.listActiveByUser(ctx.a.environmentId, userId, later(1000))
      expect(active.map((row) => row.id).sort()).toEqual([kept.id, s.id].sort())
      expect(await recorded(ctx.a, oldest.id)).toEqual(['session.revoked'])
    })

    test('when ending the named sessions is not enough, nothing is ended or created', async () => {
      const { userId, session: oldest } = await seed(ctx.a)
      await seed(ctx.a, { userId })
      await seed(ctx.a, { userId })
      const { session: s, result } = await createLimited(ctx.a, userId, 2, [oldest.id])
      expect(result).toEqual({ created: false })
      expect(await ctx.store.findById(ctx.a.environmentId, s.id)).toBeNull()
      expect((await ctx.store.findById(ctx.a.environmentId, oldest.id))?.revokedAt).toBeNull()
      expect(await recorded(ctx.a, oldest.id)).toEqual([])
    })

    test('only sessions that can still be used count towards the limit', async () => {
      const userId = await ctx.a.user()
      const { session: revoked } = await seed(ctx.a, { userId })
      await ctx.store.revoke(
        ctx.a.environmentId,
        revoked.id,
        'sign_out',
        later(1),
        Audit.none('fixture')
      )
      await seed(ctx.a, { userId, idleExpiresAt: later(500) })
      await seed(ctx.a, { userId, absoluteExpiresAt: later(500), idleExpiresAt: later(500) })
      const { result } = await createLimited(ctx.a, userId, 1)
      expect(result).toEqual({ created: true, ended: [] })
    })

    test('another user’s session, and another environment’s, are never ended or counted', async () => {
      const { session: theirs } = await seed(ctx.a)
      const { session: foreign } = await seed(ctx.b)
      const userId = await ctx.a.user()
      const { result } = await createLimited(ctx.a, userId, 1, [theirs.id, foreign.id])
      expect(result).toEqual({ created: true, ended: [] })
      expect((await ctx.store.findById(ctx.a.environmentId, theirs.id))?.revokedAt).toBeNull()
      expect((await ctx.store.findById(ctx.b.environmentId, foreign.id))?.revokedAt).toBeNull()
    })

    test('of two simultaneous sign-ins at the limit only one gets a session', async () => {
      const { userId } = await seed(ctx.a)
      const results = await Promise.all([
        createLimited(ctx.a, userId, 2),
        createLimited(ctx.a, userId, 2),
        createLimited(ctx.a, userId, 2),
      ])
      expect(results.filter(({ result }) => result.created)).toHaveLength(1)
      expect(
        await ctx.store.listActiveByUser(ctx.a.environmentId, userId, later(1000))
      ).toHaveLength(2)
    })

    test('touching a live session moves its activity and idle expiry', async () => {
      const { session: s } = await seed(ctx.a)
      expect(await ctx.store.touch(ctx.a.environmentId, s.id, later(60_000), later(DAY))).toBe(true)
      const touched = await ctx.store.findById(ctx.a.environmentId, s.id)
      expect(touched?.lastActiveAt).toEqual(later(60_000))
      expect(touched?.idleExpiresAt).toEqual(later(DAY))
    })

    test('a revoked, expired, unknown or foreign session cannot be touched', async () => {
      const { session: revoked } = await seed(ctx.a)
      await ctx.store.revoke(
        ctx.a.environmentId,
        revoked.id,
        'sign_out',
        later(1),
        Audit.none('fixture')
      )
      const { session: expired } = await seed(ctx.a, { idleExpiresAt: later(500) })
      const { session: live } = await seed(ctx.a)
      const env = ctx.a.environmentId
      expect(await ctx.store.touch(env, revoked.id, later(1000), later(DAY))).toBe(false)
      expect(await ctx.store.touch(env, expired.id, later(1000), later(DAY))).toBe(false)
      expect(await ctx.store.touch(env, Bun.randomUUIDv7(), later(1000), later(DAY))).toBe(false)
      expect(await ctx.store.touch(ctx.b.environmentId, live.id, later(1000), later(DAY))).toBe(
        false
      )
      expect((await ctx.store.findById(env, expired.id))?.idleExpiresAt).toEqual(later(500))
      expect((await ctx.store.findById(env, live.id))?.lastActiveAt).toEqual(now)
    })

    test('one environment cannot read, rotate, list or revoke another’s sessions', async () => {
      const { session: s, root, userId } = await seed(ctx.a)
      const foreign = ctx.b.environmentId
      expect(await ctx.store.findById(foreign, s.id)).toBeNull()
      expect(await ctx.store.findToken(foreign, root.tokenHash)).toBeNull()
      expect(await ctx.store.findTokenById(foreign, root.id)).toBeNull()
      expect(await ctx.store.listActiveByUser(foreign, userId, later(1))).toEqual([])
      expect(
        await ctx.store.listDevicesBefore(
          foreign,
          userId,
          { id: 'ffffffff-ffff-7fff-8fff-ffffffffffff', createdAt: later(DAY) },
          10
        )
      ).toEqual([])
      expect(
        await ctx.store.revoke(foreign, s.id, 'sign_out', later(1), Audit.none('fixture'))
      ).toBe(false)
      expect(
        await ctx.store.revokeByUser(foreign, userId, 'sign_out', later(1), {
          activity: () => Audit.none('fixture'),
        })
      ).toEqual([])
      expect((await ctx.store.findById(ctx.a.environmentId, s.id))?.revokedAt).toBeNull()
    })
  })
}
