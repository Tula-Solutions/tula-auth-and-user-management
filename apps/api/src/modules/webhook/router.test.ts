import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { ServiceUnavailableError } from '~/exceptions'
import { createApp } from '~/index'
import { PUBLISHABLE_KEY_HEADER } from '~/middleware/publishable-key'
import * as Webhooks from '~/modules/webhook/service'
import {
  createInstanceTestDeps,
  dashboardHeaders,
  dashboardSignIn,
  seedApiKey,
  TEST_TENANT,
  type TestDeps,
} from '~/testing'

const SK = 'tula_sk_dev_admin000000000000000000000000000000'
const PROD_SK = 'tula_sk_prod_admin00000000000000000000000000000'
const PK = 'tula_pk_dev_publishable0000000000000000000000000'
const PATH = '/v1/admin/webhook-endpoints'
// In the `local` tier a loopback address passes the guard; nothing is ever sent to it here.
const URL_OK = 'http://127.0.0.1:9/hook'

let deps: TestDeps
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  deps = createInstanceTestDeps()
  for (const [id, kind] of [
    [TEST_TENANT.environmentId, 'development'],
    [TEST_TENANT.productionEnvironmentId, 'production'],
  ] as const) {
    deps.environments.add({
      id,
      projectId: TEST_TENANT.projectId,
      kind,
      createdAt: deps.clock.now(),
    })
  }
  await seedApiKey(deps, SK)
  await seedApiKey(deps, PK)
  await seedApiKey(deps, PROD_SK, { environmentId: TEST_TENANT.productionEnvironmentId })
  app = createApp(deps)
})

function call(method: string, path: string, key: string | null = SK, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      ...(key && { authorization: `Bearer ${key}` }),
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
}

interface Endpoint {
  id: string
  url: string
  eventTypes: string[]
  enabled: boolean
  secret?: string
}

async function create(body: unknown = { url: URL_OK, eventTypes: ['user.created'] }, key = SK) {
  const res = await call('POST', PATH, key, body)
  return { res, body: (await res.json()) as Endpoint & { code?: string } }
}

describe('authentication', () => {
  const id = TEST_TENANT.environmentId
  const routes = [
    ['GET', PATH],
    ['POST', PATH],
    ['GET', `${PATH}/${id}`],
    ['PATCH', `${PATH}/${id}`],
    ['DELETE', `${PATH}/${id}`],
    ['GET', `${PATH}/${id}/deliveries`],
    ['GET', `${PATH}/${id}/deliveries/${id}`],
    ['POST', `${PATH}/${id}/test`],
    ['POST', `${PATH}/${id}/deliveries/${id}/redeliver`],
  ] as const

  test.each(routes)('%s %s requires a secret key', async (method, path) => {
    const none = await call(method, path, null)
    expect(none.status).toBe(401)
    const publishable = await app.request(path, {
      method,
      headers: { [PUBLISHABLE_KEY_HEADER]: PK, authorization: `Bearer ${PK}` },
    })
    expect(publishable.status).toBe(401)
    expect(await deps.webhookEndpoints.list(TEST_TENANT.environmentId)).toEqual([])
  })

  test('the dashboard’s session works on an endpoint’s routes, and the change is recorded as its own', async () => {
    const cookie = await dashboardSignIn(app)
    const res = await app.request(PATH, {
      method: 'POST',
      headers: dashboardHeaders(cookie, TEST_TENANT.environmentId),
      body: JSON.stringify({ url: URL_OK, eventTypes: ['user.created'] }),
    })
    expect(res.status).toBe(201)
    expect(deps.activityLog.entries.at(-1)).toMatchObject({
      type: 'webhook_endpoint.created',
      actor: { type: 'instance_admin' },
    })
  })
})

