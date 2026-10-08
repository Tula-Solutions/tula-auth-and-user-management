import { afterAll, afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from 'bun:test'
import type { Tenant } from '~/dependencies'
import { ServiceException } from '~/exceptions'
import { createApp } from '~/index'
import * as logger from '~/lib/logger'
import * as Audit from '~/modules/audit/service'
import * as Webhooks from '~/modules/webhook/service'
import { createTestDeps, seedApiKey, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'

// The worker as its own service (TULA-52, ADR 0034): with `WEBHOOK_WORKER=separate` an API
// instance makes no request to a webhook endpoint, by any path, and a worker process makes
// them all. The processes of one deployment are stood in for by dependencies that share the
// stores and the job lock and differ in `config.deliversWebhooks` alone, which is all that
// `planProcess` makes them differ in. The receiver is a listener in this process, reached
// through the real outbound guard.

const tenant: Tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}
const SK = 'tula_sk_dev_admin000000000000000000000000000000'
const PATH = '/v1/admin/webhook-endpoints'

let received: string[] = []
let respond: () => Response | Promise<Response> = () => new Response(null, { status: 204 })
const listener = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    received.push(req.headers.get('webhook-id') ?? '')
    await req.text()
    return respond()
  },
})
afterAll(() => listener.stop(true))

/** A deployment's worker process, and an API instance of it, over the same stores and lock. */
let worker: TestDeps
let api: TestDeps
let spies: Mock<(...args: never[]) => unknown>[] = []

beforeEach(() => {
  received = []
  respond = () => new Response(null, { status: 204 })
  worker = createTestDeps()
  worker.environments.add({
    id: tenant.environmentId,
    projectId: tenant.projectId,
    kind: 'development',
    createdAt: worker.clock.now(),
  })
  api = { ...worker, config: { ...worker.config, deliversWebhooks: false } }
})

afterEach(() => {
  for (const spy of spies) {
    spy.mockRestore()
  }
  spies = []
})

/** An endpoint, registered through the API instance: registering is not delivering. */
function register() {
  return Webhooks.create(
    api,
    tenant,
    {
      url: `http://127.0.0.1:${listener.port}/hook`,
      eventTypes: ['user.deleted'],
      enabled: true,
    },
    TEST_ACTOR
  )
}

/** Record that something happened: an outbox event and an audit entry. Returns the event's id. */
function happen(): string {
  const activity = Audit.entry(api, tenant, {
    type: 'user.deleted',
    actor: TEST_ACTOR,
    target: { type: 'user', id: api.ids.next() },
  })
  api.activityLog.record([activity])
  return activity.id
}

const waiting = () => api.webhookDeliveries.pendingEvents(tenant.environmentId, 100)

async function refusal(work: Promise<unknown>): Promise<ServiceException> {
  const error = await work.then(
    () => null,
    (caught: unknown) => caught
  )
  if (!(error instanceof ServiceException)) {
    throw new Error(`expected a ServiceException, got ${String(error)}`)
  }
  return error
}

describe('an API instance of a deployment whose worker is separate', () => {
  test('makes no delivery: an owed event waits, untouched, until a worker’s round sends it', async () => {
    await register()
    const eventId = happen()
    const lock = spyOn(api.jobLock, 'runExclusive')
    spies.push(lock)

    // However often its timer would have fired.
    expect(await Webhooks.run(api)).toBeNull()
    expect(await Webhooks.run(api)).toBeNull()
    expect(received).toEqual([])
    // Not sent, not queued, not settled: nothing of the worker's work was done here, and the
    // lock a worker needs was never taken.
    expect(api.webhookDeliveries.rows).toEqual([])
    expect((await waiting()).map((event) => event.id)).toContain(eventId)
    expect(lock).not.toHaveBeenCalled()

    // The same event, the same stores: a worker's round delivers it.
    const report = await Webhooks.run(worker)
    expect(report?.delivered).toBe(1)
    expect(received).toEqual([eventId])
    expect(await waiting()).toEqual([])
  })

  test('the round itself refuses too, not only the entry that takes the lock', async () => {
    await register()
    happen()
    const report = await Webhooks.deliverPending(api)
    expect(received).toEqual([])
    expect(report).toEqual({
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
    })
    expect(api.webhookDeliveries.rows).toEqual([])
  })

  test('says nothing per round: an idle timer that is not even started must not fill the log', async () => {
    const lines = (['debug', 'info', 'warn', 'error'] as const).map((level) =>
      spyOn(logger, level).mockImplementation(() => undefined)
    )
    spies.push(...lines)
    await Webhooks.run(api)
    expect(lines.flatMap((spy) => spy.mock.calls)).toEqual([])
  })
})

