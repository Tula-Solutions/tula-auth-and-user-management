import { sql } from 'drizzle-orm'
import { index, jsonb, text, timestamp } from 'drizzle-orm/pg-core'
import { primaryKey } from '../mixins'
import { tenantColumns, tenantConstraints } from '../tenant-columns'
import { tula } from './pg-schema'

/**
 * Transactional outbox: auth events are written in the same transaction as the change they
 * describe, then delivered to webhooks and analytics by a worker (Phase 2).
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
    index('events_undelivered_idx').on(t.occurredAt).where(sql`delivered_at is null`),
    ...tenantConstraints('events', t),
  ]
)

/** An event row. */
export type Event = typeof events.$inferSelect
/** Insert shape for an event. */
export type NewEvent = typeof events.$inferInsert