describe('POST /v1/admin/webhook-endpoints', () => {
  test('answers 201 with the secret, once, and tells intermediaries not to keep it', async () => {
    const { res, body } = await create()
    expect(res.status).toBe(201)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect<unknown>(body).toEqual({
      id: expect.any(String),
      url: URL_OK,
      eventTypes: ['user.created'],
      enabled: true,
      disabledReason: null,
      failingSince: null,
      secret: expect.stringMatching(/^whsec_[A-Za-z0-9+/]{43}=$/),
      createdAt: deps.clock.now().toISOString(),
      updatedAt: deps.clock.now().toISOString(),
    })

    const secret = body.secret as string
    for (const [method, path, payload] of [
      ['GET', PATH, undefined],
      ['GET', `${PATH}/${body.id}`, undefined],
      ['PATCH', `${PATH}/${body.id}`, { enabled: false }],
    ] as const) {
      const text = await (await call(method, path, SK, payload)).text()
      expect(text).not.toContain(secret)
      expect(text).not.toContain('secret')
    }
    const audit = await (await call('GET', '/v1/admin/audit-logs')).text()
    expect(audit).not.toContain(secret)
    expect(audit).not.toContain('127.0.0.1')
    expect(audit).toContain('webhook_endpoint.created')
  })

  test.each([
    ['no body', undefined],
    ['no event type', { url: URL_OK, eventTypes: [] }],
    ['an unknown event type', { url: URL_OK, eventTypes: ['user.exploded'] }],
    [
      'a secret of the caller’s choosing',
      { url: URL_OK, eventTypes: ['user.created'], secret: 'whsec_weak' },
    ],
    [
      'an id of the caller’s choosing',
      { url: URL_OK, eventTypes: ['user.created'], id: TEST_TENANT.projectId },
    ],
  ])('refuses %s as a validation error and stores nothing', async (_, payload) => {
    const res = await call('POST', PATH, SK, payload)
    expect([400, 422]).toContain(res.status)
    expect(await deps.webhookEndpoints.list(TEST_TENANT.environmentId)).toEqual([])
    expect(deps.activityLog.entries).toEqual([])
  })

  test.each([
    ['a private address', 'https://10.9.8.7/canary-path', 'address_not_allowed'],
    [
      'a name that resolves to a private address',
      'https://canary-internal.example.test/',
      'address_not_allowed',
    ],
    ['a name that does not resolve', 'https://canary-nowhere.example.test/', 'resolve_failed'],
    ['credentials', 'https://canary-user:canary-pass@hooks.example.test/', 'invalid_url'],
  ])('refuses %s with webhook.url_not_allowed and echoes nothing of it', async (_, url, reason) => {
    deps.outbound.point('canary-internal.example.test', '172.16.5.4')
    const res = await call('POST', PATH, SK, { url, eventTypes: ['user.created'] })
    const text = await res.text()
    expect(res.status).toBe(422)
    expect(JSON.parse(text)).toEqual({
      status: 422,
      code: 'webhook.url_not_allowed',
      detail: 'The server cannot deliver to that address.',
      params: { reason },
    })
    expect(text).not.toContain('canary')
    expect(text).not.toContain('172.16')
    expect(text).not.toContain('10.9.8.7')
    expect(await deps.webhookEndpoints.list(TEST_TENANT.environmentId)).toEqual([])
  })

  test('outside the local tier the address must be https', async () => {
    deps.outbound.tier = 'prod'
    const { res, body } = await create({ url: URL_OK, eventTypes: ['user.created'] })
    expect(res.status).toBe(422)
    expect(body).toMatchObject({
      code: 'webhook.url_not_allowed',
      params: { reason: 'scheme_not_allowed' },
    })
  })
})

