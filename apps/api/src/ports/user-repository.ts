import type { OAuthProvider, UserSort } from '@tula/contract'
import type { Recorded } from '~/ports/activity-log'

/** An end user of a customer's app, scoped to one environment. */
export interface UserRecord {
  id: string
  projectId: string
  environmentId: string
  /**
   * Email as entered (for display and for sending mail), or `null` for an account that has
   * none: one created by a first sign-in with a provider Tula takes no address from
   * (`OAUTH_PROVIDERS_WITHOUT_ADDRESS`; ADR 0026). Such an account is sent nothing, is found
   * by no address, has no `email` identity and no password.
   */
  email: string | null
  /**
   * Lowercased, trimmed email used for lookups and uniqueness; `null` exactly when
   * {@link UserRecord.email} is. Any number of accounts may have none.
   */
  emailNormalized: string | null
  /** When the address was verified. Always `null` for an account with no address. */
  emailVerifiedAt: Date | null
  firstName: string | null
  lastName: string | null
  bannedAt: Date | null
  lastSignInAt: Date | null
  createdAt: Date
  /**
   * The account's phone number in E.164 form, or `null`. Only ever a number the user proved
   * with a code sent to it. Not unique. An account is looked up by it in one place only,
   * `Phone.signInHolder`, for a sign-in with a texted code where the environment has
   * switched that on (ADR 0037). Personal data like the email address: never in a log line, an audit entry,
   * an event payload or an error.
   */
  phoneNumber: string | null
  /** When {@link UserRecord.phoneNumber} was verified; `null` exactly when there is none. */
  phoneNumberVerifiedAt: Date | null
  /**
   * Since when a code texted to {@link UserRecord.phoneNumber} is the account's second factor
   * (ADR 0025); `null` when it is not. Never set without a number: taking the number away,
   * or replacing it with another, clears it in the same write.
   */
  smsFactorEnabledAt: Date | null
}

/**
 * A user to create together with their email identity and, if they have one, their password.
 * A user with no address gets no email identity, and must come with an `oauthIdentity` and no
 * password: it is the only thing they sign in with.
 */
