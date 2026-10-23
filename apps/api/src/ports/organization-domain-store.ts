import type { OrganizationDomainMode } from '@tula-tech/contract'
import type { Recorded } from '~/ports/activity-log'

/**
 * A domain an organization claims, as stored (ADR 0065, "Verified domains").
 *
 * **Pending** while `verifiedAt` is `null`: the row then holds the keyed hash of the emailed
 * code, when it stops working and the guesses made at it. **Verified** once the code was
 * entered: the domain is the organization's alone in its environment, until `expiresAt`
 * (ADR 0065, "Lapse"); from then on it matches nobody and only a new code restores it. A
 * verified row holds a code only while a manager is proving it again, and keeps matching
 * meanwhile.
 */
export interface OrganizationDomainRecord {
  id: string
  projectId: string
  environmentId: string
  organizationId: string
  /** Lower-case, in the contract's grammar. */
  domain: string
  mode: OrganizationDomainMode
  verifiedAt: Date | null
  /** When the verification lapses; `null` exactly while the claim is pending. */
  expiresAt: Date | null
  /** The smallest reminder threshold (days) sent for this verification; `null`: none yet. */
  remindedDays: number | null
  /** `HMAC(key, "<id>:<domain>:<code>")`; `null` when no code is waiting. */
  codeHash: string | null
  codeExpiresAt: Date | null
  /** Guesses made at the current code. */
  codeAttempts: number
  createdAt: Date
  updatedAt: Date
}

/** What {@link OrganizationDomainStore.claim} writes. */
export interface DomainClaim {
  /** Used when the organization has no row for the domain yet; an existing row keeps its id. */
  id: string
  projectId: string
  environmentId: string
  organizationId: string
  domain: string
  mode: OrganizationDomainMode
  codeHash: string
  codeExpiresAt: Date
  /** When the claim is made. */
  at: Date
  /** The most domains (pending and verified) the organization may have, this one included. */
  limit: number
}

/** A verified row due a reminder: the row and the threshold (days) it has reached. */
export interface DueReminder {
  record: OrganizationDomainRecord
  /** The smallest of the reminder thresholds that `record.expiresAt` is within. */
  days: number
}

/** What a claim came to. */
export type ClaimOutcome =
  /**
   * The row holds this code; `record` is it as stored. A pending row is written pending. A
   * **verified row of this organization** keeps its mode, its dates and its standing (it
   * matches until it lapses) and only has a new code: the mode in the claim is ignored.
   */
  | { outcome: 'claimed'; record: OrganizationDomainRecord }
  /**
   * The domain is verified for another organization of the environment and that verification
   * has not lapsed. (A lapsed one does not block: see {@link OrganizationDomainStore.claim}.)
   */
  | { outcome: 'taken' }
  /** The organization has `limit` domains already, and none is this one. */
  | { outcome: 'limit_reached' }
  /** The organization does not exist (it was deleted since the caller read it). */
  | { outcome: 'gone' }

/** What entering the right code came to. */
export type VerifyDomainOutcome =
  | { outcome: 'verified'; record: OrganizationDomainRecord }
  /** The claim is gone, was replaced by a newer code, or was verified meanwhile. */
  | { outcome: 'stale' }
  /** Another organization verified the domain first. Nothing was written. */
  | { outcome: 'taken' }

/** What changing a domain's mode came to. */
export type SetDomainModeOutcome =
  | { outcome: 'updated'; record: OrganizationDomainRecord; previousMode: OrganizationDomainMode }
  | { outcome: 'not_found' }

/**
 * An organization's domains: claims waiting for a code, and verified ones (ADR 0065), always
 * read and written inside one environment. Another environment's row is never returned,
 * changed or counted.
 */
export interface OrganizationDomainStore {
  /**
   * @param environmentId - The environment to look in.
   * @param organizationId - The organization.
   * @returns Its domains, oldest first. Empty for an organization of another environment.
   */
  list(environmentId: string, organizationId: string): Promise<OrganizationDomainRecord[]>

  /**
   * @param environmentId - The environment to look in.
   * @param organizationId - The organization.
   * @param id - The domain row.
   * @returns The row, or `null` when the organization has none with that id.
   */
  find(
    environmentId: string,
    organizationId: string,
    id: string
  ): Promise<OrganizationDomainRecord | null>

  /**
   * @param environmentId - The environment to look in.
   * @param domain - A domain, exactly as stored (no subdomain, no parent).
   * @returns The **verified** row for it, or `null`. At most one exists: a pending claim is
   *   never returned.
   */
  findVerified(environmentId: string, domain: string): Promise<OrganizationDomainRecord | null>

  /**
   * Claim a domain for an organization, or replace the code of a claim it has already, **in
   * one transaction that holds the organization's row**, so that the count against the limit
   * and the write take turns. A new claim is a pending row; an existing pending row keeps its
   * id and gets the new code, mode, expiry and zero guesses (the old code stops working).
   * Writes nothing for a domain that another organization has verified and that has not
   * lapsed (`taken`). A lapsed verification of another organization does not block a claim
   * (the pending row is written; verifying it needs the lapsed row removed first, which the
   * service does). A domain this organization has verified gets a new code and nothing else
   * changes (re-verification).
   *
   * @param claim - The row to write.
   * @param activity - Recorded in the same transaction, only if a row was written.
   * @returns What came of it.
   */
  claim(claim: DomainClaim, activity: Recorded): Promise<ClaimOutcome>

