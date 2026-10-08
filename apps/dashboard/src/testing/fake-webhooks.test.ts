import { afterEach, describe, expect, test } from 'bun:test'
import {
  type FakeApi,
  fakeWebhookDelivery,
  fakeWebhookEndpoint,
  IDS,
  installFakeApi,
} from './fake-api'

// The fake's webhook routes answer as the API does where a screen can tell the difference
// (`apps/api/src/modules/webhook`: `schema.ts` for what is refused, `service.ts` for what a
// change does). These tests hold the fake to what was read there.

let api: FakeApi | undefined

afterEach(() => {
  api?.restore()
  api = undefined
})

/** The fake, with a dashboard session: every admin route is behind one. */
function signedIn(): FakeApi {
  const fake = installFakeApi()
  fake.state.signedIn = true
  return fake
}

const ROOT = '/v1/admin/webhook-endpoints'
const NO_SUCH = '00000000-0000-7000-8000-ffffffffffff'

async function call(
  method: string,
  path: string,
  body?: unknown,
  environment: string = IDS.development
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://localhost${path}`, {
    method,
    headers: {
      'x-tula-dashboard': '1',
      'x-tula-environment': environment,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, body: text === '' ? {} : JSON.parse(text) }
}

function fields(body: Record<string, unknown>): string[] {
  return (body.errors as { field: string }[] | undefined)?.map((entry) => entry.field) ?? []
}

function setUp() {
  api = signedIn()
  const endpoint = fakeWebhookEndpoint()
  const delivery = fakeWebhookDelivery(endpoint.id)
  api.state.webhookEndpoints.push(endpoint)
  api.state.webhookDeliveries.push(delivery)
  return { api, endpoint, delivery }
}

describe('what the API refuses before it looks, the fake refuses the same way', () => {
  test.each([
    ['GET', '/not-an-id', undefined, ['id']],
    ['PATCH', '/not-an-id', { enabled: false }, ['id']],
    ['DELETE', '/not-an-id', undefined, ['id']],
    ['POST', '/not-an-id/secret/rotate', undefined, ['id']],
    ['DELETE', '/not-an-id/secret/previous', undefined, ['id']],
    ['GET', '/not-an-id/deliveries', undefined, ['id']],
    ['POST', '/not-an-id/test', { eventType: 'user.created' }, ['id']],
    ['GET', `/${NO_SUCH}/deliveries/not-an-id`, undefined, ['deliveryId']],
    ['GET', '/not-an-id/deliveries/also-not', undefined, ['id', 'deliveryId']],
    ['POST', `/${NO_SUCH}/deliveries/not-an-id/redeliver`, undefined, ['deliveryId']],
  ])('%s %s: an id that is no UUID is 422 validation.failed', async (method, path, body, at) => {
    setUp()
    const answer = await call(method, `${ROOT}${path}`, body)
    expect(answer.status).toBe(422)
    expect(answer.body.code).toBe('validation.failed')
    expect(fields(answer.body)).toEqual(at)
  })

  test('an id that is one, of nothing, is 404', async () => {
    setUp()
    const answer = await call('GET', `${ROOT}/${NO_SUCH}`)
    expect(answer.status).toBe(404)
    expect(answer.body.code).toBe('resource.not_found')
  })

  test.each([
    ['an unknown state', 'state=bogus', ['state']],
    ['an unknown event type', 'eventType=invoice.paid', ['eventType']],
    ['a page that is no number', 'page=two', ['page']],
    ['page 0', 'page=0', ['page']],
    ['a size over the most', 'size=101', ['size']],
    // 501 pages of 20 are past the newest 10,000.
    ['a page past the window', 'page=501&size=20', ['page']],
    ['a page past the window at another size', 'page=101&size=100', ['page']],
  ])('the delivery list refuses %s', async (_name, query, at) => {
    const { endpoint } = setUp()
    const answer = await call('GET', `${ROOT}/${endpoint.id}/deliveries?${query}`)
    expect(answer.status).toBe(422)
    expect(answer.body.code).toBe('validation.failed')
    expect(fields(answer.body)).toEqual(at)
  })

  test.each([
    ['the last page inside the window', 'page=500&size=20'],
    ['the same at another size', 'page=100&size=100'],
    ['known filters', 'state=failed&eventType=user.created'],
  ])('the delivery list answers %s', async (_name, query) => {
    const { endpoint } = setUp()
    expect((await call('GET', `${ROOT}/${endpoint.id}/deliveries?${query}`)).status).toBe(200)
  })

  test.each([
    ['POST', '', { url: 'https://a.example.com/in', eventTypes: ['user.created'], secret: 'x' }],
    ['POST', '', { url: 'https://a.example.com/in', eventTypes: [] }],
    ['POST', '', { url: 'https://a.example.com/in', eventTypes: ['invoice.paid'] }],
    ['POST', '', { eventTypes: ['user.created'] }],
    ['PATCH', '/:id', {}],
    ['PATCH', '/:id', { enabled: true, secret: 'x' }],
    ['PATCH', '/:id', { eventTypes: [] }],
    ['POST', '/:id/test', {}],
    ['POST', '/:id/test', { eventType: 'invoice.paid' }],
    ['POST', '/:id/test', { eventType: 'user.created', url: 'https://elsewhere.example.com' }],
  ])('%s %s refuses the body %j', async (method, path, body) => {
    const { api: fake, endpoint } = setUp()
    const before = structuredClone(fake.state.webhookEndpoints)
    const answer = await call(method, `${ROOT}${path.replace(':id', endpoint.id)}`, body)
    expect(answer.status).toBe(422)
    expect(answer.body.code).toBe('validation.failed')
    expect(fake.state.webhookEndpoints).toEqual(before)
    expect(fake.state.webhookDeliveries).toHaveLength(1)
  })

  test('the count of a delivery list stops at the window', async () => {
    const { api: fake, endpoint } = setUp()
    const one = fakeWebhookDelivery(endpoint.id)
    fake.state.webhookDeliveries = Array.from({ length: 10_050 }, (_, index) => ({
      ...one,
      id: `00000000-0000-7000-8000-d${String(index).padStart(11, '0')}`,
    }))
    const answer = await call('GET', `${ROOT}/${endpoint.id}/deliveries?page=500&size=20`)
    expect(answer.body.meta).toEqual({
      totalCount: 10_000,
      totalPages: 500,
      page: 500,
      perPage: 20,
    })
    expect(answer.body.data as unknown[]).toHaveLength(20)
  })
})

