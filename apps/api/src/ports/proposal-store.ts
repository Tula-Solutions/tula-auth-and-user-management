import type {
  ProposalApproverType,
  ProposalFailureReason,
  ProposalOperation,
  ProposalTargetType,
} from '@tula/contract'
import type { Recorded } from '~/ports/activity-log'

/** What a stored proposal's `status` can be. "Expired" is not stored: it is read from `expiresAt`. */
export type StoredProposalStatus = 'pending' | 'approved' | 'executed' | 'failed'

/** A proposal as stored (ADR 0053): what an agent asked for, and what became of it. */
export interface ProposalRecord {
  id: string
  projectId: string
  environmentId: string
  /** What approving it does. Never changes. */
  operation: ProposalOperation
  /** The kind of thing it acts on. Never changes. */
  targetType: ProposalTargetType
  /** The id of what it acts on. Never changes. */
  targetId: string
  /** The agent key that asked. Never changes. */
  proposedBy: string
  status: StoredProposalStatus
  /** A pending proposal can be approved strictly before this instant. Never changes. */
  expiresAt: Date
  /** The kind of credential that approved; `null` while pending. */
  approvedByType: ProposalApproverType | null
  /** The approving secret key's id or dashboard session's; `null` while pending. */
  approvedById: string | null
  approvedAt: Date | null
  /** Set exactly for `failed`. */
  failureReason: ProposalFailureReason | null
  createdAt: Date
  updatedAt: Date
  /**
   * Whether the key that asked (`proposedBy`) is, as the row was read, an unrevoked agent
   * key of the proposal's own environment. **Read with the row, never stored**: revoking an
   * agent key is the one write that ends everything it asked for and nobody has approved
   * (ADR 0053). `false` also for a key that is gone, of another kind or of another
   * environment.
   */
  proposerActive: boolean
}

/** A proposal as it is handed to {@link ProposalStore.insert}: everything that is stored. */
export type NewProposalRecord = Omit<ProposalRecord, 'proposerActive'>

/** Who approves: the kind of credential and its id. */
export interface ProposalApproval {
  type: ProposalApproverType
  id: string | null
}

/** How an approved proposal's operation ended. */
export type ProposalOutcome =
  | { status: 'executed' }
  | { status: 'failed'; reason: ProposalFailureReason }

/**
 * Proposals, always read and written inside one environment.
 *
 * There is no method that changes what a proposal would do, to what, who asked or until when:
 * what a human approves is what was proposed.
 */
export interface ProposalStore {
  /**
   * @param environmentId - The environment to look in.
   * @param limit - The most proposals to return.
   * @returns Its proposals, newest first.
   */
  list(environmentId: string, limit: number): Promise<ProposalRecord[]>

  /**
   * @param environmentId - The environment to look in.
   * @param id - The proposal.
   * @returns The proposal, or `null` when the environment has none with that id.
   */
  find(environmentId: string, id: string): Promise<ProposalRecord | null>

  /**
   * The proposal an agent key already has waiting for the same operation on the same target.
   *
   * @param environmentId - The environment to look in.
   * @param like - The operation, the target and the agent key that asked.
   * @param at - Now: a proposal that has expired is not waiting.
   * @returns The newest such proposal that is pending and not expired, or `null`.
   */
  findPending(
    environmentId: string,
    like: Pick<ProposalRecord, 'operation' | 'targetType' | 'targetId' | 'proposedBy'>,
    at: Date
  ): Promise<ProposalRecord | null>

  /**
   * Store a new proposal. Nothing else happens.
   *
   * @param record - The proposal, `pending`.
   * @param activity - Recorded in the same transaction.
   * @returns The row as stored.
   */
  insert(record: NewProposalRecord, activity: Recorded): Promise<ProposalRecord>

  /**
   * Approve a proposal, **only if it is still pending, has not expired, and the key that
   * asked is still an unrevoked agent key of the environment**. This is what makes a
   * proposal single use: of two approvals at once one is written.
   *
   * The condition on the key is part of the write, not a look before it: a revocation that
   * lands between a caller's own check and this call must not leave an approved proposal of
   * a revoked key. An adapter holds the key against a concurrent revocation while it writes
   * (Postgres: the key's row is locked `FOR SHARE` in the same transaction), so an approval
   * that is written was written before the revocation, and one that comes after is refused.
   *
   * @param environmentId - The environment. A proposal of another is not touched.
   * @param id - The proposal.
   * @param approval - Who approves.
   * @param at - When: the proposal must expire strictly after it.
   * @param activity - Recorded in the same transaction, only if the row was written.
   * @returns The proposal as it is now, or `null` when nothing was written: it is not this
   *   environment's, it was approved before, it has expired, or its agent key is revoked or
   *   gone.
   */
  approve(
    environmentId: string,
    id: string,
    approval: ProposalApproval,
    at: Date,
    activity: Recorded
  ): Promise<ProposalRecord | null>

  /**
   * Record how an approved proposal's operation ended, **only if it is still `approved`**.
   *
   * @param environmentId - The environment. A proposal of another is not touched.
   * @param id - The proposal.
   * @param outcome - Carried out, or not and why.
   * @param at - When.
   * @param activity - Recorded in the same transaction, only if the row was written.
   * @returns The proposal as it is now, or `null` when nothing was written.
   */
  finish(
    environmentId: string,
    id: string,
    outcome: ProposalOutcome,
    at: Date,
    activity: Recorded
  ): Promise<ProposalRecord | null>

  /**
   * Delete proposals whose expiry is long past, whatever became of them (the retention job,
   * ADR 0017). The audit log keeps what was proposed, approved and done.
   *
   * @param environmentId - The environment. Another's rows are not touched.
   * @param cutoff - Rows that expired strictly before this are deleted.
   * @param limit - The most rows to delete in this call.
   * @returns How many were deleted.
   */
  deleteExpiredBefore(environmentId: string, cutoff: Date, limit: number): Promise<number>
}
