import { describe, expect, test } from 'bun:test'
import { createApp } from '~/index'
import { createTestDeps, type TestDeps } from '~/testing'

/** H-020: the SSO mock IdP signs anybody in as anybody, so it answers this machine only. */
function mockApp(config: Partial<TestDeps['config']> = {}) {
  const deps = createTestDeps()
  deps.config = { ...deps.config, oauthMock: true, ...config }
  return createApp(deps)
}

const PATHS = ['/.well-known/openid-configuration', '/jwks', '/saml/metadata', '/saml/sso']

const HOSTILE: [string, string][] = [
  ['loopback as a prefix of another name', '127.0.0.1.evil.com'],
  ['user information before loopback', 'user@localhost'],
  ['an empty one', ''],
]

describe('the SSO mock IdP and its Host (H-020)', () => {
  test.each(HOSTILE)('refuses %s on every route', async (_name, host) => {
    const app = mockApp()
    for (const path of PATHS) {
      const res = await app.request(`/v1/dev/sso${path}`, { headers: { host } })
      expect(res.status).toBe(403)
    }
  })

  test('answers localhost', async () => {
    const res = await mockApp().request('/v1/dev/sso/jwks', { headers: { host: 'localhost:3003' } })
    expect(res.status).toBe(200)
  })

  test.each([
    ['dev', { tier: 'dev' as const }],
    ['prod', { tier: 'prod' as const }],
    ['the flag off', { oauthMock: false }],
  ])('is not mounted when %s', async (_name, config) => {
    const app = mockApp(config)
    for (const path of PATHS) {
      const res = await app.request(`/v1/dev/sso${path}`, { headers: { host: 'localhost:3003' } })
      expect(res.status).toBe(404)
    }
  })
})
