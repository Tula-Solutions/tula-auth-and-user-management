import { integer, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { primaryKey } from '../mixins'
import { tenantColumns, tenantConstraints, tenantForeignKey } from '../tenant-columns'
import { tula } from './pg-schema'
import { webhookDeliveries } from './webhook-deliveries'

/**
 * One request the server made for a webhook delivery (ADR 0034): when, the receiver's status
 * code or `null`, how long it took, and one of the server's fixed words when there was no
 * answer. **There is no column for a header or a body and there must never be one.**
 *
 * Append-only for the runtime role (`SELECT` and `INSERT`, no `UPDATE`, no `DELETE`): the log
 * of what was tried cannot be rewritten. A row goes only with its delivery, by cascade.
 *
 * A row here means a request was attempted. What the worker decided not to send
 * (`endpoint_unresponsive`, `signing_failed`) is a word on the delivery, never a row here.
 */
export const webhookDeliveryAttempts = tula.table(
  'webhook_delivery_attempts',
  {
    id: primaryKey(),
    ...tenantColumns(),
    deliveryId: uuid('delivery_id').notNull(),
    /** 1 for the delivery's first request, counting up. */
    attempt: integer('attempt').notNull(),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull(),
    /** The receiver's HTTP status; `null` when there was no answer. */
    statusCode: integer('status_code'),
    /** Milliseconds from sending to the answer, or to giving up. */
    durationMs: integer('duration_ms').notNull(),
    /** Why there was no answer: a fixed word. `null` when the receiver answered. */
    failureReason: text('failure_reason'),
  },
  (t) => [
    // Also the index the detail view and the cascade from a deleted delivery use.
    unique('webhook_delivery_attempts_delivery_attempt_key').on(t.deliveryId, t.attempt),
    tenantForeignKey('webhook_delivery_attempts_delivery_fk', t, t.deliveryId, webhookDeliveries),
    ...tenantConstraints('webhook_delivery_attempts', t),
  ]
)

/** A webhook delivery attempt row. */
export type WebhookDeliveryAttemptRow = typeof webhookDeliveryAttempts.$inferSelect
/** Insert shape for a webhook delivery attempt. */
export type NewWebhookDeliveryAttemptRow = typeof webhookDeliveryAttempts.$inferInsert
