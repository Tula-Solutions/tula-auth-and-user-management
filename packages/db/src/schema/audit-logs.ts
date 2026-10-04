import { index, inet, jsonb, text, timestamp } from 'drizzle-orm/pg-core'
import { primaryKey } from '../mixins'
import { tenantColumns, tenantConstraints } from '../tenant-columns'
import { tula } from './pg-schema'

/**
 * Who performed an audited action. `agent` tags MCP/AI actions (business plan §4.5);
 * `instance_admin` is the deployment's operator, through the dashboard (ADR 0032).
 */
export const AUDIT_ACTOR_TYPES = ['user', 'admin', 'system', 'agent', 'instance_admin'] as const

/** Append-only record of sensitive and administrative actions. */
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
  ]
)

/** An audit log row. */
export type AuditLog = typeof auditLogs.$inferSelect
/** Insert shape for an audit log row. */
export type NewAuditLog = typeof auditLogs.$inferInsert
