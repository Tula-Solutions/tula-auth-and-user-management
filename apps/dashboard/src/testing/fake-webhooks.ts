import {
  CreateWebhookEndpointRequestSchema,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_WEBHOOK_ENDPOINTS,
  SendTestWebhookRequestSchema,
  UpdateWebhookEndpointRequestSchema,
  WEBHOOK_DELIVERY_STATES,
} from '@tula/contract'
import { ACTIVITY_TYPES } from '@tula/contract/event-types'
import { z } from 'zod'
import { type FakeCall, type FakeHandler, failure, IDS } from './fake-api'

// The fake API's webhook routes (`/v1/admin/webhook-endpoints`): the shapes, the refusals and
// the error codes of `apps/api/src/modules/webhook`, on plain in-memory data. No request is
// ever made: what a receiver "answers" is `FakeWebhookState.webhookReceiver`.
//
// Held to the API by `fake-webhooks.test.ts`: what is refused before anything is looked up
// (an id that is no UUID, an unknown filter, a page past the window, a body the contract's
// strict schemas refuse: 422 `validation.failed`, with the field), a count that stops at the
// window, a change that changes nothing (nothing moves, `updatedAt` included), the health
// that is reset only by a real switch-on or a real change of address, the guard that judges
// only an address that changes, an overlap that is over when the clock (`webhookNow`) says
// so, and what a delivery sent again records.
//
// Where it still differs from the API, on purpose:
// - No rate limit: neither the admin API's nor the one on test events and deliveries sent
//   again. A test that needs a 429 overrides the route.
// - No secret is sealed or opened, so there is no `secret_unreadable` refusal of a rotation
//   and no `signing_failed` outcome of a request on demand. A test overrides the route.
// - `event_gone` is answered only for a delivery whose `eventId` is `null`. The API also
//   answers it when the event's row is past its retention; the fake keeps no events.
// - The outbound guard is four fixed rules on the address's text (`refusedAddress`), enough
//   to produce each of its words; nothing is resolved.
// - One clock (`webhookNow`) that only a test moves; no worker, so nothing is ever retried,
//   given up or switched off by the server here. A test writes such a state itself.
// - `disabledReason` is whatever a test wrote: the fake never sets one.
// - An environment that does not exist is not a 404 here (the shell's own routes decide
//   that): an endpoint is simply not found under it.

const NOW = '2026-10-04T12:00:00.000Z'
const ENVIRONMENT = 'x-tula-environment'

/** `WEBHOOK_DELIVERY_LIST_WINDOW` of the API's webhook service. */
const DELIVERY_LIST_WINDOW = 10_000
/** `WEBHOOK_MAX_TOTAL_ATTEMPTS` of the API's webhook service. */
const MAX_TOTAL_ATTEMPTS = 20
/** `WEBHOOK_SECRET_OVERLAP` of the API's webhook service, in milliseconds. */
const SECRET_OVERLAP_MS = 24 * 60 * 60 * 1000

// The API's own request schemas (`apps/api/src/modules/webhook/schema.ts`), which are not in
// the contract. The bodies' are, and are used as they are.
const EndpointParams = z.object({ id: z.uuid() })
const DeliveryParams = z.object({ id: z.uuid(), deliveryId: z.uuid() })
const DeliveryQuery = z
  .object({
    state: z.enum(WEBHOOK_DELIVERY_STATES).optional(),
    eventType: z.enum(ACTIVITY_TYPES).optional(),
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    size: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  })
  .refine((query) => query.page * query.size <= DELIVERY_LIST_WINDOW, {
    path: ['page'],
    message: `The delivery log is paged through its newest ${DELIVERY_LIST_WINDOW} deliveries. Narrow it with state or eventType.`,
  })

/** A webhook endpoint as the fake holds it: the API's view, plus the environment it is in. */
export interface FakeWebhookEndpoint {
  id: string
  environmentId: string
  url: string
  eventTypes: string[]
  enabled: boolean
  disabledReason: string | null
  failingSince: string | null
  lastFailedAt: string | null
  /** When the previous secret stops signing, as stored: past it, the view says `null`. */
  rotationOverlapEndsAt: string | null
  createdAt: string
  updatedAt: string
}

