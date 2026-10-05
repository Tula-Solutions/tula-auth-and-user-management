import { beforeEach, describe, expect, test } from 'bun:test'
import { createApp } from '~/index'
import { PUBLISHABLE_KEY_HEADER } from '~/middleware/publishable-key'
import { ADMIN_RATE_LIMIT } from '~/middleware/rate-limit'
import { createTestDeps, seedApiKey, TEST_CONFIG, TEST_TENANT, type TestDeps } from '~/testing'

const SK = 'tula_sk_dev_admin000000000000000000000000000000'
const PROD_SK = 'tula_sk_prod_admin00000000000000000000000000000'
const PK = 'tula_pk_dev_publishable0000000000000000000000000'

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

async function create(key = SK, body: unknown = { kind: 'secret', name: 'Backend' }) {
  const res = await call('POST', '/v1/admin/api-keys', key, body)
  return { res, body: (await res.json()) as { id: string; key: string; [k: string]: unknown } }
}

describe('an API key’s name', () => {
  test.each([
    ['a line break', 'Backend\nINFO forged log line'],
    ['a carriage return', 'Backend\rx'],
    ['an escape sequence', 'Backend\u001b[2J'],
    ['a NUL', 'Back\u0000end'],
    ['a delete character', 'Backend\u007f'],
  ])('with %s is refused: it is shown in terminals and logs', async (_label, name) => {
    const count = async () =>
      ((await (await call('GET', '/v1/admin/api-keys', SK)).json()) as { data: unknown[] }).data
        .length
    const before = await count()
    const { res, body } = await create(SK, { kind: 'secret', name })
    expect(res.status).toBe(422)
    expect(body).toMatchObject({ code: 'validation.failed', errors: [{ field: 'name' }] })
    expect(await count()).toBe(before)
  })

  test('an ordinary name, with spaces and accents, is accepted and trimmed', async () => {
    const { res, body } = await create(SK, { kind: 'secret', name: '  Café backend (EU)  ' })
    expect(res.status).toBe(201)
    expect(body.name).toBe('Café backend (EU)')
  })
})

describe('authentication', () => {
  test.each([
    ['GET', '/v1/admin/environments'],
    ['GET', '/v1/admin/api-keys'],
    ['POST', '/v1/admin/api-keys'],
    ['DELETE', `/v1/admin/api-keys/${TEST_TENANT.environmentId}`],
  ])('%s %s requires a secret key', async (method, path) => {
    const res = await call(method, path, null)
    expect(res.status).toBe(401)
    expect(((await res.json()) as { code: string }).code).toBe('auth.invalid_key')
  })

  test('a publishable key cannot reach admin routes, in either header', async () => {
    expect((await call('GET', '/v1/admin/api-keys', PK)).status).toBe(401)
    const res = await app.request('/v1/admin/api-keys', {
      headers: { [PUBLISHABLE_KEY_HEADER]: PK },
    })
    expect(res.status).toBe(401)
  })

  test('unauthenticated requests are rejected before the body is validated', async () => {
    const res = await call('POST', '/v1/admin/api-keys', null, { kind: 'nope' })
    expect(res.status).toBe(401)
  })

  test('failed key guesses count toward the per-IP limit', async () => {
    const trusted = createTestDeps({ config: { ...TEST_CONFIG, trustProxy: true } })
    const limited = createApp(trusted)
    const guess = () =>
      limited.request('/v1/admin/api-keys', {
        headers: { authorization: 'Bearer tula_sk_dev_guess', 'x-forwarded-for': '203.0.113.9' },
      })
    for (let i = 0; i < ADMIN_RATE_LIMIT; i++) {
      await guess()
    }
    const blocked = await guess()
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).not.toBeNull()
  })
})

describe('GET /v1/admin/environments', () => {
  test('lists the project’s environments', async () => {
    const res = await call('GET', '/v1/admin/environments')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { id: string; kind: string; createdAt: string }[] }
    expect(body.data.map((env) => env.kind)).toEqual(['development', 'production'])
    expect(body.data[0]?.createdAt).toBe(deps.clock.now().toISOString())
  })
})

describe('POST /v1/admin/api-keys', () => {
  test('returns the key once, uncacheable, and the key works immediately', async () => {
    const { res, body } = await create()
    expect(res.status).toBe(201)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(body.key).toMatch(/^tula_sk_dev_/)
    expect(body).toMatchObject({ kind: 'secret', name: 'Backend', revokedAt: null })
    expect((await call('GET', '/v1/admin/api-keys', body.key)).status).toBe(200)
  })

  test('a production secret key mints production keys', async () => {
    const { body } = await create(PROD_SK, { kind: 'publishable', name: 'iOS' })
    expect(body.key).toMatch(/^tula_pk_prod_/)
    expect(body.environmentId).toBe(TEST_TENANT.productionEnvironmentId)
  })

  test.each([
    ['an unknown kind', { kind: 'root', name: 'x' }, 'kind'],
    ['a blank name', { kind: 'secret', name: '   ' }, 'name'],
    ['a name over 100 characters', { kind: 'secret', name: 'x'.repeat(101) }, 'name'],
    ['a missing name', { kind: 'secret' }, 'name'],
  ])('rejects %s', async (_, input, field) => {
    const { res, body } = await create(SK, input)
    expect(res.status).toBe(422)
    expect((body as unknown as { errors: { field: string }[] }).errors.map((e) => e.field)).toEqual(
      [field]
    )
  })

  test('trims the name', async () => {
    const { body } = await create(SK, { kind: 'secret', name: '  Backend  ' })
    expect(body.name).toBe('Backend')
  })
})

describe('GET /v1/admin/api-keys', () => {
  test('lists the environment’s keys without their values', async () => {
    const { body: created } = await create()
    const res = await call('GET', '/v1/admin/api-keys')
    const text = await res.text()
    const listed = JSON.parse(text) as { data: { id: string; environmentId: string }[] }
    expect(listed.data.map((key) => key.id)).toContain(created.id)
    expect(listed.data.every((key) => key.environmentId === TEST_TENANT.environmentId)).toBe(true)
    expect(text).not.toContain(created.key)
    expect(text).not.toContain('keyHash')
  })
})

describe('DELETE /v1/admin/api-keys/:id', () => {
  test('rotation: a new key revokes the old one, which then stops working', async () => {
    const { body: old } = await create()
    const { body: replacement } = await create(old.key)
    const res = await call('DELETE', `/v1/admin/api-keys/${old.id}`, replacement.key)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { revokedAt: string }).revokedAt).toBe(
      deps.clock.now().toISOString()
    )
    expect((await call('GET', '/v1/admin/api-keys', old.key)).status).toBe(401)
  })

  test('a key cannot revoke itself', async () => {
    const { body: self } = await create()
    const res = await call('DELETE', `/v1/admin/api-keys/${self.id}`, self.key)
    expect(res.status).toBe(409)
    expect((await call('GET', '/v1/admin/api-keys', self.key)).status).toBe(200)
  })

  test('another environment’s key id is not found, and stays active', async () => {
    const { body: prodKey } = await create(PROD_SK)
    const res = await call('DELETE', `/v1/admin/api-keys/${prodKey.id}`)
    expect(res.status).toBe(404)
    expect((await call('GET', '/v1/admin/api-keys', prodKey.key)).status).toBe(200)
  })

  test('rejects a malformed id', async () => {
    const res = await call('DELETE', '/v1/admin/api-keys/not-a-uuid')
    expect(res.status).toBe(422)
  })
})
