import {
  type CreatedWebhookEndpoint,
  type CreateWebhookEndpointRequest,
  DEFAULT_PAGE_SIZE,
  durationToMs,
  EVENT_FIXTURES,
  MAX_WEBHOOK_ENDPOINTS,
  type RotatedWebhookSecret,
  type SendTestWebhookRequest,
  type UpdateWebhookEndpointRequest,
  WEBHOOK_ENDPOINT_FIELDS,
  type WebhookDelivery,
  type WebhookDeliveryDetail,
  type WebhookDeliveryList,
  type WebhookDeliveryState,
  type WebhookEndpoint,
  type WebhookSendResult,
} from '@tula/contract'
import type { Deps, Tenant } from '~/dependencies'
import { AuthError, ConflictError, NotFoundError, NotImplementedError } from '~/exceptions'
import { type Actor, systemActor } from '~/lib/actor'
import * as logger from '~/lib/logger'
import * as Outbound from '~/lib/outbound'
import { errorReason } from '~/lib/safe-error'
import {
  newSigningSecret,
  openSigningSecret,
  SIGNING_SECRET_BYTES,
  type SigningKeys,
  signedHeaders,
} from '~/lib/signing-secret'
import * as Audit from '~/modules/audit/service'
import type {
  DeliveryTransition,
  NewWebhookAttempt,
  NewWebhookDelivery,
  OutboxEvent,
  WebhookDeliveryRecord,
} from '~/ports/webhook-delivery-store'
import type {
  WebhookDisabledReason,
  WebhookEndpointChanges,
  WebhookEndpointRecord,
} from '~/ports/webhook-endpoint-store'

/** Key-separation label of the sealed signing secrets (`~/lib/secret-box`). */
export const WEBHOOK_SECRET_PURPOSE = 'webhook-secrets'

/** Bytes of a new signing key: 256 bits, inside the 24 to 64 the scheme allows. */
export const WEBHOOK_SECRET_BYTES = SIGNING_SECRET_BYTES

/**
 * How long the secret a rotation replaced keeps signing beside the new one. A constant, not a
 * setting: a receiver's operator can be told what to expect.
 *
 * A day is long enough to get the new secret into a receiver through an ordinary deployment
 * (a review, a release window, another time zone), and short enough that a secret which is
 * being replaced because it may have leaked stops being worth anything soon. An operator who
 * cannot wait that long ends the overlap by hand ({@link revokePreviousSecret}).
 */
export const WEBHOOK_SECRET_OVERLAP = '24h'

/**
 * Endpoints cleared of an expired previous secret per statement, per environment per round.
 * An environment has at most `MAX_WEBHOOK_ENDPOINTS` endpoints, so one statement is always
 * the whole of it; the bound is there so the statement has one.
 */
export const WEBHOOK_SECRET_CLEAR_BATCH = 100

/**
 * How often the delivery worker runs. Short, because a webhook is how an operator's backend
 * learns that something happened, and nothing else wakes the worker: the delay of a delivery
 * is at most this plus the round under way. An idle round costs a few indexed queries per
 * environment, on the instance that holds the job lock.
 */
export const WEBHOOK_DELIVERY_INTERVAL_MS = 5_000

/** Events read per statement, per environment. */
export const WEBHOOK_BATCH_SIZE = 100

/**
 * Batches per environment per round: a ceiling of 1,000 events turned into deliveries. A larger
 * backlog is finished by the following rounds instead of one round that never ends.
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
 * after another, so this is what keeps an environment whose endpoints are slow from delaying
 * the others by more than a fixed amount: what it has left waits for the next round.
 */
export const WEBHOOK_ENVIRONMENT_BUDGET_MS = 15_000

/** Requests made for one delivery before it is given up: the first, and seven retries. */
export const WEBHOOK_MAX_ATTEMPTS = 8

/**
 * How long to wait after the first, second, … failed request before the next: the schedule
 * of the Standard Webhooks reference implementation (roughly exponential, 27 hours 35 minutes
 * in all). Constants, not settings: a receiver can be told what to expect.
 *
 * The first wait is one round of the worker, so a receiver that hiccups once is tried again
 * almost at once; the last ones are long enough to outlast a night's outage.
 */
export const WEBHOOK_RETRY_DELAYS = ['5s', '5m', '30m', '2h', '5h', '10h', '10h'] as const

/**
 * How much longer than the schedule a wait may be, as a fraction: up to a fifth. Deliveries
 * that failed together (an endpoint that was down) do not all come back in the same second.
 * A wait is never shorter than the schedule says.
 */
export const WEBHOOK_RETRY_JITTER = 0.2

/**
 * How long a delivery may stay pending, from the moment it was queued, whatever happened to
 * it: after this it is given up (`expired`). The schedule ends well inside it (33 hours with
 * the most jitter); this is the bound for what the schedule does not count: a delivery put
 * off because its endpoint was unresponsive or its secret would not open, one the round's
 * caps kept leaving for later, and one whose endpoint is switched off.
 */
export const WEBHOOK_DELIVERY_MAX_AGE = '3d'

/**
 * The most deliveries made to one endpoint in one round, the most overdue first. An endpoint
 * with a backlog (it was down for a night) takes this much of a round and no more; the rest
 * is due in the next one, five seconds later.
 */
export const WEBHOOK_ENDPOINT_ROUND_CAP = 50

/**
 * The most requests in flight at once. Endpoints of one environment are served side by side,
 * up to this many; each endpoint has one request in flight at a time, so a receiver is never
 * sent two events at once by the worker.
 */
export const WEBHOOK_MAX_CONCURRENT_DELIVERIES = 5

/**
 * How long a run of failed requests must have lasted before the server switches an endpoint
 * off. A **run** is failed requests with no success among them and no silence between two of
 * them longer than {@link WEBHOOK_FAILURE_RUN_MAX_GAP_MS}. An endpoint that is down for an
 * hour, a night or a weekend is not switched off, and one that has been sent things all week
 * and taken none of them is.
 */
export const WEBHOOK_DISABLE_AFTER = '5d'

/** What is added to the schedule's own length to get the longest silence a run may have. */
export const WEBHOOK_FAILURE_RUN_MARGIN = '1h'

/**
 * The longest silence between two failed requests that still belong to one run: the whole
 * retry schedule with the most jitter, and a margin. Computed from the schedule's constants,
 * so it cannot drift from them.
 *
 * Why the whole schedule: while one delivery is being retried, its requests are at most this
 * far apart in all, so an endpoint that is failing and still being sent things never has a
 * longer silence. A longer one means nothing was sent for a while (the delivery was given up
 * and no event followed), and then nothing says the endpoint stayed broken: it may have been
 * fixed the same day. The next failure begins a run of its own.
 */
export const WEBHOOK_FAILURE_RUN_MAX_GAP_MS =
  Math.round(
    WEBHOOK_RETRY_DELAYS.reduce((sum, wait) => sum + durationToMs(wait), 0) *
      (1 + WEBHOOK_RETRY_JITTER)
  ) + durationToMs(WEBHOOK_FAILURE_RUN_MARGIN)

/**
 * The most requests one delivery may ever have: the worker's eight and what an administrator
 * adds by sending it again. Past this "send it again" is refused (`attempt_limit`), so one
 * delivery's log, and the answer that returns it, is bounded. Checked before the request is
 * made: requests already in flight when the limit is reached are still recorded, and
 * {@link WEBHOOK_SEND_RATE_LIMIT} bounds how many those can be.
 */
export const WEBHOOK_MAX_TOTAL_ATTEMPTS = 20

/**
 * How far into an endpoint's delivery log the admin API pages and counts: its newest ten
 * thousand deliveries (500 pages of the default size). A page past it is refused, and
 * `totalCount` stops there. The log can hold ninety days of deliveries; what an operator
 * wants from further back is found with the `state` and `eventType` filters, not by paging.
 */