describe('a change does what the service does, and no more', () => {
  const FAILING = {
    failingSince: '2026-10-03T08:00:00.000Z',
    lastFailedAt: '2026-10-04T11:00:00.000Z',
  }

  function failing(overrides: Parameters<typeof fakeWebhookEndpoint>[0] = {}) {
    api = signedIn()
    const endpoint = fakeWebhookEndpoint({
      ...FAILING,
      updatedAt: '2026-10-01T00:00:00.000Z',
      ...overrides,
    })
    api.state.webhookEndpoints.push(endpoint)
    return endpoint
  }

  test.each([
    ['switched on when it is on already', { enabled: true }],
    ['given the address it has', { url: 'https://api.example.com/webhooks/tula' }],
    [
      'given the types it has, in another order',
      { eventTypes: ['session.revoked', 'user.created'] },
    ],
  ])(
    'an endpoint %s is left as it was: its health, and when it was last changed',
    async (_name, body) => {
      const endpoint = failing()
      const answer = await call('PATCH', `${ROOT}/${endpoint.id}`, body)
      expect(answer.status).toBe(200)
      expect(answer.body).toMatchObject({ ...FAILING, updatedAt: '2026-10-01T00:00:00.000Z' })
      expect(answer.body.eventTypes).toEqual(['user.created', 'session.revoked'])
    }
  )

  test('a change of event types alone keeps the health', async () => {
    const endpoint = failing()
    const answer = await call('PATCH', `${ROOT}/${endpoint.id}`, { eventTypes: ['user.banned'] })
    expect(answer.body).toMatchObject({ ...FAILING, updatedAt: '2026-10-04T12:00:00.000Z' })
  })

  test('switching it off keeps the health too', async () => {
    const endpoint = failing()
    const answer = await call('PATCH', `${ROOT}/${endpoint.id}`, { enabled: false })
    expect(answer.body).toMatchObject({ ...FAILING, enabled: false })
  })

  test.each([
    ['switching it on', { enabled: true }],
    ['a new address', { url: 'https://new.example.com/in' }],
  ])('%s resets the health and the reason', async (_name, body) => {
    const endpoint = failing({ enabled: false, disabledReason: 'failing' })
    const answer = await call('PATCH', `${ROOT}/${endpoint.id}`, body)
    expect(answer.body).toMatchObject({
      disabledReason: null,
      failingSince: null,
      lastFailedAt: null,
    })
  })

  test('the address it already has is not judged again', async () => {
    // Saved before the rule that refuses it: the guard looks only at an address that changes.
    const endpoint = failing({ url: 'http://legacy.example.com/in' })
    const same = await call('PATCH', `${ROOT}/${endpoint.id}`, {
      url: 'http://legacy.example.com/in',
      eventTypes: ['user.banned'],
    })
    expect(same.status).toBe(200)
    const other = await call('PATCH', `${ROOT}/${endpoint.id}`, { url: 'http://other.example.com' })
    expect(other.status).toBe(422)
    expect(other.body.code).toBe('webhook.url_not_allowed')
  })

  test('an overlap is under way until the clock reaches its end, then it is not', async () => {
    api = signedIn()
    const endpoint = fakeWebhookEndpoint({ rotationOverlapEndsAt: '2026-10-05T12:00:00.000Z' })
    api.state.webhookEndpoints.push(endpoint)
    const overlap = async () =>
      (await call('GET', `${ROOT}/${endpoint.id}`)).body.rotationOverlapEndsAt
    api.state.webhookNow = '2026-10-05T11:59:59.999Z'
    expect(await overlap()).toBe('2026-10-05T12:00:00.000Z')
    api.state.webhookNow = '2026-10-05T12:00:00.000Z'
    expect(await overlap()).toBeNull()
    const listed = (await call('GET', ROOT)).body.data as { rotationOverlapEndsAt: unknown }[]
    expect(listed[0]?.rotationOverlapEndsAt).toBeNull()
    // And the two secret routes judge by the same clock.
    const ended = await call('DELETE', `${ROOT}/${endpoint.id}/secret/previous`)
    expect(ended.status).toBe(409)
    expect(ended.body.params).toEqual({ reason: 'no_rotation_in_progress' })
    expect((await call('POST', `${ROOT}/${endpoint.id}/secret/rotate`)).status).toBe(200)
  })
})

