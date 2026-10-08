import {
  type CreatedWebhookEndpoint,
  type CreateWebhookEndpointRequest,
  formatWebhookSecret,
  MAX_WEBHOOK_ENDPOINTS,
  signWebhook,
  type UpdateWebhookEndpointRequest,
  WEBHOOK_ENDPOINT_FIELDS,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  type WebhookEndpoint,
  webhookSecretBytes,
} from '@tula/contract'
import type { Deps, Tenant } from '~/dependencies'
import { AuthError, ConflictError, NotFoundError } from '~/exceptions'
import type { Actor } from '~/lib/actor'
import * as logger from '~/lib/logger'
import * as Outbound from '~/lib/outbound'
import { errorReason } from '~/lib/safe-error'
import * as Audit from '~/modules/audit/service'
import type {
  PendingEvent,
  WebhookDeliveryRecord,
  WebhookFailureReason,
} from '~/ports/webhook-delivery-store'
import type { WebhookEndpointChanges, WebhookEndpointRecord } from '~/ports/webhook-endpoint-store'

/** Key-separation label of the sealed signing secrets (`~/lib/secret-box`). */
export const WEBHOOK_SECRET_PURPOSE = 'webhook-secrets'

/** Bytes of a new signing key: 256 bits, inside the 24 to 64 the scheme allows. */
export const WEBHOOK_SECRET_BYTES = 32

/**
 * How often the delivery worker runs. Short, because a webhook is how an operator's backend
 * learns that something happened, and nothing else wakes the worker: the delay of a delivery
 * is at most this plus the round under way. An idle round costs one indexed query per
 * environment, on the instance that holds the job lock.
 */
export const WEBHOOK_DELIVERY_INTERVAL_MS = 5_000

/** Events read per statement, per environment. */
export const WEBHOOK_BATCH_SIZE = 100

/**
 * Batches per environment per round: a ceiling of 1,000 events. A larger backlog (the outbox
 * of a deployment that has recorded events since before there was a worker) is finished by
 * the following rounds instead of one round that never ends.
 */
export const WEBHOOK_MAX_BATCHES = 10

/**
 * Deadline of one delivery, name resolution included. A receiver is expected to take the
 * event and answer; the work it causes belongs after its answer.
 */
export const WEBHOOK_DELIVERY_TIMEOUT_MS = 5_000

/**
 * Events marked per statement when an environment's backlog is settled in bulk: events that
 * are owed to nobody because they happened before any endpoint that is on was registered.
 */
export const WEBHOOK_SETTLE_BATCH_SIZE = 5_000

/**
 * Bulk batches per environment per round: a ceiling of 100,000 events, each batch its own
 * short transaction. A deployment that has recorded events for years settles a million of
 * them in ten rounds, under a minute, instead of the hours the per-event path would take.
 */
export const WEBHOOK_MAX_SETTLE_BATCHES = 20

/**
 * Largest answer body a delivery accepts. Nothing of it is read or kept: the cap only bounds
 * what a receiver can make the server take in. A larger answer counts as a failed delivery.
 */
export const WEBHOOK_MAX_RESPONSE_BYTES = 16 * 1024

/**
 * How long one environment's deliveries may take in one round. Environments are served one
 * after another, so this is what keeps an environment whose endpoint hangs from delaying the
 * others by more than a fixed amount: what it has left waits for the next round.
 */
export const WEBHOOK_ENVIRONMENT_BUDGET_MS = 15_000

/** What one delivery round did. Counts only: nothing here names an endpoint or an address. */
export interface DeliveryReport {
  /** Environments visited. */
  environments: number
  /** Environments whose round failed part-way; what was left is taken up next round. */
  failed: number
  /** Events settled: marked delivered, whether or not anything had to be sent. */
  events: number
  /**
   * Of those, events settled in bulk, unread: they happened before any endpoint that is on
   * was registered (or the environment has none), so they were owed to nobody.
   */
  unowed: number
  /** Deliveries a receiver answered with a 2xx status. */
  delivered: number
  /** Deliveries that got another status, or no answer. Recorded, not repeated. */
  undelivered: number
  /**
   * Events never sent because their stored payload is not an event of the contract (rows
   * recorded before the payload had a schema version). Marked delivered.
   */
  skipped: number
}

/** What binds a sealed secret to its row: copied to another environment or endpoint, it fails. */
function aad(environmentId: string, endpointId: string): string {
  return `${environmentId}:${endpointId}`
}