export const WEBHOOK_DELIVERY_LIST_WINDOW = 10_000

/**
 * How long the rest of an endpoint's due deliveries are put off after it let one run out its
 * deadline. No request is made for them and no attempt is counted.
 */
export const WEBHOOK_UNRESPONSIVE_DELAY = '1m'

/**
 * How long an endpoint's due deliveries are put off when its signing secret cannot be opened.
 * The fault is the server's (`TULA_MASTER_KEY`): nothing is sent and no attempt is counted.
 */
export const WEBHOOK_SIGNING_RETRY_DELAY = '5m'

/** Deliveries given up for their age per statement. */
export const WEBHOOK_EXPIRE_BATCH_SIZE = 500

/** Such batches per environment per round. */
export const WEBHOOK_MAX_EXPIRE_BATCHES = 10

/**
 * How often one environment may ask for a request on demand (a test event, or a delivery sent
 * again), per minute. Its own bucket: each such call makes the server call an address, and the
 * general admin limit would let that be done three hundred times a minute.
 */
export const WEBHOOK_SEND_RATE_LIMIT = 10

/** What one delivery round did. Counts only: nothing here names an endpoint or an address. */
export interface DeliveryReport {
  /** Environments visited. */
  environments: number
  /** Environments whose round failed part-way; what was left is taken up next round. */
  failed: number
  /** Events settled: every endpoint they are owed to has a delivery row, or none is owed. */
  events: number
  /**
   * Of those, events settled in bulk, unread: they happened before any endpoint that is on
   * was registered (or the environment has none), so they were owed to nobody.
   */
  unowed: number
  /** Deliveries queued: one per endpoint an event is owed to. */
  queued: number
  /** Requests a receiver answered with a 2xx status. */
  delivered: number
  /** Requests that got another status, or no answer. Tried again unless given up. */
  undelivered: number
  /** Deliveries put off without a request: an unresponsive endpoint, a secret that will not open. */
  deferred: number
  /** Deliveries given up: out of attempts, too old, answered 410, or their event is gone. */
  givenUp: number
  /** Endpoints the server switched off. */
  disabled: number
  /**
   * Previous signing secrets deleted from their rows because their rotation's overlap had
   * ended. They had stopped signing at that end already, by the clock.
   */
  secretsExpired: number
  /**
   * Events never sent because their stored payload is not an event of the contract (rows
   * recorded before the payload had a schema version). Settled.
   */
  skipped: number
}

/**
 * What binds the sealed **current** secret to its row: copied to another environment or
 * endpoint, it fails. Exactly what it was before rotation existed, so every secret stored
 * since the first webhook still opens.
 */
function aad(environmentId: string, endpointId: string): string {
  return `${environmentId}:${endpointId}`
}

/**
 * What binds the sealed **previous** secret to its row and to its slot. The slot is part of
 * it, so a ciphertext cannot be moved between the two columns: the current one copied into
 * `previous_secret` does not open (it would otherwise sign past its own rotation), and the
 * previous one copied back into `secret` does not either. Both ids are UUIDs, so this can
 * never be another row's current binding.
 */
function previousAad(environmentId: string, endpointId: string): string {
  return `${environmentId}:${endpointId}:previous`
}

/**
 * Whether an endpoint's previous secret signs at `at`: it has one, and its end has not come.
 * The one place that decides it, for signing, for the view and for what a rotation refuses;
 * the store's guards say the same in SQL. Strict: at the instant of its end it does not.
 */
function overlapUnderWay(
  record: Pick<WebhookEndpointRecord, 'previousSecretExpiresAt'>,
  at: Date
): boolean {
  return (
    record.previousSecretExpiresAt !== null &&
    at.getTime() < record.previousSecretExpiresAt.getTime()
  )
}

/**
 * The public view of a stored endpoint: everything but the secrets.
 *
 * @param record - The stored endpoint.
 * @param now - The clock: a previous secret past its end is not "a rotation under way",
 *   whether or not the worker has cleared it from the row yet.
 */
function view(record: WebhookEndpointRecord, now: Date): WebhookEndpoint {
  return {
    id: record.id,
    url: record.url,
    eventTypes: record.eventTypes,
    enabled: record.enabled,
    disabledReason: record.disabledReason,
    failingSince: record.failingSince?.toISOString() ?? null,
    lastFailedAt: record.lastFailedAt?.toISOString() ?? null,
    rotationOverlapEndsAt: overlapUnderWay(record, now)
      ? (record.previousSecretExpiresAt?.toISOString() ?? null)
      : null,
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
 * @param deps - The endpoint store and the clock.
 * @param tenant - The environment.
 * @returns The endpoints, oldest first, without their secrets.
 */
export async function list(
  deps: Pick<Deps, 'webhookEndpoints' | 'clock'>,
  tenant: Pick<Tenant, 'environmentId'>
): Promise<WebhookEndpoint[]> {
  const now = deps.clock.now()
  return (await deps.webhookEndpoints.list(tenant.environmentId)).map((record) => view(record, now))
}

/** The stored endpoint, or the 404 every route answers for one that is not this environment's. */
async function requireEndpoint(
  deps: Pick<Deps, 'webhookEndpoints'>,
  tenant: Pick<Tenant, 'environmentId'>,
  id: string
): Promise<WebhookEndpointRecord> {
  const record = await deps.webhookEndpoints.find(tenant.environmentId, id)
  if (!record) {
    throw new NotFoundError()
  }
  return record
}

/**
 * Read one webhook endpoint.
 *
 * @param deps - The endpoint store and the clock.
 * @param tenant - The environment.
 * @param id - The endpoint.
 * @returns The endpoint, without its secret.
 * @throws NotFoundError when the environment has no endpoint with that id.
 */
export async function get(
  deps: Pick<Deps, 'webhookEndpoints' | 'clock'>,
  tenant: Pick<Tenant, 'environmentId'>,
  id: string
): Promise<WebhookEndpoint> {
  return view(await requireEndpoint(deps, tenant, id), deps.clock.now())
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
  const secret = newSigningSecret()
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
      previousSecret: null,
      previousSecretExpiresAt: null,
      enabled: input.enabled,
      disabledReason: null,
      failingSince: null,
      lastFailedAt: null,
      // The instant of its own audit entry: an endpoint is sent the events from its creation
      // on, and within this instance "from" must not depend on which of two clock readings
      // came first. Between instances it depends on their clocks agreeing (ADR 0034).
      createdAt: activity.occurredAt,
      updatedAt: activity.occurredAt,
    },
    activity
  )
  return { ...view(record, activity.occurredAt), secret }
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
 * Switching an endpoint on, or giving it another address, forgets why the server switched it
 * off and since when it was failing. Deliveries that were pending when it went off are tried
 * again from then on, unless they have meanwhile grown older than
 * {@link WEBHOOK_DELIVERY_MAX_AGE}; events from the time it was off are never sent.
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
  const current = await requireEndpoint(deps, tenant, id)
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
    return view(current, deps.clock.now())
  }
  // Switched on again, or pointed somewhere else: what the worker held against the endpoint
  // was about the endpoint as it was.
  if (changes.enabled === true || changes.url !== undefined) {
    changes.resetHealth = true
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
  return view(updated, deps.clock.now())
}

