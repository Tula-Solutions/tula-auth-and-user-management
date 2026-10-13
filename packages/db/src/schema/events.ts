import { sql } from 'drizzle-orm'
import { index, jsonb, pgPolicy, text, timestamp } from 'drizzle-orm/pg-core'
import { primaryKey } from '../mixins'
import { tenantColumns, tenantConstraints, tenantParentKey } from '../tenant-columns'
import { tula } from './pg-schema'

/**
 * The youngest event the runtime role can delete, whatever the retention job asks for: the
 * bound the database itself keeps (`events_retention_floor`).
 */
export const EVENT_RETENTION_FLOOR = '1 day'

/**
 * Transactional outbox: auth events are written in the same transaction as the change they
 * describe, then delivered to the environment's webhook endpoints by a worker (ADR 0034).
 *
 * `delivered_at` is `null` until the worker has **settled** the event: every endpoint it is
 * owed to has a row in `webhook_deliveries` (also when there was none to go to). Settled is
 * not "received": the delivery rows carry that, each with its own retries.
 *
 * The runtime role may insert an event, set `delivered_at` (the one column it may update) and
 * delete an event that is settled and older than {@link EVENT_RETENTION_FLOOR}: the retention
 * job's purge (ADR 0017).
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
    // The retention job's purge: one environment's settled events, oldest first.
    index('events_environment_delivered_idx')
      .on(t.environmentId, t.deliveredAt)
      .where(sql`delivered_at is not null`),
    tenantParentKey('events', t),
    ...tenantConstraints('events', t),
    // Restrictive: ANDed with the tenant policy, so it can only take rows away from a delete.
    // An event that no worker has settled is never deleted, and `occurred_at` is not a column
    // the runtime role may update, so an event cannot be aged to get past the floor.
    pgPolicy('events_retention_floor', {
      as: 'restrictive',
      for: 'delete',
      using: sql.raw(
        `delivered_at is not null and occurred_at < now() - interval '${EVENT_RETENTION_FLOOR}'`
      ),
    }),
  ]
)

/** An event row. */
export type Event = typeof events.$inferSelect
/** Insert shape for an event. */
export type NewEvent = typeof events.$inferInsert