/** The public view of a stored endpoint: everything but the secret. */
function view(record: WebhookEndpointRecord): WebhookEndpoint {
  return {
    id: record.id,
    url: record.url,
    eventTypes: record.eventTypes,
    enabled: record.enabled,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

/**
 * Refuse an address the server may not call, as the outbound guard judges it now.
 *
 * The answer carries the guard's fixed word (`params.reason`) and nothing else: not the
 * address, and not what its name resolved to.
 *
 * @throws AuthError `webhook.url_not_allowed`.
 */
async function requireCallable(deps: Pick<Deps, 'outbound'>, url: string): Promise<void> {
  try {
    await Outbound.check(deps.outbound, url)
  } catch (error) {
    if (error instanceof Outbound.OutboundError) {
      throw new AuthError('webhook.url_not_allowed', { reason: error.reason })
    }
    throw error
  }
}

/**
 * List the environment's webhook endpoints.
 *
 * @param deps - The endpoint store.
 * @param tenant - The environment.
 * @returns The endpoints, oldest first, without their secrets.
 */
export async function list(
  deps: Pick<Deps, 'webhookEndpoints'>,
  tenant: Pick<Tenant, 'environmentId'>
): Promise<WebhookEndpoint[]> {
  return (await deps.webhookEndpoints.list(tenant.environmentId)).map(view)
}

/**
 * Read one webhook endpoint.
 *
 * @param deps - The endpoint store.
 * @param tenant - The environment.
 * @param id - The endpoint.
 * @returns The endpoint, without its secret.
 * @throws NotFoundError when the environment has no endpoint with that id.
 */
export async function get(
  deps: Pick<Deps, 'webhookEndpoints'>,
  tenant: Pick<Tenant, 'environmentId'>,
  id: string
): Promise<WebhookEndpoint> {
  const record = await deps.webhookEndpoints.find(tenant.environmentId, id)
  if (!record) {
    throw new NotFoundError()
  }
  return view(record)
}

/**
 * Register a webhook endpoint.
 *
 * The signing secret is made here (256 random bits, in the Standard Webhooks format), sealed
 * before it is stored, and returned in this result only: nothing reads it back out. The caller
 * cannot supply one.
 *
 * @param deps - The endpoint store, the outbound guard's settings, the secret box, ids, clock.
 * @param tenant - The environment to register it in.
 * @param input - The address, the event types and whether it starts switched on.
 * @param actor - Who registers it, for the audit log.
 * @returns The endpoint and its secret.
 * @throws AuthError `webhook.url_not_allowed` when the server may not call the address.
 * @throws ConflictError when the environment already has `MAX_WEBHOOK_ENDPOINTS` endpoints.
 * @throws ServiceUnavailableError when the environment's lock could not be had in time.
 */
export async function create(
  deps: Pick<
    Deps,
    'webhookEndpoints' | 'environmentLock' | 'outbound' | 'secretBox' | 'ids' | 'clock'
  >,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  input: CreateWebhookEndpointRequest,
  actor: Actor
): Promise<CreatedWebhookEndpoint> {
  // Before the lock: resolving a name can take seconds, and nothing it decides is shared.
  await requireCallable(deps, input.url)
  // The count and the insert take turns per environment, across instances: registrations
  // that arrive together cannot each see room for one more.
  return deps.environmentLock.runExclusive(tenant.environmentId, 'webhook_endpoints', () =>
    register(deps, tenant, input, actor)
  )
}

/** Count the environment's endpoints and add one. Called with the environment's lock held. */
async function register(
  deps: Pick<Deps, 'webhookEndpoints' | 'secretBox' | 'ids' | 'clock'>,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  input: CreateWebhookEndpointRequest,
  actor: Actor
): Promise<CreatedWebhookEndpoint> {
  const existing = await deps.webhookEndpoints.list(tenant.environmentId)
  if (existing.length >= MAX_WEBHOOK_ENDPOINTS) {
    throw new ConflictError({
      message: `This environment already has ${MAX_WEBHOOK_ENDPOINTS} webhook endpoints. Remove one first.`,
      params: { max: MAX_WEBHOOK_ENDPOINTS },
    })
  }
  const id = deps.ids.next()
  const secret = formatWebhookSecret(crypto.getRandomValues(new Uint8Array(WEBHOOK_SECRET_BYTES)))
  const activity = Audit.entry(deps, tenant, {
    type: 'webhook_endpoint.created',
    actor,
    target: { type: 'webhook_endpoint', id },
    data: { eventTypes: input.eventTypes.length, enabled: input.enabled },
  })
  const record = await deps.webhookEndpoints.insert(
    {
      id,
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      url: input.url,
      eventTypes: [...input.eventTypes],
      secret: await deps.secretBox.seal(
        WEBHOOK_SECRET_PURPOSE,
        new TextEncoder().encode(secret),
        aad(tenant.environmentId, id)
      ),
      enabled: input.enabled,
      // The instant of its own audit entry: an endpoint is sent the events from its creation
      // on, and within this instance "from" must not depend on which of two clock readings
      // came first. Between instances it depends on their clocks agreeing (ADR 0034).
      createdAt: activity.occurredAt,
      updatedAt: activity.occurredAt,
    },
    activity
  )
  return { ...view(record), secret }
}

/** Whether two lists name the same event types, in any order. */
function sameTypes(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((type) => b.includes(type))
}

/**
 * Change a webhook endpoint's address, event types or switch.
 *
 * A new address is judged by the outbound guard before it is stored. The audit entry names the
 * fields that changed and never their values. A request that changes nothing writes nothing.
 * The secret is not something an update can touch.
 *
 * @param deps - The endpoint store, the outbound guard's settings, ids and clock.
 * @param tenant - The environment.
 * @param id - The endpoint.
 * @param input - The fields to change.
 * @param actor - Who changes it, for the audit log.
 * @returns The endpoint as it is now, without its secret.
 * @throws NotFoundError when the environment has no endpoint with that id.
 * @throws AuthError `webhook.url_not_allowed` when the server may not call the new address.
 */
export async function update(
  deps: Pick<Deps, 'webhookEndpoints' | 'outbound' | 'ids' | 'clock'>,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  id: string,
  input: UpdateWebhookEndpointRequest,
  actor: Actor
): Promise<WebhookEndpoint> {
  const current = await deps.webhookEndpoints.find(tenant.environmentId, id)
  if (!current) {
    throw new NotFoundError()
  }
  const changes: WebhookEndpointChanges = {}
  if (input.url !== undefined && input.url !== current.url) {
    await requireCallable(deps, input.url)
    changes.url = input.url
  }
  if (input.eventTypes !== undefined && !sameTypes(input.eventTypes, current.eventTypes)) {
    changes.eventTypes = [...input.eventTypes]
  }
  if (input.enabled !== undefined && input.enabled !== current.enabled) {
    changes.enabled = input.enabled
  }
  const changed = WEBHOOK_ENDPOINT_FIELDS.filter((field) => changes[field] !== undefined)
  if (changed.length === 0) {
    return view(current)
  }
  const updated = await deps.webhookEndpoints.update(
    tenant.environmentId,
    id,
    changes,
    deps.clock.now(),
    Audit.entry(deps, tenant, {
      type: 'webhook_endpoint.updated',
      actor,
      target: { type: 'webhook_endpoint', id },
      data: { changed },
    })
  )
  if (!updated) {
    // Removed between the read and the write.
    throw new NotFoundError()
  }
  return view(updated)
}

/**
 * Remove a webhook endpoint. Nothing more is delivered to it, and the record of its deliveries
 * goes with it.
 *
 * @param deps - The endpoint store, ids and clock.
 * @param tenant - The environment.
 * @param id - The endpoint.
 * @param actor - Who removes it, for the audit log.
 * @throws NotFoundError when the environment has no endpoint with that id.
 */
export async function remove(
  deps: Pick<Deps, 'webhookEndpoints' | 'ids' | 'clock'>,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  id: string,
  actor: Actor
): Promise<void> {
  const deleted = await deps.webhookEndpoints.delete(
    tenant.environmentId,
    id,
    Audit.entry(deps, tenant, {
      type: 'webhook_endpoint.deleted',
      actor,
      target: { type: 'webhook_endpoint', id },
    })
  )
  if (!deleted) {
    throw new NotFoundError()
  }
}

type DeliveryDeps = Pick<
  Deps,
  | 'environments'
  | 'webhookEndpoints'
  | 'webhookDeliveries'
  | 'outbound'
  | 'secretBox'
  | 'ids'
  | 'clock'
>

/**
 * Whether a stored payload is an event of the contract and the one its row says it is.
 *
 * Rows recorded before the event contract hold `{ actor, target, data }` with no
 * `schemaVersion`: a shape no receiver was promised, so one is never sent.
 */
function isEvent(event: PendingEvent): boolean {
  const { payload } = event
  return (
    typeof payload.schemaVersion === 'number' &&
    payload.id === event.id &&
    payload.type === event.type
  )
}

/** The endpoints an event has to go to: switched on, subscribed, and there when it happened. */
function recipients(
  endpoints: readonly WebhookEndpointRecord[],
  event: PendingEvent
): WebhookEndpointRecord[] {
  return endpoints.filter(
    (endpoint) =>
      endpoint.enabled &&
      endpoint.eventTypes.includes(event.type) &&
      endpoint.createdAt.getTime() <= event.occurredAt.getTime()
  )
}

/** The signing key of an endpoint, or `null` when its sealed secret cannot be opened or read. */
async function signingKey(
  deps: Pick<Deps, 'secretBox'>,
  endpoint: WebhookEndpointRecord
): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const opened = await deps.secretBox.open(
      WEBHOOK_SECRET_PURPOSE,
      endpoint.secret,
      aad(endpoint.environmentId, endpoint.id)
    )
    return webhookSecretBytes(new TextDecoder().decode(opened))
  } catch {
    // The failure is not passed on: it is about key material.
    return null
  }
}