/**
 * Remove a webhook endpoint. Nothing more is delivered to it, and the record of its deliveries
 * goes with it, pending ones included.
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

/**
 * Replace an endpoint's signing secret without dropping a delivery.
 *
 * The server makes the new secret and returns it in this result only. The secret it replaces
 * is not thrown away: it keeps signing **beside** the new one for
 * {@link WEBHOOK_SECRET_OVERLAP}, so every delivery in that time carries two signatures (the
 * new secret's first) and a receiver verifies with whichever it holds. The operator deploys
 * the new secret to the receiver inside the overlap; when it ends, the old one signs nothing
 * (decided at each request from the stored end and the clock) and the worker deletes it.
 *
 * **Never three.** While a previous secret still signs, another rotation is refused
 * (`rotation_in_progress`): keeping a third would let a mistake pile secrets up, and dropping
 * the oldest silently would fail the receivers that still hold only it. The operator who
 * needs to rotate again now ends the overlap first ({@link revokePreviousSecret}), which is
 * an explicit, recorded act. The check is made again in the store's statement, so two
 * rotations that arrive together, on one instance or two, cannot both be written.
 *
 * The replaced secret is opened and sealed again for the previous slot (its binding names the
 * slot), which is why a secret the server cannot open cannot be rotated
 * (`secret_unreadable`): it could not be kept signing, and a receiver that still holds only
 * it would be cut off at once, with no overlap at all. That is a `TULA_MASTER_KEY` to put
 * right first.
 *
 * An endpoint that is switched off can be rotated: a secret that may have leaked is a reason
 * to switch one off, and it is replaced before it is switched on again.
 *
 * @param deps - The endpoint store, the secret box, ids and the clock.
 * @param tenant - The environment. An endpoint of another is not found.
 * @param id - The endpoint.
 * @param actor - Who rotates it, for the audit log.
 * @returns The endpoint, its **new** secret, and when the previous one stops signing.
 * @throws NotFoundError when the environment has no endpoint with that id, or it was removed
 *   meanwhile.
 * @throws AuthError `webhook.rotation_refused`, with `params.reason` `rotation_in_progress`
 *   or `secret_unreadable`.
 */
export async function rotateSecret(
  deps: Pick<Deps, 'webhookEndpoints' | 'secretBox' | 'ids' | 'clock'>,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  id: string,
  actor: Actor
): Promise<RotatedWebhookSecret> {
  const current = await requireEndpoint(deps, tenant, id)
  if (overlapUnderWay(current, deps.clock.now())) {
    throw new AuthError('webhook.rotation_refused', { reason: 'rotation_in_progress' })
  }
  // Opened, and a signing secret: anything else could not sign today and must not be kept as
  // a previous secret that signs nothing while a read says two secrets do.
  const replaced = await openSecret(deps, current.secret, aad(tenant.environmentId, id))
  if (!replaced) {
    throw new AuthError('webhook.rotation_refused', { reason: 'secret_unreadable' })
  }
  const secret = newSigningSecret()
  const sealed = {
    secret: await deps.secretBox.seal(
      WEBHOOK_SECRET_PURPOSE,
      new TextEncoder().encode(secret),
      aad(tenant.environmentId, id)
    ),
    previousSecret: await deps.secretBox.seal(
      WEBHOOK_SECRET_PURPOSE,
      replaced.sealable,
      previousAad(tenant.environmentId, id)
    ),
  }
  // The replaced secret was in the clear only to be sealed again.
  replaced.sealable.fill(0)
  // One reading of the clock for the rotation, its audit entry and the end of the overlap.
  const at = deps.clock.now()
  const previousSecretExpiresAt = new Date(at.getTime() + durationToMs(WEBHOOK_SECRET_OVERLAP))
  const rotated = await deps.webhookEndpoints.rotateSecret(
    tenant.environmentId,
    id,
    { expectedSecret: current.secret, ...sealed, previousSecretExpiresAt },
    at,
    {
      ...Audit.entry(deps, tenant, {
        type: 'webhook_endpoint.secret_rotated',
        actor,
        target: { type: 'webhook_endpoint', id },
        // A time, and nothing of either secret: not a prefix, not a fingerprint.
        data: { rotationOverlapEndsAt: previousSecretExpiresAt.toISOString() },
      }),
      occurredAt: at,
    }
  )
  if (!rotated) {
    // Not written: the endpoint was removed meanwhile, or another rotation got there first
    // (its secret is no longer the one read here, and a previous one now signs).
    await requireEndpoint(deps, tenant, id)
    throw new AuthError('webhook.rotation_refused', { reason: 'rotation_in_progress' })
  }
  return {
    ...view(rotated, at),
    rotationOverlapEndsAt: previousSecretExpiresAt.toISOString(),
    secret,
  }
}

/**
 * End a rotation's overlap now: the endpoint's previous secret stops signing at once and is
 * deleted.
 *
 * For a previous secret that has leaked (the usual reason a secret is rotated in a hurry):
 * once the receiver verifies with the new one, the old one should not stay good for the rest
 * of the day. It is also what makes another rotation possible straight away. Deliveries a
 * round is making when this is called may still carry the old secret's signature beside the
 * new one, for that round at most; that gives away nothing (whoever holds the old secret can
 * sign with it anyway) and what matters is done by the operator: taking the old secret out of
 * the receiver.
 *
 * @param deps - The endpoint store, ids and the clock.
 * @param tenant - The environment. An endpoint of another is not found.
 * @param id - The endpoint.
 * @param actor - Who ends it, for the audit log.
 * @returns The endpoint as it is now: one secret signs.
 * @throws NotFoundError when the environment has no endpoint with that id.
 * @throws AuthError `webhook.rotation_refused`, `params.reason` `no_rotation_in_progress`,
 *   when no previous secret is signing (none was ever kept, or its overlap is already over).
 */
export async function revokePreviousSecret(
  deps: Pick<Deps, 'webhookEndpoints' | 'ids' | 'clock'>,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  id: string,
  actor: Actor
): Promise<WebhookEndpoint> {
  const activity = Audit.entry(deps, tenant, {
    type: 'webhook_endpoint.previous_secret_revoked',
    actor,
    target: { type: 'webhook_endpoint', id },
  })
  const revoked = await deps.webhookEndpoints.revokePreviousSecret(
    tenant.environmentId,
    id,
    activity.occurredAt,
    activity
  )
  if (!revoked) {
    await requireEndpoint(deps, tenant, id)
    throw new AuthError('webhook.rotation_refused', { reason: 'no_rotation_in_progress' })
  }
  return view(revoked, activity.occurredAt)
}

/**
 * The fixed word, in `params.reason` of a `not_implemented` (501), with which an API instance
 * of a deployment whose worker is its own service (`WEBHOOK_WORKER=separate`) refuses a
 * request on demand: a test event, a delivery sent again.
 */
export const WEBHOOK_WORKER_SEPARATE_REASON = 'worker_separate'

/**
 * Refuse a request on demand in a process that does not deliver.
 *
 * With the worker separate, **no** request to a webhook endpoint leaves an API instance: that
 * is what an operator who separated the two for a network policy was promised, and a request
 * made from here anyway would fail against that policy and be written to the delivery log as
 * the receiver's failure. Handing the request to the worker is not built, which is what the
 * code says.
 *
 * Called twice for a request over HTTP. By the router, right after the key is checked and
 * before the send limit and the validators, so that an authenticated caller always gets
 * this answer and nothing is counted. And by {@link sendTest} and {@link redeliver} as
 * their first statement, before a store is read, so that no caller of the service can make
 * a request either, and the answer is the same for an endpoint that exists and one that
 * does not.
 *
 * @param deps - The configuration.
 * @throws NotImplementedError `not_implemented`, `params.reason` `worker_separate`.
 */
export function requireDeliveryHere(deps: Pick<Deps, 'config'>): void {
  if (!deps.config.deliversWebhooks) {
    throw new NotImplementedError({
      message:
        'This deployment sends webhooks from a separate worker (WEBHOOK_WORKER=separate). A test event or a delivery sent again cannot be asked of an API instance yet.',
      params: { reason: WEBHOOK_WORKER_SEPARATE_REASON },
    })
  }
}

type DeliveryDeps = Pick<
  Deps,
  | 'config'
  | 'environments'
  | 'webhookEndpoints'
  | 'webhookDeliveries'
  | 'outbound'
  | 'secretBox'
  | 'ids'
  | 'clock'
  | 'jitter'
