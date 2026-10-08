import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { environmentIssuer, jwksUrl } from '@tula/contract'
import { createApp } from '~/index'
import * as Jwks from '~/modules/jwks/service'
import { createTestDeps, seedApiKey, TEST_CONFIG, TEST_TENANT, type TestDeps } from '~/testing'

const SK = 'tula_sk_dev_admin000000000000000000000000000000'
let deps: TestDeps
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  deps = createTestDeps()
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  await seedApiKey(deps, SK)
  app = createApp(deps)
})

const admin = (method: string, path: string) =>
  app.request(path, { method, headers: { authorization: `Bearer ${SK}` } })

describe('GET <issuer>/.well-known/jwks.json', () => {
  test('is served at the URL derived from the token issuer, cacheable, without auth', async () => {
    await Jwks.ensureKeys(deps, TEST_TENANT.environmentId)
    const url = new URL(
      jwksUrl(environmentIssuer(TEST_CONFIG.publicUrl, TEST_TENANT.environmentId))
    )
    const res = await app.request(url.pathname)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe(`public, max-age=${Jwks.JWKS_MAX_AGE_SECONDS}`)
    const body = (await res.json()) as { keys: Record<string, string>[] }
    expect(body.keys).toHaveLength(2)
    expect(body.keys.every((key) => !('d' in key))).toBe(true)
  })

  test('bootstraps an environment that has no keys yet instead of serving an empty set', async () => {
    const res = await app.request(
      `/v1/environments/${TEST_TENANT.environmentId}/.well-known/jwks.json`
    )
    expect(((await res.json()) as { keys: unknown[] }).keys).toHaveLength(2)
  })

  test('an empty set is never cacheable', async () => {
    const spy = spyOn(Jwks, 'publicKeySet').mockResolvedValue({ keys: [] })
    try {
      const res = await app.request(
        `/v1/environments/${TEST_TENANT.environmentId}/.well-known/jwks.json`
      )
      expect(res.headers.get('cache-control')).toBe('no-store')
    } finally {
      spy.mockRestore()
    }
  })

  test('404s for an unknown environment and 422s for a malformed id', async () => {
    const unknown = await app.request(
      '/v1/environments/00000000-0000-7000-8000-0000000000ff/.well-known/jwks.json'
    )
    expect(unknown.status).toBe(404)
    const malformed = await app.request('/v1/environments/nope/.well-known/jwks.json')
    expect(malformed.status).toBe(422)
  })
})

describe('admin signing keys', () => {
  test('require a secret key', async () => {
    expect((await app.request('/v1/admin/signing-keys')).status).toBe(401)
    expect((await app.request('/v1/admin/signing-keys/rotate', { method: 'POST' })).status).toBe(
      401
    )
  })

  test('list the lifecycle and rotate once the next key is old enough', async () => {
    await Jwks.ensureKeys(deps, TEST_TENANT.environmentId)
    const listed = (await (await admin('GET', '/v1/admin/signing-keys')).json()) as {
      data: { status: string }[]
    }
    expect(listed.data.map((key) => key.status).sort()).toEqual(['active', 'next'])

    const early = await admin('POST', '/v1/admin/signing-keys/rotate')
    expect(early.status).toBe(409)
    expect(((await early.json()) as { params: { retryAfter: number } }).params.retryAfter).toBe(
      Jwks.NEXT_KEY_MIN_AGE_MS / 1000
    )

    deps.clock.advance(Jwks.NEXT_KEY_MIN_AGE_MS)
    const res = await admin('POST', '/v1/admin/signing-keys/rotate')
    expect(res.status).toBe(200)
    const rotated = (await res.json()) as { data: { status: string }[] }
    expect(rotated.data.map((key) => key.status)).toEqual(['next', 'active', 'retired'])
    expect(JSON.stringify(rotated)).not.toContain('v1.')
  })
})
