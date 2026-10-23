import { beforeEach, describe, expect, test } from 'bun:test'
import {
  type AccessTokenClaims,
  type ActiveOrganization,
  type CurrentUser,
  DEFAULT_ENVIRONMENT_SETTINGS,
  EVENT_SCHEMAS,
  type FlowAttempt,
  type HybridSessionTokens as SessionTokens,
  type UserOrganization,
  type UserOrganizationList,
} from '@tula-tech/contract'
import { decodeJwt } from 'jose'
import { createApp } from '~/index'
import { MY_ORGANIZATIONS_WRITE_RATE_LIMIT } from '~/modules/organization/me-router'
import * as Organizations from '~/modules/organization/service'
import * as Users from '~/modules/user/service'
import { createTestDeps, seedApiKey, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'

const PK = 'tula_pk_dev_publishable0000000000000000000'
const SK = 'tula_sk_dev_secret000000000000000000000000'
const PK_B = 'tula_pk_dev_publishableb000000000000000000'
const TENANT_B = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.productionEnvironmentId,
}
const TENANT_A = { ...TEST_TENANT, apiKeyId: 'key_1' }
const PASSWORD = 'correct horse battery staple'
const ORIGIN = 'https://app.northline.test'
const UNKNOWN = '00000000-0000-7000-8000-00000000dead'

let deps: TestDeps
let app: ReturnType<typeof createApp>
let revision = 0

function configure(
  organizations: Record<string, unknown> = {},
  environmentId: string = TEST_TENANT.environmentId,
  sessions: Record<string, unknown> = {}
) {
  revision += 1
  deps.environmentSettings.seed(environmentId, {
    revision,
    settings: {
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      signIn: {
        methods: {
          password: { enabled: true },
          emailCode: { enabled: true },
          emailLink: { enabled: false },
          passkey: { enabled: false },
          smsCode: { enabled: false },
        },
      },
      urls: { allowedOrigins: [ORIGIN], allowedRedirectUrls: [] },
      sessions: { ...DEFAULT_ENVIRONMENT_SETTINGS.sessions, ...sessions },
      organizations: {
        ...DEFAULT_ENVIRONMENT_SETTINGS.organizations,
        enabled: true,
        allowUserCreated: true,
        ...organizations,
      },
    } as never,
  })
}

beforeEach(async () => {
  deps = createTestDeps()
  revision = 0
  for (const [id, kind] of [
    [TEST_TENANT.environmentId, 'development'],
    [TENANT_B.environmentId, 'production'],
  ] as const) {
    deps.environments.add({
      id,
      projectId: TEST_TENANT.projectId,
      kind,
      createdAt: deps.clock.now(),
    })
  }
  await seedApiKey(deps, PK)
  await seedApiKey(deps, SK)
  await seedApiKey(deps, PK_B, TENANT_B)
  configure()
  configure({}, TENANT_B.environmentId)
  app = createApp(deps)
})

interface CallOptions {
  token?: string
  key?: string | null
  client?: string
  origin?: string | null
  cookie?: string
  secret?: string
  ip?: string
}