/** What became of one attempt, in the terms of a delivery row. */
type Attempt = Pick<
  WebhookDeliveryRecord,
  'attemptedAt' | 'outcome' | 'statusCode' | 'durationMs' | 'failureReason'
>

/**
 * Send one event to one endpoint, once, signed.
 *
 * The request goes through the outbound guard, which judges the address again now: what it
 * resolved to when it was saved says nothing about today. Of the answer only the status is
 * looked at; its headers and body are dropped here and never leave this function.
 */
async function attempt(
  deps: Pick<Deps, 'outbound' | 'secretBox' | 'clock'>,
  endpoint: WebhookEndpointRecord,
  event: PendingEvent
): Promise<Attempt> {
  const attemptedAt = deps.clock.now()
  const failed = (failureReason: WebhookFailureReason): Attempt => ({
    attemptedAt,
    outcome: 'failed',
    statusCode: null,
    durationMs: Math.max(0, deps.clock.now().getTime() - attemptedAt.getTime()),
    failureReason,
  })
  const key = await signingKey(deps, endpoint)
  if (!key) {
    // The caller says so once per endpoint and round, not once per event.
    return failed('signing_failed')
  }
  // The exact text that is sent is the text that is signed.
  const body = JSON.stringify(event.payload)
  const timestamp = Math.floor(attemptedAt.getTime() / 1000)
  let status: number
  try {
    const answer = await Outbound.request(deps.outbound, endpoint.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [WEBHOOK_ID_HEADER]: event.id,
        [WEBHOOK_TIMESTAMP_HEADER]: String(timestamp),
        [WEBHOOK_SIGNATURE_HEADER]: await signWebhook(key, event.id, timestamp, body),
      },
      body,
      timeoutMs: WEBHOOK_DELIVERY_TIMEOUT_MS,
      maxResponseBytes: WEBHOOK_MAX_RESPONSE_BYTES,
    })
    status = answer.status
  } catch (error) {
    if (error instanceof Outbound.OutboundError) {
      return failed(error.reason)
    }
    throw error
  }
  return {
    attemptedAt,
    outcome: status >= 200 && status < 300 ? 'delivered' : 'failed',
    statusCode: status,
    durationMs: Math.max(0, deps.clock.now().getTime() - attemptedAt.getTime()),
    failureReason: null,
  }
}

