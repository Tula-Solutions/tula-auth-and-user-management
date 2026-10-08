import { afterAll, afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from 'bun:test'
import {
  ACTIVITY_TYPES,
  MAX_WEBHOOK_ENDPOINTS,
  signWebhook,
  TulaEventSchema,
  type UpdateWebhookEndpointRequest,
  webhookSecretBytes,
} from '@tula/contract'
import type { Tenant } from '~/dependencies'
import { ServiceException } from '~/exceptions'
import * as logger from '~/lib/logger'
import * as Outbound from '~/lib/outbound'
import * as Audit from '~/modules/audit/service'
import * as Webhooks from '~/modules/webhook/service'
import { createTestDeps, TEST_ACTOR, TEST_CONFIG, TEST_TENANT, type TestDeps } from '~/testing'
import { comparable } from '~/testing/comparable'

const tenant: Tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}
const otherTenant: Tenant = { ...tenant, environmentId: TEST_TENANT.productionEnvironmentId }

/** What the loopback receiver was sent. */
interface Received {
  path: string
  method: string
  headers: Record<string, string>
  body: string
}

let received: Received[] = []
let respond: (req: Request) => Response | Promise<Response> = () =>
  new Response(null, { status: 204 })
// A real listener on loopback, which the `local` tier allows: deliveries in these tests go
// through the real outbound guard and a real socket, and nowhere else.
const listener = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)
    received.push({
      path: `${url.pathname}${url.search}`,
      method: req.method,
      headers: Object.fromEntries(req.headers),
      body: await req.text(),
    })
    return respond(req)
  },
})
afterAll(() => listener.stop(true))

const receiverUrl = (path = '/hook') => `http://127.0.0.1:${listener.port}${path}`

let deps: TestDeps
let spies: Mock<(...args: never[]) => unknown>[] = []

beforeEach(() => {
  received = []
  respond = () => new Response(null, { status: 204 })
  deps = createTestDeps()
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
})

afterEach(() => {
  for (const spy of spies) {
    spy.mockRestore()
  }
  spies = []
})

/** Everything the logger was given while `spy`s were on, as one text. */
function logged(): string {
  return JSON.stringify(spies.flatMap((spy) => spy.mock.calls))
}

function quietLogs(): void {
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    spies.push(spyOn(logger, level).mockImplementation(() => undefined))
  }
}

async function failure(work: Promise<unknown>): Promise<ServiceException> {
  const error = await work.then(
    () => null,
    (caught: unknown) => caught
  )
  if (!(error instanceof ServiceException)) {
    throw new Error(`expected a ServiceException, got ${String(error)}`)
  }
  return error
}

function register(
  scope: Tenant = tenant,
  input: Partial<Parameters<typeof Webhooks.create>[2]> = {}
) {
  return Webhooks.create(
    deps,
    scope,
    { url: receiverUrl(), eventTypes: ['user.deleted'], enabled: true, ...input },
    TEST_ACTOR
  )
}

/** Record that something happened, as a store's write would: an outbox event and an audit entry. */
function happen(scope: Tenant = tenant, type: 'user.deleted' | 'user.banned' = 'user.deleted') {
  const activity = Audit.entry(deps, scope, {
    type,
    actor: TEST_ACTOR,
    target: { type: 'user', id: deps.ids.next() },
  })
  deps.activityLog.record([activity])
  return activity.id
}

const outboxRow = (eventId: string) => {
  const row = deps.activityLog.outbox.find((one) => one.id === eventId)
  if (!row) {
    throw new Error('no such event')
  }
  return row
}

/**
 * The deliveries of an event: each row with the requests made for it (`log`) and, beside it,
 * how long the latest one took.
 */
const deliveriesOf = async (eventId: string, scope: Tenant = tenant) =>
  deps.webhookDeliveries.rows
    .filter((row) => row.eventId === eventId && row.environmentId === scope.environmentId)
    .map((row) => {
      const log = deps.webhookDeliveries.attemptsOf(row.id)
      return { ...row, log, durationMs: log.at(-1)?.durationMs ?? 0 }
    })

describe('registering an endpoint', () => {
  test('the server makes the secret, returns it once and stores it sealed', async () => {
    const created = await register()
    expect(created.secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/)
    expect(webhookSecretBytes(created.secret)?.length).toBe(32)
    expect(comparable(created)).toMatchObject(
      comparable({
        url: receiverUrl(),
        eventTypes: ['user.deleted'],
        enabled: true,
        createdAt: deps.clock.now().toISOString(),
      })
    )

    const stored = await deps.webhookEndpoints.find(tenant.environmentId, created.id)
    expect(stored?.secret).not.toContain(created.secret)
    expect(stored?.secret).not.toContain(created.secret.slice('whsec_'.length))
    expect(JSON.stringify(await Webhooks.list(deps, tenant))).not.toContain('secret')
    expect(JSON.stringify(await Webhooks.get(deps, tenant, created.id))).not.toContain('secret')
    expect(await Webhooks.get(deps, tenant, created.id)).toEqual({
      id: created.id,
      url: created.url,
      eventTypes: created.eventTypes,
      enabled: true,
      disabledReason: null,
      failingSince: null,
      lastFailedAt: null,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
    })
  })

  test('two endpoints never share a secret', async () => {
    const first = await register()
    const second = await register()
    expect(first.secret).not.toBe(second.secret)
  })

  test('is audited with a count and a switch, never the address or the secret', async () => {
    const created = await register(tenant, {
      url: receiverUrl('/canary-path?canary-query'),
      eventTypes: ['user.deleted', 'user.banned'],
      enabled: false,
    })
    expect(deps.activityLog.entries).toHaveLength(1)
    expect(comparable(deps.activityLog.entries[0])).toMatchObject(
      comparable({
        type: 'webhook_endpoint.created',
        environmentId: tenant.environmentId,
        actor: { type: TEST_ACTOR.type, id: TEST_ACTOR.id },
        target: { type: 'webhook_endpoint', id: created.id },
        data: { eventTypes: 2, enabled: false },
      })
    )
    const record = JSON.stringify([deps.activityLog.entries, deps.activityLog.events])
    expect(record).not.toContain('canary')
    expect(record).not.toContain('127.0.0.1')
    expect(record).not.toContain(created.secret)
    expect(record).not.toContain(created.secret.slice('whsec_'.length))
    expect(TulaEventSchema.parse(deps.activityLog.events[0])).toEqual(
      deps.activityLog.events[0] as never
    )
  })

  test.each([
    ['a private address', 'https://10.1.2.3/hook', 'address_not_allowed'],
    ['the metadata service', 'https://169.254.169.254/latest/meta-data', 'address_not_allowed'],
    [
      'a name that resolves to a private address',
      'https://internal.example.test/hook',
      'address_not_allowed',
    ],
    ['a name that does not resolve', 'https://nowhere.example.test/hook', 'resolve_failed'],
    [
      'credentials in the address',
      'https://user:canary-password@hooks.example.test/',
      'invalid_url',
    ],
    ['another scheme', 'ftp://hooks.example.test/', 'invalid_url'],
    ['text that is no URL', 'canary not a url', 'invalid_url'],
  ])('refuses %s, stores nothing and repeats nothing of it', async (_, url, reason) => {
    deps.outbound.point('internal.example.test', '10.20.30.40')
    deps.outbound.point('hooks.example.test', '93.184.216.34')
    const error = await failure(register(tenant, { url }))
    expect(error.toJSON()).toEqual({
      status: 422,
      code: 'webhook.url_not_allowed',
      detail: 'The server cannot deliver to that address.',
      params: { reason },
    })
    const said = `${JSON.stringify(error.toJSON())} ${error.message} ${error.internalMessage ?? ''}`
    expect(said).not.toContain('canary')
    expect(said).not.toContain('10.20.30.40')
    expect(await Webhooks.list(deps, tenant)).toEqual([])
    expect(deps.activityLog.entries).toEqual([])
    expect(received).toEqual([])
  })

  test.each(['dev', 'staging', 'prod'] as const)(
    'outside the local tier (%s) refuses http and loopback, and accepts a public https name',
    async (tier) => {
      deps.outbound.tier = tier
      deps.outbound.point('hooks.example.test', '93.184.216.34')
      expect((await failure(register(tenant, { url: receiverUrl() }))).params).toEqual({
        reason: 'scheme_not_allowed',
      })
      expect(
        (await failure(register(tenant, { url: `https://127.0.0.1:${listener.port}/hook` }))).params
      ).toEqual({ reason: 'address_not_allowed' })
      const created = await register(tenant, { url: 'https://hooks.example.test/tula' })
      expect(created.url).toBe('https://hooks.example.test/tula')
      // Saving resolves the name and sends nothing.
      expect(deps.outbound.asked).toEqual(['hooks.example.test'])
      expect(received).toEqual([])
    }
  )

  test('an environment holds a bounded number of endpoints', async () => {
    for (let count = 0; count < MAX_WEBHOOK_ENDPOINTS; count++) {
      await register()
    }
    const error = await failure(register())
    expect(comparable(error.toJSON())).toMatchObject(
      comparable({
        status: 409,
        params: { max: MAX_WEBHOOK_ENDPOINTS },
      })
    )
    expect(await Webhooks.list(deps, tenant)).toHaveLength(MAX_WEBHOOK_ENDPOINTS)
    // Another environment has its own allowance.
    expect((await register(otherTenant)).id).toBeString()
  })
})

