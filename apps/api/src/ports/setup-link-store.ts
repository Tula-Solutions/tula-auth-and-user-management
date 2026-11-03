import type { Recorded } from '~/ports/activity-log'

/** A setup link of an organization's SSO setup portal, as stored (ADR 0067, "Setup links"). */
export interface SetupLinkRecord {
  id: string
  projectId: string
  environmentId: string
  organizationId: string
  name: string
  /** The first characters of the token, for the list: never enough to use it. */
  prefix: string
  /** SHA-256 of the token. */
  tokenHash: string
  expiresAt: Date
  revokedAt: Date | null
  lastUsedAt: Date | null
  /** The audit actor that created it. */
  createdByType: string
  createdById: string | null
  createdAt: Date
  updatedAt: Date
}

/** Storage of setup links. */
export interface SetupLinkStore {
  /**
   * @param record - The link, hash only.
   * @param recorded - The audit entry written in the same transaction (`setup_link.created`).
   */
  insert(record: SetupLinkRecord, recorded: Recorded): Promise<void>

  /**
   * @param environmentId - The environment.
   * @param organizationId - The organization.
   * @returns Its links, revoked and expired ones included, newest first.
   */
  list(environmentId: string, organizationId: string): Promise<SetupLinkRecord[]>

  /**
   * @param environmentId - The environment the presented token names.
   * @param tokenHash - SHA-256 of the presented token.
   * @returns The link, or `null` (also for another environment's).
   */
  findByHash(environmentId: string, tokenHash: string): Promise<SetupLinkRecord | null>

  /**
   * Revoke a link that is not revoked yet.
   *
   * @param environmentId - The environment.
   * @param organizationId - The organization the link must belong to.
   * @param id - The link.
   * @param at - Revocation time.
   * @param recorded - Written only when this call revoked (`setup_link.revoked`).
   * @returns The link as revoked, or `null` when it is missing or was revoked already.
   */
  revoke(
    environmentId: string,
    organizationId: string,
    id: string,
    at: Date,
    recorded: Recorded
  ): Promise<SetupLinkRecord | null>

  /**
   * @param environmentId - The environment.
   * @param id - The link.
   * @param at - Use time.
   */
  touch(environmentId: string, id: string, at: Date): Promise<void>

  /**
   * Delete links that expired before a cutoff (retention, ADR 0017), in a batch.
   *
   * @param environmentId - The environment.
   * @param cutoff - Links whose `expiresAt` is before this go.
   * @param limit - The most to delete.
   * @returns How many were deleted.
   */
  deleteExpiredBefore(environmentId: string, cutoff: Date, limit: number): Promise<number>
}
