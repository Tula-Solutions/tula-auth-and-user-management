import { afterAll, afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from 'bun:test'
import {
  ACTIVITY_TYPES,
  durationToMs,
  EVENT_FIXTURES,
  signWebhook,
  TulaEventSchema,
  webhookSecretBytes,
} from '@tula/contract'
import { FixedClock } from '~/adapters/memory/clock'
import type { Tenant } from '~/dependencies'
import { ServiceException } from '~/exceptions'
import * as logger from '~/lib/logger'
import * as Outbound from '~/lib/outbound'
import * as Audit from '~/modules/audit/service'
import * as Webhooks from '~/modules/webhook/service'
import { createTestDeps, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'

// Retries, giving up, switching an endpoint off, the caps of a round, the delivery log, test
// events and sending a delivery again (TULA-42). The receiver is a listener in this process,
// reached through the real outbound guard; time is the test's clock, and nothing sleeps.

const tenant: Tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}
const otherTenant: Tenant = { ...tenant, environmentId: TEST_TENANT.productionEnvironmentId }

interface Received {
  path: string
  headers: Record<string, string>
  body: string
}

let received: Received[] = []
let respond: (req: Request) => Response | Promise<Response> = () =>
  new Response(null, { status: 204 })
const listener = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)
    received.push({
      path: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(req.headers),
      body: await req.text(),
    })
    return respond(req)
  },
})
afterAll(() => listener.stop(true))

const receiverUrl = (path = '/hook') => `http://127.0.0.1:${listener.port}${path}`
const answer = (status: number) => () => new Response(null, { status })

let deps: TestDeps
let spies: Mock<(...args: never[]) => unknown>[] = []