/** Deliver one environment's waiting events, within its budget for the round. */
async function deliverEnvironment(
  deps: DeliveryDeps,
  environmentId: string,
  report: DeliveryReport,
  signal: AbortSignal | undefined
): Promise<void> {
  const started = deps.clock.now().getTime()
  // Endpoints that ran out a delivery's whole deadline in this round. Waiting that long again
  // for every further event would spend the environment's budget on one endpoint and starve
  // the others, so the rest of what such an endpoint is owed this round is settled WITHOUT
  // being tried: recorded as failed (`endpoint_unresponsive`), never sent, and not sent later
  // either until retries exist. An endpoint that was slow once loses up to a round's worth.
  // The next round tries it afresh.
  const unresponsive = new Set<string>()
  // Per endpoint, how many deliveries were not made this round because its secret could not
  // be opened. A fault on the server's side: said once per endpoint, with the count.
  const unsigned = new Map<string, number>()
  // Out of budget, or the server is shutting down: either way what is left waits.
  const outOfTime = () =>
    signal?.aborted === true ||
    deps.clock.now().getTime() - started >= WEBHOOK_ENVIRONMENT_BUDGET_MS
  try {
    await settleUnowed(deps, environmentId, report, new Date(started), outOfTime)
    await deliverOwed(deps, environmentId, report, outOfTime, unresponsive, unsigned)
  } finally {
    for (const [endpointId, events] of unsigned) {
      // Most often a TULA_MASTER_KEY that is not the one the secret was sealed with, on this
      // instance or on all of them. The receiver did nothing wrong and was sent nothing.
      logger.warn(
        'webhook signing secret could not be opened; nothing was sent to the endpoint this round',
        { environmentId, endpointId, events }
      )
    }
  }
}

