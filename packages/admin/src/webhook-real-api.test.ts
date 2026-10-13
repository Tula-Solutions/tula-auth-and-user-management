import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { FixedClock } from '../../../apps/api/src/adapters/memory/clock'
import { createApp } from '../../../apps/api/src/index'
import * as Webhooks from '../../../apps/api/src/modules/webhook/service'
import { createTestDeps, seedApiKey, TEST_TENANT } from '../../../apps/api/src/testing'
import {
  type AdminFetch,
  createAdminClient,
  isTulaAdminError,
  type TulaWebhookEvent,
  verifyWebhook,
} from './index'

// A delivery as the server really makes it: an endpoint registered through this package's
// client, an event recorded by the real API in process, the real worker, the real outbound
// guard and a real socket to a listener on loopback. What arrives there is what
// `verifyWebhook` is given.

const SECRET_KEY = 'tula_sk_dev_adminwebhook00000000000000000000'
const BASE_URL = 'http://localhost:3003'

interface Arrived {
  body: string
  headers: Headers
}

let arrived: Arrived[] = []
/** The statuses the receiver answers its next deliveries with; 204 after them. */
let answers: number[] = []
const receiver = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    arrived.push({ body: await request.text(), headers: request.headers })
    return new Response(null, { status: answers.shift() ?? 204 })
  },
})
afterAll(() => receiver.stop(true))

beforeEach(() => {
  arrived = []
  answers = []
})

async function world() {
  // The wall clock, so the delivery's timestamp is judged as a receiver would judge it.
  const deps = createTestDeps({ clock: new FixedClock(new Date()) })
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  await seedApiKey(deps, SECRET_KEY)
  const app = createApp(deps)
  const fetch: AdminFetch = async (url, init) => app.request(url, init)
  const admin = createAdminClient({ baseUrl: BASE_URL, secretKey: SECRET_KEY, fetch })
  const endpoint = await admin.call('createWebhookEndpoint', {
    body: {
      url: `http://127.0.0.1:${receiver.port}/tula`,
      eventTypes: ['user.created', 'user.banned'],
    },
  })
  return { deps, admin, endpoint: endpoint.data }
}

describe('a delivery the server made, given to verifyWebhook', () => {
  test('verifies with the secret the registration returned and is the event that happened', async () => {
    const { deps, admin, endpoint } = await world()
    const user = await admin.call('createUser', { body: { email: 'maya@northline.app' } })
    await Webhooks.deliverPending(deps)

    expect(arrived).toHaveLength(1)
    const [delivery] = arrived as [Arrived]
    const event: TulaWebhookEvent = await verifyWebhook(
      delivery.body,
      delivery.headers,
      endpoint.secret
    )
    expect(event.type).toBe('user.created')
    expect(event.id).toBe(delivery.headers.get('webhook-id') as string)
    expect(event.target).toEqual({ type: 'user', id: user.data.id })
    if (event.type === 'user.created') {
      expect(event.data).toEqual({ method: 'admin', emailVerified: false, passwordless: true })
    }
    // The payload is what the contract allows a third party to see: no address.
    expect(delivery.body).not.toContain('maya@northline.app')
    // The same delivery as Node hands it to a handler: bytes, and headers as a plain record.
    expect(
      await verifyWebhook(
        new TextEncoder().encode(delivery.body),
        Object.fromEntries(delivery.headers),
        endpoint.secret
      )
    ).toEqual(event)
  })

  test('is refused with another endpoint’s secret, a changed body, and once it is stale', async () => {
    const { deps, admin, endpoint } = await world()
    const other = await admin.call('createWebhookEndpoint', {
      body: { url: `http://127.0.0.1:${receiver.port}/other`, eventTypes: ['user.deleted'] },
    })
    await admin.call('createUser', { body: { email: 'maya@northline.app' } })
    await Webhooks.deliverPending(deps)
    const [delivery] = arrived as [Arrived]

    const code = async (work: Promise<unknown>) => {
      try {
        await work
        return 'accepted'
      } catch (error) {
        return isTulaAdminError(error) ? error.code : 'threw something else'
      }
    }
    expect(await code(verifyWebhook(delivery.body, delivery.headers, other.data.secret))).toBe(
      'webhook.invalid_signature'
    )
    expect(
      await code(
        verifyWebhook(
          delivery.body.replace('"admin"', '"sign_up"'),
          delivery.headers,
          endpoint.secret
        )
      )
    ).toBe('webhook.invalid_signature')
    const sixMinutesOn = deps.clock.now().getTime() + 6 * 60_000
    expect(
      await code(
        verifyWebhook(delivery.body, delivery.headers, endpoint.secret, { now: sixMinutesOn })
      )
    ).toBe('webhook.timestamp_out_of_tolerance')
    expect(await code(verifyWebhook(delivery.body, delivery.headers, endpoint.secret))).toBe(
      'accepted'
    )
  })

  test('the endpoint is managed through the typed client, and its secret is never read back', async () => {
    const { admin, endpoint } = await world()
    const listed = await admin.call('listWebhookEndpoints')
    expect(listed.data.data.map((one) => one.id)).toEqual([endpoint.id])
    const updated = await admin.call('updateWebhookEndpoint', {
      params: { id: endpoint.id },
      body: { enabled: false },
    })
    expect(updated.data.enabled).toBe(false)
    const read = await admin.call('getWebhookEndpoint', { params: { id: endpoint.id } })
    expect(JSON.stringify([listed.data, updated.data, read.data])).not.toContain(endpoint.secret)
    expect(
      (await admin.call('deleteWebhookEndpoint', { params: { id: endpoint.id } })).status
    ).toBe(204)
  })

  test('an address the server may not call is refused with the contract’s code', async () => {
    const { admin } = await world()
    let refused: unknown
    try {
      await admin.call('createWebhookEndpoint', {
        body: { url: 'https://10.0.0.1/hook', eventTypes: ['user.created'] },
      })
    } catch (error) {
      refused = error
    }
    expect(isTulaAdminError(refused) && [refused.code, refused.status, refused.params]).toEqual([
      'webhook.url_not_allowed',
      422,
      { reason: 'address_not_allowed' },
    ])
  })
})

