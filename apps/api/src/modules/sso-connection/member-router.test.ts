import { beforeEach, describe, expect, test } from 'bun:test'
import {
  type CurrentUser,
  DEFAULT_ENVIRONMENT_SETTINGS,
  type FlowAttempt,
  type Organization,
  type HybridSessionTokens as SessionTokens,
  type SsoConnection,
} from '@tula-tech/contract'
import { createApp } from '~/index'
import * as Audit from '~/modules/audit/service'
import * as Organizations from '~/modules/organization/service'
import * as SsoConnections from '~/modules/sso-connection/service'
import { createTestDeps, seedApiKey, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'

const PK = 'tula_pk_dev_publishable0000000000000000000'
const SK = 'tula_sk_dev_secret000000000000000000000000'
const TENANT = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }
const PASSWORD = 'correct horse battery staple'
const ORIGIN = 'https://app.northline.test'
const SECRET = 'super-secret-value'
const REDIRECT = `${ORIGIN}/settings`

let deps: TestDeps
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  deps = createTestDeps()
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  deps.environmentSettings.seed(TEST_TENANT.environmentId, {
    revision: 1,
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
      urls: { allowedOrigins: [ORIGIN], allowedRedirectUrls: [REDIRECT] },
      organizations: {
        ...DEFAULT_ENVIRONMENT_SETTINGS.organizations,
        enabled: true,
        allowUserCreated: true,
      },
      sso: { enabled: true },
    } as never,
  })
  deps.outbound.point('idp.example.test', '93.184.216.34')
  await seedApiKey(deps, PK)
  await seedApiKey(deps, SK)
  app = createApp(deps)
})

const json = async <T>(res: Response) => (await res.json()) as T
const codeOf = async (res: Response) => (await json<{ code: string }>(res)).code

