import type { OrganizationDomainMode } from '@tula-tech/contract'
import type { Recorded } from '~/ports/activity-log'

/**
 * A domain an organization claims, as stored (ADR 0065, "Verified domains").
 *
 * **Pending** while `verifiedAt` is `null`: the row then holds the keyed hash of the emailed
 * code, when it stops working and the guesses made at it. **Verified** once the code was
 * entered: the code columns are `null` and the domain is the organization's alone in its
 * environment.
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
  /** `HMAC(key, "<id>:<domain>:<code>")`; `null` exactly when the domain is verified. */
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

/** What a claim came to. */
export type ClaimOutcome =
  /** The row is pending with this code; `record` is it as stored. */
  | { outcome: 'claimed'; record: OrganizationDomainRecord }
  /** The domain is verified for an organization of the environment, this one or another. */
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
   * Writes nothing for a domain that is verified already, for this organization or another.
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
   * @returns The row with the incremented counter, or `null` when it is not pending, its code
   *   expired or it is out of guesses (nothing is counted).
   */
  recordAttempt(
    environmentId: string,
    organizationId: string,
    id: string,
    now: Date,
    maxAttempts: number
  ): Promise<OrganizationDomainRecord | null>

  /**
   * Verify a claim whose code was entered right: set `verifiedAt` and clear the code, **only
   * if the row still holds the code that was checked** (`expectedCodeHash`). The unique key
   * over verified rows decides a race between two organizations.
   *
   * @param environmentId - The environment.
   * @param organizationId - The organization.
   * @param id - The domain row.
   * @param expectedCodeHash - The hash the entered code matched.
   * @param at - When it is verified.
   * @param activity - Recorded in the same transaction, only if the row was verified.
   * @returns What came of it.
   */
  verify(
    environmentId: string,
    organizationId: string,
    id: string,
    expectedCodeHash: string,
    at: Date,
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
