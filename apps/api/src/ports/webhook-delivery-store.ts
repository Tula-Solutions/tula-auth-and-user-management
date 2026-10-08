import type { OutboundFailure } from '~/lib/outbound'

/** An event of the outbox, as stored. */
export interface OutboxEvent {
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

/** Where a delivery stands. `pending` is the only state the worker acts on. */
export type WebhookDeliveryState = 'pending' | 'delivered' | 'failed'

/**
 * The fixed word of a delivery's latest step. Never text from the receiver or the transport.
 *
 * The outbound guard's words belong to a request that was attempted. The other four mean **no
 * request was made**, and are never the word of an attempt:
 *
 * - `signing_failed`: the endpoint's secret could not be opened (the server's fault);
 * - `endpoint_unresponsive`: the endpoint had just let another delivery run out its deadline;
 * - `expired`: the delivery waited longer than the worker keeps trying;
 * - `event_gone`: the event's row no longer exists.
 */
export type WebhookFailureReason =
  | OutboundFailure
  | 'signing_failed'
  | 'endpoint_unresponsive'
  | 'expired'
  | 'event_gone'

/**
 * The delivery of one event to one endpoint: where it stands and how its latest step ended.
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
  /** The event; `null` for a test event, which has none. */
  eventId: string | null
  eventType: string
  /** A test event an administrator asked for. */
  test: boolean
  state: WebhookDeliveryState
  /** Requests made so far: the number of its {@link WebhookAttemptRecord}s. */
  attempts: number
  /** When the worker tries next; `null` unless `pending`. */
  nextAttemptAt: Date | null
  lastAttemptAt: Date | null
  /** The receiver's HTTP status at the latest request; `null` when there was no answer. */
  statusCode: number | null
  failureReason: WebhookFailureReason | null
  /** When it was delivered or given up; `null` while `pending`. */
  completedAt: Date | null
  createdAt: Date
}

/** One request made for a delivery. Append-only: nothing changes or removes one. */
export interface WebhookAttemptRecord {
  id: string
  /** 1 for the delivery's first request, counting up. */
  attempt: number
  attemptedAt: Date
  /** The receiver's HTTP status; `null` when there was no answer. */
  statusCode: number | null
  /** Milliseconds from sending to the answer, or to giving up. */
  durationMs: number
  /** The outbound guard's word when there was no answer; `null` when the receiver answered. */
  failureReason: OutboundFailure | null
}

/** A delivery to queue: what {@link WebhookDeliveryStore.enqueue} needs of it. */
export interface NewWebhookDelivery {
  id: string
  projectId: string
  environmentId: string
  endpointId: string
  eventId: string
  eventType: string
  /** When it is queued: its `created_at` and its first `next_attempt_at`. */
  at: Date
}

/** A request that was made, as {@link WebhookDeliveryStore.recordAttempt} is given it. */
export type NewWebhookAttempt = Omit<WebhookAttemptRecord, 'attempt'>

/** Where a delivery goes after a request. */
export interface DeliveryTransition {
  state: WebhookDeliveryState
  /** Set for `pending`, `null` otherwise. */
  nextAttemptAt: Date | null
  /** Set for `delivered` and `failed`, `null` for `pending`. */
  completedAt: Date | null
}

/** The filters and the page of {@link WebhookDeliveryStore.list}. */
export interface DeliveryListQuery {
  state?: WebhookDeliveryState
  eventType?: string
  /** 1-based. */
  page: number
  perPage: number
  /**
   * The most rows the count looks at: `totalCount` is the number of matches or this, whichever
   * is smaller. A log can hold millions of rows; a count of all of them is never asked for.
   */
  maxCount: number
}

/**
 * The delivery side of the event outbox: the events that wait, the deliveries they turn into,
 * and every request made for one. Events are written by the stores, with the change they
 * record (`ActivityLog`); here they are read, marked settled and, long after, deleted.
 *
 * None of these writes takes an `Activity`: they change nothing about who can do what, and a
 * delivery with its attempts is itself the record of the delivery (ADR 0012).
 */
export interface WebhookDeliveryStore {
  /**
   * @param environmentId - The environment to look in.
   * @param limit - The most events to return.
   * @returns Its events with no `delivered_at`, oldest first.
   */
  pendingEvents(environmentId: string, limit: number): Promise<OutboxEvent[]>

  /**
   * @param environmentId - The environment to look in. No other is read.
   * @param eventIds - The events.
   * @returns Those of them that still exist, settled or not, in no particular order.
   */
  eventsById(environmentId: string, eventIds: readonly string[]): Promise<OutboxEvent[]>

  /**
   * Queue deliveries: one `pending` row each, due at once, with no attempt made. One row per
   * endpoint and event: a delivery that already has a row is left as it is, and one whose
   * endpoint was removed meanwhile is not written.
   *
   * @param deliveries - The deliveries, all of one environment.
   * @returns How many rows were written.
   */
  enqueue(deliveries: readonly NewWebhookDelivery[]): Promise<number>

  /**
   * Mark events as settled: every endpoint they are owed to has a delivery row. An event that
   * is already marked keeps its first time.
   *
   * @param environmentId - The environment. No other is touched.
   * @param eventIds - The events.
   * @param at - When they were settled.
   * @returns How many were marked by this call.
   */
  markDelivered(environmentId: string, eventIds: readonly string[], at: Date): Promise<number>

