import type { Activity } from '~/ports/activity-log'
import type { SignInMeans } from '~/ports/user-repository'

/** A user's passkey: a WebAuthn credential's public half. Nothing in it is a secret. */
export interface PasskeyRecord {
  id: string
  projectId: string
  environmentId: string
  userId: string
  /** The credential id, base64url. Unique in its environment. */
  credentialId: string
  /** The COSE public key. */
  publicKey: Uint8Array
  /** The authenticator's signature counter at its last use; `0` when it keeps none. */
  signCount: number
  transports: string[]
  aaguid: string
  backupEligible: boolean
  backedUp: boolean
  /** The opaque handle given to the authenticator as `user.id`: one per user. */
  userHandle: string
  name: string
  lastUsedAt: Date | null
  createdAt: Date
}

/** What a session's stored challenge was issued for. */
export type PasskeyChallengePurpose = 'registration' | 'step_up'

/** A WebAuthn challenge issued to a signed-in session. */
export interface PasskeyChallengeRecord {
  id: string
  projectId: string
  environmentId: string
  userId: string
  sessionId: string
  purpose: PasskeyChallengePurpose
  challenge: string
  expiresAt: Date
  createdAt: Date
}

/**
 * What storing a passkey did.
 *
 * - `created`: stored.
 * - `duplicate`: the credential id already belongs to a passkey of this environment.
 * - `limit`: the user already has as many passkeys as allowed.
 */
export type PasskeyCreateOutcome = 'created' | 'duplicate' | 'limit'

/**
 * What removing a passkey did.
 *
 * - `removed`: gone.
 * - `not_found`: the user has no such passkey.
 * - `last_method`: refused, because nothing else would let the user sign in.
 */
export type PasskeyRemoveOutcome = 'removed' | 'not_found' | 'last_method'

/** What an accepted assertion writes back to its passkey. */
export interface PasskeyUse {
  /** The counter the row must still hold: the update is a compare-and-set on it. */
  expectedSignCount: number
  signCount: number
  backupEligible: boolean
  backedUp: boolean
  at: Date
}

/**
 * Passkeys and the WebAuthn challenges of signed-in sessions, always read and written inside
 * one environment (ADR 0027).
 */
export interface PasskeyStore {
  /**
   * Store a passkey, unless the user is at the limit or the credential id is taken.
   *
   * @param passkey - The passkey.
   * @param limit - The most passkeys the user may have, counted in the same transaction.
   * @param activity - Recorded in the same transaction, only if the passkey was stored.
   * @returns What happened.
   */
  create(passkey: PasskeyRecord, limit: number, activity?: Activity): Promise<PasskeyCreateOutcome>

  /**
   * @param environmentId - The environment to look in.
   * @param userId - The user.
   * @returns The user's passkeys, oldest first.
   */
  listForUser(environmentId: string, userId: string): Promise<PasskeyRecord[]>

  /**
   * @param environmentId - The environment to look in.
   * @param credentialId - The credential id an assertion names, base64url.
   * @returns The passkey, or `null`. Never one of another environment.
   */
  findByCredentialId(environmentId: string, credentialId: string): Promise<PasskeyRecord | null>

  /**
   * Record an accepted assertion: the new counter, the backup flags and the time.
   *
   * A compare-and-set on the stored counter, so of two requests carrying the same assertion
   * only one succeeds for an authenticator that counts.
   *
   * @param environmentId - The environment.
   * @param id - The passkey.
   * @param use - The expected and the new counter, the flags and when.
   * @returns `false` when the passkey is gone or its counter is no longer the expected one.
   */
  recordUse(environmentId: string, id: string, use: PasskeyUse): Promise<boolean>

  /**
   * Record that an assertion was refused because its signature counter went backwards.
   * Changes nothing about the passkey.
   *
   * @param environmentId - The environment.
   * @param id - The passkey.
   * @param activity - The audit entry.
   */
  reportRegression(environmentId: string, id: string, activity: Activity): Promise<void>

  /**
   * @param environmentId - The environment.
   * @param userId - The owner: a passkey of another user is not renamed.
   * @param id - The passkey.
   * @param name - The new name.
   * @param at - When.
   * @param activity - Recorded in the same transaction, only if a passkey was renamed.
   * @returns Whether a passkey was renamed.
   */
  rename(
    environmentId: string,
    userId: string,
    id: string,
    name: string,
    at: Date,
    activity?: Activity
  ): Promise<boolean>

  /**
   * Remove one passkey of a user, unless that would leave them no way to sign in.
   *
   * The check and the delete are one transaction that locks the user, so two removals at once
   * cannot each rely on what the other is about to remove.
   *
   * @param environmentId - The environment.
   * @param userId - The owner.
   * @param id - The passkey.
   * @param allowed - Asked with what the user would have left; `false` refuses the removal.
   * @param activity - Recorded in the same transaction, only if the passkey was removed.
   * @returns What happened.
   */
  remove(
    environmentId: string,
    userId: string,
    id: string,
    allowed: (remaining: SignInMeans) => boolean,
    activity?: Activity
  ): Promise<PasskeyRemoveOutcome>

  /**
   * Remove every passkey and stored challenge of a user (an admin reset).
   *
   * @param environmentId - The environment.
   * @param userId - The user.
   * @param activity - Recorded in the same transaction, only if a passkey was removed.
   * @returns How many passkeys were removed.
   */
  removeForUser(environmentId: string, userId: string, activity?: Activity): Promise<number>

  /**
   * Store a session's challenge, replacing an earlier one of the same purpose.
   *
   * @param challenge - The challenge.
   */
  putChallenge(challenge: PasskeyChallengeRecord): Promise<void>

  /**
   * Take a session's challenge: read it and delete it in one statement, so it is honoured once.
   *
   * @param environmentId - The environment.
   * @param sessionId - The session that asked.
   * @param purpose - What it was issued for.
   * @param now - The current time: an expired challenge is deleted and not returned.
   * @returns The challenge with the user it was issued to, or `null`.
   */
  takeChallenge(
    environmentId: string,
    sessionId: string,
    purpose: PasskeyChallengePurpose,
    now: Date
  ): Promise<Pick<PasskeyChallengeRecord, 'challenge' | 'userId'> | null>

  /**
   * Delete challenges that expired before a cutoff, a batch at a time (the retention job).
   *
   * @param environmentId - The environment.
   * @param before - Rows that expired before this are deleted.
   * @param limit - The most rows to delete in this call.
   * @returns How many rows were deleted.
   */
  deleteExpiredChallenges(environmentId: string, before: Date, limit: number): Promise<number>
}