describe('reading, changing and removing an endpoint', () => {
  test('another environment cannot read, change or remove it', async () => {
    const created = await register()
    expect((await failure(Webhooks.get(deps, otherTenant, created.id))).status).toBe(404)
    expect(
      (
        await failure(
          Webhooks.update(deps, otherTenant, created.id, { enabled: false }, TEST_ACTOR)
        )
      ).status
    ).toBe(404)
    expect((await failure(Webhooks.remove(deps, otherTenant, created.id, TEST_ACTOR))).status).toBe(
      404
    )
    expect(await Webhooks.list(deps, otherTenant)).toEqual([])
    expect(comparable(await Webhooks.get(deps, tenant, created.id))).toMatchObject(
      comparable({ enabled: true })
    )
    expect(deps.activityLog.entries.map((entry) => entry.type)).toEqual([
      'webhook_endpoint.created',
    ])
  })

  test('an update names what changed in the audit entry, never the values', async () => {
    const created = await register()
    deps.clock.advance('1m')
    const updated = await Webhooks.update(
      deps,
      tenant,
      created.id,
      { url: receiverUrl('/canary-new'), eventTypes: ['user.banned'], enabled: false },
      TEST_ACTOR
    )
    expect(updated).toEqual({
      id: created.id,
      url: receiverUrl('/canary-new'),
      eventTypes: ['user.banned'],
      enabled: false,
      disabledReason: null,
      failingSince: null,
      lastFailedAt: null,
      createdAt: created.createdAt,
      updatedAt: deps.clock.now().toISOString(),
    })
    expect(comparable(deps.activityLog.entries.at(-1))).toMatchObject(
      comparable({
        type: 'webhook_endpoint.updated',
        target: { type: 'webhook_endpoint', id: created.id },
        data: { changed: ['url', 'eventTypes', 'enabled'] },
      })
    )
    const record = JSON.stringify([deps.activityLog.entries, deps.activityLog.events])
    expect(record).not.toContain('canary')
    expect(record).not.toContain(created.secret)
  })

  const SINGLE_CHANGES: [string, UpdateWebhookEndpointRequest, string[]][] = [
    ['only the switch', { enabled: false }, ['enabled']],
    ['only the event types', { eventTypes: ['user.banned', 'user.deleted'] }, ['eventTypes']],
    ['only the address', { url: 'https://hooks.example.test/other' }, ['url']],
  ]

  test.each(SINGLE_CHANGES)('an update of %s records exactly that', async (_, input, changed) => {
    deps.outbound.point('hooks.example.test', '127.0.0.1')
    const created = await register()
    await Webhooks.update(deps, tenant, created.id, input, TEST_ACTOR)
    expect(deps.activityLog.ofType('webhook_endpoint.updated').map((entry) => entry.data)).toEqual([
      { changed },
    ])
  })

  test('an update that changes nothing writes and records nothing', async () => {
    const created = await register(tenant, { eventTypes: ['user.deleted', 'user.banned'] })
    deps.clock.advance('1m')
    const same = await Webhooks.update(
      deps,
      tenant,
      created.id,
      // The same address, the same types in another order, the same switch.
      { url: receiverUrl(), eventTypes: ['user.banned', 'user.deleted'], enabled: true },
      TEST_ACTOR
    )
    expect(same.updatedAt).toBe(created.updatedAt)
    expect(deps.activityLog.ofType('webhook_endpoint.updated')).toEqual([])
  })

  test('a new address is judged by the guard; a refused one changes nothing', async () => {
    deps.outbound.point('internal.example.test', '192.168.1.5')
    const created = await register()
    const error = await failure(
      Webhooks.update(
        deps,
        tenant,
        created.id,
        { url: 'https://internal.example.test/hook', enabled: false },
        TEST_ACTOR
      )
    )
    expect(comparable(error.toJSON())).toMatchObject(
      comparable({
        status: 422,
        code: 'webhook.url_not_allowed',
        params: { reason: 'address_not_allowed' },
      })
    )
    expect(JSON.stringify(error.toJSON())).not.toContain('192.168')
    expect(comparable(await Webhooks.get(deps, tenant, created.id))).toMatchObject(
      comparable({
        url: receiverUrl(),
        enabled: true,
      })
    )
    expect(deps.activityLog.ofType('webhook_endpoint.updated')).toEqual([])
  })

  test('an update of the same address does not ask the guard again', async () => {
    deps.outbound.point('hooks.example.test', '127.0.0.1')
    const created = await register(tenant, { url: `http://hooks.example.test:${listener.port}/in` })
    deps.outbound.point('hooks.example.test', '10.0.0.1')
    const updated = await Webhooks.update(
      deps,
      tenant,
      created.id,
      { url: created.url, enabled: false },
      TEST_ACTOR
    )
    expect(updated.enabled).toBe(false)
  })

  test('an endpoint removed between the read and the write of an update is not found', async () => {
    const created = await register()
    spies.push(spyOn(deps.webhookEndpoints, 'update').mockImplementation(async () => null) as never)
    expect(
      (await failure(Webhooks.update(deps, tenant, created.id, { enabled: false }, TEST_ACTOR)))
        .status
    ).toBe(404)
  })

  test('removal is audited, and a second removal finds nothing and records nothing', async () => {
    const created = await register()
    await Webhooks.remove(deps, tenant, created.id, TEST_ACTOR)
    expect(await Webhooks.list(deps, tenant)).toEqual([])
    expect(comparable(deps.activityLog.entries.at(-1))).toMatchObject(
      comparable({
        type: 'webhook_endpoint.deleted',
        target: { type: 'webhook_endpoint', id: created.id },
        data: {},
      })
    )
    expect((await failure(Webhooks.remove(deps, tenant, created.id, TEST_ACTOR))).status).toBe(404)
    expect(deps.activityLog.ofType('webhook_endpoint.deleted')).toHaveLength(1)
  })

  test('unknown ids are not found', async () => {
    const id = deps.ids.next()
    expect((await failure(Webhooks.get(deps, tenant, id))).status).toBe(404)
    expect(
      (await failure(Webhooks.update(deps, tenant, id, { enabled: false }, TEST_ACTOR))).status
    ).toBe(404)
  })
})