describe('reading, changing and removing', () => {
  test('a key of one environment sees and touches only that environment’s endpoints', async () => {
    const { body: created } = await create()
    expect(((await (await call('GET', PATH, PROD_SK)).json()) as { data: unknown[] }).data).toEqual(
      []
    )
    expect((await call('GET', `${PATH}/${created.id}`, PROD_SK)).status).toBe(404)
    expect((await call('PATCH', `${PATH}/${created.id}`, PROD_SK, { enabled: false })).status).toBe(
      404
    )
    expect((await call('DELETE', `${PATH}/${created.id}`, PROD_SK)).status).toBe(404)
    const mine = (await (await call('GET', `${PATH}/${created.id}`)).json()) as Endpoint
    expect(mine).toMatchObject({ id: created.id, enabled: true })
  })

  test('lists the environment’s endpoints, oldest first', async () => {
    const { body: first } = await create()
    deps.clock.advance('1s')
    const { body: second } = await create({
      url: 'http://127.0.0.1:9/second',
      eventTypes: ['user.deleted'],
    })
    const listed = (await (await call('GET', PATH)).json()) as { data: Endpoint[] }
    expect(listed.data.map((endpoint) => endpoint.id)).toEqual([first.id, second.id])
  })

  test('PATCH changes the named fields and records their names', async () => {
    const { body: created } = await create()
    const res = await call('PATCH', `${PATH}/${created.id}`, SK, {
      eventTypes: ['user.deleted', 'user.banned'],
      enabled: false,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      id: created.id,
      url: URL_OK,
      eventTypes: ['user.deleted', 'user.banned'],
      enabled: false,
    })
    expect(deps.activityLog.ofType('webhook_endpoint.updated')[0]?.data).toEqual({
      changed: ['eventTypes', 'enabled'],
    })
  })

  test.each([
    ['nothing', {}],
    ['the secret', { secret: 'whsec_mine' }],
    ['an unknown event type', { eventTypes: ['nope'] }],
  ])('PATCH refuses to change %s', async (_, payload) => {
    const { body: created } = await create()
    expect((await call('PATCH', `${PATH}/${created.id}`, SK, payload)).status).toBe(422)
    expect(deps.activityLog.ofType('webhook_endpoint.updated')).toEqual([])
  })

  test('PATCH refuses an address the server may not call and keeps the old one', async () => {
    const { body: created } = await create()
    const res = await call('PATCH', `${PATH}/${created.id}`, SK, { url: 'https://192.168.0.10/in' })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ code: 'webhook.url_not_allowed' })
    expect(await (await call('GET', `${PATH}/${created.id}`)).json()).toMatchObject({ url: URL_OK })
  })

  test('DELETE answers 204, then 404, and is recorded once', async () => {
    const { body: created } = await create()
    const removed = await call('DELETE', `${PATH}/${created.id}`)
    expect(removed.status).toBe(204)
    expect(await removed.text()).toBe('')
    expect((await call('DELETE', `${PATH}/${created.id}`)).status).toBe(404)
    expect((await call('GET', `${PATH}/${created.id}`)).status).toBe(404)
    expect(deps.activityLog.ofType('webhook_endpoint.deleted')).toHaveLength(1)
  })

  test.each(['GET', 'PATCH', 'DELETE'])(
    '%s with an id that is not a UUID is a validation error',
    async (method) => {
      const res = await call(
        method,
        `${PATH}/not-a-uuid`,
        SK,
        method === 'PATCH' ? { enabled: false } : undefined
      )
      expect(res.status).toBe(422)
    }
  )
})

// The routes below make the server call an address: a listener in this process, on loopback,
// which the `local` tier allows. Everything still goes through the real outbound guard.
let receivedBodies: string[] = []
let respond: () => Response = () => new Response(null, { status: 204 })
const listener = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    receivedBodies.push(await req.text())
    return respond()
  },
})
afterAll(() => listener.stop(true))
const RECEIVER = () => `http://127.0.0.1:${listener.port}/hook`

let users = 0

/** Register an endpoint at the listener, make a user and run one round. */
async function delivered(status = 204) {
  receivedBodies = []
  respond = () => new Response('canary-body', { status, headers: { 'x-canary': 'canary-header' } })
  const { body: endpoint } = await create({ url: RECEIVER(), eventTypes: ['user.created'] })
  users += 1
  const created = await call('POST', '/v1/admin/users', SK, { email: `ada${users}@example.com` })
  expect(created.status).toBe(201)
  await Webhooks.deliverPending(deps)
  const list = await call('GET', `${PATH}/${endpoint.id}/deliveries`)
  const page = (await list.json()) as { data: { id: string; eventId: string }[] }
  return { endpoint, delivery: page.data[0] as { id: string; eventId: string } }
}

