import { describe, expect, test } from 'bun:test'
import type { MemoryDiagnostics } from '~/adapters/memory/diagnostics'
import { ServiceUnavailableError } from '~/exceptions'
import { createApp } from '~/index'
import { sha256Hex } from '~/lib/crypto'
import { INSTANCE_RATE_LIMIT } from '~/middleware/instance-admin'
import { createTestDeps, TEST_CONFIG, type TestDeps } from '~/testing'
import { InstanceDiagnosticsSchema } from './schema'

const TOKEN = 'k3Zr8vQ1nP5xW7bT2mY9cF4hJ6dL0sAg'
const PATH = '/v1/instance/diagnostics'

function withToken(overrides: Partial<TestDeps> = {}): TestDeps {
  return createTestDeps({
    config: { ...TEST_CONFIG, instanceAdminTokenHash: sha256Hex(TOKEN) },
    ...overrides,
  })
}

function bearer(token: string) {
  return { headers: { authorization: `Bearer ${token}` } }
}

describe('GET /v1/instance/diagnostics', () => {
  test('without TULA_ADMIN_TOKEN the route does not exist, whatever is presented', async () => {
    const app = createApp(createTestDeps())
    const unknown = await app.request('/v1/instance/nothing-here')
    for (const init of [undefined, bearer(TOKEN), bearer('')]) {
      const res = await app.request(PATH, init)
      expect(res.status).toBe(404)
      // The same answer as a path that was never routed.
      expect(await res.json()).toEqual(await unknown.clone().json())
    }
  })

  test('a missing token and a wrong one get the same 401', async () => {
    const app = createApp(withToken())
    const answers: unknown[] = []
    for (const init of [
      undefined,
      bearer('wrong-token-wrong-token-wrong-token'),
      bearer(TOKEN.slice(0, -1)),
      bearer(`${TOKEN}x`),
      { headers: { authorization: `Basic ${TOKEN}` } },
      { headers: { authorization: TOKEN } },
    ]) {
      const res = await app.request(PATH, init)
      expect(res.status).toBe(401)
      const body = (await res.json()) as { code: string }
      expect(body.code).toBe('auth.invalid_key')
      answers.push(body)
    }
    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1)
  })

  test('a secret key is not an admin token', async () => {
    const res = await createApp(withToken()).request(PATH, bearer('tula_sk_dev_abcdefghijklmnop'))
    expect(res.status).toBe(401)
  })

  test('the right token gets the checks, in the contract’s shape', async () => {
    const res = await createApp(withToken()).request(PATH, bearer(TOKEN))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = InstanceDiagnosticsSchema.parse(await res.json())
    expect(body.checks.map((check) => check.id)).toContain('database')
    expect(body.publicUrl).toBe(TEST_CONFIG.publicUrl)
  })

  test('no probe runs for a request that is not authorized', async () => {
    const deps = withToken()
    let ran = 0
    ;(deps.diagnostics as MemoryDiagnostics).smtp = async () => {
      ran += 1
    }
    await createApp(deps).request(PATH, bearer('wrong-token-wrong-token-wrong-token'))
    expect(ran).toBe(0)
  })

  test('is rate limited per IP, wrong guesses included', async () => {
    const app = createApp(withToken())
    for (let index = 0; index < INSTANCE_RATE_LIMIT; index += 1) {
      const res = await app.request(PATH, bearer('wrong-token-wrong-token-wrong-token'))
      expect(res.status).toBe(401)
    }
    const limited = await app.request(PATH, bearer(TOKEN))
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBeTruthy()
  })

  test('refuses when the rate limiter cannot count', async () => {
    const deps = withToken({
      rateLimiter: {
        hit: async () => {
          throw new ServiceUnavailableError()
        },
      } as unknown as TestDeps['rateLimiter'],
    })
    const res = await createApp(deps).request(PATH, bearer(TOKEN))
    expect(res.status).toBe(503)
    expect(((await res.json()) as { code: string }).code).toBe('service.unavailable')
  })

  test('a failing dependency’s own words never reach the answer', async () => {
    const deps = withToken()
    const diagnostics = deps.diagnostics as MemoryDiagnostics
    diagnostics.database = async () => {
      throw new Error('password authentication failed: postgres://tula_api:CANARY-pw@db:5432/tula')
    }
    diagnostics.smtp = async () => {
      throw new Error('CANARY smtp://user:CANARY-pw@relay:587')
    }
    diagnostics.redis = async () => {
      throw new Error('CANARY redis://:CANARY-pw@cache:6379')
    }
    const res = await createApp(deps).request(PATH, bearer(TOKEN))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain('CANARY')
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain('postgres://')
    const failed = (JSON.parse(text) as { checks: { id: string; status: string }[] }).checks
      .filter((check) => check.status === 'fail')
      .map((check) => check.id)
    expect(failed).toEqual(['database', 'smtp', 'redis'])
  })
})
