import { beforeEach, describe, expect, test } from 'bun:test'
import type { FlowAttempt, OAuthStart } from '@tula/contract'
import { mockOAuthProviders } from '~/adapters/oauth/mock'
import { createApp } from '~/index'
import { createTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'

const PK = 'tula_pk_dev_publishable0000000000000000000'
const SK = 'tula_sk_dev_secret000000000000000000000000'
const REDIRECT = 'http://localhost:5174/oauth/callback'

let deps: TestDeps
let app: ReturnType<typeof createApp>

/** An app wired the way `container.ts` wires it with `OAUTH_MOCK_PROVIDER=true`. */
async function mockApp(config: Partial<TestDeps['config']> = {}) {
  deps = createTestDeps()
  deps.config = { ...deps.config, oauthMock: true, ...config }
  Object.assign(deps, {
    oauth: mockOAuthProviders({
      secretBox: deps.secretBox,
      clock: deps.clock,
      publicUrl: deps.config.publicUrl,
    }),
  })
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  await seedApiKey(deps, PK)
  await seedApiKey(deps, SK)
  app = createApp(deps)
  const res = await app.request('/v1/admin/oauth-providers/google', {
    method: 'PUT',
    headers: { authorization: `Bearer ${SK}`, 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'mock-client', clientSecret: 'mock-secret' }),
  })
  expect(res.status).toBe(200)
}

beforeEach(() => mockApp())

async function start() {
  const res = await app.request('/v1/client/sign-ins/oauth', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tula-publishable-key': PK,
      'x-tula-client': 'ios',
    },
    body: JSON.stringify({ provider: 'google', redirectUrl: REDIRECT }),
  })
  return (await res.json()) as OAuthStart
}

const pathOf = (url: string) => url.slice(new URL(url).origin.length)

function consent(authorizationUrl: string, fields: Record<string, string>) {
  return app.request('/v1/dev/oauth/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      ...Object.fromEntries(new URL(authorizationUrl).searchParams),
      ...fields,
    }),
  })
}

describe('the mock provider’s consent page', () => {
  test('shows a form that posts back the request’s parameters, escaped, and is not cacheable', async () => {
    const started = await start()
    const res = await app.request(pathOf(started.authorizationUrl))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    const html = await res.text()
    expect(html).toContain('Development only')
    expect(html).toContain('name="state"')
    expect(html).toContain('action="/v1/dev/oauth/authorize"')
  })

  test('refuses any redirect URI but this API’s own callback: it is not an open redirector', async () => {
    const started = await start()
    const url = new URL(started.authorizationUrl)
    url.searchParams.set('redirect_uri', 'https://evil.test/cb"><script>alert(1)</script>')
    const page = await app.request(pathOf(url.toString()))
    expect(page.status).toBe(400)
    expect(await page.text()).not.toContain('evil.test')
    const posted = await consent(url.toString(), { email: 'maya@northline.app' })
    expect(posted.status).toBe(400)
    expect(posted.headers.get('location')).toBeNull()
    expect((await app.request('/v1/dev/oauth/authorize?provider=twitch')).status).toBe(400)
    expect((await consent(started.authorizationUrl, {})).status).toBe(400)
  })

  test('the whole sign-in runs through the real callback, ticket and exchange', async () => {
    const started = await start()
    const consented = await consent(started.authorizationUrl, {
      email: 'Maya@Northline.app',
      given_name: 'Maya',
    })
    expect(consented.status).toBe(302)
    const callback = await app.request(pathOf(consented.headers.get('location') as string))
    expect(callback.status).toBe(303)
    const fragment = new URLSearchParams((callback.headers.get('location') as string).split('#')[1])
    const res = await app.request('/v1/client/sign-ins/oauth/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tula-publishable-key': PK },
      body: JSON.stringify({
        ticket: fragment.get('tula_ticket'),
        attemptId: fragment.get('tula_attempt'),
        binding: started.binding,
      }),
    })
    expect(((await res.json()) as FlowAttempt).step.status).toBe('complete')
    const user = await deps.users.findByEmail(TEST_TENANT.environmentId, 'maya@northline.app')
    expect(user).toMatchObject({ firstName: 'Maya' })
    // The subject is derived from the address, so the same address is the same account again.
    const identities = await deps.users.listIdentities(TEST_TENANT.environmentId, user?.id ?? '')
    expect(identities[0]?.subject).toMatch(/^mock-[0-9a-f]{24}$/)
  })

  test('“unverified”, an explicit account id and “cancel” reach the callback as a provider would send them', async () => {
    const unverified = await start()
    const first = await consent(unverified.authorizationUrl, {
      email: 'maya@northline.app',
      unverified: '1',
      subject: 'acct-9',
    })
    const back = await app.request(pathOf(first.headers.get('location') as string))
    const ticket = new URLSearchParams((back.headers.get('location') as string).split('#')[1])
    const res = await app.request('/v1/client/sign-ins/oauth/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tula-publishable-key': PK },
      body: JSON.stringify({
        ticket: ticket.get('tula_ticket'),
        attemptId: ticket.get('tula_attempt'),
        binding: unverified.binding,
      }),
    })
    expect(((await res.json()) as { code: string }).code).toBe('oauth.email_unverified')

    const cancelled = await start()
    const denied = await consent(cancelled.authorizationUrl, { action: 'deny' })
    const answer = await app.request(pathOf(denied.headers.get('location') as string))
    expect(answer.headers.get('location')).toContain('#tula_error=oauth.access_denied')
  })

  test('a form that cannot be read is refused', async () => {
    const res = await app.request('/v1/dev/oauth/authorize', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      body: 'nope',
    })
    expect(res.status).toBe(400)
  })
})