describe('GET /v1/admin/webhook-endpoints/:id/deliveries', () => {
  test('an endpoint with no deliveries has an empty first page', async () => {
    const { body: endpoint } = await create()
    const res = await call('GET', `${PATH}/${endpoint.id}/deliveries`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      meta: { totalCount: 0, totalPages: 0, page: 1, perPage: 20 },
      data: [],
    })
  })

  test('lists what was delivered, by state, with nothing of the receiver’s answer', async () => {
    const { endpoint, delivery } = await delivered(500)
    const res = await call('GET', `${PATH}/${endpoint.id}/deliveries?state=pending&size=5`)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({
      meta: { totalCount: 1, totalPages: 1, page: 1, perPage: 5 },
      data: [
        {
          id: delivery.id,
          endpointId: endpoint.id,
          eventId: delivery.eventId,
          eventType: 'user.created',
          test: false,
          state: 'pending',
          attemptCount: 1,
          nextAttemptAt: new Date(deps.clock.now().getTime() + 5_000).toISOString(),
          lastAttemptAt: deps.clock.now().toISOString(),
          statusCode: 500,
          failureReason: null,
          completedAt: null,
          createdAt: deps.clock.now().toISOString(),
        },
      ],
    })
    expect(text).not.toContain('canary')
    for (const query of ['state=delivered', 'eventType=user.deleted', 'page=2']) {
      const other = await call('GET', `${PATH}/${endpoint.id}/deliveries?${query}`)
      expect(((await other.json()) as { data: unknown[] }).data).toEqual([])
    }
  })

  test.each(['state=sent', 'eventType=user.exploded', 'page=0', 'size=1000', 'size=x'])(
    'refuses the query %s',
    async (query) => {
      const { body: endpoint } = await create()
      expect((await call('GET', `${PATH}/${endpoint.id}/deliveries?${query}`)).status).toBe(422)
    }
  )

  test('another environment’s key finds neither the list nor a delivery', async () => {
    const { endpoint, delivery } = await delivered()
    const base = `${PATH}/${endpoint.id}/deliveries`
    expect((await call('GET', base, PROD_SK)).status).toBe(404)
    expect((await call('GET', `${base}/${delivery.id}`, PROD_SK)).status).toBe(404)
    expect((await call('GET', `${PATH}/${delivery.id}/deliveries`)).status).toBe(404)
  })
})

describe('GET /v1/admin/webhook-endpoints/:id/deliveries/:deliveryId', () => {
  test('answers the delivery with its attempts: a status code and a duration each', async () => {
    const { endpoint, delivery } = await delivered(503)
    const res = await call('GET', `${PATH}/${endpoint.id}/deliveries/${delivery.id}`)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(JSON.parse(text)).toMatchObject({
      id: delivery.id,
      state: 'pending',
      attemptCount: 1,
      attempts: [
        {
          attempt: 1,
          attemptedAt: deps.clock.now().toISOString(),
          statusCode: 503,
          durationMs: 0,
          failureReason: null,
        },
      ],
    })
    expect(text).not.toContain('canary')
  })

  test('an unknown delivery is not found, and an id that is not a UUID is a validation error', async () => {
    const { body: endpoint } = await create()
    const base = `${PATH}/${endpoint.id}/deliveries`
    expect((await call('GET', `${base}/${endpoint.id}`)).status).toBe(404)
    expect((await call('GET', `${base}/nope`)).status).toBe(422)
    expect((await call('GET', `${PATH}/nope/deliveries`)).status).toBe(422)
  })
})