describe('a delivery round', () => {
  test('delivers the stored event, signed, and marks it delivered', async () => {
    const endpoint = await register()
    const eventId = happen()
    deps.clock.advance('3s')

    const report = await Webhooks.deliverPending(deps)

    expect(received).toHaveLength(1)
    const [request] = received as [Received]
    expect(request.method).toBe('POST')
    expect(request.path).toBe('/hook')
    expect(request.headers['content-type']).toBe('application/json')
    expect(request.headers['webhook-id']).toBe(eventId)
    const timestamp = Math.floor(deps.clock.now().getTime() / 1000)
    expect(request.headers['webhook-timestamp']).toBe(String(timestamp))
    // The signature is the Standard Webhooks one for the secret the registration returned.
    const key = webhookSecretBytes(endpoint.secret) as Uint8Array<ArrayBuffer>
    expect(request.headers['webhook-signature']).toBe(
      await signWebhook(key, eventId, timestamp, request.body)
    )
    // The body is the stored payload, and an event of the contract.
    expect(JSON.parse(request.body)).toEqual(outboxRow(eventId).payload)
    expect(comparable(TulaEventSchema.parse(JSON.parse(request.body)))).toMatchObject(
      comparable({
        id: eventId,
        type: 'user.deleted',
        schemaVersion: 1,
      })
    )

    const attempt = {
      id: expect.any(String),
      attempt: 1,
      attemptedAt: deps.clock.now(),
      statusCode: 204,
      durationMs: 0,
      failureReason: null,
    }
    expect(await deliveriesOf(eventId)).toEqual([
      {
        id: expect.any(String),
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        endpointId: endpoint.id,
        eventId,
        eventType: 'user.deleted',
        test: false,
        state: 'delivered',
        attempts: 1,
        nextAttemptAt: null,
        lastAttemptAt: deps.clock.now(),
        statusCode: 204,
        failureReason: null,
        completedAt: deps.clock.now(),
        createdAt: deps.clock.now(),
        log: [attempt],
        durationMs: 0,
      },
    ])
    expect(outboxRow(eventId).deliveredAt).toEqual(deps.clock.now())
    // The endpoint's own creation event and the user's: both settled, one queued and sent.
    expect(report).toEqual({
      environments: 2,
      failed: 0,
      events: 2,
      unowed: 0,
      queued: 1,
      delivered: 1,
      undelivered: 0,
      deferred: 0,
      givenUp: 0,
      disabled: 0,
      skipped: 0,
    })
  })

  test('the duration is what the clock says the delivery took', async () => {
    await register()
    const eventId = happen()
    respond = () => {
      deps.clock.advance(120)
      return new Response('ok')
    }
    await Webhooks.deliverPending(deps)
    expect(comparable(await deliveriesOf(eventId))).toMatchObject(
      comparable([{ durationMs: 120, statusCode: 200 }])
    )
  })

  test('an event of a type nobody subscribed to is sent nowhere and marked delivered', async () => {
    await register(tenant, { eventTypes: ['user.banned'] })
    const eventId = happen(tenant, 'user.deleted')
    await Webhooks.deliverPending(deps)
    expect(received).toEqual([])
    expect(await deliveriesOf(eventId)).toEqual([])
    expect(outboxRow(eventId).deliveredAt).toEqual(deps.clock.now())
  })

  test('an environment with no endpoint at all still has its events marked delivered', async () => {
    const eventId = happen()
    const report = await Webhooks.deliverPending(deps)
    expect(outboxRow(eventId).deliveredAt).not.toBeNull()
    expect(comparable(report)).toMatchObject(
      comparable({ events: 1, delivered: 0, undelivered: 0 })
    )
  })

  test('a switched-off endpoint is sent nothing, and the events of that time are not sent later', async () => {
    const endpoint = await register(tenant, { enabled: false })
    const eventId = happen()
    await Webhooks.deliverPending(deps)
    expect(received).toEqual([])
    expect(outboxRow(eventId).deliveredAt).not.toBeNull()

    await Webhooks.update(deps, tenant, endpoint.id, { enabled: true }, TEST_ACTOR)
    const later = happen()
    await Webhooks.deliverPending(deps)
    expect(received.map((request) => request.headers['webhook-id'])).toEqual([later])
  })

  test('an endpoint is not sent what happened before it was registered', async () => {
    const before = happen()
    deps.clock.advance('1s')
    await register()
    const after = happen()
    await Webhooks.deliverPending(deps)
    expect(received.map((request) => request.headers['webhook-id'])).toEqual([after])
    expect(outboxRow(before).deliveredAt).not.toBeNull()
  })

  test('an endpoint that subscribed to it is sent its own registration, from the same instant', async () => {
    const endpoint = await register(tenant, { eventTypes: ['webhook_endpoint.created'] })
    await Webhooks.deliverPending(deps)
    expect(received).toHaveLength(1)
    expect(comparable(JSON.parse((received[0] as Received).body))).toMatchObject(
      comparable({
        type: 'webhook_endpoint.created',
        target: { type: 'webhook_endpoint', id: endpoint.id },
      })
    )
    expect((received[0] as Received).body).not.toContain(endpoint.secret)
    expect((received[0] as Received).body).not.toContain('127.0.0.1')
  })

  test('each subscribed endpoint gets the event once, signed with its own secret', async () => {
    const first = await register(tenant, { url: receiverUrl('/first') })
    const second = await register(tenant, { url: receiverUrl('/second') })
    const eventId = happen()
    await Webhooks.deliverPending(deps)
    // Endpoints are served side by side: which request arrives first is not fixed.
    expect(received.map((request) => request.path).sort()).toEqual(['/first', '/second'])
    const signatures = received.map((request) => request.headers['webhook-signature'])
    expect(signatures[0]).not.toBe(signatures[1])
    for (const [path, endpoint] of [
      ['/first', first],
      ['/second', second],
    ] as const) {
      const request = received.find((one) => one.path === path) as Received
      expect(request.headers['webhook-signature']).toBe(
        await signWebhook(
          webhookSecretBytes(endpoint.secret) as Uint8Array<ArrayBuffer>,
          eventId,
          Number(request.headers['webhook-timestamp']),
          request.body
        )
      )
    }
    expect(await deliveriesOf(eventId)).toHaveLength(2)
  })

  test('events are sent oldest first', async () => {
    await register()
    const first = happen()
    deps.clock.advance('1s')
    const second = happen()
    deps.clock.advance('1s')
    const third = happen()
    await Webhooks.deliverPending(deps)
    expect(received.map((request) => request.headers['webhook-id'])).toEqual([first, second, third])
  })

  test('one environment’s events never reach another environment’s endpoint', async () => {
    await register(tenant, { url: receiverUrl('/dev') })
    await register(otherTenant, { url: receiverUrl('/prod') })
    const mine = happen(tenant)
    const theirs = happen(otherTenant)
    await Webhooks.deliverPending(deps)
    expect(received.map((request) => [request.path, request.headers['webhook-id']]).sort()).toEqual(
      [
        ['/dev', mine],
        ['/prod', theirs],
      ].sort()
    )
    expect(await deliveriesOf(mine, otherTenant)).toEqual([])
    expect(await deliveriesOf(theirs, tenant)).toEqual([])
  })

  test.each([200, 201, 202, 204, 299])('a %d answer is a delivery', async (status) => {
    await register()
    const eventId = happen()
    respond = () => new Response(null, { status })
    const report = await Webhooks.deliverPending(deps)
    expect(comparable(await deliveriesOf(eventId))).toMatchObject(
      comparable([{ state: 'delivered', statusCode: status, failureReason: null }])
    )
    expect(comparable(report)).toMatchObject(comparable({ delivered: 1, undelivered: 0 }))
  })

  // Changed with retries (TULA-42): a failed request used to be the end of a delivery. It is
  // now the first of up to eight, and the delivery waits for the next. 410 has a rule of its
  // own (`delivery.test.ts`).
  test.each([400, 401, 404, 429, 500, 503])(
    'a %d answer is a failed request: the delivery waits, and is sent again when it is due',
    async (status) => {
      quietLogs()
      await register()
      const eventId = happen()
      respond = () => new Response('no', { status })
      const report = await Webhooks.deliverPending(deps)
      const due = new Date(deps.clock.now().getTime() + 5_000)
      expect(comparable(await deliveriesOf(eventId))).toMatchObject(
        comparable([
          {
            state: 'pending',
            attempts: 1,
            statusCode: status,
            failureReason: null,
            nextAttemptAt: due,
            completedAt: null,
          },
        ])
      )
      expect(comparable(report)).toMatchObject(
        comparable({ delivered: 0, undelivered: 1, givenUp: 0 })
      )
      // The event is settled all the same: its delivery exists, and goes its own way.
      expect(outboxRow(eventId).deliveredAt).not.toBeNull()

      // Not before it is due, however many rounds pass.
      respond = () => new Response(null, { status: 204 })
      await Webhooks.deliverPending(deps)
      deps.clock.advance(4_999)
      await Webhooks.deliverPending(deps)
      expect(received).toHaveLength(1)

      deps.clock.advance(1)
      await Webhooks.deliverPending(deps)
      expect(received.map((request) => request.headers['webhook-id'])).toEqual([eventId, eventId])
      expect(comparable(await deliveriesOf(eventId))).toMatchObject(
        comparable([{ state: 'delivered', attempts: 2, statusCode: 204, nextAttemptAt: null }])
      )
    }
  )

  test('a redirect is a failed delivery, and where it points is never asked', async () => {
    await register()
    const eventId = happen()
    respond = () =>
      new Response(null, { status: 302, headers: { location: receiverUrl('/elsewhere') } })
    await Webhooks.deliverPending(deps)
    expect(received.map((request) => request.path)).toEqual(['/hook'])
    expect(comparable(await deliveriesOf(eventId))).toMatchObject(
      comparable([{ state: 'pending', statusCode: 302 }])
    )
  })

  // Changed after review (TULA-42, F3): this was a failed delivery with no status, which with
  // retries sent a healthy receiver the same event eight times. The status line arrives
  // before the body, so the answer is judged by it (`delivery.test.ts`, "an answer larger
  // than the server reads").
  test('an answer larger than the cap is judged by its status, and nothing of its body is read', async () => {
    await register()
    const eventId = happen()
    respond = () => new Response('x'.repeat(Webhooks.WEBHOOK_MAX_RESPONSE_BYTES + 1))
    await Webhooks.deliverPending(deps)
    expect(comparable(await deliveriesOf(eventId))).toMatchObject(
      comparable([{ state: 'delivered', statusCode: 200, failureReason: null }])
    )
    expect(outboxRow(eventId).deliveredAt).not.toBeNull()
  })

  test('nothing of the receiver’s answer is kept but its status: no header, no body', async () => {
    quietLogs()
    await register()
    const eventId = happen()
    respond = () =>
      new Response('canary-body {"secret":"canary-json"}', {
        status: 500,
        statusText: 'canary-status-text',
        headers: { 'x-canary-header': 'canary-header-value', 'set-cookie': 'canary=cookie' },
      })
    const report = await Webhooks.deliverPending(deps)
    const [row] = deps.webhookDeliveries.rows.filter((one) => one.eventId === eventId)
    expect(Object.keys(row ?? {}).sort()).toEqual([
      'attempts',
      'completedAt',
      'createdAt',
      'endpointId',
      'environmentId',
      'eventId',
      'eventType',
      'failureReason',
      'id',
      'lastAttemptAt',
      'nextAttemptAt',
      'projectId',
      'state',
      'statusCode',
      'test',
    ])
    const attempts = deps.webhookDeliveries.attemptsOf(row?.id ?? '')
    expect(attempts).toHaveLength(1)
    expect(Object.keys(attempts[0] ?? {}).sort()).toEqual([
      'attempt',
      'attemptedAt',
      'durationMs',
      'failureReason',
      'id',
      'statusCode',
    ])
    const kept = JSON.stringify([
      row,
      attempts,
      report,
      deps.activityLog.entries,
      deps.activityLog.outbox,
      await deps.webhookEndpoints.list(tenant.environmentId),
      await Webhooks.listDeliveries(deps, tenant, row?.endpointId ?? ''),
      await Webhooks.getDelivery(deps, tenant, row?.endpointId ?? '', row?.id ?? ''),
    ])
    expect(kept).not.toContain('canary')
    expect(logged()).not.toContain('canary')
  })

  test('a delivery asks the guard for a short deadline and a small answer', async () => {
    await register()
    happen()
    const request = spyOn(Outbound, 'request')
    spies.push(request as never)
    await Webhooks.deliverPending(deps)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]?.[0]).toBe(deps.outbound)
    expect(comparable(request.mock.calls[0]?.[2])).toMatchObject(
      comparable({
        method: 'POST',
        timeoutMs: Webhooks.WEBHOOK_DELIVERY_TIMEOUT_MS,
        maxResponseBytes: Webhooks.WEBHOOK_MAX_RESPONSE_BYTES,
      })
    )
    expect(Webhooks.WEBHOOK_DELIVERY_TIMEOUT_MS).toBeLessThanOrEqual(5_000)
    expect(Webhooks.WEBHOOK_MAX_RESPONSE_BYTES).toBeLessThanOrEqual(64 * 1024)
  })

  test.each(['timeout', 'connection_failed'] as const)(
    'a receiver that gives no answer (%s) is a failed request with that word, and is not sent again before it is due',
    async (reason) => {
      quietLogs()
      await register()
      const eventId = happen()
      const request = spyOn(Outbound, 'request').mockImplementation(async () => {
        deps.clock.advance(Webhooks.WEBHOOK_DELIVERY_TIMEOUT_MS)
        throw new Outbound.OutboundError(reason)
      })
      spies.push(request as never)
      await Webhooks.deliverPending(deps)
      await Webhooks.deliverPending(deps)
      expect(request).toHaveBeenCalledTimes(1)
      expect(comparable(await deliveriesOf(eventId))).toMatchObject(
        comparable([
          {
            state: 'pending',
            statusCode: null,
            durationMs: Webhooks.WEBHOOK_DELIVERY_TIMEOUT_MS,
            failureReason: reason,
          },
        ])
      )
    }
  )

  test('a closed port is a failed delivery, through the real transport', async () => {
    quietLogs()
    const closed = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
    const port = closed.port
    await closed.stop(true)
    await register(tenant, { url: `http://127.0.0.1:${port}/hook` })
    const eventId = happen()
    await Webhooks.deliverPending(deps)
    expect(comparable(await deliveriesOf(eventId))).toMatchObject(
      comparable([{ state: 'pending', statusCode: null, failureReason: 'connection_failed' }])
    )
  })
})

