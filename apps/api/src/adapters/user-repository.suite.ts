import { beforeEach, describe, expect, test } from 'bun:test'
import type { NewUserWithPassword, UserRepository } from '~/ports/user-repository'

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

    function user(
      tenant: UserSuiteTenant,
      overrides: Partial<NewUserWithPassword> = {}
    ): NewUserWithPassword {
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

    function record(input: NewUserWithPassword) {
      const { identityId: _i, credentialId: _c, passwordHash: _p, ...rest } = input
      return { ...rest, bannedAt: null, lastSignInAt: null }
    }

    test('creates a user and finds them by id and by normalized email', async () => {
      const input = user(ctx.a)
      expect(await ctx.users.createWithPassword(input)).toBe(true)
      expect(await ctx.users.findById(ctx.a.environmentId, input.id)).toEqual(record(input))
      expect(await ctx.users.findByEmail(ctx.a.environmentId, input.emailNormalized)).toEqual(
        record(input)
      )
      expect(await ctx.users.findByEmail(ctx.a.environmentId, 'nobody@northline.app')).toBeNull()
      expect(await ctx.users.findById(ctx.a.environmentId, Bun.randomUUIDv7())).toBeNull()
    })

    test('stores optional fields as null', async () => {
      const input = user(ctx.a, { firstName: null, lastName: null, emailVerifiedAt: null })
      await ctx.users.createWithPassword(input)
      expect(await ctx.users.findById(ctx.a.environmentId, input.id)).toMatchObject({
        firstName: null,
        lastName: null,
        emailVerifiedAt: null,
      })
    })

    test('returns the password hash with the user for sign-in', async () => {
      const input = user(ctx.a, { passwordHash: '$argon2id$original' })
      await ctx.users.createWithPassword(input)
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
      expect(await ctx.users.createWithPassword(first)).toBe(true)
      expect(await ctx.users.createWithPassword(second)).toBe(false)
      expect(await ctx.users.findById(ctx.a.environmentId, second.id)).toBeNull()
      // Of concurrent creations for one email, exactly one wins.
      const email = `race-${Bun.randomUUIDv7()}@northline.app`
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          ctx.users.createWithPassword(user(ctx.a, { emailNormalized: email }))
        )
      )
      expect(results.filter(Boolean)).toHaveLength(1)
    })

    test('the same email can exist in another environment', async () => {
      const first = user(ctx.a)
      const twin = user(ctx.b, { email: first.email, emailNormalized: first.emailNormalized })
      expect(await ctx.users.createWithPassword(first)).toBe(true)
      expect(await ctx.users.createWithPassword(twin)).toBe(true)
      expect((await ctx.users.findByEmail(ctx.b.environmentId, first.emailNormalized))?.id).toBe(
        twin.id
      )
    })

    test('replaces the password hash, reporting whether there was one to replace', async () => {
      const input = user(ctx.a)
      await ctx.users.createWithPassword(input)
      expect(
        await ctx.users.setPasswordHash(
          ctx.a.environmentId,
          input.id,
          '$argon2id$new',
          later(1_000)
        )
      ).toBe(true)
      expect(
        await ctx.users.setPasswordHash(ctx.a.environmentId, Bun.randomUUIDv7(), 'x', later(1))
      ).toBe(false)
      expect(
        (await ctx.users.findByEmailWithPassword(ctx.a.environmentId, input.emailNormalized))
          ?.passwordHash
      ).toBe('$argon2id$new')
    })

    test('marks the email verified once and records sign-ins', async () => {
      const input = user(ctx.a, { emailVerifiedAt: null })
      await ctx.users.createWithPassword(input)
      await ctx.users.markEmailVerified(ctx.a.environmentId, input.id, later(1_000))
      await ctx.users.markEmailVerified(ctx.a.environmentId, input.id, later(9_000))
      await ctx.users.recordSignIn(ctx.a.environmentId, input.id, later(2_000))
      expect(await ctx.users.findById(ctx.a.environmentId, input.id)).toMatchObject({
        emailVerifiedAt: later(1_000),
        lastSignInAt: later(2_000),
      })
    })

    test('lists a page with the total, newest first by default sort', async () => {
      const inputs = [0, 1, 2, 3, 4].map((i) =>
        user(ctx.a, { createdAt: later(i * 1_000), emailNormalized: `list-${i}@page.test` })
      )
      for (const input of inputs) {
        await ctx.users.createWithPassword(input)
      }
      await ctx.users.createWithPassword(user(ctx.b, { emailNormalized: 'list-9@page.test' }))
      const criteria = { q: '@page.test', sort: '-createdAt' as const, size: 2 }

      const first = await ctx.users.list(ctx.a.environmentId, { ...criteria, page: 1 })
      expect(first.totalCount).toBe(5)
      expect(first.users.map((u) => u.id)).toEqual([inputs[4]?.id, inputs[3]?.id] as string[])
      const last = await ctx.users.list(ctx.a.environmentId, { ...criteria, page: 3 })
      expect(last.users.map((u) => u.id)).toEqual([inputs[0]?.id] as string[])
      expect(first.users[0]).toEqual(record(inputs[4] as NewUserWithPassword))
      expect((await ctx.users.list(ctx.a.environmentId, { ...criteria, page: 4 })).users).toEqual(
        []
      )
    })

    test('sorts by email and by last sign-in, in both directions', async () => {
      const tag = Bun.randomUUIDv7()
      const [b, a, c] = ['b', 'a', 'c'].map((letter) =>
        user(ctx.a, { emailNormalized: `${letter}-${tag}@sort.test` })
      ) as [NewUserWithPassword, NewUserWithPassword, NewUserWithPassword]
      for (const input of [b, a, c]) {
        await ctx.users.createWithPassword(input)
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
        await ctx.users.createWithPassword(input)
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
      await ctx.users.createWithPassword(maya)
      await ctx.users.createWithPassword(percent)
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
      await ctx.users.createWithPassword(input)
      expect(
        (await ctx.users.setBanned(ctx.a.environmentId, input.id, later(1_000), later(1_000)))
          ?.bannedAt
      ).toEqual(later(1_000))
      expect(
        (await ctx.users.setBanned(ctx.a.environmentId, input.id, later(5_000), later(5_000)))
          ?.bannedAt
      ).toEqual(later(1_000))
      expect(
        (await ctx.users.setBanned(ctx.a.environmentId, input.id, null, later(6_000)))?.bannedAt
      ).toBeNull()
      expect(
        await ctx.users.setBanned(ctx.a.environmentId, Bun.randomUUIDv7(), later(1), later(1))
      ).toBeNull()
    })

    test('deletes a user and frees their email', async () => {
      const input = user(ctx.a)
      await ctx.users.createWithPassword(input)
      expect(await ctx.users.delete(ctx.a.environmentId, input.id)).toBe(true)
      expect(await ctx.users.delete(ctx.a.environmentId, input.id)).toBe(false)
      expect(await ctx.users.findById(ctx.a.environmentId, input.id)).toBeNull()
      expect(
        await ctx.users.findByEmailWithPassword(ctx.a.environmentId, input.emailNormalized)
      ).toBeNull()
      expect(
        await ctx.users.createWithPassword(user(ctx.a, { emailNormalized: input.emailNormalized }))
      ).toBe(true)
    })

    test('one environment cannot list, ban or delete another’s users', async () => {
      const input = user(ctx.a)
      await ctx.users.createWithPassword(input)
      const foreign = ctx.b.environmentId
      const listed = await ctx.users.list(foreign, {
        q: input.emailNormalized,
        sort: 'email',
        page: 1,
        size: 10,
      })
      expect(listed).toEqual({ users: [], totalCount: 0 })
      expect(await ctx.users.setBanned(foreign, input.id, later(1), later(1))).toBeNull()
      expect(await ctx.users.delete(foreign, input.id)).toBe(false)
      expect(await ctx.users.findById(ctx.a.environmentId, input.id)).toEqual(record(input))
    })

    test('one environment cannot read or change another’s users', async () => {
      const input = user(ctx.a, { emailVerifiedAt: null })
      await ctx.users.createWithPassword(input)
      const foreign = ctx.b.environmentId
      expect(await ctx.users.findById(foreign, input.id)).toBeNull()
      expect(await ctx.users.findByEmail(foreign, input.emailNormalized)).toBeNull()
      expect(await ctx.users.findByEmailWithPassword(foreign, input.emailNormalized)).toBeNull()
      await ctx.users.setPasswordHash(foreign, input.id, '$argon2id$stolen', later(1))
      await ctx.users.markEmailVerified(foreign, input.id, later(1))
      await ctx.users.recordSignIn(foreign, input.id, later(1))
      expect(
        await ctx.users.findByEmailWithPassword(ctx.a.environmentId, input.emailNormalized)
      ).toEqual({ user: record(input), passwordHash: '$argon2id$hash' })
    })
  })
}
