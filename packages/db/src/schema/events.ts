import { sql } from 'drizzle-orm'
import { index, jsonb, text, timestamp } from 'drizzle-orm/pg-core'
import { primaryKey } from '../mixins'
import { tenantColumns, tenantConstraints, tenantParentKey } from '../tenant-columns'
import { tula } from './pg-schema'

/**
 * Transactional outbox: auth events are written in the same transaction as the change they
 * describe, then delivered to the environment's webhook endpoints by a worker (ADR 0034).
 *
 * `delivered_at` is `null` until the worker has settled the event: every endpoint it had to go
 * to has a row in `webhook_deliveries` (also when there was none to go to).
 */
export const events = tula.table(
  'events',
  {
    id: primaryKey(),
    ...tenantColumns(),
    /** Event type, e.g. `session.created`, `session.reuse_detected`. */
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (t) => [
    // What the worker reads: one environment's unsettled events, oldest first. Leading with
    // the environment keeps an environment with nothing waiting from scanning the others'.
    index('events_environment_undelivered_idx')
      .on(t.environmentId, t.occurredAt, t.id)
      .where(sql`delivered_at is null`),
    tenantParentKey('events', t),
    ...tenantConstraints('events', t),
  ]
)

/** An event row. */
export type Event = typeof events.$inferSelect
/** Insert shape for an event. */
export type NewEvent = typeof events.$inferInsert
