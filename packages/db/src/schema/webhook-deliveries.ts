import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  pgPolicy,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import {
  tenantColumns,
  tenantConstraints,
  tenantForeignKey,
  tenantParentKey,
} from '../tenant-columns'
import { tula } from './pg-schema'
import { webhookEndpoints } from './webhook-endpoints'

/**
 * Where a delivery stands: `pending` (the worker will try it, or try it again), `delivered`
 * (the receiver answered 2xx) or `failed` (given up).
 */
export const WEBHOOK_DELIVERY_STATES = ['pending', 'delivered', 'failed'] as const

/**
 * The youngest delivery row the runtime role can delete, whatever the retention job asks for:
 * the bound the database itself keeps (`webhook_deliveries_retention_floor`). A week is what
 * an operator needs at the least to read last week's failures.
 */
export const WEBHOOK_DELIVERY_RETENTION_FLOOR = '7 days'

/**
 * The delivery of one event to one endpoint (ADR 0034): the unit of work of the webhook worker.
 * One row per endpoint and event (the unique key makes a second worker's insert a no-op); a
 * test event has no event and so no such key.
 *
 * The row says where the delivery stands and how its **latest** step ended; every request that
 * was made for it is a row of `webhook_delivery_attempts`, which is append-only. The runtime
 * role may update this row's state columns and nothing else (not the endpoint, the event, the
 * type, the test flag or `created_at`), and may delete only a row that is no longer `pending`
 * and is older than {@link WEBHOOK_DELIVERY_RETENTION_FLOOR}.
 *
 * **Nothing of the receiver's answer is kept beyond its status code and how long it took**: no
 * header and no body, and there is no column for either, here or on an attempt. An endpoint's
 * address can name anything the outbound guard lets through; what it answered must not become
 * readable here. `failure_reason` is one of the server's own fixed words, never text from the
 * receiver or the transport.
 *
 * `event_id` is **not** a foreign key: a settled event is deleted after its own, shorter
 * retention period and the record of its deliveries is kept longer. It is only ever written by
 * the worker, from an event it read in the same environment, and only ever read back inside
 * that environment. Rows go with their endpoint (that foreign key cascades).
 */
export const webhookDeliveries = tula.table(
  'webhook_deliveries',
  {
    id: primaryKey(),
    ...tenantColumns(),
    endpointId: uuid('endpoint_id').notNull(),
    /** The event, which is the delivery's `webhook-id`. `null` for a test event. */
    eventId: uuid('event_id'),
    /** The event's type, kept here so the log can be filtered once the event is gone. */
    eventType: text('event_type').notNull(),
    /** A test event an administrator asked for: built from an example, never from the outbox. */
    test: boolean('test').notNull().default(false),
    state: text('state', { enum: WEBHOOK_DELIVERY_STATES }).notNull(),
    /** Requests made so far: the number of rows in `webhook_delivery_attempts`. */
    attempts: integer('attempts').notNull().default(0),
    /** When the worker tries next. `null` unless `pending`. */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    /** When the latest request was sent. `null` before the first. */
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    /** The receiver's HTTP status at the latest request; `null` when there was no answer. */
    statusCode: integer('status_code'),
    /**
     * The latest fixed word: why a request got no answer, or why none was made
     * (`endpoint_unresponsive`, `signing_failed`, `expired`, `event_gone`). `null` after an
     * answer.
     */
    failureReason: text('failure_reason'),
    /** When it was delivered or given up. `null` while `pending`. */
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    unique('webhook_deliveries_endpoint_event_key').on(t.endpointId, t.eventId),
    // What the retention job asks before it deletes an event (is a delivery of it still
    // pending?), and what "send it again" reads.
    index('webhook_deliveries_event_idx').on(t.environmentId, t.eventId),
    // What the worker reads every round: one endpoint's due deliveries, the most overdue
    // first. Partial, so it holds only what is still to be done.
    index('webhook_deliveries_due_idx')
      .on(t.environmentId, t.endpointId, t.nextAttemptAt)
      .where(sql`state = 'pending'`),
    // Giving up by age: the pending deliveries of an environment, oldest first.
    index('webhook_deliveries_pending_age_idx')
      .on(t.environmentId, t.createdAt)
      .where(sql`state = 'pending'`),
    // The delivery log of one endpoint, newest first.
    index('webhook_deliveries_endpoint_log_idx').on(t.environmentId, t.endpointId, t.createdAt),
    // The retention job's purge: an environment's rows by age.
    index('webhook_deliveries_environment_created_idx').on(t.environmentId, t.createdAt),
    tenantParentKey('webhook_deliveries', t),
    tenantForeignKey('webhook_deliveries_endpoint_fk', t, t.endpointId, webhookEndpoints),
    ...tenantConstraints('webhook_deliveries', t),
    // Restrictive: ANDed with the tenant policy, so it can only take rows away from a delete.
    // `created_at` is not among the columns the runtime role may update, so a row cannot be
    // aged to get past it. A cascade from a removed endpoint is not subject to it.
    pgPolicy('webhook_deliveries_retention_floor', {
      as: 'restrictive',
      for: 'delete',
      using: sql.raw(
        `state <> 'pending' and created_at < now() - interval '${WEBHOOK_DELIVERY_RETENTION_FLOOR}'`
      ),
    }),
  ]
)

/** A webhook delivery row. */
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect
/** Insert shape for a webhook delivery. */
export type NewWebhookDeliveryRow = typeof webhookDeliveries.$inferInsert