describe('several workers', () => {
  test('one is let through per round, an API instance never, and the event is sent once', async () => {
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
    // A second worker: its own process, the same database (stores and job lock).
    const second: TestDeps = { ...worker }

    const first = Webhooks.run(worker)
    await arrived
    // While the first worker's round is under way, the second is told the job is taken...
    expect(await Webhooks.run(second)).toBeNull()
    // ...and the API instance does nothing, as it would with the lock free.
    expect(await Webhooks.run(api)).toBeNull()
    release()
    expect((await first)?.delivered).toBe(1)
    expect(received).toEqual([eventId])

    // The next round is the second worker's to run; nothing is left to send.
    const next = await Webhooks.run(second)
    expect(next).not.toBeNull()
    expect(next?.delivered).toBe(0)
    expect(received).toEqual([eventId])
  })

  test('the next event goes out through whichever worker’s round comes first', async () => {
    await register()
    const second: TestDeps = { ...worker }
    const one = happen()
    expect((await Webhooks.run(second))?.delivered).toBe(1)
    const two = happen()
    expect((await Webhooks.run(worker))?.delivered).toBe(1)
    expect(received).toEqual([one, two])
  })
})

describe('requests on demand, asked of an API instance that does not deliver', () => {
  const REFUSAL = {
    code: 'not_implemented' as const,
    status: 501,
    params: { reason: 'worker_separate' },
    detail:
      'This deployment sends webhooks from a separate worker (WEBHOOK_WORKER=separate). A test event or a delivery sent again cannot be asked of an API instance yet.',
  }

  test('a test event is refused, and nothing is sent or recorded', async () => {
    const endpoint = await register()
    const error = await refusal(
      Webhooks.sendTest(api, tenant, endpoint.id, { eventType: 'user.deleted' })
    )
    expect(error.toJSON()).toEqual(REFUSAL)
    expect(received).toEqual([])
    expect(api.webhookDeliveries.rows).toEqual([])
  })

  test('a delivery sent again is refused, and its log is as it was', async () => {
    const endpoint = await register()
    const eventId = happen()
    // Delivered by the worker: a delivery that a process which delivers would send again.
    await Webhooks.run(worker)
    const [delivery] = worker.webhookDeliveries.rows.filter((row) => row.eventId === eventId)
    expect(delivery?.state).toBe('delivered')
    expect(received).toEqual([eventId])

    const error = await refusal(Webhooks.redeliver(api, tenant, endpoint.id, delivery?.id ?? ''))
    expect(error.toJSON()).toEqual(REFUSAL)
    expect(received).toEqual([eventId])
    const [after] = worker.webhookDeliveries.rows.filter((row) => row.eventId === eventId)
    expect(after?.attempts).toBe(1)
    expect(worker.webhookDeliveries.attemptsOf(delivery?.id ?? '')).toHaveLength(1)

    // The same call in the worker's process goes out: the refusal is the process's, not the
    // delivery's.
    const result = await Webhooks.redeliver(worker, tenant, endpoint.id, delivery?.id ?? '')
    expect(result.outcome).toBe('delivered')
    expect(received).toEqual([eventId, eventId])
  })

  test('the refusal says the same for an endpoint or a delivery that does not exist', async () => {
    const missing = '00000000-0000-7000-8000-00000000dead'
    expect(
      (
        await refusal(Webhooks.sendTest(api, tenant, missing, { eventType: 'user.deleted' }))
      ).toJSON()
    ).toEqual(REFUSAL)
    expect((await refusal(Webhooks.redeliver(api, tenant, missing, missing))).toJSON()).toEqual(
      REFUSAL
    )
  })

  test('over HTTP both routes answer 501 with the fixed reason, and the rest of the endpoint’s routes work', async () => {
    await seedApiKey(api, SK)
    const app = createApp(api)
    const call = (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: {
          authorization: `Bearer ${SK}`,
          ...(body !== undefined && { 'content-type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      })
    const endpoint = await register()
    const test = await call('POST', `${PATH}/${endpoint.id}/test`, { eventType: 'user.deleted' })
    expect(test.status).toBe(501)
    expect(await test.json()).toEqual(REFUSAL)
    const again = await call('POST', `${PATH}/${endpoint.id}/deliveries/${endpoint.id}/redeliver`)
    expect(again.status).toBe(501)
    expect(await again.json()).toEqual(REFUSAL)
    expect(received).toEqual([])
    // Registering, reading and the delivery log are not deliveries: an API instance serves them.
    expect((await call('GET', `${PATH}/${endpoint.id}`)).status).toBe(200)
    expect((await call('GET', `${PATH}/${endpoint.id}/deliveries`)).status).toBe(200)
    // Without a key the refusal is the usual one: the mode is not told to a stranger.
    const stranger = await app.request(`${PATH}/${endpoint.id}/test`, { method: 'POST' })
    expect(stranger.status).toBe(401)
  })

  // The refusal is about the deployment, not about the request: it comes right after the key
  // is checked, before the send limit counts anything and before a body or an id is looked at.
  describe('the order of the refusal over HTTP', () => {
    const post = (deps: TestDeps, path: string, init: { key?: string; body?: string } = {}) =>
      createApp(deps).request(path, {
        method: 'POST',
        headers: {
          ...(init.key !== undefined && { authorization: `Bearer ${init.key}` }),
          'content-type': 'application/json',
        },
        body: init.body ?? JSON.stringify({ eventType: 'user.deleted' }),
      })

    test('every call is the refusal, however many: the send limit never answers for it', async () => {
      await seedApiKey(api, SK)
      const endpoint = await register()
      const statuses: number[] = []
      for (let call = 0; call < 12; call += 1) {
        const answer = await post(api, `${PATH}/${endpoint.id}/test`, { key: SK })
        statuses.push(answer.status)
        expect(await answer.json()).toEqual(REFUSAL)
      }
      expect(statuses).toEqual(new Array(12).fill(501))
      const again: number[] = []
      for (let call = 0; call < 12; call += 1) {
        const path = `${PATH}/${endpoint.id}/deliveries/${endpoint.id}/redeliver`
        again.push((await post(api, path, { key: SK })).status)
      }
      expect(again).toEqual(new Array(12).fill(501))
    })

    test('a body or an id the route would refuse is the same refusal, not a validation error', async () => {
      await seedApiKey(api, SK)
      const endpoint = await register()
      for (const [path, body] of [
        [`${PATH}/${endpoint.id}/test`, '{"eventType":"no.such.type"}'],
        [`${PATH}/${endpoint.id}/test`, 'not json'],
        [`${PATH}/not-an-id/test`, '{"eventType":"user.deleted"}'],
        [`${PATH}/not-an-id/deliveries/neither/redeliver`, '{}'],
      ] as const) {
        const answer = await post(api, path, { key: SK, body })
        expect(`${path} ${answer.status}`).toBe(`${path} 501`)
        expect(await answer.json()).toEqual(REFUSAL)
      }
    })

    test('without a key, or with a wrong one, the answer is the usual 401: the mode is not told to a stranger', async () => {
      await seedApiKey(api, SK)
      const endpoint = await register()
      for (const key of [undefined, 'tula_sk_dev_wrong0000000000000000000000000000000']) {
        const test = await post(api, `${PATH}/${endpoint.id}/test`, { key })
        expect(test.status).toBe(401)
        const again = await post(
          api,
          `${PATH}/${endpoint.id}/deliveries/${endpoint.id}/redeliver`,
          {
            key,
          }
        )
        expect(again.status).toBe(401)
      }
    })

    test('refused calls spend nothing of the send allowance: all of it is there when the process delivers', async () => {
      await seedApiKey(api, SK)
      const endpoint = await register()
      for (let call = 0; call < 12; call += 1) {
        expect((await post(api, `${PATH}/${endpoint.id}/test`, { key: SK })).status).toBe(501)
      }
      // The same stores and the same limiter, in a process that delivers.
      const allowed: number[] = []
      for (let call = 0; call < Webhooks.WEBHOOK_SEND_RATE_LIMIT + 1; call += 1) {
        allowed.push((await post(worker, `${PATH}/${endpoint.id}/test`, { key: SK })).status)
      }
      expect(allowed).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 429])
    })
  })

  test('where the process delivers, both work as they always have', async () => {
    const endpoint = await register()
    const result = await Webhooks.sendTest(worker, tenant, endpoint.id, {
      eventType: 'user.deleted',
    })
    expect(result.outcome).toBe('delivered')
    expect(received).toHaveLength(1)
  })
})