async function call(method: string, path: string, body?: unknown, options: CallOptions = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-tula-client': options.client ?? 'ios',
  }
  if (options.origin !== null) {
    headers.origin = options.origin ?? ORIGIN
  }
  if (options.key !== null) {
    headers['x-tula-publishable-key'] = options.key ?? PK
  }
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`
  }
  if (options.cookie) {
    headers.cookie = options.cookie
  }
  if (options.secret) {
    headers['x-tula-attempt'] = options.secret
  }
  if (options.ip) {
    headers['x-forwarded-for'] = options.ip
  }
  return app.request(`/v1/client${path}`, {
    method,
    headers,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
}

const json = async <T>(res: Response) => (await res.json()) as T
const codeOf = async (res: Response) => (await json<{ code: string }>(res)).code
const emailedCode = () =>
  /^(\d{6}) /.exec(
    deps.mailer.outbox.findLast((mail) => /^\d{6} /.test(mail.subject))?.subject ?? ''
  )?.[1] ?? ''

async function signUp(
  email = 'maya@northline.app',
  key: string = PK
): Promise<SessionTokens & { userId: string }> {
  const started = await json<FlowAttempt>(
    await call('POST', '/sign-ups', { email, password: PASSWORD }, { key })
  )
  const done = await json<FlowAttempt>(
    await call(
      'POST',
      `/sign-ups/${started.id}/verify-email`,
      { code: emailedCode() },
      { key, secret: started.attemptSecret }
    )
  )
  const session = done.session as SessionTokens
  const user = await json<CurrentUser>(
    await call('GET', '/me', undefined, { token: session.accessToken, key })
  )
  return { ...session, userId: user.id }
}

const list = (token: string, query = '', options: CallOptions = {}) =>
  call('GET', `/me/organizations${query}`, undefined, { token, ...options })
const create = (token: string, body: unknown, options: CallOptions = {}) =>
  call('POST', '/me/organizations', body, { token, ...options })
const activate = (token: string, organizationId: string | null, options: CallOptions = {}) =>
  call('PUT', '/me/organizations/active', { organizationId }, { token, ...options })

const claimsOf = (token: string | undefined) => decodeJwt<AccessTokenClaims>(token ?? '')

/** An organization created by the operator, with these members. */
async function organization(slug: string, members: Array<[userId: string, role: string]>) {
  const org = await Organizations.create(deps, TENANT_A, { name: 'Acme Corp', slug }, TEST_ACTOR)
  for (const [userId, role] of members) {
    await Organizations.addMember(deps, TENANT_A, org.id, { userId, role }, TEST_ACTOR)
  }
  return org
}

const organizationTypes = () =>
  deps.activityLog.entries.filter((entry) => entry.type.startsWith('organization'))

describe('organizations switched off', () => {
  test.each([
    ['GET', '', undefined],
    ['POST', '', { name: 'Acme', slug: 'acme' }],
    ['PUT', '/active', { organizationId: UNKNOWN }],
    ['PUT', '/active', { organizationId: null }],
  ])('%s %s answers organization.disabled and touches nothing', async (method, path, body) => {
    const maya = await signUp()
    configure({ enabled: false })
    const before = organizationTypes().length
    const res = await call(method, `/me/organizations${path}`, body, { token: maya.accessToken })
    expect(res.status).toBe(403)
    expect(await codeOf(res)).toBe('organization.disabled')
    expect(organizationTypes()).toHaveLength(before)
    expect(
      (await deps.sessions.findById(TEST_TENANT.environmentId, maya.sessionId))
        ?.activeOrganizationId
    ).toBeNull()
  })

  test('an environment that never configured organizations says the same', async () => {
    const maya = await signUp()
    deps.environmentSettings.seed(TEST_TENANT.environmentId, {
      revision: 99,
      settings: { ...DEFAULT_ENVIRONMENT_SETTINGS },
    })
    expect(await codeOf(await list(maya.accessToken))).toBe('organization.disabled')
  })
})

describe('who may call', () => {
  test.each([
    ['GET', ''],
    ['POST', ''],
    ['PUT', '/active'],
  ])('%s %s needs a session', async (method, path) => {
    const res = await call(method, `/me/organizations${path}`, { name: 'Acme', slug: 'acme' })
    expect(res.status).toBe(401)
  })

  test.each([
    ['GET', ''],
    ['POST', ''],
    ['PUT', '/active'],
  ])('%s %s needs a publishable key', async (method, path) => {
    const maya = await signUp()
    const res = await call(
      method,
      `/me/organizations${path}`,
      {},
      {
        token: maya.accessToken,
        key: null,
      }
    )
    expect([401, 403]).toContain(res.status)
  })

  test('a token of another environment is no session here', async () => {
    const maya = await signUp()
    const res = await list(maya.accessToken, '', { key: PK_B })
    expect(res.status).toBe(401)
  })

  test('a secret key is not a session', async () => {
    const res = await list(SK)
    expect(res.status).toBe(401)
  })

  test('a revoked session is refused before anything is read', async () => {
    const maya = await signUp()
    await call(
      'POST',
      '/sessions/sign-out',
      { refreshToken: maya.refreshToken },
      { token: maya.accessToken }
    )
    expect((await list(maya.accessToken)).status).toBe(401)
    expect((await create(maya.accessToken, { name: 'Acme', slug: 'acme' })).status).toBe(401)
    expect(organizationTypes()).toHaveLength(0)
  })

  test('a banned user’s session is over, and so is every organization route', async () => {
    const maya = await signUp()
    const acme = await organization('acme', [[maya.userId, 'admin']])
    await Users.ban(deps, TENANT_A, maya.userId, TEST_ACTOR)
    for (const res of [
      await list(maya.accessToken),
      await activate(maya.accessToken, acme.id),
      await create(maya.accessToken, { name: 'Acme', slug: 'again' }),
    ]) {
      expect(res.status).toBe(401)
    }
  })
})

describe('listing', () => {
  test('lists my organizations with my role and its permissions, and nobody else’s', async () => {
    const maya = await signUp()
    const sam = await signUp('sam@northline.app')
    const acme = await organization('acme', [
      [maya.userId, 'admin'],
      [sam.userId, 'member'],
    ])
    const globex = await organization('globex', [[maya.userId, 'member']])
    await organization('initech', [[sam.userId, 'admin']])
    const res = await list(maya.accessToken)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await json<UserOrganizationList>(res)
    expect(body.activeOrganizationId).toBeNull()
    expect(body.meta.totalCount).toBe(2)
    expect(body.data.map((one) => [one.id, one.slug, one.role])).toEqual([
      [acme.id, 'acme', 'admin'],
      [globex.id, 'globex', 'member'],
    ])
    expect(body.data[0]?.permissions).toContain('org:sys:memberships:manage')
    expect(body.data[1]?.permissions).toEqual(['org:sys:memberships:read'])
    // Nothing of anyone else: no creator, no member.
    expect(Object.keys(body.data[0] ?? {}).sort()).toEqual([
      'createdAt',
      'id',
      'name',
      'permissions',
      'role',
      'slug',
    ])
    expect(JSON.stringify(body)).not.toContain(sam.userId)
  })

  test('pages', async () => {
    const maya = await signUp()
    for (const slug of ['acme', 'globex', 'initech']) {
      await organization(slug, [[maya.userId, 'member']])
      deps.clock.advance('1s')
    }
    const first = await json<UserOrganizationList>(await list(maya.accessToken, '?size=2'))
    const second = await json<UserOrganizationList>(await list(maya.accessToken, '?size=2&page=2'))
    expect(first.data.map((one) => one.slug)).toEqual(['acme', 'globex'])
    expect(second.data.map((one) => one.slug)).toEqual(['initech'])
    expect(first.meta).toMatchObject({ totalCount: 3, totalPages: 2, perPage: 2 })
    expect((await list(maya.accessToken, '?size=0')).status).toBe(422)
  })

  test('says which organization the session acts in, and drops one the user has left', async () => {
    const maya = await signUp()
    const sam = await signUp('sam@northline.app')
    const acme = await organization('acme', [
      [maya.userId, 'admin'],
      [sam.userId, 'admin'],
    ])
    await activate(maya.accessToken, acme.id)
    expect(
      (await json<UserOrganizationList>(await list(maya.accessToken))).activeOrganizationId
    ).toBe(acme.id)
    await Organizations.removeMember(deps, TENANT_A, acme.id, maya.userId, TEST_ACTOR)
    const after = await json<UserOrganizationList>(await list(maya.accessToken))
    expect(after.activeOrganizationId).toBeNull()
    expect(after.data).toEqual([])
  })

  test('another environment’s organizations are not listed', async () => {
    const maya = await signUp()
    await organization('acme', [[maya.userId, 'admin']])
    const mayaB = await signUp('maya@northline.app', PK_B)
    const body = await json<UserOrganizationList>(await list(mayaB.accessToken, '', { key: PK_B }))
    expect(body.data).toEqual([])
  })
})

describe('creating', () => {
  test('is not allowed unless the environment allows it', async () => {
    const maya = await signUp()
    configure({ allowUserCreated: false })
    const res = await create(maya.accessToken, { name: 'Acme', slug: 'acme' })
    expect(res.status).toBe(403)
    expect(await codeOf(res)).toBe('organization.creation_disabled')
    expect(organizationTypes()).toHaveLength(0)
    expect((await list(maya.accessToken).then(json<UserOrganizationList>)).data).toEqual([])
  })

  test('makes the creator its first member with the creator role, and records both', async () => {
    const maya = await signUp()
    const res = await create(maya.accessToken, { name: ' Acme Corp ', slug: 'acme' })
    expect(res.status).toBe(201)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const created = await json<UserOrganization>(res)
    expect(created).toMatchObject({ name: 'Acme Corp', slug: 'acme', role: 'admin' })
    expect(created.permissions).toContain('org:sys:memberships:manage')
    expect((await json<UserOrganizationList>(await list(maya.accessToken))).data[0]?.id).toBe(
      created.id
    )
    const entries = organizationTypes()
    expect(entries.map((entry) => entry.type)).toEqual([
      'organization.created',
      'organization_membership.added',
    ])
    for (const entry of entries) {
      expect(entry.actor).toEqual({ type: 'user', id: maya.userId })
      expect(EVENT_SCHEMAS[entry.type as 'organization.created']).toBeDefined()
    }
    expect(JSON.stringify(entries)).not.toContain('Acme')
    // The admin API sees it, created by the user.
    const admin = await app.request(`/v1/admin/organizations/${created.id}`, {
      headers: { authorization: `Bearer ${SK}` },
    })
    expect(await json<{ createdBy: string }>(admin)).toMatchObject({ createdBy: maya.userId })
  })

  test('does not switch the session to it', async () => {
    const maya = await signUp()
    await create(maya.accessToken, { name: 'Acme', slug: 'acme' })
    expect(
      (await deps.sessions.findById(TEST_TENANT.environmentId, maya.sessionId))
        ?.activeOrganizationId
    ).toBeNull()
  })

  test('takes the environment’s creator role', async () => {
    const maya = await signUp()
    configure({ creatorRole: 'member' })
    const created = await json<UserOrganization>(
      await create(maya.accessToken, { name: 'Acme', slug: 'acme' })
    )
    expect(created.role).toBe('member')
  })

  test('answers role_unknown for a creator role that does not exist, creating nothing', async () => {
    const maya = await signUp()
    configure({ creatorRole: 'owner' })
    const res = await create(maya.accessToken, { name: 'Acme', slug: 'acme' })
    expect(res.status).toBe(422)
    expect(await codeOf(res)).toBe('organization.role_unknown')
    expect(organizationTypes()).toHaveLength(0)
  })

  test('refuses a slug that is taken, whoever took it, and records nothing', async () => {
    const maya = await signUp()
    const sam = await signUp('sam@northline.app')
    await create(sam.accessToken, { name: 'Sam’s', slug: 'acme' })
    const before = organizationTypes().length
    const res = await create(maya.accessToken, { name: 'Acme', slug: 'acme' })
    expect(res.status).toBe(409)
    expect(await codeOf(res)).toBe('organization.slug_taken')
    expect(organizationTypes()).toHaveLength(before)
    expect((await json<UserOrganizationList>(await list(maya.accessToken))).data).toEqual([])
  })

  test.each([
    ['no name', { slug: 'acme' }],
    ['a slug with capitals', { name: 'Acme', slug: 'Acme' }],
    ['an unknown field', { name: 'Acme', slug: 'acme', createdBy: 'someone' }],
    ['a role', { name: 'Acme', slug: 'acme', role: 'admin' }],
  ])('refuses %s', async (_name, body) => {
    const maya = await signUp()
    expect((await create(maya.accessToken, body)).status).toBe(422)
    expect(organizationTypes()).toHaveLength(0)
  })

  describe('up to the limit a user may create', () => {
    test('refuses the one over it, with nothing written, and only for that user', async () => {
      const maya = await signUp()
      const sam = await signUp('sam@northline.app')
      configure({ maxCreatedPerUser: 2 })
      for (const slug of ['one', 'two']) {
        expect((await create(maya.accessToken, { name: 'Acme', slug })).status).toBe(201)
      }
      const before = organizationTypes().length
      const res = await create(maya.accessToken, { name: 'Acme', slug: 'three' })
      expect(res.status).toBe(403)
      expect(await codeOf(res)).toBe('organization.limit_reached')
      expect(organizationTypes()).toHaveLength(before)
      expect((await create(sam.accessToken, { name: 'Sam’s', slug: 'sams' })).status).toBe(201)
    })

    test('counts what the user created, not what they belong to', async () => {
      const maya = await signUp()
      configure({ maxCreatedPerUser: 1 })
      // Joining others’ organizations (and the operator’s) is not creating.
      await organization('theirs', [[maya.userId, 'admin']])
      expect((await create(maya.accessToken, { name: 'Mine', slug: 'mine' })).status).toBe(201)
      expect(await codeOf(await create(maya.accessToken, { name: 'More', slug: 'more' }))).toBe(
        'organization.limit_reached'
      )
    })

    test('keeps counting an organization the user has since left', async () => {
      const maya = await signUp()
      const sam = await signUp('sam@northline.app')
      configure({ maxCreatedPerUser: 1 })
      const mine = await json<UserOrganization>(
        await create(maya.accessToken, { name: 'Mine', slug: 'mine' })
      )
      await Organizations.addMember(
        deps,
        TENANT_A,
        mine.id,
        { userId: sam.userId, role: 'admin' },
        TEST_ACTOR
      )
      await Organizations.removeMember(deps, TENANT_A, mine.id, maya.userId, TEST_ACTOR)
      expect(await codeOf(await create(maya.accessToken, { name: 'More', slug: 'more' }))).toBe(
        'organization.limit_reached'
      )
    })

    test('has none when the environment sets none', async () => {
      const maya = await signUp()
      configure({ maxCreatedPerUser: null })
      for (const slug of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']) {
        expect((await create(maya.accessToken, { name: 'Acme', slug })).status).toBe(201)
      }
    })

    test('holds against simultaneous requests', async () => {
      const maya = await signUp()
      configure({ maxCreatedPerUser: 2 })
      const answers = await Promise.all(
        ['a1', 'a2', 'a3', 'a4', 'a5'].map((slug) =>
          create(maya.accessToken, { name: 'Acme', slug })
        )
      )
      expect(answers.filter((res) => res.status === 201)).toHaveLength(2)
      expect(await Promise.all(answers.filter((res) => res.status !== 201).map(codeOf))).toEqual([
        'organization.limit_reached',
        'organization.limit_reached',
        'organization.limit_reached',
      ])
      expect((await json<UserOrganizationList>(await list(maya.accessToken))).meta.totalCount).toBe(
        2
      )
    })
  })
})

describe('setting the active organization', () => {
  test('answers a new access token with the claims, and keeps the session', async () => {
    const maya = await signUp()
    const acme = await organization('acme', [[maya.userId, 'admin']])
    const res = await activate(maya.accessToken, acme.id)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await json<ActiveOrganization>(res)
    expect(body).toMatchObject({ sessionId: maya.sessionId, organizationId: acme.id })
    expect(body).not.toHaveProperty('refreshToken')
    expect(claimsOf(body.accessToken)).toMatchObject({
      org_id: acme.id,
      org_role: 'admin',
      sid: maya.sessionId,
    })
    expect(claimsOf(body.accessToken).org_perms).toContain('org:sys:memberships:manage')
    // The token works.
    const me = await call('GET', '/me', undefined, { token: body.accessToken })
    expect(me.status).toBe(200)
  })

  test('the claims survive a refresh, and are gone at the next one after the user is removed', async () => {
    const maya = await signUp()
    const sam = await signUp('sam@northline.app')
    const acme = await organization('acme', [
      [maya.userId, 'admin'],
      [sam.userId, 'admin'],
    ])
    await activate(maya.accessToken, acme.id)
    const refresh = (token: string) =>
      call('POST', '/sessions/refresh', { refreshToken: token }, { client: 'ios' })
    const first = await json<SessionTokens>(await refresh(maya.refreshToken ?? ''))
    expect(claimsOf(first.accessToken).org_id).toBe(acme.id)
    await Organizations.removeMember(deps, TENANT_A, acme.id, maya.userId, TEST_ACTOR)
    const second = await json<SessionTokens>(await refresh(first.refreshToken ?? ''))
    expect(
      Object.keys(claimsOf(second.accessToken)).filter((name) => name.startsWith('org_'))
    ).toEqual([])
    expect(claimsOf(second.accessToken).sid).toBe(maya.sessionId)
  })

  test('clears with null', async () => {
    const maya = await signUp()
    const acme = await organization('acme', [[maya.userId, 'admin']])
    await activate(maya.accessToken, acme.id)
    const res = await activate(maya.accessToken, null)
    expect(res.status).toBe(200)
    const body = await json<ActiveOrganization>(res)
    expect(body.organizationId).toBeNull()
    expect(
      Object.keys(claimsOf(body.accessToken)).filter((name) => name.startsWith('org_'))
    ).toEqual([])
  })

  test('cannot be cleared where there is no personal account', async () => {
    const maya = await signUp()
    configure({ personalAccount: false })
    const res = await activate(maya.accessToken, null)
    expect(res.status).toBe(409)
    expect(await codeOf(res)).toBe('organization.personal_account_disabled')
  })

  test.each([
    ['not theirs', async () => (await organization('theirs', [])).id],
    ['unknown', async () => UNKNOWN],
  ])(
    'an organization that is %s is not_a_member (403), the same answer for both',
    async (_n, id) => {
      const maya = await signUp()
      const res = await activate(maya.accessToken, await id())
      expect(res.status).toBe(403)
      const body = await json<Record<string, unknown>>(res)
      expect(body).toMatchObject({ status: 403, code: 'organization.not_a_member' })
      expect(Object.keys(body).sort()).toEqual(['code', 'detail', 'status'])
    }
  )

  test('another environment’s organization is not_a_member', async () => {
    const maya = await signUp()
    const foreign = await Organizations.create(
      deps,
      TENANT_B,
      { name: 'Acme', slug: 'acme' },
      TEST_ACTOR
    )
    expect(await codeOf(await activate(maya.accessToken, foreign.id))).toBe(
      'organization.not_a_member'
    )
  })

  test.each([
    ['not an id', { organizationId: 'acme' }],
    ['no field', {}],
    ['a second field', { organizationId: null, role: 'admin' }],
  ])('refuses %s', async (_name, body) => {
    const maya = await signUp()
    const res = await call('PUT', '/me/organizations/active', body, { token: maya.accessToken })
    expect(res.status).toBe(422)
  })

  test('is recorded nowhere: choosing among memberships is not a change of who can do what', async () => {
    const maya = await signUp()
    const acme = await organization('acme', [[maya.userId, 'admin']])
    const before = deps.activityLog.entries.length
    await activate(maya.accessToken, acme.id)
    expect(deps.activityLog.entries).toHaveLength(before)
  })
})

describe('a stateful browser session', () => {
  const STATEFUL = { profiles: { web: { type: 'stateful' } } }

  /** Signs up in a browser: the session lives in a cookie and there is no token. */
  async function browser() {
    configure({}, TEST_TENANT.environmentId, STATEFUL)
    const started = await json<FlowAttempt>(
      await call(
        'POST',
        '/sign-ups',
        { email: 'maya@northline.app', password: PASSWORD },
        { client: 'web' }
      )
    )
    const done = await call(
      'POST',
      `/sign-ups/${started.id}/verify-email`,
      { code: emailedCode() },
      { client: 'web', secret: started.attemptSecret }
    )
    const cookie = (done.headers.getSetCookie() as string[])
      .map((line) => line.split(';')[0])
      .join('; ')
    return { cookie, flow: await json<FlowAttempt>(done) }
  }

  test('switches by its cookie and carries the claims at the next request, with no token', async () => {
    const { cookie, flow } = await browser()
    expect(cookie).not.toBe('')
    const userId = (
      await json<CurrentUser>(await call('GET', '/me', undefined, { client: 'web', cookie }))
    ).id
    const acme = await organization('acme', [[userId, 'admin']])
    const res = await call(
      'PUT',
      '/me/organizations/active',
      { organizationId: acme.id },
      { client: 'web', cookie }
    )
    expect(res.status).toBe(200)
    expect(await json<ActiveOrganization>(res)).toEqual({
      sessionId: (flow.session as { sessionId: string }).sessionId,
      organizationId: acme.id,
    })
    const listed = await json<UserOrganizationList>(
      await call('GET', '/me/organizations', undefined, { client: 'web', cookie })
    )
    expect(listed.activeOrganizationId).toBe(acme.id)
  })

  test('a request from an origin the environment does not allow is not signed in, and changes nothing', async () => {
    const { cookie } = await browser()
    const userId = (
      await json<CurrentUser>(await call('GET', '/me', undefined, { client: 'web', cookie }))
    ).id
    const acme = await organization('acme', [[userId, 'admin']])
    const before = organizationTypes().length
    for (const [method, path, body] of [
      ['PUT', '/me/organizations/active', { organizationId: acme.id }],
      ['POST', '/me/organizations', { name: 'Mine', slug: 'mine' }],
    ] as const) {
      for (const origin of ['https://evil.test', null]) {
        const res = await call(method, path, body, { client: 'web', cookie, origin })
        expect(res.status).toBe(401)
        expect(res.headers.getSetCookie()).toEqual([])
      }
    }
    const read = await call('GET', '/me/organizations', undefined, {
      client: 'web',
      cookie,
      origin: 'https://evil.test',
    })
    expect(read.status).toBe(401)
    expect(organizationTypes()).toHaveLength(before)
    const ok = await json<UserOrganizationList>(
      await call('GET', '/me/organizations', undefined, { client: 'web', cookie })
    )
    expect(ok.activeOrganizationId).toBeNull()
  })
})

describe('rate limits', () => {
  test.each([
    ['POST', '/me/organizations', { name: 'Acme', slug: 'acme' }],
    ['PUT', '/me/organizations/active', { organizationId: null }],
  ])('%s %s is limited per IP', async (method, path, body) => {
    const maya = await signUp()
    let last = 0
    for (let sent = 0; sent <= MY_ORGANIZATIONS_WRITE_RATE_LIMIT; sent++) {
      last = (
        await call(method, path, sent === 0 ? body : { ...body, slug: `a${sent}` }, {
          token: maya.accessToken,
          ip: '203.0.113.9',
        })
      ).status
    }
    expect(last).toBe(429)
  })
})