const AUDIENCE = '1234567890-webclient.apps.googleusercontent.com'

function mint(body: unknown, headers: Record<string, string> = { host: 'localhost:3003' }) {
  return app.request('/v1/dev/oauth/id-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('the mock provider’s ID tokens (ADR 0045)', () => {
  const asked = {
    provider: 'google',
    audience: AUDIENCE,
    nonce: 'n-1',
    email: 'Maya@Northline.app',
  }

  test('mints a token the mock’s own verifier accepts, for the nonce and the audience asked for', async () => {
    const res = await mint({ ...asked, givenName: 'Maya' })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const { idToken } = (await res.json()) as { idToken: string }
    const profile = await deps.oauth.google.verifyIdToken?.(
      { clientId: AUDIENCE, clientSecret: 'x' },
      { idToken, audiences: [AUDIENCE], nonce: 'n-1' }
    )
    expect(profile).toMatchObject({
      email: 'Maya@Northline.app',
      emailVerified: true,
      givenName: 'Maya',
    })
    // Derived from the address, as the consent page's is: the same account every time.
    expect(profile?.subject).toMatch(/^mock-[0-9a-f]{24}$/)
  })

  test.each([
    ['another nonce', { nonce: 'n-2' }, {}],
    ['no nonce', { nonce: undefined }, {}],
    ['another audience', { audience: 'other.apps.googleusercontent.com' }, {}],
    [
      'an authorized party that is not accepted',
      { authorizedParty: 'app.apps.googleusercontent.com' },
      {},
    ],
    ['expired', { expired: true }, {}],
  ])('what it is asked to get wrong, it gets wrong: %s', async (_name, change) => {
    const res = await mint({ ...asked, ...change })
    const { idToken } = (await res.json()) as { idToken: string }
    await expect(
      deps.oauth.google.verifyIdToken?.(
        { clientId: AUDIENCE, clientSecret: 'x' },
        { idToken, audiences: [AUDIENCE], nonce: 'n-1' }
      )
    ).rejects.toMatchObject({ failure: 'invalid_token' })
  })

  test('“unverified” and an account id of its own reach the profile', async () => {
    const res = await mint({ ...asked, unverified: true, subject: 'acct-9' })
    const { idToken } = (await res.json()) as { idToken: string }
    const profile = await deps.oauth.google.verifyIdToken?.(
      { clientId: AUDIENCE, clientSecret: 'x' },
      { idToken, audiences: [AUDIENCE], nonce: 'n-1' }
    )
    expect(profile).toMatchObject({ subject: 'acct-9', emailVerified: false })
  })

  test.each([
    ['no Host', {}],
    ['a Host that is not loopback', { host: 'api.example.com' }],
    ['a rebinding page’s Host', { host: 'attacker.test:3003' }],
    ['a loopback look-alike', { host: 'localhost.attacker.test' }],
  ])('refused with an empty 403 for %s', async (_name, headers) => {
    const res = await mint(asked, headers)
    expect(res.status).toBe(403)
    expect(await res.text()).toBe('')
  })

  test.each([
    ['an Origin, even this API’s own', { origin: 'http://localhost:3003' }],
    ['a foreign Origin', { origin: 'https://evil.example' }],
    ['a cross-site request', { 'sec-fetch-site': 'cross-site' }],
    ['a same-site request', { 'sec-fetch-site': 'same-site' }],
  ])('refused for a browser’s page: %s', async (_name, headers) => {
    const res = await mint(asked, { host: 'localhost:3003', ...headers })
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain('idToken')
  })

  test.each([
    ['not JSON', 'nope'],
    ['a provider with no ID-token exchange', { ...asked, provider: 'github' }],
    ['no audience', { provider: 'google', email: 'a@b.test' }],
    ['neither an address nor an account id', { provider: 'google', audience: AUDIENCE }],
    ['a key it does not know', { ...asked, clientSecret: 'x' }],
  ])('a request it cannot read is a 400: %s', async (_name, body) => {
    const res = await mint(body)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid request' })
  })

  test.each([
    ['the flag is off', { oauthMock: false }],
    ['the tier is not local', { tier: 'dev' as const }],
    ['the tier is production', { tier: 'prod' as const }],
  ])('is not mounted when %s', async (_name, config) => {
    await mockApp(config)
    const res = await mint(asked)
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('idToken')
  })
})

describe('the mock provider exists only where it was asked for', () => {
  test.each([
    ['the flag is off', { oauthMock: false }],
    ['the tier is not local', { tier: 'dev' as const }],
    ['the tier is production', { tier: 'prod' as const }],
  ])('the routes are not mounted when %s', async (_name, config) => {
    await mockApp(config)
    for (const method of ['GET', 'POST']) {
      const res = await app.request('/v1/dev/oauth/authorize?provider=google', { method })
      expect(res.status).toBe(404)
      expect(await res.text()).not.toContain('Mock')
    }
  })

  test('it is not part of the OpenAPI document', async () => {
    const doc = (await (await app.request('/v1/openapi.json')).json()) as {
      paths: Record<string, unknown>
    }
    expect(Object.keys(doc.paths).filter((path) => path.includes('/dev/'))).toEqual([])
  })
})