export interface NewUser
  extends Omit<
    UserRecord,
    'bannedAt' | 'lastSignInAt' | 'phoneNumber' | 'phoneNumberVerifiedAt' | 'smsFactorEnabledAt'
  > {
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

/**
 * What a password write does to the passwords the user had before (ADR 0038).
 *
 * Every write names it, so that no path can store a password and leave the history as it was.
 */
export interface PasswordHistoryRule {
  /**
   * How many previous passwords the user has after this write: the environment's
   * `password.history` minus one (the current password counts as one of "the last N"), and 0
   * where the policy keeps none. The hash that stops being current becomes the newest previous
   * one when this is at least 1; whatever is then beyond it is deleted in the same transaction.
   */
  keep: number
  /**
   * Given when the new password was compared with the stored ones: the current hash it was
   * compared with (`null`: the user had no password). The write then happens only while that
   * is still the stored hash, so a password is never stored on a comparison with a history
   * that has since moved. Left out by a write that compares nothing (an administrator's).
   */
  ifCurrent?: string | null
}

/**
 * A user's current password hash and the ones before it, newest first.
 *
 * Hashes only ever leave the store to be verified against: never log, return or record one.
 */
export interface StoredPasswords {
  /** The current argon2id hash, or `null` for a user with no password. */
  current: string | null
  /** The previous hashes that were asked for, the most recent first. */
  previous: string[]
}

/**
 * A user as a password sign-in reads them: with the hash of their password and the time that
 * password was set.
 */
export interface UserWithPassword {
  user: UserRecord
  /** The current argon2id hash, or `null` for a user with no password. */
  passwordHash: string | null
  /**
   * When the current password was set: stored for the first time, or replaced by a different
   * one. `null` exactly when `passwordHash` is. A hash upgrade after a sign-in
   * (`upgradePasswordHash`) does not move it: it is the same password, and a rehash must not
   * make an old password look new (`password.expiryDays`, ADR 0041).
   */
  passwordChangedAt: Date | null
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

/**
 * The second factors stronger than a texted code that a user holds, as a store reads them
 * inside the write they guard. Whether a passkey counts (passkeys may be switched off) is
 * the service's to say, which is why this is a count and not a verdict.
 */
export interface StrongerFactorsHeld {
  /** An authenticator app that has been confirmed. A pending enrolment is not one. */
  confirmedTotp: boolean
  /** How many passkeys the user has, usable or not. */
  passkeys: number
}

/** What {@link UserRepository.enableSmsFactor} did. */
export type SmsFactorEnableOutcome = 'enabled' | 'stale' | 'stronger_factor'

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
   * @returns The user, their password hash and when that password was set (both `null` when
   *   they have no password), or `null`.
   */
  findByEmailWithPassword(
    environmentId: string,
    emailNormalized: string
  ): Promise<UserWithPassword | null>

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
  linkIdentity(identity: NewIdentity, activity: Recorded, guard?: LinkGuard): Promise<LinkOutcome>

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
    activity: Recorded
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
  create(user: NewUser, activity: Recorded): Promise<boolean>

  /**
   * Store a user's password hash: replace the one they have, or create the credential when
   * they have none (a user who signed up another way setting their first password). One atomic
   * write either way; of two concurrent first passwords exactly one is `created`.
   *
   * The hash that stops being current is kept as the user's newest previous password, every
   * older one moves one place back, and what is then beyond `history.keep` is deleted: all in
   * the transaction that stores the new hash, under a lock on the user, so of two concurrent
   * writes neither loses a previous password nor keeps one twice (ADR 0038).
   *
   * @param environmentId - The user's environment.
   * @param userId - The user.
   * @param passwordHash - The new argon2id hash.
   * @param at - Update time, and from now on the time the user's password was set. **A
   *   replacement is always newer than the password it replaces**: where `at` is not later
   *   than the time stored, the store sets that time plus one millisecond. A sign-in waiting
   *   to replace an expired password tells a replacement from a hash upgrade by this time
   *   (ADR 0041), so it must move whatever the writer's clock says.
   * @param activity - Recorded in the same transaction as the write. When the password is the
   *   user's first, the recorded entry's `data` gains `created: true`: only the store knows
   *   which happened at the moment it happens.
   * @param history - What becomes of the previous passwords, and the current hash the new
   *   password was compared with, if it was.
   * @returns What happened; `'stale'` when `history.ifCurrent` is no longer the stored hash;
   *   or `null` when the user does not exist in that environment. For the last two nothing is
   *   written or recorded.
   */
  setPasswordHash(
    environmentId: string,
    userId: string,
    passwordHash: string,
    at: Date,
    activity: Recorded,
    history: PasswordHistoryRule
  ): Promise<PasswordOutcome | 'stale' | null>

  /**
   * The hashes a new password of the user is compared with (ADR 0038): the current one and
   * the most recent previous ones.
   *
   * Not a snapshot: an adapter may read the current hash and the previous ones in two
   * statements, and a password change can land between them or after both. What covers that
   * is not this read but the write: {@link setPasswordHash} is told the current hash that was
   * compared with (`ifCurrent`) and stores nothing when it is no longer the current one.
   *
   * @param environmentId - The user's environment.
   * @param userId - The user.
   * @param previous - How many previous hashes to return at most.
   * @returns The hashes (a user with no password, or none in that environment: `current` is
   *   `null` and `previous` is empty).
   */
  storedPasswords(environmentId: string, userId: string, previous: number): Promise<StoredPasswords>

  /**
   * Delete previous passwords that are beyond what the environment now keeps, for the
   * retention job (ADR 0017): what a lowered `password.history` left with users who have not
   * changed their password since.
   *
   * It never waits for a row a password change holds: such rows are passed over and go in a
   * later call, so a purge and a user's own change cannot block or deadlock each other. A
   * return below `limit` therefore does not promise that nothing is left.
   *
   * @param environmentId - The environment to purge.
   * @param keep - How many previous passwords a user may have (`password.history` minus one,
   *   at least 0).
   * @param limit - The most rows to delete in this call.
   * @returns How many rows were deleted.
   */
  deletePasswordHistoryBeyond(environmentId: string, keep: number, limit: number): Promise<number>

  /**
   * Replace a password hash with a stronger hash **of the same password**, only if the stored
   * hash is still the one that was verified. A plain write here could overwrite a password that
   * was changed between the verify and the upgrade, bringing the old password back.
   *
   * It is not a new password, so the previous passwords are left exactly as they are: the old
   * hash is not kept (the same password would then be there twice). For the same reason the
   * time the password was set does not move: an expired password stays expired (ADR 0041).
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
   * changes nothing and removes nothing. The account's previous passwords are deleted with
   * the password, in that transaction: they were chosen by the same stranger, and the owner
   * must never be refused a password because of them (ADR 0038).
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
    activity: Recorded,
    removePassword?: { activity: Recorded }
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
    activity: Recorded
  ): Promise<UserRecord | null>

  /**
   * The users of an environment whose account holds a phone number, oldest account first.
   *
   * A number is not unique (ADR 0037), so this answers a list. **It is the one read by
   * number, and it has one caller**: `Phone.signInHolder`, for a sign-in with a texted code.
   * Nothing else may find an account from a number: not linking, not a sign-up, not a reset,
   * not a search (`modules/phone/lookup.test.ts` walks the sources).
   *
   * @param environmentId - The environment to search.
   * @param phoneNumber - The number, in E.164 form.
   * @param limit - The most users to return. Two is enough to tell one holder from several.
   * @returns The holders, at most `limit`; empty when nobody holds the number.
   */
  findByPhoneNumber(
    environmentId: string,
    phoneNumber: string,
    limit: number
  ): Promise<UserRecord[]>

  /**
   * Move the time a user's phone number was last proven, after a sign-in with a code texted
   * to it: the number has just been shown, again, to be theirs.
   *
   * Bookkeeping like {@link UserRepository.recordSignIn}, and **not recorded**: it changes
   * nothing about who can do what today (the session it follows is recorded as
   * `session.created`), it only keeps the number from lapsing as a way to sign in
   * (ADR 0012, ADR 0037). It writes only while the account still holds exactly that number,
   * and never moves the time backwards.
   *
   * @param environmentId - The user's environment.
   * @param userId - The user.
   * @param phoneNumber - The number the code was texted to, in E.164 form.
   * @param at - When the code was accepted.
   */
  recordPhoneNumberProof(
    environmentId: string,
    userId: string,
    phoneNumber: string,
    at: Date
  ): Promise<void>

  /**
   * Store a phone number the user has just proven, with the time it was proven, replacing
   * the one they had. Always a write, and always recorded: proving the same number again
   * moves its verification time. **A texted code that was the user's second factor goes
   * when the number changes**, in the same statement (it was a factor of the old number);
   * proving the same number again keeps it.
   *
   * @param environmentId - The user's environment.
   * @param userId - The user.
   * @param phoneNumber - The number, in E.164 form.
   * @param at - Verification time.
   * @param activity - Recorded in the same transaction, only if the user exists.
   * @param factorRemoved - Recorded in the same transaction, only if the user's texted-code
   *   second factor was on and went with the number it was texted to.
   * @returns The user as they now are, or `null` when they do not exist (nothing is written).
   */
  setPhoneNumber(
    environmentId: string,
    userId: string,
    phoneNumber: string,
    at: Date,
    activity: Recorded,
    factorRemoved: Recorded
  ): Promise<UserRecord | null>

  /**
   * Take the phone number, and its verification time, off a user. **A texted code that was
   * the user's second factor goes with it, in the same statement**: there is never a factor
   * without the number it is texted to.
   *
   * @param environmentId - The user's environment.
   * @param userId - The user.
   * @param at - Update time.
   * @param activity - Recorded in the same transaction, only if a number was removed.
   * @param factorRemoved - Recorded in the same transaction, only if the user's texted-code
   *   second factor was on and went with the number.
   * @returns `false` when the user has no number, or does not exist (nothing is recorded).
   */
  removePhoneNumber(
    environmentId: string,
    userId: string,
    at: Date,
    activity: Recorded,
    factorRemoved: Recorded
  ): Promise<boolean>

  /**
   * Make a code texted to the user's phone number their second factor (ADR 0025).
   *
   * A compare-and-set: it writes only while the account still holds exactly `phoneNumber`
   * (the number the confirming code was texted to) and the factor is not on already. So a
   * number replaced or removed while its code was on its way enrols nothing, and of two
   * confirmations at once one wins.
   *
   * **Whether a stronger factor stands in the way is part of the write.** Under the user's
   * row lock the store reads what the user holds now ({@link StrongerFactorsHeld}) and asks
   * `allowed`; the service's own earlier look is a courtesy. A passkey's registration takes
   * the same lock and so does an authenticator's confirmation, so neither can arrive
   * between this read and this write.
   *
   * @param environmentId - The user's environment.
   * @param userId - The user.
   * @param phoneNumber - The number the confirming code was texted to, in E.164 form.
   * @param at - When it was confirmed.
   * @param allowed - The service's rule, asked with what the user holds at the write.
   * @param activity - Recorded in the same transaction, only if the factor was turned on.
   * @returns `'enabled'`; `'stale'` when the number is not the account's or the factor is
   *   on already (or there is no such user); `'stronger_factor'` when `allowed` refused.
   *   Nothing is written or recorded for the last two.
   */
  enableSmsFactor(
    environmentId: string,
    userId: string,
    phoneNumber: string,
    at: Date,
    allowed: (held: StrongerFactorsHeld) => boolean,
    activity: Recorded
  ): Promise<SmsFactorEnableOutcome>

  /**
   * Stop a texted code being the user's second factor. The phone number stays.
   *
   * @param environmentId - The user's environment.
   * @param userId - The user.
   * @param at - Update time.
   * @param activity - Recorded in the same transaction, only if the factor was on.
   * @returns `false` when it was not on, or the user does not exist (nothing is recorded).
   */
  disableSmsFactor(
    environmentId: string,
    userId: string,
    at: Date,
    activity: Recorded
  ): Promise<boolean>

  /**
   * Delete a user and, by cascade, their identities, credentials (with every previous
   * password kept for them), sessions and attempts.
   *
   * @param environmentId - The user's environment.
   * @param userId - The user.
   * @param activity - Recorded in the same transaction, only if the user was deleted.
   * @returns `false` when they do not exist.
   */
  delete(environmentId: string, userId: string, activity: Recorded): Promise<boolean>
}
