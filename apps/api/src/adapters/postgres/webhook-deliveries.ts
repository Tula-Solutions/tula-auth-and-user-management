import {
  type Database,
  events,
  webhookDeliveries,
  webhookDeliveryAttempts,
  withTenant,
} from '@tula/db'
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notExists,
  sql,
} from 'drizzle-orm'
import { isForeignKeyViolation } from '~/adapters/postgres/errors'
import type { OutboundFailure } from '~/lib/outbound'
import type {
  DeliveryListQuery,
  DeliveryTransition,
  NewWebhookAttempt,
  NewWebhookDelivery,
  OutboxEvent,
  WebhookAttemptRecord,
  WebhookDeliveryRecord,
  WebhookDeliveryStore,
  WebhookFailureReason,
} from '~/ports/webhook-delivery-store'

const eventColumns = {
  id: events.id,
  projectId: events.projectId,
  environmentId: events.environmentId,
  type: events.type,
  payload: events.payload,
  occurredAt: events.occurredAt,
}

const deliveryColumns = {
  id: webhookDeliveries.id,
  projectId: webhookDeliveries.projectId,
  environmentId: webhookDeliveries.environmentId,
  endpointId: webhookDeliveries.endpointId,
  eventId: webhookDeliveries.eventId,
  eventType: webhookDeliveries.eventType,
  test: webhookDeliveries.test,
  state: webhookDeliveries.state,
  attempts: webhookDeliveries.attempts,
  nextAttemptAt: webhookDeliveries.nextAttemptAt,
  lastAttemptAt: webhookDeliveries.lastAttemptAt,
  statusCode: webhookDeliveries.statusCode,
  failureReason: webhookDeliveries.failureReason,
  completedAt: webhookDeliveries.completedAt,
  createdAt: webhookDeliveries.createdAt,
}

const attemptColumns = {
  id: webhookDeliveryAttempts.id,
  attempt: webhookDeliveryAttempts.attempt,
  attemptedAt: webhookDeliveryAttempts.attemptedAt,
  statusCode: webhookDeliveryAttempts.statusCode,
  durationMs: webhookDeliveryAttempts.durationMs,
  failureReason: webhookDeliveryAttempts.failureReason,
}

/** A delivery row as read, typed: the column is text, and only this server's words are in it. */
function toDelivery(
  row: Omit<WebhookDeliveryRecord, 'failureReason'> & { failureReason: string | null }
): WebhookDeliveryRecord {
  return { ...row, failureReason: row.failureReason as WebhookFailureReason | null }
}

/** A pending row for a delivery that is being queued. */
function pendingRow(delivery: NewWebhookDelivery) {
  const { at, ...identity } = delivery
  return {
    ...identity,
    state: 'pending' as const,
    nextAttemptAt: at,
    createdAt: at,
    updatedAt: at,
  }
}

/**
 * Webhook deliveries, their attempts and the outbox's events in Postgres, behind row-level
 * security. Every statement names the environment as well: the policy is the second lock.
 */
export class PostgresWebhookDeliveryStore implements WebhookDeliveryStore {
  /** @param db - Database connected as the runtime role. */
  constructor(private readonly db: Database) {}

  /** @inheritdoc */
  async pendingEvents(environmentId: string, limit: number): Promise<OutboxEvent[]> {
    return withTenant(this.db, environmentId, (tx) =>
      tx
        .select(eventColumns)
        .from(events)
        .where(and(eq(events.environmentId, environmentId), isNull(events.deliveredAt)))
        // On `events_environment_undelivered_idx`; the id breaks ties of one instant.
        .orderBy(asc(events.occurredAt), asc(events.id))
        .limit(limit)
    )
  }

  /** @inheritdoc */
  async eventsById(environmentId: string, eventIds: readonly string[]): Promise<OutboxEvent[]> {
    if (eventIds.length === 0) {
      return []
    }
    return withTenant(this.db, environmentId, (tx) =>
      tx
        .select(eventColumns)
        .from(events)
        .where(and(eq(events.environmentId, environmentId), inArray(events.id, [...eventIds])))
    )
  }

