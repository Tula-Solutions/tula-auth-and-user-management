import type { Recorded } from '~/ports/activity-log'

/** A user's authenticator (TOTP) factor. The secret is only ever held sealed. */
export interface FactorRecord {
  id: string
  projectId: string
  environmentId: string
  userId: string
  type: 'totp'
  /** The shared secret, sealed with `~/lib/secret-box` (bound to environment, user and id). */
  secret: string
  /** `null` while the enrolment is pending. A pending factor is never asked for or accepted. */
  confirmedAt: Date | null
  /** When a pending enrolment lapses; `null` once confirmed. */
  expiresAt: Date | null
  /** The last RFC 6238 time step a code was accepted for; `null` before the first. */
  lastUsedStep: number | null
  createdAt: Date
}

/** A pending factor to store. */
export type NewFactor = Omit<FactorRecord, 'confirmedAt' | 'lastUsedStep' | 'expiresAt'> & {
  expiresAt: Date
}

/** A backup code to store: only its keyed hash. */
export interface NewBackupCode {
  id: string
  codeHash: string
}

/** What confirming an enrolment writes, in one transaction. */
export interface FactorConfirmation {
  /** The time step of the code that confirmed it: that code cannot be used again. */
  step: number
  at: Date
  /** The user's new backup codes; any earlier ones are removed. */
  backupCodes: readonly NewBackupCode[]
  /** Recorded in the same transaction, only if the factor was confirmed. */
  activity: Recorded
}

/**
 * Whether a factor counts: confirmed. Shared by the adapters and the service so they agree.
 *
 * @param factor - A factor, or none.
 * @returns `true` only for a confirmed factor.
 */
export function isConfirmed(factor: Pick<FactorRecord, 'confirmedAt'> | null): boolean {
  return factor !== null && factor.confirmedAt !== null
}

/**
 * Second factors (an authenticator app) and backup codes, always read and written inside one
 * environment. A user has at most one TOTP factor, pending or confirmed.
 */
export interface FactorStore {
  /**
   * @param environmentId - The environment to look in.
   * @param userId - The user.
   * @returns The user's TOTP factor, pending or confirmed, or `null`.
   */
  findTotp(environmentId: string, userId: string): Promise<FactorRecord | null>

  /**
   * Store a pending enrolment. An earlier **pending** one of the same user is replaced (the
   * user started again); a **confirmed** factor is never touched.
   *
   * @param factor - The pending factor.
   * @returns `false` when the user already has a confirmed factor (nothing was written).
   */
  startTotp(factor: NewFactor): Promise<boolean>

  /**
   * Confirm a pending enrolment and replace the user's backup codes, atomically. Guarded: only
   * a factor that is still pending and not expired at `confirmation.at` is confirmed, so of two
   * concurrent confirmations exactly one succeeds.
   *
   * @param environmentId - The factor's environment.
   * @param id - Factor id.
   * @param confirmation - The step used, the time, the new backup codes and the activity.
   * @returns `false` when the guard failed (nothing was written).
   */
  confirmTotp(environmentId: string, id: string, confirmation: FactorConfirmation): Promise<boolean>

  /**
   * Mark a time step used, as a compare-and-set: it succeeds only for a confirmed factor whose
   * last used step is **strictly lower** (or unset). This is the replay rule: a code works
   * once, and a code of an earlier step never works after a later one was used. Of two
   * concurrent submissions of the same code exactly one succeeds.
   *
   * @param environmentId - The factor's environment.
   * @param id - Factor id.
   * @param step - The time step of the accepted code.
   * @param at - Current time.
   * @returns `false` when the step was already used or passed (nothing was written).
   */
  useTotpStep(environmentId: string, id: string, step: number, at: Date): Promise<boolean>

  /**
   * Remove a user's factor (pending or confirmed) and every backup code they have.
   *
   * @param environmentId - The user's environment.
   * @param userId - The user.
   * @param activity - Recorded in the same transaction, only if a **confirmed** factor was
   *   removed.
   * @param onlyFactorId - Remove the factor only if it is this one. A caller undoing its own
   *   work passes the id of the factor it made: when the user's factor is another one by now
   *   (reset and enrolled again in between), nothing is removed, the backup codes included.
   * @returns Whether a confirmed factor was removed.
   */
  removeForUser(
    environmentId: string,
    userId: string,
    activity: Recorded,
    onlyFactorId?: string
  ): Promise<boolean>

  /**
   * Replace every backup code of a user who has a confirmed factor.
   *
   * @param environmentId - The user's environment.
   * @param userId - The user.
   * @param scope - Project of the new rows.
   * @param codes - The new codes' hashes.
   * @param at - Current time.
   * @param activity - Recorded in the same transaction, only if the codes were replaced.
   * @returns `false` when the user has no confirmed factor (nothing was written).
   */
  replaceBackupCodes(
    environmentId: string,
    userId: string,
    scope: { projectId: string },
    codes: readonly NewBackupCode[],
    at: Date,
    activity: Recorded
  ): Promise<boolean>

  /**
   * Spend a backup code. Single use: one guarded update, so of two concurrent submissions of
   * the same code exactly one succeeds.
   *
   * @param environmentId - The user's environment.
   * @param userId - The user the code must belong to.
   * @param codeHash - Keyed hash of the presented code.
   * @param at - Current time.
   * @param activity - Recorded in the same transaction, only if the code was spent.
   * @returns How many unused codes remain, or `null` when the code is unknown, another user's
   *   or already used (nothing was written).
   */
  consumeBackupCode(
    environmentId: string,
    userId: string,
    codeHash: string,
    at: Date,
    activity: Recorded
  ): Promise<number | null>

  /**
   * @param environmentId - The user's environment.
   * @param userId - The user.
   * @returns How many unused backup codes the user has.
   */
  countBackupCodes(environmentId: string, userId: string): Promise<number>

  /**
   * Remove enrolments in an environment that were never confirmed and lapsed at or before
   * `before`. A confirmed factor is never touched. At most `limit` go per call, so no call
   * holds locks for long; the caller repeats while a full batch comes back.
   *
   * @param environmentId - The environment to purge.
   * @param before - Pending factors with `expiresAt <= before` go.
   * @param limit - The most factors to remove in this call.
   * @returns How many were removed.
   */
  deleteExpiredPending(environmentId: string, before: Date, limit: number): Promise<number>
}
