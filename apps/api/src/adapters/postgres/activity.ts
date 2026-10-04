import { auditLogs, type Database, events, type Transaction, withTenant } from '@tula/db'
import { and, count, desc, eq, gte, lt } from 'drizzle-orm'
import type { Activity, ActivityLog, AuditCriteria, AuditEntry } from '~/ports/activity-log'

/**
 * Rows per insert statement. Postgres allows 65,535 bind parameters per statement and an audit
 * row uses 12, so one statement holds about 5,400 rows; revoking every session of one user can
 * exceed that. The statements still share the caller's transaction.
 */
export const ACTIVITY_INSERT_BATCH = 500

/**
 * Write activity inside the caller's transaction: one outbox event and one audit entry each.
 *
 * Every Postgres store calls this from the same `withTenant` transaction as the change the
 * activity describes, which is what makes the two atomic. If these inserts fail the change is
 * rolled back with them: nothing happens off the record.
 *
 * @param tx - The open, tenant-scoped transaction.
 * @param activities - What to record; an empty list writes nothing.
 */
export async function recordActivity(
  tx: Transaction,
  activities: readonly Activity[]
): Promise<void> {
  for (let start = 0; start < activities.length; start += ACTIVITY_INSERT_BATCH) {
    const batch = activities.slice(start, start + ACTIVITY_INSERT_BATCH)
    await tx.insert(events).values(
      batch.map((activity) => ({
        id: activity.id,
        projectId: activity.projectId,
        environmentId: activity.environmentId,
        type: activity.type,
        // No IP or user agent: the outbox feeds webhooks, which get only what they need.
        payload: { actor: activity.actor, target: activity.target, data: activity.data },
        occurredAt: activity.occurredAt,
      }))
    )
    await tx.insert(auditLogs).values(
      batch.map((activity) => ({
        id: activity.id,
        projectId: activity.projectId,
        environmentId: activity.environmentId,
        actorType: activity.actor.type,
        actorId: activity.actor.id,
        action: activity.type,
        targetType: activity.target.type,
        targetId: activity.target.id,
        ipAddress: activity.ipAddress,
        userAgent: activity.userAgent,
        metadata: activity.data,
        occurredAt: activity.occurredAt,
      }))
    )
  }
}

/** The audit log in Postgres, read inside the environment's RLS scope. */
export class PostgresActivityLog implements ActivityLog {
  /** @param db - Database connected as the runtime role. */
  constructor(private readonly db: Database) {}

  /** @inheritdoc */
  async listAudit(
    environmentId: string,
    criteria: AuditCriteria
  ): Promise<{ entries: AuditEntry[]; totalCount: number }> {
    const where = and(
      eq(auditLogs.environmentId, environmentId),
      criteria.action ? eq(auditLogs.action, criteria.action) : undefined,
      criteria.actorId ? eq(auditLogs.actorId, criteria.actorId) : undefined,
      criteria.targetId ? eq(auditLogs.targetId, criteria.targetId) : undefined,
      criteria.actorType ? eq(auditLogs.actorType, criteria.actorType) : undefined,
      criteria.from ? gte(auditLogs.occurredAt, criteria.from) : undefined,
      criteria.to ? lt(auditLogs.occurredAt, criteria.to) : undefined
    )
    return withTenant(this.db, environmentId, async (tx) => {
      const [total] = await tx.select({ value: count() }).from(auditLogs).where(where)
      const rows = await tx
        .select()
        .from(auditLogs)
        .where(where)
        // The id breaks ties between entries of the same instant, so paging is stable.
        .orderBy(desc(auditLogs.occurredAt), desc(auditLogs.id))
        .limit(criteria.size)
        .offset((criteria.page - 1) * criteria.size)
      return {
        entries: rows.map((row) => ({
          id: row.id,
          projectId: row.projectId,
          environmentId: row.environmentId,
          type: row.action,
          actor: { type: row.actorType, id: row.actorId },
          target:
            row.targetType !== null && row.targetId !== null
              ? { type: row.targetType, id: row.targetId }
              : null,
          ipAddress: row.ipAddress,
          userAgent: row.userAgent,
          data: row.metadata,
          occurredAt: row.occurredAt,
        })),
        totalCount: total?.value ?? 0,
      }
    })
  }
}