describe('the outbound guard at delivery time', () => {
  test('an address that was allowed when saved and leads somewhere private now is refused, and nothing is sent', async () => {
    quietLogs()
    deps.outbound.point('hooks.example.test', '127.0.0.1')
    const endpoint = await register(tenant, {
      url: `http://hooks.example.test:${listener.port}/hook`,
    })
    const first = happen()
    await Webhooks.deliverPending(deps)
    expect(received.map((request) => request.headers['webhook-id'])).toEqual([first])

    // The name is pointed at the private network after the endpoint was saved.
    deps.outbound.point('hooks.example.test', '10.0.0.7')
    const second = happen()
    await Webhooks.deliverPending(deps)

    expect(received).toHaveLength(1)
    expect(comparable(await deliveriesOf(second))).toMatchObject(
      comparable([
        {
          endpointId: endpoint.id,
          state: 'pending',
          statusCode: null,
          failureReason: 'address_not_allowed',
        },
      ])
    )
    expect(outboxRow(second).deliveredAt).not.toBeNull()
    expect(logged()).not.toContain('10.0.0.7')
    expect(logged()).not.toContain('hooks.example.test')
  })

  test('a name with one public and one private address is refused whole', async () => {
    quietLogs()
    deps.outbound.point('hooks.example.test', '127.0.0.1')
    await register(tenant, { url: `http://hooks.example.test:${listener.port}/hook` })
    deps.outbound.point('hooks.example.test', '127.0.0.1', '169.254.169.254')
    const eventId = happen()
    await Webhooks.deliverPending(deps)
    expect(received).toEqual([])
    expect(comparable(await deliveriesOf(eventId))).toMatchObject(
      comparable([{ failureReason: 'address_not_allowed' }])
    )
  })

  test('a name that no longer resolves is a failed delivery', async () => {
    quietLogs()
    deps.outbound.point('hooks.example.test', '127.0.0.1')
    await register(tenant, { url: `http://hooks.example.test:${listener.port}/hook` })
    deps.outbound.point('hooks.example.test')
    const eventId = happen()
    await Webhooks.deliverPending(deps)
    expect(comparable(await deliveriesOf(eventId))).toMatchObject(
      comparable([{ failureReason: 'resolve_failed' }])
    )
  })

  test('an endpoint saved in the local tier is refused once the deployment is not local', async () => {
    quietLogs()
    await register()
    deps.outbound.tier = 'prod'
    const eventId = happen()
    await Webhooks.deliverPending(deps)
    expect(received).toEqual([])
    expect(comparable(await deliveriesOf(eventId))).toMatchObject(
      comparable([{ failureReason: 'scheme_not_allowed' }])
    )
  })

  test('the name is resolved for every delivery, never remembered from the last one', async () => {
    deps.outbound.point('hooks.example.test', '127.0.0.1')
    await register(tenant, { url: `http://hooks.example.test:${listener.port}/hook` })
    happen()
    happen()
    await Webhooks.deliverPending(deps)
    // Once when saved, once for each delivery.
    expect(deps.outbound.asked).toEqual([
      'hooks.example.test',
      'hooks.example.test',
      'hooks.example.test',
    ])
  })
})

