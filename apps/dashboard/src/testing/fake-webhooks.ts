import { MAX_WEBHOOK_ENDPOINTS } from '@tula/contract'
import { type FakeCall, type FakeHandler, failure, IDS } from './fake-api'

// The fake API's webhook routes (`/v1/admin/webhook-endpoints`): the shapes, the refusals and
// the error codes of `apps/api/src/modules/webhook`, on plain in-memory data. No request is
// ever made: what a receiver "answers" is `FakeWebhookState.webhookReceiver`.

const NOW = '2026-10-04T12:00:00.000Z'
const ENVIRONMENT = 'x-tula-environment'

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
function refusedAddress(url: string): string | null {
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

function notFound(): Response {
  return failure(404, 'resource.not_found', 'The requested resource does not exist.')
}

function viewEndpoint({ environmentId: _environmentId, ...endpoint }: FakeWebhookEndpoint) {
  return endpoint
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

  function endpointOf(call: FakeCall, id: string | undefined): FakeWebhookEndpoint | undefined {
    return state.webhookEndpoints.find(
      (entry) => entry.id === id && entry.environmentId === call.headers.get(ENVIRONMENT)
    )
  }

  function deliveryOf(call: FakeCall, match: RegExpExecArray) {
    const endpoint = endpointOf(call, match[1])
    const delivery = state.webhookDeliveries.find(
      (entry) => entry.id === match[2] && entry.endpointId === endpoint?.id
    )
    return endpoint && delivery ? { endpoint, delivery } : null
  }

  /** Make one request on demand and record it as the delivery's next attempt. */
  function attemptNow(delivery: FakeWebhookDelivery) {
    const { statusCode, durationMs, failureReason } = state.webhookReceiver
    const delivered = statusCode !== null && statusCode >= 200 && statusCode < 300
    delivery.attempts.push({
      attempt: delivery.attempts.length + 1,
      attemptedAt: NOW,
      statusCode,
      durationMs,
      failureReason,
    })
    delivery.attemptCount = delivery.attempts.length
    delivery.lastAttemptAt = NOW
    delivery.statusCode = statusCode
    delivery.failureReason = failureReason
    if (delivered) {
      delivery.state = 'delivered'
      delivery.completedAt = NOW
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
        const body = call.body as { url: string; eventTypes: string[]; enabled?: boolean }
        const environmentId = call.headers.get(ENVIRONMENT) ?? ''
        const reason = refusedAddress(body.url)
        if (reason !== null) {
          return refused(
            422,
            'webhook.url_not_allowed',
            'The server cannot deliver to that address.',
            reason
          )
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
          url: body.url,
          eventTypes: body.eventTypes,
          enabled: body.enabled ?? true,
        })
        state.webhookEndpoints.push(endpoint)
        return secretAnswer(201, { ...viewEndpoint(endpoint), secret: signingSecret() })
      },
    ],
    [
      'GET',
      /^\/v1\/admin\/webhook-endpoints\/([^/]+)$/,
      (call, match) => {
        const endpoint = endpointOf(call, match[1])
        return endpoint ? viewEndpoint(endpoint) : notFound()
      },
    ],
    [
      'PATCH',
      /^\/v1\/admin\/webhook-endpoints\/([^/]+)$/,
      (call, match) => {
        const endpoint = endpointOf(call, match[1])
        if (!endpoint) {
          return notFound()
        }
        const body = call.body as { url?: string; eventTypes?: string[]; enabled?: boolean }
        const reason = body.url === undefined ? null : refusedAddress(body.url)
        if (reason !== null) {
          return refused(
            422,
            'webhook.url_not_allowed',
            'The server cannot deliver to that address.',
            reason
          )
        }
        // Switching it on, or changing its address, forgets why it was off and since when it
        // was failing.
        if (body.enabled === true || (body.url !== undefined && body.url !== endpoint.url)) {
          endpoint.disabledReason = null
          endpoint.failingSince = null
          endpoint.lastFailedAt = null
        }
        Object.assign(endpoint, body, { updatedAt: NOW })
        return viewEndpoint(endpoint)
      },
    ],
    [
      'DELETE',
      /^\/v1\/admin\/webhook-endpoints\/([^/]+)$/,
      (call, match) => {
        const endpoint = endpointOf(call, match[1])
        if (!endpoint) {
          return notFound()
        }
        state.webhookEndpoints = state.webhookEndpoints.filter((entry) => entry !== endpoint)
        state.webhookDeliveries = state.webhookDeliveries.filter(
          (entry) => entry.endpointId !== endpoint.id
        )
        return new Response(null, { status: 204 })
      },
    ],
    [
      'POST',
      /^\/v1\/admin\/webhook-endpoints\/([^/]+)\/secret\/rotate$/,
      (call, match) => {
        const endpoint = endpointOf(call, match[1])
        if (!endpoint) {
          return notFound()
        }
        if (endpoint.rotationOverlapEndsAt !== null) {
          return refused(
            409,
            'webhook.rotation_refused',
            'The signing secret cannot be changed now.',
            'rotation_in_progress'
          )
        }
        endpoint.rotationOverlapEndsAt = '2026-10-05T12:00:00.000Z'
        return secretAnswer(200, { ...viewEndpoint(endpoint), secret: signingSecret() })
      },
    ],
    [
      'DELETE',
      /^\/v1\/admin\/webhook-endpoints\/([^/]+)\/secret\/previous$/,
      (call, match) => {
        const endpoint = endpointOf(call, match[1])
        if (!endpoint) {
          return notFound()
        }
        if (endpoint.rotationOverlapEndsAt === null) {
          return refused(
            409,
            'webhook.rotation_refused',
            'The signing secret cannot be changed now.',
            'no_rotation_in_progress'
          )
        }
        endpoint.rotationOverlapEndsAt = null
        return viewEndpoint(endpoint)
      },
    ],
    [
      'GET',
      /^\/v1\/admin\/webhook-endpoints\/([^/]+)\/deliveries$/,
      (call, match) => {
        const endpoint = endpointOf(call, match[1])
        if (!endpoint) {
          return notFound()
        }
        const wanted = { state: call.search.get('state'), type: call.search.get('eventType') }
        const rows = state.webhookDeliveries.filter(
          (entry) =>
            entry.endpointId === endpoint.id &&
            (wanted.state === null || entry.state === wanted.state) &&
            (wanted.type === null || entry.eventType === wanted.type)
        )
        const current = Number(call.search.get('page') ?? 1)
        const perPage = Number(call.search.get('size') ?? 20)
        return {
          meta: {
            totalCount: rows.length,
            totalPages: Math.ceil(rows.length / perPage),
            page: current,
            perPage,
          },
          data: rows.slice((current - 1) * perPage, current * perPage).map(viewDelivery),
        }
      },
    ],
    [
      'GET',
      /^\/v1\/admin\/webhook-endpoints\/([^/]+)\/deliveries\/([^/]+)$/,
      (call, match) => deliveryOf(call, match)?.delivery ?? notFound(),
    ],
    [
      'POST',
      /^\/v1\/admin\/webhook-endpoints\/([^/]+)\/test$/,
      (call, match) => {
        const endpoint = endpointOf(call, match[1])
        if (!endpoint) {
          return notFound()
        }
        // One request, recorded as a delivery flagged `test`. The endpoint is not touched.
        const delivery = fakeWebhookDelivery(endpoint.id, {
          eventId: null,
          eventType: (call.body as { eventType: string }).eventType,
          test: true,
          state: 'failed',
          attempts: [],
        })
        state.webhookDeliveries.unshift(delivery)
        return attemptNow(delivery)
      },
    ],
    [
      'POST',
      /^\/v1\/admin\/webhook-endpoints\/([^/]+)\/deliveries\/([^/]+)\/redeliver$/,
      (call, match) => {
        const found = deliveryOf(call, match)
        if (!found) {
          return notFound()
        }
        const { endpoint, delivery } = found
        const reason = !endpoint.enabled
          ? 'endpoint_disabled'
          : delivery.state === 'pending'
            ? 'delivery_pending'
            : delivery.attemptCount >= 20
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
        // A real event that got through ends the endpoint's run of failures.
        if (result.outcome === 'delivered') {
          endpoint.failingSince = null
          endpoint.lastFailedAt = null
        }
        return result
      },
    ],
  ]
}
