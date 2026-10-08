import { z } from 'zod'
import { PasskeySchema } from './passkey'

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
    /**
     * The account's phone number in E.164 form (`+14155550100`), or `null`. Only a number the
     * user proved with a code sent to it is ever here, so one that is present is verified
     * (`phoneNumberVerifiedAt` says when). It is contact data: nobody signs in with it, and
     * two accounts may have the same one (ADR 0037). Optional in the schema, so a client
     * reading an older server's answer treats a missing one as `null`.
     */
    phoneNumber: z.string().nullable().optional(),
    /** When the phone number was verified; `null` without one. */
    phoneNumberVerifiedAt: z.iso.datetime().nullable().optional(),
  })
  .meta({ ref: 'User' })

/**
 * The signed-in user, as `GET /v1/client/me` returns them: a {@link UserSchema} and what a
 * profile screen needs to know about how they sign in. Never a credential.
 */
export const CurrentUserSchema = UserSchema.extend({
  /**
   * Whether the account has a password. `false` for someone who signed up through a provider
   * or by email: there is no current password to ask them for, so a profile shows how to add
   * one instead of the change-password form.
   */
  hasPassword: z.boolean(),
}).meta({ ref: 'CurrentUser' })

/**
 * How a user signs in, as `GET /v1/admin/users/{userId}/authentication` returns it to a server
 * or the dashboard: which methods the account has, and when each was added.
 *
 * Never a credential or anything that identifies one elsewhere: no password hash, no
 * authenticator secret or `otpauth` URI, no backup code, no passkey credential id, public key
 * or user handle, and no provider's own id for the account.
 *
 * - `identities`: the provider accounts connected to the user, oldest first.
 * - `factors`: **confirmed** second factors only; an enrolment that was started and never
 *   confirmed is not listed. `type` is `totp` today; a plain string so that a later factor does
 *   not break a client.
 * - `backupCodesRemaining`: how many unused backup codes are left (0 without a factor).
 * - `passkeys`: the same view the user has of them ({@link PasskeySchema}).
 * - `canSignInWithoutPasskeys`: whether a method the environment accepts would remain if every
 *   passkey were removed, which is what resetting two-step verification does: a password where
 *   passwords are on, a verified address where the emailed code is on, or an account of an
 *   enabled provider. `false` means a reset would leave the user no way in.
 */
export const UserAuthenticationSchema = z
  .object({
    hasPassword: z.boolean(),
    emailVerified: z.boolean(),
    identities: z.array(z.object({ provider: z.string(), linkedAt: z.iso.datetime() })),
    factors: z.array(z.object({ type: z.string(), confirmedAt: z.iso.datetime() })),
    backupCodesRemaining: z.number().int().min(0),
    passkeys: z.array(PasskeySchema),
    canSignInWithoutPasskeys: z.boolean(),
  })
  .meta({ ref: 'UserAuthentication' })

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

/**
 * Ask for a code to be sent to a phone number the signed-in user wants on their account
 * (`POST /v1/client/me/phone`). Spaces, hyphens and parentheses are taken out; anything else
 * that is not a `+` and 8 to 15 digits is `phone.invalid`.
 */
export const PhoneNumberRequestSchema = z
  .object({ phoneNumber: z.string().max(64) })
  .meta({ ref: 'PhoneNumberRequest' })

/**
 * What asking for a phone code answers: where it went, masked, and when it stops working.
 * Never the code.
 */
export const PhoneCodeSentSchema = z
  .object({
    /** The number's last two digits behind a mask, e.g. `***00`. */
    destination: z.string(),
    expiresAt: z.iso.datetime(),
  })
  .meta({ ref: 'PhoneCodeSent' })

/** The code a phone number is confirmed with (`POST /v1/client/me/phone/verify`). */
export const PhoneNumberVerifyRequestSchema = z
  .object({ code: z.string().regex(/^\d{6}$/) })
  .meta({ ref: 'PhoneNumberVerifyRequest' })

/** Paging details. */
export type PaginationMeta = z.infer<typeof PaginationMetaSchema>
/** A user. */
export type User = z.infer<typeof UserSchema>
/** The signed-in user. */
export type CurrentUser = z.infer<typeof CurrentUserSchema>
/** How a user signs in. */
export type UserAuthentication = z.infer<typeof UserAuthenticationSchema>
/** A page of users. */
export type UserList = z.infer<typeof UserListSchema>
/** User sort key. */
export type UserSort = z.infer<typeof UserSortSchema>
/** A phone number to send a code to. */
export type PhoneNumberRequest = z.infer<typeof PhoneNumberRequestSchema>
/** Where a phone code went and when it expires. */
export type PhoneCodeSent = z.infer<typeof PhoneCodeSentSchema>
/** The code that confirms a phone number. */
export type PhoneNumberVerifyRequest = z.infer<typeof PhoneNumberVerifyRequestSchema>
/** Create-user request body. */
export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>
/** Set-password request body. */
export type SetPasswordRequest = z.infer<typeof SetPasswordRequestSchema>
/** Change-password request body. */
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>
