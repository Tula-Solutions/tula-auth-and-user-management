import type {
  ProposalApproverType,
  ProposalFailureReason,
  ProposalOperation,
  ProposalTargetType,
} from '@tula/contract'
import { type Database, proposals, withTenant } from '@tula/db'
import { and, desc, eq, gt, inArray, lt } from 'drizzle-orm'
import { recordActivity } from '~/adapters/postgres/activity'
import { activityOf, type Recorded } from '~/ports/activity-log'
import type {
  ProposalApproval,
  ProposalOutcome,
  ProposalRecord,
  ProposalStore,
} from '~/ports/proposal-store'

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
}

/** A row as the port's record: the words are the server's own, written by it. */
function toRecord(row: typeof proposals.$inferSelect): ProposalRecord {
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
  async insert(record: ProposalRecord, recorded: Recorded): Promise<ProposalRecord> {
    const activity = activityOf(recorded)
    return withTenant(this.db, record.environmentId, async (tx) => {
      const [row] = await tx.insert(proposals).values(record).returning(columns)
      await recordActivity(tx, activity ? [activity] : [])
      // An insert that did not throw returns its row.
      return toRecord(row as typeof proposals.$inferSelect)
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
            gt(proposals.expiresAt, at)
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