/** One request made for a delivery, as the API lists it. */
export interface FakeWebhookAttempt {
  attempt: number
  attemptedAt: string
  statusCode: number | null
  durationMs: number
  failureReason: string | null
}

/** A delivery with its attempts, as the fake holds it. */
export interface FakeWebhookDelivery {
  id: string
  endpointId: string
  eventId: string | null
  eventType: string
  test: boolean
  state: string
  attemptCount: number
  nextAttemptAt: string | null
  lastAttemptAt: string | null
  statusCode: number | null
  failureReason: string | null
  completedAt: string | null
  createdAt: string
  attempts: FakeWebhookAttempt[]
}

/** The part of the fake's state the webhook routes work on. */
export interface FakeWebhookState {
  /** Every environment's webhook endpoints, oldest first. */
  webhookEndpoints: FakeWebhookEndpoint[]
  /** Every endpoint's deliveries, newest first. */
  webhookDeliveries: FakeWebhookDelivery[]
  /** How a request made on demand (a test event, a delivery sent again) ends. */
  webhookReceiver: { statusCode: number | null; durationMs: number; failureReason: string | null }
  /** The server's clock, as the webhook routes read it. Only a test moves it. */
  webhookNow: string
}

let made = 0

function nextId(kind: 'a' | 'b' | 'c'): string {
  made += 1
  return `00000000-0000-7000-8000-${kind}${String(made).padStart(11, '0')}`
}

/**
 * A webhook endpoint for a test to put in the fake's state: switched on, healthy, in the
 * development environment, subscribed to two types.
 *
 * @param overrides - What differs.
 * @returns The endpoint.
 */
