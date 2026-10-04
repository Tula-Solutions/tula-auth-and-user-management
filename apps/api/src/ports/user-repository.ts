import type { OAuthProvider, UserSort } from '@tula/contract'
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
  /**
   * The provider account the user signed up with (ADR 0026), stored as a second identity beside
   * the email one, in the same transaction.
   */
  oauthIdentity?: { id: string; provider: OAuthProvider; subject: string }
}

/** A provider account connected to a user. */
export interface IdentityRecord {
  id: string
  userId: string
  provider: OAuthProvider
  /** The provider's stable id for the account. Never sent to a client. */
  subject: string
  createdAt: Date
}

/** A provider account to connect to an existing user. */
export interface NewIdentity extends IdentityRecord {
  projectId: string
  environmentId: string
}

/**
 * What must still be true of the user at the moment an identity is connected to them
 * **automatically** (by a matching email): the address is still theirs, and verified.
 */
export interface LinkGuard {
  emailNormalized: string
}

/**
 * What connecting an identity did.
 *
 * - `linked`: the identity now belongs to the user.
 * - `identity_in_use`: that provider account already belongs to a user (this one or another).
 * - `provider_linked`: the user already has another account of that provider.
 * - `user_changed`: the user is gone, or no longer satisfies the {@link LinkGuard}.
 */
export type LinkOutcome = 'linked' | 'identity_in_use' | 'provider_linked' | 'user_changed'

/** The ways a user could still sign in, as the store sees them inside one transaction. */
export interface SignInMeans {
  /** The user has a password credential. */
  hasPassword: boolean
  /** The user's email address is verified. */
  emailVerified: boolean
  /** The providers of the identities the user would still have. */
  providers: OAuthProvider[]
  /** How many passkeys the user would still have. */
  passkeys: number
}

/** What disconnecting an identity did. */
export type UnlinkOutcome = 'unlinked' | 'not_found' | 'last_method'

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
   * The user a provider account belongs to.
   *
   * @param environmentId - The environment to look in.
   * @param provider - The provider.
   * @param subject - The provider's stable id for the account.
   * @returns The user, or `null` when no user has that identity.
   */
  findByIdentity(
    environmentId: string,
    provider: OAuthProvider,
    subject: string
  ): Promise<UserRecord | null>

  /**
   * @param environmentId - The user's environment.
   * @param userId - The user.
   * @returns Their provider identities (never the `email` one), oldest first.
   */
  listIdentities(environmentId: string, userId: string): Promise<IdentityRecord[]>

  /**
   * Connect a provider account to an existing user. The unique keys are the arbiter: a provider
   * account belongs to one user, and a user has one account per provider. Of two concurrent
   * links of the same account exactly one is `linked`.
   *
   * @param identity - The identity and the user it is for.
   * @param activity - Recorded in the same transaction, only when the identity was linked.
   * @param guard - For an automatic link: what must still hold of the user, checked under a
   *   lock in the same transaction, so a deletion or an email change cannot race it.
   * @returns What happened. Never throws for a conflict.
   */
  linkIdentity(identity: NewIdentity, activity?: Activity, guard?: LinkGuard): Promise<LinkOutcome>

  /**
   * Disconnect a provider account from a user, unless that would leave them no way to sign in.
   *
   * The decision is the caller's (`allowed`), but it is asked **inside the transaction**, with
   * the user locked and with what they would have left, so two concurrent removals cannot each
   * count on the other's identity remaining.
   *
   * @param environmentId - The user's environment.
   * @param userId - The user.
   * @param identityId - The identity to remove. Another user's, or the `email` one: `not_found`.
   * @param allowed - Whether the user could still sign in with what remains.
   * @param activity - Recorded in the same transaction, only when the identity was removed.
   * @returns What happened.
   */
  unlinkIdentity(
    environmentId: string,
    userId: string,
    identityId: string,
    allowed: (remaining: SignInMeans) => boolean,
    activity?: Activity
  ): Promise<UnlinkOutcome>

  /**
   * Create a user and their email identity atomically, with a password credential when
   * `passwordHash` is given and a provider identity when `oauthIdentity` is.
   *
   * @param user - The user and, optionally, their password or provider account.
   * @param activity - Recorded in the same transaction, only if the user was created.
   * @returns `false` when the email, or the provider account, is already taken in that
   *   environment (nothing is written).
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
   * **With `removePassword`**, an address that was unverified until this call also loses the
   * account's password credential, in the same transaction. That is for a verification by
   * someone who did not prove the password (an emailed sign-in code or link): a password that
   * exists on an account whose address nobody had proven was chosen by whoever made the
   * account, who is not known to be the address's owner, and must not start working the moment
   * the owner verifies it (a pre-hijack; ADR 0024). An address that was already verified
   * changes nothing and removes nothing.
   *
   * @param environmentId - The user's environment.
   * @param userId - The user.
   * @param at - Verification time.
   * @param activity - Recorded in the same transaction, only if the email was unverified before.
   * @param removePassword - Also remove the password, if the email was unverified before. Its
   *   `activity` is recorded in the same transaction, only if a password was removed.
   * @returns Whether a password was removed.
   */
  markEmailVerified(
    environmentId: string,
    userId: string,
    at: Date,
    activity?: Activity,
    removePassword?: { activity?: Activity }
  ): Promise<{ passwordRemoved: boolean }>

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
