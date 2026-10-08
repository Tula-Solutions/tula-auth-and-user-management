import { beforeEach, describe, expect, test } from 'bun:test'
import { createApp } from '~/index'
import { PUBLISHABLE_KEY_HEADER } from '~/middleware/publishable-key'
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
