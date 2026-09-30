import { describe, expect, test } from 'bun:test'
import { createApp } from '~/index'
import { sha256Hex } from '~/lib/crypto'
import { bearerToken } from '~/middleware/api-key'
import { PUBLISHABLE_KEY_HEADER, publishableKey } from '~/middleware/publishable-key'
import { secretKey } from '~/middleware/secret-key'
import type { ApiKeyKind } from '~/ports/api-key-repository'
import { createTestDeps } from '~/testing'

const PK = 'tula_pk_dev_publishable0000000000000000000'
const SK = 'tula_sk_dev_secret00000000000000000000000000'
const TENANT = { projectId: 'p1', environmentId: 'e1' }

function setup() {
  const deps = createTestDeps()
  const add = (key: string, kind: ApiKeyKind, id: string) =>
    deps.apiKeys.insert(sha256Hex(key), { id, kind, ...TENANT, revokedAt: null })
  add(PK, 'publishable', 'pk1')
  add(SK, 'secret', 'sk1')
  const app = createApp(deps)
  app.get('/test/client', publishableKey(), (c) => c.json(c.get('tenant')))
  app.get('/test/admin', secretKey(), (c) => c.json(c.get('tenant')))
  return { deps, app }
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
    const { app } = setup()
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
    const { app } = setup()
    const headers: Record<string, string> = key ? { [PUBLISHABLE_KEY_HEADER]: key } : {}
    await expectInvalidKey(await app.request('/test/client', { headers }))
  })

  test('rejects a revoked key', async () => {
    const { app, deps } = setup()
    deps.apiKeys.revoke(sha256Hex(PK), deps.clock.now())
    await expectInvalidKey(
      await app.request('/test/client', { headers: { [PUBLISHABLE_KEY_HEADER]: PK } })
    )
  })
})

describe('secretKey', () => {
  test('resolves the tenant from a Bearer secret key', async () => {
    const { app } = setup()
    const res = await app.request('/test/admin', { headers: { authorization: `Bearer ${SK}` } })
    expect(await res.json()).toEqual({ ...TENANT, apiKeyId: 'sk1' })
  })

  test('rejects a publishable key even when stored under a secret prefix', async () => {
    const { app, deps } = setup()
    // A mis-issued key: secret-looking prefix but publishable in the database.
    const misissued = 'tula_sk_dev_actuallypublishable000000000000'
    deps.apiKeys.insert(sha256Hex(misissued), {
      id: 'x',
      kind: 'publishable',
      ...TENANT,
      revokedAt: null,
    })
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
    const { app } = setup()
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
