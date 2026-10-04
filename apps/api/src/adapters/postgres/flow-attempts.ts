import type { FlowKind, FlowStatus } from '@tula/contract'
import { type Database, flowAttempts, withTenant } from '@tula/db'
import { and, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm'
import type {
  FlowAttemptChange,
  FlowAttemptRecord,
  FlowAttemptStore,
  NewFlowAttempt,
  StateGuard,
} from '~/ports/flow-attempt-store'

const columns = {
  id: flowAttempts.id,
  projectId: flowAttempts.projectId,
  environmentId: flowAttempts.environmentId,
  kind: flowAttempts.kind,
  status: flowAttempts.status,
  userId: flowAttempts.userId,
  identifier: flowAttempts.identifier,
  secretHash: flowAttempts.secretHash,
  state: flowAttempts.state,
  expiresAt: flowAttempts.expiresAt,
  completedAt: flowAttempts.completedAt,
  createdAt: flowAttempts.createdAt,
}

/**
 * Flow attempts in `tula.flow_attempts`, inside the environment's RLS scope.
 *
 * RLS already hides other environments' rows; the explicit `environment_id` filters are defence
 * in depth.
 */
export class PostgresFlowAttemptStore implements FlowAttemptStore {
  /** @param db - Database connected as the runtime role. */
  constructor(private readonly db: Database) {}

  /** @inheritdoc */
  async create(attempt: NewFlowAttempt): Promise<void> {
    await withTenant(this.db, attempt.environmentId, (tx) =>
      tx.insert(flowAttempts).values({ ...attempt, updatedAt: attempt.createdAt })
    )
  }

  /** @inheritdoc */
  async findById(environmentId: string, id: string): Promise<FlowAttemptRecord | null> {
    const [row] = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select(columns)
        .from(flowAttempts)
        .where(and(eq(flowAttempts.id, id), eq(flowAttempts.environmentId, environmentId)))
        .limit(1)
    )
    // `status` is free text in the schema; only this adapter and the flow service write it.
    return row ? { ...row, kind: row.kind as FlowKind, status: row.status as FlowStatus } : null
  }

  /** @inheritdoc */
  async transition(
    environmentId: string,
    id: string,
    from: FlowStatus,
    change: FlowAttemptChange,
    at: Date,
    guard?: StateGuard
  ): Promise<boolean> {
    // One guarded UPDATE: the row lock makes concurrent transitions from one step exclusive.
    const rows = await withTenant(this.db, environmentId, (tx) =>
      tx
        .update(flowAttempts)
        .set({
          status: change.status,
          ...(change.userId !== undefined && { userId: change.userId }),
          ...(change.state !== undefined && { state: change.state }),
          ...(change.secretHash !== undefined && { secretHash: change.secretHash }),
          completedAt: change.completedAt ?? null,
          updatedAt: at,
        })
        .where(
          and(
            eq(flowAttempts.id, id),
            eq(flowAttempts.environmentId, environmentId),
            eq(flowAttempts.status, from),
            isNull(flowAttempts.completedAt),
            gt(flowAttempts.expiresAt, at),
            guard ? sql`${flowAttempts.state}->>${guard.key} = ${guard.value}` : undefined
          )
        )
        .returning({ id: flowAttempts.id })
    )
    return rows.length === 1
  }

  /** @inheritdoc */
  async delete(environmentId: string, id: string): Promise<void> {
    await withTenant(this.db, environmentId, (tx) =>
      tx
        .delete(flowAttempts)
        .where(and(eq(flowAttempts.id, id), eq(flowAttempts.environmentId, environmentId)))
    )
  }

  /** @inheritdoc */
  async deleteExpired(environmentId: string, now: Date, limit: number): Promise<number> {
    const rows = await withTenant(this.db, environmentId, (tx) =>
      tx
        .delete(flowAttempts)
        .where(
          and(
            eq(flowAttempts.environmentId, environmentId),
            // DELETE has no LIMIT in Postgres: pick the batch in a subquery.
            inArray(
              flowAttempts.id,
              tx
                .select({ id: flowAttempts.id })
                .from(flowAttempts)
                .where(
                  and(
                    eq(flowAttempts.environmentId, environmentId),
                    lte(flowAttempts.expiresAt, now)
                  )
                )
                .limit(limit)
            )
          )
        )
        .returning({ id: flowAttempts.id })
    )
    return rows.length
  }
}