describe('what a round never does', () => {
  test('a row recorded before events had a schema version is never sent: marked delivered and counted', async () => {
    await register(tenant, { eventTypes: [...ACTIVITY_TYPES] })
    const legacy = deps.ids.next()
    deps.activityLog.outbox.push({
      id: legacy,
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      type: 'user.deleted',
      // The shape `events.payload` had before the event contract.
      payload: { actor: { type: 'system', id: null }, target: { type: 'user', id: 'u' }, data: {} },
      occurredAt: deps.clock.now(),
      deliveredAt: null,
    })
    const report = await Webhooks.deliverPending(deps)
    expect(received.map((request) => request.headers['webhook-id'])).not.toContain(legacy)
    expect(await deliveriesOf(legacy)).toEqual([])
    expect(outboxRow(legacy).deliveredAt).toEqual(deps.clock.now())
    expect(report.skipped).toBe(1)
  })

  test.each([
    ['another event’s id', (id: string) => ({ id: `${id.slice(0, -1)}f`, type: 'user.deleted' })],
    ['another type', (id: string) => ({ id, type: 'user.banned' })],
    [
      'a schema version that is not a number',
      (id: string) => ({ id, type: 'user.deleted', schemaVersion: '1' }),
    ],
  ])('a row whose payload carries %s than the row is not sent', async (_, change) => {
    await register()
    const eventId = happen()
    const row = outboxRow(eventId)
    row.payload = { ...row.payload, ...change(eventId) }
    const report = await Webhooks.deliverPending(deps)
    expect(received).toEqual([])
    expect(row.deliveredAt).not.toBeNull()
    expect(report.skipped).toBe(1)
  })

  test('a secret that cannot be opened sends nothing, is recorded, and is not logged', async () => {
    quietLogs()
    const first = await register()
    const second = await register(otherTenant)
    const mine = await deps.webhookEndpoints.find(tenant.environmentId, first.id)
    const theirs = await deps.webhookEndpoints.find(otherTenant.environmentId, second.id)
    // A ciphertext copied from another environment's row: sealed for that row, it does not
    // open here.
    await deps.webhookEndpoints.delete(tenant.environmentId, first.id, Audit.none('fixture'))
    await deps.webhookEndpoints.insert(
      {
        ...(mine as NonNullable<typeof mine>),
        secret: (theirs as NonNullable<typeof theirs>).secret,
      },
      Audit.none('fixture')
    )
    const eventId = happen()
    const report = await Webhooks.deliverPending(deps)
    expect(received).toEqual([])
    // Changed with retries (TULA-42): this was a row settled as failed for good. Nothing was
    // sent, so it is no attempt; the delivery waits for the key to be right.
    expect(comparable(await deliveriesOf(eventId))).toMatchObject(
      comparable([
        {
          state: 'pending',
          attempts: 0,
          statusCode: null,
          failureReason: 'signing_failed',
          lastAttemptAt: null,
          log: [],
        },
      ])
    )
    expect(outboxRow(eventId).deliveredAt).not.toBeNull()
    expect(comparable(report)).toMatchObject(
      comparable({ failed: 0, undelivered: 0, deferred: 1, givenUp: 0 })
    )
    expect(logged()).not.toContain(first.secret)
    expect(logged()).not.toContain(second.secret)
    expect(logged()).not.toContain((theirs as NonNullable<typeof theirs>).secret)
    expect(logged()).toContain(first.id)
  })

  test.each([
    ['of another endpoint of the same environment', async () => (await register()).id],
    ['that is not a sealed value at all', async () => null],
  ])('a secret %s does not sign', async (_, other) => {
    quietLogs()
    const created = await register()
    const otherId = await other()
    const record = await deps.webhookEndpoints.find(tenant.environmentId, created.id)
    const donor = otherId ? await deps.webhookEndpoints.find(tenant.environmentId, otherId) : null
    if (otherId) {
      await deps.webhookEndpoints.delete(tenant.environmentId, otherId, Audit.none('fixture'))
    }
    await deps.webhookEndpoints.delete(tenant.environmentId, created.id, Audit.none('fixture'))
    await deps.webhookEndpoints.insert(
      { ...(record as NonNullable<typeof record>), secret: donor?.secret ?? 'whsec_plain' },
      Audit.none('fixture')
    )
    const eventId = happen()
    await Webhooks.deliverPending(deps)
    expect(received).toEqual([])
    expect(comparable(await deliveriesOf(eventId))).toMatchObject(
      comparable([{ failureReason: 'signing_failed' }])
    )
  })

  test('a sealed value that opens to something that is no signing secret does not sign', async () => {
    quietLogs()
    const created = await register()
    const record = await deps.webhookEndpoints.find(tenant.environmentId, created.id)
    await deps.webhookEndpoints.delete(tenant.environmentId, created.id, Audit.none('fixture'))
    await deps.webhookEndpoints.insert(
      {
        ...(record as NonNullable<typeof record>),
        secret: await deps.secretBox.seal(
          Webhooks.WEBHOOK_SECRET_PURPOSE,
          new TextEncoder().encode('not-a-webhook-secret'),
          `${tenant.environmentId}:${created.id}`
        ),
      },
      Audit.none('fixture')
    )
    const eventId = happen()
    await Webhooks.deliverPending(deps)
    expect(received).toEqual([])
    expect(comparable(await deliveriesOf(eventId))).toMatchObject(
      comparable([{ failureReason: 'signing_failed' }])
    )
  })

  test('the address and the secret of an endpoint are never logged, whatever happens to its deliveries', async () => {
    quietLogs()
    const created = await register(tenant, { url: receiverUrl('/canary-path?token=canary-query') })
    happen()
    respond = () => new Response('no', { status: 500 })
    await Webhooks.run(deps)
    happen()
    respond = () =>
      new Response('canary-moved', {
        status: 302,
        headers: { location: 'https://canary.example/' },
      })
    await Webhooks.run(deps)
    expect(received).toHaveLength(2)
    const text = logged()
    expect(text).not.toContain('canary')
    expect(text).not.toContain(created.secret)
    expect(text).not.toContain(created.secret.slice('whsec_'.length))
    expect(text).not.toContain(String(listener.port))
  })
})

