import { beforeEach, describe, expect, test } from 'bun:test'
import { PASSWORD_POLICY_PRESETS, PasswordPolicySchema } from '@tula/contract'
import { createApp } from '~/index'
import { CLIENT_RATE_LIMIT } from '~/middleware/rate-limit'
import { createTestDeps, seedApiKey, TEST_CONFIG, type TestDeps } from '~/testing'

const PK = 'tula_pk_dev_publishable0000000000000000000'
const SK = 'tula_sk_dev_admin000000000000000000000000000000'
const PATH = '/v1/client/password-policy'
let deps: TestDeps
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  deps = createTestDeps({
    config: { ...TEST_CONFIG, passwordPolicy: PASSWORD_POLICY_PRESETS.strict },
  })
  await seedApiKey(deps, PK)
  await seedApiKey(deps, SK)
  app = createApp(deps)
})

const get = (headers: Record<string, string> = {}) => app.request(PATH, { headers })

describe('GET /v1/client/password-policy', () => {
  test("returns the environment's policy for the live checklist", async () => {
    const res = await get({ 'x-tula-publishable-key': PK })
    expect(res.status).toBe(200)
    const body = PasswordPolicySchema.parse(await res.json())
    expect(body).toEqual(PASSWORD_POLICY_PRESETS.strict)
  })

  test('is cacheable per key for a few minutes', async () => {
    const res = await get({ 'x-tula-publishable-key': PK })
    expect(res.headers.get('cache-control')).toBe('private, max-age=300')
    expect(res.headers.get('vary')?.toLowerCase()).toContain('x-tula-publishable-key')
  })

  test.each([
    ['no key', {}],
    ['an unknown key', { 'x-tula-publishable-key': `${PK.slice(0, -1)}1` }],
    ['a secret key in the publishable header', { 'x-tula-publishable-key': SK }],
    ['a secret key as a bearer token', { authorization: `Bearer ${SK}` }],
  ])('rejects %s with auth.invalid_key', async (_name, headers) => {
    const res = await get(headers)
    expect(res.status).toBe(401)
    expect(((await res.json()) as { code: string }).code).toBe('auth.invalid_key')
  })

  test('counts requests per IP before resolving the key, so key guessing is limited', async () => {
    for (let i = 0; i < CLIENT_RATE_LIMIT; i++) {
      await get({ 'x-tula-publishable-key': `${PK.slice(0, -1)}1` })
    }
    const res = await get({ 'x-tula-publishable-key': PK })
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).not.toBeNull()
  })
})
