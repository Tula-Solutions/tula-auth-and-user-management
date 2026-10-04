import { index, inet, jsonb, text, timestamp } from 'drizzle-orm/pg-core'
import { primaryKey } from '../mixins'
import { AUDIT_ACTOR_TYPES } from './audit-logs'
import { tula } from './pg-schema'

/**
 * Append-only record of what the deployment's operator did outside any one environment:
 * dashboard sign-ins (and failures), and changes to workspaces, projects and environments
 * (ADR 0032).
 *
 * Control plane, like `workspaces`: no tenant columns and no row-level security, because the
 * actions it records are not one environment's. The runtime role may only read and insert.
 */
export const instanceAuditLogs = tula.table(
  'instance_audit_logs',
  {
    id: primaryKey(),
    actorType: text('actor_type', { enum: AUDIT_ACTOR_TYPES }).notNull(),
    actorId: text('actor_id'),
    /** Action name, e.g. `instance.signed_in`, `project.created`. */
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('instance_audit_logs_occurred_idx').on(t.occurredAt)]
)

/** An instance audit log row. */
export type InstanceAuditLog = typeof instanceAuditLogs.$inferSelect
/** Insert shape for an instance audit log row. */
export type NewInstanceAuditLog = typeof instanceAuditLogs.$inferInsert