  /** @inheritdoc */
  async enqueue(deliveries: readonly NewWebhookDelivery[]): Promise<number> {
    const [first] = deliveries
    if (!first) {
      return 0
    }
    const insert = (batch: readonly NewWebhookDelivery[]) =>
      withTenant(this.db, first.environmentId, (tx) =>
        tx
          .insert(webhookDeliveries)
          .values(batch.map(pendingRow))
          // One row per endpoint and event: a worker that lost a race changes nothing.
          .onConflictDoNothing({
            target: [webhookDeliveries.endpointId, webhookDeliveries.eventId],
          })
          .returning({ id: webhookDeliveries.id })
      )
    try {
      return (await insert(deliveries)).length
    } catch (error) {
      if (!isForeignKeyViolation(error)) {
        throw error
      }
    }
    // An endpoint was removed while its deliveries were being queued, and took the whole
    // statement with it. One at a time: the rows of the endpoints that are still there are
    // written, and the ones of the endpoint that is gone are not.
    let written = 0
    for (const delivery of deliveries) {
      try {
        written += (await insert([delivery])).length
      } catch (error) {
        if (!isForeignKeyViolation(error)) {
          throw error
        }
      }
    }
    return written
  }

  /** @inheritdoc */
  async settleBefore(
    environmentId: string,
    before: Date,
    at: Date,
    limit: number
  ): Promise<number> {
    const waiting = and(
      eq(events.environmentId, environmentId),
      isNull(events.deliveredAt),
      lt(events.occurredAt, before)
    )
    const rows = await withTenant(this.db, environmentId, (tx) =>
      tx
        .update(events)
        .set({ deliveredAt: at })
        .where(
          and(
            // Said again on the update itself: the batch is chosen from a snapshot.
            waiting,
            // UPDATE has no LIMIT in Postgres: pick the batch in a subquery, oldest first, on
            // `events_environment_undelivered_idx`, so a backlog is never one long update.
            inArray(
              events.id,
              tx
                .select({ id: events.id })
                .from(events)
                .where(waiting)
                .orderBy(asc(events.occurredAt), asc(events.id))
                .limit(limit)
            )
          )
        )
        .returning({ id: events.id })
    )
    return rows.length
  }

  /** @inheritdoc */
  async markDelivered(
    environmentId: string,
    eventIds: readonly string[],
    at: Date
  ): Promise<number> {
    if (eventIds.length === 0) {
      return 0
    }
    const rows = await withTenant(this.db, environmentId, (tx) =>
      tx
        .update(events)
        .set({ deliveredAt: at })
        .where(
          and(
            eq(events.environmentId, environmentId),
            inArray(events.id, [...eventIds]),
            // Never moved once set: the first settlement is the one on record.
            isNull(events.deliveredAt)
          )
        )
        .returning({ id: events.id })
    )
    return rows.length
  }