describe('retries, the delivery log, test events and sending again, through the typed client', () => {
  test('a delivery that failed is in the log as pending, is retried by the worker, and the log then has both requests', async () => {
    const { deps, admin, endpoint } = await world()
    await admin.call('createUser', { body: { email: 'grace@example.com' } })
    answers = [500]
    await Webhooks.deliverPending(deps)

    const pending = await admin.call('listWebhookDeliveries', {
      params: { id: endpoint.id },
      query: { state: 'pending', eventType: 'user.created' },
    })
    expect(pending.data.meta.totalCount).toBe(1)
    const [delivery] = pending.data.data
    expect(delivery).toMatchObject({ state: 'pending', attemptCount: 1, statusCode: 500 })
    const failing = await admin.call('getWebhookEndpoint', { params: { id: endpoint.id } })
    expect(failing.data.failingSince).not.toBeNull()

    // The first wait of the schedule, and the worker's next round.
    deps.clock.advance('5s')
    await Webhooks.deliverPending(deps)
    const detail = await admin.call('getWebhookDelivery', {
      params: { id: endpoint.id, deliveryId: delivery?.id ?? '' },
    })
    expect(detail.data).toMatchObject({ state: 'delivered', attemptCount: 2 })
    expect(detail.data.attempts.map((attempt) => attempt.statusCode)).toEqual([500, 204])
    // The receiver saw the same event twice, with the same id, and verifies both.
    expect(arrived).toHaveLength(2)
    const events = await Promise.all(
      arrived.map((one) =>
        verifyWebhook(one.body, one.headers, endpoint.secret, { now: deps.clock.now().getTime() })
      )
    )
    expect(events[0]?.id).toBe(events[1]?.id as string)
    expect(events.every((event) => event.test === undefined)).toBe(true)
  })

  test('a test event verifies like any delivery and tells the receiver it is a test', async () => {
    const { deps, admin, endpoint } = await world()
    const sent = await admin.call('sendTestWebhook', {
      params: { id: endpoint.id },
      body: { eventType: 'session.reuse_detected' },
    })
    expect(sent.data).toEqual({
      deliveryId: sent.data.deliveryId,
      outcome: 'delivered',
      statusCode: 204,
      durationMs: 0,
      failureReason: null,
    })
    const [delivery] = arrived as [Arrived]
    const event = await verifyWebhook(delivery.body, delivery.headers, endpoint.secret, {
      now: deps.clock.now().getTime(),
    })
    // What a receiver checks before it acts on an event.
    expect(event.test).toBe(true)
    expect(event.type).toBe('session.reuse_detected')
    const logged = await admin.call('getWebhookDelivery', {
      params: { id: endpoint.id, deliveryId: sent.data.deliveryId },
    })
    expect(logged.data).toMatchObject({ test: true, eventId: null, state: 'delivered' })
  })

  test('a delivery is sent again with its own id; one that is pending, or of an endpoint that is off, is refused with a reason', async () => {
    const { deps, admin, endpoint } = await world()
    await admin.call('createUser', { body: { email: 'edsger@example.com' } })
    answers = [500]
    await Webhooks.deliverPending(deps)
    const listed = await admin.call('listWebhookDeliveries', { params: { id: endpoint.id } })
    const deliveryId = listed.data.data[0]?.id ?? ''
    const params = { id: endpoint.id, deliveryId }
    const refusal = async () => {
      try {
        await admin.call('redeliverWebhook', { params })
        return null
      } catch (error) {
        return isTulaAdminError(error) ? [error.code, error.status, error.params] : error
      }
    }
    expect(await refusal()).toEqual([
      'webhook.cannot_redeliver',
      409,
      { reason: 'delivery_pending' },
    ])

    deps.clock.advance('5s')
    await Webhooks.deliverPending(deps)
    const again = await admin.call('redeliverWebhook', { params })
    expect(again.data).toMatchObject({ deliveryId, outcome: 'delivered', statusCode: 204 })
    expect(new Set(arrived.map((one) => one.headers.get('webhook-id'))).size).toBe(1)
    expect(arrived).toHaveLength(3)

    await admin.call('updateWebhookEndpoint', {
      params: { id: endpoint.id },
      body: { enabled: false },
    })
    expect(await refusal()).toEqual([
      'webhook.cannot_redeliver',
      409,
      { reason: 'endpoint_disabled' },
    ])
    expect(arrived).toHaveLength(3)
  })

  test('a rotated secret: deliveries of the overlap verify with either secret, and after it with the new one only', async () => {
    const { deps, admin, endpoint } = await world()
    const at = () => ({ now: deps.clock.now().getTime() })
    const code = async (work: Promise<unknown>) => {
      try {
        await work
        return 'accepted'
      } catch (error) {
        return isTulaAdminError(error) ? error.code : 'threw something else'
      }
    }
    /** Something happens and the worker delivers it: what arrived. */
    const next = async (email: string): Promise<Arrived> => {
      const before = arrived.length
      await admin.call('createUser', { body: { email } })
      await Webhooks.deliverPending(deps)
      expect(arrived).toHaveLength(before + 1)
      return arrived[before] as Arrived
    }

    const rotated = await admin.call('rotateWebhookSecret', { params: { id: endpoint.id } })
    const { secret: fresh, rotationOverlapEndsAt } = rotated.data
    expect(fresh).not.toBe(endpoint.secret)
    expect(Date.parse(rotationOverlapEndsAt) - deps.clock.now().getTime()).toBe(24 * 3_600_000)

    // During the overlap: two signatures, and a receiver on the old secret, on the new one or
    // on both takes the delivery.
    const during = await next('grace@example.com')
    expect((during.headers.get('webhook-signature') ?? '').split(' ')).toHaveLength(2)
    for (const secrets of [endpoint.secret, fresh, [fresh, endpoint.secret]]) {
      const event = await verifyWebhook(during.body, during.headers, secrets, at())
      expect(event.type).toBe('user.created')
    }

    // A second rotation while the first one's overlap lasts is refused: never three.
    const refusal = async (work: Promise<unknown>) => {
      try {
        await work
        return null
      } catch (error) {
        return isTulaAdminError(error) ? [error.code, error.status, error.params] : error
      }
    }
    expect(
      await refusal(admin.call('rotateWebhookSecret', { params: { id: endpoint.id } }))
    ).toEqual(['webhook.rotation_refused', 409, { reason: 'rotation_in_progress' }])

    // After the overlap: one signature, the new secret's. The old one alone no longer verifies,
    // and a receiver that still lists both is not hurt.
    deps.clock.set(new Date(rotationOverlapEndsAt))
    const after = await next('ada@example.com')
    expect((after.headers.get('webhook-signature') ?? '').split(' ')).toHaveLength(1)
    expect(await code(verifyWebhook(after.body, after.headers, endpoint.secret, at()))).toBe(
      'webhook.invalid_signature'
    )
    expect(await code(verifyWebhook(after.body, after.headers, fresh, at()))).toBe('accepted')
    expect(
      await code(verifyWebhook(after.body, after.headers, [fresh, endpoint.secret], at()))
    ).toBe('accepted')
    const read = await admin.call('getWebhookEndpoint', { params: { id: endpoint.id } })
    expect(read.data.rotationOverlapEndsAt).toBeNull()
    expect(JSON.stringify(read.data)).not.toContain('whsec_')
  })

  test('the overlap of a rotation can be ended early through the typed client, and then only the new secret verifies', async () => {
    const { deps, admin, endpoint } = await world()
    const params = { id: endpoint.id }
    const refusal = async (work: Promise<unknown>) => {
      try {
        await work
        return null
      } catch (error) {
        return isTulaAdminError(error) ? [error.code, error.status, error.params] : error
      }
    }
    expect(await refusal(admin.call('revokePreviousWebhookSecret', { params }))).toEqual([
      'webhook.rotation_refused',
      409,
      { reason: 'no_rotation_in_progress' },
    ])
    const rotated = await admin.call('rotateWebhookSecret', { params })
    const revoked = await admin.call('revokePreviousWebhookSecret', { params })
    expect(revoked.data.rotationOverlapEndsAt).toBeNull()
    expect(JSON.stringify(revoked.data)).not.toContain('whsec_')

    await admin.call('createUser', { body: { email: 'grace@example.com' } })
    await Webhooks.deliverPending(deps)
    const [delivery] = arrived as [Arrived]
    expect((await verifyWebhook(delivery.body, delivery.headers, rotated.data.secret)).type).toBe(
      'user.created'
    )
    expect(await refusal(verifyWebhook(delivery.body, delivery.headers, endpoint.secret))).toEqual([
      'webhook.invalid_signature',
      0,
      {},
    ])
  })
})