>

/**
 * Whether a stored payload is an event of the contract and the one its row says it is.
 *
 * Rows recorded before the event contract hold `{ actor, target, data }` with no
 * `schemaVersion`: a shape no receiver was promised, so one is never sent.
 */
function isEvent(event: OutboxEvent): boolean {
  const { payload } = event
  return (
    typeof payload.schemaVersion === 'number' &&
    payload.id === event.id &&
    payload.type === event.type
  )
}

/** The endpoints an event is owed to: switched on, subscribed, and there when it happened. */
function recipients(
  endpoints: readonly WebhookEndpointRecord[],
  event: OutboxEvent
): WebhookEndpointRecord[] {
  return endpoints.filter(
    (endpoint) =>
      endpoint.enabled &&
      endpoint.eventTypes.includes(event.type) &&
      endpoint.createdAt.getTime() <= event.occurredAt.getTime()
  )
}

/** One of an endpoint's sealed secrets, opened; `null` when it cannot be (`openSigningSecret`). */
function openSecret(deps: Pick<Deps, 'secretBox'>, sealed: string, binding: string) {
  return openSigningSecret(deps.secretBox, WEBHOOK_SECRET_PURPOSE, sealed, binding)
}

/** The key of one sealed secret, or `null` when it cannot be opened or is no signing secret. */
async function openKey(
  deps: Pick<Deps, 'secretBox'>,
  sealed: string,
  binding: string
): Promise<Uint8Array<ArrayBuffer> | null> {
  return (await openSecret(deps, sealed, binding))?.key ?? null
}

/**
 * The signing keys of an endpoint, or `null` when its **current** secret cannot be opened or
 * read: then nothing is sent, as before rotation existed. The previous secret never signs
 * alone.
 *
 * @param deps - The secret box.
 * @param endpoint - The endpoint as stored.
 * @param now - The clock: a previous secret whose end has come is not opened at all.
 */
async function signingKeys(
  deps: Pick<Deps, 'secretBox'>,
  endpoint: WebhookEndpointRecord,
  now: Date
): Promise<SigningKeys | null> {
  const current = await openKey(deps, endpoint.secret, aad(endpoint.environmentId, endpoint.id))
  if (!current) {
    return null
  }
  const { previousSecret, previousSecretExpiresAt: expiresAt } = endpoint
  if (previousSecret === null || expiresAt === null || !overlapUnderWay(endpoint, now)) {
    return { current, previous: null, previousUnreadable: false }
  }
  const key = await openKey(deps, previousSecret, previousAad(endpoint.environmentId, endpoint.id))
  return { current, previous: key && { key, expiresAt }, previousUnreadable: key === null }
}

/** Said when an endpoint's previous secret should be signing and would not open. */
function warnPreviousUnreadable(endpoint: WebhookEndpointRecord): void {
  // The receiver may still hold only the previous secret, and will then refuse these
  // deliveries until it has the new one: worth a line, with ids and nothing else.
  logger.warn(
    'webhook previous signing secret could not be opened; deliveries to the endpoint carry the current secret’s signature only',
    { environmentId: endpoint.environmentId, endpointId: endpoint.id }
  )
}

/**
 * Make one signed request to an endpoint.
 *
 * The request goes through the outbound guard, which judges the address again now: what it
 * resolved to when it was saved says nothing about today. **Of the answer only the status is
 * looked at; its headers and body are dropped here and never leave this function.**
 * `Retry-After` is among what is dropped: the schedule is the server's own.
 *
 * **Signed in one place, `signedHeaders` (`~/lib/signing-secret`)**, which the worker, a test
 * event and a delivery sent again all reach through here: the current secret's signature and,
 * while its overlap lasts, the previous secret's after it.
 *
 * @param deps - The outbound guard's settings, ids and the clock.
 * @param url - The endpoint's address.
 * @param keys - Its signing keys: the current secret's, and the previous one's during an overlap.
 * @param id - The `webhook-id`: the event's id.
 * @param payload - The body, written out once: exactly that text is signed and sent.
 * @returns The request as an attempt: when, the status or the guard's word, how long.
 */
async function request(
  deps: Pick<Deps, 'outbound' | 'ids' | 'clock'>,
  url: string,
  keys: SigningKeys,
  id: string,
  payload: Record<string, unknown>
): Promise<NewWebhookAttempt> {
  const attemptedAt = deps.clock.now()
  const took = () => Math.max(0, deps.clock.now().getTime() - attemptedAt.getTime())
  const body = JSON.stringify(payload)
  try {
    const answer = await Outbound.request(deps.outbound, url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(await signedHeaders(keys, id, attemptedAt, body)),
      },
      body,
      timeoutMs: WEBHOOK_DELIVERY_TIMEOUT_MS,
      maxResponseBytes: WEBHOOK_MAX_RESPONSE_BYTES,
    })
    const { status } = answer
    return {
      id: deps.ids.next(),
      attemptedAt,
      statusCode: status,
      durationMs: took(),
      failureReason: null,
    }
  } catch (error) {
    if (error instanceof Outbound.OutboundError) {
      // An answer over the cap was still an answer, and its status line had arrived: the
      // receiver took the event (2xx) or did not, and that is what is recorded. Its body was
      // not read and is not looked at here either; the guard hands over the number alone.
      const answered = error.reason === 'response_too_large' && error.status !== undefined
      return {
        id: deps.ids.next(),
        attemptedAt,
        statusCode: answered ? (error.status ?? null) : null,
        durationMs: took(),
        failureReason: answered ? null : error.reason,
      }
    }
    throw error
  }
}

/** Any 2xx is a delivery. A redirect is an answer like any other and is never followed. */
function succeeded(attempt: NewWebhookAttempt): boolean {
  return attempt.statusCode !== null && attempt.statusCode >= 200 && attempt.statusCode < 300
}

/**
 * When to try again after the `made`th request of a delivery failed.
 *
 * @param deps - The clock and the jitter source.
 * @param made - How many requests the delivery has had, this one included.
 * @returns The schedule's wait, stretched by up to {@link WEBHOOK_RETRY_JITTER}, from now; or
 *   `null` when the delivery is out of attempts.
 */
export function nextAttemptAt(deps: Pick<Deps, 'clock' | 'jitter'>, made: number): Date | null {
  const delay = WEBHOOK_RETRY_DELAYS[made - 1]
  if (made >= WEBHOOK_MAX_ATTEMPTS || delay === undefined) {
    return null
  }
  // Clamped: a source that misbehaves can stretch a wait by a fifth and no more, and can
  // never shorten one.
  const drawn = deps.jitter()
  const spread =
    (Number.isFinite(drawn) ? Math.min(Math.max(drawn, 0), 1) : 0) * WEBHOOK_RETRY_JITTER
  return new Date(deps.clock.now().getTime() + Math.round(durationToMs(delay) * (1 + spread)))
}

/** The state of one environment's round that its lanes share. */
interface Round {
  environmentId: string
  report: DeliveryReport
  /** Out of budget, or the server is shutting down: either way what is left waits. */
  outOfTime: () => boolean
}

/**
 * Switch an endpoint off because of what its deliveries did. Recorded as the system's own act
 * (`webhook_endpoint.disabled`), which is also an event its environment's other endpoints can
 * subscribe to. Its pending deliveries are left pending: nothing is sent to an endpoint that
 * is off, and they are tried again if it is switched on before they grow too old.
 */
