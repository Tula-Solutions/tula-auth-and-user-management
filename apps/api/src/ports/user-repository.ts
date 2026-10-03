import type { UserSort } from '@tula/contract'
import type { Activity } from '~/ports/activity-log'

/** An end user of a customer's app, scoped to one environment. */
export interface UserRecord {
  id: string
  projectId: string
  environmentId: string
  /** Email as entered (for display and for sending mail). */
  email: string
  /** Lowercased, trimmed email used for lookups and uniqueness. */
  emailNormalized: string
  emailVerifiedAt: Date | null
  firstName: string | null
  lastName: string | null
  bannedAt: Date | null
  lastSignInAt: Date | null
  createdAt: Date
}

/** A user to create together with their email identity and, if they have one, their password. */
export interface NewUser extends Omit<UserRecord, 'bannedAt' | 'lastSignInAt'> {
  /** Id for the `email` identity row. */
  identityId: string
  /** Id for the `password` credential row. Unused when there is no password. */
  credentialId: string
  /** argon2id hash of the password, or `null` for a user who has none (no credential row). */
  passwordHash: string | null
}

/**
 * What storing a password did: `created` when the user had none before (their first password),
 * `replaced` otherwise.
 */
export type PasswordOutcome = 'created' | 'replaced'

/** Which users to list. */
export interface UserListCriteria {
  /** Case-insensitive substring of the email or a name. Wildcards are matched literally. */
  q?: string
  /** 1-based page. */
  page: number
  /** Page size. */
  size: number
  sort: UserSort
}

/** Users with their identities and credentials, always inside one environment. */
export interface UserRepository {
  /**
   * @param environmentId - The environment to look in.
   * @param id - User id.
   * @returns The user, or `null`.
   */
  findById(environmentId: string, id: string): Promise<UserRecord | null>

  /**
   * @param environmentId - The environment to look in.
   * @param emailNormalized - Normalized email.
   * @returns The user, or `null`.
   */
  findByEmail(environmentId: string, emailNormalized: string): Promise<UserRecord | null>

  /**
   * Look a user up for sign-in, with their password hash, in a single query, so known and
   * unknown emails cost the same round trip.
   *
   * @param environmentId - The environment to look in.
   * @param emailNormalized - Normalized email.
   * @returns The user and their password hash (`null` when they have no password), or `null`.
   */
  findByEmailWithPassword(
    environmentId: string,
    emailNormalized: string
  ): Promise<{ user: UserRecord; passwordHash: string | null } | null>

  /**
   * Create a user and their email identity atomically, with a password credential when
   * `passwordHash` is given.
   *
   * @param user - The user and, optionally, their password.
   * @param activity - Recorded in the same transaction, only if the user was created.
   * @returns `false` when the email is already taken in that environment (nothing is written).
   */
  create(user: NewUser, activity?: Activity): Promise<boolean>

  /**
   * Store a user's password hash: replace the one they have, or create the credential when
   * they have none (a user who signed up another way setting their first password). One atomic
   * write either way; of two concurrent first passwords exactly one is `created`.
   *
   * @param environmentId - The user's environment.
   * @param userId - The user.
   * @param passwordHash - The new argon2id hash.
   * @param at - Update time.
   * @param activity - Recorded in the same transaction as the write. When the password is the
   *   user's first, the recorded entry's `data` gains `created: true`: only the store knows
   *   which happened at the moment it happens.
   * @returns What happened, or `null` when the user does not exist in that environment (nothing
   *   is written or recorded).
   */
  setPasswordHash(
    environmentId: string,
    userId: string,
    passwordHash: string,
    at: Date,
    activity?: Activity
  ): Promise<PasswordOutcome | null>

  /**
   * Replace a password hash with a stronger hash **of the same password**, only if the stored
   * hash is still the one that was verified. A plain write here could overwrite a password that
   * was changed between the verify and the upgrade, bringing the old password back.
   *
   * @param environmentId - The user's environment.
   * @param userId - The user.
   * @param currentHash - The hash the password was just verified against.
   * @param passwordHash - The new argon2id hash of that same password.
   * @param at - Update time.
   * @returns `false` when the stored hash is no longer `currentHash` (nothing is written).
   */
  upgradePasswordHash(
    environmentId: string,
    userId: string,
    currentHash: string,
    passwordHash: string,
    at: Date
  ): Promise<boolean>

  /**
   * Record that the user proved control of their email. Keeps the first verification time.
   *
   * @param environmentId - The user's environment.
   * @param userId - The user.
   * @param at - Verification time.
   * @param activity - Recorded in the same transaction, only if the email was unverified before.
   */
  markEmailVerified(
    environmentId: string,
    userId: string,
    at: Date,
    activity?: Activity
  ): Promise<void>

  /**
   * @param environmentId - The user's environment.
   * @param userId - The user.
   * @param at - Sign-in time.
   */
  recordSignIn(environmentId: string, userId: string, at: Date): Promise<void>

  /**
   * @param environmentId - The environment to list.
   * @param criteria - Search, paging and sort.
   * @returns One page of users and the total number that match.
   */
  list(
    environmentId: string,
    criteria: UserListCriteria
  ): Promise<{ users: UserRecord[]; totalCount: number }>

  /**
   * Ban or unban a user. Banning keeps the first ban time if they are already banned.
   *
   * @param environmentId - The user's environment.
   * @param userId - The user.
   * @param bannedAt - Ban time, or `null` to unban.
   * @param at - Update time.
   * @param activity - Recorded in the same transaction, only if the ban state changed.
   * @returns The user as they now are, or `null` when they do not exist.
   */
  setBanned(
    environmentId: string,
    userId: string,
    bannedAt: Date | null,
    at: Date,
    activity?: Activity
  ): Promise<UserRecord | null>

  /**
   * Delete a user and, by cascade, their identities, credentials, sessions and attempts.
   *
   * @param environmentId - The user's environment.
   * @param userId - The user.
   * @param activity - Recorded in the same transaction, only if the user was deleted.
   * @returns `false` when they do not exist.
   */
  delete(environmentId: string, userId: string, activity?: Activity): Promise<boolean>
}
