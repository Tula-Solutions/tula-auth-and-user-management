import type {
  ProposalApproverType,
  ProposalFailureReason,
  ProposalOperation,
  ProposalTargetType,
} from '@tula/contract'
import { apiKeys, type Database, proposals, withTenant } from '@tula/db'
import { and, desc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm'
import { recordActivity } from '~/adapters/postgres/activity'
import { activityOf, type Recorded } from '~/ports/activity-log'
import type {
  NewProposalRecord,
  ProposalApproval,
  ProposalOutcome,
  ProposalRecord,
  ProposalStore,
} from '~/ports/proposal-store'

/**
 * "The key that asked is an unrevoked agent key of the proposal's own environment", as SQL
 * over the proposal's row. `api_keys` has no row-level security, so the environment is in the
 * condition itself. One expression for the reads and for the approval's own condition: what
 * a read says can be approved is what the write will approve.
 *
 * Every column is written with its table: Drizzle renders a bare column name inside an
 * `INSERT` or an `UPDATE`, and a bare `environment_id` in this subquery would be the key's
 * own, which makes the comparison true for a key of any environment. The shared suite has
 * the test (a proposal that names another environment's agent key).
 */
const proposerActive = sql<boolean>`exists (
  select 1 from ${apiKeys} as k
  where k.id = ${proposals}.proposed_by
    and k.environment_id = ${proposals}.environment_id
    and k.kind = 'agent'
    and k.revoked_at is null
)`

const columns = {
  id: proposals.id,
  projectId: proposals.projectId,
  environmentId: proposals.environmentId,
  operation: proposals.operation,
  targetType: proposals.targetType,
  targetId: proposals.targetId,
  proposedBy: proposals.proposedBy,
  status: proposals.status,
  expiresAt: proposals.expiresAt,
  approvedByType: proposals.approvedByType,
  approvedById: proposals.approvedById,
  approvedAt: proposals.approvedAt,
  failureReason: proposals.failureReason,
  createdAt: proposals.createdAt,
  updatedAt: proposals.updatedAt,
  proposerActive,
}

/** A row as the port's record: the words are the server's own, written by it. */
function toRecord(
  row: typeof proposals.$inferSelect & { proposerActive: boolean }
): ProposalRecord {
  return {
    ...row,
    operation: row.operation as ProposalOperation,
    targetType: row.targetType as ProposalTargetType,
    approvedByType: row.approvedByType as ProposalApproverType | null,
    failureReason: row.failureReason as ProposalFailureReason | null,
  }
}

/** Proposals in Postgres, behind row-level security. */
export class PostgresProposalStore implements ProposalStore {
  /** @param db - Database connected as the runtime role. */
  constructor(private readonly db: Database) {}

  /** @inheritdoc */
  async list(environmentId: string, limit: number): Promise<ProposalRecord[]> {
    const rows = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select(columns)
        .from(proposals)
        .where(eq(proposals.environmentId, environmentId))
        // The id breaks ties between proposals of the same instant, so the order is stable.
        .orderBy(desc(proposals.createdAt), desc(proposals.id))
        .limit(limit)
    )
    return rows.map(toRecord)
  }

  /** @inheritdoc */
  async find(environmentId: string, id: string): Promise<ProposalRecord | null> {
    const [row] = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select(columns)
        .from(proposals)
        .where(and(eq(proposals.environmentId, environmentId), eq(proposals.id, id)))
        .limit(1)
    )
    return row ? toRecord(row) : null
  }

  /** @inheritdoc */
  async findPending(
    environmentId: string,
    like: Pick<ProposalRecord, 'operation' | 'targetType' | 'targetId' | 'proposedBy'>,
    at: Date
  ): Promise<ProposalRecord | null> {
    const [row] = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select(columns)
        .from(proposals)
        .where(
          and(
            eq(proposals.environmentId, environmentId),
            eq(proposals.status, 'pending'),
            gt(proposals.expiresAt, at),
            eq(proposals.operation, like.operation),
            eq(proposals.targetType, like.targetType),
            eq(proposals.targetId, like.targetId),
            eq(proposals.proposedBy, like.proposedBy)
          )
        )
        .orderBy(desc(proposals.createdAt), desc(proposals.id))
        .limit(1)
    )
    return row ? toRecord(row) : null
  }

  /** @inheritdoc */
  async insert(record: NewProposalRecord, recorded: Recorded): Promise<ProposalRecord> {
    const activity = activityOf(recorded)
    return withTenant(this.db, record.environmentId, async (tx) => {
      const [row] = await tx.insert(proposals).values(record).returning(columns)
      await recordActivity(tx, activity ? [activity] : [])
      // An insert that did not throw returns its row.
      return toRecord(row as typeof proposals.$inferSelect & { proposerActive: boolean })
    })
  }

  /** @inheritdoc */
  async approve(
    environmentId: string,
    id: string,
    approval: ProposalApproval,
    at: Date,
    recorded: Recorded
  ): Promise<ProposalRecord | null> {
    const activity = activityOf(recorded)
    return withTenant(this.db, environmentId, async (tx) => {
      // The agent key's row is locked for the length of this transaction, so a revocation
      // cannot land between the condition below and the commit: one that is already under
      // way is waited for and then seen (the statement that follows reads after it), and
      // one that comes later waits for this approval. `proposed_by` never changes, so the
      // key locked here is the key the condition reads.
      await tx
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.environmentId, environmentId),
            eq(
              apiKeys.id,
              tx
                .select({ id: proposals.proposedBy })
                .from(proposals)
                .where(and(eq(proposals.environmentId, environmentId), eq(proposals.id, id)))
            ),
            isNull(apiKeys.revokedAt)
          )
        )
        .for('share')
      const [row] = await tx
        .update(proposals)
        .set({
          status: 'approved',
          approvedByType: approval.type,
          approvedById: approval.id,
          approvedAt: at,
          updatedAt: at,
        })
        .where(
          and(
            eq(proposals.environmentId, environmentId),
            eq(proposals.id, id),
            // The compare of the compare-and-set: in the statement itself, so it is judged
            // against the row as it is when the write takes its lock. Of two approvals at
            // once the second finds the row no longer pending and writes nothing.
            eq(proposals.status, 'pending'),
            gt(proposals.expiresAt, at),
            // And the key that asked is still an agent key. In the statement, not before
            // it: what a revoked key asked for is never approved (ADR 0053).
            proposerActive
          )
        )
        .returning(columns)
      await recordActivity(tx, row && activity ? [activity] : [])
      return row ? toRecord(row) : null
    })
  }

  /** @inheritdoc */
  async finish(
    environmentId: string,
    id: string,
    outcome: ProposalOutcome,
    at: Date,
    recorded: Recorded
  ): Promise<ProposalRecord | null> {
    const activity = activityOf(recorded)
    return withTenant(this.db, environmentId, async (tx) => {
      const [row] = await tx
        .update(proposals)
        .set({
          status: outcome.status,
          failureReason: outcome.status === 'failed' ? outcome.reason : null,
          updatedAt: at,
        })
        .where(
          and(
            eq(proposals.environmentId, environmentId),
            eq(proposals.id, id),
            eq(proposals.status, 'approved')
          )
        )
        .returning(columns)
      await recordActivity(tx, row && activity ? [activity] : [])
      return row ? toRecord(row) : null
    })
  }

  /** @inheritdoc */
  async deleteExpiredBefore(environmentId: string, cutoff: Date, limit: number): Promise<number> {
    const rows = await withTenant(this.db, environmentId, (tx) =>
      tx
        .delete(proposals)
        .where(
          and(
            eq(proposals.environmentId, environmentId),
            // DELETE has no LIMIT in Postgres: pick the batch in a subquery.
            inArray(
              proposals.id,
              tx
                .select({ id: proposals.id })
                .from(proposals)
                .where(
                  and(eq(proposals.environmentId, environmentId), lt(proposals.expiresAt, cutoff))
                )
                .limit(limit)
            )
          )
        )
        .returning({ id: proposals.id })
    )
    return rows.length
  }
}
