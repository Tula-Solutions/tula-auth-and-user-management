import { describe, expect, test } from 'bun:test'
import {
  ChangePasswordRequestSchema,
  CreateUserRequestSchema,
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