describe('POST /v1/admin/webhook-endpoints/:id/test', () => {
  const send = (id: string, body: unknown = { eventType: 'user.created' }, key = SK) =>
    call('POST', `${PATH}/${id}/test`, key, body)

  test('sends a signed test event and answers the outcome, a status code and a duration only', async () => {
    receivedBodies = []
    respond = () =>
      new Response('canary-body', { status: 202, headers: { 'x-canary': 'canary-header' } })
    const { body: endpoint } = await create({ url: RECEIVER(), eventTypes: ['user.deleted'] })
    const audit = deps.activityLog.entries.length
    const res = await send(endpoint.id)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({
      deliveryId: expect.any(String),
      outcome: 'delivered',
      statusCode: 202,
      durationMs: 0,
      failureReason: null,
    })
    expect(text).not.toContain('canary')
    expect(receivedBodies).toHaveLength(1)
    expect(JSON.parse(receivedBodies[0] as string)).toMatchObject({
      type: 'user.created',
      test: true,
    })
    // Not something that happened: no audit entry, no event.
    expect(deps.activityLog.entries).toHaveLength(audit)
    const { deliveryId } = JSON.parse(text) as { deliveryId: string }
    const detail = await call('GET', `${PATH}/${endpoint.id}/deliveries/${deliveryId}`)
    expect(await detail.json()).toMatchObject({ test: true, eventId: null, state: 'delivered' })
  })

  test('an address that refuses the connection is a failed outcome, not an error', async () => {
    const { body: endpoint } = await create()
    const res = await send(endpoint.id)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      outcome: 'failed',
      statusCode: null,
      failureReason: 'connection_failed',
    })
  })

  test.each([
    ['no type', {}],
    ['an unknown type', { eventType: 'user.exploded' }],
    ['an address of the caller’s', { eventType: 'user.created', url: 'https://example.com/' }],
    ['a payload of the caller’s', { eventType: 'user.created', data: { userId: 'x' } }],
  ])('refuses %s', async (_, body) => {
    receivedBodies = []
    const { body: endpoint } = await create({ url: RECEIVER(), eventTypes: ['user.created'] })
    expect((await send(endpoint.id, body)).status).toBe(422)
    expect(receivedBodies).toEqual([])
  })

  test('another environment’s key cannot test an endpoint, and an unknown one is not found', async () => {
    receivedBodies = []
    const { body: endpoint } = await create({ url: RECEIVER(), eventTypes: ['user.created'] })
    expect((await send(endpoint.id, undefined, PROD_SK)).status).toBe(404)
    expect((await send(TEST_TENANT.environmentId)).status).toBe(404)
    expect((await send('nope')).status).toBe(422)
    expect(receivedBodies).toEqual([])
  })

  test('is limited per environment in a bucket of its own, shared with sending a delivery again', async () => {
    const { endpoint, delivery } = await delivered()
    receivedBodies = []
    for (let count = 0; count < Webhooks.WEBHOOK_SEND_RATE_LIMIT - 1; count++) {
      expect((await send(endpoint.id)).status).toBe(200)
    }
    const again = await call('POST', `${PATH}/${endpoint.id}/deliveries/${delivery.id}/redeliver`)
    expect(again.status).toBe(200)
    expect(receivedBodies).toHaveLength(Webhooks.WEBHOOK_SEND_RATE_LIMIT)

    const refused = await send(endpoint.id)
    expect(refused.status).toBe(429)
    expect(await refused.json()).toMatchObject({ code: 'rate_limited' })
    expect(refused.headers.get('retry-after')).not.toBeNull()
    expect(
      (await call('POST', `${PATH}/${endpoint.id}/deliveries/${delivery.id}/redeliver`)).status
    ).toBe(429)
    // Nothing more was sent, and the rest of the admin API is not held up by it.
    expect(receivedBodies).toHaveLength(Webhooks.WEBHOOK_SEND_RATE_LIMIT)
    expect((await call('GET', `${PATH}/${endpoint.id}/deliveries`)).status).toBe(200)
    // Another environment has its own allowance.
    const theirs = await create({ url: RECEIVER(), eventTypes: ['user.created'] }, PROD_SK)
    expect((await send(theirs.body.id, undefined, PROD_SK)).status).toBe(200)
    // And it comes back with the next minute.
    deps.clock.advance('1m')
    expect((await send(endpoint.id)).status).toBe(200)
  })

  test('a wrong key does not use up an environment’s allowance', async () => {
    const { body: endpoint } = await create({ url: RECEIVER(), eventTypes: ['user.created'] })
    for (let count = 0; count < Webhooks.WEBHOOK_SEND_RATE_LIMIT + 5; count++) {
      expect(
        (await send(endpoint.id, undefined, 'tula_sk_dev_wrong0000000000000000000000000000000'))
          .status
      ).toBe(401)
    }
    expect((await send(endpoint.id)).status).toBe(200)
  })

  test('when the limiter cannot count, nothing is sent', async () => {
    receivedBodies = []
    const { body: endpoint } = await create({ url: RECEIVER(), eventTypes: ['user.created'] })
    const hit = deps.rateLimiter.hit.bind(deps.rateLimiter)
    const down = spyOn(deps.rateLimiter, 'hit').mockImplementation(
      async (bucket, limit, window) => {
        if (bucket.startsWith('webhook_send:')) {
          throw new ServiceUnavailableError()
        }
        return hit(bucket, limit, window)
      }
    )
    const res = await send(endpoint.id)
    down.mockRestore()
    expect(res.status).toBe(503)
    expect(receivedBodies).toEqual([])
  })
})

