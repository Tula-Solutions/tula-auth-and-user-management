import { index, integer, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import { tenantColumns, tenantConstraints, tenantForeignKey } from '../tenant-columns'
import { events } from './events'
import { tula } from './pg-schema'
import { webhookEndpoints } from './webhook-endpoints'

/** How a delivery ended: the receiver answered 2xx, or it did not. */
export const WEBHOOK_DELIVERY_OUTCOMES = ['delivered', 'failed'] as const

/**
 * What became of sending one event to one endpoint (ADR 0034). One row per endpoint and event:
 * the unique key is what makes a second worker's insert for the same pair a no-op.
 *
 * **Nothing of the receiver's answer is kept beyond its status code and how long it took**: no
 * header and no body, and there is no column for either. An endpoint's address can name
 * anything the outbound guard lets through; what it answered must not become readable here.
 * `failure_reason` is one of the server's own fixed words (the outbound guard's reason when
 * there was no answer, `signing_failed` when the secret could not be opened,
 * `endpoint_unresponsive` when the endpoint had already timed out in the round), never text from
 * the receiver or the transport.
 *
 * Rows go with their endpoint and with their event (both foreign keys cascade).
 */
export const webhookDeliveries = tula.table(
  'webhook_deliveries',
  {
    id: primaryKey(),
    ...tenantColumns(),
    endpointId: uuid('endpoint_id').notNull(),
    eventId: uuid('event_id').notNull(),
    /**
     * When the request was sent; for a row whose `failure_reason` says nothing was sent
     * (`signing_failed`, `endpoint_unresponsive`, a refusal by the outbound guard), when the
     * worker decided not to.
     */
    attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull(),
    outcome: text('outcome', { enum: WEBHOOK_DELIVERY_OUTCOMES }).notNull(),
    /** The receiver's HTTP status; `null` when there was no answer. */
    statusCode: integer('status_code'),
    /** Milliseconds from sending to the answer, or to giving up. */
    durationMs: integer('duration_ms').notNull(),
    /** Why there was no answer: a fixed word. `null` when the receiver answered. */
    failureReason: text('failure_reason'),
    ...timestamps(),
  },
  (t) => [
    unique('webhook_deliveries_endpoint_event_key').on(t.endpointId, t.eventId),
    // What the worker asks for every batch (the rows of these events), and what the cascade
    // from a deleted event needs: the unique key leads with the endpoint and serves neither.
    index('webhook_deliveries_event_idx').on(t.environmentId, t.eventId),
    tenantForeignKey('webhook_deliveries_endpoint_fk', t, t.endpointId, webhookEndpoints),
    tenantForeignKey('webhook_deliveries_event_fk', t, t.eventId, events),
    ...tenantConstraints('webhook_deliveries', t),
  ]
)

/** A webhook delivery row. */
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect
/** Insert shape for a webhook delivery. */
export type NewWebhookDeliveryRow = typeof webhookDeliveries.$inferInsert