describe('races and failures inside a round', () => {
  test('an endpoint removed while its delivery is under way leaves no row and does not fail the round', async () => {
    const endpoint = await register()
    const eventId = happen()
    respond = async () => {
      await Webhooks.remove(deps, tenant, endpoint.id, TEST_ACTOR)
      return new Response(null, { status: 204 })
    }
    const report = await Webhooks.deliverPending(deps)
    expect(received).toHaveLength(1)
    expect(report.failed).toBe(0)
    expect(await deliveriesOf(eventId)).toEqual([])
    expect(outboxRow(eventId).deliveredAt).not.toBeNull()
  })

  // Changed with retries (TULA-42): events are turned into deliveries before any request is
  // made, so "between two batches" no longer exists. What is left of the rule: an endpoint
  // switched off while a round is sending to it gets at most the rest of that round's cap,
  // and nothing from the next round on; what was queued for it waits.
  test('an endpoint switched off while a round is sending to it is sent nothing from the next round on', async () => {
    const endpoint = await register()
    for (let count = 0; count < Webhooks.WEBHOOK_BATCH_SIZE + 5; count++) {
      happen()
    }
    let seen = 0
    respond = async () => {
      seen += 1
      if (seen === 1) {
        await Webhooks.update(deps, tenant, endpoint.id, { enabled: false }, TEST_ACTOR)
      }
      return new Response(null, { status: 204 })
    }
    await Webhooks.deliverPending(deps)
    expect(received).toHaveLength(Webhooks.WEBHOOK_ENDPOINT_ROUND_CAP)
    await Webhooks.deliverPending(deps)
    await Webhooks.deliverPending(deps)
    expect(received).toHaveLength(Webhooks.WEBHOOK_ENDPOINT_ROUND_CAP)
    // Every event is settled, the endpoint's own "switched off" among them.
    expect(deps.activityLog.outbox.every((row) => row.deliveredAt !== null)).toBe(true)
    const waiting = deps.webhookDeliveries.rows.filter((row) => row.state === 'pending')
    expect(waiting).toHaveLength(
      Webhooks.WEBHOOK_BATCH_SIZE + 5 - Webhooks.WEBHOOK_ENDPOINT_ROUND_CAP
    )
    expect(waiting.every((row) => row.attempts === 0)).toBe(true)
  })

  test('a delivery an earlier round queued and sent, but whose event it did not settle, is not sent again', async () => {
    const endpoint = await register()
    const eventId = happen()
    const id = deps.ids.next()
    await deps.webhookDeliveries.enqueue([
      {
        id,
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        endpointId: endpoint.id,
        eventId,
        eventType: 'user.deleted',
        at: deps.clock.now(),
      },
    ])
    await deps.webhookDeliveries.recordAttempt(
      tenant.environmentId,
      id,
      {
        id: deps.ids.next(),
        attemptedAt: deps.clock.now(),
        statusCode: 200,
        durationMs: 9,
        failureReason: null,
      },
      { state: 'delivered', nextAttemptAt: null, completedAt: deps.clock.now() },
      'pending'
    )
    await Webhooks.deliverPending(deps)
    expect(received).toEqual([])
    expect(await deliveriesOf(eventId)).toHaveLength(1)
    expect(outboxRow(eventId).deliveredAt).not.toBeNull()
  })

  test('two instances: the second skips the round while the first runs it, and the event is sent once', async () => {
    await register()
    const eventId = happen()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered: () => void = () => undefined
    const arrived = new Promise<void>((resolve) => {
      entered = resolve
    })
    respond = async () => {
      entered()
      await gate
      return new Response(null, { status: 204 })
    }
    // Two instances share the database's job lock.
    const second = createTestDeps({ ...deps })
    const first = Webhooks.run(deps)
    await arrived
    expect(await Webhooks.run(second)).toBeNull()
    release()
    expect(comparable(await first)).toMatchObject(comparable({ delivered: 1 }))
    expect(received).toHaveLength(1)
    expect(await deliveriesOf(eventId)).toHaveLength(1)
    // Once the first is done, the next round is the second's to run: nothing is left.
    expect(comparable(await Webhooks.run(second))).toMatchObject(
      comparable({ events: 0, delivered: 0 })
    )
    expect(received).toHaveLength(1)
  })

  test('two rounds that overlap without the lock still leave one delivery row and one settlement', async () => {
    await register()
    const eventId = happen()
    const [one, two] = await Promise.all([
      Webhooks.deliverPending(deps),
      Webhooks.deliverPending(deps),
    ])
    // Delivery is at least once: without the lock the receiver may see the id twice.
    expect(new Set(received.map((request) => request.headers['webhook-id']))).toEqual(
      new Set([eventId])
    )
    expect(await deliveriesOf(eventId)).toHaveLength(1)
    // The creation event and the user's, each settled by exactly one of the two rounds.
    expect(one.events + two.events).toBe(2)
  })

  test('a failure in one environment is logged and does not keep the next from being served', async () => {
    quietLogs()
    await register(tenant)
    await register(otherTenant)
    happen(tenant)
    const theirs = happen(otherTenant)
    const pending = deps.webhookDeliveries.pendingEvents.bind(deps.webhookDeliveries)
    spies.push(
      spyOn(deps.webhookDeliveries, 'pendingEvents').mockImplementation(async (id, limit) => {
        if (id === tenant.environmentId) {
          throw new Error('canary: connection to 10.9.8.7 refused')
        }
        return pending(id, limit)
      }) as never
    )
    const report = await Webhooks.deliverPending(deps)
    expect(comparable(report)).toMatchObject(
      comparable({ environments: 2, failed: 1, delivered: 1 })
    )
    expect(received.map((request) => request.headers['webhook-id'])).toEqual([theirs])
    expect(logged()).toContain('webhook delivery failed in one environment')
    expect(logged()).toContain(tenant.environmentId)
  })

  // Changed with retries (TULA-42): an event is settled when its delivery is queued, so what a
  // failed write leaves behind is a delivery that is still pending, not an unsettled event.
  test('when recording a request fails, what was recorded before it stays, the one in flight is sent again, and the lost request is not counted', async () => {
    quietLogs()
    await register()
    const first = happen()
    deps.clock.advance('1s')
    const second = happen()
    const record = deps.webhookDeliveries.recordAttempt.bind(deps.webhookDeliveries)
    let calls = 0
    const failing = spyOn(deps.webhookDeliveries, 'recordAttempt').mockImplementation(
      async (...args) => {
        calls += 1
        if (calls === 2) {
          throw new Error('the database went away')
        }
        return record(...args)
      }
    )
    const report = await Webhooks.deliverPending(deps)
    expect(report.failed).toBe(1)
    expect(comparable(await deliveriesOf(first))).toMatchObject(
      comparable([{ state: 'delivered', attempts: 1 }])
    )
    // Sent, and nothing says so: still pending, still due, with no attempt counted.
    expect(comparable(await deliveriesOf(second))).toMatchObject(
      comparable([{ state: 'pending', attempts: 0, log: [] }])
    )

    failing.mockRestore()
    await Webhooks.deliverPending(deps)
    // At least once: the receiver sees the second event's id twice.
    expect(received.map((request) => request.headers['webhook-id'])).toEqual([
      first,
      second,
      second,
    ])
    // The request that was not recorded does not use up one of the delivery's attempts.
    expect(comparable(await deliveriesOf(second))).toMatchObject(
      comparable([{ state: 'delivered', attempts: 1 }])
    )
  })

  test('an error that is not the guard’s fails the environment and leaves the delivery waiting, with nothing counted', async () => {
    quietLogs()
    await register()
    const eventId = happen()
    spies.push(
      spyOn(Outbound, 'request').mockImplementation(async () => {
        throw new TypeError('a programming error')
      }) as never
    )
    const report = await Webhooks.deliverPending(deps)
    expect(report.failed).toBe(1)
    expect(comparable(await deliveriesOf(eventId))).toMatchObject(
      comparable([{ state: 'pending', attempts: 0, log: [] }])
    )
  })

  test('a slow endpoint uses up its environment’s budget, not the round: the next environment is served', async () => {
    await register(tenant, { url: receiverUrl('/slow') })
    await register(otherTenant, { url: receiverUrl('/fast') })
    const slow = [happen(tenant), happen(tenant), happen(tenant), happen(tenant), happen(tenant)]
    const fast = happen(otherTenant)
    respond = (req) => {
      if (new URL(req.url).pathname === '/slow') {
        // Each delivery to it takes the whole deadline.
        deps.clock.advance(Webhooks.WEBHOOK_DELIVERY_TIMEOUT_MS)
      }
      return new Response(null, { status: 204 })
    }
    await Webhooks.deliverPending(deps)
    const perRound = Webhooks.WEBHOOK_ENVIRONMENT_BUDGET_MS / Webhooks.WEBHOOK_DELIVERY_TIMEOUT_MS
    expect(received.filter((request) => request.path === '/slow')).toHaveLength(perRound)
    expect(received.filter((request) => request.path === '/fast')).toHaveLength(1)
    expect(outboxRow(fast).deliveredAt).not.toBeNull()
    const states = async () =>
      (await Promise.all(slow.map((id) => deliveriesOf(id)))).map(([row]) => row?.state)
    expect(await states()).toEqual(['delivered', 'delivered', 'delivered', 'pending', 'pending'])
    // What was left is taken up by the next round, and nothing is sent twice.
    await Webhooks.deliverPending(deps)
    expect(
      received.filter((request) => request.path === '/slow').map((r) => r.headers['webhook-id'])
    ).toEqual(slow)
  })

  test('a backlog is worked off in bounded batches, over as many rounds as it takes', async () => {
    const backlog = Webhooks.WEBHOOK_BATCH_SIZE * Webhooks.WEBHOOK_MAX_BATCHES + 50
    for (let count = 0; count < backlog; count++) {
      deps.activityLog.outbox.push({
        id: deps.ids.next(),
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        type: 'session.created',
        payload: { actor: { type: 'system', id: null }, target: null, data: {} },
        occurredAt: deps.clock.now(),
        deliveredAt: null,
      })
    }
    const reads = spyOn(deps.webhookDeliveries, 'pendingEvents')
    spies.push(reads as never)
    const first = await Webhooks.deliverPending(deps)
    expect(comparable(first)).toMatchObject(
      comparable({ events: backlog - 50, skipped: backlog - 50 })
    )
    // Ten batches for this environment, one empty read for the other.
    expect(reads).toHaveBeenCalledTimes(Webhooks.WEBHOOK_MAX_BATCHES + 1)
    expect(reads.mock.calls.every(([, limit]) => limit === Webhooks.WEBHOOK_BATCH_SIZE)).toBe(true)
    expect(comparable(await Webhooks.deliverPending(deps))).toMatchObject(
      comparable({ events: 50, skipped: 50 })
    )
    expect(comparable(await Webhooks.deliverPending(deps))).toMatchObject(
      comparable({ events: 0, skipped: 0 })
    )
  })
})

