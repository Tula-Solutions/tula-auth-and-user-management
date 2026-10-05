import { beforeEach, describe, expect, test } from 'bun:test'
import * as Audit from '~/modules/audit/service'
import type { NewUser, UserRepository } from '~/ports/user-repository'

/** A tenant for the suite. */
export interface UserSuiteTenant {
  projectId: string
  environmentId: string
}

/** What a repository under test provides. */
export interface UserSuiteContext {
  users: UserRepository
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

    function user(tenant: UserSuiteTenant, overrides: Partial<NewUser> = {}): NewUser {
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
      return { ...rest, bannedAt: null, lastSignInAt: null }
    }

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
      ).toEqual({ user: record(input), passwordHash: '$argon2id$original' })
      expect(
        await ctx.users.findByEmailWithPassword(ctx.a.environmentId, 'nobody@northline.app')
      ).toBeNull()
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
          Audit.none('fixture')
        )
      ).toBe('replaced')
      expect(
        await ctx.users.setPasswordHash(
          ctx.a.environmentId,
          Bun.randomUUIDv7(),
          'x',
          later(1),
          Audit.none('fixture')
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
      ).toEqual({ user: record(input), passwordHash: null })
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
          Audit.none('fixture')
        )
      ).toBeNull()
      expect(await stored()).toBeNull()

      expect(
        await ctx.users.setPasswordHash(
          env,
          input.id,
          '$argon2id$first',
          later(1),
          Audit.none('fixture')
        )
      ).toBe('created')
      expect(await stored()).toBe('$argon2id$first')
      expect(
        await ctx.users.setPasswordHash(
          env,
          input.id,
          '$argon2id$second',
          later(2),
          Audit.none('fixture')
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
            Audit.none('fixture')
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
      const hashOf = async (input: NewUser) =>
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
          Audit.none('fixture')
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
        Audit.none('fixture')
      )
      await ctx.users.markEmailVerified(foreign, input.id, later(1), Audit.none('fixture'))
      await ctx.users.recordSignIn(foreign, input.id, later(1))
      expect(
        await ctx.users.findByEmailWithPassword(ctx.a.environmentId, input.emailNormalized)
      ).toEqual({ user: record(input), passwordHash: '$argon2id$hash' })
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
        Audit.none('fixture')
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