async function switchOff(
  deps: Pick<Deps, 'webhookEndpoints' | 'ids' | 'clock'>,
  round: Round,
  endpoint: WebhookEndpointRecord,
  reason: WebhookDisabledReason
): Promise<void> {
  const disabled = await deps.webhookEndpoints.disable(
    endpoint.environmentId,
    endpoint.id,
    reason,
    deps.clock.now(),
    Audit.entry(deps, endpoint, {
      type: 'webhook_endpoint.disabled',
      actor: systemActor(),
      target: { type: 'webhook_endpoint', id: endpoint.id },
      data: { reason },
    })
  )
  // Off for this lane whoever switched it: nothing more is sent to it this round.
  endpoint.enabled = false
  if (disabled) {
    round.report.disabled += 1
    logger.warn('webhook endpoint switched off by the server', {
      environmentId: endpoint.environmentId,
      endpointId: endpoint.id,
      reason,
    })
  }
}

/**
 * Record a request the worker made, and move the delivery, the endpoint's health and, when it
 * has kept failing, the endpoint itself.
 */
async function settle(
  deps: DeliveryDeps,
  round: Round,
  endpoint: WebhookEndpointRecord,
  delivery: WebhookDeliveryRecord,
  attempt: NewWebhookAttempt
): Promise<void> {
  const now = deps.clock.now()
  const delivered = succeeded(attempt)
  // 410 Gone is a receiver saying "stop": this delivery is not tried again.
  const gone = attempt.statusCode === 410
  const retryAt = delivered || gone ? null : nextAttemptAt(deps, delivery.attempts + 1)
  const next: DeliveryTransition = delivered
    ? { state: 'delivered', nextAttemptAt: null, completedAt: now }
    : retryAt
      ? { state: 'pending', nextAttemptAt: retryAt, completedAt: null }
      : { state: 'failed', nextAttemptAt: null, completedAt: now }
  // `null`: the delivery is gone (its endpoint was removed meanwhile) or another worker has
  // moved it on. Either way there is nothing more of it to record.
  const recorded = await deps.webhookDeliveries.recordAttempt(
    round.environmentId,
    delivery.id,
    attempt,
    next,
    'pending'
  )
  if (recorded === null) {
    return
  }
  round.report[delivered ? 'delivered' : 'undelivered'] += 1
  if (next.state === 'failed') {
    round.report.givenUp += 1
  }
  if (delivered) {
    await clearHealth(deps, endpoint)
    return
  }
  if (gone) {
    await switchOff(deps, round, endpoint, 'gone')
    return
  }
  await noteFailure(deps, round, endpoint, now)
}

/** How often {@link noteFailure} reads the endpoint again before it lets the failure go. */
const HEALTH_WRITE_TRIES = 3

/**
 * A request to an endpoint has just failed: continue its run of failures or begin one, and
 * switch the endpoint off if the run has lasted long enough.
 *
 * A failure continues the run only if the one before it was recent. After a silence longer
 * than the schedule itself, nothing says the endpoint stayed broken (it was sent nothing),
 * so this failure begins a run of its own: one bad day, a fix and a hiccup a week later are
 * two short runs, not one long one.
 *
 * The run is written **only over what was read** (`setHealth` compares). The lane read the
 * endpoint when it began; since then an administrator may have switched it on again or given
 * it another address, or a delivery sent again may have got through, and each of those ends
 * the run. Then the row is read again and the rule applied to what it holds now, so a run
 * that was reset is never brought back, and never switches off an endpoint that was just
 * reset.
 */
async function noteFailure(
  deps: Pick<Deps, 'webhookEndpoints' | 'ids' | 'clock'>,
  round: Round,
  endpoint: WebhookEndpointRecord,
  now: Date
): Promise<void> {
  for (let tries = 0; tries < HEALTH_WRITE_TRIES; tries++) {
    const read = { failingSince: endpoint.failingSince, lastFailedAt: endpoint.lastFailedAt }
    const continues =
      read.failingSince !== null &&
      read.lastFailedAt !== null &&
      now.getTime() - read.lastFailedAt.getTime() <= WEBHOOK_FAILURE_RUN_MAX_GAP_MS
    const failingSince = continues && read.failingSince ? read.failingSince : now
    const written = await deps.webhookEndpoints.setHealth(round.environmentId, endpoint.id, read, {
      failingSince,
      lastFailedAt: now,
    })
    if (written) {
      endpoint.failingSince = failingSince
      endpoint.lastFailedAt = now
      if (now.getTime() - failingSince.getTime() >= durationToMs(WEBHOOK_DISABLE_AFTER)) {
        await switchOff(deps, round, endpoint, 'failing')
      }
      return
    }
    const current = await deps.webhookEndpoints.find(round.environmentId, endpoint.id)
    if (!current) {
      // Removed meanwhile: there is no endpoint to keep a run for, and the lane ends.
      endpoint.enabled = false
      return
    }
    // Its run as it is now, and its switch: the lane sends nothing more to one that is off.
    endpoint.failingSince = current.failingSince
    endpoint.lastFailedAt = current.lastFailedAt
    endpoint.enabled = current.enabled
    if (!current.enabled) {
      return
    }
  }
  // Changed under the worker three times in a row. This one failure goes unrecorded on the
  // endpoint (it is on its delivery); the next one is judged afresh.
}

/** A request got through: whatever run of failures the endpoint had is over. */
async function clearHealth(
  deps: Pick<Deps, 'webhookEndpoints'>,
  endpoint: WebhookEndpointRecord
): Promise<void> {
  // Over whatever is there, read or not: a real event was taken, and that ends any run. An
  // endpoint with none on record is not written to at all.
  if (endpoint.failingSince !== null || endpoint.lastFailedAt !== null) {
    await deps.webhookEndpoints.setHealth(endpoint.environmentId, endpoint.id, null, {
      failingSince: null,
      lastFailedAt: null,
    })
    endpoint.failingSince = null
    endpoint.lastFailedAt = null
  }
}

/**
 * Serve one endpoint for one round: its due deliveries, the most overdue first, one request
 * at a time, at most {@link WEBHOOK_ENDPOINT_ROUND_CAP} of them.
 */
async function serveEndpoint(
  deps: DeliveryDeps,
  round: Round,
  endpoint: WebhookEndpointRecord
): Promise<void> {
  const { environmentId, report } = round
  const due = await deps.webhookDeliveries.due(
    environmentId,
    endpoint.id,
    deps.clock.now(),
    WEBHOOK_ENDPOINT_ROUND_CAP
  )
  if (due.length === 0) {
    return
  }
  const ids = (deliveries: readonly WebhookDeliveryRecord[]) => deliveries.map(({ id }) => id)
  const later = (wait: string) => new Date(deps.clock.now().getTime() + durationToMs(wait))
  const keys = await signingKeys(deps, endpoint, deps.clock.now())
  if (!keys) {
    // Most often a TULA_MASTER_KEY that is not the one the secret was sealed with, on this
    // instance or on all of them. The receiver did nothing wrong and was sent nothing, so no
    // attempt is counted against it; the deliveries wait, and are sent once the key is right.
    // Said once per endpoint per round, with the count, not once per event.
    const events = await deps.webhookDeliveries.defer(
      environmentId,
      ids(due),
      'signing_failed',
      later(WEBHOOK_SIGNING_RETRY_DELAY),
      deps.clock.now()
    )
    report.deferred += events
    logger.warn(
      'webhook signing secret could not be opened; nothing was sent to the endpoint this round',
      { environmentId, endpointId: endpoint.id, events }
    )
    return
  }
  if (keys.previousUnreadable) {
    // Once per endpoint per round, like the line above, and only when there is something to
    // send: the deliveries are made all the same.
    warnPreviousUnreadable(endpoint)
  }
  const events = new Map(
    (
      await deps.webhookDeliveries.eventsById(
        environmentId,
        due.flatMap(({ eventId }) => (eventId === null ? [] : [eventId]))
      )
    ).map((event) => [event.id, event])
  )
  for (const [index, delivery] of due.entries()) {
    if (round.outOfTime() || !endpoint.enabled) {
      // Left as they are: still due next round, with nothing counted.
      return
    }
    const event = delivery.eventId === null ? undefined : events.get(delivery.eventId)
    if (!event || !isEvent(event)) {
      // The event's row is gone, or is not something a receiver was promised: there is
      // nothing to send, now or later.
      report.givenUp += await deps.webhookDeliveries.giveUp(
        environmentId,
        [delivery.id],
        'event_gone',
        deps.clock.now()
      )
      continue
    }
    const attempt = await request(deps, endpoint.url, keys, event.id, event.payload)
    await settle(deps, round, endpoint, delivery, attempt)
    if (attempt.failureReason === 'timeout') {
      // The endpoint let a request run out its whole deadline. Waiting that long again for
      // each of the rest would spend the environment's budget on one endpoint, so the rest is
      // put off WITHOUT being tried: no request, no attempt counted, and a word on each that
      // says so. They are due again in a minute, by which time the one that timed out has
      // been tried again and shown whether the endpoint is back.
      report.deferred += await deps.webhookDeliveries.defer(
        environmentId,
        ids(due.slice(index + 1)),
        'endpoint_unresponsive',
        later(WEBHOOK_UNRESPONSIVE_DELAY),
        deps.clock.now()
      )
      return
    }
  }
}

