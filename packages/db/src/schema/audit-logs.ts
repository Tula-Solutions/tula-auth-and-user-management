import { sql } from 'drizzle-orm'
import { index, inet, jsonb, pgPolicy, text, timestamp } from 'drizzle-orm/pg-core'
import { primaryKey } from '../mixins'
import { tenantColumns, tenantConstraints } from '../tenant-columns'
import { tula } from './pg-schema'

/**
 * Who performed an audited action. `agent` tags MCP/AI actions (business plan §4.5);
 * `instance_admin` is the deployment's operator, through the dashboard (ADR 0032).
 */
export const AUDIT_ACTOR_TYPES = ['user', 'admin', 'system', 'agent', 'instance_admin'] as const

/**
 * The youngest entry the runtime role may delete, as a Postgres interval: the shortest audit
 * retention period an environment can set (`audit.retentionDays` is at least 1 in
 * `@tula/contract`). The retention job never asks for less; the policy below is what holds it
 * to that if the job, or anything else running as the runtime role, ever does.
 */
export const AUDIT_RETENTION_FLOOR = '1 day'

/**
 * Record of sensitive and administrative actions.
 *
 * An entry is never changed: the runtime role has no `UPDATE`. It is deleted only by the
 * retention job, once it is older than the environment's `audit.retentionDays` (ADR 0012,
 * ADR 0017), and row-level security bounds that delete twice over: the tenant policy to the
 * environment in scope, and `audit_logs_retention_floor` to entries older than
 * {@link AUDIT_RETENTION_FLOOR}.
 */
export const auditLogs = tula.table(
  'audit_logs',
  {
    id: primaryKey(),
    ...tenantColumns(),
    actorType: text('actor_type', { enum: AUDIT_ACTOR_TYPES }).notNull(),
    actorId: text('actor_id'),
    /** Action name, e.g. `user.banned`, `api_key.revoked`. */
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_logs_environment_occurred_idx').on(t.environmentId, t.occurredAt),
    // One per filter of the audit list ("what happened to X", "what did Y do"), newest first.
    index('audit_logs_environment_target_idx').on(t.environmentId, t.targetId, t.occurredAt),
    index('audit_logs_environment_actor_idx').on(t.environmentId, t.actorId, t.occurredAt),
    ...tenantConstraints('audit_logs', t),
    // Restrictive: ANDed with the tenant policy, so it can only take rows away from a delete.
    // With no `UPDATE` grant an entry's time cannot be moved to get past it either.
    pgPolicy('audit_logs_retention_floor', {
      as: 'restrictive',
      for: 'delete',
      using: sql.raw(`occurred_at < now() - interval '${AUDIT_RETENTION_FLOOR}'`),
    }),
  ]
)

/** An audit log row. */
export type AuditLog = typeof auditLogs.$inferSelect
/** Insert shape for an audit log row. */
export type NewAuditLog = typeof auditLogs.$inferInsert
