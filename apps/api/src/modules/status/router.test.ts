import { describe, expect, test } from 'bun:test'
import { createApp } from '~/index'
import { createTestDeps } from '~/testing'

describe('GET /v1/status', () => {
  test('returns ok without touching dependencies', async () => {
    const probe = {
      name: 'database',
      check: async () => {
        throw new Error('must not run')
      },
    }
    const res = await createApp(createTestDeps({ probes: [probe] })).request('/v1/status')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok', version: expect.any(String) })
  })
})

describe('GET /v1/ready', () => {
  test('returns 200 when dependencies are reachable', async () => {
    const deps = createTestDeps({ probes: [{ name: 'database', check: async () => {} }] })
    const res = await createApp(deps).request('/v1/ready')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ready', checks: { database: 'ok' } })
  })

  test('returns 503 without the failure reason when a dependency is down', async () => {
    const deps = createTestDeps({
      probes: [
        {
          name: 'database',
          check: async () => {
            throw new Error('password authentication failed for user "tula_api"')
          },
        },
      ],
    })
    const res = await createApp(deps).request('/v1/ready')
    expect(res.status).toBe(503)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ status: 'not_ready', checks: { database: 'fail' } })
    expect(text).not.toContain('tula_api')
  })
})

describe('rate limits', () => {
  test('readiness checks are limited per IP; liveness is not', async () => {
    const { READY_RATE_LIMIT } = await import('~/modules/status/router')
    const app = createApp(createTestDeps())
    for (let index = 0; index < READY_RATE_LIMIT; index++) {
      expect((await app.request('/v1/ready')).status).toBe(200)
    }
    const blocked = await app.request('/v1/ready')
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toMatchObject({ code: 'rate_limited' })
    expect((await app.request('/v1/status')).status).toBe(200)
  })
})