/** Run `work` over `items`, at most `width` at a time; the first failure is thrown at the end. */
async function sideBySide<T>(
  items: readonly T[],
  width: number,
  work: (item: T) => Promise<void>
): Promise<void> {
  const queue = [...items]
  const failures: unknown[] = []
  const lane = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      try {
        await work(item)
      } catch (error) {
        // One endpoint's failure does not stop the lanes of the others.
        failures.push(error)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, queue.length) }, lane))
  if (failures.length > 0) {
    throw failures[0]
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
  const round: Round = {
    environmentId,
    report,
    outOfTime: () =>
      signal?.aborted === true ||
      deps.clock.now().getTime() - started >= WEBHOOK_ENVIRONMENT_BUDGET_MS,
  }
  await dropExpiredSecrets(deps, round)
  await settleUnowed(deps, round, new Date(started))
  await queueOwed(deps, round)
  await expireOld(deps, round)
  await deliverDue(deps, round)
}

/**
 * Delete the previous signing secrets of an environment's endpoints whose overlap has ended.
 *
 * They stopped signing at that end already (`signedHeaders` decides by the clock); this
 * only takes away a ciphertext nothing will open again, so that a secret an operator
 * replaced, perhaps because it leaked, is not kept in the database for good. Done here
 * because the round already visits every environment's endpoints every few seconds, whether
 * they are on or off and whether or not anything is due: one statement, and first, so that
 * nothing that goes wrong later in the round keeps an expired secret in place.
 */
