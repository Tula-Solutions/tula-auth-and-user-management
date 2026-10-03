import { z } from 'zod'

/** Largest page a list endpoint returns. */
export const MAX_PAGE_SIZE = 100

/** Page size when the client does not ask for one. */
export const DEFAULT_PAGE_SIZE = 20

/** Paging details returned with every list. */
export const PaginationMetaSchema = z
  .object({
    totalCount: z.number().int().min(0),
    totalPages: z.number().int().min(0),
    /** 1-based page number. */
    page: z.number().int().min(1),
    perPage: z.number().int().min(1),
  })
  .meta({ ref: 'PaginationMeta' })

/**
 * An end user of the app, as returned to the dashboard, servers and the user themselves.
 *
 * Never contains credentials.
 */
export const UserSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    emailVerifiedAt: z.iso.datetime().nullable(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    /** Set while the user is banned; a banned user cannot sign in or refresh. */
    bannedAt: z.iso.datetime().nullable(),
    lastSignInAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ ref: 'User' })

/** One page of users. */
export const UserListSchema = z
  .object({ meta: PaginationMetaSchema, data: z.array(UserSchema) })
  .meta({ ref: 'UserList' })

/** Fields users can be sorted by; prefix with `-` for descending. */
export const UserSortSchema = z
  .enum(['createdAt', '-createdAt', 'email', '-email', 'lastSignInAt', '-lastSignInAt'])
  .meta({ ref: 'UserSort' })

/**
 * Create a user from a server or the dashboard.
 *
 * `password` is optional: a user created without one has no password credential (they will sign
 * in another way) and gets one through a password reset or an admin "set password".
 */
export const CreateUserRequestSchema = z
  .object({
    email: z.string().max(320),
    password: z.string().max(1024).optional(),
    firstName: z.string().trim().max(100).optional(),
    lastName: z.string().trim().max(100).optional(),
    /** Mark the email as already verified (e.g. when importing users). Defaults to `false`. */
    emailVerified: z.boolean().optional(),
  })
  .meta({ ref: 'CreateUserRequest' })

/** Set a user's password from a server or the dashboard. Ends all of their sessions. */
export const SetPasswordRequestSchema = z
  .object({ password: z.string().max(1024) })
  .meta({ ref: 'SetPasswordRequest' })

/** Change the signed-in user's own password. Ends their other sessions. */
export const ChangePasswordRequestSchema = z
  .object({
    currentPassword: z.string().max(1024),
    newPassword: z.string().max(1024),
  })
  .meta({ ref: 'ChangePasswordRequest' })

/** Paging details. */
export type PaginationMeta = z.infer<typeof PaginationMetaSchema>
/** A user. */
export type User = z.infer<typeof UserSchema>
/** A page of users. */
export type UserList = z.infer<typeof UserListSchema>
/** User sort key. */
export type UserSort = z.infer<typeof UserSortSchema>
/** Create-user request body. */
export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>
/** Set-password request body. */
export type SetPasswordRequest = z.infer<typeof SetPasswordRequestSchema>
/** Change-password request body. */
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>