beforeEach(() => {
  received = []
  respond = answer(204)
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

function quietLogs(): void {
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    spies.push(spyOn(logger, level).mockImplementation(() => undefined))
  }
}

/** Everything the logger was given while `spy`s were on, as one text. */
function logged(): string {
  return JSON.stringify(spies.flatMap((spy) => spy.mock.calls))
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

/** Record that something happened: an outbox event and an audit entry. Returns the event's id. */
function happen(scope: Tenant = tenant, type: 'user.deleted' | 'user.banned' = 'user.deleted') {
  const activity = Audit.entry(deps, scope, {
    type,
    actor: TEST_ACTOR,
    target: { type: 'user', id: deps.ids.next() },
  })
  deps.activityLog.record([activity])
  return activity.id
}

const round = () => Webhooks.deliverPending(deps)

/** The one delivery of an event to an endpoint of `tenant`, with its attempts. */
function deliveryOf(eventId: string) {
  const [row, ...more] = deps.webhookDeliveries.rows.filter((one) => one.eventId === eventId)
  if (!row || more.length > 0) {
    throw new Error(`expected one delivery of the event, found ${more.length + (row ? 1 : 0)}`)
  }
  return { ...row, log: deps.webhookDeliveries.attemptsOf(row.id) }
}

const sentTo = (path: string) =>
  received.filter((request) => request.path === path).map((r) => r.headers['webhook-id'])

const endpointNow = async (id: string, scope: Tenant = tenant) => {
  const record = await deps.webhookEndpoints.find(scope.environmentId, id)
  if (!record) {
    throw new Error('no such endpoint')
  }
  return record
}

/** Swap an endpoint's sealed secret for one that does not open, and back. */
async function breakSecret(id: string): Promise<() => Promise<void>> {
  const record = await endpointNow(id)
  const swap = async (secret: string) => {
    const current = await endpointNow(id)
    await deps.webhookEndpoints.delete(tenant.environmentId, id, Audit.none('fixture'))
    // The deliveries of a removed endpoint go with it; a test that needs them asks afterwards.
    await deps.webhookEndpoints.insert({ ...current, secret }, Audit.none('fixture'))
  }
  await swap('not-sealed')
  return () => swap(record.secret)
}

describe('the retry schedule', () => {
  test('a delivery that keeps failing is tried eight times, each when the schedule says, and then given up', async () => {
    quietLogs()
    const endpoint = await register()
    const eventId = happen()
    respond = answer(500)
    const started = deps.clock.now().getTime()

    expect(await round()).toMatchObject({ undelivered: 1, givenUp: 0 })
    for (const [index, wait] of Webhooks.WEBHOOK_RETRY_DELAYS.entries()) {
      expect(deliveryOf(eventId)).toMatchObject({
        state: 'pending',
        attempts: index + 1,
        nextAttemptAt: new Date(deps.clock.now().getTime() + durationToMs(wait)),
      })
      // One millisecond early is too early, however often the worker looks.
      deps.clock.advance(durationToMs(wait) - 1)
      await round()
      await round()
      expect(received).toHaveLength(index + 1)
      deps.clock.advance(1)
      const report = await round()
      expect(received).toHaveLength(index + 2)
      expect(report.undelivered).toBe(1)
      expect(report.givenUp).toBe(index === Webhooks.WEBHOOK_RETRY_DELAYS.length - 1 ? 1 : 0)
    }

    const given = deliveryOf(eventId)
    expect(given).toMatchObject({
      state: 'failed',
      attempts: Webhooks.WEBHOOK_MAX_ATTEMPTS,
      nextAttemptAt: null,
      completedAt: deps.clock.now(),
      statusCode: 500,
      failureReason: null,
    })
    // Every request is on record, numbered, each with a status code and a duration and
    // nothing else of what the receiver said.
    expect(given.log.map((attempt) => attempt.attempt)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    for (const attempt of given.log) {
      expect(Object.keys(attempt).sort()).toEqual([
        'attempt',
        'attemptedAt',
        'durationMs',
        'failureReason',
        'id',
        'statusCode',
      ])
      expect(attempt).toMatchObject({ statusCode: 500, durationMs: 0, failureReason: null })
    }
    // Every request carried the same id: a receiver drops a repeat by it.
    expect(new Set(sentTo('/hook'))).toEqual(new Set([eventId]))
    expect(deps.clock.now().getTime() - started).toBe(
      durationToMs('27h') + durationToMs('35m') + 5_000
    )

    // Given up is given up: no amount of time brings it back.
    deps.clock.advance('2d')
    respond = answer(204)
    await round()
    expect(received).toHaveLength(Webhooks.WEBHOOK_MAX_ATTEMPTS)
    expect(deliveryOf(eventId).state).toBe('failed')
    // A day of failures is not what switches an endpoint off.
    expect(await endpointNow(endpoint.id)).toMatchObject({ enabled: true, disabledReason: null })
  })

  test('the schedule is eight requests over a day and a few hours, inside the age at which a delivery is given up', () => {
    const total = Webhooks.WEBHOOK_RETRY_DELAYS.reduce((sum, wait) => sum + durationToMs(wait), 0)
    expect(Webhooks.WEBHOOK_MAX_ATTEMPTS).toBe(Webhooks.WEBHOOK_RETRY_DELAYS.length + 1)
    expect(Webhooks.WEBHOOK_MAX_ATTEMPTS).toBe(8)
    expect(total).toBeGreaterThan(durationToMs('1d'))
    expect(total).toBeLessThan(durationToMs('2d'))
    // With the most jitter the last request is still made before the delivery would expire.
    expect(total * (1 + Webhooks.WEBHOOK_RETRY_JITTER)).toBeLessThan(
      durationToMs(Webhooks.WEBHOOK_DELIVERY_MAX_AGE)
    )
    // Each wait is at least as long as the one before: a backoff.
    const waits = Webhooks.WEBHOOK_RETRY_DELAYS.map((wait) => durationToMs(wait))
    expect(waits).toEqual([...waits].sort((a, b) => a - b))
    // The first retry is within a round or two of the failure.
    expect(waits[0]).toBeLessThanOrEqual(2 * Webhooks.WEBHOOK_DELIVERY_INTERVAL_MS)
  })

  test.each([
    ['none', 0, 5_000],
    ['half', 0.5, 5_500],
    ['almost all', 0.999, 5_999],
    // A source that misbehaves can stretch a wait by a fifth and no more, and never shorten it.
    ['more than one', 7, 6_000],
    ['a negative number', -3, 5_000],
    ['not a number', Number.NaN, 5_000],
    ['infinity', Number.POSITIVE_INFINITY, 5_000],
  ])('jitter (%s) stretches the wait by up to a fifth and never shortens it', (_, drawn, wait) => {
    const at = Webhooks.nextAttemptAt({ clock: deps.clock, jitter: () => drawn }, 1)
    expect(at?.getTime()).toBe(deps.clock.now().getTime() + wait)
  })

  test('the jitter comes from the injected source, drawn once per failed request', async () => {
    quietLogs()
    let draws = 0
    deps = createTestDeps({
      ...deps,
      jitter: () => {
        draws += 1
        return 0.5
      },
    })
    await register()
    const eventId = happen()
    respond = answer(503)
    await round()
    expect(draws).toBe(1)
    expect(deliveryOf(eventId).nextAttemptAt).toEqual(new Date(deps.clock.now().getTime() + 5_500))
    deps.clock.advance(5_499)
    await round()
    expect(received).toHaveLength(1)
    deps.clock.advance(1)
    await round()
    expect(received).toHaveLength(2)
    expect(draws).toBe(2)
  })

  test('there is no wait after the last request, and none is asked for', () => {
    const next = (made: number) =>
      Webhooks.nextAttemptAt({ clock: deps.clock, jitter: () => 0 }, made)
    expect(next(Webhooks.WEBHOOK_MAX_ATTEMPTS - 1)).not.toBeNull()
    expect(next(Webhooks.WEBHOOK_MAX_ATTEMPTS)).toBeNull()
    expect(next(Webhooks.WEBHOOK_MAX_ATTEMPTS + 5)).toBeNull()
  })

  test('a delivery that gets through on a retry is delivered, and its endpoint is no longer failing', async () => {
    quietLogs()
    const endpoint = await register()
    const eventId = happen()
    respond = answer(502)
    await round()
    expect((await endpointNow(endpoint.id)).failingSince).toEqual(deps.clock.now())
    deps.clock.advance('5s')
    respond = answer(200)
    expect(await round()).toMatchObject({ delivered: 1, undelivered: 0 })
    expect(deliveryOf(eventId)).toMatchObject({
      state: 'delivered',
      attempts: 2,
      statusCode: 200,
      nextAttemptAt: null,
      completedAt: deps.clock.now(),
    })
    expect(deliveryOf(eventId).log.map((attempt) => attempt.statusCode)).toEqual([502, 200])
    expect((await endpointNow(endpoint.id)).failingSince).toBeNull()
  })

  test('a receiver’s Retry-After is not honoured: the schedule is the server’s own', async () => {
    quietLogs()
    await register()
    const eventId = happen()
    respond = () => new Response(null, { status: 503, headers: { 'retry-after': '86400' } })
    await round()
    expect(deliveryOf(eventId).nextAttemptAt).toEqual(new Date(deps.clock.now().getTime() + 5_000))
    respond = () => new Response(null, { status: 429, headers: { 'retry-after': '0' } })
    deps.clock.advance('5s')
    await round()
    expect(deliveryOf(eventId).nextAttemptAt).toEqual(
      new Date(deps.clock.now().getTime() + durationToMs('5m'))
    )
  })

  test('a failure that never reached the receiver (a refused address) is a request like any other: counted and retried', async () => {
    quietLogs()
    deps.outbound.point('hooks.example.test', '127.0.0.1')
    await register(tenant, { url: `http://hooks.example.test:${listener.port}/hook` })
    deps.outbound.point('hooks.example.test', '10.0.0.7')
    const eventId = happen()
    await round()
    expect(received).toEqual([])
    expect(deliveryOf(eventId)).toMatchObject({
      state: 'pending',
      attempts: 1,
      failureReason: 'address_not_allowed',
    })
    // The name is pointed back: the retry gets through.
    deps.outbound.point('hooks.example.test', '127.0.0.1')
    deps.clock.advance('5s')
    await round()
    expect(deliveryOf(eventId)).toMatchObject({ state: 'delivered', attempts: 2 })
  })

  test('a failing endpoint holds nothing back: its environment’s later events are settled and reach the healthy endpoint at once', async () => {
    quietLogs()
    await register(tenant, { url: receiverUrl('/down') })
    await register(tenant, { url: receiverUrl('/up') })
    respond = (req) => answer(new URL(req.url).pathname === '/down' ? 500 : 204)()
    const first = happen()
    await round()
    // While the first event's delivery to the failing endpoint waits hours for its retries…
    deps.clock.advance('10m')
    await round()
    const later = [happen(), happen(), happen()]
    await round()
    // …everything that happens afterwards is settled, and is delivered where it can be.
    expect(deps.activityLog.outbox.every((row) => row.deliveredAt !== null)).toBe(true)
    expect(await deps.webhookDeliveries.pendingEvents(tenant.environmentId, 10)).toEqual([])
    expect(sentTo('/up')).toEqual([first, ...later])
  })
})

describe('what is not an attempt', () => {
  test('a secret that cannot be opened counts nothing against the receiver, and the deliveries are sent once the key is right', async () => {
    quietLogs()
    const endpoint = await register()
    const restore = await breakSecret(endpoint.id)
    const events = [happen(), happen(), happen()]
    // Many more rounds than a delivery has attempts.
    for (let count = 0; count < 3 * Webhooks.WEBHOOK_MAX_ATTEMPTS; count++) {
      expect(await round()).toMatchObject({ undelivered: 0, givenUp: 0, disabled: 0 })
      deps.clock.advance(Webhooks.WEBHOOK_SIGNING_RETRY_DELAY)
    }
    expect(received).toEqual([])
    for (const eventId of events) {
      expect(deliveryOf(eventId)).toMatchObject({
        state: 'pending',
        attempts: 0,
        failureReason: 'signing_failed',
        log: [],
      })
    }
    // The fault was the server's: the endpoint is not failing and is not switched off.
    expect(await endpointNow(endpoint.id)).toMatchObject({ enabled: true, failingSince: null })

    // The swap removed and re-made the endpoint, and its deliveries went with it; these are
    // the ones that count: queued again for the same events.
    await restore()
    const ids = events.map(() => deps.ids.next())
    await deps.webhookDeliveries.enqueue(
      events.map((eventId, index) => ({
        id: ids[index] as string,
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        endpointId: endpoint.id,
        eventId,
        eventType: 'user.deleted',
        at: deps.clock.now(),
      }))
    )
    expect(await round()).toMatchObject({ delivered: 3 })
    expect(sentTo('/hook')).toEqual(events)
  })

  test('deliveries put off behind an unresponsive endpoint count no attempt, are due again in a minute, and none is ever lost to it', async () => {
    quietLogs()
    const endpoint = await register()
    const events = Array.from({ length: 6 }, () => happen())
    let hanging = true
    const real = Outbound.request
    const request = spyOn(Outbound, 'request').mockImplementation(async (settings, url, init) => {
      if (hanging) {
        deps.clock.advance(Webhooks.WEBHOOK_DELIVERY_TIMEOUT_MS)
        throw new Outbound.OutboundError('timeout')
      }
      return real(settings, url, init)
    })
    spies.push(request as never)

    expect(await round()).toMatchObject({ undelivered: 1, deferred: 5 })
    expect(request).toHaveBeenCalledTimes(1)
    const put = deps.webhookDeliveries.rows.filter(
      (row) => row.failureReason === 'endpoint_unresponsive'
    )
    expect(put).toHaveLength(5)
    for (const row of put) {
      expect(row).toMatchObject({
        state: 'pending',
        attempts: 0,
        lastAttemptAt: null,
        nextAttemptAt: new Date(
          deps.clock.now().getTime() + durationToMs(Webhooks.WEBHOOK_UNRESPONSIVE_DELAY)
        ),
      })
      expect(deps.webhookDeliveries.attemptsOf(row.id)).toEqual([])
    }

    // The endpoint comes back. Everything it was owed arrives: nothing was settled as lost.
    hanging = false
    deps.clock.advance(Webhooks.WEBHOOK_UNRESPONSIVE_DELAY)
    await round()
    expect([...sentTo('/hook')].sort()).toEqual([...events].sort())
    expect(deps.webhookDeliveries.rows.every((row) => row.state === 'delivered')).toBe(true)
    // The five that were put off were delivered on their FIRST request.
    expect(deps.webhookDeliveries.rows.map((row) => row.attempts).sort()).toEqual([
      1, 1, 1, 1, 1, 2,
    ])
    expect((await endpointNow(endpoint.id)).failingSince).toBeNull()
  })

  test('a delivery the round did not get to is left exactly as it was', async () => {
    await register()
    const events = Array.from({ length: Webhooks.WEBHOOK_ENDPOINT_ROUND_CAP + 3 }, () => happen())
    expect(await round()).toMatchObject({ delivered: Webhooks.WEBHOOK_ENDPOINT_ROUND_CAP })
    const left = deps.webhookDeliveries.rows.filter((row) => row.state === 'pending')
    expect(left).toHaveLength(3)
    expect(left.every((row) => row.attempts === 0 && row.failureReason === null)).toBe(true)
    await round()
    expect(sentTo('/hook')).toEqual(events)
  })
})

describe('giving up by age', () => {
  test('a delivery that is put off again and again without a request is given up after three days, never before', async () => {
    quietLogs()
    const endpoint = await register()
    await breakSecret(endpoint.id)
    const eventId = happen()
    await round()
    deps.clock.advance(durationToMs(Webhooks.WEBHOOK_DELIVERY_MAX_AGE))
    // Exactly at the limit it still waits.
    expect(await round()).toMatchObject({ givenUp: 0 })
    expect(deliveryOf(eventId).state).toBe('pending')
    deps.clock.advance(1)
    expect(await round()).toMatchObject({ givenUp: 1 })
    expect(deliveryOf(eventId)).toMatchObject({
      state: 'failed',
      attempts: 0,
      failureReason: 'expired',
      nextAttemptAt: null,
      completedAt: deps.clock.now(),
      log: [],
    })
    expect(received).toEqual([])
  })

  test('the pending deliveries of an endpoint that is switched off are not tried, and end when they are too old', async () => {
    quietLogs()
    const endpoint = await register()
    const eventId = happen()
    respond = answer(500)
    await round()
    await Webhooks.update(deps, tenant, endpoint.id, { enabled: false }, TEST_ACTOR)
    respond = answer(204)
    deps.clock.advance('2d')
    await round()
    expect(received).toHaveLength(1)
    expect(deliveryOf(eventId)).toMatchObject({ state: 'pending', attempts: 1 })
    deps.clock.advance('1d')
    deps.clock.advance(1)
    expect(await round()).toMatchObject({ givenUp: 1 })
    expect(deliveryOf(eventId)).toMatchObject({
      state: 'failed',
      attempts: 1,
      failureReason: 'expired',
    })
    // The one request that was made is still its only attempt.
    expect(deliveryOf(eventId).log).toHaveLength(1)
    expect(received).toHaveLength(1)
  })

  test('giving up by age is bounded per round and touches one environment at a time', async () => {
    const expire = spyOn(deps.webhookDeliveries, 'expire')
    spies.push(expire as never)
    await round()
    expect(expire.mock.calls.map(([environment]) => environment).sort()).toEqual(
      [tenant.environmentId, otherTenant.environmentId].sort()
    )
    expect(
      expire.mock.calls.every(([, , , limit]) => limit === Webhooks.WEBHOOK_EXPIRE_BATCH_SIZE)
    ).toBe(true)
    const cutoff = expire.mock.calls[0]?.[1] as Date
    expect(deps.clock.now().getTime() - cutoff.getTime()).toBe(
      durationToMs(Webhooks.WEBHOOK_DELIVERY_MAX_AGE)
    )
  })
})

describe('giving up by age, with more to give up than a round takes', () => {
  test('stops at its ceiling for the round and leaves the rest for the next one', async () => {
    // A store that always has another full batch: the round must not go on for ever.
    const expire = spyOn(deps.webhookDeliveries, 'expire').mockImplementation(
      async () => Webhooks.WEBHOOK_EXPIRE_BATCH_SIZE
    )
    spies.push(expire as never)
    const report = await round()
    // Two environments, each at its ceiling.
    expect(expire).toHaveBeenCalledTimes(2 * Webhooks.WEBHOOK_MAX_EXPIRE_BATCHES)
    expect(report).toMatchObject({
      failed: 0,
      givenUp: 2 * Webhooks.WEBHOOK_MAX_EXPIRE_BATCHES * Webhooks.WEBHOOK_EXPIRE_BATCH_SIZE,
    })
  })
})

describe('an event that is gone', () => {
  test('a pending delivery whose event no longer exists is given up with a word, and nothing is sent', async () => {
    quietLogs()
    await register()
    const eventId = happen()
    respond = answer(500)
    await round()
    // Not something the retention job does (it keeps an event with a pending delivery): the
    // row is removed behind its back.
    deps.activityLog.dropEvents(new Set([eventId]))
    deps.clock.advance('5s')
    respond = answer(204)
    expect(await round()).toMatchObject({ givenUp: 1, delivered: 0, failed: 0 })
    expect(received).toHaveLength(1)
    expect(deliveryOf(eventId)).toMatchObject({
      state: 'failed',
      attempts: 1,
      failureReason: 'event_gone',
      statusCode: null,
    })
  })

  test('a pending delivery whose stored payload is no longer its event’s is not sent either', async () => {
    quietLogs()
    await register()
    const eventId = happen()
    respond = answer(500)
    await round()
    const row = deps.activityLog.outbox.find((one) => one.id === eventId)
    ;(row as { payload: unknown }).payload = { id: eventId, type: 'user.banned', schemaVersion: 1 }
    deps.clock.advance('5s')
    await round()
    expect(received).toHaveLength(1)
    expect(deliveryOf(eventId)).toMatchObject({ state: 'failed', failureReason: 'event_gone' })
  })
})

describe('an endpoint that says 410 Gone', () => {
  test('is switched off at once by the system, the delivery is given up, and what was queued for it waits unsent', async () => {
    quietLogs()
    const endpoint = await register(tenant, { url: receiverUrl('/canary-path?token=canary') })
    const first = happen()
    deps.clock.advance('1s')
    const second = happen()
    respond = answer(410)
    const report = await round()

    expect(report).toMatchObject({ undelivered: 1, givenUp: 1, disabled: 1 })
    // One request: the second delivery was not tried once the endpoint said "stop".
    expect(received).toHaveLength(1)
    expect(deliveryOf(first)).toMatchObject({
      state: 'failed',
      attempts: 1,
      statusCode: 410,
      nextAttemptAt: null,
    })
    expect(deliveryOf(second)).toMatchObject({ state: 'pending', attempts: 0 })
    expect(await Webhooks.get(deps, tenant, endpoint.id)).toMatchObject({
      enabled: false,
      disabledReason: 'gone',
    })

    const entry = deps.activityLog.ofType('webhook_endpoint.disabled')
    expect(entry).toHaveLength(1)
    expect(entry[0]).toMatchObject({
      environmentId: tenant.environmentId,
      actor: { type: 'system', id: null },
      target: { type: 'webhook_endpoint', id: endpoint.id },
      data: { reason: 'gone' },
      ipAddress: null,
      userAgent: null,
    })
    // The event it becomes is an event of the contract, with no address and no secret in it.
    const payload = deps.activityLog.events.at(-1)
    expect(TulaEventSchema.parse(payload)).toEqual(payload as never)
    const record = JSON.stringify([entry, payload, logged()])
    expect(record).not.toContain('canary')
    expect(record).not.toContain('127.0.0.1')
    expect(record).not.toContain(endpoint.secret.slice('whsec_'.length))
    expect(logged()).toContain('webhook endpoint switched off by the server')

    respond = answer(204)
    deps.clock.advance('1h')
    await round()
    expect(received).toHaveLength(1)
  })

  test('another endpoint of the environment that subscribed to it is told', async () => {
    quietLogs()
    await register(tenant, { url: receiverUrl('/gone') })
    await register(tenant, {
      url: receiverUrl('/watch'),
      eventTypes: ['webhook_endpoint.disabled'],
    })
    happen()
    respond = (req) => answer(new URL(req.url).pathname === '/gone' ? 410 : 204)()
    await round()
    await round()
    const told = received.filter((request) => request.path === '/watch')
    expect(told).toHaveLength(1)
    expect(JSON.parse((told[0] as Received).body)).toMatchObject({
      type: 'webhook_endpoint.disabled',
      actor: { type: 'system', id: null },
      data: { reason: 'gone' },
    })
  })
})

describe('an endpoint that keeps failing', () => {
  /** Fail a new event now, and return its id. */
  async function failOne(): Promise<string> {
    const eventId = happen()
    await round()
    return eventId
  }

  test('is switched off once every request to it has failed for five days, not a moment sooner', async () => {
    quietLogs()
    const endpoint = await register()
    respond = answer(500)
    await failOne()
    const since = deps.clock.now()
    expect((await endpointNow(endpoint.id)).failingSince).toEqual(since)

    // An hour, a night, a weekend: failing all the while, and still on.
    for (const wait of ['1h', '11h', '2d', '2d']) {
      deps.clock.advance(wait)
      await failOne()
      expect(await endpointNow(endpoint.id)).toMatchObject({ enabled: true, failingSince: since })
    }
    // One millisecond short of five days since the first failure.
    deps.clock.set(new Date(since.getTime() + durationToMs(Webhooks.WEBHOOK_DISABLE_AFTER) - 1))
    await failOne()
    expect((await endpointNow(endpoint.id)).enabled).toBe(true)
    expect(deps.activityLog.ofType('webhook_endpoint.disabled')).toEqual([])

    deps.clock.advance(1)
    const last = happen()
    const report = await round()
    expect(report.disabled).toBe(1)
    expect(await Webhooks.get(deps, tenant, endpoint.id)).toMatchObject({
      enabled: false,
      disabledReason: 'failing',
      failingSince: since.toISOString(),
      updatedAt: deps.clock.now().toISOString(),
    })
    expect(deps.activityLog.ofType('webhook_endpoint.disabled')).toMatchObject([
      {
        actor: { type: 'system', id: null },
        target: { type: 'webhook_endpoint', id: endpoint.id },
        data: { reason: 'failing' },
      },
    ])
    // The request that tripped it was made and is on record; its retry never is.
    expect(deliveryOf(last)).toMatchObject({ state: 'pending', attempts: 1 })
    const sent = received.length
    respond = answer(204)
    deps.clock.advance('1h')
    await round()
    await round()
    expect(received).toHaveLength(sent)
    expect(deps.activityLog.ofType('webhook_endpoint.disabled')).toHaveLength(1)
  })

  test('one success in between starts the count again', async () => {
    quietLogs()
    const endpoint = await register()
    respond = answer(500)
    await failOne()
    deps.clock.advance('4d')
    respond = answer(204)
    await failOne()
    expect((await endpointNow(endpoint.id)).failingSince).toBeNull()
    respond = answer(500)
    deps.clock.advance('4d')
    await failOne()
    const since = deps.clock.now()
    deps.clock.advance('4d')
    await failOne()
    // Eight days after the first failure, four after the latest run of them began.
    expect(await endpointNow(endpoint.id)).toMatchObject({ enabled: true, failingSince: since })
  })

  test('rounds in which nothing is due do not count: the rule needs no scan and looks only when a request fails', async () => {
    quietLogs()
    const endpoint = await register()
    respond = answer(500)
    await failOne()
    const reads = spyOn(deps.webhookDeliveries, 'list')
    spies.push(reads as never)
    deps.clock.advance('30d')
    // The one delivery has long been given up; nothing is sent, so nothing is judged.
    await round()
    await round()
    expect((await endpointNow(endpoint.id)).enabled).toBe(true)
    expect(reads).not.toHaveBeenCalled()
  })

  test('switching it on again forgets what tripped it, and what was pending is tried again; what happened while it was off is not sent', async () => {
    quietLogs()
    const endpoint = await register()
    respond = answer(500)
    await failOne()
    deps.clock.advance(Webhooks.WEBHOOK_DISABLE_AFTER)
    const pending = await failOne()
    expect((await endpointNow(endpoint.id)).enabled).toBe(false)
    const whileOff = happen()
    deps.clock.advance('1h')
    await round()

    const updated = await Webhooks.update(deps, tenant, endpoint.id, { enabled: true }, TEST_ACTOR)
    expect(updated).toMatchObject({ enabled: true, disabledReason: null, failingSince: null })
    expect(deps.activityLog.entries.at(-1)).toMatchObject({
      type: 'webhook_endpoint.updated',
      actor: { type: TEST_ACTOR.type },
      data: { changed: ['enabled'] },
    })
    respond = answer(204)
    const sent = received.length
    await round()
    expect(received.slice(sent).map((request) => request.headers['webhook-id'])).toEqual([pending])
    expect(deliveryOf(pending)).toMatchObject({ state: 'delivered', attempts: 2 })
    expect(deps.webhookDeliveries.rows.some((row) => row.eventId === whileOff)).toBe(false)
    // A fresh start: one failure now is the first of a new run, five days from tripping.
    respond = answer(500)
    await failOne()
    expect(await endpointNow(endpoint.id)).toMatchObject({
      enabled: true,
      failingSince: deps.clock.now(),
    })
  })

  test('a new address is a fresh start too; a change of event types is not', async () => {
    quietLogs()
    const endpoint = await register()
    respond = answer(500)
    await failOne()
    const since = deps.clock.now()
    await Webhooks.update(deps, tenant, endpoint.id, { eventTypes: ['user.banned'] }, TEST_ACTOR)
    expect((await endpointNow(endpoint.id)).failingSince).toEqual(since)
    await Webhooks.update(deps, tenant, endpoint.id, { url: receiverUrl('/new') }, TEST_ACTOR)
    expect((await endpointNow(endpoint.id)).failingSince).toBeNull()
  })

  test('an administrator switching an endpoint off leaves no reason of the server’s', async () => {
    const endpoint = await register()
    const off = await Webhooks.update(deps, tenant, endpoint.id, { enabled: false }, TEST_ACTOR)
    expect(off).toMatchObject({ enabled: false, disabledReason: null })
    expect(deps.activityLog.ofType('webhook_endpoint.disabled')).toEqual([])
  })

  test('an endpoint removed with deliveries pending takes them with it, and the round goes on', async () => {
    quietLogs()
    const doomed = await register(tenant, { url: receiverUrl('/doomed') })
    await register(tenant, { url: receiverUrl('/kept') })
    respond = (req) => answer(new URL(req.url).pathname === '/doomed' ? 500 : 204)()
    const eventId = happen()
    await round()
    await Webhooks.remove(deps, tenant, doomed.id, TEST_ACTOR)
    expect(deps.webhookDeliveries.rows.filter((row) => row.endpointId === doomed.id)).toEqual([])
    deps.clock.advance('1d')
    const later = happen()
    expect(await round()).toMatchObject({ failed: 0, delivered: 1 })
    expect(sentTo('/doomed')).toEqual([eventId])
    expect(sentTo('/kept')).toEqual([eventId, later])
  })

  test('an endpoint switched off by the server in the middle of a retry run keeps the delivery’s count where it was', async () => {
    quietLogs()
    const endpoint = await register()
    respond = answer(500)
    const eventId = await failOne()
    deps.clock.advance('5s')
    await round()
    expect(deliveryOf(eventId).attempts).toBe(2)
    await deps.webhookEndpoints.disable(
      tenant.environmentId,
      endpoint.id,
      'failing',
      deps.clock.now(),
      Audit.none('fixture')
    )
    deps.clock.advance('1h')
    await round()
    expect(deliveryOf(eventId)).toMatchObject({ state: 'pending', attempts: 2 })
    await Webhooks.update(deps, tenant, endpoint.id, { enabled: true }, TEST_ACTOR)
    await round()
    // It goes on from its third request, not from its first.
    expect(deliveryOf(eventId)).toMatchObject({
      state: 'pending',
      attempts: 3,
      nextAttemptAt: new Date(deps.clock.now().getTime() + durationToMs('30m')),
    })
  })
})

describe('the caps of a round', () => {
  test('one endpoint gets at most fifty deliveries a round, the most overdue first', async () => {
    await register()
    const events: string[] = []
    for (let count = 0; count < 2 * Webhooks.WEBHOOK_ENDPOINT_ROUND_CAP + 10; count++) {
      events.push(happen())
      deps.clock.advance(1)
    }
    const due = spyOn(deps.webhookDeliveries, 'due')
    spies.push(due as never)
    await round()
    expect(sentTo('/hook')).toEqual(events.slice(0, Webhooks.WEBHOOK_ENDPOINT_ROUND_CAP))
    expect(
      due.mock.calls.every(([, , , limit]) => limit === Webhooks.WEBHOOK_ENDPOINT_ROUND_CAP)
    ).toBe(true)
    await round()
    await round()
    expect(sentTo('/hook')).toEqual(events)
  })

  test('an endpoint with a backlog does not take a round from the endpoint beside it', async () => {
    await register(tenant, { url: receiverUrl('/busy'), eventTypes: ['user.deleted'] })
    await register(tenant, { url: receiverUrl('/quiet'), eventTypes: ['user.banned'] })
    for (let count = 0; count < 3 * Webhooks.WEBHOOK_ENDPOINT_ROUND_CAP; count++) {
      happen(tenant, 'user.deleted')
    }
    const mine = happen(tenant, 'user.banned')
    await round()
    expect(sentTo('/quiet')).toEqual([mine])
    expect(sentTo('/busy')).toHaveLength(Webhooks.WEBHOOK_ENDPOINT_ROUND_CAP)
  })

  test('never more than five requests are in flight, and never two to one endpoint', async () => {
    const paths = Array.from({ length: 10 }, (_, index) => `/lane-${index}`)
    for (const path of paths) {
      await register(tenant, { url: receiverUrl(path) })
    }
    for (let count = 0; count < 4; count++) {
      happen()
    }
    let inFlight = 0
    let most = 0
    const perPath = new Map<string, number>()
    let mostPerPath = 0
    respond = async (req) => {
      const path = new URL(req.url).pathname
      inFlight += 1
      perPath.set(path, (perPath.get(path) ?? 0) + 1)
      most = Math.max(most, inFlight)
      mostPerPath = Math.max(mostPerPath, perPath.get(path) ?? 0)
      // Let every other lane that can start, start. Not a wait: the event loop's next turns.
      for (let turn = 0; turn < 20; turn++) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      inFlight -= 1
      perPath.set(path, (perPath.get(path) ?? 0) - 1)
      return new Response(null, { status: 204 })
    }
    expect(await round()).toMatchObject({ delivered: 40, failed: 0 })
    expect(most).toBe(Webhooks.WEBHOOK_MAX_CONCURRENT_DELIVERIES)
    expect(mostPerPath).toBe(1)
    for (const path of paths) {
      expect(sentTo(path)).toHaveLength(4)
    }
  })

  test('one endpoint’s lane failing does not stop the lanes beside it, and the environment is reported failed', async () => {
    quietLogs()
    await register(tenant, { url: receiverUrl('/breaks') })
    await register(tenant, { url: receiverUrl('/works') })
    const events = [happen(), happen()]
    const real = Outbound.request
    spies.push(
      spyOn(Outbound, 'request').mockImplementation(async (settings, url, init) => {
        if (url.endsWith('/breaks')) {
          throw new TypeError('a programming error')
        }
        return real(settings, url, init)
      }) as never
    )
    expect(await round()).toMatchObject({ failed: 1, delivered: 2 })
    expect(sentTo('/works')).toEqual(events)
  })

  test('the caps leave room: a request’s deadline fits the budget several times over, and a round’s worth fits one environment', () => {
    expect(Webhooks.WEBHOOK_MAX_CONCURRENT_DELIVERIES).toBeGreaterThan(1)
    expect(Webhooks.WEBHOOK_MAX_CONCURRENT_DELIVERIES).toBeLessThanOrEqual(10)
    expect(Webhooks.WEBHOOK_ENDPOINT_ROUND_CAP).toBeLessThanOrEqual(100)
    expect(Webhooks.WEBHOOK_DELIVERY_TIMEOUT_MS * 3).toBeLessThanOrEqual(
      Webhooks.WEBHOOK_ENVIRONMENT_BUDGET_MS
    )
  })
})

describe('two instances', () => {
  test('a retry is made once, by whichever instance holds the lock', async () => {
    quietLogs()
    await register()
    const eventId = happen()
    respond = answer(500)
    await Webhooks.run(deps)
    deps.clock.advance('5s')

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
    // A second instance: its own process, the same database and the same job lock.
    const second = createTestDeps({ ...deps })
    const first = Webhooks.run(deps)
    await arrived
    expect(await Webhooks.run(second)).toBeNull()
    release()
    expect(await first).toMatchObject({ delivered: 1 })
    expect(await Webhooks.run(second)).toMatchObject({ delivered: 0, undelivered: 0 })
    expect(sentTo('/hook')).toEqual([eventId, eventId])
    expect(deliveryOf(eventId)).toMatchObject({ state: 'delivered', attempts: 2 })
  })

  test('without the lock, two rounds that send the same retry record it once: the count is not doubled', async () => {
    quietLogs()
    await register()
    const eventId = happen()
    respond = answer(500)
    await round()
    deps.clock.advance('5s')
    await Promise.all([round(), round()])
    // At least once: the receiver may see it twice. One of the two is on record.
    expect(received.length).toBeGreaterThanOrEqual(2)
    const delivery = deliveryOf(eventId)
    expect(delivery.attempts).toBe(delivery.log.length)
    expect(delivery.log.map((attempt) => attempt.attempt)).toEqual(
      delivery.log.map((_, index) => index + 1)
    )
  })

  test('an instance whose clock is behind does not send a retry early, and one that is ahead sends it early by no more than the difference', async () => {
    quietLogs()
    await register()
    const eventId = happen()
    respond = answer(500)
    await round()
    const due = deliveryOf(eventId).nextAttemptAt as Date

    // The other instance's clock runs thirty seconds behind this one's.
    const behind = createTestDeps({
      ...deps,
      clock: new FixedClock(new Date(deps.clock.now().getTime() - 30_000)),
    })
    await Webhooks.deliverPending(behind)
    behind.clock.set(new Date(due.getTime() - 1))
    await Webhooks.deliverPending(behind)
    expect(received).toHaveLength(1)
    expect(deliveryOf(eventId).attempts).toBe(1)

    // And one that runs ten seconds ahead takes it as soon as its own clock says so.
    const ahead = createTestDeps({
      ...deps,
      clock: new FixedClock(new Date(deps.clock.now().getTime() + 10_000)),
    })
    await Webhooks.deliverPending(ahead)
    expect(received).toHaveLength(2)
    // Counted once, wherever it was sent from; the next wait is by the sender's clock.
    expect(deliveryOf(eventId)).toMatchObject({
      attempts: 2,
      nextAttemptAt: new Date(ahead.clock.now().getTime() + durationToMs('5m')),
    })
    await round()
    expect(received).toHaveLength(2)
  })
})

describe('the delivery log', () => {
  test('lists an endpoint’s deliveries newest first, by state and event type, in pages', async () => {
    quietLogs()
    const endpoint = await register(tenant, { eventTypes: ['user.deleted', 'user.banned'] })
    const other = await register(tenant, { url: receiverUrl('/other') })
    const oldest = happen(tenant, 'user.deleted')
    await round()
    deps.clock.advance('1s')
    respond = (req) => answer(new URL(req.url).pathname === '/hook' ? 500 : 204)()
    const middle = happen(tenant, 'user.banned')
    await round()
    deps.clock.advance('1s')
    const newest = happen(tenant, 'user.deleted')
    await round()

    const list = async (input?: Webhooks.DeliveryListInput) => {
      const page = await Webhooks.listDeliveries(deps, tenant, endpoint.id, input)
      return { events: page.data.map((delivery) => delivery.eventId), meta: page.meta }
    }
    expect(await list()).toEqual({
      events: [newest, middle, oldest],
      meta: { totalCount: 3, totalPages: 1, page: 1, perPage: 20 },
    })
    expect(await list({ size: 2 })).toEqual({
      events: [newest, middle],
      meta: { totalCount: 3, totalPages: 2, page: 1, perPage: 2 },
    })
    expect((await list({ size: 2, page: 2 })).events).toEqual([oldest])
    expect((await list({ state: 'pending' })).events).toEqual([newest, middle])
    expect((await list({ state: 'delivered' })).events).toEqual([oldest])
    expect((await list({ state: 'failed' })).events).toEqual([])
    expect((await list({ eventType: 'user.banned' })).events).toEqual([middle])
    expect((await list({ state: 'delivered', eventType: 'user.banned' })).events).toEqual([])
    // The other endpoint's log is its own.
    expect(
      (await Webhooks.listDeliveries(deps, tenant, other.id)).data.map((one) => one.eventId)
    ).toEqual([newest, oldest])
  })

  test('one delivery is read with every request made for it, and nothing that is not in the contract', async () => {
    quietLogs()
    const endpoint = await register()
    const eventId = happen()
    respond = () => {
      deps.clock.advance(40)
      return new Response('canary-body', { status: 500, headers: { 'x-canary': 'canary-header' } })
    }
    await round()
    const first = deps.clock.now()
    deps.clock.advance('5s')
    respond = answer(204)
    await round()
    const { id } = deliveryOf(eventId)
    const detail = await Webhooks.getDelivery(deps, tenant, endpoint.id, id)
    expect(detail).toEqual({
      id,
      endpointId: endpoint.id,
      eventId,
      eventType: 'user.deleted',
      test: false,
      state: 'delivered',
      attemptCount: 2,
      nextAttemptAt: null,
      lastAttemptAt: deps.clock.now().toISOString(),
      statusCode: 204,
      failureReason: null,
      completedAt: deps.clock.now().toISOString(),
      createdAt: new Date(first.getTime() - 40).toISOString(),
      attempts: [
        {
          attempt: 1,
          attemptedAt: new Date(first.getTime() - 40).toISOString(),
          statusCode: 500,
          durationMs: 40,
          failureReason: null,
        },
        {
          attempt: 2,
          attemptedAt: deps.clock.now().toISOString(),
          statusCode: 204,
          durationMs: 0,
          failureReason: null,
        },
      ],
    })
    expect(JSON.stringify(detail)).not.toContain('canary')
  })

  test('another environment reads neither the list nor a delivery, with its own endpoint or with ours', async () => {
    const endpoint = await register()
    const theirs = await register(otherTenant)
    const eventId = happen()
    await round()
    const { id } = deliveryOf(eventId)
    for (const endpointId of [endpoint.id, theirs.id]) {
      expect((await failure(Webhooks.getDelivery(deps, otherTenant, endpointId, id))).status).toBe(
        404
      )
    }
    expect((await failure(Webhooks.listDeliveries(deps, otherTenant, endpoint.id))).status).toBe(
      404
    )
    expect((await Webhooks.listDeliveries(deps, otherTenant, theirs.id)).data).toEqual([])
    // Nor under another endpoint of its own environment, nor an id nobody has.
    const sibling = await register(tenant, { url: receiverUrl('/sibling') })
    expect((await failure(Webhooks.getDelivery(deps, tenant, sibling.id, id))).status).toBe(404)
    expect(
      (await failure(Webhooks.getDelivery(deps, tenant, endpoint.id, deps.ids.next()))).status
    ).toBe(404)
    expect((await failure(Webhooks.listDeliveries(deps, tenant, deps.ids.next()))).status).toBe(404)
  })
})

describe('a test event', () => {
  test('is a real, signed delivery of the chosen type that says it is a test, and touches neither the outbox nor the audit log', async () => {
    const endpoint = await register()
    await round()
    const outbox = deps.activityLog.outbox.length
    const audit = deps.activityLog.entries.length
    deps.clock.advance('1m')

    const result = await Webhooks.sendTest(deps, tenant, endpoint.id, {
      eventType: 'session.reuse_detected',
    })

    expect(received).toHaveLength(1)
    const [request] = received as [Received]
    const sent = JSON.parse(request.body) as Record<string, unknown>
    // What a receiver sees: an event of the contract, of that type, marked inside the body.
    expect(sent.test).toBe(true)
    expect(TulaEventSchema.parse(sent)).toEqual(sent as never)
    expect(sent).toEqual({
      ...EVENT_FIXTURES['session.reuse_detected'],
      id: request.headers['webhook-id'] as string,
      occurredAt: deps.clock.now().toISOString(),
      test: true,
    })
    // An id of its own, never an example's and never a real event's.
    expect(sent.id).not.toBe(EVENT_FIXTURES['session.reuse_detected'].id)
    const timestamp = Number(request.headers['webhook-timestamp'])
    expect(timestamp).toBe(Math.floor(deps.clock.now().getTime() / 1000))
    // The mark is inside what is signed: it cannot be added or taken away on the way.
    expect(request.headers['webhook-signature']).toBe(
      await signWebhook(
        webhookSecretBytes(endpoint.secret) as Uint8Array<ArrayBuffer>,
        String(sent.id),
        timestamp,
        request.body
      )
    )

    // The answer is the outcome, a status code and a duration, and nothing else.
    expect(result).toEqual({
      deliveryId: expect.any(String),
      outcome: 'delivered',
      statusCode: 204,
      durationMs: 0,
      failureReason: null,
    })
    expect(await Webhooks.getDelivery(deps, tenant, endpoint.id, result.deliveryId)).toMatchObject({
      eventId: null,
      eventType: 'session.reuse_detected',
      test: true,
      state: 'delivered',
      attemptCount: 1,
      nextAttemptAt: null,
      attempts: [{ attempt: 1, statusCode: 204 }],
    })
    expect(deps.activityLog.outbox).toHaveLength(outbox)
    expect(deps.activityLog.entries).toHaveLength(audit)

    // The worker never touches it, and two tests are two deliveries.
    await round()
    expect(received).toHaveLength(1)
    const again = await Webhooks.sendTest(deps, tenant, endpoint.id, { eventType: 'user.created' })
    expect(again.deliveryId).not.toBe(result.deliveryId)
    expect(received.map((one) => one.headers['webhook-id'])).toHaveLength(2)
    expect(new Set(received.map((one) => one.headers['webhook-id'])).size).toBe(2)
  })

  test.each([...ACTIVITY_TYPES])('of type %s is an event of the contract', async (eventType) => {
    const endpoint = await register()
    await Webhooks.sendTest(deps, tenant, endpoint.id, { eventType })
    const sent: unknown = JSON.parse((received[0] as Received).body)
    expect(TulaEventSchema.parse(sent)).toMatchObject({ type: eventType, test: true })
  })

  test('no real event is ever marked as a test', async () => {
    await register(tenant, { eventTypes: [...ACTIVITY_TYPES] })
    happen()
    await round()
    expect(received.length).toBeGreaterThan(0)
    for (const request of received) {
      expect(request.body).not.toContain('"test"')
    }
  })

  test('to an address the server may not call is refused by the guard: nothing is sent, and the refusal is the outcome', async () => {
    deps.outbound.point('hooks.example.test', '127.0.0.1')
    const endpoint = await register(tenant, {
      url: `http://hooks.example.test:${listener.port}/hook`,
    })
    deps.outbound.point('hooks.example.test', '169.254.169.254')
    const result = await Webhooks.sendTest(deps, tenant, endpoint.id, { eventType: 'user.created' })
    expect(received).toEqual([])
    expect(result).toEqual({
      deliveryId: expect.any(String),
      outcome: 'failed',
      statusCode: null,
      durationMs: 0,
      failureReason: 'address_not_allowed',
    })
    expect(JSON.stringify(result)).not.toContain('169.254')
    expect(await Webhooks.getDelivery(deps, tenant, endpoint.id, result.deliveryId)).toMatchObject({
      test: true,
      state: 'failed',
      failureReason: 'address_not_allowed',
      attempts: [{ attempt: 1, statusCode: null, failureReason: 'address_not_allowed' }],
    })
  })

  test('goes through the outbound guard with the delivery’s deadline and cap, and keeps nothing of the answer', async () => {
    quietLogs()
    const endpoint = await register()
    const request = spyOn(Outbound, 'request')
    spies.push(request as never)
    respond = () =>
      new Response('canary-body', {
        status: 500,
        headers: { 'x-canary': 'canary-header', 'retry-after': '1' },
      })
    const result = await Webhooks.sendTest(deps, tenant, endpoint.id, { eventType: 'user.created' })
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]?.[0]).toBe(deps.outbound)
    expect(request.mock.calls[0]?.[2]).toMatchObject({
      method: 'POST',
      timeoutMs: Webhooks.WEBHOOK_DELIVERY_TIMEOUT_MS,
      maxResponseBytes: Webhooks.WEBHOOK_MAX_RESPONSE_BYTES,
    })
    expect(Object.keys(result).sort()).toEqual([
      'deliveryId',
      'durationMs',
      'failureReason',
      'outcome',
      'statusCode',
    ])
    const kept = JSON.stringify([
      result,
      deps.webhookDeliveries.rows,
      deps.webhookDeliveries.attemptsOf(result.deliveryId),
      deps.activityLog.entries,
      deps.activityLog.outbox,
      logged(),
    ])
    expect(kept).not.toContain('canary')
  })

  test('that fails, or is answered 410, changes nothing about the endpoint and is not retried', async () => {
    quietLogs()
    const endpoint = await register()
    for (const status of [500, 410]) {
      respond = answer(status)
      const result = await Webhooks.sendTest(deps, tenant, endpoint.id, {
        eventType: 'user.created',
      })
      expect(result).toMatchObject({ outcome: 'failed', statusCode: status })
    }
    expect(await endpointNow(endpoint.id)).toMatchObject({
      enabled: true,
      disabledReason: null,
      failingSince: null,
    })
    expect(deps.activityLog.ofType('webhook_endpoint.disabled')).toEqual([])
    respond = answer(204)
    deps.clock.advance('1d')
    await round()
    expect(received).toHaveLength(2)
  })

  test('can be sent to an endpoint that is switched off: that is how to find out whether to switch it on', async () => {
    const endpoint = await register(tenant, { enabled: false })
    const result = await Webhooks.sendTest(deps, tenant, endpoint.id, { eventType: 'user.created' })
    expect(result.outcome).toBe('delivered')
    expect(received).toHaveLength(1)
    expect((await endpointNow(endpoint.id)).enabled).toBe(false)
  })

  test('cannot be sent to another environment’s endpoint, or to one that does not exist', async () => {
    const endpoint = await register()
    expect(
      (
        await failure(
          Webhooks.sendTest(deps, otherTenant, endpoint.id, { eventType: 'user.created' })
        )
      ).status
    ).toBe(404)
    expect(
      (
        await failure(
          Webhooks.sendTest(deps, tenant, deps.ids.next(), { eventType: 'user.created' })
        )
      ).status
    ).toBe(404)
    expect(received).toEqual([])
    expect(deps.webhookDeliveries.rows).toEqual([])
  })

  test('with a secret the server cannot open sends nothing and says whose fault it is', async () => {
    const endpoint = await register()
    await breakSecret(endpoint.id)
    const result = await Webhooks.sendTest(deps, tenant, endpoint.id, { eventType: 'user.created' })
    expect(received).toEqual([])
    expect(result).toEqual({
      deliveryId: expect.any(String),
      outcome: 'failed',
      statusCode: null,
      durationMs: 0,
      failureReason: 'signing_failed',
    })
    expect(await Webhooks.getDelivery(deps, tenant, endpoint.id, result.deliveryId)).toMatchObject({
      test: true,
      state: 'failed',
      attemptCount: 0,
      attempts: [],
    })
  })

  test('to an endpoint removed while the request is under way records nothing', async () => {
    const endpoint = await register()
    respond = async () => {
      await Webhooks.remove(deps, tenant, endpoint.id, TEST_ACTOR)
      return new Response(null, { status: 204 })
    }
    expect(
      (await failure(Webhooks.sendTest(deps, tenant, endpoint.id, { eventType: 'user.created' })))
        .status
    ).toBe(404)
    expect(deps.webhookDeliveries.rows).toEqual([])
  })
})

describe('sending a delivery again', () => {
  /** An event whose delivery was given up after every attempt failed. */
  async function givenUp() {
    const endpoint = await register()
    const eventId = happen()
    respond = answer(500)
    await round()
    for (const wait of Webhooks.WEBHOOK_RETRY_DELAYS) {
      deps.clock.advance(wait)
      await round()
    }
    const delivery = deliveryOf(eventId)
    expect(delivery.state).toBe('failed')
    received = []
    return { endpoint, eventId, delivery }
  }

  test('is one more request for the stored payload, with the same id, appended to the delivery’s own log', async () => {
    quietLogs()
    const { endpoint, eventId, delivery } = await givenUp()
    expect((await endpointNow(endpoint.id)).failingSince).not.toBeNull()
    respond = answer(200)
    deps.clock.advance('1h')
    const audit = deps.activityLog.entries.length

    const result = await Webhooks.redeliver(deps, tenant, endpoint.id, delivery.id)

    expect(result).toEqual({
      deliveryId: delivery.id,
      outcome: 'delivered',
      statusCode: 200,
      durationMs: 0,
      failureReason: null,
    })
    expect(received).toHaveLength(1)
    const [request] = received as [Received]
    expect(request.headers['webhook-id']).toBe(eventId)
    expect(JSON.parse(request.body)).toEqual(
      deps.activityLog.outbox.find((row) => row.id === eventId)?.payload
    )
    expect(request.body).not.toContain('"test"')
    const timestamp = Math.floor(deps.clock.now().getTime() / 1000)
    expect(request.headers['webhook-signature']).toBe(
      await signWebhook(
        webhookSecretBytes(endpoint.secret) as Uint8Array<ArrayBuffer>,
        eventId,
        timestamp,
        request.body
      )
    )
    // No second delivery: the ninth request of the same one.
    expect(deps.webhookDeliveries.rows).toHaveLength(1)
    const after = deliveryOf(eventId)
    expect(after).toMatchObject({
      id: delivery.id,
      state: 'delivered',
      attempts: Webhooks.WEBHOOK_MAX_ATTEMPTS + 1,
      statusCode: 200,
      completedAt: deps.clock.now(),
      nextAttemptAt: null,
    })
    expect(after.log.map((attempt) => attempt.attempt)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    // The log of what was tried before is as it was.
    expect(after.log.slice(0, 8)).toEqual(delivery.log)
    // It got through: the endpoint is not failing any more. Nothing is audited.
    expect((await endpointNow(endpoint.id)).failingSince).toBeNull()
    expect(deps.activityLog.entries).toHaveLength(audit)
  })

  test('that fails leaves the delivery as it was, is on record, and is not retried', async () => {
    quietLogs()
    const { endpoint, eventId, delivery } = await givenUp()
    respond = answer(503)
    const result = await Webhooks.redeliver(deps, tenant, endpoint.id, delivery.id)
    expect(result).toMatchObject({ outcome: 'failed', statusCode: 503 })
    expect(deliveryOf(eventId)).toMatchObject({
      state: 'failed',
      attempts: Webhooks.WEBHOOK_MAX_ATTEMPTS + 1,
      statusCode: 503,
      nextAttemptAt: null,
      completedAt: delivery.completedAt,
    })
    respond = answer(204)
    deps.clock.advance('2d')
    await round()
    expect(received).toHaveLength(1)
    // It changes nothing about the endpoint either: 410 to a request on demand does not
    // switch it off.
    respond = answer(410)
    await Webhooks.redeliver(deps, tenant, endpoint.id, delivery.id)
    expect((await endpointNow(endpoint.id)).enabled).toBe(true)
  })

  test('a delivery that was delivered can be sent again, and a failure then does not undo that', async () => {
    quietLogs()
    const endpoint = await register()
    const eventId = happen()
    await round()
    const { id } = deliveryOf(eventId)
    respond = answer(500)
    expect(await Webhooks.redeliver(deps, tenant, endpoint.id, id)).toMatchObject({
      outcome: 'failed',
    })
    expect(deliveryOf(eventId)).toMatchObject({ state: 'delivered', attempts: 2, statusCode: 500 })
    expect(sentTo('/hook')).toEqual([eventId, eventId])
  })

  test('is refused while the worker still has the delivery: it will be sent anyway', async () => {
    quietLogs()
    const endpoint = await register()
    const eventId = happen()
    respond = answer(500)
    await round()
    const error = await failure(
      Webhooks.redeliver(deps, tenant, endpoint.id, deliveryOf(eventId).id)
    )
    expect(error).toMatchObject({
      status: 409,
      code: 'webhook.cannot_redeliver',
      params: { reason: 'delivery_pending' },
    })
    expect(received).toHaveLength(1)
    expect(deliveryOf(eventId).attempts).toBe(1)
  })

  test('is refused for an endpoint that is switched off, by an administrator or by the server', async () => {
    quietLogs()
    const { endpoint, delivery } = await givenUp()
    await Webhooks.update(deps, tenant, endpoint.id, { enabled: false }, TEST_ACTOR)
    const error = await failure(Webhooks.redeliver(deps, tenant, endpoint.id, delivery.id))
    expect(error).toMatchObject({
      status: 409,
      code: 'webhook.cannot_redeliver',
      params: { reason: 'endpoint_disabled' },
    })
    expect(received).toEqual([])
    expect(deps.webhookDeliveries.attemptsOf(delivery.id)).toHaveLength(delivery.log.length)
  })

  test('is refused once the event is no longer kept, and for a test event, which never was', async () => {
    quietLogs()
    const { endpoint, eventId, delivery } = await givenUp()
    const test = await Webhooks.sendTest(deps, tenant, endpoint.id, { eventType: 'user.created' })
    received = []
    deps.activityLog.dropEvents(new Set([eventId]))
    for (const id of [delivery.id, test.deliveryId]) {
      const error = await failure(Webhooks.redeliver(deps, tenant, endpoint.id, id))
      expect(error).toMatchObject({
        status: 409,
        code: 'webhook.cannot_redeliver',
        params: { reason: 'event_gone' },
      })
    }
    expect(received).toEqual([])
  })

  test('is impossible across environments: not with their endpoint, not with ours, and nothing is sent', async () => {
    quietLogs()
    const { endpoint, eventId, delivery } = await givenUp()
    const theirs = await register(otherTenant, { url: receiverUrl('/theirs') })
    respond = answer(204)
    for (const endpointId of [endpoint.id, theirs.id]) {
      expect(
        (await failure(Webhooks.redeliver(deps, otherTenant, endpointId, delivery.id))).status
      ).toBe(404)
    }
    // Nor to another endpoint of its own environment.
    const sibling = await register(tenant, { url: receiverUrl('/sibling') })
    expect((await failure(Webhooks.redeliver(deps, tenant, sibling.id, delivery.id))).status).toBe(
      404
    )
    expect(
      (await failure(Webhooks.redeliver(deps, tenant, endpoint.id, deps.ids.next()))).status
    ).toBe(404)
    expect(received).toEqual([])
    expect(deliveryOf(eventId).attempts).toBe(Webhooks.WEBHOOK_MAX_ATTEMPTS)
  })

  test('an event id that belongs to another environment finds no payload to send', async () => {
    quietLogs()
    const { endpoint, delivery } = await givenUp()
    // A delivery row that names another environment's event: nothing writes one, and if one
    // existed it would still read nothing from over there.
    const foreign = happen(otherTenant)
    const lookup = spyOn(deps.webhookDeliveries, 'find').mockImplementation(async () => ({
      delivery: { ...delivery, eventId: foreign },
      attempts: [],
    }))
    spies.push(lookup as never)
    const error = await failure(Webhooks.redeliver(deps, tenant, endpoint.id, delivery.id))
    expect(error).toMatchObject({
      code: 'webhook.cannot_redeliver',
      params: { reason: 'event_gone' },
    })
    expect(received).toEqual([])
  })

  test('goes through the outbound guard as the address is now', async () => {
    quietLogs()
    deps.outbound.point('hooks.example.test', '127.0.0.1')
    const endpoint = await register(tenant, {
      url: `http://hooks.example.test:${listener.port}/hook`,
    })
    const eventId = happen()
    await round()
    deps.outbound.point('hooks.example.test', '10.0.0.7')
    received = []
    const result = await Webhooks.redeliver(deps, tenant, endpoint.id, deliveryOf(eventId).id)
    expect(result).toMatchObject({ outcome: 'failed', failureReason: 'address_not_allowed' })
    expect(received).toEqual([])
    expect(deliveryOf(eventId).log.at(-1)).toMatchObject({
      attempt: 2,
      failureReason: 'address_not_allowed',
    })
  })

  test('with a secret the server cannot open sends nothing and records no attempt', async () => {
    quietLogs()
    const { endpoint, delivery } = await givenUp()
    const record = await endpointNow(endpoint.id)
    spies.push(
      spyOn(deps.webhookEndpoints, 'find').mockImplementation(async () => ({
        ...record,
        secret: 'not-sealed',
      })) as never
    )
    const result = await Webhooks.redeliver(deps, tenant, endpoint.id, delivery.id)
    expect(result).toEqual({
      deliveryId: delivery.id,
      outcome: 'failed',
      statusCode: null,
      durationMs: 0,
      failureReason: 'signing_failed',
    })
    expect(received).toEqual([])
    expect(deps.webhookDeliveries.attemptsOf(delivery.id)).toHaveLength(delivery.log.length)
  })

  test('of a delivery removed with its endpoint while the request is under way is not found', async () => {
    quietLogs()
    const { endpoint, delivery } = await givenUp()
    respond = async () => {
      await Webhooks.remove(deps, tenant, endpoint.id, TEST_ACTOR)
      return new Response(null, { status: 204 })
    }
    expect((await failure(Webhooks.redeliver(deps, tenant, endpoint.id, delivery.id))).status).toBe(
      404
    )
  })
})
