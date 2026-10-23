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
    /**
     * The account's email address, or `null` for an account that has none: one created by a
     * first sign-in with a provider Tula takes no address from (X, Facebook; ADR 0026). Such
     * an account is sent no email, and nothing is looked up by an address for it.
     */
    email: z.string().nullable(),
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
     * (`phoneNumberVerifiedAt` says when). Two accounts may have the same one. It is contact
     * data and, only where the environment has the texted sign-in code on and exactly one
     * account holds the number, a way to sign in to that account (ADR 0037). Optional in the schema, so a client
     * reading an older server's answer treats a missing one as `null`.
     */
    phoneNumber: z.string().nullable().optional(),
    /**
     * When the phone number was last proven with a texted code: when it was added, or the
     * last sign-in with a code texted to it. `null` without a number.
     */
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

/** The most rows one call of `POST /v1/admin/users/import` takes. */
export const MAX_IMPORT_ROWS = 500

/**
 * The most bytes a row's `metadata` may take **as stored**: the database prints a space after
 * every `:` and `,`, so the count is the compact JSON plus about one byte for each of them.
 * It is stored with the user, so it is bounded the way any user-sized value is. A row over
 * it, nested more than 32 levels, or holding a NUL, a lone surrogate or an exponent number
 * is refused alone with `validation.failed`.
 */
export const MAX_IMPORT_METADATA_BYTES = 4096

/**
 * A password hash made by another system, in a tagged form.
 *
 * `algorithm` names the format and decides how `hash` is read and checked. It is a plain
 * string on the wire so that a name this server does not know is refused for that row
 * (`import.unsupported_algorithm`) and not for the whole call, and so that a later algorithm
 * is an addition, not a break. Today: `bcrypt`
 * (`$2a$`, `$2b$`, `$2y$`; cost 10 to 14), `argon2id` and `argon2i` (PHC strings; at least
 * 19 MiB and 2 passes), `pbkdf2_sha256` (Django's `pbkdf2_sha256$iterations$salt$hash`, a PHC
 * or passlib `$pbkdf2-sha256$…` string, or a base64 derived key with `params`
 * `{ iterations, salt }`, the salt base64; 100,000 to 2,000,000 iterations) and
 * `firebase_scrypt` (Firebase's `passwordHash`, base64, with `params` `{ salt }`, the user's
 * `salt` from the export, base64; the project's own parameters come once in the request's
 * `firebaseScrypt`). `params` is for algorithms whose hash does not carry its own parameters;
 * bcrypt and argon2 do, so it is ignored for them.
 *
 * The hash is never returned by any route.
 *
 * @example
 * ```ts
 * ImportPasswordSchema.parse({ algorithm: 'bcrypt', hash: '$2b$10$…' })
 * ```
 */
export const ImportPasswordSchema = z
  .object({
    algorithm: z.string().max(64),
    hash: z.string().max(1024),
    params: z.record(z.string().max(64), z.union([z.string().max(1024), z.number()])).optional(),
  })
  .meta({ ref: 'ImportPassword' })

/** One user of an import. */
export const ImportUserRowSchema = z
  .object({
    email: z.string().max(320),
    emailVerified: z.boolean(),
    /** The user's full name, kept as given. */
    name: z.string().trim().max(200).optional(),
    /** Anything the operator wants to keep with the user, up to 4 KiB as JSON. */
    metadata: z.record(z.string().max(128), z.unknown()).optional(),
    /** The user's id in the system they come from. */
    externalId: z.string().trim().min(1).max(256).optional(),
    password: ImportPasswordSchema.optional(),
  })
  .meta({ ref: 'ImportUserRow' })

/**
 * A Firebase project's password hash parameters, from `firebase auth:export` or the console's
 * "password hash parameters" (ADR 0066). Given once per call and used by every row whose
 * algorithm is `firebase_scrypt`. All four are secrets of the source project: the signer key
 * above all. They are sealed where stored, and never returned, logged or recorded.
 */
export const FirebaseScryptParamsSchema = z
  .object({
    /** `base64_signer_key`: base64, up to 128 bytes. */
    signerKey: z.string().max(512),
    /** `base64_salt_separator`: base64, up to 64 bytes (it may be empty). */
    saltSeparator: z.string().max(256),
    /** `rounds`: scrypt's `r`, 4 to 16 (Firebase's own is 8). */
    rounds: z.number().int(),
    /** `mem_cost`: log2 of scrypt's `N`, 12 to 16 (Firebase's own is 14). */
    memCost: z.number().int(),
  })
  .meta({ ref: 'FirebaseScryptParams' })

/**
 * A call of `POST /v1/admin/users/import`: up to {@link MAX_IMPORT_ROWS} users. A row that is
 * wrong is refused alone; a request that is not this shape at all is refused whole.
 * `firebaseScrypt` carries the Firebase project's parameters for the rows that use them; a
 * `firebase_scrypt` row of a call without it is refused alone.
 */