/**
 * Settle, in bulk and unread, the events of an environment that are owed to nobody.
 *
 * An event is owed to the endpoints that are switched on, subscribed to its type and were
 * registered no later than it happened. So an event from **before the earliest endpoint that
 * is on** is owed to none of them whatever its type, and with no endpoint on, nothing that
 * has happened so far is owed to anyone. An endpoint that is switched off does not count: it
 * is owed nothing while it is off, exactly as in the per-event path, which would settle the
 * same events one by one.
 *
 * The boundary is strict: an event at the very instant the earliest endpoint was registered
 * is owed to it and is left for the per-event path. So is anything at or after the instant
 * this pass began, which an endpoint registered meanwhile may be owed.
 */
async function settleUnowed(
  deps: DeliveryDeps,
  environmentId: string,
  report: DeliveryReport,
  started: Date,
  outOfTime: () => boolean
): Promise<void> {
  const registered = (await deps.webhookEndpoints.list(environmentId))
    .filter((endpoint) => endpoint.enabled)
    .map((endpoint) => endpoint.createdAt.getTime())
  const before = new Date(Math.min(started.getTime(), ...registered))
  for (let batch = 0; batch < WEBHOOK_MAX_SETTLE_BATCHES && !outOfTime(); batch++) {
    const settled = await deps.webhookDeliveries.settleBefore(
      environmentId,
      before,
      deps.clock.now(),
      WEBHOOK_SETTLE_BATCH_SIZE
    )
    report.events += settled
    report.unowed += settled
    if (settled < WEBHOOK_SETTLE_BATCH_SIZE) {
      return
    }
  }
}

/** Send one environment's waiting events to the endpoints they are owed to, event by event. */
async function deliverOwed(
  deps: DeliveryDeps,
  environmentId: string,
  report: DeliveryReport,
  outOfTime: () => boolean,
  unresponsive: Set<string>,
  unsigned: Map<string, number>
): Promise<void> {
  for (let batch = 0; batch < WEBHOOK_MAX_BATCHES; batch++) {
    const pending = await deps.webhookDeliveries.pendingEvents(environmentId, WEBHOOK_BATCH_SIZE)
    if (pending.length === 0) {
      return
    }
    // Read again for every batch: an endpoint switched off or removed stops being sent to.
    const endpoints = await deps.webhookEndpoints.list(environmentId)
    const sent = new Set(
      (
        await deps.webhookDeliveries.listForEvents(
          environmentId,
          pending.map((event) => event.id)
        )
      ).map((row) => `${row.endpointId}:${row.eventId}`)
    )
    const settled: string[] = []
    let skipped = 0
    let stopped = false
    try {
      for (const event of pending) {
        if (!isEvent(event)) {
          skipped += 1
          settled.push(event.id)
          continue
        }
        // Left over from a round that ended between sending and marking: not sent again.
        const owed = recipients(endpoints, event).filter(
          (endpoint) => !sent.has(`${endpoint.id}:${event.id}`)
        )
        for (const endpoint of owed) {
          if (outOfTime()) {
            stopped = true
            break
          }
          const result: Attempt = unresponsive.has(endpoint.id)
            ? {
                attemptedAt: deps.clock.now(),
                outcome: 'failed',
                statusCode: null,
                durationMs: 0,
                failureReason: 'endpoint_unresponsive',
              }
            : await attempt(deps, endpoint, event)
          if (result.failureReason === 'timeout') {
            unresponsive.add(endpoint.id)
          }
          if (result.failureReason === 'signing_failed') {
            unsigned.set(endpoint.id, (unsigned.get(endpoint.id) ?? 0) + 1)
          }
          // `gone` (the endpoint was removed meanwhile) and `duplicate` (another worker's row)
          // both mean this endpoint is owed nothing more for this event.
          await deps.webhookDeliveries.insert({
            id: deps.ids.next(),
            projectId: event.projectId,
            environmentId,
            endpointId: endpoint.id,
            eventId: event.id,
            ...result,
          })
          report[result.outcome === 'delivered' ? 'delivered' : 'undelivered'] += 1
        }
        if (stopped) {
          break
        }
        settled.push(event.id)
      }
    } finally {
      // Also when a later event failed: what was settled before it stays settled, so a
      // failure does not send the earlier events of the batch a second time.
      report.events += await deps.webhookDeliveries.markDelivered(
        environmentId,
        settled,
        deps.clock.now()
      )
      report.skipped += skipped
    }
    if (stopped || pending.length < WEBHOOK_BATCH_SIZE) {
      return
    }
  }
}

