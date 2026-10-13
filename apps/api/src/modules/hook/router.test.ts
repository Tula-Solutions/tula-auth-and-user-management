import { beforeEach, describe, expect, test } from 'bun:test'
import type { CreatedHook, Hook } from '@tula/contract'
import { createApp, OPENAPI_PATH } from '~/index'
import { createTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'

const SK = 'tula_sk_dev_secret000000000000000000000000'
const OTHER_SK = 'tula_sk_live_secret00000000000000000000000'
const PK = 'tula_pk_dev_publishable0000000000000000000'
const URL_OK = 'http://hooks.operator.test:8443/tula/before-sign-up'

let deps: TestDeps
let app: ReturnType<typeof createApp>

beforeEach(async () => {
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
  await seedApiKey(deps, SK)
  await seedApiKey(deps, PK)
  await seedApiKey(deps, OTHER_SK, { environmentId: TEST_TENANT.productionEnvironmentId })
  // The guard is the real one; the name resolves to a loopback address, allowed in `local`.
  deps.outbound.point('hooks.operator.test', '127.0.0.1')
  app = createApp(deps)
})

function admin(method: string, path = '', body?: unknown, key: string | null = SK) {
  return app.request(`/v1/admin/hooks${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(key !== null && { authorization: `Bearer ${key}` }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
}

const json = async <T>(res: Response) => (await res.json()) as T

async function registered(body: Record<string, unknown> = {}, key = SK): Promise<CreatedHook> {
  const res = await admin('POST', '', { point: 'before_sign_up', url: URL_OK, ...body }, key)
  expect(res.status).toBe(201)
  return json<CreatedHook>(res)
}

const actions = () => deps.activityLog.entries.map((entry) => entry.type)

describe('POST /v1/admin/hooks', () => {
  test('registers a hook and returns its secret once, never to be cached', async () => {
    const res = await admin('POST', '', { point: 'before_sign_up', url: URL_OK })
    expect(res.status).toBe(201)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const created = await json<CreatedHook>(res)
    expect(created).toMatchObject({
      point: 'before_sign_up',
      url: URL_OK,
      enabled: true,
      deadlineMs: 2000,
      failureMode: 'deny',
      lastFailedAt: null,
      lastFailureReason: null,
    })
    expect(created.secret).toMatch(/^whsec_/)
    for (const read of [await admin('GET'), await admin('GET', `/${created.id}`)]) {
      expect(read.status).toBe(200)
      const text = await read.text()
      expect(text).not.toContain('whsec_')
      expect(text).not.toContain('secret')
    }
    const patched = await admin('PATCH', `/${created.id}`, { deadlineMs: 300 })
    expect(await patched.text()).not.toContain('secret')
    expect(actions()).toEqual(['hook.created', 'hook.updated'])
  })

  test.each([
    ['a deadline above five seconds', { deadlineMs: 5001 }],
    ['a deadline of a minute', { deadlineMs: 60_000 }],
    ['a deadline under the floor', { deadlineMs: 99 }],
    ['a secret of the caller’s own', { secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw' }],
    ['a point that does not exist', { point: 'before_refresh' }],
    ['a failure mode that does not exist', { failureMode: 'open' }],
    ['an unknown field', { claims: { role: 'admin' } }],
    ['an address with a space', { url: 'https://a.example/x y' }],
  ])('refuses %s as a validation error and stores nothing', async (_name, body) => {
    const res = await admin('POST', '', { point: 'before_sign_up', url: URL_OK, ...body })
    expect(res.status).toBe(422)
    expect((await json<{ code: string }>(res)).code).toBe('validation.failed')
    expect(await deps.hooks.list(TEST_TENANT.environmentId)).toEqual([])
    expect(actions()).toEqual([])
  })

  test('refuses an address the server may not call, with a fixed word and not the address', async () => {
    const res = await admin('POST', '', {
      point: 'before_sign_up',
      url: 'http://169.254.169.254/x',
    })
    expect(res.status).toBe(422)
    const body = await res.text()
    expect(JSON.parse(body)).toMatchObject({
      code: 'hook.url_not_allowed',
      params: { reason: 'address_not_allowed' },
    })
    expect(body).not.toContain('169.254')
  })

  test('a second hook for the same point is a conflict', async () => {
    await registered()
    const res = await admin('POST', '', { point: 'before_sign_up', url: URL_OK })
    expect(res.status).toBe(409)
    expect((await json<{ code: string }>(res)).code).toBe('resource.conflict')
    expect(actions()).toEqual(['hook.created'])
  })

  test.each([
    ['no key', null, 401],
    ['a publishable key', PK, 401],
    ['a key that does not exist', 'tula_sk_dev_nope00000000000000000000000000', 401],
  ] as const)(
    'with %s nothing is registered, read, changed or removed',
    async (_name, key, status) => {
      const { id } = await registered()
      for (const res of [
        await admin('POST', '', { point: 'before_sign_up', url: URL_OK }, key),
        await admin('GET', '', undefined, key),
        await admin('GET', `/${id}`, undefined, key),
        await admin('PATCH', `/${id}`, { enabled: false }, key),
        await admin('DELETE', `/${id}`, undefined, key),
      ]) {
        expect(res.status).toBe(status)
      }
      expect((await deps.hooks.find(TEST_TENANT.environmentId, id))?.enabled).toBe(true)
      expect(actions()).toEqual(['hook.created'])
    }
  )
})

describe('PATCH and DELETE /v1/admin/hooks/{id}', () => {
  test('a change is answered with the hook as it is now, and a weakening is recorded as one', async () => {
    const { id } = await registered()
    const res = await admin('PATCH', `/${id}`, { failureMode: 'allow', deadlineMs: 5000 })
    expect(res.status).toBe(200)
    expect(await json<Hook>(res)).toMatchObject({ failureMode: 'allow', deadlineMs: 5000 })
    expect(deps.activityLog.entries[1]?.data).toEqual({
      point: 'before_sign_up',
      changed: ['deadlineMs', 'failureMode'],
      weakened: true,
    })
    expect(deps.activityLog.entries[1]?.actor.type).toBe('admin')
  })

  test.each([
    ['nothing to change', {}],
    ['the point', { point: 'before_sign_up' }],
    ['a secret', { secret: 'whsec_x' }],
    ['a deadline above five seconds', { deadlineMs: 5001 }],
  ])('a change of %s is refused', async (_name, body) => {
    const { id } = await registered()
    expect((await admin('PATCH', `/${id}`, body)).status).toBe(422)
    expect(actions()).toEqual(['hook.created'])
  })

  test('removing answers 204, and then the hook is not found', async () => {
    const { id } = await registered()
    expect((await admin('DELETE', `/${id}`)).status).toBe(204)
    expect((await admin('GET', `/${id}`)).status).toBe(404)
    expect((await admin('DELETE', `/${id}`)).status).toBe(404)
    expect(actions()).toEqual(['hook.created', 'hook.deleted'])
  })

  test('another environment’s key finds nothing: no read, change or removal, and the same 404', async () => {
    const { id } = await registered()
    const unknown = await admin('GET', `/${deps.ids.next()}`)
    for (const res of [
      await admin('GET', `/${id}`, undefined, OTHER_SK),
      await admin('PATCH', `/${id}`, { enabled: false, failureMode: 'allow' }, OTHER_SK),
      await admin('DELETE', `/${id}`, undefined, OTHER_SK),
    ]) {
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual(await unknown.clone().json())
    }
    expect(await json<{ data: Hook[] }>(await admin('GET', '', undefined, OTHER_SK))).toEqual({
      data: [],
    })
    expect(await deps.hooks.find(TEST_TENANT.environmentId, id)).toMatchObject({
      enabled: true,
      failureMode: 'deny',
    })
  })

  test('an id that is not an id is a validation error', async () => {
    expect((await admin('GET', '/not-an-id')).status).toBe(422)
  })
})

describe('the OpenAPI document', () => {
  test('has the question and the answer of a hook, which no route returns', async () => {
    const document = await json<{ components: { schemas: Record<string, unknown> } }>(
      await app.request(OPENAPI_PATH)
    )
    for (const name of [
      'HookBeforeSignUpQuestion',
      'HookBeforeSignUpData',
      'HookBeforeSessionQuestion',
      'HookBeforeSessionData',
      'HookBeforeTokenQuestion',
      'HookBeforeTokenData',
      'HookAnswer',
      'HookClaimsAnswer',
      'Hook',
    ]) {
      expect(Object.keys(document.components.schemas)).toContain(name)
    }
  })
})
