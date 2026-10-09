import { beforeEach, describe, expect, test } from 'bun:test'
import type { FlowAttempt, OAuthProviderSettings, OAuthStart } from '@tula/contract'
import { mockOAuthProviders } from '~/adapters/oauth/mock'
import { createApp } from '~/index'
import * as Audit from '~/modules/audit/service'
import * as Notices from '~/modules/notice/service'
import * as OAuth from '~/modules/oauth/service'
import { createTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'

// Sign in with Discord and with LinkedIn, from the admin routes to a session: the
// credentials, the account's identity and the verified rule, through the mock provider and
// the real callback, ticket and exchange (ADR 0026). What each real adapter takes from its
// provider is in `adapters/oauth/{discord,linkedin}.test.ts`.

const PK = 'tula_pk_dev_publishable0000000000000000000'
const SK = 'tula_sk_dev_secret000000000000000000000000'
const REDIRECT = 'http://localhost:5174/oauth/callback'
const EMAIL = 'maya@northline.app'

type Provider = 'discord' | 'linkedin'
/** Each provider, its name on the consent page, and an account id in the provider's own shape. */
const PROVIDERS: [Provider, string, string][] = [
  ['discord', 'Discord', '80351110224678912'],
  ['linkedin', 'LinkedIn', '782bbtaQ'],
]

let deps: TestDeps
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  deps = createTestDeps()
  deps.config = { ...deps.config, oauthMock: true }
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
})

function admin(method: string, path: string, body?: unknown) {
  return app.request(`/v1/admin${path}`, {
    method,
    headers: { authorization: `Bearer ${SK}`, 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
}

const configure = (provider: Provider, body: Record<string, unknown> = {}) =>
  admin('PUT', `/oauth-providers/${provider}`, {
    clientId: 'mock-client',
    clientSecret: 'mock-secret',
    ...body,
  })

async function start(provider: Provider) {
  const res = await app.request('/v1/client/sign-ins/oauth', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tula-publishable-key': PK,
      'x-tula-client': 'ios',
    },
    body: JSON.stringify({ provider, redirectUrl: REDIRECT }),
  })
  expect(res.status).toBe(200)
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

/** One round trip: the consent form, the callback, the exchange. */
async function signIn(provider: Provider, fields: Record<string, string>) {
  const started = await start(provider)
  const consented = await consent(started.authorizationUrl, fields)
  if (consented.status !== 302) {
    return { consent: consented.status }
  }
  const callback = await app.request(pathOf(consented.headers.get('location') as string))
  const fragment = new URLSearchParams((callback.headers.get('location') as string).split('#')[1])
  if (fragment.get('tula_error')) {
    return { callbackError: fragment.get('tula_error') }
  }
  const res = await app.request('/v1/client/sign-ins/oauth/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tula-publishable-key': PK },
    body: JSON.stringify({
      ticket: fragment.get('tula_ticket'),
      attemptId: fragment.get('tula_attempt'),
      binding: started.binding,
    }),
  })
  const body = (await res.json()) as FlowAttempt & { code?: string }
  return { status: body.step?.status, code: body.code }
}

async function subjectsOf(provider: Provider, email: string): Promise<string[]> {
  const user = await deps.users.findByEmail(TEST_TENANT.environmentId, email)
  const identities = await deps.users.listIdentities(TEST_TENANT.environmentId, user?.id ?? '')
  return identities.filter((entry) => entry.provider === provider).map((entry) => entry.subject)
}

/** A Tula account with a password, its address verified or not. */
async function account(verified: boolean): Promise<string> {
  const id = deps.ids.next()
  await deps.users.create(
    {
      id,
      projectId: TEST_TENANT.projectId,
      environmentId: TEST_TENANT.environmentId,
      email: EMAIL,
      emailNormalized: EMAIL,
      emailVerifiedAt: verified ? deps.clock.now() : null,
      firstName: null,
      lastName: null,
      createdAt: deps.clock.now(),
      identityId: deps.ids.next(),
      credentialId: deps.ids.next(),
      passwordHash: '$argon2id$hash',
    },
    Audit.none('fixture')
  )
  return id
}

