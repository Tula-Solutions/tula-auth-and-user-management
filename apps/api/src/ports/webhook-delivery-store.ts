import type { OutboundFailure } from '~/lib/outbound'

/** An outbox event that no worker has settled yet. */
export interface PendingEvent {
  id: string
  projectId: string
  environmentId: string
  type: string
  /**
   * What was stored when the event was recorded. A row written before the event contract
   * existed has no `schemaVersion`; the worker never sends one.
   */
  payload: Record<string, unknown>
  occurredAt: Date
}

/**
 * Why a delivery got no answer: the outbound guard's word; `signing_failed` when the
 * endpoint's secret could not be opened; or `endpoint_unresponsive` when the endpoint had
 * already let a delivery run out its deadline in the same round. For the last two nothing was
 * sent. Fixed words of the server's own, never text from the receiver or the transport.
 */
export type WebhookFailureReason = OutboundFailure | 'signing_failed' | 'endpoint_unresponsive'

/**
 * What became of sending one event to one endpoint.
 *
 * **There is no field for anything the receiver said beyond its status code.** Its headers and
 * body are never stored: an endpoint's address may lead anywhere the outbound guard allows,
 * and what answers there must not become readable through a delivery record.
 */
export interface WebhookDeliveryRecord {
  id: string
  projectId: string
  environmentId: string
  endpointId: string
  eventId: string
  attemptedAt: Date
  /** `delivered` when the receiver answered 2xx. */
  outcome: 'delivered' | 'failed'
  /** The receiver's HTTP status; `null` when there was no answer. */
  statusCode: number | null
  /** Milliseconds from sending to the answer, or to giving up. */
  durationMs: number
  /** `null` when the receiver answered. */
  failureReason: WebhookFailureReason | null
}

/**
 * What {@link WebhookDeliveryStore.insert} did.
 *
 * - `recorded`: the row was written.
 * - `duplicate`: the endpoint already has a row for the event (another worker's); nothing changed.
 * - `gone`: the endpoint or the event was deleted meanwhile; there is nothing to record.
 */
export type DeliveryInsertOutcome = 'recorded' | 'duplicate' | 'gone'

/**
 * The delivery side of the event outbox: the events that wait, and what became of sending
 * them. Events are written by the stores, with the change they record (`ActivityLog`); here
 * they are only read and marked.
 *
 * None of these writes takes an `Activity`: they change nothing about who can do what, and a
 * delivery row is itself the record of the delivery (ADR 0012).
 */
export interface WebhookDeliveryStore {
  /**
   * @param environmentId - The environment to look in.
   * @param limit - The most events to return.
   * @returns Its events with no `delivered_at`, oldest first.
   */
  pendingEvents(environmentId: string, limit: number): Promise<PendingEvent[]>

  /**
   * @param environmentId - The environment to look in.
   * @param eventIds - The events.
   * @returns Every delivery row of those events, in no particular order.
   */
  listForEvents(
    environmentId: string,
    eventIds: readonly string[]
  ): Promise<WebhookDeliveryRecord[]>

  /**
   * Record what became of sending an event to an endpoint. One row per endpoint and event:
   * a second insert for the same pair changes nothing.
   *
   * @param delivery - The delivery.
   * @returns What happened; see {@link DeliveryInsertOutcome}.
   */
  insert(delivery: WebhookDeliveryRecord): Promise<DeliveryInsertOutcome>

  /**
   * Mark events as settled: every endpoint they had to go to has a delivery row. An event that
   * is already marked keeps its first time.
   *
   * @param environmentId - The environment. No other is touched.
   * @param eventIds - The events.
   * @param at - When they were settled.
   * @returns How many were marked by this call.
   */
  markDelivered(environmentId: string, eventIds: readonly string[], at: Date): Promise<number>
}
