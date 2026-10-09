import { beforeEach, describe, expect, test } from 'bun:test'
import type { ActivityType } from '@tula/contract'
import * as Audit from '~/modules/audit/service'
import type { Activity, ActivityLog } from '~/ports/activity-log'
import type { NewUser, UserRepository } from '~/ports/user-repository'

/** A tenant for the suite. */
export interface UserSuiteTenant {
  projectId: string
  environmentId: string
}

/** What a repository under test provides. */
export interface UserSuiteContext {
  users: UserRepository
  /** Reads back what the repository recorded. */
  log: ActivityLog
  a: UserSuiteTenant
  b: UserSuiteTenant
}

/**
 * Behaviour every `UserRepository` must have. Run against each adapter so the memory repository
 * used by unit tests can't drift from Postgres.
 *
 * @param name - Adapter name for the report.
 * @param setup - Builds a fresh context; called before each test.
 */
export function describeUserRepository(name: string, setup: () => Promise<UserSuiteContext>): void {
  describe(`${name} (UserRepository)`, () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    const later = (ms: number) => new Date(now.getTime() + ms)
    let ctx: UserSuiteContext

    beforeEach(async () => {
      ctx = await setup()
    })

    /** A user with an address: what every test here means unless it says otherwise. */
    type Addressed = NewUser & { email: string; emailNormalized: string }

    function user(tenant: UserSuiteTenant, overrides: Partial<Addressed> = {}): Addressed {
      const id = Bun.randomUUIDv7()
      return {
        id,
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        email: `Maya-${id}@Northline.app`,
        emailNormalized: `maya-${id}@northline.app`,
        emailVerifiedAt: now,
        firstName: 'Maya',
        lastName: 'Okafor',
        createdAt: now,
        identityId: Bun.randomUUIDv7(),
        credentialId: Bun.randomUUIDv7(),
        passwordHash: '$argon2id$hash',
        ...overrides,
      }
    }

    function record(input: NewUser) {
      const { identityId: _i, credentialId: _c, passwordHash: _p, ...rest } = input
      return {
        ...rest,
        bannedAt: null,
        lastSignInAt: null,
        phoneNumber: null,
        phoneNumberVerifiedAt: null,
      }
    }

    function activity(tenant: UserSuiteTenant, type: ActivityType, userId: string): Activity {
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

    const auditOf = async (tenant: UserSuiteTenant, userId: string) =>
      (
        await ctx.log.listAudit(tenant.environmentId, { targetId: userId, page: 1, size: 50 })
      ).entries.map((entry) => entry.type)

    describe('a phone number', () => {
      test('a new user has none', async () => {
        const input = user(ctx.a)
        await ctx.users.create(input, Audit.none('fixture'))
        expect(await ctx.users.findById(ctx.a.environmentId, input.id)).toMatchObject({
          phoneNumber: null,
          phoneNumberVerifiedAt: null,
        })
      })

      test('is stored with the time it was proven, and recorded', async () => {
        const input = user(ctx.a)
        await ctx.users.create(input, Audit.none('fixture'))
        const stored = await ctx.users.setPhoneNumber(
          ctx.a.environmentId,
          input.id,
          '+14155550100',
          later(1_000),
          activity(ctx.a, 'user.phone_number_added', input.id)
        )
        const expected = {
          ...record(input),
          phoneNumber: '+14155550100',
          phoneNumberVerifiedAt: later(1_000),
        }
        expect(stored).toEqual(expected)
        expect(await ctx.users.findById(ctx.a.environmentId, input.id)).toEqual(expected)
        expect(await auditOf(ctx.a, input.id)).toEqual(['user.phone_number_added'])
      })

      test('a second number replaces the first, and proving one again moves its time', async () => {
        const input = user(ctx.a)
        await ctx.users.create(input, Audit.none('fixture'))
        const set = (phoneNumber: string, at: Date) =>
          ctx.users.setPhoneNumber(
            ctx.a.environmentId,
            input.id,
            phoneNumber,
            at,
            activity(ctx.a, 'user.phone_number_added', input.id)
          )
        await set('+14155550100', later(1_000))
        expect(await set('+4915112345678', later(2_000))).toEqual({
          ...record(input),
          phoneNumber: '+4915112345678',
          phoneNumberVerifiedAt: later(2_000),
        })
        expect((await set('+4915112345678', later(3_000)))?.phoneNumberVerifiedAt).toEqual(
          later(3_000)
        )
        expect(await auditOf(ctx.a, input.id)).toHaveLength(3)
      })

      test('two users may have the same number: it is not an identifier', async () => {
        const first = user(ctx.a)
        const second = user(ctx.a)
        await ctx.users.create(first, Audit.none('fixture'))
        await ctx.users.create(second, Audit.none('fixture'))
        for (const { id } of [first, second]) {
          expect(
            (
              await ctx.users.setPhoneNumber(
                ctx.a.environmentId,
                id,
                '+14155550100',
                later(1),
                Audit.none('fixture')
              )
            )?.phoneNumber
          ).toBe('+14155550100')
        }
      })

      test('removing takes the number and its time, once, and records only a real removal', async () => {
        const input = user(ctx.a)
        await ctx.users.create(input, Audit.none('fixture'))
        const remove = () =>
          ctx.users.removePhoneNumber(
            ctx.a.environmentId,
            input.id,
            later(2_000),
            activity(ctx.a, 'user.phone_number_removed', input.id)
          )
        // Nothing to remove: nothing recorded.
        expect(await remove()).toBe(false)
        expect(await auditOf(ctx.a, input.id)).toEqual([])
        await ctx.users.setPhoneNumber(
          ctx.a.environmentId,
          input.id,
          '+14155550100',
          later(1_000),
          Audit.none('fixture')
        )
        expect(await remove()).toBe(true)
        expect(await ctx.users.findById(ctx.a.environmentId, input.id)).toEqual(record(input))
        expect(await remove()).toBe(false)
        expect(await auditOf(ctx.a, input.id)).toEqual(['user.phone_number_removed'])
      })

      test('an unknown user and another environment’s user get nothing, and nothing is recorded', async () => {
        const input = user(ctx.a)
        await ctx.users.create(input, Audit.none('fixture'))
        await ctx.users.setPhoneNumber(
          ctx.a.environmentId,
          input.id,
          '+14155550100',
          later(1),
          Audit.none('fixture')
        )
        for (const [environmentId, id] of [
          [ctx.a.environmentId, Bun.randomUUIDv7()],
          [ctx.b.environmentId, input.id],
        ] as const) {
          expect(
            await ctx.users.setPhoneNumber(
              environmentId,
              id,
              '+4915112345678',
              later(2),
              activity(ctx.b, 'user.phone_number_added', id)
            )
          ).toBeNull()
          expect(
            await ctx.users.removePhoneNumber(
              environmentId,
              id,
              later(2),
              activity(ctx.b, 'user.phone_number_removed', id)
            )
          ).toBe(false)
        }
        expect(await auditOf(ctx.b, input.id)).toEqual([])
        expect((await ctx.users.findById(ctx.a.environmentId, input.id))?.phoneNumber).toBe(
          '+14155550100'
        )
      })

      test('the list carries it', async () => {
        const input = user(ctx.a)
        await ctx.users.create(input, Audit.none('fixture'))
        await ctx.users.setPhoneNumber(
          ctx.a.environmentId,
          input.id,
          '+14155550100',
          later(1),
          Audit.none('fixture')
        )
        const listed = await ctx.users.list(ctx.a.environmentId, {
          q: input.emailNormalized,
          sort: 'email',
          page: 1,
          size: 10,
        })
        expect(listed.users[0]?.phoneNumber).toBe('+14155550100')
      })

      /** A number no other test of the run has used: adapters may share a database. */
      const unused = () => `+1415${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`

      /** A user of `tenant` holding `phoneNumber`, proven at `at`. */
      async function holder(tenant: UserSuiteTenant, phoneNumber: string, at: Date) {
        const input = user(tenant)
        await ctx.users.create(input, Audit.none('fixture'))
        await ctx.users.setPhoneNumber(
          tenant.environmentId,
          input.id,
          phoneNumber,
          at,
          Audit.none('fixture')
        )
        return input.id
      }

      test('the users of an environment who hold a number are found by it, up to a limit', async () => {
        const number = unused()
        expect(await ctx.users.findByPhoneNumber(ctx.a.environmentId, number, 2)).toEqual([])
        const first = await holder(ctx.a, number, later(1))
        await holder(ctx.a, unused(), later(1))
        // Another environment's holder is never found from here.
        await holder(ctx.b, number, later(1))
        const one = await ctx.users.findByPhoneNumber(ctx.a.environmentId, number, 2)
        expect(one.map(({ id }) => id)).toEqual([first])
        expect(one[0]).toMatchObject({ phoneNumber: number })
        expect(one[0]?.phoneNumberVerifiedAt).toEqual(later(1))
        const second = await holder(ctx.a, number, later(2))
        const third = await holder(ctx.a, number, later(3))
        const two = await ctx.users.findByPhoneNumber(ctx.a.environmentId, number, 2)
        expect(two).toHaveLength(2)
        const all = await ctx.users.findByPhoneNumber(ctx.a.environmentId, number, 10)
        expect(new Set(all.map(({ id }) => id))).toEqual(new Set([first, second, third]))
        // A number that was removed finds nobody.
        await ctx.users.removePhoneNumber(
          ctx.a.environmentId,
          first,
          later(4),
          Audit.none('fixture')
        )
        expect(
          (await ctx.users.findByPhoneNumber(ctx.a.environmentId, number, 10)).map(({ id }) => id)
        ).not.toContain(first)
      })

      test('a proof moves the time the number was proven, forward only, and records nothing', async () => {
        const number = unused()
        const id = await holder(ctx.a, number, later(1_000))
        const provenAt = async () =>
          (await ctx.users.findById(ctx.a.environmentId, id))?.phoneNumberVerifiedAt
        await ctx.users.recordPhoneNumberProof(ctx.a.environmentId, id, number, later(5_000))
        expect(await provenAt()).toEqual(later(5_000))
        // Never backwards.
        await ctx.users.recordPhoneNumberProof(ctx.a.environmentId, id, number, later(2_000))
        expect(await provenAt()).toEqual(later(5_000))
        // Not for a number the user no longer holds, and not from another environment.
        await ctx.users.recordPhoneNumberProof(
          ctx.a.environmentId,
          id,
          '+14155550199',
          later(9_000)
        )
        await ctx.users.recordPhoneNumberProof(ctx.b.environmentId, id, number, later(9_000))
        expect(await provenAt()).toEqual(later(5_000))
        expect((await ctx.users.findById(ctx.a.environmentId, id))?.phoneNumber).toBe(number)
        // Bookkeeping: no audit entry of its own.
        expect(await auditOf(ctx.a, id)).toEqual([])
        // An unknown user is not an error.
        await ctx.users.recordPhoneNumberProof(
          ctx.a.environmentId,
          Bun.randomUUIDv7(),
          number,
          later(9_000)
        )
      })
    })

    test('creates a user and finds them by id and by normalized email', async () => {
      const input = user(ctx.a)
      expect(await ctx.users.create(input, Audit.none('fixture'))).toBe(true)
      expect(await ctx.users.findById(ctx.a.environmentId, input.id)).toEqual(record(input))
      expect(await ctx.users.findByEmail(ctx.a.environmentId, input.emailNormalized)).toEqual(
        record(input)
      )
      expect(await ctx.users.findByEmail(ctx.a.environmentId, 'nobody@northline.app')).toBeNull()
      expect(await ctx.users.findById(ctx.a.environmentId, Bun.randomUUIDv7())).toBeNull()
    })

    test('stores optional fields as null', async () => {
      const input = user(ctx.a, { firstName: null, lastName: null, emailVerifiedAt: null })
      await ctx.users.create(input, Audit.none('fixture'))
      expect(await ctx.users.findById(ctx.a.environmentId, input.id)).toMatchObject({
        firstName: null,
        lastName: null,
        emailVerifiedAt: null,
      })
    })

    test('returns the password hash with the user for sign-in', async () => {
      const input = user(ctx.a, { passwordHash: '$argon2id$original' })
      await ctx.users.create(input, Audit.none('fixture'))
      expect(
        await ctx.users.findByEmailWithPassword(ctx.a.environmentId, input.emailNormalized)
      ).toEqual({
        user: record(input),
        passwordHash: '$argon2id$original',
        // A password an account is created with was set when the account was made.
        passwordChangedAt: input.createdAt,
      })
      expect(
        await ctx.users.findByEmailWithPassword(ctx.a.environmentId, 'nobody@northline.app')
      ).toBeNull()
    })

    describe('when a password was set (ADR 0041)', () => {
      const env = () => ctx.a.environmentId
      const changedAt = async (input: Addressed) =>
        (await ctx.users.findByEmailWithPassword(env(), input.emailNormalized))?.passwordChangedAt

      test('a replaced password is as old as the write that replaced it', async () => {
        const input = user(ctx.a, { passwordHash: '$argon2id$first' })
        await ctx.users.create(input, Audit.none('fixture'))
        await ctx.users.setPasswordHash(
          env(),
          input.id,
          '$argon2id$second',
          later(90_000),
          Audit.none('fixture'),
          { keep: 0 }
        )
        expect(await changedAt(input)).toEqual(later(90_000))
      })

      test('a first password is as old as the write that created it', async () => {
        const input = user(ctx.a, { passwordHash: null })
        await ctx.users.create(input, Audit.none('fixture'))
        expect(await changedAt(input)).toBeNull()
        await ctx.users.setPasswordHash(
          env(),
          input.id,
          '$argon2id$first',
          later(5_000),
          Audit.none('fixture'),
          { keep: 0 }
        )
        expect(await changedAt(input)).toEqual(later(5_000))
      })

      test('a hash upgrade does not make the password newer', async () => {
        const input = user(ctx.a, { passwordHash: '$argon2id$weak' })
        await ctx.users.create(input, Audit.none('fixture'))
        expect(
          await ctx.users.upgradePasswordHash(
            env(),
            input.id,
            '$argon2id$weak',
            '$argon2id$strong',
            later(777_000)
          )
        ).toBe(true)
        expect(
          (await ctx.users.findByEmailWithPassword(env(), input.emailNormalized))?.passwordHash
        ).toBe('$argon2id$strong')
        expect(await changedAt(input)).toEqual(input.createdAt)
      })

      test('a write that stores nothing moves nothing', async () => {
        const input = user(ctx.a, { passwordHash: '$argon2id$first' })
        await ctx.users.create(input, Audit.none('fixture'))
        expect(
          await ctx.users.setPasswordHash(
            env(),
            input.id,
            '$argon2id$second',
            later(1_000),
            Audit.none('fixture'),
            { keep: 0, ifCurrent: '$argon2id$not-the-current-one' }
          )
        ).toBe('stale')
        // Another environment's write does not reach the user either.
        await ctx.users.setPasswordHash(
          ctx.b.environmentId,
          input.id,
          '$argon2id$foreign',
          later(2_000),
          Audit.none('fixture'),
          { keep: 0 }
        )
        expect(await changedAt(input)).toEqual(input.createdAt)
      })

      test('a removed password leaves no time behind', async () => {
        const input = user(ctx.a, { passwordHash: '$argon2id$first', emailVerifiedAt: null })
        await ctx.users.create(input, Audit.none('fixture'))
        await ctx.users.markEmailVerified(env(), input.id, later(1_000), Audit.none('fixture'), {
          activity: Audit.none('fixture'),
        })
        expect(await ctx.users.findByEmailWithPassword(env(), input.emailNormalized)).toMatchObject(
          { passwordHash: null, passwordChangedAt: null }
        )
      })
    })

    test('refuses a duplicate email in the same environment and writes nothing', async () => {
      const first = user(ctx.a)
      const second = user(ctx.a, { emailNormalized: first.emailNormalized })
      expect(await ctx.users.create(first, Audit.none('fixture'))).toBe(true)
      expect(await ctx.users.create(second, Audit.none('fixture'))).toBe(false)
      expect(await ctx.users.findById(ctx.a.environmentId, second.id)).toBeNull()
      // Of concurrent creations for one email, exactly one wins.
      const email = `race-${Bun.randomUUIDv7()}@northline.app`
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          ctx.users.create(user(ctx.a, { emailNormalized: email }), Audit.none('fixture'))
        )
      )
      expect(results.filter(Boolean)).toHaveLength(1)
    })

    test('the same email can exist in another environment', async () => {
      const first = user(ctx.a)
      const twin = user(ctx.b, { email: first.email, emailNormalized: first.emailNormalized })
      expect(await ctx.users.create(first, Audit.none('fixture'))).toBe(true)
      expect(await ctx.users.create(twin, Audit.none('fixture'))).toBe(true)
      expect((await ctx.users.findByEmail(ctx.b.environmentId, first.emailNormalized))?.id).toBe(
        twin.id
      )
    })

    test('replaces the password hash, and stores nothing for a user who does not exist', async () => {
      const input = user(ctx.a)
      await ctx.users.create(input, Audit.none('fixture'))
      expect(
        await ctx.users.setPasswordHash(
          ctx.a.environmentId,
          input.id,
          '$argon2id$new',
          later(1_000),
          Audit.none('fixture'),
          { keep: 0 }
        )
      ).toBe('replaced')
      expect(
        await ctx.users.setPasswordHash(
          ctx.a.environmentId,
          Bun.randomUUIDv7(),
          'x',
          later(1),
          Audit.none('fixture'),
          { keep: 0 }
        )
      ).toBeNull()
      expect(
        (await ctx.users.findByEmailWithPassword(ctx.a.environmentId, input.emailNormalized))
          ?.passwordHash
      ).toBe('$argon2id$new')
    })

    test('a user can be created without a password, and found with none', async () => {
      const input = user(ctx.a, { passwordHash: null })
      expect(await ctx.users.create(input, Audit.none('fixture'))).toBe(true)
      expect(await ctx.users.findById(ctx.a.environmentId, input.id)).toEqual(record(input))
      expect(
        await ctx.users.findByEmailWithPassword(ctx.a.environmentId, input.emailNormalized)
      ).toEqual({ user: record(input), passwordHash: null, passwordChangedAt: null })
      // Nothing to upgrade: a hash upgrade never creates a password.
      expect(
        await ctx.users.upgradePasswordHash(ctx.a.environmentId, input.id, 'a', 'b', later(1))
      ).toBe(false)
    })

    test('a first password creates the credential; the next one replaces it', async () => {
      const input = user(ctx.a, { passwordHash: null })
      await ctx.users.create(input, Audit.none('fixture'))
      const env = ctx.a.environmentId
      const stored = async () =>
        (await ctx.users.findByEmailWithPassword(env, input.emailNormalized))?.passwordHash
      // Another environment cannot give this user a password.
      expect(
        await ctx.users.setPasswordHash(
          ctx.b.environmentId,
          input.id,
          '$argon2id$x',
          later(1),
          Audit.none('fixture'),
          { keep: 0 }
        )
      ).toBeNull()
      expect(await stored()).toBeNull()

      expect(
        await ctx.users.setPasswordHash(
          env,
          input.id,
          '$argon2id$first',
          later(1),
          Audit.none('fixture'),
          { keep: 0 }
        )
      ).toBe('created')
      expect(await stored()).toBe('$argon2id$first')
      expect(
        await ctx.users.setPasswordHash(
          env,
          input.id,
          '$argon2id$second',
          later(2),
          Audit.none('fixture'),
          { keep: 0 }
        )
      ).toBe('replaced')
      expect(await stored()).toBe('$argon2id$second')
    })

    test('of concurrent first passwords exactly one creates the credential', async () => {
      const input = user(ctx.a, { passwordHash: null })
      await ctx.users.create(input, Audit.none('fixture'))
      const outcomes = await Promise.all(
        [1, 2, 3, 4].map((n) =>
          ctx.users.setPasswordHash(
            ctx.a.environmentId,
            input.id,
            `$argon2id$${n}`,
            later(n),
            Audit.none('fixture'),
            { keep: 0 }
          )
        )
      )
      expect(outcomes.filter((outcome) => outcome === 'created')).toHaveLength(1)
      expect(outcomes.filter((outcome) => outcome === 'replaced')).toHaveLength(3)
      expect(
        (await ctx.users.findByEmailWithPassword(ctx.a.environmentId, input.emailNormalized))
          ?.passwordHash
      ).toMatch(/^\$argon2id\$[1-4]$/)
    })

    describe('previous passwords (ADR 0038)', () => {
      const hashOf = (n: number | string) => `$argon2id$${n}`

      // An adapter's tests may share one database: what an earlier test kept is not the next
      // one's to count.
      beforeEach(async () => {
        for (const tenant of [ctx.a, ctx.b]) {
          await ctx.users.deletePasswordHistoryBeyond(tenant.environmentId, 0, 10_000)
        }
      })

      /** Store a password; the history rule defaults to "keep five, compare nothing". */
      const change = (
        tenant: UserSuiteTenant,
        userId: string,
        n: number | string,
        history: { keep: number; ifCurrent?: string | null } = { keep: 5 }
      ) =>
        ctx.users.setPasswordHash(
          tenant.environmentId,
          userId,
          hashOf(n),
          later(1),
          Audit.none('fixture'),
          history
        )

      /** A user whose password is `$argon2id$0`. */
      async function seeded(tenant: UserSuiteTenant = ctx.a): Promise<Addressed> {
        const input = user(tenant, { passwordHash: hashOf(0) })
        await ctx.users.create(input, Audit.none('fixture'))
        return input
      }

      const stored = (tenant: UserSuiteTenant, userId: string, previous = 24) =>
        ctx.users.storedPasswords(tenant.environmentId, userId, previous)

      test('a new user has a current password and none before it', async () => {
        const input = await seeded()
        expect(await stored(ctx.a, input.id)).toEqual({ current: hashOf(0), previous: [] })
        const none = user(ctx.a, { passwordHash: null })
        await ctx.users.create(none, Audit.none('fixture'))
        expect(await stored(ctx.a, none.id)).toEqual({ current: null, previous: [] })
        expect(await stored(ctx.a, Bun.randomUUIDv7())).toEqual({ current: null, previous: [] })
      })

      test('the replaced hash becomes the newest previous one, newest first', async () => {
        const input = await seeded()
        expect(await change(ctx.a, input.id, 1)).toBe('replaced')
        expect(await change(ctx.a, input.id, 2)).toBe('replaced')
        expect(await change(ctx.a, input.id, 3)).toBe('replaced')
        expect(await stored(ctx.a, input.id)).toEqual({
          current: hashOf(3),
          previous: [hashOf(2), hashOf(1), hashOf(0)],
        })
        // Only as many as were asked for, and none when none are.
        expect((await stored(ctx.a, input.id, 2)).previous).toEqual([hashOf(2), hashOf(1)])
        expect(await stored(ctx.a, input.id, 0)).toEqual({ current: hashOf(3), previous: [] })
      })

      test('what is beyond `keep` is deleted by the write that pushes it there', async () => {
        const input = await seeded()
        for (const n of [1, 2, 3, 4]) {
          await change(ctx.a, input.id, n, { keep: 2 })
        }
        expect(await stored(ctx.a, input.id)).toEqual({
          current: hashOf(4),
          previous: [hashOf(3), hashOf(2)],
        })
      })

      test('a lowered `keep` deletes the surplus at the next write', async () => {
        const input = await seeded()
        for (const n of [1, 2, 3, 4]) {
          await change(ctx.a, input.id, n)
        }
        await change(ctx.a, input.id, 5, { keep: 1 })
        expect(await stored(ctx.a, input.id)).toEqual({ current: hashOf(5), previous: [hashOf(4)] })
      })

      test('`keep: 0` keeps nothing, and deletes what was kept before', async () => {
        const input = await seeded()
        await change(ctx.a, input.id, 1, { keep: 0 })
        expect(await stored(ctx.a, input.id)).toEqual({ current: hashOf(1), previous: [] })
        await change(ctx.a, input.id, 2)
        await change(ctx.a, input.id, 3)
        expect((await stored(ctx.a, input.id)).previous).toHaveLength(2)
        await change(ctx.a, input.id, 4, { keep: 0 })
        expect(await stored(ctx.a, input.id)).toEqual({ current: hashOf(4), previous: [] })
        // Nothing is left for the retention job either.
        expect(await ctx.users.deletePasswordHistoryBeyond(ctx.a.environmentId, 0, 100)).toBe(0)
      })

      test('a first password keeps nothing: there was none before it', async () => {
        const input = user(ctx.a, { passwordHash: null })
        await ctx.users.create(input, Audit.none('fixture'))
        expect(await change(ctx.a, input.id, 1, { keep: 5, ifCurrent: null })).toBe('created')
        expect(await stored(ctx.a, input.id)).toEqual({ current: hashOf(1), previous: [] })
      })

      test('a write judged against a hash that is no longer stored is stale and writes nothing', async () => {
        const input = await seeded()
        await change(ctx.a, input.id, 1)
        const before = await stored(ctx.a, input.id)
        const entries = await auditOf(ctx.a, input.id)
        for (const ifCurrent of [hashOf(0), hashOf('other'), null]) {
          expect(
            await ctx.users.setPasswordHash(
              ctx.a.environmentId,
              input.id,
              hashOf(9),
              later(5),
              activity(ctx.a, 'user.password_changed', input.id),
              { keep: 5, ifCurrent }
            )
          ).toBe('stale')
        }
        expect(await stored(ctx.a, input.id)).toEqual(before)
        expect(await auditOf(ctx.a, input.id)).toEqual(entries)
        // The hash it was really judged against goes through.
        expect(await change(ctx.a, input.id, 9, { keep: 5, ifCurrent: hashOf(1) })).toBe('replaced')
      })

      test('two concurrent changes neither lose nor duplicate a previous password', async () => {
        const input = await seeded()
        const outcomes = await Promise.all([
          change(ctx.a, input.id, 'a'),
          change(ctx.a, input.id, 'b'),
          change(ctx.a, input.id, 'c'),
        ])
        expect(outcomes).toEqual(['replaced', 'replaced', 'replaced'])
        const after = await stored(ctx.a, input.id)
        // Every hash that was ever current is there exactly once: one as the current password,
        // the others, with the one they all replaced, before it.
        expect([after.current, ...after.previous].sort()).toEqual(
          [hashOf(0), hashOf('a'), hashOf('b'), hashOf('c')].sort()
        )
        expect(after.previous.at(-1)).toBe(hashOf(0))
      })

      test('of concurrent changes judged against the same hash exactly one is stored', async () => {
        const input = await seeded()
        const outcomes = await Promise.all(
          ['a', 'b', 'c', 'd'].map((n) =>
            change(ctx.a, input.id, n, { keep: 5, ifCurrent: hashOf(0) })
          )
        )
        expect(outcomes.filter((outcome) => outcome === 'replaced')).toHaveLength(1)
        expect(outcomes.filter((outcome) => outcome === 'stale')).toHaveLength(3)
        const after = await stored(ctx.a, input.id)
        expect(after.current).toMatch(/^\$argon2id\$[abcd]$/)
        expect(after.previous).toEqual([hashOf(0)])
      })

      test('previous passwords belong to one user of one environment', async () => {
        const mine = await seeded()
        const theirs = await seeded()
        const twin = await seeded(ctx.b)
        await change(ctx.a, mine.id, 1)
        await change(ctx.a, mine.id, 2)
        expect(await stored(ctx.a, theirs.id)).toEqual({ current: hashOf(0), previous: [] })
        expect(await stored(ctx.b, twin.id)).toEqual({ current: hashOf(0), previous: [] })
        // Asked under the other environment, the user has nothing at all.
        expect(await stored(ctx.b, mine.id)).toEqual({ current: null, previous: [] })
        // And the other environment can neither change the password nor move the history.
        expect(await change(ctx.b, mine.id, 9)).toBeNull()
        expect(await stored(ctx.a, mine.id)).toEqual({
          current: hashOf(2),
          previous: [hashOf(1), hashOf(0)],
        })
      })

      test('a hash upgrade is not a new password: no previous password is added', async () => {
        const input = await seeded()
        await change(ctx.a, input.id, 1)
        expect(
          await ctx.users.upgradePasswordHash(
            ctx.a.environmentId,
            input.id,
            hashOf(1),
            hashOf('1-upgraded'),
            later(9)
          )
        ).toBe(true)
        expect(await stored(ctx.a, input.id)).toEqual({
          current: hashOf('1-upgraded'),
          previous: [hashOf(0)],
        })
      })

      test('removing the password of an unproven address removes the ones before it', async () => {
        const input = user(ctx.a, { emailVerifiedAt: null, passwordHash: hashOf(0) })
        await ctx.users.create(input, Audit.none('fixture'))
        await change(ctx.a, input.id, 1)
        await change(ctx.a, input.id, 2)
        expect(
          await ctx.users.markEmailVerified(
            ctx.a.environmentId,
            input.id,
            later(10),
            Audit.none('fixture'),
            { activity: Audit.none('fixture') }
          )
        ).toEqual({ passwordRemoved: true })
        expect(await stored(ctx.a, input.id)).toEqual({ current: null, previous: [] })
        expect(await ctx.users.deletePasswordHistoryBeyond(ctx.a.environmentId, 0, 100)).toBe(0)
        // The owner's first password starts a history of its own.
        expect(await change(ctx.a, input.id, 'owner', { keep: 5, ifCurrent: null })).toBe('created')
        expect(await stored(ctx.a, input.id)).toEqual({ current: hashOf('owner'), previous: [] })
      })

      test('verifying an address without removing the password keeps the history', async () => {
        const input = user(ctx.a, { emailVerifiedAt: null, passwordHash: hashOf(0) })
        await ctx.users.create(input, Audit.none('fixture'))
        await change(ctx.a, input.id, 1)
        await ctx.users.markEmailVerified(
          ctx.a.environmentId,
          input.id,
          later(10),
          Audit.none('fixture')
        )
        expect(await stored(ctx.a, input.id)).toEqual({ current: hashOf(1), previous: [hashOf(0)] })
      })

      test('an address that was already proven keeps its password and its history', async () => {
        const input = await seeded()
        await change(ctx.a, input.id, 1)
        expect(
          await ctx.users.markEmailVerified(
            ctx.a.environmentId,
            input.id,
            later(10),
            Audit.none('fixture'),
            { activity: Audit.none('fixture') }
          )
        ).toEqual({ passwordRemoved: false })
        expect(await stored(ctx.a, input.id)).toEqual({ current: hashOf(1), previous: [hashOf(0)] })
      })

      test('deleting a user deletes their previous passwords', async () => {
        const input = await seeded()
        const other = await seeded()
        await change(ctx.a, input.id, 1)
        await change(ctx.a, input.id, 2)
        await change(ctx.a, other.id, 1)
        expect(await ctx.users.delete(ctx.a.environmentId, input.id, Audit.none('fixture'))).toBe(
          true
        )
        expect(await stored(ctx.a, input.id)).toEqual({ current: null, previous: [] })
        // Only the other user's one row is left for a purge to find.
        expect(await ctx.users.deletePasswordHistoryBeyond(ctx.a.environmentId, 0, 100)).toBe(1)
      })

      test('the purge deletes what is beyond `keep`, in batches, in one environment', async () => {
        const first = await seeded()
        const second = await seeded()
        const twin = await seeded(ctx.b)
        for (const n of [1, 2, 3, 4]) {
          await change(ctx.a, first.id, n)
          await change(ctx.a, second.id, n)
          await change(ctx.b, twin.id, n)
        }
        const purge = (keep: number, limit: number) =>
          ctx.users.deletePasswordHistoryBeyond(ctx.a.environmentId, keep, limit)
        // Nothing is beyond four.
        expect(await purge(4, 100)).toBe(0)
        // Two users with two rows too many each: three now, the fourth in the next batch.
        expect(await purge(2, 3)).toBe(3)
        expect(await purge(2, 3)).toBe(1)
        expect(await purge(2, 3)).toBe(0)
        for (const input of [first, second]) {
          expect(await stored(ctx.a, input.id)).toEqual({
            current: hashOf(4),
            previous: [hashOf(3), hashOf(2)],
          })
        }
        expect(await purge(0, 100)).toBe(4)
        expect((await stored(ctx.a, first.id)).previous).toEqual([])
        // The other environment's rows were never in reach.
        expect((await stored(ctx.b, twin.id)).previous).toEqual([
          hashOf(3),
          hashOf(2),
          hashOf(1),
          hashOf(0),
        ])
      })
    })

    test('marks the email verified once and records sign-ins', async () => {
      const input = user(ctx.a, { emailVerifiedAt: null })
      await ctx.users.create(input, Audit.none('fixture'))
      await ctx.users.markEmailVerified(
        ctx.a.environmentId,
        input.id,
        later(1_000),
        Audit.none('fixture')
      )
      await ctx.users.markEmailVerified(
        ctx.a.environmentId,
        input.id,
        later(9_000),
        Audit.none('fixture')
      )
      await ctx.users.recordSignIn(ctx.a.environmentId, input.id, later(2_000))
      expect(await ctx.users.findById(ctx.a.environmentId, input.id)).toMatchObject({
        emailVerifiedAt: later(1_000),
        lastSignInAt: later(2_000),
      })
    })

    describe('verifying an address nobody had proven, with the password removed', () => {
      const hashOf = async (input: Addressed) =>
        (await ctx.users.findByEmailWithPassword(ctx.a.environmentId, input.emailNormalized))
          ?.passwordHash

      test('an unverified user is verified and loses the password, in one write', async () => {
        const input = user(ctx.a, { emailVerifiedAt: null })
        await ctx.users.create(input, Audit.none('fixture'))
        expect(
          await ctx.users.markEmailVerified(
            ctx.a.environmentId,
            input.id,
            later(1),
            Audit.none('fixture'),
            { activity: Audit.none('fixture') }
          )
        ).toEqual({ passwordRemoved: true })
        expect(await hashOf(input)).toBeNull()
        expect((await ctx.users.findById(ctx.a.environmentId, input.id))?.emailVerifiedAt).toEqual(
          later(1)
        )
      })

      test('a user who was already verified keeps the password', async () => {
        const input = user(ctx.a)
        await ctx.users.create(input, Audit.none('fixture'))
        expect(
          await ctx.users.markEmailVerified(
            ctx.a.environmentId,
            input.id,
            later(1),
            Audit.none('fixture'),
            { activity: Audit.none('fixture') }
          )
        ).toEqual({ passwordRemoved: false })
        expect(await hashOf(input)).toBe('$argon2id$hash')
      })

      test('an unverified user without a password is verified and nothing is removed', async () => {
        const input = user(ctx.a, { emailVerifiedAt: null, passwordHash: null })
        await ctx.users.create(input, Audit.none('fixture'))
        expect(
          await ctx.users.markEmailVerified(
            ctx.a.environmentId,
            input.id,
            later(1),
            Audit.none('fixture'),
            { activity: Audit.none('fixture') }
          )
        ).toEqual({ passwordRemoved: false })
      })

      test('without the option the password stays, as before', async () => {
        const input = user(ctx.a, { emailVerifiedAt: null })
        await ctx.users.create(input, Audit.none('fixture'))
        expect(
          await ctx.users.markEmailVerified(
            ctx.a.environmentId,
            input.id,
            later(1),
            Audit.none('fixture')
          )
        ).toEqual({
          passwordRemoved: false,
        })
        expect(await hashOf(input)).toBe('$argon2id$hash')
      })

      test('another environment’s call removes nothing', async () => {
        const input = user(ctx.a, { emailVerifiedAt: null })
        await ctx.users.create(input, Audit.none('fixture'))
        expect(
          await ctx.users.markEmailVerified(
            ctx.b.environmentId,
            input.id,
            later(1),
            Audit.none('fixture'),
            { activity: Audit.none('fixture') }
          )
        ).toEqual({ passwordRemoved: false })
        expect(await hashOf(input)).toBe('$argon2id$hash')
      })

      test('a password set afterwards is kept by a second call', async () => {
        const input = user(ctx.a, { emailVerifiedAt: null })
        await ctx.users.create(input, Audit.none('fixture'))
        await ctx.users.markEmailVerified(
          ctx.a.environmentId,
          input.id,
          later(1),
          Audit.none('fixture'),
          { activity: Audit.none('fixture') }
        )
        await ctx.users.setPasswordHash(
          ctx.a.environmentId,
          input.id,
          '$argon2id$own',
          later(2),
          Audit.none('fixture'),
          { keep: 0 }
        )
        expect(
          await ctx.users.markEmailVerified(
            ctx.a.environmentId,
            input.id,
            later(3),
            Audit.none('fixture'),
            { activity: Audit.none('fixture') }
          )
        ).toEqual({ passwordRemoved: false })
        expect(await hashOf(input)).toBe('$argon2id$own')
      })
    })

    test('lists a page with the total, newest first by default sort', async () => {
      const inputs = [0, 1, 2, 3, 4].map((i) =>
        user(ctx.a, { createdAt: later(i * 1_000), emailNormalized: `list-${i}@page.test` })
      )
      for (const input of inputs) {
        await ctx.users.create(input, Audit.none('fixture'))
      }
      await ctx.users.create(
        user(ctx.b, { emailNormalized: 'list-9@page.test' }),
        Audit.none('fixture')
      )
      const criteria = { q: '@page.test', sort: '-createdAt' as const, size: 2 }

      const first = await ctx.users.list(ctx.a.environmentId, { ...criteria, page: 1 })
      expect(first.totalCount).toBe(5)
      expect(first.users.map((u) => u.id)).toEqual([inputs[4]?.id, inputs[3]?.id] as string[])
      const last = await ctx.users.list(ctx.a.environmentId, { ...criteria, page: 3 })
      expect(last.users.map((u) => u.id)).toEqual([inputs[0]?.id] as string[])
      expect(first.users[0]).toEqual(record(inputs[4] as NewUser))
      expect((await ctx.users.list(ctx.a.environmentId, { ...criteria, page: 4 })).users).toEqual(
        []
      )
    })

    test('sorts by email and by last sign-in, in both directions', async () => {
      const tag = Bun.randomUUIDv7()
      const [b, a, c] = ['b', 'a', 'c'].map((letter) =>
        user(ctx.a, { emailNormalized: `${letter}-${tag}@sort.test` })
      ) as [NewUser, NewUser, NewUser]
      for (const input of [b, a, c]) {
        await ctx.users.create(input, Audit.none('fixture'))
      }
      await ctx.users.recordSignIn(ctx.a.environmentId, a.id, later(2_000))
      await ctx.users.recordSignIn(ctx.a.environmentId, c.id, later(1_000))
      const ids = async (sort: Parameters<UserRepository['list']>[1]['sort']) =>
        (await ctx.users.list(ctx.a.environmentId, { q: tag, sort, page: 1, size: 10 })).users.map(
          (u) => u.id
        )
      expect(await ids('email')).toEqual([a.id, b.id, c.id])
      expect(await ids('-email')).toEqual([c.id, b.id, a.id])
      // Users who never signed in sort last either way.
      expect(await ids('-lastSignInAt')).toEqual([a.id, c.id, b.id])
      expect(await ids('lastSignInAt')).toEqual([c.id, a.id, b.id])
    })

    test('users without a sort value are ordered by id, so paging stays stable', async () => {
      const tag = Bun.randomUUIDv7()
      const never = [0, 1, 2].map(() =>
        user(ctx.a, { emailNormalized: `${Bun.randomUUIDv7()}-${tag}@never.test` })
      )
      for (const input of never) {
        await ctx.users.create(input, Audit.none('fixture'))
      }
      const sorted = never.map((u) => u.id).sort()
      const ids = async (sort: Parameters<UserRepository['list']>[1]['sort']) =>
        (await ctx.users.list(ctx.a.environmentId, { q: tag, sort, page: 1, size: 10 })).users.map(
          (u) => u.id
        )
      expect(await ids('lastSignInAt')).toEqual(sorted)
      expect(await ids('-lastSignInAt')).toEqual([...sorted].reverse())
    })

    test('searches email and names case-insensitively, treating wildcards literally', async () => {
      const tag = Bun.randomUUIDv7()
      const maya = user(ctx.a, {
        emailNormalized: `maya-${tag}@northline.app`,
        firstName: 'Maya',
        lastName: `Okafor-${tag}`,
      })
      const percent = user(ctx.a, {
        emailNormalized: `odd-${tag}@northline.app`,
        firstName: '100%_real',
        lastName: null,
      })
      await ctx.users.create(maya, Audit.none('fixture'))
      await ctx.users.create(percent, Audit.none('fixture'))
      const search = async (q: string) =>
        (
          await ctx.users.list(ctx.a.environmentId, { q, sort: 'email', page: 1, size: 10 })
        ).users.map((u) => u.id)

      expect(await search(`MAYA-${tag.toUpperCase()}`)).toEqual([maya.id])
      expect(await search(`okafor-${tag}`)).toEqual([maya.id])
      expect(await search('100%_re')).toEqual([percent.id])
      // `%` and `_` are not wildcards: this would match everyone if they were.
      expect(await search(`%${tag}_`)).toEqual([])
      expect(await search(`no-such-user-${tag}`)).toEqual([])
    })

    test('bans keep the first ban time, and unbans clear it', async () => {
      const input = user(ctx.a)
      await ctx.users.create(input, Audit.none('fixture'))
      expect(
        (
          await ctx.users.setBanned(
            ctx.a.environmentId,
            input.id,
            later(1_000),
            later(1_000),
            Audit.none('fixture')
          )
        )?.bannedAt
      ).toEqual(later(1_000))
      expect(
        (
          await ctx.users.setBanned(
            ctx.a.environmentId,
            input.id,
            later(5_000),
            later(5_000),
            Audit.none('fixture')
          )
        )?.bannedAt
      ).toEqual(later(1_000))
      expect(
        (
          await ctx.users.setBanned(
            ctx.a.environmentId,
            input.id,
            null,
            later(6_000),
            Audit.none('fixture')
          )
        )?.bannedAt
      ).toBeNull()
      expect(
        await ctx.users.setBanned(
          ctx.a.environmentId,
          Bun.randomUUIDv7(),
          later(1),
          later(1),
          Audit.none('fixture')
        )
      ).toBeNull()
    })

    test('deletes a user and frees their email', async () => {
      const input = user(ctx.a)
      await ctx.users.create(input, Audit.none('fixture'))
      expect(await ctx.users.delete(ctx.a.environmentId, input.id, Audit.none('fixture'))).toBe(
        true
      )
      expect(await ctx.users.delete(ctx.a.environmentId, input.id, Audit.none('fixture'))).toBe(
        false
      )
      expect(await ctx.users.findById(ctx.a.environmentId, input.id)).toBeNull()
      expect(
        await ctx.users.findByEmailWithPassword(ctx.a.environmentId, input.emailNormalized)
      ).toBeNull()
      expect(
        await ctx.users.create(
          user(ctx.a, { emailNormalized: input.emailNormalized }),
          Audit.none('fixture')
        )
      ).toBe(true)
    })

    test('one environment cannot list, ban or delete another’s users', async () => {
      const input = user(ctx.a)
      await ctx.users.create(input, Audit.none('fixture'))
      const foreign = ctx.b.environmentId
      const listed = await ctx.users.list(foreign, {
        q: input.emailNormalized,
        sort: 'email',
        page: 1,
        size: 10,
      })
      expect(listed).toEqual({ users: [], totalCount: 0 })
      expect(
        await ctx.users.setBanned(foreign, input.id, later(1), later(1), Audit.none('fixture'))
      ).toBeNull()
      expect(await ctx.users.delete(foreign, input.id, Audit.none('fixture'))).toBe(false)
      expect(await ctx.users.findById(ctx.a.environmentId, input.id)).toEqual(record(input))
    })

    test('one environment cannot read or change another’s users', async () => {
      const input = user(ctx.a, { emailVerifiedAt: null })
      await ctx.users.create(input, Audit.none('fixture'))
      const foreign = ctx.b.environmentId
      expect(await ctx.users.findById(foreign, input.id)).toBeNull()
      expect(await ctx.users.findByEmail(foreign, input.emailNormalized)).toBeNull()
      expect(await ctx.users.findByEmailWithPassword(foreign, input.emailNormalized)).toBeNull()
      await ctx.users.setPasswordHash(
        foreign,
        input.id,
        '$argon2id$stolen',
        later(1),
        Audit.none('fixture'),
        { keep: 0 }
      )
      await ctx.users.markEmailVerified(foreign, input.id, later(1), Audit.none('fixture'))
      await ctx.users.recordSignIn(foreign, input.id, later(1))
      expect(
        await ctx.users.findByEmailWithPassword(ctx.a.environmentId, input.emailNormalized)
      ).toEqual({
        user: record(input),
        passwordHash: '$argon2id$hash',
        passwordChangedAt: input.createdAt,
      })
    })

    test('a hash upgrade replaces the hash only if it is still the one that was verified', async () => {
      const input = user(ctx.a, { passwordHash: '$argon2id$weak' })
      await ctx.users.create(input, Audit.none('fixture'))
      const env = ctx.a.environmentId
      const stored = async () =>
        (await ctx.users.findByEmailWithPassword(env, input.emailNormalized))?.passwordHash
      const upgrade = (current: string, next: string, environmentId = env) =>
        ctx.users.upgradePasswordHash(environmentId, input.id, current, next, later(1))

      expect(await upgrade('$argon2id$weak', '$argon2id$strong')).toBe(true)
      expect(await stored()).toBe('$argon2id$strong')

      // The password was changed after the old hash was read: the upgrade must not undo that.
      await ctx.users.setPasswordHash(
        env,
        input.id,
        '$argon2id$changed',
        later(2),
        Audit.none('fixture'),
        { keep: 0 }
      )
      expect(await upgrade('$argon2id$strong', '$argon2id$stale')).toBe(false)
      expect(await stored()).toBe('$argon2id$changed')

      // Unknown user, or another environment: nothing happens.
      expect(await upgrade('$argon2id$changed', '$argon2id$x', ctx.b.environmentId)).toBe(false)
      expect(await ctx.users.upgradePasswordHash(env, Bun.randomUUIDv7(), 'a', 'b', later(3))).toBe(
        false
      )
      expect(await stored()).toBe('$argon2id$changed')
    })

    describe('provider identities', () => {
      const identity = (tenant: UserSuiteTenant, userId: string, overrides = {}) => ({
        id: Bun.randomUUIDv7(),
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        userId,
        provider: 'google' as const,
        subject: `sub-${Bun.randomUUIDv7()}`,
        createdAt: now,
        ...overrides,
      })
      const anyway = () => true

      test('creates a user with a provider identity and finds them by it, in their environment only', async () => {
        const oauthIdentity = {
          id: Bun.randomUUIDv7(),
          provider: 'github' as const,
          subject: '583231',
        }
        const input = user(ctx.a, { passwordHash: null, oauthIdentity })
        expect(await ctx.users.create(input, Audit.none('fixture'))).toBe(true)
        const found = await ctx.users.findByIdentity(ctx.a.environmentId, 'github', '583231')
        expect(found?.id).toBe(input.id)
        expect(await ctx.users.findByIdentity(ctx.b.environmentId, 'github', '583231')).toBeNull()
        expect(await ctx.users.findByIdentity(ctx.a.environmentId, 'google', '583231')).toBeNull()
        // The `email` identity is never listed: only provider accounts are.
        expect(await ctx.users.listIdentities(ctx.a.environmentId, input.id)).toEqual([
          {
            id: oauthIdentity.id,
            userId: input.id,
            provider: 'github',
            subject: '583231',
            createdAt: now,
          },
        ])
        expect(await ctx.users.listIdentities(ctx.b.environmentId, input.id)).toEqual([])
      })

      test('a provider account that is taken creates no second user, and nothing of it is written', async () => {
        const oauthIdentity = {
          id: Bun.randomUUIDv7(),
          provider: 'google' as const,
          subject: 'taken',
        }
        expect(await ctx.users.create(user(ctx.a, { oauthIdentity }), Audit.none('fixture'))).toBe(
          true
        )
        const second = user(ctx.a, { oauthIdentity: { ...oauthIdentity, id: Bun.randomUUIDv7() } })
        expect(await ctx.users.create(second, Audit.none('fixture'))).toBe(false)
        expect(await ctx.users.findById(ctx.a.environmentId, second.id)).toBeNull()
        expect(await ctx.users.findByEmail(ctx.a.environmentId, second.emailNormalized)).toBeNull()
        // The same account in another environment is another account.
        expect(
          await ctx.users.create(
            user(ctx.b, { oauthIdentity: { ...oauthIdentity, id: Bun.randomUUIDv7() } }),
            Audit.none('fixture')
          )
        ).toBe(true)
      })

      test('two concurrent sign-ups with one provider account: exactly one user', async () => {
        const subject = `race-${Bun.randomUUIDv7()}`
        const inputs = [1, 2].map(() =>
          user(ctx.a, {
            oauthIdentity: { id: Bun.randomUUIDv7(), provider: 'google' as const, subject },
          })
        )
        const results = await Promise.all(
          inputs.map((input) => ctx.users.create(input, Audit.none('fixture')))
        )
        expect(results.filter(Boolean)).toHaveLength(1)
      })

      test('links an identity to a user; the account belongs to one user and a user has one per provider', async () => {
        const [maya, zed] = [user(ctx.a), user(ctx.a)]
        await ctx.users.create(maya, Audit.none('fixture'))
        await ctx.users.create(zed, Audit.none('fixture'))
        const first = identity(ctx.a, maya.id)
        expect(await ctx.users.linkIdentity(first, Audit.none('fixture'))).toBe('linked')
        expect(
          (await ctx.users.findByIdentity(ctx.a.environmentId, 'google', first.subject))?.id
        ).toBe(maya.id)
        // The same provider account, for anyone: in use.
        expect(
          await ctx.users.linkIdentity(
            identity(ctx.a, zed.id, { subject: first.subject }),
            Audit.none('fixture')
          )
        ).toBe('identity_in_use')
        expect(
          await ctx.users.linkIdentity({ ...first, id: Bun.randomUUIDv7() }, Audit.none('fixture'))
        ).toBe('identity_in_use')
        // A second account of the same provider for the same user.
        expect(await ctx.users.linkIdentity(identity(ctx.a, maya.id), Audit.none('fixture'))).toBe(
          'provider_linked'
        )
        // Another provider is fine.
        expect(
          await ctx.users.linkIdentity(
            identity(ctx.a, maya.id, { provider: 'github' }),
            Audit.none('fixture')
          )
        ).toBe('linked')
        expect(
          (await ctx.users.listIdentities(ctx.a.environmentId, maya.id))
            .map((i) => i.provider)
            .sort()
        ).toEqual(['github', 'google'])
        expect(await ctx.users.listIdentities(ctx.a.environmentId, zed.id)).toEqual([])
      })

      test('two concurrent links of one provider account: exactly one is linked', async () => {
        const [maya, zed] = [user(ctx.a), user(ctx.a)]
        await ctx.users.create(maya, Audit.none('fixture'))
        await ctx.users.create(zed, Audit.none('fixture'))
        const subject = `race-${Bun.randomUUIDv7()}`
        const outcomes = await Promise.all(
          [maya, zed].map((owner) =>
            ctx.users.linkIdentity(identity(ctx.a, owner.id, { subject }), Audit.none('fixture'))
          )
        )
        expect(outcomes.sort()).toEqual(['identity_in_use', 'linked'])
      })

      test('a link is refused for a user who is gone, or in another environment', async () => {
        const maya = user(ctx.a)
        await ctx.users.create(maya, Audit.none('fixture'))
        expect(await ctx.users.linkIdentity(identity(ctx.b, maya.id), Audit.none('fixture'))).toBe(
          'user_changed'
        )
        await ctx.users.delete(ctx.a.environmentId, maya.id, Audit.none('fixture'))
        expect(await ctx.users.linkIdentity(identity(ctx.a, maya.id), Audit.none('fixture'))).toBe(
          'user_changed'
        )
      })

      test('a guarded link needs the address to still be the user’s, and verified', async () => {
        const verified = user(ctx.a)
        const unverified = user(ctx.a, { emailVerifiedAt: null })
        await ctx.users.create(verified, Audit.none('fixture'))
        await ctx.users.create(unverified, Audit.none('fixture'))
        expect(
          await ctx.users.linkIdentity(identity(ctx.a, unverified.id), Audit.none('fixture'), {
            emailNormalized: unverified.emailNormalized,
          })
        ).toBe('user_changed')
        expect(
          await ctx.users.linkIdentity(identity(ctx.a, verified.id), Audit.none('fixture'), {
            emailNormalized: 'someone-else@northline.app',
          })
        ).toBe('user_changed')
        expect(await ctx.users.listIdentities(ctx.a.environmentId, verified.id)).toEqual([])
        expect(
          await ctx.users.linkIdentity(identity(ctx.a, verified.id), Audit.none('fixture'), {
            emailNormalized: verified.emailNormalized,
          })
        ).toBe('linked')
      })

      test('unlinking asks the caller with what would remain, and removes only when allowed', async () => {
        const maya = user(ctx.a, { passwordHash: null, emailVerifiedAt: null })
        await ctx.users.create(maya, Audit.none('fixture'))
        const [google, github] = [
          identity(ctx.a, maya.id),
          identity(ctx.a, maya.id, { provider: 'github' }),
        ]
        await ctx.users.linkIdentity(google, Audit.none('fixture'))
        await ctx.users.linkIdentity(github, Audit.none('fixture'))
        const seen: unknown[] = []
        const refuse = (remaining: unknown) => {
          seen.push(remaining)
          return false
        }
        expect(
          await ctx.users.unlinkIdentity(
            ctx.a.environmentId,
            maya.id,
            google.id,
            refuse,
            Audit.none('fixture')
          )
        ).toBe('last_method')
        expect(seen).toEqual([
          { hasPassword: false, emailVerified: false, providers: ['github'], passkeys: 0 },
        ])
        expect(await ctx.users.listIdentities(ctx.a.environmentId, maya.id)).toHaveLength(2)
        expect(
          await ctx.users.unlinkIdentity(
            ctx.a.environmentId,
            maya.id,
            google.id,
            anyway,
            Audit.none('fixture')
          )
        ).toBe('unlinked')
        expect(
          (await ctx.users.listIdentities(ctx.a.environmentId, maya.id)).map((i) => i.id)
        ).toEqual([github.id])
        expect(
          await ctx.users.findByIdentity(ctx.a.environmentId, 'google', google.subject)
        ).toBeNull()
      })

      test('what remains counts the password and the verified address', async () => {
        const maya = user(ctx.a)
        await ctx.users.create(maya, Audit.none('fixture'))
        const google = identity(ctx.a, maya.id)
        await ctx.users.linkIdentity(google, Audit.none('fixture'))
        let remaining: unknown
        await ctx.users.unlinkIdentity(
          ctx.a.environmentId,
          maya.id,
          google.id,
          (means) => {
            remaining = means
            return true
          },
          Audit.none('fixture')
        )
        expect(remaining).toEqual({
          hasPassword: true,
          emailVerified: true,
          providers: [],
          passkeys: 0,
        })
      })

      test('unlinking an unknown identity, another user’s, or across environments is not found', async () => {
        const [maya, zed] = [user(ctx.a), user(ctx.a)]
        await ctx.users.create(maya, Audit.none('fixture'))
        await ctx.users.create(zed, Audit.none('fixture'))
        const google = identity(ctx.a, maya.id)
        await ctx.users.linkIdentity(google, Audit.none('fixture'))
        expect(
          await ctx.users.unlinkIdentity(
            ctx.a.environmentId,
            zed.id,
            google.id,
            anyway,
            Audit.none('fixture')
          )
        ).toBe('not_found')
        expect(
          await ctx.users.unlinkIdentity(
            ctx.b.environmentId,
            maya.id,
            google.id,
            anyway,
            Audit.none('fixture')
          )
        ).toBe('not_found')
        expect(
          await ctx.users.unlinkIdentity(
            ctx.a.environmentId,
            maya.id,
            Bun.randomUUIDv7(),
            anyway,
            Audit.none('fixture')
          )
        ).toBe('not_found')
        expect(await ctx.users.listIdentities(ctx.a.environmentId, maya.id)).toHaveLength(1)
      })

      test('two concurrent removals cannot both count on the other identity remaining', async () => {
        const maya = user(ctx.a, { passwordHash: null })
        await ctx.users.create(maya, Audit.none('fixture'))
        const [google, github] = [
          identity(ctx.a, maya.id),
          identity(ctx.a, maya.id, { provider: 'github' }),
        ]
        await ctx.users.linkIdentity(google, Audit.none('fixture'))
        await ctx.users.linkIdentity(github, Audit.none('fixture'))
        const needsOne = (remaining: { providers: unknown[] }) => remaining.providers.length > 0
        const outcomes = await Promise.all(
          [google, github].map((target) =>
            ctx.users.unlinkIdentity(
              ctx.a.environmentId,
              maya.id,
              target.id,
              needsOne,
              Audit.none('fixture')
            )
          )
        )
        expect(outcomes.sort()).toEqual(['last_method', 'unlinked'])
        expect(await ctx.users.listIdentities(ctx.a.environmentId, maya.id)).toHaveLength(1)
      })

      describe('a user with no email address (made through X or Facebook)', () => {
        /** A provider's id nobody has yet: the suite's tenants are shared between tests. */
        const freshSubject = () =>
          String(BigInt(`0x${Bun.randomUUIDv7().replaceAll('-', '').slice(-15)}`) + 1n)
        let SUBJECT: string

        beforeEach(() => {
          SUBJECT = freshSubject()
        })

        function addressless(overrides: Partial<NewUser> = {}): NewUser {
          return {
            ...user(ctx.a),
            email: null,
            emailNormalized: null,
            emailVerifiedAt: null,
            passwordHash: null,
            oauthIdentity: { id: Bun.randomUUIDv7(), provider: 'x', subject: SUBJECT },
            ...overrides,
          }
        }

        test('is created with its provider identity and nothing else, and found by it', async () => {
          const nelly = addressless()
          expect(await ctx.users.create(nelly, activity(ctx.a, 'user.created', nelly.id))).toBe(
            true
          )
          const found = await ctx.users.findByIdentity(ctx.a.environmentId, 'x', SUBJECT)
          expect(found).toMatchObject({
            id: nelly.id,
            email: null,
            emailNormalized: null,
            emailVerifiedAt: null,
          })
          expect(await ctx.users.findById(ctx.a.environmentId, nelly.id)).toEqual(found)
          expect(
            (await ctx.users.listIdentities(ctx.a.environmentId, nelly.id)).map(
              (entry) => entry.provider
            )
          ).toEqual(['x'])
          expect(await auditOf(ctx.a, nelly.id)).toEqual(['user.created'])
          // No address finds it: not an empty one, not the word.
          for (const address of ['', 'null', 'undefined']) {
            expect(await ctx.users.findByEmail(ctx.a.environmentId, address)).toBeNull()
            expect(await ctx.users.findByEmailWithPassword(ctx.a.environmentId, address)).toBeNull()
          }
        })

        test('any number of them coexist: having no address is not a conflict', async () => {
          const one = addressless()
          const two = addressless({
            id: Bun.randomUUIDv7(),
            oauthIdentity: { id: Bun.randomUUIDv7(), provider: 'facebook', subject: SUBJECT },
          })
          const three = addressless({
            id: Bun.randomUUIDv7(),
            oauthIdentity: { id: Bun.randomUUIDv7(), provider: 'x', subject: freshSubject() },
          })
          for (const input of [one, two, three]) {
            expect(await ctx.users.create(input, Audit.none('fixture'))).toBe(true)
            expect((await ctx.users.findById(ctx.a.environmentId, input.id))?.email).toBeNull()
          }
        })

        test('two creations for one new provider account at once make one user', async () => {
          const outcomes = await Promise.all(
            [0, 1, 2].map(() =>
              ctx.users.create(addressless({ id: Bun.randomUUIDv7() }), Audit.none('fixture'))
            )
          )
          expect(outcomes.filter(Boolean)).toHaveLength(1)
          expect(await ctx.users.findByIdentity(ctx.a.environmentId, 'x', SUBJECT)).not.toBeNull()
        })

        test('sorts after every address both ways, and a search by address passes it by', async () => {
          // A family name only these two have: the suite's tenants are shared between tests.
          const family = `Fam${SUBJECT}`
          const nelly = addressless({ firstName: `Nelly${SUBJECT}`, lastName: family })
          const maya = user(ctx.a, { lastName: family })
          await ctx.users.create(nelly, Audit.none('fixture'))
          await ctx.users.create(maya, Audit.none('fixture'))
          const ids = async (q: string, sort: 'email' | '-email' = 'email') =>
            (await ctx.users.list(ctx.a.environmentId, { q, page: 1, size: 10, sort })).users.map(
              (entry) => entry.id
            )
          expect(await ids(family, 'email')).toEqual([maya.id, nelly.id])
          expect(await ids(family, '-email')).toEqual([maya.id, nelly.id])
          expect(await ids(maya.emailNormalized)).toEqual([maya.id])
          expect(await ids(`nelly${SUBJECT}`)).toEqual([nelly.id])
        })

        test('has no address to verify: verifying changes nothing and records nothing', async () => {
          const nelly = addressless()
          await ctx.users.create(nelly, Audit.none('fixture'))
          expect(
            await ctx.users.markEmailVerified(
              ctx.a.environmentId,
              nelly.id,
              later(1),
              activity(ctx.a, 'user.email_verified', nelly.id),
              { activity: activity(ctx.a, 'user.password_changed', nelly.id) }
            )
          ).toEqual({ passwordRemoved: false })
          expect(
            (await ctx.users.findById(ctx.a.environmentId, nelly.id))?.emailVerifiedAt
          ).toBeNull()
          expect(await auditOf(ctx.a, nelly.id)).toEqual([])
        })

        test('is never the target of an automatic link, whatever the guard says', async () => {
          const nelly = addressless()
          await ctx.users.create(nelly, Audit.none('fixture'))
          for (const emailNormalized of ['', 'null', 'maya@northline.app']) {
            expect(
              await ctx.users.linkIdentity(identity(ctx.a, nelly.id), Audit.none('fixture'), {
                emailNormalized,
              })
            ).toBe('user_changed')
          }
        })

        test('removing its only identity is asked about with nothing left, and refused', async () => {
          const nelly = addressless()
          await ctx.users.create(nelly, Audit.none('fixture'))
          const seen: unknown[] = []
          const outcome = await ctx.users.unlinkIdentity(
            ctx.a.environmentId,
            nelly.id,
            nelly.oauthIdentity?.id ?? '',
            (remaining) => {
              seen.push(remaining)
              return (
                remaining.hasPassword ||
                remaining.emailVerified ||
                remaining.providers.length > 0 ||
                remaining.passkeys > 0
              )
            },
            Audit.none('fixture')
          )
          expect(outcome).toBe('last_method')
          expect(seen).toEqual([
            { hasPassword: false, emailVerified: false, providers: [], passkeys: 0 },
          ])
          expect(await ctx.users.listIdentities(ctx.a.environmentId, nelly.id)).toHaveLength(1)
        })
      })

      test('deleting a user frees their provider accounts', async () => {
        const maya = user(ctx.a)
        await ctx.users.create(maya, Audit.none('fixture'))
        const google = identity(ctx.a, maya.id)
        await ctx.users.linkIdentity(google, Audit.none('fixture'))
        await ctx.users.delete(ctx.a.environmentId, maya.id, Audit.none('fixture'))
        expect(
          await ctx.users.findByIdentity(ctx.a.environmentId, 'google', google.subject)
        ).toBeNull()
        const zed = user(ctx.a)
        await ctx.users.create(zed, Audit.none('fixture'))
        expect(
          await ctx.users.linkIdentity(
            identity(ctx.a, zed.id, { subject: google.subject }),
            Audit.none('fixture')
          )
        ).toBe('linked')
      })
    })
  })
}
