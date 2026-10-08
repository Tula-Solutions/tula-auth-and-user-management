import { beforeEach, describe, expect, test } from 'bun:test'
import type { FlowAttempt, OAuthProviderSettings, OAuthStart } from '@tula/contract'
import { MICROSOFT_CONSUMER_TENANT_ID } from '~/adapters/oauth/microsoft'
import { mockOAuthProviders } from '~/adapters/oauth/mock'
import { createApp } from '~/index'
import * as Audit from '~/modules/audit/service'
import * as Notices from '~/modules/notice/service'
import { MOCK_MICROSOFT_TENANT_ID } from '~/modules/oauth/dev-router'
import { createTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'

// Sign in with Microsoft, from the admin routes to a session: the credentials' `tenant`, the
// account's identity (tenant id + object id) and the verified-domain rule, through the mock
// provider and the real callback, ticket and exchange (ADR 0026).

const PK = 'tula_pk_dev_publishable0000000000000000000'
const SK = 'tula_sk_dev_secret000000000000000000000000'
const REDIRECT = 'http://localhost:5174/oauth/callback'
const CONTOSO = 'aaaabbbb-0000-cccc-1111-dddd2222eeee'
const FABRIKAM = 'bbbbcccc-1111-dddd-2222-eeee3333ffff'
const OBJECT_ID = '00aa11bb-22cc-33dd-44ee-55ff66aa77bb'
const EMAIL = 'maya@northline.app'

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

const configure = (body: Record<string, unknown>) =>
  admin('PUT', '/oauth-providers/microsoft', {
    clientId: 'mock-client',
    clientSecret: 'mock-secret',
    ...body,
  })

async function start() {
  const res = await app.request('/v1/client/sign-ins/oauth', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tula-publishable-key': PK,
      'x-tula-client': 'ios',
    },
    body: JSON.stringify({ provider: 'microsoft', redirectUrl: REDIRECT }),
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
async function signIn(fields: Record<string, string>) {
  const started = await start()
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

async function microsoftSubjects(email: string): Promise<string[]> {
  const user = await deps.users.findByEmail(TEST_TENANT.environmentId, email)
  const identities = await deps.users.listIdentities(TEST_TENANT.environmentId, user?.id ?? '')
  return identities.filter((entry) => entry.provider === 'microsoft').map((entry) => entry.subject)
}

describe('the credentials', () => {
  test.each(['common', 'organizations', 'consumers', CONTOSO])(
    'are saved with the tenant %s, which a read returns and no secret with it',
    async (tenant) => {
      const res = await configure({ tenant })
      expect(res.status).toBe(200)
      const saved = (await res.json()) as OAuthProviderSettings
      expect(saved).toMatchObject({
        provider: 'microsoft',
        configured: true,
        enabled: true,
        clientId: 'mock-client',
        tenant,
        teamId: null,
        keyId: null,
        callbackUrl: `${deps.config.publicUrl}/v1/oauth/callback/microsoft`,
      })
      const list = await (await admin('GET', '/oauth-providers')).text()
      expect(list).toContain(`"tenant":"${tenant}"`)
      expect(list).not.toContain('mock-secret')
    }
  )

  test('a tenant id is stored lower-cased', async () => {
    const res = await configure({ tenant: ` ${CONTOSO.toUpperCase()} ` })
    expect(((await res.json()) as OAuthProviderSettings).tenant).toBe(CONTOSO)
  })

  test.each([
    ['no tenant', {}],
    ['a domain name', { tenant: 'contoso.onmicrosoft.com' }],
    ['an empty tenant', { tenant: '' }],
    ['a path', { tenant: 'common/../evil' }],
    ['a GUID in braces', { tenant: `{${CONTOSO}}` }],
    ['Apple’s team id', { tenant: 'common', teamId: 'TEAM123456' }],
    ['a private key', { tenant: 'common', privateKey: 'x' }],
  ])('are refused with %s, and nothing is stored', async (_name, body) => {
    const res = await configure(body)
    expect(res.status).toBe(422)
    expect(await deps.oauthProviders.find(TEST_TENANT.environmentId, 'microsoft')).toBeNull()
  })

  test.each(['google', 'github'] as const)('%s takes no tenant', async (provider) => {
    const res = await admin('PUT', `/oauth-providers/${provider}`, {
      clientId: 'id',
      clientSecret: 'secret',
      tenant: 'common',
    })
    expect(res.status).toBe(422)
    expect(await res.text()).toContain('tenant is not used by this provider')
  })

  test('every other provider reads a null tenant', async () => {
    const { data } = (await (await admin('GET', '/oauth-providers')).json()) as {
      data: OAuthProviderSettings[]
    }
    expect(data.map((entry) => [entry.provider, entry.tenant])).toEqual([
      ['google', null],
      ['github', null],
      ['apple', null],
      ['microsoft', null],
    ])
  })

  test('the audit entry names what changed, the tenant among it, and holds no value', async () => {
    await configure({ tenant: CONTOSO })
    await configure({ tenant: 'common', clientSecret: undefined })
    expect(deps.activityLog.entries.map((entry) => [entry.type, entry.data])).toEqual([
      [
        'oauth_provider.updated',
        {
          provider: 'microsoft',
          changed: ['clientId', 'secret', 'tenant', 'enabled'],
          created: true,
        },
      ],
      ['oauth_provider.updated', { provider: 'microsoft', changed: ['tenant'] }],
    ])
    const log = JSON.stringify(deps.activityLog.entries)
    expect(log).not.toContain(CONTOSO)
    expect(log).not.toContain('mock-secret')
  })

  test('the tenant is not sealed with the secret: it is read without opening anything', async () => {
    await configure({ tenant: CONTOSO })
    const record = await deps.oauthProviders.find(TEST_TENANT.environmentId, 'microsoft')
    expect(record?.config).toEqual({ tenant: CONTOSO })
    expect(record?.secret).not.toContain('mock-secret')
  })
})

describe('Microsoft is a first factor like the others', () => {
  test('a sign-in start and the client config offer it once enabled', async () => {
    await configure({ tenant: 'common' })
    const res = await app.request('/v1/client/sign-ins', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tula-publishable-key': PK,
        'x-tula-client': 'ios',
      },
      body: JSON.stringify({ identifier: EMAIL }),
    })
    expect(((await res.json()) as FlowAttempt).step).toEqual({
      status: 'needs_first_factor',
      strategies: ['password', 'oauth_microsoft'],
    })
    const config = await app.request('/v1/client/config', {
      headers: { 'x-tula-publishable-key': PK },
    })
    expect(((await config.json()) as { signIn: unknown }).signIn).toEqual({
      methods: ['password'],
      oauth: ['microsoft'],
    })
  })

  test('the attempt offers only oauth_microsoft', async () => {
    await configure({ tenant: 'common' })
    expect((await start()).attempt.step).toEqual({
      status: 'needs_first_factor',
      strategies: ['oauth_microsoft'],
    })
  })
})

describe('the account and its address, through the mock provider', () => {
  test('with the verified-domain claim: a sign-up, identified by tenant id and object id', async () => {
    await configure({ tenant: 'common' })
    expect(await signIn({ email: EMAIL, tenant_id: CONTOSO, object_id: OBJECT_ID })).toEqual({
      status: 'complete',
      code: undefined,
    })
    expect(await microsoftSubjects(EMAIL)).toEqual([`${CONTOSO}:${OBJECT_ID}`])
    expect(deps.activityLog.entries.find((entry) => entry.type === 'user.created')?.data).toEqual({
      method: 'oauth_microsoft',
      emailVerified: true,
      passwordless: true,
    })
  })

  test('signing in again is the same account, whatever address Microsoft now reports', async () => {
    await configure({ tenant: 'common' })
    await signIn({ email: EMAIL, tenant_id: CONTOSO, object_id: OBJECT_ID })
    expect(
      await signIn({
        email: 'renamed@contoso.example',
        tenant_id: CONTOSO,
        object_id: OBJECT_ID,
        unverified: '1',
      })
    ).toMatchObject({ status: 'complete' })
    expect(await deps.users.findByEmail(TEST_TENANT.environmentId, 'renamed@contoso.example')).toBe(
      null
    )
  })

  test('the same object id in another tenant is another account, not the first one', async () => {
    await configure({ tenant: 'common' })
    await signIn({ email: EMAIL, tenant_id: CONTOSO, object_id: OBJECT_ID })
    // Another tenant's administrator gives an account of theirs the same object id and the
    // victim's address. Without the claim it is refused; it never reaches the first account.
    expect(
      await signIn({ email: EMAIL, tenant_id: FABRIKAM, object_id: OBJECT_ID, unverified: '1' })
    ).toMatchObject({ code: 'oauth.email_unverified' })
    expect(await microsoftSubjects(EMAIL)).toEqual([`${CONTOSO}:${OBJECT_ID}`])
  })

  test('without the claim an address a tenant administrator typed links to nobody and creates nobody', async () => {
    await configure({ tenant: 'common' })
    // The victim: a Tula account whose address is verified.
    const victim = deps.ids.next()
    await deps.users.create(
      {
        id: victim,
        projectId: TEST_TENANT.projectId,
        environmentId: TEST_TENANT.environmentId,
        email: EMAIL,
        emailNormalized: EMAIL,
        emailVerifiedAt: deps.clock.now(),
        firstName: null,
        lastName: null,
        createdAt: deps.clock.now(),
        identityId: deps.ids.next(),
        credentialId: deps.ids.next(),
        passwordHash: '$argon2id$hash',
      },
      Audit.none('fixture')
    )
    const attacker = { tenant_id: FABRIKAM, object_id: OBJECT_ID, unverified: '1' }
    expect(await signIn({ email: EMAIL, ...attacker })).toMatchObject({
      code: 'oauth.email_unverified',
    })
    // The same answer for an address nobody has: nothing is revealed.
    expect(await signIn({ email: 'nobody@northline.app', ...attacker })).toMatchObject({
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

  test('with the claim, and the Tula address verified too, the account is linked', async () => {
    await configure({ tenant: 'common' })
    const owner = deps.ids.next()
    await deps.users.create(
      {
        id: owner,
        projectId: TEST_TENANT.projectId,
        environmentId: TEST_TENANT.environmentId,
        email: EMAIL,
        emailNormalized: EMAIL,
        emailVerifiedAt: deps.clock.now(),
        firstName: null,
        lastName: null,
        createdAt: deps.clock.now(),
        identityId: deps.ids.next(),
        credentialId: deps.ids.next(),
        passwordHash: '$argon2id$hash',
      },
      Audit.none('fixture')
    )
    expect(await signIn({ email: EMAIL, tenant_id: CONTOSO, object_id: OBJECT_ID })).toMatchObject({
      status: 'complete',
    })
    expect(await microsoftSubjects(EMAIL)).toEqual([`${CONTOSO}:${OBJECT_ID}`])
    expect(deps.activityLog.entries.map((entry) => entry.type)).toContain('user.identity_linked')
  })

  test('no address at all is refused as the other providers’ is', async () => {
    await configure({ tenant: 'common' })
    expect(await signIn({ email: '', tenant_id: CONTOSO, object_id: OBJECT_ID })).toMatchObject({
      code: 'oauth.email_missing',
    })
  })
})

describe('which tenant may sign in, through the mock provider', () => {
  test.each([
    ['common', CONTOSO, true],
    ['common', MICROSOFT_CONSUMER_TENANT_ID, true],
    ['organizations', CONTOSO, true],
    ['organizations', MICROSOFT_CONSUMER_TENANT_ID, false],
    ['consumers', MICROSOFT_CONSUMER_TENANT_ID, true],
    ['consumers', CONTOSO, false],
    [CONTOSO, CONTOSO, true],
    [CONTOSO, FABRIKAM, false],
  ])('configured %s, an account of %s → accepted: %p', async (tenant, tenantId, accepted) => {
    await configure({ tenant })
    const outcome = await signIn({ email: EMAIL, tenant_id: tenantId, object_id: OBJECT_ID })
    expect(outcome).toEqual(
      accepted ? { status: 'complete', code: undefined } : { callbackError: 'oauth.provider_error' }
    )
    expect((await deps.users.findByEmail(TEST_TENANT.environmentId, EMAIL)) !== null).toBe(accepted)
  })
})

describe('the mock consent page for Microsoft', () => {
  test.each([
    ['common', MOCK_MICROSOFT_TENANT_ID],
    ['organizations', MOCK_MICROSOFT_TENANT_ID],
    ['consumers', MICROSOFT_CONSUMER_TENANT_ID],
    [CONTOSO, CONTOSO],
  ])(
    'with the tenant %s it asks for a tenant id, an object id and the claim, and offers %s',
    async (tenant, offered) => {
      await configure({ tenant })
      const { authorizationUrl } = await start()
      const url = new URL(authorizationUrl)
      expect(url.searchParams.get('code_challenge_method')).toBe('S256')
      const html = await (await app.request(pathOf(authorizationUrl))).text()
      expect(html).toContain('Mock Microsoft sign-in')
      expect(html).toContain(`name="tenant_id" type="text" autocomplete="off" value="${offered}"`)
      expect(html).toContain('name="object_id"')
      expect(html).toContain('xms_edov')
      expect(html).not.toContain('name="subject"')
      // And an account made with nothing but an address is in the offered tenant.
      expect(await signIn({ email: EMAIL })).toMatchObject({ status: 'complete' })
      const [subject] = await microsoftSubjects(EMAIL)
      expect(subject).toMatch(new RegExp(`^${offered}:[0-9a-f-]{36}$`))
    }
  )

  test('the object id derived from an address is the same the next time', async () => {
    await configure({ tenant: 'common' })
    await signIn({ email: EMAIL })
    const first = await microsoftSubjects(EMAIL)
    await signIn({ email: EMAIL })
    expect(await microsoftSubjects(EMAIL)).toEqual(first)
  })

  test.each([
    ['a tenant id that is not a GUID', { tenant_id: 'contoso.onmicrosoft.com' }],
    ['an object id that is not a GUID', { object_id: 'maya' }],
    ['a tenant value that is not one', { tenant: 'evil/..' }],
  ])('%s is not a valid request', async (_name, fields) => {
    await configure({ tenant: 'common' })
    expect(await signIn({ email: EMAIL, ...fields })).toEqual({ consent: 400 })
  })

  test('the code is exchanged only with the PKCE verifier of the attempt that asked', async () => {
    await configure({ tenant: 'common' })
    const mine = await start()
    const theirs = await start()
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
