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
const receiver = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    arrived.push({ body: await request.text(), headers: request.headers })
    return new Response(null, { status: 204 })
  },
})
afterAll(() => receiver.stop(true))

beforeEach(() => {
  arrived = []
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