export const ImportUsersRequestSchema = z
  .object({
    users: z.array(ImportUserRowSchema).min(1).max(MAX_IMPORT_ROWS),
    firebaseScrypt: FirebaseScryptParamsSchema.optional(),
  })
  .meta({ ref: 'ImportUsersRequest' })

/** Why a row was skipped: the address is taken, or an earlier row of the call has it. */
export const ImportSkipReasonSchema = z
  .enum(['email_exists', 'repeated_in_batch'])
  .meta({ ref: 'ImportSkipReason' })

/**
 * What became of one row. `index` is the row's place in the request, so the answer can be
 * matched to the file it came from. A `created` row has the user's `id`, a `skipped` one a
 * `reason`, a `refused` one a contract error `code` (an `import.*` code, `email.invalid`,
 * …) and its default message.
 */
export const ImportRowResultSchema = z
  .discriminatedUnion('status', [
    z.object({ index: z.number().int().min(0), status: z.literal('created'), id: z.uuid() }),
    z.object({
      index: z.number().int().min(0),
      status: z.literal('skipped'),
      reason: ImportSkipReasonSchema,
    }),
    z.object({
      index: z.number().int().min(0),
      status: z.literal('refused'),
      code: z.string(),
      message: z.string(),
    }),
  ])
  .meta({ ref: 'ImportRowResult' })

/** The answer to an import: one result per row, in order, and the counts. */
export const ImportUsersResultSchema = z
  .object({
    results: z.array(ImportRowResultSchema),
    created: z.number().int().min(0),
    skipped: z.number().int().min(0),
    refused: z.number().int().min(0),
  })
  .meta({ ref: 'ImportUsersResult' })

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

/**
 * Ask for a code to be emailed to an address the signed-in user wants on their account
 * (`POST /v1/client/me/email`; ADR 0059). Only for an account that has **no** address: one
 * made by a first sign-in with a provider Tula takes no address from (X, Facebook).
 *
 * @example
 * ```ts
 * EmailAddressRequestSchema.parse({ email: 'ada@example.com' })
 * ```
 */
export const EmailAddressRequestSchema = z
  .object({ email: z.string().max(320) })
  .meta({ ref: 'EmailAddressRequest' })

/**
 * What asking for that code answers: where it went, masked, and when it stops working. Never
 * the code, and the same for an address that is free and one another account holds.
 *
 * @example
 * ```ts
 * EmailCodeSentSchema.parse({ destination: 'a***@example.com', expiresAt: '2026-10-12T09:10:00.000Z' })
 * ```
 */
export const EmailCodeSentSchema = z
  .object({
    /** The address behind a mask, e.g. `a***@example.com`. */
    destination: z.string(),
    expiresAt: z.iso.datetime(),
  })
  .meta({ ref: 'EmailCodeSent' })

/**
 * The code an address is confirmed with (`POST /v1/client/me/email/verify`).
 *
 * @example
 * ```ts
 * EmailAddressVerifyRequestSchema.parse({ code: '482913' })
 * ```
 */
export const EmailAddressVerifyRequestSchema = z
  .object({ code: z.string().regex(/^\d{6}$/) })
  .meta({ ref: 'EmailAddressVerifyRequest' })

/**
 * Give a user who has no email address one, from a server or the dashboard
 * (`PUT /v1/admin/users/{userId}/email`; ADR 0059). The address is stored **unverified**:
 * nobody has shown that they read mail sent to it, and the first emailed code its holder
 * enters is what verifies it.
 *
 * @example
 * ```ts
 * SetUserEmailRequestSchema.parse({ email: 'ada@example.com' })
 * ```
 */
export const SetUserEmailRequestSchema = z
  .strictObject({ email: z.string().max(320) })
  .meta({ ref: 'SetUserEmailRequest' })

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
/** An address to email a code to. */
export type EmailAddressRequest = z.infer<typeof EmailAddressRequestSchema>
/** Where an emailed code went and when it expires. */
export type EmailCodeSent = z.infer<typeof EmailCodeSentSchema>
/** The code that confirms an email address. */
export type EmailAddressVerifyRequest = z.infer<typeof EmailAddressVerifyRequestSchema>
/** The address an administrator gives a user who has none. */
export type SetUserEmailRequest = z.infer<typeof SetUserEmailRequestSchema>
/** A Firebase project's password hash parameters. */
export type FirebaseScryptParams = z.infer<typeof FirebaseScryptParamsSchema>
/** One user of an import. */
export type ImportUserRow = z.infer<typeof ImportUserRowSchema>
/** An import request body. */
export type ImportUsersRequest = z.infer<typeof ImportUsersRequestSchema>
/** What became of one import row. */
export type ImportRowResult = z.infer<typeof ImportRowResultSchema>
/** The answer to an import. */
export type ImportUsersResult = z.infer<typeof ImportUsersResultSchema>
/** Create-user request body. */
export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>
/** Set-password request body. */
export type SetPasswordRequest = z.infer<typeof SetPasswordRequestSchema>
/** Change-password request body. */
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>
