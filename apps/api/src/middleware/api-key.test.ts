import { describe, expect, test } from 'bun:test'
import { createApp } from '~/index'
import { sha256Hex } from '~/lib/crypto'
import { bearerToken } from '~/middleware/api-key'
import { PUBLISHABLE_KEY_HEADER, publishableKey } from '~/middleware/publishable-key'
import { secretKey } from '~/middleware/secret-key'
import * as Audit from '~/modules/audit/service'
import { createTestDeps, seedApiKey } from '~/testing'

const PK = 'tula_pk_dev_publishable0000000000000000000'
const SK = 'tula_sk_dev_secret00000000000000000000000000'
const TENANT = { projectId: 'p1', environmentId: 'e1' }

async function setup() {
  const deps = createTestDeps()
  const pk = await seedApiKey(deps, PK, { id: 'pk1', ...TENANT })
  await seedApiKey(deps, SK, { id: 'sk1', ...TENANT })
  const app = createApp(deps)
  app.get('/test/client', publishableKey(), (c) => c.json(c.get('tenant')))
  app.get('/test/admin', secretKey(), (c) => c.json(c.get('tenant')))
  return { deps, app, pk }
}

async function expectInvalidKey(res: Response) {
  expect(res.status).toBe(401)
  expect(await res.json()).toEqual({
    status: 401,
    code: 'auth.invalid_key',
    detail: 'The API key is missing, invalid or revoked.',
  })
}

describe('publishableKey', () => {
  test('resolves the tenant from a valid key', async () => {
    const { app } = await setup()
    const res = await app.request('/test/client', { headers: { [PUBLISHABLE_KEY_HEADER]: PK } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ...TENANT, apiKeyId: 'pk1' })
  })

  test.each([
    ['missing', undefined],
    ['wrong prefix', PK.replace('tula_pk_', 'tula_xx_')],
    ['unknown', `${PK}x`],
    ['a secret key', SK],
    ['oversized', `tula_pk_${'a'.repeat(300)}`],
  ])('rejects a %s key with the same generic error', async (_, key) => {
    const { app } = await setup()
    const headers: Record<string, string> = key ? { [PUBLISHABLE_KEY_HEADER]: key } : {}
    await expectInvalidKey(await app.request('/test/client', { headers }))
  })

  test('rejects a revoked key', async () => {
    const { app, deps, pk } = await setup()
    await deps.apiKeys.revoke(TENANT.environmentId, pk.id, deps.clock.now(), Audit.none('fixture'))
    await expectInvalidKey(
      await app.request('/test/client', { headers: { [PUBLISHABLE_KEY_HEADER]: PK } })
    )
  })
})

describe('last used tracking', () => {
  test('records when a key was last used, at most once a minute', async () => {
    const { app, deps, pk } = await setup()
    const use = () => app.request('/test/client', { headers: { [PUBLISHABLE_KEY_HEADER]: PK } })
    const lastUsed = async () => (await deps.apiKeys.findByHash(sha256Hex(PK)))?.lastUsedAt
    expect(pk.lastUsedAt).toBeNull()

    await use()
    const first = deps.clock.now()
    expect(await lastUsed()).toEqual(first)

    deps.clock.advance('30s')
    await use()
    expect(await lastUsed()).toEqual(first)

    deps.clock.advance('31s')
    await use()
    expect(await lastUsed()).toEqual(deps.clock.now())
  })

  test('a failure to record usage does not fail the request', async () => {
    const { app, deps } = await setup()
    deps.apiKeys.touch = async () => {
      throw new Error('database write failed')
    }
    const res = await app.request('/test/client', { headers: { [PUBLISHABLE_KEY_HEADER]: PK } })
    expect(res.status).toBe(200)
  })

  test('failed resolutions do not record usage', async () => {
    const { app, deps, pk } = await setup()
    await deps.apiKeys.revoke(TENANT.environmentId, pk.id, deps.clock.now(), Audit.none('fixture'))
    await app.request('/test/client', { headers: { [PUBLISHABLE_KEY_HEADER]: PK } })
    expect((await deps.apiKeys.findByHash(sha256Hex(PK)))?.lastUsedAt).toBeNull()
  })
})

describe('secretKey', () => {
  test('resolves the tenant from a Bearer secret key', async () => {
    const { app } = await setup()
    const res = await app.request('/test/admin', { headers: { authorization: `Bearer ${SK}` } })
    expect(await res.json()).toEqual({ ...TENANT, apiKeyId: 'sk1' })
  })

  test('rejects a publishable key even when stored under a secret prefix', async () => {
    const { app, deps } = await setup()
    // A mis-issued key: secret-looking prefix but publishable in the database.
    const misissued = 'tula_sk_dev_actuallypublishable000000000000'
    await seedApiKey(deps, misissued, { id: 'x', kind: 'publishable', ...TENANT })
    await expectInvalidKey(
      await app.request('/test/admin', { headers: { authorization: `Bearer ${misissued}` } })
    )
  })

  test.each([
    ['no header', {}],
    ['a publishable key', { authorization: `Bearer ${PK}` }],
    ['the key without Bearer', { authorization: SK }],
    ['the key in the publishable header', { [PUBLISHABLE_KEY_HEADER]: SK }],
  ])('rejects %s', async (_, headers) => {
    const { app } = await setup()
    await expectInvalidKey(await app.request('/test/admin', { headers }))
  })
})

describe('bearerToken', () => {
  test.each([
    ['Bearer abc', 'abc'],
    ['bearer abc', 'abc'],
    ['Bearer   abc  ', 'abc'],
    ['Basic abc', undefined],
    ['Bearer', undefined],
    ['Bearer a b', undefined],
    [undefined, undefined],
  ])('%p → %p', (header, expected) => {
    expect(bearerToken(header)).toBe(expected)
  })
})
