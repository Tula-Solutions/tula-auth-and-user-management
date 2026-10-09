import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { FlowAttempt, OAuthProviderSettings, OAuthStart } from '@tula/contract'
import { createMicrosoftProvider, MICROSOFT_CONSUMER_TENANT_ID } from '~/adapters/oauth/microsoft'
import { mockOAuthProviders } from '~/adapters/oauth/mock'
import { createApp } from '~/index'
import * as logger from '~/lib/logger'
import * as Audit from '~/modules/audit/service'
import * as Notices from '~/modules/notice/service'
import { MOCK_MICROSOFT_TENANT_ID } from '~/modules/oauth/dev-router'
import * as OAuth from '~/modules/oauth/service'
import * as Settings from '~/modules/settings/service'
import { OAuthProviderError } from '~/ports/oauth-provider'
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

function startRequest(redirectUrl = REDIRECT) {
  return app.request('/v1/client/sign-ins/oauth', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tula-publishable-key': PK,
      'x-tula-client': 'ios',
    },
    body: JSON.stringify({ provider: 'microsoft', redirectUrl }),
  })
}

async function start() {
  const res = await startRequest()
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
      ['discord', null],
      ['linkedin', null],
      ['x', null],
      ['facebook', null],
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

// A stored `tenant` the server cannot use (a row from before a rule, an edit in the database)
// is the provider being unavailable: said the way a provider that is off is said, and before
// anything is made.
describe('credentials the server cannot use', () => {
  /** What a start answers for a provider that is not configured at all. */
  async function refusalOfAnOffProvider(redirectUrl?: string) {
    const res = await startRequest(redirectUrl)
    return { status: res.status, body: await res.json() }
  }

  async function storeTenant(tenant: string | undefined) {
    await configure({ tenant: CONTOSO })
    const record = await deps.oauthProviders.find(TEST_TENANT.environmentId, 'microsoft')
    if (!record) {
      throw new Error('no stored provider')
    }
    await deps.oauthProviders.upsert(
      { ...record, config: tenant === undefined ? {} : { tenant } },
      Audit.none('fixture')
    )
  }

  test.each([
    ['a domain name', 'contoso.onmicrosoft.com'],
    ['a path', 'common/../consumers'],
    ['a GUID in braces', `{${CONTOSO}}`],
    ['an alias in another case', 'Common'],
    ['an empty tenant', ''],
    ['no tenant', undefined],
  ])(
    'a stored row with %s: a start is refused as a provider that is off is, and no attempt is made',
    async (_name, tenant) => {
      const charged = spyOn(deps.rateLimiter, 'hit')
      const off = await refusalOfAnOffProvider()
      expect(off.body).toMatchObject({ code: 'auth.method_disabled' })
      const chargedWhenOff = charged.mock.calls.length
      await storeTenant(tenant)
      // The real adapter: the mock puts whatever is stored into its own URL.
      Object.assign(deps, { oauth: { ...deps.oauth, microsoft: createMicrosoftProvider() } })
      const created = spyOn(deps.flowAttempts, 'create')
      const logged = spyOn(logger, 'error').mockImplementation(() => undefined)
      try {
        const before = charged.mock.calls.length
        const res = await startRequest()
        expect({ status: res.status, body: await res.json() }).toEqual(off)
        expect(created).not.toHaveBeenCalled()
        // Nothing more is counted than for a provider that is off: the environment's ceiling
        // is charged only after this refusal.
        expect(charged.mock.calls.length - before).toBe(chargedWhenOff)
        expect(logged).toHaveBeenCalledWith('stored OAuth credentials cannot be used', {
          environmentId: TEST_TENANT.environmentId,
          provider: 'microsoft',
          field: 'tenant',
        })
        if (tenant) {
          expect(JSON.stringify(logged.mock.calls)).not.toContain(tenant)
        }
      } finally {
        created.mockRestore()
        charged.mockRestore()
        logged.mockRestore()
      }
    }
  )

  test('the refusal comes before the redirect URL is judged, as for a provider that is off', async () => {
    const off = await refusalOfAnOffProvider('https://elsewhere.test/callback')
    await storeTenant('contoso.onmicrosoft.com')
    const logged = spyOn(logger, 'error').mockImplementation(() => undefined)
    try {
      const res = await startRequest('https://elsewhere.test/callback')
      expect({ status: res.status, body: await res.json() }).toEqual(off)
    } finally {
      logged.mockRestore()
    }
  })

  test('every later step of an attempt reads the same refusal', async () => {
    await storeTenant('contoso.onmicrosoft.com')
    const logged = spyOn(logger, 'error').mockImplementation(() => undefined)
    try {
      await expect(OAuth.credentials(deps, TEST_TENANT, 'microsoft')).rejects.toMatchObject({
        code: 'auth.method_disabled',
        params: { method: 'oauth_microsoft' },
      })
    } finally {
      logged.mockRestore()
    }
  })

  test('a usable tenant is not refused: an alias and a tenant id', async () => {
    for (const tenant of ['organizations', CONTOSO]) {
      await storeTenant(tenant)
      expect((await OAuth.credentials(deps, TEST_TENANT, 'microsoft')).tenant).toBe(tenant)
    }
  })

  // A row nobody can sign in through must not be what keeps an environment "open": every
  // count of the ways to sign in leaves it out, as it leaves out a provider that is off.
  describe('is not counted as a way to sign in', () => {
    const PASSWORD_OFF = { signIn: { methods: { password: { enabled: false } } } }

    async function replaceSettings(body: Record<string, unknown>) {
      const current = await admin('GET', '/settings')
      return app.request('/v1/admin/settings', {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${SK}`,
          'content-type': 'application/json',
          'if-match': current.headers.get('etag') ?? '',
        },
        body: JSON.stringify(body),
      })
    }

    const errorsOf = async (res: Response) =>
      ((await res.json()) as { errors?: { field: string; message: string }[] }).errors

    test('the password cannot be switched off when it is the only other "method": refused as with no provider', async () => {
      const without = await replaceSettings(PASSWORD_OFF)
      expect(without.status).toBe(422)
      const expected = await errorsOf(without)
      expect(expected).toMatchObject([{ field: 'signIn.methods' }])

      await storeTenant('Common')
      const res = await replaceSettings(PASSWORD_OFF)
      expect(res.status).toBe(422)
      expect(await errorsOf(res)).toEqual(expected)
    })

    test('with a usable tenant the same change is accepted', async () => {
      await storeTenant('common')
      expect((await replaceSettings(PASSWORD_OFF)).status).toBe(200)
    })

    test('another provider cannot be switched off or removed on the strength of it', async () => {
      const google = (body: Record<string, unknown>) =>
        admin('PUT', '/oauth-providers/google', { clientId: 'g', clientSecret: 's', ...body })
      expect((await google({})).status).toBe(200)
      expect((await replaceSettings(PASSWORD_OFF)).status).toBe(200)
      await storeTenant('Common')
      const disabled = await google({ enabled: false })
      expect(disabled.status).toBe(422)
      expect(await errorsOf(disabled)).toMatchObject([{ field: 'enabled' }])
      expect((await admin('DELETE', '/oauth-providers/google')).status).toBe(422)
    })

    test('an identity of it is no way to sign in, exactly as an identity of a provider that is off', async () => {
      const settings = await Settings.current(deps, TEST_TENANT)
      const left = {
        hasPassword: false,
        emailVerified: false,
        providers: ['microsoft' as const],
        passkeys: 0,
      }
      const counted = async () =>
        OAuth.canStillSignIn(settings, await OAuth.enabledProviders(deps, TEST_TENANT), left)

      await configure({ tenant: CONTOSO })
      expect(await counted()).toBe(true)
      await configure({ tenant: CONTOSO, enabled: false, clientSecret: undefined })
      expect(await OAuth.enabledProviders(deps, TEST_TENANT)).toEqual([])
      expect(await counted()).toBe(false)

      await configure({ tenant: CONTOSO, enabled: true, clientSecret: undefined })
      await storeTenant('Common')
      expect(await OAuth.enabledProviders(deps, TEST_TENANT)).toEqual([])
      expect(await counted()).toBe(false)
    })

    test('it is not offered at sign-in, and the admin list still shows the row as it is stored', async () => {
      await storeTenant('Common')
      const config = await app.request('/v1/client/config', {
        headers: { 'x-tula-publishable-key': PK },
      })
      expect(((await config.json()) as { signIn: unknown }).signIn).toEqual({
        methods: ['password'],
        oauth: [],
      })
      const { data } = (await (await admin('GET', '/oauth-providers')).json()) as {
        data: OAuthProviderSettings[]
      }
      expect(data.find((entry) => entry.provider === 'microsoft')).toMatchObject({
        configured: true,
        enabled: true,
        tenant: 'Common',
      })
    })
  })

  test('an adapter that cannot build its URL makes no attempt either', async () => {
    const off = await refusalOfAnOffProvider()
    await configure({ tenant: CONTOSO })
    const built = spyOn(deps.oauth.microsoft, 'authorizationUrl').mockImplementation(() => {
      throw new OAuthProviderError('unavailable')
    })
    const created = spyOn(deps.flowAttempts, 'create')
    const logged = spyOn(logger, 'error').mockImplementation(() => undefined)
    try {
      const res = await startRequest()
      expect({ status: res.status, body: await res.json() }).toEqual(off)
      expect(built).toHaveBeenCalledTimes(1)
      expect(created).not.toHaveBeenCalled()
    } finally {
      built.mockRestore()
      created.mockRestore()
      logged.mockRestore()
    }
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