  /**
   * Count one guess at a pending claim's code, **atomically and before the code is compared**:
   * concurrent guesses can then never make more than `maxAttempts` between them. Not an
   * audit entry: a guess changes nobody's access.
   *
   * @param environmentId - The environment.
   * @param organizationId - The organization.
   * @param id - The domain row.
   * @param now - The current time.
   * @param maxAttempts - Guesses a code allows.
   * @returns The row with the incremented counter, or `null` when it holds no code, its code
   *   expired or it is out of guesses (nothing is counted). A verified row being proven again
   *   counts like a pending one.
   */
  recordAttempt(
    environmentId: string,
    organizationId: string,
    id: string,
    now: Date,
    maxAttempts: number
  ): Promise<OrganizationDomainRecord | null>

  /**
   * Verify a claim whose code was entered right: set `verifiedAt` and `expiresAt`, clear the
   * code and the reminder mark, **only if the row still holds the code that was checked**
   * (`expectedCodeHash`). The unique key over verified rows decides a race between two
   * organizations. Also the end of a re-verification: the dates move on.
   *
   * @param environmentId - The environment.
   * @param organizationId - The organization.
   * @param id - The domain row.
   * @param expectedCodeHash - The hash the entered code matched.
   * @param at - When it is verified.
   * @param expiresAt - When this verification lapses.
   * @param activity - Recorded in the same transaction, only if the row was verified.
   * @returns What came of it.
   */
  verify(
    environmentId: string,
    organizationId: string,
    id: string,
    expectedCodeHash: string,
    at: Date,
    expiresAt: Date,
    activity: Recorded
  ): Promise<VerifyDomainOutcome>

  /**
   * Change what a domain does.
   *
   * @param environmentId - The environment.
   * @param organizationId - The organization.
   * @param id - The domain row, pending or verified.
   * @param mode - The new mode.
   * @param at - When it changes.
   * @param activity - Recorded in the same transaction, only if the row was written.
   * @returns What came of it.
   */
  setMode(
    environmentId: string,
    organizationId: string,
    id: string,
    mode: OrganizationDomainMode,
    at: Date,
    activity: Recorded
  ): Promise<SetDomainModeOutcome>

  /**
   * Remove a domain, pending or verified. Members who joined because of it stay.
   *
   * @param environmentId - The environment.
   * @param organizationId - The organization.
   * @param id - The domain row.
   * @param activity - Recorded in the same transaction, only if a row was deleted.
   * @returns `false` when the organization had no such row.
   */
  remove(
    environmentId: string,
    organizationId: string,
    id: string,
    activity: Recorded
  ): Promise<boolean>

  /**
   * The verified rows that have reached a reminder threshold and have not been reminded of it:
   * `expiresAt` is after `now`, within `days` of it for one of the `thresholds`, and
   * `remindedDays` is null or larger than that threshold. A lapsed row is not returned.
   *
   * @param environmentId - The environment.
   * @param now - The current time.
   * @param thresholds - Days before the lapse, as the contract's `DOMAIN_REMINDER_DAYS`.
   * @param limit - The most rows to return.
   * @returns The rows with the smallest threshold each has reached, soonest lapse first.
   */
  listDueReminders(
    environmentId: string,
    now: Date,
    thresholds: readonly number[],
    limit: number
  ): Promise<DueReminder[]>

  /**
   * Take a reminder: set `remindedDays` to `days` **only if** the row is verified and has not
   * been reminded at that threshold or a smaller one, so that two instances (or a retry)
   * send a reminder once.
   *
   * @param environmentId - The environment.
   * @param organizationId - The organization.
   * @param id - The domain row.
   * @param days - The threshold being sent.
   * @returns The previous `remindedDays` (`null`: none) when taken, or `false` when not.
   */
  takeReminder(
    environmentId: string,
    organizationId: string,
    id: string,
    days: number
  ): Promise<{ previous: number | null } | false>

  /**
   * Give a taken reminder back when it could not be sent, so that the next run tries again:
   * restores `previous` **only if** the row still holds `days` (a re-verification in between
   * has reset it, and that wins).
   *
   * @param environmentId - The environment.
   * @param organizationId - The organization.
   * @param id - The domain row.
   * @param days - The threshold that was taken.
   * @param previous - What {@link OrganizationDomainStore.takeReminder} returned.
   */
  releaseReminder(
    environmentId: string,
    organizationId: string,
    id: string,
    days: number,
    previous: number | null
  ): Promise<void>

  /**
   * Delete pending claims whose code expired before a time (the retention job, ADR 0017). A
   * verified domain is never deleted by it.
   *
   * @param environmentId - The environment to purge.
   * @param cutoff - Claims whose code expired before this are deleted.
   * @param limit - The most rows to delete in this call.
   * @returns How many were deleted.
   */
  purgeExpiredPending(environmentId: string, cutoff: Date, limit: number): Promise<number>
}