function admin(method: string, path: string, body?: unknown) {
  return app.request(`/v1/admin/${path}`, {
    method,
    headers: { authorization: `Bearer ${SK}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function client(method: string, path: string, body?: unknown, token?: string, secret?: string) {
  return app.request(`/v1/client${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-tula-client': 'ios',
      origin: ORIGIN,
      'x-tula-publishable-key': PK,
      ...(token && { authorization: `Bearer ${token}` }),
      ...(secret && { 'x-tula-attempt': secret }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
}

const emailedCode = () =>
  /^(\d{6}) /.exec(
    deps.mailer.outbox.findLast((mail) => /^\d{6} /.test(mail.subject))?.subject ?? ''
  )?.[1] ?? ''

async function signUp(email: string): Promise<SessionTokens & { userId: string }> {
  const started = await json<FlowAttempt>(
    await client('POST', '/sign-ups', { email, password: PASSWORD })
  )
  const done = await json<FlowAttempt>(
    await client(
      'POST',
      `/sign-ups/${started.id}/verify-email`,
      { code: emailedCode() },
      undefined,
      started.attemptSecret
    )
  )
  const session = done.session as SessionTokens
  const user = await json<CurrentUser>(await client('GET', '/me', undefined, session.accessToken))
  return { ...session, userId: user.id }
}

async function verified(organizationId: string, domain: string) {
  const id = Bun.randomUUIDv7()
  const none = Audit.none('fixture')
  const now = deps.clock.now()
  await deps.organizationDomains.claim(
    {
      id,
      ...TENANT,
      organizationId,
      domain,
      mode: 'suggest',
      codeHash: 'h',
      codeExpiresAt: new Date(now.getTime() + 60_000),
      at: now,
      limit: 10,
    },
    none
  )
  await deps.organizationDomains.verify(
    TENANT.environmentId,
    organizationId,
    id,
    'h',
    now,
    new Date(now.getTime() + 86_400_000),
    none
  )
}

async function makeOrg(slug: string): Promise<Organization> {
  const res = await admin('POST', 'organizations', { name: slug, slug })
  expect(res.status).toBe(201)
  return json<Organization>(res)
}

const join = (org: Organization, userId: string, role: string) =>
  Organizations.addMember(deps, TENANT, org.id, { userId, role }, TEST_ACTOR)

const body = (extra: Record<string, unknown> = {}) => ({
  protocol: 'oidc',
  name: 'Okta',
  issuer: 'https://idp.example.test',
  clientId: 'client-1',
  clientSecret: SECRET,
  domains: ['acme.test'],
  ...extra,
})

/** Acme with an admin (maya), a member (ada) and a stranger (cy); a connection in Acme and one in Other. */
async function world() {
  const maya = await signUp('maya@northline.app')
  const ada = await signUp('ada@northline.app')
  const cy = await signUp('cy@northline.app')
  const org = await makeOrg('acme')
  const other = await makeOrg('other')
  await join(org, maya.userId, 'admin')
  await join(org, ada.userId, 'member')
  await verified(org.id, 'acme.test')
  await verified(other.id, 'other.test')
  const made = await json<SsoConnection>(
    await admin('POST', 'sso-connections', { ...body(), organizationId: org.id })
  )
  const foreign = await json<SsoConnection>(
    await admin('POST', 'sso-connections', {
      ...body({ domains: ['other.test'] }),
      organizationId: other.id,
    })
  )
  return { maya, ada, cy, org, other, made, foreign }
}

const base = (org: Organization) => `/me/organizations/${org.id}/sso-connections`

describe('who may call', () => {
  test('a member without org:sys:sso:manage is refused at every route, and nothing changes', async () => {
    const { ada, org, made } = await world()
    const before = deps.activityLog.entries.length
    const calls = [
      client('GET', base(org), undefined, ada.accessToken),
      client('POST', base(org), body(), ada.accessToken),
      client('GET', `${base(org)}/${made.id}`, undefined, ada.accessToken),
      client('PATCH', `${base(org)}/${made.id}`, { name: 'x' }, ada.accessToken),
      client('DELETE', `${base(org)}/${made.id}`, undefined, ada.accessToken),
      client('POST', `${base(org)}/${made.id}/refresh-metadata`, undefined, ada.accessToken),
      client('GET', `${base(org)}/${made.id}/group-roles`, undefined, ada.accessToken),
      client('PUT', `${base(org)}/${made.id}/group-roles`, { mappings: [] }, ada.accessToken),
      client('POST', `${base(org)}/${made.id}/tests`, { redirectUrl: REDIRECT }, ada.accessToken),
      client(
        'GET',
        `${base(org)}/${made.id}/tests/${Bun.randomUUIDv7()}`,
        undefined,
        ada.accessToken
      ),
    ]
    for (const res of await Promise.all(calls)) {
      expect(res.status).toBe(403)
      expect(await codeOf(res)).toBe('organization.permission_required')
    }
    expect(deps.activityLog.entries).toHaveLength(before)
  })

  test('a stranger is not a member, at every route', async () => {
    const { cy, org, made } = await world()
    for (const [method, path] of [
      ['GET', base(org)],
      ['POST', base(org)],
      ['GET', `${base(org)}/${made.id}`],
      ['PATCH', `${base(org)}/${made.id}`],
      ['DELETE', `${base(org)}/${made.id}`],
      ['POST', `${base(org)}/${made.id}/refresh-metadata`],
      ['GET', `${base(org)}/${made.id}/group-roles`],
      ['PUT', `${base(org)}/${made.id}/group-roles`],
      ['POST', `${base(org)}/${made.id}/tests`],
      ['GET', `${base(org)}/${made.id}/tests/${Bun.randomUUIDv7()}`],
    ] as const) {
      const res = await client(
        method,
        path,
        path.endsWith('/tests')
          ? { redirectUrl: REDIRECT }
          : ({ POST: body(), PATCH: { name: 'x' } }[method as 'POST'] ?? { mappings: [] }),
        cy.accessToken
      )
      expect(await codeOf(res)).toBe('organization.not_a_member')
    }
  })

  test('every route needs a session', async () => {
    const { org, made } = await world()
    expect((await client('GET', base(org))).status).toBe(401)
    expect((await client('PATCH', `${base(org)}/${made.id}`, {})).status).toBe(401)
  })

  test('a connection of another organization is not found, whoever asks', async () => {
    const { maya, org, foreign } = await world()
    for (const [method, path] of [
      ['GET', `${base(org)}/${foreign.id}`],
      ['PATCH', `${base(org)}/${foreign.id}`],
      ['DELETE', `${base(org)}/${foreign.id}`],
      ['POST', `${base(org)}/${foreign.id}/refresh-metadata`],
      ['GET', `${base(org)}/${foreign.id}/group-roles`],
      ['PUT', `${base(org)}/${foreign.id}/group-roles`],
      ['POST', `${base(org)}/${foreign.id}/tests`],
      ['GET', `${base(org)}/${foreign.id}/tests/${Bun.randomUUIDv7()}`],
    ] as const) {
      const res = await client(
        method,
        path,
        path.endsWith('/tests')
          ? { redirectUrl: REDIRECT }
          : method === 'PATCH'
            ? { name: 'x' }
            : { mappings: [] },
        maya.accessToken
      )
      expect(await codeOf(res)).toBe('sso.connection_not_found')
    }
    expect(await deps.ssoConnections.find(TENANT.environmentId, foreign.id)).not.toBeNull()
  })
})

describe('an organization admin', () => {
  test('lists, creates for the path organization, reads and never sees the secret', async () => {
    const { maya, org } = await world()
    const created = await client(
      'POST',
      base(org),
      body({ name: 'Second', domains: [] }),
      maya.accessToken
    )
    expect(created.status).toBe(201)
    const text = await created.text()
    expect(text).not.toContain(SECRET)
    const one = JSON.parse(text) as SsoConnection
    expect(one.organizationId).toBe(org.id)
    const listed = await client('GET', base(org), undefined, maya.accessToken)
    const raw = await listed.text()
    expect(raw).not.toContain(SECRET)
    expect(JSON.parse(raw).connections).toHaveLength(2)
    expect(
      (await client('GET', `${base(org)}/${one.id}`, undefined, maya.accessToken)).status
    ).toBe(200)
  })

  test('a body cannot name another organization', async () => {
    const { maya, org, other } = await world()
    const res = await client(
      'POST',
      base(org),
      { ...body(), organizationId: other.id },
      maya.accessToken
    )
    expect(res.status).toBe(422)
  })

  test('reads and replaces the group mapping', async () => {
    const { maya, org, made } = await world()
    const put = await client(
      'PUT',
      `${base(org)}/${made.id}/group-roles`,
      { mappings: [{ group: 'eng', role: 'admin' }] },
      maya.accessToken
    )
    expect(put.status).toBe(200)
    const got = await json<{ mappings: unknown[] }>(
      await client('GET', `${base(org)}/${made.id}/group-roles`, undefined, maya.accessToken)
    )
    expect(got.mappings).toEqual([{ group: 'eng', role: 'admin' }])
  })

  test('deletes an unused connection', async () => {
    const { maya, org, made } = await world()
    expect(
      (await client('DELETE', `${base(org)}/${made.id}`, undefined, maya.accessToken)).status
    ).toBe(204)
  })

  test('cannot give a role above their own', async () => {
    const { maya, ada, org, made } = await world()
    const role = await admin('POST', 'organization-roles', {
      key: 'sso_only',
      name: 'SSO only',
      permissions: ['org:sys:sso:manage'],
    })
    expect(role.status).toBe(201)
    await Organizations.changeMemberRole(
      deps,
      TENANT,
      org.id,
      ada.userId,
      { role: 'sso_only' },
      TEST_ACTOR
    )
    const mapped = await client(
      'PUT',
      `${base(org)}/${made.id}/group-roles`,
      { mappings: [{ group: 'eng', role: 'admin' }] },
      ada.accessToken
    )
    expect(await codeOf(mapped)).toBe('organization.role_not_assignable')
    const patched = await client(
      'PATCH',
      `${base(org)}/${made.id}`,
      { defaultRole: 'admin' },
      ada.accessToken
    )
    expect(await codeOf(patched)).toBe('organization.role_not_assignable')
    const created = await client('POST', base(org), body({ defaultRole: 'admin' }), ada.accessToken)
    expect(await codeOf(created)).toBe('organization.role_not_assignable')
    expect(maya.userId).not.toBe(ada.userId)
  })
})

describe('weakenings need a recent authentication', () => {
  async function aged(session: SessionTokens): Promise<string> {
    deps.clock.advance('11m')
    const refreshed = await client('POST', '/sessions/refresh', {
      refreshToken: session.refreshToken,
    })
    return (await json<{ accessToken: string }>(refreshed)).accessToken
  }

  test.each([
    ['trustIdpMfa', { trustIdpMfa: true }],
    ['breakGlassRole', { breakGlassRole: 'admin' }],
  ])('%s from a stale session is refused and nothing changes', async (_name, change) => {
    const { maya, org, made } = await world()
    const token = await aged(maya)
    const before = deps.activityLog.entries.length
    const res = await client('PATCH', `${base(org)}/${made.id}`, change, token)
    expect(res.status).toBe(403)
    expect(await codeOf(res)).toBe('auth.step_up_required')
    expect(deps.activityLog.entries).toHaveLength(before)
  })

  test('switching enforcement off is refused when stale and recorded as weakened when fresh', async () => {
    const { maya, org, made } = await world()
    expect(
      (await client('PATCH', `${base(org)}/${made.id}`, { enforced: true }, maya.accessToken))
        .status
    ).toBe(200)
    const token = await aged(maya)
    const stale = await client('PATCH', `${base(org)}/${made.id}`, { enforced: false }, token)
    expect(await codeOf(stale)).toBe('auth.step_up_required')
    const stepped = await client(
      'POST',
      '/sessions/step-up',
      { method: 'password', password: PASSWORD },
      token
    )
    const fresh = (await json<{ accessToken: string }>(stepped)).accessToken
    expect(
      (await client('PATCH', `${base(org)}/${made.id}`, { enforced: false }, fresh)).status
    ).toBe(200)
    const entry = deps.activityLog.entries.findLast((e) => e.type === 'sso_connection.updated')
    expect(entry?.data).toMatchObject({ weakened: true })
    expect(entry?.actor.type).toBe('user')
  })

  test('a change that is not a weakening does not ask', async () => {
    const { maya, org, made } = await world()
    const token = await aged(maya)
    expect(
      (await client('PATCH', `${base(org)}/${made.id}`, { name: 'Renamed' }, token)).status
    ).toBe(200)
  })
})

describe('the test sign-in gate', () => {
  test('activating without a passing test is refused, however the admin asks', async () => {
    const { maya, org, made } = await world()
    const res = await client(
      'PATCH',
      `${base(org)}/${made.id}`,
      { status: 'active' },
      maya.accessToken
    )
    expect(res.status).toBe(409)
    expect(await codeOf(res)).toBe('sso.test_required')
  })

  test('a passing test of the current settings allows activation, and a change resets it', async () => {
    const { maya, org, made } = await world()
    const record = await deps.ssoConnections.find(TENANT.environmentId, made.id)
    if (!record) {
      throw new Error('missing')
    }
    await SsoConnections.markTested(
      deps,
      TENANT,
      made.id,
      SsoConnections.fingerprint(record),
      TEST_ACTOR
    )
    const read = await json<SsoConnection>(
      await client('GET', `${base(org)}/${made.id}`, undefined, maya.accessToken)
    )
    expect(read.tested).toBe(true)
    await client('PATCH', `${base(org)}/${made.id}`, { clientId: 'client-2' }, maya.accessToken)
    const again = await client(
      'PATCH',
      `${base(org)}/${made.id}`,
      { status: 'active' },
      maya.accessToken
    )
    expect(await codeOf(again)).toBe('sso.test_required')
  })

  test('starts a test of the own connection and reads it; a test of another connection is not found', async () => {
    const { maya, org, made } = await world()
    const second = await json<SsoConnection>(
      await client('POST', base(org), body({ name: 'Second', domains: [] }), maya.accessToken)
    )
    // The provider cannot be reached: the test fails at once instead of waiting on the network.
    deps.outbound.point('idp.example.test')
    const started = await client(
      'POST',
      `${base(org)}/${made.id}/tests`,
      { redirectUrl: REDIRECT },
      maya.accessToken
    )
    expect(started.status).toBe(201)
    const { testId } = await json<{ testId: string }>(started)
    const read = await client(
      'GET',
      `${base(org)}/${made.id}/tests/${testId}`,
      undefined,
      maya.accessToken
    )
    expect(read.status).toBe(200)
    const wrong = await client(
      'GET',
      `${base(org)}/${second.id}/tests/${testId}`,
      undefined,
      maya.accessToken
    )
    expect(await codeOf(wrong)).toBe('sso.test_not_found')
  })
})

describe('the per-environment limits', () => {
  for (const [name, path, bucket, limit, body] of [
    ['refresh-metadata', 'refresh-metadata', 'sso_refresh_metadata', 10, undefined],
    ['tests', 'tests', 'sso_test', 20, { redirectUrl: REDIRECT }],
  ] as const) {
    test(`${name} is limited per environment, across client addresses`, async () => {
      const { maya, org, made } = await world()
      Object.assign(deps.config, { trustProxy: true })
      const from = (n: number) =>
        app.request(`/v1/client${base(org)}/${made.id}/${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-tula-client': 'ios',
            origin: ORIGIN,
            'x-tula-publishable-key': PK,
            authorization: `Bearer ${maya.accessToken}`,
            'x-forwarded-for': `203.0.113.${n}`,
          },
          ...(body !== undefined && { body: JSON.stringify(body) }),
        })
      // The bucket is filled directly: twenty real rounds outlast the test's deadline.
      for (let n = 1; n <= limit; n++) {
        await deps.rateLimiter.hit(`${bucket}:env:${TEST_TENANT.environmentId}`, limit, 60_000)
      }
      expect((await from(limit + 1)).status).toBe(429)
    })
  }
})
