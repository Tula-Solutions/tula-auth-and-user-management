import { describe, expect, test } from 'bun:test'
import {
  ChangePasswordRequestSchema,
  CreateUserRequestSchema,
  CurrentUserSchema,
  UserAuthenticationSchema,
  UserListSchema,
  UserSchema,
  UserSortSchema,
} from './user'

const user = {
  id: 'u_1',
  email: 'maya@northline.app',
  emailVerifiedAt: '2026-01-01T00:00:00.000Z',
  firstName: 'Maya',
  lastName: null,
  bannedAt: null,
  lastSignInAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
}

describe('CurrentUser', () => {
  test('is a user plus whether they have a password, and never the credential', () => {
    const parsed = CurrentUserSchema.parse({
      ...user,
      hasPassword: false,
      passwordHash: '$argon2id$secret',
    })
    expect(parsed).toEqual({ ...user, hasPassword: false } as never)
    expect(Object.keys(CurrentUserSchema.shape).sort()).toEqual(
      [...Object.keys(UserSchema.shape), 'hasPassword'].sort()
    )
  })

  test.each([undefined, 'yes', 1, null])('refuses hasPassword %p', (hasPassword) => {
    expect(CurrentUserSchema.safeParse({ ...user, hasPassword }).success).toBe(false)
  })
})

describe('User', () => {
  test('accepts a user and strips anything that is not part of the contract', () => {
    const parsed = UserSchema.parse({ ...user, passwordHash: '$argon2id$secret' })
    expect(parsed).toEqual(user as never)
    expect(parsed).not.toHaveProperty('passwordHash')
  })

  test('a list carries paging details', () => {
    const list = UserListSchema.parse({
      meta: { totalCount: 1, totalPages: 1, page: 1, perPage: 20 },
      data: [user],
    })
    expect(list.data).toHaveLength(1)
    expect(
      UserListSchema.safeParse({
        meta: { totalCount: 1, totalPages: 1, page: 0, perPage: 20 },
        data: [],
      }).success
    ).toBe(false)
  })

  test.each(['createdAt', '-createdAt', 'email', '-email', 'lastSignInAt', '-lastSignInAt'])(
    'sorts by %s',
    (sort) => {
      expect(UserSortSchema.parse(sort)).toBe(sort as never)
    }
  )

  test('rejects sorting by anything else', () => {
    expect(UserSortSchema.safeParse('passwordHash').success).toBe(false)
  })
})

describe('user requests', () => {
  test('create trims names and leaves emailVerified optional', () => {
    expect(
      CreateUserRequestSchema.parse({ email: 'a@b.co', password: 'x', firstName: '  Maya ' })
    ).toEqual({ email: 'a@b.co', password: 'x', firstName: 'Maya' })
  })

  test('create accepts a user without a password', () => {
    expect(CreateUserRequestSchema.parse({ email: 'a@b.co' })).toEqual({ email: 'a@b.co' })
    expect(CreateUserRequestSchema.safeParse({ password: 'x' }).success).toBe(false)
  })

  test('create and change-password cap input lengths', () => {
    expect(
      CreateUserRequestSchema.safeParse({ email: 'a@b.co', password: 'x'.repeat(1025) }).success
    ).toBe(false)
    expect(
      ChangePasswordRequestSchema.safeParse({ currentPassword: 'x', newPassword: 'y'.repeat(1025) })
        .success
    ).toBe(false)
  })
})

describe('UserAuthentication', () => {
  const authentication = {
    hasPassword: true,
    emailVerified: true,
    identities: [{ provider: 'google', linkedAt: '2026-01-01T00:00:00.000Z' }],
    factors: [{ type: 'totp', confirmedAt: '2026-01-02T00:00:00.000Z' }],
    backupCodesRemaining: 8,
    passkeys: [
      {
        id: 'pk_1',
        name: 'Laptop',
        synced: true,
        createdAt: '2026-01-03T00:00:00.000Z',
        lastUsedAt: null,
      },
    ],
    canSignInWithoutPasskeys: true,
  }

  test('strips secrets and identifiers a caller might pass through by mistake', () => {
    const parsed = UserAuthenticationSchema.parse({
      ...authentication,
      passwordHash: '$argon2id$secret',
      identities: [{ ...authentication.identities[0], id: 'i_1', subject: 'provider-subject' }],
      factors: [{ ...authentication.factors[0], secret: 'sealed', uri: 'otpauth://totp/x' }],
      passkeys: [
        {
          ...authentication.passkeys[0],
          credentialId: 'credential',
          publicKey: 'key',
          userHandle: 'handle',
        },
      ],
    })
    expect(parsed).toEqual(authentication as never)
  })

  test('a factor is listed only with the time it was confirmed', () => {
    expect(
      UserAuthenticationSchema.safeParse({
        ...authentication,
        factors: [{ type: 'totp', confirmedAt: null }],
      }).success
    ).toBe(false)
    expect(
      UserAuthenticationSchema.safeParse({ ...authentication, backupCodesRemaining: -1 }).success
    ).toBe(false)
  })
})