/**
 * One round of webhook delivery, in every environment.
 *
 * Per environment it takes the events no round has settled yet, oldest first, and sends each
 * to every endpoint that is switched on, subscribed to the event's type and was registered no
 * later than the event happened. **Each endpoint gets at most one attempt per event**: the outcome is
 * recorded (a status code and a duration, or a fixed word when there was no answer) and a
 * failure is not repeated. An event is marked delivered once every endpoint it had to go to
 * has a delivery row, which includes the event nobody subscribed to.
 *
 * Delivery is at least once: a round that ends between sending and recording sends again, with
 * the same event id.
 *
 * Two kinds of event are settled without being tried, and are not sent later (there are no
 * retries yet). After an endpoint lets a delivery run out its deadline, the rest of what it
 * is owed in that round is recorded `endpoint_unresponsive`, so it cannot use up the budget
 * its environment's other endpoints share: a receiver that is slow once can lose up to a
 * round's worth. And what is owed to an endpoint whose secret cannot be opened is recorded
 * `signing_failed`, with one log line per endpoint per round.
 *
 * Before any of that, events owed to nobody (from before the earliest endpoint that is on)
 * are settled in bulk, so a long outbox does not stand between a new endpoint and its first
 * delivery.
 *
 * A failure in one environment is logged and skipped, and each environment has a time budget
 * ({@link WEBHOOK_ENVIRONMENT_BUDGET_MS}), so neither a broken nor a slow one keeps the
 * environments after it from being served.
 *
 * @param deps - Environments, the webhook stores, the outbound guard's settings, the secret
 *   box, ids and the clock.
 * @param signal - Aborted to end the round early (the server is shutting down): the delivery
 *   under way is finished and recorded, nothing further is sent, and what is left waits for
 *   the next round.
 * @returns What the round did. Counts from an environment that failed part-way are included.
 */
export async function deliverPending(
  deps: DeliveryDeps,
  signal?: AbortSignal
): Promise<DeliveryReport> {
  const report: DeliveryReport = {
    environments: 0,
    failed: 0,
    events: 0,
    unowed: 0,
    delivered: 0,
    undelivered: 0,
    skipped: 0,
  }
  for (const { id } of await deps.environments.listAll()) {
    if (signal?.aborted) {
      break
    }
    report.environments += 1
    try {
      await deliverEnvironment(deps, id, report, signal)
    } catch (error) {
      report.failed += 1
      logger.warn('webhook delivery failed in one environment', {
        environmentId: id,
        err: errorReason(error),
      })
    }
  }
  return report
}

/**
 * Run a delivery round, unless one is running: here or on another API instance.
 *
 * Called on boot and every {@link WEBHOOK_DELIVERY_INTERVAL_MS} by `server.ts`, on every
 * instance; the job lock lets one of them through, and a round that is still running when the
 * next one is due is not started twice. Logs one line per round that did something, with
 * counts only.
 *
 * @param deps - Everything {@link deliverPending} needs, plus the job lock.
 * @param signal - Aborted to end the round early; see {@link deliverPending}.
 * @returns The round's report, or `null` when the lock was held (nothing is logged).
 * @throws When the lock or the list of environments cannot be read (the database is down).
 */
export async function run(
  deps: DeliveryDeps & Pick<Deps, 'jobLock'>,
  signal?: AbortSignal
): Promise<DeliveryReport | null> {
  const outcome = await deps.jobLock.runExclusive('webhook_delivery', () =>
    deliverPending(deps, signal)
  )
  if (!outcome.ran) {
    return null
  }
  const report = outcome.value
  // An idle round is routine and frequent; one that sent something, or could not, is worth a
  // line.
  const log =
    report.failed > 0 || report.undelivered > 0
      ? logger.warn
      : report.events > 0
        ? logger.info
        : logger.debug
  log('webhook delivery round finished', { ...report })
  return report
}