  /** @inheritdoc */
  async due(
    environmentId: string,
    endpointId: string,
    now: Date,
    limit: number
  ): Promise<WebhookDeliveryRecord[]> {
    const rows = await withTenant(this.db, environmentId, (tx) =>
      tx
        .select(deliveryColumns)
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.environmentId, environmentId),
            eq(webhookDeliveries.endpointId, endpointId),
            eq(webhookDeliveries.state, 'pending'),
            lte(webhookDeliveries.nextAttemptAt, now)
          )
        )
        // On `webhook_deliveries_due_idx`.
        .orderBy(asc(webhookDeliveries.nextAttemptAt), asc(webhookDeliveries.id))
        .limit(limit)
    )
    return rows.map(toDelivery)
  }

  /** @inheritdoc */
  async recordAttempt(
    environmentId: string,
    deliveryId: string,
    attempt: NewWebhookAttempt,
    next: DeliveryTransition | null,
    from: 'pending' | 'ended'
  ): Promise<number | null> {
    return withTenant(this.db, environmentId, async (tx) => {
      // The update takes the row's lock and counts; the insert below uses the number it
      // returned. Both or neither: a count without its attempt would give up a delivery early.
      const [row] = await tx
        .update(webhookDeliveries)
        .set({
          attempts: sql`${webhookDeliveries.attempts} + 1`,
          lastAttemptAt: attempt.attemptedAt,
          statusCode: attempt.statusCode,
          failureReason: attempt.failureReason,
          ...(next ?? {}),
          updatedAt: attempt.attemptedAt,
        })
        .where(
          and(
            eq(webhookDeliveries.environmentId, environmentId),
            eq(webhookDeliveries.id, deliveryId),
            from === 'pending'
              ? eq(webhookDeliveries.state, 'pending')
              : ne(webhookDeliveries.state, 'pending')
          )
        )
        .returning({
          attempts: webhookDeliveries.attempts,
          projectId: webhookDeliveries.projectId,
        })
      if (!row) {
        return null
      }
      await tx.insert(webhookDeliveryAttempts).values({
        ...attempt,
        projectId: row.projectId,
        environmentId,
        deliveryId,
        attempt: row.attempts,
      })
      return row.attempts
    })
  }

  /** @inheritdoc */
  async recordTest(
    delivery: WebhookDeliveryRecord,
    attempt: NewWebhookAttempt | null
  ): Promise<boolean> {
    try {
      await withTenant(this.db, delivery.environmentId, async (tx) => {
        await tx.insert(webhookDeliveries).values({
          ...delivery,
          eventId: null,
          test: true,
          attempts: attempt ? 1 : 0,
          updatedAt: delivery.createdAt,
        })
        if (attempt) {
          await tx.insert(webhookDeliveryAttempts).values({
            ...attempt,
            projectId: delivery.projectId,
            environmentId: delivery.environmentId,
            deliveryId: delivery.id,
            attempt: 1,
          })
        }
      })
      return true
    } catch (error) {
      // The endpoint was removed while its test was under way.
      if (isForeignKeyViolation(error)) {
        return false
      }
      throw error
    }
  }

  /** The pending rows among `deliveryIds`, of one environment: what `defer` and `giveUp` touch. */
  #pending(environmentId: string, deliveryIds: readonly string[]) {
    return and(
      eq(webhookDeliveries.environmentId, environmentId),
      inArray(webhookDeliveries.id, [...deliveryIds]),
      eq(webhookDeliveries.state, 'pending')
    )
  }

  /** @inheritdoc */
  async defer(
    environmentId: string,
    deliveryIds: readonly string[],
    reason: WebhookFailureReason,
    nextAttemptAt: Date,
    at: Date
  ): Promise<number> {
    if (deliveryIds.length === 0) {
      return 0
    }
    const rows = await withTenant(this.db, environmentId, (tx) =>
      tx
        .update(webhookDeliveries)
        // `attempts` is not touched: nothing was sent.
        .set({ failureReason: reason, statusCode: null, nextAttemptAt, updatedAt: at })
        .where(this.#pending(environmentId, deliveryIds))
        .returning({ id: webhookDeliveries.id })
    )
    return rows.length
  }

  /** @inheritdoc */
  async giveUp(
    environmentId: string,
    deliveryIds: readonly string[],
    reason: WebhookFailureReason,
    at: Date
  ): Promise<number> {
    if (deliveryIds.length === 0) {
      return 0
    }
    const rows = await withTenant(this.db, environmentId, (tx) =>
      tx
        .update(webhookDeliveries)
        .set({
          state: 'failed',
          failureReason: reason,
          statusCode: null,
          nextAttemptAt: null,
          completedAt: at,
          updatedAt: at,
        })
        .where(this.#pending(environmentId, deliveryIds))
        .returning({ id: webhookDeliveries.id })
    )
    return rows.length
  }

  /** @inheritdoc */
  async expire(
    environmentId: string,
    createdBefore: Date,
    at: Date,
    limit: number
  ): Promise<number> {
    const waiting = and(
      eq(webhookDeliveries.environmentId, environmentId),
      eq(webhookDeliveries.state, 'pending'),
      lt(webhookDeliveries.createdAt, createdBefore)
    )
    const rows = await withTenant(this.db, environmentId, (tx) =>
      tx
        .update(webhookDeliveries)
        .set({
          state: 'failed',
          failureReason: 'expired',
          statusCode: null,
          nextAttemptAt: null,
          completedAt: at,
          updatedAt: at,
        })
        .where(
          and(
            // Said again on the update itself: the batch is chosen from a snapshot.
            waiting,
            // On `webhook_deliveries_pending_age_idx`, oldest first.
            inArray(
              webhookDeliveries.id,
              tx
                .select({ id: webhookDeliveries.id })
                .from(webhookDeliveries)
                .where(waiting)
                .orderBy(asc(webhookDeliveries.createdAt), asc(webhookDeliveries.id))
                .limit(limit)
            )
          )
        )
        .returning({ id: webhookDeliveries.id })
    )
    return rows.length
  }

  /** @inheritdoc */
  async list(
    environmentId: string,
    endpointId: string,
    query: DeliveryListQuery
  ): Promise<{ deliveries: WebhookDeliveryRecord[]; totalCount: number }> {
    const matching = and(
      eq(webhookDeliveries.environmentId, environmentId),
      eq(webhookDeliveries.endpointId, endpointId),
      query.state === undefined ? undefined : eq(webhookDeliveries.state, query.state),
      query.eventType === undefined ? undefined : eq(webhookDeliveries.eventType, query.eventType)
    )
    return withTenant(this.db, environmentId, async (tx) => {
      const rows = await tx
        .select(deliveryColumns)
        .from(webhookDeliveries)
        .where(matching)
        // On `webhook_deliveries_endpoint_log_idx`; the id breaks ties of one instant.
        .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
        .limit(query.perPage)
        .offset((query.page - 1) * query.perPage)
      const [total] = await tx.select({ value: count() }).from(webhookDeliveries).where(matching)
      return { deliveries: rows.map(toDelivery), totalCount: total?.value ?? 0 }
    })
  }

  /** @inheritdoc */
  async find(
    environmentId: string,
    endpointId: string,
    id: string
  ): Promise<{ delivery: WebhookDeliveryRecord; attempts: WebhookAttemptRecord[] } | null> {
    return withTenant(this.db, environmentId, async (tx) => {
      const [row] = await tx
        .select(deliveryColumns)
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.environmentId, environmentId),
            // Part of the lookup, not a check afterwards: a delivery is found only under the
            // endpoint it is of.
            eq(webhookDeliveries.endpointId, endpointId),
            eq(webhookDeliveries.id, id)
          )
        )
        .limit(1)
      if (!row) {
        return null
      }
      const attempts = await tx
        .select(attemptColumns)
        .from(webhookDeliveryAttempts)
        .where(
          and(
            eq(webhookDeliveryAttempts.environmentId, environmentId),
            eq(webhookDeliveryAttempts.deliveryId, id)
          )
        )
        .orderBy(asc(webhookDeliveryAttempts.attempt))
      return {
        delivery: toDelivery(row),
        attempts: attempts.map((attempt) => ({
          ...attempt,
          // Only the outbound guard's words are ever written to an attempt.
          failureReason: attempt.failureReason as OutboundFailure | null,
        })),
      }
    })
  }

  /** @inheritdoc */
  async deleteSettledEvents(environmentId: string, before: Date, limit: number): Promise<number> {
    return withTenant(this.db, environmentId, async (tx) => {
      const rows = await tx
        .delete(events)
        .where(
          and(
            eq(events.environmentId, environmentId),
            inArray(
              events.id,
              tx
                .select({ id: events.id })
                .from(events)
                .where(
                  and(
                    eq(events.environmentId, environmentId),
                    isNotNull(events.deliveredAt),
                    lt(events.deliveredAt, before),
                    // What a pending delivery will send is its event's payload: kept until
                    // the delivery has ended. On `webhook_deliveries_event_idx`.
                    notExists(
                      tx
                        .select({ id: webhookDeliveries.id })
                        .from(webhookDeliveries)
                        .where(
                          and(
                            eq(webhookDeliveries.environmentId, environmentId),
                            eq(webhookDeliveries.eventId, events.id),
                            eq(webhookDeliveries.state, 'pending')
                          )
                        )
                    )
                  )
                )
                // On `events_environment_delivered_idx`.
                .orderBy(asc(events.deliveredAt), asc(events.id))
                .limit(limit)
            )
          )
        )
        .returning({ id: events.id })
      return rows.length
    })
  }

  /** @inheritdoc */
  async deleteEndedBefore(environmentId: string, before: Date, limit: number): Promise<number> {
    return withTenant(this.db, environmentId, async (tx) => {
      // The attempts go with their delivery: the foreign key cascades.
      const rows = await tx
        .delete(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.environmentId, environmentId),
            inArray(
              webhookDeliveries.id,
              tx
                .select({ id: webhookDeliveries.id })
                .from(webhookDeliveries)
                .where(
                  and(
                    eq(webhookDeliveries.environmentId, environmentId),
                    ne(webhookDeliveries.state, 'pending'),
                    lt(webhookDeliveries.createdAt, before)
                  )
                )
                // On `webhook_deliveries_environment_created_idx`.
                .orderBy(asc(webhookDeliveries.createdAt), asc(webhookDeliveries.id))
                .limit(limit)
            )
          )
        )
        .returning({ id: webhookDeliveries.id })
      return rows.length
    })
  }
}
