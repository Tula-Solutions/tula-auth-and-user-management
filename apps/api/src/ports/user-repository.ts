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

/** A user to create together with their email identity and password credential. */
export interface NewUserWithPassword extends Omit<UserRecord, 'bannedAt' | 'lastSignInAt'> {
  /** Id for the `email` identity row. */
  identityId: string
  /** Id for the `password` credential row. */
  credentialId: string
  /** argon2id hash of the password. */
  passwordHash: string
}

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
   * Create a user, their email identity and their password credential atomically.
   *
   * @param user - The user and credential.
   * @param activity - Recorded in the same transaction, only if the user was created.
   * @returns `false` when the email is already taken in that environment (nothing is written).
   */
  createWithPassword(user: NewUserWithPassword, activity?: Activity): Promise<boolean>

  /**
   * Replace a user's password hash (password change, or a rehash with stronger parameters).
   *
   * @param environmentId - The user's environment.
   * @param userId - The user.
   * @param passwordHash - The new argon2id hash.
   * @param at - Update time.
   * @param activity - Recorded in the same transaction, only if the hash was replaced. Leave it
   *   out for a rehash, which is not a password change.
   * @returns `false` when the user has no password credential to replace (nothing is written).
   */
  setPasswordHash(
    environmentId: string,
    userId: string,
    passwordHash: string,
    at: Date,
    activity?: Activity
  ): Promise<boolean>

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