describe('POST /v1/admin/webhook-endpoints/:id/deliveries/:deliveryId/redeliver', () => {
  const again = (endpointId: string, deliveryId: string, key = SK) =>
    call('POST', `${PATH}/${endpointId}/deliveries/${deliveryId}/redeliver`, key)

  test('sends the stored event once more and answers the outcome', async () => {
    const { endpoint, delivery } = await delivered()
    const first = receivedBodies[0]
    respond = () => new Response('canary-body', { status: 200 })
    const res = await again(endpoint.id, delivery.id)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({
      deliveryId: delivery.id,
      outcome: 'delivered',
      statusCode: 200,
      durationMs: 0,
      failureReason: null,
    })
    expect(text).not.toContain('canary')
    expect(receivedBodies).toEqual([first as string, first as string])
    const detail = await call('GET', `${PATH}/${endpoint.id}/deliveries/${delivery.id}`)
    expect(await detail.json()).toMatchObject({ attemptCount: 2, state: 'delivered' })
  })

  test('is refused while the delivery is pending, and for an endpoint that is off', async () => {
    const { endpoint, delivery } = await delivered(500)
    const pending = await again(endpoint.id, delivery.id)
    expect(pending.status).toBe(409)
    expect(await pending.json()).toMatchObject({
      code: 'webhook.cannot_redeliver',
      params: { reason: 'delivery_pending' },
    })

    const other = await delivered()
    await call('PATCH', `${PATH}/${other.endpoint.id}`, SK, { enabled: false })
    receivedBodies = []
    const off = await again(other.endpoint.id, other.delivery.id)
    expect(off.status).toBe(409)
    expect(await off.json()).toMatchObject({
      code: 'webhook.cannot_redeliver',
      params: { reason: 'endpoint_disabled' },
    })
    expect(receivedBodies).toEqual([])
  })

  test('another environment’s key cannot send a delivery again, with any endpoint id', async () => {
    const { endpoint, delivery } = await delivered()
    const theirs = await create({ url: RECEIVER(), eventTypes: ['user.created'] }, PROD_SK)
    receivedBodies = []
    expect((await again(endpoint.id, delivery.id, PROD_SK)).status).toBe(404)
    expect((await again(theirs.body.id, delivery.id, PROD_SK)).status).toBe(404)
    expect((await again(endpoint.id, endpoint.id)).status).toBe(404)
    expect((await again(endpoint.id, 'nope')).status).toBe(422)
    expect(receivedBodies).toEqual([])
  })

  test('the dashboard’s session can read the log and send again', async () => {
    const { endpoint, delivery } = await delivered()
    const cookie = await dashboardSignIn(app)
    const headers = dashboardHeaders(cookie, TEST_TENANT.environmentId)
    const list = await app.request(`${PATH}/${endpoint.id}/deliveries`, { headers })
    expect(list.status).toBe(200)
    const sent = await app.request(`${PATH}/${endpoint.id}/deliveries/${delivery.id}/redeliver`, {
      method: 'POST',
      headers,
    })
    expect(sent.status).toBe(200)
  })
})