  /**
   * Mark one batch of an environment's waiting events as settled without reading them: the
   * oldest ones that happened **before** `before`. For events the worker knows are owed to
   * nobody (they happened before any endpoint that is on was registered), so that a long
   * outbox does not have to be walked a hundred events at a time.
   *
   * @param environmentId - The environment. No other is touched.
   * @param before - Events that occurred before this instant are marked; one at it is kept.
   * @param at - When they were settled.
   * @param limit - The most events one call marks.
   * @returns How many were marked.
   */
  settleBefore(environmentId: string, before: Date, at: Date, limit: number): Promise<number>

  /**
   * @param environmentId - The environment to look in.
   * @param endpointId - The endpoint.
   * @param now - Deliveries whose next attempt is at or before this instant are due.
   * @param limit - The most deliveries to return.
   * @returns The endpoint's `pending` deliveries that are due, the most overdue first.
   */
  due(
    environmentId: string,
    endpointId: string,
    now: Date,
    limit: number
  ): Promise<WebhookDeliveryRecord[]>

  /**
   * Record a request that was made for a delivery, and where the delivery goes next, in one
   * transaction: the attempt's number is the delivery's count plus one, taken under the row's
   * lock, so two writers never record the same number and the count is never off.
   *
   * @param environmentId - The environment.
   * @param deliveryId - The delivery.
   * @param attempt - The request: when, the status or the guard's word, how long.
   * @param next - Where the delivery goes. `null` leaves its state as it is (a request made on
   *   demand that failed changes nothing about a delivery that had already ended).
   * @param from - `pending`: only if the delivery is still pending (the worker's request).
   *   `ended`: only if it is not (a request made on demand).
   * @returns The attempt's number, or `null` when the delivery is gone or not in that state:
   *   then nothing was written.
   */
  recordAttempt(
    environmentId: string,
    deliveryId: string,
    attempt: NewWebhookAttempt,
    next: DeliveryTransition | null,
    from: 'pending' | 'ended'
  ): Promise<number | null>

  /**
   * Record a test event: a delivery that never was pending, flagged as a test, with the one
   * request made for it (or none, when nothing could be sent).
   *
   * @param delivery - The delivery, already `delivered` or `failed`.
   * @param attempt - The request, or `null` when none was made.
   * @returns `false` when the endpoint was removed meanwhile: nothing was written.
   */
  recordTest(delivery: WebhookDeliveryRecord, attempt: NewWebhookAttempt | null): Promise<boolean>

  /**
   * Put off deliveries **without a request having been made**: they stay `pending`, their count
   * of attempts does not move and no attempt is recorded. Only deliveries that are still
   * pending are touched.
   *
   * @param environmentId - The environment. No other is touched.
   * @param deliveryIds - The deliveries.
   * @param reason - Why nothing was sent.
   * @param nextAttemptAt - When to try.
   * @param at - When this was decided.
   * @returns How many were put off.
   */
  defer(
    environmentId: string,
    deliveryIds: readonly string[],
    reason: WebhookFailureReason,
    nextAttemptAt: Date,
    at: Date
  ): Promise<number>

  /**
   * Give up deliveries **without a request having been made**: `pending` becomes `failed`.
   *
   * @param environmentId - The environment. No other is touched.
   * @param deliveryIds - The deliveries.
   * @param reason - Why.
   * @param at - When.
   * @returns How many were given up.
   */
  giveUp(
    environmentId: string,
    deliveryIds: readonly string[],
    reason: WebhookFailureReason,
    at: Date
  ): Promise<number>

  /**
   * Give up one batch of an environment's deliveries that have waited too long: `pending` and
   * created before `createdBefore`, whatever their endpoint is doing, the oldest first. Their
   * word becomes `expired`.
   *
   * @param environmentId - The environment. No other is touched.
   * @param createdBefore - Deliveries queued before this instant are given up; one at it is kept.
   * @param at - When.
   * @param limit - The most deliveries one call gives up.
   * @returns How many were given up.
   */
  expire(environmentId: string, createdBefore: Date, at: Date, limit: number): Promise<number>

  /**
   * @param environmentId - The environment to look in.
   * @param endpointId - The endpoint.
   * @param query - Filters and the page.
   * @returns One page of the endpoint's deliveries, newest first, and how many match, counted
   *   no further than `query.maxCount`.
   */
  list(
    environmentId: string,
    endpointId: string,
    query: DeliveryListQuery
  ): Promise<{ deliveries: WebhookDeliveryRecord[]; totalCount: number }>

  /**
   * @param environmentId - The environment to look in.
   * @param endpointId - The endpoint the delivery must be of.
   * @param id - The delivery.
   * @returns The delivery and its attempts, oldest first; `null` when that endpoint of that
   *   environment has no such delivery.
   */
  find(
    environmentId: string,
    endpointId: string,
    id: string
  ): Promise<{ delivery: WebhookDeliveryRecord; attempts: WebhookAttemptRecord[] } | null>

  /**
   * Delete one batch of an environment's events that were settled before `before`, the oldest
   * first. An event that a delivery still `pending` is of is kept: it is what will be sent.
   *
   * @param environmentId - The environment. No other is touched.
   * @param before - Events settled before this instant go; one settled at it is kept.
   * @param limit - The most events one call deletes.
   * @returns How many were deleted.
   */
  deleteSettledEvents(environmentId: string, before: Date, limit: number): Promise<number>

  /**
   * Delete one batch of an environment's deliveries that are no longer `pending` and were
   * queued before `before`, with their attempts, the oldest first.
   *
   * @param environmentId - The environment. No other is touched.
   * @param before - Deliveries queued before this instant go; one at it is kept.
   * @param limit - The most deliveries one call deletes.
   * @returns How many were deleted.
   */
  deleteEndedBefore(environmentId: string, before: Date, limit: number): Promise<number>
}
