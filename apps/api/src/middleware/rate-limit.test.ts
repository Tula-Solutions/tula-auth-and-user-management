import { describe, expect, test } from 'bun:test'
import { createApp } from '~/index'
import { sha256Hex } from '~/lib/crypto'
import { PUBLISHABLE_KEY_HEADER, publishableKey } from '~/middleware/publishable-key'
import { byEnvironment, byIp, rateLimit } from '~/middleware/rate-limit'
import { createTestDeps, TEST_CONFIG } from '~/testing'

describe('rateLimit', () => {
  test('returns 429 with Retry-After once the limit is exceeded, then recovers', async () => {
    const deps = createTestDeps()
    const app = createApp(deps)
    app.get('/test', rateLimit({ name: 't', limit: 2, window: '1m', key: byIp }), (c) =>
      c.text('ok')
    )
    expect((await app.request('/test')).status).toBe(200)
    expect((await app.request('/test')).status).toBe(200)
    deps.clock.advance('20s')
    const blocked = await app.request('/test')
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toBe('40')
    expect(await blocked.json()).toEqual({
      status: 429,
      code: 'rate_limited',
      detail: 'Too many requests. Try again shortly.',
      params: { retryAfter: 40 },
    })
    deps.clock.advance('40s')
    expect((await app.request('/test')).status).toBe(200)
  })

  test('buckets by the trusted proxy IP so clients do not share a limit', async () => {
    const deps = createTestDeps({ config: { ...TEST_CONFIG, trustProxy: true } })
    const app = createApp(deps)
    app.get('/test', rateLimit({ name: 't', limit: 1, window: '1m', key: byIp }), (c) =>
      c.text('ok')
    )
    const from = (ip: string) => app.request('/test', { headers: { 'x-forwarded-for': ip } })
    expect((await from('203.0.113.1')).status).toBe(200)
    expect((await from('203.0.113.2')).status).toBe(200)
    expect((await from('203.0.113.1')).status).toBe(429)
  })

  test('buckets by environment after key resolution and skips when there is none', async () => {
    const deps = createTestDeps()
    const key = 'tula_pk_dev_publishable0000000000000000000'
    deps.apiKeys.insert(sha256Hex(key), {
      id: 'pk1',
      kind: 'publishable',
      projectId: 'p1',
      environmentId: 'e1',
      revokedAt: null,
    })
    const app = createApp(deps)
    const limit = rateLimit({ name: 'env', limit: 1, window: '1m', key: byEnvironment })
    app.get('/test/keyed', publishableKey(), limit, (c) => c.text('ok'))
    app.get('/test/open', limit, (c) => c.text('ok'))
    const keyed = () => app.request('/test/keyed', { headers: { [PUBLISHABLE_KEY_HEADER]: key } })
    expect((await keyed()).status).toBe(200)
    expect((await keyed()).status).toBe(429)
    expect((await app.request('/test/open')).status).toBe(200)
    expect((await app.request('/test/open')).status).toBe(200)
  })
})