export function fakeWebhookEndpoint(
  overrides: Partial<FakeWebhookEndpoint> = {}
): FakeWebhookEndpoint {
  return {
    id: nextId('a'),
    environmentId: IDS.development,
    url: 'https://api.example.com/webhooks/tula',
    eventTypes: ['user.created', 'session.revoked'],
    enabled: true,
    disabledReason: null,
    failingSince: null,
    lastFailedAt: null,
    rotationOverlapEndsAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

/**
 * A delivery for a test to put in the fake's state: of a real event, delivered at the first
 * request unless `attempts` says otherwise.
 *
 * @param endpointId - The endpoint it was owed to.
 * @param overrides - What differs.
 * @returns The delivery.
 */
export function fakeWebhookDelivery(
  endpointId: string,
  overrides: Partial<FakeWebhookDelivery> = {}
): FakeWebhookDelivery {
  const attempts = overrides.attempts ?? [
    { attempt: 1, attemptedAt: NOW, statusCode: 204, durationMs: 41, failureReason: null },
  ]
  const last = attempts.at(-1)
  return {
    id: nextId('b'),
    endpointId,
    eventId: nextId('c'),
    eventType: 'user.created',
    test: false,
    state: 'delivered',
    attemptCount: attempts.length,
    nextAttemptAt: null,
    lastAttemptAt: last?.attemptedAt ?? null,
    statusCode: last?.statusCode ?? null,
    failureReason: last?.failureReason ?? null,
    completedAt: NOW,
    createdAt: NOW,
    ...overrides,
    attempts,
  }
}

/** What the outbound guard says of an address: the word it is refused with, or nothing. */
export function refusedAddress(url: string): string | null {
  if (!URL.canParse(url)) {
    return 'invalid_url'
  }
  const parsed = new URL(url)
  if (parsed.username !== '' || parsed.password !== '') {
    return 'invalid_url'
  }
  if (parsed.protocol !== 'https:') {
    return 'scheme_not_allowed'
  }
  if (parsed.hostname === 'localhost' || /^(10|127)\./.test(parsed.hostname)) {
    return 'address_not_allowed'
  }
  return parsed.hostname.endsWith('.invalid') ? 'resolve_failed' : null
}

function refused(status: number, code: string, detail: string, reason: string): Response {
  return failure(status, code, detail, undefined, { reason })
}

function refusedUrl(reason: string): Response {
  return refused(
    422,
    'webhook.url_not_allowed',
    'The server cannot deliver to that address.',
    reason
  )
}

function notFound(): Response {
  return failure(404, 'resource.not_found', 'The requested resource does not exist.')
}

/** The API's answer to a path, a query or a body its schema refuses: one entry per issue. */
export function invalid(error: z.ZodError): Response {
  return failure(
    422,
    'validation.failed',
    'The request is not valid.',
    error.issues.map((issue) => ({
      field: issue.path.map(String).join('.') || '(root)',
      code: 'validation.failed',
      message: issue.message,
    }))
  )
}

function viewDelivery({ attempts: _attempts, ...delivery }: FakeWebhookDelivery) {
  return delivery
}

function secretAnswer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

function sameTypes(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((type) => b.includes(type))
}

/**
 * The webhook routes of the fake API.
 *
 * @param state - The fake's state; the routes read and change its webhook part.
 * @returns The routes, in the fake's own table format.
 */
export function webhookRoutes(state: FakeWebhookState): [string, RegExp, FakeHandler][] {
  let secrets = 0

  /** A new signing secret in the server's format. A test value that signs nothing. */
  function signingSecret(): string {
    secrets += 1
    return `whsec_ZmFrZXNpZ25pbmdzZWNyZXRmb3J0ZXN0c29ubHk${secrets}`
  }

  /** Whether a previous secret still signs: decided by the clock, as the API decides it. */
  function overlapUnderWay(endpoint: FakeWebhookEndpoint): boolean {
    return (
      endpoint.rotationOverlapEndsAt !== null &&
      Date.parse(state.webhookNow) < Date.parse(endpoint.rotationOverlapEndsAt)
    )
  }

  function viewEndpoint(held: FakeWebhookEndpoint) {
    const { environmentId: _environmentId, ...endpoint } = held
    return {
      ...endpoint,
      rotationOverlapEndsAt: overlapUnderWay(held) ? held.rotationOverlapEndsAt : null,
    }
  }

  function endpointOf(call: FakeCall, id: string): FakeWebhookEndpoint | undefined {
    return state.webhookEndpoints.find(
      (entry) => entry.id === id && entry.environmentId === call.headers.get(ENVIRONMENT)
    )
  }

  /**
   * A route on one endpoint: the path's id is checked as the API checks it, then the body
   * (when the route has one), and only then is anything looked up.
   */
  function onEndpoint<Body>(
    body: z.ZodType<Body> | null,
    handler: (endpoint: FakeWebhookEndpoint, body: Body, call: FakeCall) => Response | unknown
  ): FakeHandler {
    return (call, match) => {
      const params = EndpointParams.safeParse({ id: match[1] })
      if (!params.success) {
        return invalid(params.error)
      }
      const given = body === null ? null : body.safeParse(call.body ?? {})
      if (given && !given.success) {
        return invalid(given.error)
      }
      const endpoint = endpointOf(call, params.data.id)
      return endpoint ? handler(endpoint, given?.data as Body, call) : notFound()
    }
  }

  /** A route on one delivery of one endpoint, both checked and both looked up. */
  function onDelivery(
    handler: (endpoint: FakeWebhookEndpoint, delivery: FakeWebhookDelivery) => Response | unknown
  ): FakeHandler {
    return (call, match) => {
      const params = DeliveryParams.safeParse({ id: match[1], deliveryId: match[2] })
      if (!params.success) {
        return invalid(params.error)
      }
      const endpoint = endpointOf(call, params.data.id)
      const delivery = state.webhookDeliveries.find(
        (entry) => entry.id === params.data.deliveryId && entry.endpointId === endpoint?.id
      )
      return endpoint && delivery ? handler(endpoint, delivery) : notFound()
    }
  }

  /**
   * Make one request on demand and record it as the delivery's next attempt, as the
   * delivery store's `recordAttempt` does: the count, when, and how it ended always; the
   * state and when the delivery ended only when the request got through.
   */
  function attemptNow(delivery: FakeWebhookDelivery) {
    const { statusCode, durationMs, failureReason } = state.webhookReceiver
    const delivered = statusCode !== null && statusCode >= 200 && statusCode < 300
    delivery.attemptCount += 1
    delivery.attempts.push({
      attempt: delivery.attemptCount,
      attemptedAt: state.webhookNow,
      statusCode,
      durationMs,
      failureReason,
    })
    delivery.lastAttemptAt = state.webhookNow
    delivery.statusCode = statusCode
    delivery.failureReason = failureReason
    if (delivered) {
      delivery.state = 'delivered'
      delivery.nextAttemptAt = null
      delivery.completedAt = state.webhookNow
    }
    return {
      deliveryId: delivery.id,
      outcome: delivered ? 'delivered' : 'failed',
      statusCode,
      durationMs,
      failureReason,
    }
  }

  return [
    [
      'GET',
      /^\/v1\/admin\/webhook-endpoints$/,
      (call) => ({
        data: state.webhookEndpoints
          .filter((entry) => entry.environmentId === call.headers.get(ENVIRONMENT))
          .map(viewEndpoint),
      }),
    ],
    [
      'POST',
      /^\/v1\/admin\/webhook-endpoints$/,
      (call) => {
        const body = CreateWebhookEndpointRequestSchema.safeParse(call.body ?? {})
        if (!body.success) {
          return invalid(body.error)
        }
        const environmentId = call.headers.get(ENVIRONMENT) ?? ''
        // The address is judged before the cap is counted.
        const reason = refusedAddress(body.data.url)
        if (reason !== null) {
          return refusedUrl(reason)
        }
        const held = state.webhookEndpoints.filter((entry) => entry.environmentId === environmentId)
        if (held.length >= MAX_WEBHOOK_ENDPOINTS) {
          return failure(
            409,
            'resource.conflict',
            `This environment already has ${MAX_WEBHOOK_ENDPOINTS} webhook endpoints. Remove one first.`,
            undefined,
            { max: MAX_WEBHOOK_ENDPOINTS }
          )
        }
        const endpoint = fakeWebhookEndpoint({
          environmentId,
          url: body.data.url,
          eventTypes: body.data.eventTypes,
          enabled: body.data.enabled,
          createdAt: state.webhookNow,
          updatedAt: state.webhookNow,
        })
        state.webhookEndpoints.push(endpoint)
        return secretAnswer(201, { ...viewEndpoint(endpoint), secret: signingSecret() })
      },
    ],
    ['GET', /^\/v1\/admin\/webhook-endpoints\/([^/]+)$/, onEndpoint(null, viewEndpoint)],
    [
      'PATCH',
      /^\/v1\/admin\/webhook-endpoints\/([^/]+)$/,
      onEndpoint(UpdateWebhookEndpointRequestSchema, (endpoint, body) => {
        // Only what differs is a change, and only a changed address is judged.
        const changes: Partial<Pick<FakeWebhookEndpoint, 'url' | 'eventTypes' | 'enabled'>> = {}
        if (body.url !== undefined && body.url !== endpoint.url) {
          const reason = refusedAddress(body.url)
          if (reason !== null) {
            return refusedUrl(reason)
          }
          changes.url = body.url
        }
        if (body.eventTypes !== undefined && !sameTypes(body.eventTypes, endpoint.eventTypes)) {
          changes.eventTypes = [...body.eventTypes]
        }
        if (body.enabled !== undefined && body.enabled !== endpoint.enabled) {
          changes.enabled = body.enabled
        }
        // A request that changes nothing writes nothing: not even when it was last changed.
        if (Object.keys(changes).length === 0) {
          return viewEndpoint(endpoint)
        }
        // Switched on again, or pointed somewhere else: what was held against the endpoint
        // was about the endpoint as it was.
        if (changes.enabled === true || changes.url !== undefined) {
          endpoint.disabledReason = null
          endpoint.failingSince = null
          endpoint.lastFailedAt = null
        }
        Object.assign(endpoint, changes, { updatedAt: state.webhookNow })
        return viewEndpoint(endpoint)
      }),
    ],
    [
      'DELETE',
      /^\/v1\/admin\/webhook-endpoints\/([^/]+)$/,
      onEndpoint(null, (endpoint) => {
        state.webhookEndpoints = state.webhookEndpoints.filter((entry) => entry !== endpoint)
        state.webhookDeliveries = state.webhookDeliveries.filter(
          (entry) => entry.endpointId !== endpoint.id
        )
        return new Response(null, { status: 204 })
      }),
    ],
    [
      'POST',
      /^\/v1\/admin\/webhook-endpoints\/([^/]+)\/secret\/rotate$/,
      onEndpoint(null, (endpoint) => {
        if (overlapUnderWay(endpoint)) {
          return refused(
            409,
            'webhook.rotation_refused',
            'The signing secret cannot be changed now.',
            'rotation_in_progress'
          )
        }
        endpoint.rotationOverlapEndsAt = new Date(
          Date.parse(state.webhookNow) + SECRET_OVERLAP_MS
        ).toISOString()
        endpoint.updatedAt = state.webhookNow
        return secretAnswer(200, { ...viewEndpoint(endpoint), secret: signingSecret() })
      }),
    ],
    [
      'DELETE',
      /^\/v1\/admin\/webhook-endpoints\/([^/]+)\/secret\/previous$/,
      onEndpoint(null, (endpoint) => {
        if (!overlapUnderWay(endpoint)) {
          return refused(
            409,
            'webhook.rotation_refused',
            'The signing secret cannot be changed now.',
            'no_rotation_in_progress'
          )
        }
        endpoint.rotationOverlapEndsAt = null
        endpoint.updatedAt = state.webhookNow
        return viewEndpoint(endpoint)
      }),
    ],
    [
      'GET',
      /^\/v1\/admin\/webhook-endpoints\/([^/]+)\/deliveries$/,
      (call, match) => {
        const params = EndpointParams.safeParse({ id: match[1] })
        if (!params.success) {
          return invalid(params.error)
        }
        const query = DeliveryQuery.safeParse(Object.fromEntries(call.search))
        if (!query.success) {
          return invalid(query.error)
        }
        const endpoint = endpointOf(call, params.data.id)
        if (!endpoint) {
          return notFound()
        }
        const { state: wanted, eventType, page, size } = query.data
        const rows = state.webhookDeliveries.filter(
          (entry) =>
            entry.endpointId === endpoint.id &&
            (wanted === undefined || entry.state === wanted) &&
            (eventType === undefined || entry.eventType === eventType)
        )
        // Counted no further than the window, like the store's `maxCount`.
        const totalCount = Math.min(rows.length, DELIVERY_LIST_WINDOW)
        return {
          meta: { totalCount, totalPages: Math.ceil(totalCount / size), page, perPage: size },
          data: rows.slice((page - 1) * size, page * size).map(viewDelivery),
        }
      },
    ],
    [
      'GET',
      /^\/v1\/admin\/webhook-endpoints\/([^/]+)\/deliveries\/([^/]+)$/,
      onDelivery((_endpoint, delivery) => delivery),
    ],
    [
      'POST',
      /^\/v1\/admin\/webhook-endpoints\/([^/]+)\/test$/,
      onEndpoint(SendTestWebhookRequestSchema, (endpoint, body) => {
        // One request, recorded as a delivery flagged `test`, ended whichever way it went.
        // The endpoint is not touched.
        const delivery = fakeWebhookDelivery(endpoint.id, {
          eventId: null,
          eventType: body.eventType,
          test: true,
          state: 'failed',
          attemptCount: 0,
          attempts: [],
          createdAt: state.webhookNow,
          completedAt: state.webhookNow,
        })
        state.webhookDeliveries.unshift(delivery)
        return attemptNow(delivery)
      }),
    ],
    [
      'POST',
      /^\/v1\/admin\/webhook-endpoints\/([^/]+)\/deliveries\/([^/]+)\/redeliver$/,
      onDelivery((endpoint, delivery) => {
        // In the service's order.
        const reason = !endpoint.enabled
          ? 'endpoint_disabled'
          : delivery.state === 'pending'
            ? 'delivery_pending'
            : delivery.attemptCount >= MAX_TOTAL_ATTEMPTS
              ? 'attempt_limit'
              : delivery.eventId === null
                ? 'event_gone'
                : null
        if (reason !== null) {
          return refused(
            409,
            'webhook.cannot_redeliver',
            'This delivery cannot be sent again.',
            reason
          )
        }
        const result = attemptNow(delivery)
        // A real event that got through ends the endpoint's run of failures. One that
        // failed moves nothing about the endpoint.
        if (result.outcome === 'delivered') {
          endpoint.failingSince = null
          endpoint.lastFailedAt = null
        }
        return result
      }),
    ],
  ]
}
