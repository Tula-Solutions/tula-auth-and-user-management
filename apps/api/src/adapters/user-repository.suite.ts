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

    test('replaces the password hash', async () => {
      const input = user(ctx.a)
      await ctx.users.createWithPassword(input)
      await ctx.users.setPasswordHash(ctx.a.environmentId, input.id, '$argon2id$new', later(1_000))
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