describe('a delivery sent again is recorded as `recordAttempt` records it', () => {
  function failedDelivery() {
    api = signedIn()
    const endpoint = fakeWebhookEndpoint({
      failingSince: '2026-10-03T08:00:00.000Z',
      lastFailedAt: '2026-10-04T11:00:00.000Z',
    })
    const delivery = fakeWebhookDelivery(endpoint.id, {
      state: 'failed',
      completedAt: '2026-10-04T10:00:00.000Z',
      attempts: [
        {
          attempt: 1,
          attemptedAt: '2026-10-04T10:00:00.000Z',
          statusCode: 503,
          durationMs: 12,
          failureReason: null,
        },
      ],
    })
    api.state.webhookEndpoints.push(endpoint)
    api.state.webhookDeliveries.push(delivery)
    return { api, endpoint, delivery }
  }

  test('one that fails counts, says how it ended, and moves neither the state nor the endpoint', async () => {
    const { api: fake, endpoint, delivery } = failedDelivery()
    fake.state.webhookReceiver = { statusCode: null, durationMs: 5000, failureReason: 'timeout' }
    const answer = await call('POST', `${ROOT}/${endpoint.id}/deliveries/${delivery.id}/redeliver`)
    expect(answer.body).toEqual({
      deliveryId: delivery.id,
      outcome: 'failed',
      statusCode: null,
      durationMs: 5000,
      failureReason: 'timeout',
    })
    expect(fake.state.webhookDeliveries[0]).toMatchObject({
      state: 'failed',
      attemptCount: 2,
      statusCode: null,
      failureReason: 'timeout',
      lastAttemptAt: '2026-10-04T12:00:00.000Z',
      // When it ended is when it was given up: a failed request by hand does not move it.
      completedAt: '2026-10-04T10:00:00.000Z',
      nextAttemptAt: null,
    })
    expect(fake.state.webhookDeliveries[0]?.attempts.map((attempt) => attempt.attempt)).toEqual([
      1, 2,
    ])
    expect(fake.state.webhookEndpoints[0]).toMatchObject({
      failingSince: '2026-10-03T08:00:00.000Z',
      lastFailedAt: '2026-10-04T11:00:00.000Z',
    })
  })

  test('one that gets through is delivered now, and ends the endpoint’s run of failures', async () => {
    const { api: fake, endpoint, delivery } = failedDelivery()
    await call('POST', `${ROOT}/${endpoint.id}/deliveries/${delivery.id}/redeliver`)
    expect(fake.state.webhookDeliveries[0]).toMatchObject({
      state: 'delivered',
      attemptCount: 2,
      statusCode: 204,
      failureReason: null,
      completedAt: '2026-10-04T12:00:00.000Z',
      nextAttemptAt: null,
    })
    expect(fake.state.webhookEndpoints[0]).toMatchObject({ failingSince: null, lastFailedAt: null })
  })

  test('the refusals come in the service’s order', async () => {
    const { api: fake, endpoint, delivery } = failedDelivery()
    const again = async () =>
      (await call('POST', `${ROOT}/${endpoint.id}/deliveries/${delivery.id}/redeliver`)).body.params
    const held = fake.state.webhookDeliveries[0]
    const target = fake.state.webhookEndpoints[0]
    if (!held || !target) {
      throw new Error('the fixture is missing')
    }
    // Everything is wrong at once; each is put right in turn.
    target.enabled = false
    held.state = 'pending'
    held.attemptCount = 20
    held.eventId = null
    expect(await again()).toEqual({ reason: 'endpoint_disabled' })
    target.enabled = true
    expect(await again()).toEqual({ reason: 'delivery_pending' })
    held.state = 'failed'
    expect(await again()).toEqual({ reason: 'attempt_limit' })
    held.attemptCount = 1
    expect(await again()).toEqual({ reason: 'event_gone' })
  })
})