describe('a secret the server cannot open', () => {
  test('is logged once per endpoint per round, with how many events it cost, not once per event', async () => {
    quietLogs()
    const broken = await register(tenant, { url: receiverUrl('/broken') })
    const fine = await register(tenant, { url: receiverUrl('/fine') })
    const record = await deps.webhookEndpoints.find(tenant.environmentId, broken.id)
    await deps.webhookEndpoints.delete(tenant.environmentId, broken.id, Audit.none('fixture'))
    await deps.webhookEndpoints.insert(
      { ...(record as NonNullable<typeof record>), secret: 'not-sealed' },
      Audit.none('fixture')
    )
    const events = Array.from({ length: 7 }, () => happen())

    await Webhooks.deliverPending(deps)

    const opened = (): unknown[][] =>
      ((spies[2]?.mock.calls ?? []) as unknown[][]).filter(([message]) =>
        String(message).includes('signing secret could not be opened')
      )
    expect(opened()).toEqual([
      [
        'webhook signing secret could not be opened; nothing was sent to the endpoint this round',
        { environmentId: tenant.environmentId, endpointId: broken.id, events: 7 },
      ],
    ])
    // Each delivery says why it waits, with no attempt counted, and the endpoint beside it is
    // not affected.
    const rows = deps.webhookDeliveries.rows.filter((row) => row.endpointId === broken.id)
    expect(events).toHaveLength(7)
    expect(
      rows.filter((row) => row.failureReason === 'signing_failed' && row.attempts === 0)
    ).toHaveLength(7)
    expect(received.filter((one) => one.path === '/fine')).toHaveLength(7)
    expect(received.filter((one) => one.path === '/broken')).toEqual([])
    expect(fine.id).not.toBe(broken.id)

    // The next round says it again, once, if it happens again.
    happen()
    await Webhooks.deliverPending(deps)
    expect(opened()).toHaveLength(2)
  })
})

describe('a backlog owed to nobody', () => {
  /** Put `count` events of the contract in the outbox, as recorded at `at`. */
  function backlog(count: number, at: Date, scope: Tenant = tenant): string[] {
    const ids: string[] = []
    for (let index = 0; index < count; index++) {
      const id = deps.ids.next()
      ids.push(id)
      deps.activityLog.outbox.push({
        id,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        type: 'user.deleted',
        payload: { id, type: 'user.deleted', schemaVersion: 1 },
        occurredAt: new Date(at),
        deliveredAt: null,
      })
    }
    return ids
  }

  test('a large outbox from before the first endpoint does not delay the first delivery', async () => {
    const old = backlog(12_000, deps.clock.now())
    deps.clock.advance('1h')
    await register()
    const fresh = happen()

    const report = await Webhooks.deliverPending(deps)

    // One round: the event that is owed arrives, though twelve thousand older ones were ahead.
    expect(received.map((request) => request.headers['webhook-id'])).toEqual([fresh])
    expect(outboxRow(fresh).deliveredAt).not.toBeNull()
    expect(old.every((id) => outboxRow(id).deliveredAt !== null)).toBe(true)
    expect(comparable(report)).toMatchObject(
      comparable({ unowed: 12_000, delivered: 1, skipped: 0 })
    )
    // Settled in bulk: no delivery row, nothing sent.
    expect(deps.webhookDeliveries.rows.map((row) => row.eventId)).toEqual([fresh])
  })

  test('an environment with no endpoint settles what it has in bulk', async () => {
    const old = backlog(3_000, deps.clock.now())
    deps.clock.advance('1s')
    const reads = spyOn(deps.webhookDeliveries, 'pendingEvents')
    spies.push(reads as never)
    const report = await Webhooks.deliverPending(deps)
    expect(comparable(report)).toMatchObject(comparable({ events: 3_000, unowed: 3_000 }))
    expect(old.every((id) => outboxRow(id).deliveredAt !== null)).toBe(true)
    // Not read a hundred at a time.
    expect(
      reads.mock.calls.filter(([id]) => id === tenant.environmentId).length
    ).toBeLessThanOrEqual(1)
  })

  test('an event at the very instant the earliest endpoint was registered is owed, and is sent', async () => {
    const before = backlog(1, new Date(deps.clock.now().getTime() - 1))
    await register()
    const same = backlog(1, deps.clock.now())
    await Webhooks.deliverPending(deps)
    expect(received.map((request) => request.headers['webhook-id'])).toEqual(same)
    expect(await deliveriesOf(same[0] as string)).toHaveLength(1)
    expect(await deliveriesOf(before[0] as string)).toEqual([])
    expect(outboxRow(before[0] as string).deliveredAt).not.toBeNull()
  })

  test('a switched-off endpoint does not hold events back: only endpoints that are on are owed anything', async () => {
    await register(tenant, { enabled: false })
    deps.clock.advance('1s')
    const between = backlog(2_000, deps.clock.now())
    deps.clock.advance('1s')
    await register(tenant, { url: receiverUrl('/on') })
    const fresh = happen()
    const report = await Webhooks.deliverPending(deps)
    expect(received.map((request) => request.headers['webhook-id'])).toEqual([fresh])
    expect(between.every((id) => outboxRow(id).deliveredAt !== null)).toBe(true)
    expect(report.unowed).toBeGreaterThanOrEqual(2_000)
  })

  test('one environment’s backlog is settled by its own endpoints’ dates, not another’s', async () => {
    await register(otherTenant)
    deps.clock.advance('1s')
    const mine = backlog(5, deps.clock.now(), tenant)
    const theirs = backlog(5, deps.clock.now(), otherTenant)
    deps.clock.advance('1s')
    await register(tenant, { url: receiverUrl('/dev') })
    await Webhooks.deliverPending(deps)
    // Theirs happened after their endpoint was registered: sent. Mine happened before mine.
    expect(received.map((request) => request.headers['webhook-id']).sort()).toEqual(
      [...theirs].sort()
    )
    expect(mine.every((id) => outboxRow(id).deliveredAt !== null)).toBe(true)
  })

  test('the bulk settling is bounded per round and is not started once the round is told to stop', async () => {
    backlog(10, deps.clock.now())
    deps.clock.advance('1s')
    const settle = spyOn(deps.webhookDeliveries, 'settleBefore')
    spies.push(settle as never)
    expect(comparable(await Webhooks.deliverPending(deps, AbortSignal.abort()))).toMatchObject(
      comparable({ unowed: 0 })
    )
    expect(settle).not.toHaveBeenCalled()
    await Webhooks.deliverPending(deps)
    expect(settle).toHaveBeenCalled()
    expect(
      settle.mock.calls.every(([, , , limit]) => limit === Webhooks.WEBHOOK_SETTLE_BATCH_SIZE)
    ).toBe(true)
    expect(
      Webhooks.WEBHOOK_SETTLE_BATCH_SIZE * Webhooks.WEBHOOK_MAX_SETTLE_BATCHES
    ).toBeLessThanOrEqual(200_000)
  })
})