describe.each(PROVIDERS)('%s', (provider, name, accountId) => {
  describe('the credentials', () => {
    test('are a client id and a secret, which no read returns', async () => {
      const res = await configure(provider)
      expect(res.status).toBe(200)
      expect((await res.json()) as OAuthProviderSettings).toEqual({
        provider,
        configured: true,
        enabled: true,
        clientId: 'mock-client',
        teamId: null,
        keyId: null,
        tenant: null,
        callbackUrl: `${deps.config.publicUrl}/v1/oauth/callback/${provider}`,
        updatedAt: expect.any(String),
      })
      expect(await (await admin('GET', '/oauth-providers')).text()).not.toContain('mock-secret')
    })

    test.each([
      ['no secret', { clientSecret: undefined }, 'clientSecret is required'],
      ['Microsoft’s tenant', { tenant: 'common' }, 'tenant is not used by this provider'],
      ['Apple’s team id', { teamId: 'TEAM123456' }, 'teamId is not used by this provider'],
      ['Apple’s key id', { keyId: 'KEY1234567' }, 'keyId is not used by this provider'],
      ['a private key', { privateKey: 'x' }, 'privateKey is not used by this provider'],
    ])('are refused with %s, and nothing is stored', async (_name, body, message) => {
      const res = await configure(provider, body)
      expect(res.status).toBe(422)
      expect(await res.text()).toContain(message)
      expect(await deps.oauthProviders.find(TEST_TENANT.environmentId, provider)).toBeNull()
    })

    test('the secret is stored sealed, bound to this provider and this environment', async () => {
      await configure(provider)
      const record = await deps.oauthProviders.find(TEST_TENANT.environmentId, provider)
      expect(record?.config).toEqual({})
      expect(record?.secret).not.toContain('mock-secret')
      expect(await OAuth.credentials(deps, TEST_TENANT, provider)).toEqual({
        clientId: 'mock-client',
        clientSecret: 'mock-secret',
      })
      // The same ciphertext under another provider's row does not open: that provider is
      // unusable, it does not sign anyone in with this one's secret.
      const other = provider === 'discord' ? 'linkedin' : 'discord'
      await configure(other)
      const copied = await deps.oauthProviders.find(TEST_TENANT.environmentId, other)
      await deps.oauthProviders.upsert(
        { ...(copied as NonNullable<typeof copied>), secret: record?.secret as string },
        Audit.none('fixture')
      )
      await expect(OAuth.credentials(deps, TEST_TENANT, other)).rejects.toMatchObject({
        code: 'auth.method_disabled',
      })
    })

    test('the audit entry names what changed and holds no value', async () => {
      await configure(provider)
      await configure(provider, { clientSecret: undefined, enabled: false, clientId: 'another' })
      expect(deps.activityLog.entries.map((entry) => [entry.type, entry.data])).toEqual([
        [
          'oauth_provider.updated',
          { provider, changed: ['clientId', 'secret', 'enabled'], created: true },
        ],
        ['oauth_provider.updated', { provider, changed: ['clientId', 'enabled'] }],
      ])
      const log = JSON.stringify(deps.activityLog.entries)
      expect(log).not.toContain('mock-secret')
      expect(log).not.toContain('mock-client')
    })
  })

  describe('is a first factor like the others', () => {
    test('a sign-in start and the client config offer it once enabled, and not before', async () => {
      const config = async () => {
        const res = await app.request('/v1/client/config', {
          headers: { 'x-tula-publishable-key': PK },
        })
        return (await res.json()) as { signIn: { oauth: string[] } }
      }
      expect((await config()).signIn.oauth).toEqual([])
      await configure(provider)
      expect((await config()).signIn.oauth).toEqual([provider])
      const started = await start(provider)
      expect(started.attempt.step).toMatchObject({
        status: 'needs_first_factor',
        strategies: [`oauth_${provider}`],
      })
    })

    test('switched off, a start is refused as any method that is off', async () => {
      await configure('discord')
      await configure('linkedin')
      await configure(provider, { clientSecret: undefined, enabled: false })
      const res = await app.request('/v1/client/sign-ins/oauth', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tula-publishable-key': PK },
        body: JSON.stringify({ provider, redirectUrl: REDIRECT }),
      })
      expect(((await res.json()) as { code: string }).code).toBe('auth.method_disabled')
    })
  })

  describe('the account and its address, through the mock provider', () => {
    test('a verified address signs up, identified by the provider’s id for the account', async () => {
      await configure(provider)
      expect(await signIn(provider, { email: EMAIL, subject: accountId })).toEqual({
        status: 'complete',
        code: undefined,
      })
      expect(await subjectsOf(provider, EMAIL)).toEqual([accountId])
      expect(deps.activityLog.entries.find((entry) => entry.type === 'user.created')?.data).toEqual(
        { method: `oauth_${provider}`, emailVerified: true, passwordless: true }
      )
    })

    test('signing in again is the same account, whatever address the provider now reports', async () => {
      await configure(provider)
      await signIn(provider, { email: EMAIL, subject: accountId })
      expect(
        await signIn(provider, {
          email: 'renamed@elsewhere.test',
          subject: accountId,
          unverified: '1',
        })
      ).toMatchObject({ status: 'complete' })
      expect(
        await deps.users.findByEmail(TEST_TENANT.environmentId, 'renamed@elsewhere.test')
      ).toBe(null)
      expect(await subjectsOf(provider, EMAIL)).toEqual([accountId])
    })

    test('an unverified address links to nobody and creates nobody, with and without an account', async () => {
      await configure(provider)
      const victim = await account(true)
      const attacker = { subject: accountId, unverified: '1' }
      expect(await signIn(provider, { email: EMAIL, ...attacker })).toMatchObject({
        code: 'oauth.email_unverified',
      })
      // The same answer for an address nobody has: nothing is revealed.
      expect(await signIn(provider, { email: 'nobody@northline.app', ...attacker })).toMatchObject({
        code: 'oauth.email_unverified',
      })
      expect(await deps.users.listIdentities(TEST_TENANT.environmentId, victim)).toEqual([])
      expect(await deps.users.findByEmail(TEST_TENANT.environmentId, 'nobody@northline.app')).toBe(
        null
      )
      expect(
        await deps.sessions.listActiveByUser(TEST_TENANT.environmentId, victim, deps.clock.now())
      ).toEqual([])
      await Notices.settled()
      expect(deps.mailer.outbox).toEqual([])
    })

    test('a verified address, verified in Tula too, is linked and the owner is told', async () => {
      await configure(provider)
      const owner = await account(true)
      expect(await signIn(provider, { email: EMAIL, subject: accountId })).toMatchObject({
        status: 'complete',
      })
      expect(await subjectsOf(provider, EMAIL)).toEqual([accountId])
      expect(
        deps.activityLog.entries.find((entry) => entry.type === 'user.identity_linked')
      ).toMatchObject({ target: { id: owner }, data: { provider, method: 'auto' } })
      await Notices.settled()
      const notice = deps.mailer.outbox.at(-1)
      expect(notice?.to).toBe(EMAIL)
      expect(`${notice?.subject} ${notice?.text}`).toContain(name)
    })

    test('a verified address whose Tula account is unverified is refused, and nothing is connected', async () => {
      await configure(provider)
      const owner = await account(false)
      expect(await signIn(provider, { email: EMAIL, subject: accountId })).toMatchObject({
        code: 'oauth.account_exists',
      })
      expect(await deps.users.listIdentities(TEST_TENANT.environmentId, owner)).toEqual([])
    })

    test('no address at all is refused as the other providers’ is', async () => {
      await configure(provider)
      expect(await signIn(provider, { email: '', subject: accountId })).toMatchObject({
        code: 'oauth.email_missing',
      })
    })
  })

  describe('the mock consent page', () => {
    test('asks for the account id, the address and whether it is verified', async () => {
      await configure(provider)
      const { authorizationUrl } = await start(provider)
      const html = await (await app.request(pathOf(authorizationUrl))).text()
      expect(html).toContain(`Mock ${name} sign-in`)
      expect(html).toContain('name="subject"')
      expect(html).toContain('name="email"')
      expect(html).toContain('name="unverified"')
      expect(html).not.toContain('name="tenant_id"')
    })

    test('the account id derived from an address is the same the next time', async () => {
      await configure(provider)
      await signIn(provider, { email: EMAIL })
      const first = await subjectsOf(provider, EMAIL)
      expect(first).toHaveLength(1)
      await signIn(provider, { email: EMAIL })
      expect(await subjectsOf(provider, EMAIL)).toEqual(first)
    })

    test('the code is exchanged only with the PKCE verifier of the attempt that asked', async () => {
      await configure(provider)
      const mine = await start(provider)
      const theirs = await start(provider)
      expect(new URL(mine.authorizationUrl).searchParams.get('code_challenge_method')).toBe('S256')
      // A code minted for one attempt's challenge, returned under the other attempt's state.
      const consented = await consent(mine.authorizationUrl, {
        email: EMAIL,
        state: new URL(theirs.authorizationUrl).searchParams.get('state') as string,
      })
      const callback = await app.request(pathOf(consented.headers.get('location') as string))
      expect(callback.headers.get('location')).toContain('#tula_error=oauth.provider_error')
      expect(await deps.users.findByEmail(TEST_TENANT.environmentId, EMAIL)).toBeNull()
    })
  })
})

describe('the mock stands in for Discord’s ids', () => {
  test('an account id derived from an address is a snowflake, as Discord’s are', async () => {
    await configure('discord')
    await signIn('discord', { email: EMAIL })
    expect((await subjectsOf('discord', EMAIL))[0]).toMatch(/^[1-9][0-9]{0,19}$/)
  })

  test.each([
    ['a username', 'nelly'],
    ['a number with a leading zero', '080351110224678912'],
    ['twenty-one digits', '123456789012345678901'],
  ])('%s for the account id is refused, as the real adapter refuses it', async (_name, subject) => {
    await configure('discord')
    expect(await signIn('discord', { email: EMAIL, subject })).toEqual({
      callbackError: 'oauth.provider_error',
    })
    expect(await deps.users.findByEmail(TEST_TENANT.environmentId, EMAIL)).toBeNull()
  })

  test('LinkedIn’s ids are opaque: any text is one', async () => {
    await configure('linkedin')
    expect(await signIn('linkedin', { email: EMAIL, subject: 'nelly' })).toMatchObject({
      status: 'complete',
    })
  })
})