async function dropExpiredSecrets(
  deps: Pick<Deps, 'webhookEndpoints' | 'clock'>,
  round: Round
): Promise<void> {
  round.report.secretsExpired += await deps.webhookEndpoints.clearExpiredPreviousSecrets(
    round.environmentId,
    deps.clock.now(),
    WEBHOOK_SECRET_CLEAR_BATCH
  )
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
async function settleUnowed(deps: DeliveryDeps, round: Round, started: Date): Promise<void> {
  const { environmentId, report } = round
  const registered = (await deps.webhookEndpoints.list(environmentId))
    .filter((endpoint) => endpoint.enabled)
    .map((endpoint) => endpoint.createdAt.getTime())
  const before = new Date(Math.min(started.getTime(), ...registered))
  for (let batch = 0; batch < WEBHOOK_MAX_SETTLE_BATCHES && !round.outOfTime(); batch++) {
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

/**
 * Turn one environment's waiting events into deliveries: a `pending` row for every endpoint
 * an event is owed to, and then the event is settled. **No request is made here**, so an
 * endpoint that is slow, failing or being retried never holds an event, or the events behind
 * it, in the outbox: once its deliveries exist the event is done with, and each delivery goes
 * its own way.
 */
async function queueOwed(deps: DeliveryDeps, round: Round): Promise<void> {
  const { environmentId, report } = round
  for (let batch = 0; batch < WEBHOOK_MAX_BATCHES && !round.outOfTime(); batch++) {
    const pending = await deps.webhookDeliveries.pendingEvents(environmentId, WEBHOOK_BATCH_SIZE)
    if (pending.length === 0) {
      return
    }
    // Read again for every batch: an endpoint switched off or removed stops being owed.
    const endpoints = await deps.webhookEndpoints.list(environmentId)
    const at = deps.clock.now()
    const owed: NewWebhookDelivery[] = []
    let skipped = 0
    for (const event of pending) {
      if (!isEvent(event)) {
        skipped += 1
        continue
      }
      for (const endpoint of recipients(endpoints, event)) {
        owed.push({
          id: deps.ids.next(),
          projectId: event.projectId,
          environmentId,
          endpointId: endpoint.id,
          eventId: event.id,
          eventType: event.type,
          at,
        })
      }
    }
    // A delivery that already has its row (a round that ended between queueing and settling)
    // is left as it is, and one whose endpoint was removed meanwhile is not written.
    report.queued += await deps.webhookDeliveries.enqueue(owed)
    report.events += await deps.webhookDeliveries.markDelivered(
      environmentId,
      pending.map((event) => event.id),
      at
    )
    report.skipped += skipped
    if (pending.length < WEBHOOK_BATCH_SIZE) {
      return
    }
  }
}

/**
 * Give up the deliveries of an environment that have waited longer than
 * {@link WEBHOOK_DELIVERY_MAX_AGE}, whatever kept them waiting. This is what makes sure that
 * nothing waits for ever: a delivery put off again and again without a request being made, and
 * one whose endpoint is switched off, both end here.
 */
async function expireOld(deps: DeliveryDeps, round: Round): Promise<void> {
  const before = new Date(deps.clock.now().getTime() - durationToMs(WEBHOOK_DELIVERY_MAX_AGE))
  for (let batch = 0; batch < WEBHOOK_MAX_EXPIRE_BATCHES && !round.outOfTime(); batch++) {
    const expired = await deps.webhookDeliveries.expire(
      round.environmentId,
      before,
      deps.clock.now(),
      WEBHOOK_EXPIRE_BATCH_SIZE
    )
    round.report.givenUp += expired
    if (expired < WEBHOOK_EXPIRE_BATCH_SIZE) {
      return
    }
  }
}

/** Make the requests that are due in one environment, its endpoints side by side. */
async function deliverDue(deps: DeliveryDeps, round: Round): Promise<void> {
  const endpoints = (await deps.webhookEndpoints.list(round.environmentId)).filter(
    (endpoint) => endpoint.enabled
  )
  await sideBySide(endpoints, WEBHOOK_MAX_CONCURRENT_DELIVERIES, (endpoint) =>
    serveEndpoint(deps, round, endpoint)
  )
}

/**
 * One round of webhook delivery, in every environment.
 *
 * Per environment, in this order:
 *
 * 0. Previous signing secrets whose rotation's overlap has ended are deleted from their rows
 *    (they stopped signing at that end, by the clock; see {@link rotateSecret}).
 * 1. Events owed to nobody (from before the earliest endpoint that is on) are settled in bulk.
 * 2. Every other waiting event becomes one `pending` delivery per endpoint it is **owed** to
 *    (switched on, subscribed to its type, registered no later than it happened), and is then
 *    settled. An event is settled once its deliveries exist, not once they have succeeded: a
 *    failing endpoint never holds the outbox.
 * 3. Deliveries that have been pending longer than {@link WEBHOOK_DELIVERY_MAX_AGE} are given up.
 * 4. The deliveries that are due are sent, signed: the endpoints side by side (at most
 *    {@link WEBHOOK_MAX_CONCURRENT_DELIVERIES} requests at once), each endpoint one request at
 *    a time and at most {@link WEBHOOK_ENDPOINT_ROUND_CAP} a round. A 2xx is a delivery.
 *    Anything else is tried again by {@link WEBHOOK_RETRY_DELAYS}, up to
 *    {@link WEBHOOK_MAX_ATTEMPTS} requests, and then given up; a `410` is given up at once and
 *    switches the endpoint off, as does a run of failed requests
 *    {@link WEBHOOK_DISABLE_AFTER} long (no success, and no silence longer than
 *    {@link WEBHOOK_FAILURE_RUN_MAX_GAP_MS}).
 *
 * Delivery is at least once: a round that ends between a request and its record sends again,
 * with the same event id, and the request that was not recorded is not counted.
 *
 * Two things put a delivery off **without a request and without counting an attempt**: an
 * endpoint that has just let another delivery run out its deadline (`endpoint_unresponsive`),
 * and an endpoint whose secret cannot be opened (`signing_failed`, logged once per endpoint
 * per round).
 *
 * A failure in one environment is logged and skipped, and each environment has a time budget
 * ({@link WEBHOOK_ENVIRONMENT_BUDGET_MS}), so neither a broken nor a slow one keeps the
 * environments after it from being served.
 *
 * In a process that does not deliver (`config.deliversWebhooks` is `false`: an API instance of
 * a deployment whose worker is its own service) it does none of this: nothing is read, queued,
 * settled or sent, and the report is all zeros. The queueing is the worker's as much as the
 * requests are; an API instance that queued would be a second place that decides what is owed.
 *
 * @param deps - The configuration, environments, the webhook stores, the outbound guard's
 *   settings, the secret box, ids, the clock and the jitter source.
 * @param signal - Aborted to end the round early (the server is shutting down): the requests
 *   under way are finished and recorded, nothing further is sent, and what is left waits for
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
    queued: 0,
    delivered: 0,
    undelivered: 0,
    deferred: 0,
    givenUp: 0,
    disabled: 0,
    secretsExpired: 0,
    skipped: 0,
  }
  if (!deps.config.deliversWebhooks) {
    return report
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
 * Run a delivery round, unless one is running: here or in another process.
 *
 * Called on boot and every {@link WEBHOOK_DELIVERY_INTERVAL_MS} by every process that delivers
 * (`startJobs` in `~/jobs`: every API instance, or every worker when the worker is its own
 * service); the job lock lets one of them through, and a round that is still running when the
 * next one is due is not started twice. Logs one line per round that did something, with
 * counts only.
 *
 * A process that does not deliver never starts the timer. Called there anyway it does nothing
 * and does not take the lock, which a worker may be asking for at that moment.
 *
 * @param deps - Everything {@link deliverPending} needs, plus the job lock.
 * @param signal - Aborted to end the round early; see {@link deliverPending}.
 * @returns The round's report, or `null` when the lock was held or this process does not
 *   deliver (nothing is logged).
 * @throws When the lock or the list of environments cannot be read (the database is down).
 */
export async function run(
  deps: DeliveryDeps & Pick<Deps, 'jobLock'>,
  signal?: AbortSignal
): Promise<DeliveryReport | null> {
  if (!deps.config.deliversWebhooks) {
    return null
  }
  const outcome = await deps.jobLock.runExclusive('webhook_delivery', () =>
    deliverPending(deps, signal)
  )
  if (!outcome.ran) {
    return null
  }
  const report = outcome.value
  const did =
    report.events +
    report.queued +
    report.delivered +
    report.deferred +
    report.givenUp +
    report.secretsExpired
  // An idle round is routine and frequent; one that sent something, or could not, is worth a
  // line.
  const log =
    report.failed > 0 || report.undelivered > 0 || report.disabled > 0
      ? logger.warn
      : did > 0
        ? logger.info
        : logger.debug
  log('webhook delivery round finished', { ...report })
  return report
}

/** The public view of a stored delivery. */
function viewDelivery(record: WebhookDeliveryRecord): WebhookDelivery {
  return {
    id: record.id,
    endpointId: record.endpointId,
    eventId: record.eventId,
    eventType: record.eventType,
    test: record.test,
    state: record.state,
    attemptCount: record.attempts,
    nextAttemptAt: record.nextAttemptAt?.toISOString() ?? null,
    lastAttemptAt: record.lastAttemptAt?.toISOString() ?? null,
    statusCode: record.statusCode,
    failureReason: record.failureReason,
    completedAt: record.completedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
  }
}

/** Filters and paging of {@link listDeliveries}. */
export interface DeliveryListInput {
  state?: WebhookDeliveryState
  eventType?: string
  page?: number
  size?: number
}

/**
 * List the deliveries of one endpoint, newest first, one page at a time.
 *
 * @param deps - The webhook stores.
 * @param tenant - The environment.
 * @param endpointId - The endpoint.
 * @param input - Filters and paging (defaults: page 1, 20 per page).
 * @returns The page and its paging details. `totalCount` is counted no further than
 *   {@link WEBHOOK_DELIVERY_LIST_WINDOW}.
 * @throws NotFoundError when the environment has no endpoint with that id.
 */
export async function listDeliveries(
  deps: Pick<Deps, 'webhookEndpoints' | 'webhookDeliveries'>,
  tenant: Pick<Tenant, 'environmentId'>,
  endpointId: string,
  input: DeliveryListInput = {}
): Promise<WebhookDeliveryList> {
  await requireEndpoint(deps, tenant, endpointId)
  const page = input.page ?? 1
  const perPage = input.size ?? DEFAULT_PAGE_SIZE
  const { deliveries, totalCount } = await deps.webhookDeliveries.list(
    tenant.environmentId,
    endpointId,
    {
      state: input.state,
      eventType: input.eventType,
      page,
      perPage,
      maxCount: WEBHOOK_DELIVERY_LIST_WINDOW,
    }
  )
  return {
    meta: { totalCount, totalPages: Math.ceil(totalCount / perPage), page, perPage },
    data: deliveries.map(viewDelivery),
  }
}

/**
 * Read one delivery of one endpoint, with every request made for it.
 *
 * @param deps - The delivery store.
 * @param tenant - The environment.
 * @param endpointId - The endpoint.
 * @param deliveryId - The delivery.
 * @returns The delivery and its attempts, oldest first.
 * @throws NotFoundError when that endpoint of this environment has no such delivery.
 */
export async function getDelivery(
  deps: Pick<Deps, 'webhookDeliveries'>,
  tenant: Pick<Tenant, 'environmentId'>,
  endpointId: string,
  deliveryId: string
): Promise<WebhookDeliveryDetail> {
  const found = await deps.webhookDeliveries.find(tenant.environmentId, endpointId, deliveryId)
  if (!found) {
    throw new NotFoundError()
  }
  return {
    ...viewDelivery(found.delivery),
    attempts: found.attempts.map((attempt) => ({
      attempt: attempt.attempt,
      attemptedAt: attempt.attemptedAt.toISOString(),
      statusCode: attempt.statusCode,
      durationMs: attempt.durationMs,
      failureReason: attempt.failureReason,
    })),
  }
}

type SendDeps = Pick<
  Deps,
  'config' | 'webhookEndpoints' | 'webhookDeliveries' | 'outbound' | 'secretBox' | 'ids' | 'clock'
>

/** What a request made on demand came to, in the terms of the admin API. */
function sendResult(deliveryId: string, attempt: NewWebhookAttempt): WebhookSendResult {
  return {
    deliveryId,
    outcome: succeeded(attempt) ? 'delivered' : 'failed',
    statusCode: attempt.statusCode,
    durationMs: attempt.durationMs,
    failureReason: attempt.failureReason,
  }
}

/**
 * Send a test event to one endpoint, now.
 *
 * The event is the contract's example of the chosen type with a new id, the time of the call
 * and **`test: true`**: a real, signed delivery that a receiver can tell from a real event by
 * a field inside the signed body. Nothing it describes happened, and nothing is written to
 * the outbox or the audit log: the delivery row, flagged as a test, is the record.
 *
 * It goes through the outbound guard like every delivery, is one request with no retry, and
 * **changes nothing about the endpoint, whichever way it ends**: a failed test does not count
 * towards switching it off, a `410` to a test does not either, and a test that gets through
 * does **not** end a run of failures. It is not the delivery of an event, and a receiver may
 * well answer tests without doing what it does for a real one; only a real event getting
 * through (the worker's, or one sent again) says the endpoint works. An endpoint that is switched off can be tested (that
 * is how an operator finds out whether to switch it back on).
 *
 * @param deps - The webhook stores, the outbound guard's settings, the secret box, ids, clock.
 * @param tenant - The environment.
 * @param endpointId - The endpoint.
 * @param input - The type of the example event.
 * @returns The outcome: a status code and a duration, or one of the server's fixed words.
 *   Nothing else of the receiver's answer.
 * @throws NotFoundError when the environment has no endpoint with that id, or it was removed
 *   while the test was under way.
 * @throws NotImplementedError `not_implemented`, `params.reason` `worker_separate`, in an API
 *   instance of a deployment whose worker is its own service: nothing is read or sent.
 */
export async function sendTest(
  deps: SendDeps,
  tenant: Pick<Tenant, 'environmentId'>,
  endpointId: string,
  input: SendTestWebhookRequest
): Promise<WebhookSendResult> {
  requireDeliveryHere(deps)
  const endpoint = await requireEndpoint(deps, tenant, endpointId)
  const createdAt = deps.clock.now()
  const keys = await signingKeys(deps, endpoint, createdAt)
  if (keys?.previousUnreadable) {
    warnPreviousUnreadable(endpoint)
  }
  // With no key nothing is sent, and what is recorded says so: a delivery with no attempt.
  // An id of its own, so a receiver that drops repeats by id takes every test.
  const eventId = deps.ids.next()
  const attempt = keys
    ? await request(deps, endpoint.url, keys, eventId, {
        ...EVENT_FIXTURES[input.eventType],
        id: eventId,
        occurredAt: createdAt.toISOString(),
        test: true,
      })
    : null
  const delivery: WebhookDeliveryRecord = {
    id: deps.ids.next(),
    projectId: endpoint.projectId,
    environmentId: endpoint.environmentId,
    endpointId: endpoint.id,
    eventId: null,
    eventType: input.eventType,
    test: true,
    state: attempt && succeeded(attempt) ? 'delivered' : 'failed',
    attempts: attempt ? 1 : 0,
    nextAttemptAt: null,
    lastAttemptAt: attempt?.attemptedAt ?? null,
    statusCode: attempt?.statusCode ?? null,
    failureReason: attempt ? attempt.failureReason : 'signing_failed',
    completedAt: deps.clock.now(),
    createdAt,
  }
  if (!(await deps.webhookDeliveries.recordTest(delivery, attempt))) {
    throw new NotFoundError()
  }
  return attempt
    ? sendResult(delivery.id, attempt)
    : {
        deliveryId: delivery.id,
        outcome: 'failed',
        statusCode: null,
        durationMs: 0,
        failureReason: 'signing_failed',
      }
}

/**
 * Send a past delivery again, now: one more request for the event's stored payload, to the
 * endpoint it was owed to, with the same `webhook-id`.
 *
 * The request is appended to the delivery's own log as its next attempt; no second delivery is
 * made, so the log stays one honest list of what was sent. A 2xx makes the delivery
 * `delivered`. A failure leaves its state as it was and is **not** retried: this is one
 * request an administrator asked for, not a new run of the schedule.
 *
 * Refused for a delivery that is still `pending` (the worker will send it), for an endpoint
 * that is switched off, for a test event (it has no stored event), for an event that is past
 * its retention period, and for a delivery that has had {@link WEBHOOK_MAX_TOTAL_ATTEMPTS}
 * requests. Not audited: it changes nothing about who can do what, and the attempt is its
 * record.
 *
 * **What it does to the endpoint's health.** A request that gets through ends the endpoint's
 * run of failures (`failingSince`, `lastFailedAt`): the receiver took a real event, which is
 * exactly what the run says it has not been doing. A request that fails moves nothing, and
 * neither it nor a `410` switches the endpoint off: one request made by hand is not the
 * worker's evidence.
 *
 * @param deps - The webhook stores, the outbound guard's settings, the secret box, ids, clock.
 * @param tenant - The environment. A delivery of another environment is not found.
 * @param endpointId - The endpoint the delivery is of.
 * @param deliveryId - The delivery.
 * @returns The outcome: a status code and a duration, or one of the server's fixed words.
 * @throws NotFoundError when that endpoint of this environment has no such delivery.
 * @throws AuthError `webhook.cannot_redeliver`, with `params.reason` one of
 *   `delivery_pending`, `endpoint_disabled`, `event_gone` and `attempt_limit`.
 * @throws NotImplementedError `not_implemented`, `params.reason` `worker_separate`, in an API
 *   instance of a deployment whose worker is its own service: nothing is read or sent.
 */
export async function redeliver(
  deps: SendDeps,
  tenant: Pick<Tenant, 'environmentId'>,
  endpointId: string,
  deliveryId: string
): Promise<WebhookSendResult> {
  requireDeliveryHere(deps)
  const { environmentId } = tenant
  const found = await deps.webhookDeliveries.find(environmentId, endpointId, deliveryId)
  if (!found) {
    throw new NotFoundError()
  }
  const { delivery } = found
  const endpoint = await requireEndpoint(deps, tenant, endpointId)
  if (!endpoint.enabled) {
    throw new AuthError('webhook.cannot_redeliver', { reason: 'endpoint_disabled' })
  }
  if (delivery.state === 'pending') {
    throw new AuthError('webhook.cannot_redeliver', { reason: 'delivery_pending' })
  }
  if (delivery.attempts >= WEBHOOK_MAX_TOTAL_ATTEMPTS) {
    throw new AuthError('webhook.cannot_redeliver', { reason: 'attempt_limit' })
  }
  // Read inside this environment: an id from anywhere else finds nothing.
  const [event] =
    delivery.eventId === null
      ? []
      : await deps.webhookDeliveries.eventsById(environmentId, [delivery.eventId])
  if (!event || !isEvent(event)) {
    throw new AuthError('webhook.cannot_redeliver', { reason: 'event_gone' })
  }
  const keys = await signingKeys(deps, endpoint, deps.clock.now())
  if (!keys) {
    // The server's fault, and nothing was sent: said to the caller, and to the log once.
    logger.warn('webhook signing secret could not be opened; nothing was sent', {
      environmentId,
      endpointId,
    })
    return {
      deliveryId,
      outcome: 'failed',
      statusCode: null,
      durationMs: 0,
      failureReason: 'signing_failed',
    }
  }
  if (keys.previousUnreadable) {
    warnPreviousUnreadable(endpoint)
  }
  const attempt = await request(deps, endpoint.url, keys, event.id, event.payload)
  const delivered = succeeded(attempt)
  const recorded = await deps.webhookDeliveries.recordAttempt(
    environmentId,
    deliveryId,
    attempt,
    delivered ? { state: 'delivered', nextAttemptAt: null, completedAt: deps.clock.now() } : null,
    'ended'
  )
  if (recorded === null) {
    // Removed with its endpoint while the request was under way.
    throw new NotFoundError()
  }
  if (delivered) {
    // The receiver took a real event: its run of failures, if it had one, is over. (A
    // failure here moves nothing: one request an administrator asked for is not evidence of
    // a run. And a test event never clears a run, got through or not: see `sendTest`.)
    await clearHealth(deps, endpoint)
  }
  return sendResult(deliveryId, attempt)
}