describe('the cap on endpoints under concurrency', () => {
  test('twelve registrations at once leave ten endpoints, and two are told why', async () => {
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => register()))
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(
      MAX_WEBHOOK_ENDPOINTS
    )
    const refused = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    expect(refused.map((result) => (result.reason as ServiceException).status)).toEqual([409, 409])
    expect(await Webhooks.list(deps, tenant)).toHaveLength(MAX_WEBHOOK_ENDPOINTS)
    expect(deps.activityLog.ofType('webhook_endpoint.created')).toHaveLength(MAX_WEBHOOK_ENDPOINTS)
  })

  test('the count and the insert take the environment’s own lock, and no other environment’s', async () => {
    const lock = spyOn(deps.environmentLock, 'runExclusive')
    spies.push(lock as never)
    await Promise.all([register(tenant), register(otherTenant)])
    expect(lock.mock.calls.map(([environment, scope]) => `${scope}:${environment}`).sort()).toEqual(
      [
        `webhook_endpoints:${tenant.environmentId}`,
        `webhook_endpoints:${otherTenant.environmentId}`,
      ].sort()
    )
  })
})

describe('an endpoint that does not answer', () => {
  test('costs its environment one deadline a round, not one per event: the healthy endpoint gets everything', async () => {
    quietLogs()
    const hung = await register(tenant, { url: receiverUrl('/hung') })
    const healthy = await register(tenant, { url: receiverUrl('/healthy') })
    const events = Array.from({ length: 20 }, () => happen())
    const real = Outbound.request
    const request = spyOn(Outbound, 'request').mockImplementation(async (settings, url, init) => {
      if (url.endsWith('/hung')) {
        deps.clock.advance(Webhooks.WEBHOOK_DELIVERY_TIMEOUT_MS)
        throw new Outbound.OutboundError('timeout')
      }
      return real(settings, url, init)
    })
    spies.push(request as never)

    await Webhooks.deliverPending(deps)

    expect(
      received.filter((one) => one.path === '/healthy').map((one) => one.headers['webhook-id'])
    ).toEqual(events)
    // One real request to the endpoint that hangs; the rest of what it is owed is put off
    // WITHOUT being tried, with a word of its own and no attempt counted.
    expect(request.mock.calls.filter(([, url]) => url.endsWith('/hung'))).toHaveLength(1)
    const rows = deps.webhookDeliveries.rows.filter((row) => row.endpointId === hung.id)
    expect(rows.map((row): string | null => row.failureReason).sort()).toEqual([
      ...Array.from({ length: 19 }, () => 'endpoint_unresponsive'),
      'timeout',
    ])
    expect(rows.every((row) => row.state === 'pending' && row.statusCode === null)).toBe(true)
    expect(rows.map((row) => row.attempts).sort()).toEqual([
      ...Array.from({ length: 19 }, () => 0),
      1,
    ])
    expect(events.every((id) => outboxRow(id).deliveredAt !== null)).toBe(true)
    expect(
      deps.webhookDeliveries.rows.filter(
        (row) => row.endpointId === healthy.id && row.state === 'delivered'
      )
    ).toHaveLength(20)

    // The next round tries it again: being skipped lasts one round.
    happen()
    await Webhooks.deliverPending(deps)
    expect(request.mock.calls.filter(([, url]) => url.endsWith('/hung'))).toHaveLength(2)
  })

  test('an endpoint that answers with an error, or refuses the connection, is still tried for every event', async () => {
    quietLogs()
    await register()
    happen()
    happen()
    respond = () => new Response('no', { status: 503 })
    await Webhooks.deliverPending(deps)
    expect(received).toHaveLength(2)
  })
})

describe('stopping a round', () => {
  test('a round told to stop records the delivery under way and sends nothing more', async () => {
    await register(tenant, { url: receiverUrl('/dev') })
    await register(otherTenant, { url: receiverUrl('/prod') })
    const first = happen(tenant)
    deps.clock.advance('1s')
    const second = happen(tenant)
    const theirs = happen(otherTenant)
    const stop = new AbortController()
    respond = () => {
      // The server is shutting down while this delivery is being answered.
      stop.abort()
      return new Response(null, { status: 204 })
    }
    const report = await Webhooks.deliverPending(deps, stop.signal)
    expect(received.map((request) => request.headers['webhook-id'])).toEqual([first])
    // What was sent is on record, so the next start does not send it again.
    expect(comparable(await deliveriesOf(first))).toMatchObject(
      comparable([{ state: 'delivered' }])
    )
    expect(outboxRow(first).deliveredAt).not.toBeNull()
    // Queued before the stop, never tried: it waits with nothing counted.
    expect(comparable(await deliveriesOf(second))).toMatchObject(
      comparable([{ state: 'pending', attempts: 0 }])
    )
    expect(outboxRow(theirs).deliveredAt).toBeNull()
    expect(comparable(report)).toMatchObject(
      comparable({ environments: 1, failed: 0, delivered: 1 })
    )

    respond = () => new Response(null, { status: 204 })
    await Webhooks.deliverPending(deps)
    expect(received.map((request) => request.headers['webhook-id']).sort()).toEqual(
      [first, second, theirs].sort()
    )
  })

  test('a round that was told to stop before it began visits no environment', async () => {
    await register()
    const eventId = happen()
    const report = await Webhooks.run(deps, AbortSignal.abort())
    expect(comparable(report)).toMatchObject(comparable({ environments: 0, events: 0 }))
    expect(received).toEqual([])
    expect(outboxRow(eventId).deliveredAt).toBeNull()
  })
})

describe('run', () => {
  test('runs a round under the delivery job’s own lock', async () => {
    const lock = spyOn(deps.jobLock, 'runExclusive')
    spies.push(lock as never)
    await register()
    happen()
    expect(comparable(await Webhooks.run(deps))).toMatchObject(comparable({ delivered: 1 }))
    expect(lock.mock.calls.map(([job]) => job)).toEqual(['webhook_delivery'])
  })

  test('does not keep the retention job from running, nor wait for it', async () => {
    let inside: unknown
    await deps.jobLock.runExclusive('retention', async () => {
      inside = await Webhooks.run(deps)
    })
    expect(comparable(inside)).toMatchObject(comparable({ environments: 2 }))
  })

  test.each([
    ['an idle round', 'debug', async (): Promise<void> => undefined],
    [
      'a round that delivered',
      'info',
      async (): Promise<void> => {
        await register()
        happen()
      },
    ],
    [
      'a round with a failed delivery',
      'warn',
      async (): Promise<void> => {
        await register()
        happen()
        respond = () => new Response('no', { status: 500 })
      },
    ],
  ] as const)('%s is logged at %s, with counts only', async (_, level, arrange) => {
    quietLogs()
    await arrange()
    const report = await Webhooks.run(deps)
    // `quietLogs` spies on the four levels in this order.
    const levels = ['debug', 'info', 'warn', 'error']
    const lines = spies.flatMap((spy, index) =>
      (spy.mock.calls as unknown[][])
        .filter(([message]) => message === 'webhook delivery round finished')
        .map(([, context]) => ({ level: levels[index], context }))
    )
    expect(lines).toEqual([{ level, context: { ...report } }])
    expect(Object.values(report ?? {}).every((value) => typeof value === 'number')).toBe(true)
  })

  test('a round that failed in an environment is logged as a warning', async () => {
    quietLogs()
    spies.push(
      spyOn(deps.webhookDeliveries, 'pendingEvents').mockImplementation(async () => {
        throw new Error('down')
      }) as never
    )
    expect(comparable(await Webhooks.run(deps))).toMatchObject(comparable({ failed: 2 }))
    const warned = ((spies[2]?.mock.calls ?? []) as unknown[][]).map(([message]) => message)
    expect(warned).toContain('webhook delivery round finished')
  })

  test('when the environments cannot be listed the round rejects and the lock is free again', async () => {
    const list = spyOn(deps.environments, 'listAll').mockImplementation(async () => {
      throw new Error('database is down')
    })
    expect(Webhooks.run(deps)).rejects.toThrow('database is down')
    list.mockRestore()
    expect(comparable(await Webhooks.run(deps))).toMatchObject(comparable({ environments: 2 }))
  })

  test('the worker wakes often enough for a webhook to be prompt, and a delivery fits inside its environment’s budget', () => {
    expect(Webhooks.WEBHOOK_DELIVERY_INTERVAL_MS).toBeLessThanOrEqual(10_000)
    expect(Webhooks.WEBHOOK_DELIVERY_TIMEOUT_MS).toBeLessThan(
      Webhooks.WEBHOOK_ENVIRONMENT_BUDGET_MS
    )
    expect(TEST_CONFIG.tier).toBe('local')
  })
})
