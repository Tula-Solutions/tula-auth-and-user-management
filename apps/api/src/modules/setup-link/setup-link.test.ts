import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  SETUP_LINK_HEADER,
  SETUP_LINK_TOKEN_PREFIX,
  type SsoConnection,
} from '@tula-tech/contract'
import { Hono } from 'hono'
import type { AppEnv } from '~/dependencies'
import { onError } from '~/handlers'
import { createApp } from '~/index'
import * as logger from '~/lib/logger'
import { setupLink } from '~/middleware/setup-link'
import * as Audit from '~/modules/audit/service'
import * as Organizations from '~/modules/organization/service'
import * as OrganizationRoles from '~/modules/organization-role/service'
import * as ScimTokens from '~/modules/scim-token/service'
import * as Portal from '~/modules/setup-link/portal'
import * as SetupLinks from '~/modules/setup-link/service'
import * as Sso from '~/modules/sso/service'
import * as SsoConnections from '~/modules/sso-connection/service'
import * as Users from '~/modules/user/service'
import {
  createInstanceTestDeps,
  seedApiKey,
  TEST_ACTOR,
  TEST_TENANT,
  type TestDeps,
} from '~/testing'
import { passTest } from '~/testing/sso-tested'

const SK = 'tula_sk_dev_secret000000000000000000000000'
const AK = 'tula_ak_dev_agent000000000000000000000000000000'
const PK = 'tula_pk_dev_publishable0000000000000000000'
const TENANT = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }
const ISSUER = 'https://idp.example.test'
const DAY = 86_400_000

let deps: TestDeps

function configure(sso = true, organizations = true) {
  deps.environmentSettings.seed(TEST_TENANT.environmentId, {
    revision: 1,
    settings: {
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      organizations: { ...DEFAULT_ENVIRONMENT_SETTINGS.organizations, enabled: organizations },
      sso: { enabled: sso },
    } as never,
  })
}

const org = (slug = 'acme') => Organizations.create(deps, TENANT, { name: slug, slug }, TEST_ACTOR)

async function link(organizationId: string, extra: Record<string, unknown> = {}) {
  return SetupLinks.create(
    deps,
    TENANT,
    { organizationId, name: 'IT', expiresInDays: 7, ...extra } as never,
    TEST_ACTOR
  )
}

const portal = (token: string, path = '', init: RequestInit = {}) =>
  createApp(deps).request(`/v1/setup${path}`, {
    ...init,
    headers: {
      [SETUP_LINK_HEADER]: token,
      'content-type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
  })

const body = (value: unknown) => ({ body: JSON.stringify(value) })

const oidc = { name: 'Okta', issuer: ISSUER, clientId: 'c1', clientSecret: 'shh-secret' }

/** Verify a domain for an organization straight in the store (the mail round trip is not the subject). */
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
    new Date(now.getTime() + 365 * DAY),
    none
  )
}

async function connect(token: string, extra: Record<string, unknown> = {}): Promise<SsoConnection> {
  const res = await portal(token, '/connections', {
    method: 'POST',
    ...body({ ...oidc, ...extra }),
  })
  expect(res.status).toBe(201)
  return (await res.json()) as SsoConnection
}

beforeEach(async () => {
  deps = createInstanceTestDeps()
  const now = deps.clock.now()
  for (const id of [TEST_TENANT.environmentId, TEST_TENANT.productionEnvironmentId]) {
    deps.environments.add({
      id,
      projectId: TEST_TENANT.projectId,
      kind: 'development',
      createdAt: now,
    })
  }
  deps.outbound.point('idp.example.test', '93.184.216.34')
  configure()
  await seedApiKey(deps, SK)
  await seedApiKey(deps, AK)
  await seedApiKey(deps, PK)
})

describe('setup link service', () => {
  test('a token is shown once, its address carries it in the fragment, and only a hash is kept', async () => {
    const o = await org()
    const made = await link(o.id)
    expect(made.token.startsWith(SETUP_LINK_TOKEN_PREFIX)).toBe(true)
    expect(SetupLinks.environmentOf(made.token)).toBe(TENANT.environmentId)
    expect(made.url).toBe(
      `${deps.config.publicUrl.replace(/\/+$/, '')}/dashboard/setup#token=${made.token}`
    )
    expect(new Date(made.expiresAt).getTime()).toBe(deps.clock.now().getTime() + 7 * DAY)
    const listed = await SetupLinks.list(deps, TENANT, o.id)
    expect(listed.map((one) => one.id)).toEqual([made.id])
    expect(JSON.stringify(listed)).not.toContain(made.token)
    expect(JSON.stringify(await deps.setupLinks.list(TENANT.environmentId, o.id))).not.toContain(
      made.token
    )
  })

  test('creating and revoking are audited with the link and no token', async () => {
    const o = await org()
    const made = await link(o.id)
    await SetupLinks.revoke(deps, TENANT, o.id, made.id, TEST_ACTOR)
    const entries = deps.activityLog.entries.filter((e) => e.type.startsWith('setup_link.'))
    expect(entries.map((e) => e.type).sort()).toEqual(['setup_link.created', 'setup_link.revoked'])
    expect(JSON.stringify(entries)).not.toContain(made.token)
  })

  test('an organization holds ten live links; revoking, another organization and a stranger', async () => {
    const o = await org()
    const other = await org('globex')
    const made = []
    for (let i = 0; i < SetupLinks.MAX_LIVE_LINKS; i++) {
      made.push(await link(o.id))
    }
    await expect(link(o.id)).rejects.toMatchObject({ status: 409 })
    await expect(
      SetupLinks.revoke(deps, TENANT, other.id, made[0]?.id as string, TEST_ACTOR)
    ).rejects.toMatchObject({ status: 404 })
    await SetupLinks.revoke(deps, TENANT, o.id, made[0]?.id as string, TEST_ACTOR)
    await link(o.id)
    await expect(link(Bun.randomUUIDv7())).rejects.toMatchObject({ status: 404 })
  })

  test('it refuses while SSO or organizations are off', async () => {
    const o = await org()
    configure(false)
    await expect(SetupLinks.list(deps, TENANT, o.id)).rejects.toMatchObject({
      code: 'sso.disabled',
    })
    configure(true, false)
    await expect(SetupLinks.list(deps, TENANT, o.id)).rejects.toMatchObject({
      code: 'organization.disabled',
    })
  })

  test('requireManager reads the permission from the role now', async () => {
    const o = await org()
    const user = await Users.create(
      deps,
      TENANT,
      { email: 'a@acme.test', password: 'correct horse battery staple' },
      TEST_ACTOR
    )
    await expect(SetupLinks.requireManager(deps, TENANT, user.id, o.id)).rejects.toMatchObject({
      code: 'organization.not_a_member',
    })
    await Organizations.addMember(
      deps,
      TENANT,
      o.id,
      { userId: user.id, role: 'member' },
      TEST_ACTOR
    )
    await expect(SetupLinks.requireManager(deps, TENANT, user.id, o.id)).rejects.toMatchObject({
      code: 'auth.forbidden',
    })
    await Organizations.changeMemberRole(deps, TENANT, o.id, user.id, { role: 'admin' }, TEST_ACTOR)
    await SetupLinks.requireManager(deps, TENANT, user.id, o.id)
  })

  test('environmentOf reads only tokens shaped like ours', () => {
    expect(SetupLinks.environmentOf('tula_sk_dev_x')).toBeNull()
    expect(SetupLinks.environmentOf(`${SETUP_LINK_TOKEN_PREFIX}nothex_abc`)).toBeNull()
    expect(SetupLinks.environmentOf(`${SETUP_LINK_TOKEN_PREFIX}${'a'.repeat(32)}_short`)).toBeNull()
  })
})

describe('setupLink middleware', () => {
  function guarded() {
    const app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      c.set('deps', deps as never)
      await next()
    })
    app.use('*', setupLink() as never)
    app.get('/', (c) => c.json((c as never as { var: { setupLink: unknown } }).var.setupLink))
    app.onError(onError)
    return app
  }
  const hit = (token?: string) =>
    guarded().request('/', { headers: token === undefined ? {} : { [SETUP_LINK_HEADER]: token } })

  test('a live token resolves its organization and records its use', async () => {
    const o = await org()
    const made = await link(o.id)
    const res = await hit(made.token)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ organizationId: o.id, linkId: made.id })
    expect((await deps.setupLinks.list(TENANT.environmentId, o.id))[0]?.lastUsedAt).toEqual(
      deps.clock.now()
    )
  })

  test('a failed write of the last use never fails a valid request', async () => {
    const o = await org()
    const made = await link(o.id)
    const touch = spyOn(deps.setupLinks, 'touch').mockRejectedValue(new Error('db down'))
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    expect((await hit(made.token)).status).toBe(200)
    expect(warn).toHaveBeenCalledTimes(1)
    touch.mockRestore()
    warn.mockRestore()
  })

  test('missing, malformed, unknown, other-environment, revoked and expired are the same 401', async () => {
    const o = await org()
    const made = await link(o.id)
    const flipped = `${made.token.slice(0, -1)}${made.token.endsWith('a') ? 'b' : 'a'}`
    const foreign = made.token.replace(
      /^tula_setup_[0-9a-f]{32}/,
      `${SETUP_LINK_TOKEN_PREFIX}${TEST_TENANT.productionEnvironmentId.replaceAll('-', '')}`
    )
    const short = await link(o.id, { expiresInDays: 1 })
    const revoked = await link(o.id)
    await SetupLinks.revoke(deps, TENANT, o.id, revoked.id, TEST_ACTOR)
    deps.clock.advance(2 * DAY)
    for (const presented of [
      flipped,
      foreign,
      short.token,
      revoked.token,
      SK,
      AK,
      'tula_setup_',
      '',
      undefined,
    ]) {
      const res = await hit(presented)
      expect(res.status).toBe(401)
      expect(((await res.json()) as { code: string }).code).toBe('auth.invalid_key')
    }
    expect((await hit(made.token)).status).toBe(200)
  })

  test('the token is read from its header alone', async () => {
    const o = await org()
    const made = await link(o.id)
    const viaBearer = await guarded().request('/', {
      headers: { authorization: `Bearer ${made.token}` },
    })
    expect(viaBearer.status).toBe(401)
  })

  test('a link is rate limited on its own and no more than its organization', async () => {
    const o = await org()
    const made = await link(o.id)
    let last = 200
    for (let i = 0; i < 125; i++) {
      last = (await hit(made.token)).status
    }
    expect(last).toBe(429)
  })
})

describe('admin setup link routes and credentials', () => {
  test('create answers the token once with no-store; list never does', async () => {
    const o = await org()
    const app = createApp(deps)
    const created = await app.request('/v1/admin/setup-links', {
      method: 'POST',
      headers: { authorization: `Bearer ${SK}`, 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId: o.id, name: 'IT' }),
    })
    expect(created.status).toBe(201)
    expect(created.headers.get('cache-control')).toBe('no-store')
    const made = (await created.json()) as { token: string; id: string; url: string }
    expect(made.url).toContain('#token=')
    const listed = await app.request(`/v1/admin/setup-links?organizationId=${o.id}`, {
      headers: { authorization: `Bearer ${SK}` },
    })
    expect(JSON.stringify(await listed.json())).not.toContain(made.token)
    const revoked = await app.request(`/v1/admin/setup-links/${made.id}?organizationId=${o.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${SK}` },
    })
    expect(revoked.status).toBe(204)
    expect((await portal(made.token)).status).toBe(401)
  })

  test('a setup token opens no other group, in either header', async () => {
    const o = await org()
    const made = await link(o.id)
    const app = createApp(deps)
    const carriers: Record<string, string>[] = [
      { authorization: `Bearer ${made.token}` },
      { [SETUP_LINK_HEADER]: made.token },
    ]
    for (const headers of carriers) {
      for (const path of [
        `/v1/admin/setup-links?organizationId=${o.id}`,
        `/v1/admin/sso-connections?organizationId=${o.id}`,
        `/v1/admin/scim-tokens?organizationId=${o.id}`,
      ]) {
        expect((await app.request(path, { headers })).status).toBe(401)
      }
      const agent = await app.request('/v1/agent/proposals', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: '{}',
      })
      expect(agent.status).toBe(401)
    }
  })

  test('no other credential opens the setup routes', async () => {
    const o = await org()
    const made = await link(o.id)
    const scim = await deps.scim.listTokens(TENANT.environmentId, o.id)
    expect(scim).toEqual([])
    const app = createApp(deps)
    const others: Record<string, string>[] = [
      { authorization: `Bearer ${SK}` },
      { authorization: `Bearer ${AK}` },
      { authorization: `Bearer ${made.token}` },
      { [SETUP_LINK_HEADER]: SK },
      { [SETUP_LINK_HEADER]: AK },
      {
        'x-tula-dashboard': '1',
        cookie: '__Secure-tula_dashboard=x',
        'x-tula-environment': TENANT.environmentId,
      },
    ]
    for (const headers of others) {
      const res = await app.request('/v1/setup', { headers })
      expect(res.status).toBe(401)
    }
  })

  test('the client routes need a session', async () => {
    const o = await org()
    const res = await createApp(deps).request(`/v1/client/me/organizations/${o.id}/setup-links`, {
      headers: { 'x-tula-publishable-key': PK },
    })
    expect(res.status).toBe(401)
  })
})

describe('setup portal', () => {
  test('it shows the link’s organization, no-store and no-referrer', async () => {
    const o = await org()
    const made = await link(o.id)
    const res = await portal(made.token)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(await res.json()).toMatchObject({ organization: { id: o.id }, connections: [] })
    const refused = await portal('nope')
    expect(refused.headers.get('referrer-policy')).toBe('no-referrer')
  })

  test('it lists only its own organization’s connections', async () => {
    const mine = await org()
    const theirs = await org('globex')
    const a = await link(mine.id)
    const b = await link(theirs.id)
    const own = await connect(a.token)
    const foreign = await connect(b.token)
    const view = (await (await portal(a.token)).json()) as { connections: SsoConnection[] }
    expect(view.connections.map((c) => c.id)).toEqual([own.id])
    expect(JSON.stringify(view)).not.toContain(foreign.id)
    expect(JSON.stringify(view)).not.toContain('shh-secret')
  })

  test('a connection is created for the link’s organization with the default role only', async () => {
    const o = await org()
    const made = await link(o.id)
    const created = await connect(made.token)
    expect(created).toMatchObject({ organizationId: o.id, status: 'draft', defaultRole: 'member' })
    const other = await portal(made.token, '/connections', {
      method: 'POST',
      ...body({ ...oidc, organizationId: Bun.randomUUIDv7() }),
    })
    expect(other.status).toBe(422)
  })

  test('every route refuses another organization’s connection as if it did not exist', async () => {
    const mine = await org()
    const theirs = await org('globex')
    const a = await link(mine.id)
    const b = await link(theirs.id)
    const foreign = await connect(b.token)
    const testId = Bun.randomUUIDv7()
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined)
    const calls: Array<[string, string, unknown?]> = [
      ['GET', `/connections/${foreign.id}`],
      ['PATCH', `/connections/${foreign.id}`, { name: 'x' }],
      ['POST', `/connections/${foreign.id}/refresh-metadata`],
      ['GET', `/connections/${foreign.id}/group-roles`],
      ['PUT', `/connections/${foreign.id}/group-roles`, { mappings: [] }],
      ['POST', `/connections/${foreign.id}/tests`],
      ['GET', `/connections/${foreign.id}/tests/${testId}`],
    ]
    for (const [method, path, payload] of calls) {
      const res = await portal(a.token, path, {
        method,
        ...(payload === undefined ? {} : body(payload)),
      })
      expect([method, path, res.status]).toEqual([method, path, 404])
      expect(((await res.json()) as { code: string }).code).toBe('sso.connection_not_found')
    }
    // H-026: each probe is logged with fixed fields and no id of the other organization.
    expect(warn).toHaveBeenCalledTimes(calls.length)
    for (const [, fields] of warn.mock.calls) {
      expect(fields).toEqual({ environmentId: TENANT.environmentId, organizationId: mine.id })
    }
    expect(JSON.stringify(warn.mock.calls)).not.toContain(foreign.id)
    expect(JSON.stringify(warn.mock.calls)).not.toContain(theirs.id)
    warn.mockRestore()
    const untouched = await deps.ssoConnections.find(TENANT.environmentId, foreign.id)
    expect(untouched?.name).toBe('Okta')
  })

  test('a mapping to a role that does not exist is refused, and nothing is saved (H-041)', async () => {
    const o = await org()
    const made = await link(o.id)
    const c = await connect(made.token)
    const res = await portal(made.token, `/connections/${c.id}/group-roles`, {
      method: 'PUT',
      ...body({ mappings: [{ group: 'Staff', role: 'ghost' }] }),
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(((await res.json()) as { code: string }).code).toBe('organization.role_unknown')
    expect(await deps.ssoConnections.listGroupRoles(TENANT.environmentId, o.id)).toEqual([])
  })

  test('a role that became privileged after the page loaded is refused at save time (H-042)', async () => {
    const o = await org()
    const made = await link(o.id)
    const c = await connect(made.token)
    const created = await OrganizationRoles.create(
      deps,
      TENANT,
      { key: 'viewer', name: 'Viewer', permissions: [] },
      TEST_ACTOR
    )
    const path = `/connections/${c.id}/group-roles`
    const put = () =>
      portal(made.token, path, {
        method: 'PUT',
        ...body({ mappings: [{ group: 'Staff', role: 'viewer' }] }),
      })
    expect((await put()).status).toBe(200)
    await OrganizationRoles.update(
      deps,
      TENANT,
      'viewer',
      created.version,
      { permissions: ['org:sys:memberships:manage'] },
      TEST_ACTOR
    )
    // The saved mapping is now privileged: it is locked, and a request that re-sends it is kept;
    // a new group asking for the same role is refused.
    const refused = await portal(made.token, path, {
      method: 'PUT',
      ...body({ mappings: [{ group: 'Other', role: 'viewer' }] }),
    })
    expect(refused.status).toBe(403)
    expect(((await refused.json()) as { code: string }).code).toBe('sso.role_not_allowed')
  })

  test('a link maps groups to unprivileged roles only; privileged mappings are locked and kept', async () => {
    const o = await org()
    const made = await link(o.id)
    const c = await connect(made.token)
    const path = `/connections/${c.id}/group-roles`
    const put = (mappings: Array<{ group: string; role: string }>) =>
      portal(made.token, path, { method: 'PUT', ...body({ mappings }) })
    await OrganizationRoles.create(
      deps,
      TENANT,
      { key: 'viewer', name: 'Viewer', permissions: [] },
      TEST_ACTOR
    )
    await OrganizationRoles.create(
      deps,
      TENANT,
      { key: 'billing', name: 'Billing', permissions: ['org:sys:memberships:manage'] },
      TEST_ACTOR
    )
    expect((await put([{ group: 'Staff', role: 'viewer' }])).status).toBe(200)
    expect((await put([{ group: 'Staff', role: 'member' }])).status).toBe(200)
    for (const role of ['admin', 'billing']) {
      const refused = await put([{ group: 'Staff', role }])
      expect(refused.status).toBe(403)
      expect(((await refused.json()) as { code: string }).code).toBe('sso.role_not_allowed')
    }
    // Nothing the refused calls asked for was saved.
    expect(
      (await deps.ssoConnections.listGroupRoles(TENANT.environmentId, o.id)).map((m) => m.role)
    ).toEqual(['member'])
    // The operator can still map a privileged role, and the portal then sees it locked and keeps it.
    await SsoConnections.putGroupRoles(
      deps,
      TENANT,
      c.id,
      {
        mappings: [
          { group: 'Owners', role: 'admin' },
          { group: 'Staff', role: 'member' },
        ],
      },
      TEST_ACTOR
    )
    const shown = (await (await portal(made.token, path)).json()) as {
      mappings: Array<{ group: string; role: string; locked: boolean }>
    }
    expect(shown.mappings).toEqual([
      { group: 'Owners', role: 'admin', locked: true },
      { group: 'Staff', role: 'member', locked: false },
    ])
    expect((await put([{ group: 'Staff', role: 'viewer' }])).status).toBe(200)
    expect(await deps.ssoConnections.listGroupRoles(TENANT.environmentId, o.id)).toEqual([
      { group: 'Owners', role: 'admin' },
      { group: 'Staff', role: 'viewer' },
    ])
  })

  test('a SCIM token request cannot name another organization', async () => {
    const o = await org()
    const other = await org('other')
    const made = await link(o.id)
    const res = await portal(made.token, '/scim-tokens', {
      method: 'POST',
      ...body({ name: 'Okta', organizationId: other.id }),
    })
    expect(res.status).toBe(422)
    // And the service itself, given the extra key by a caller that forgot the schema, ignores it.
    await Portal.createScimToken(
      deps,
      TENANT,
      { organizationId: o.id, expiresAt: made.expiresAt as never },
      { name: 'Okta', organizationId: other.id } as never,
      TEST_ACTOR
    )
    expect(await deps.scim.listTokens(TENANT.environmentId, other.id)).toEqual([])
    expect(await deps.scim.listTokens(TENANT.environmentId, o.id)).toHaveLength(1)
  })

  test('the portal cannot weaken: enforcement, MFA trust, break-glass and role are refused', async () => {
    const o = await org()
    const made = await link(o.id)
    const c = await connect(made.token)
    for (const extra of [
      { enforced: true },
      { trustIdpMfa: true },
      { breakGlassRole: 'owner' },
      { defaultRole: 'admin' },
      { status: 'disabled' },
      { organizationId: Bun.randomUUIDv7() },
    ]) {
      const res = await portal(made.token, `/connections/${c.id}`, {
        method: 'PATCH',
        ...body(extra),
      })
      expect([JSON.stringify(extra), res.status]).toEqual([JSON.stringify(extra), 422])
    }
  })

  test('activation needs a passing test, then works and is audited as the setup link', async () => {
    const o = await org()
    const made = await link(o.id)
    await verified(o.id, 'acme.test')
    const c = await connect(made.token, { domains: ['acme.test'] })
    const early = await portal(made.token, `/connections/${c.id}`, {
      method: 'PATCH',
      ...body({ status: 'active' }),
    })
    expect(((await early.json()) as { code: string }).code).toBe('sso.test_required')
    await passTest(deps, TENANT, c.id, TEST_ACTOR)
    const active = await portal(made.token, `/connections/${c.id}`, {
      method: 'PATCH',
      ...body({ status: 'active' }),
    })
    expect(active.status).toBe(200)
    expect(((await active.json()) as SsoConnection).status).toBe('active')
    const portalEntries = deps.activityLog.entries.filter((e) => e.actor.type === 'setup_link')
    expect(portalEntries.map((e) => e.type)).toEqual([
      'sso_connection.created',
      'sso_connection.updated',
    ])
    expect(new Set(portalEntries.map((e) => e.actor.id))).toEqual(new Set([made.id]))
  })

  test('a test sign-in returns to the server-built portal page without an allow-listed redirect', async () => {
    const o = await org()
    const made = await link(o.id)
    const c = await connect(made.token)
    const authorize = spyOn(Sso, 'authorizationUrl').mockResolvedValue(`${ISSUER}/authorize?s=1`)
    const res = await portal(made.token, `/connections/${c.id}/tests`, { method: 'POST' })
    authorize.mockRestore()
    expect(res.status).toBe(201)
    const started = (await res.json()) as { testId: string; authorizationUrl: string }
    expect(started.authorizationUrl).toBe(`${ISSUER}/authorize?s=1`)
    const attempt = await deps.flowAttempts.findById(TENANT.environmentId, started.testId)
    expect(JSON.stringify(attempt?.state)).toContain(
      `${deps.config.publicUrl.replace(/\/+$/, '')}/dashboard/setup`
    )
    const result = await portal(made.token, `/connections/${c.id}/tests/${started.testId}`)
    expect(((await result.json()) as { status: string }).status).toBe('pending')
  })

  test('a revoked or expired link stops at once', async () => {
    const o = await org()
    const made = await link(o.id, { expiresInDays: 1 })
    expect((await portal(made.token)).status).toBe(200)
    await SetupLinks.revoke(deps, TENANT, o.id, made.id, TEST_ACTOR)
    expect((await portal(made.token)).status).toBe(401)
    const fresh = await link(o.id, { expiresInDays: 1 })
    deps.clock.advance(DAY)
    expect((await portal(fresh.token)).status).toBe(401)
  })

  test('the portal reads no user, setting or other route of the API', async () => {
    const o = await org()
    const made = await link(o.id)
    for (const path of [
      '/users',
      '/settings',
      '/organizations',
      '/sso-connections',
      '/setup-links',
    ]) {
      expect((await portal(made.token, path)).status).toBe(404)
    }
  })
})

describe('setup portal SCIM token', () => {
  const create = (token: string, value: unknown = { name: 'Okta' }) =>
    portal(token, '/scim-tokens', { method: 'POST', ...body(value) })

  test('creates the link’s organization’s token once, no-store, recorded as the setup link', async () => {
    const o = await org()
    const made = await link(o.id)
    const res = await create(made.token)
    expect(res.status).toBe(201)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const created = (await res.json()) as { token: string; organizationId: string; id: string }
    expect(created.organizationId).toBe(o.id)
    expect(created.token).toStartWith('tula_scim_')
    const entries = deps.activityLog.entries.filter((e) => e.type === 'scim_token.created')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.actor).toMatchObject({ type: 'setup_link', id: made.id })
    expect(JSON.stringify(entries)).not.toContain(created.token)
    // The portal never reads a secret back: it has no list, and its view carries none.
    expect((await portal(made.token, '/scim-tokens')).status).toBe(404)
    expect(JSON.stringify(await (await portal(made.token)).json())).not.toContain(created.token)
  })

  test('the organization cannot be chosen by the request', async () => {
    const mine = await org()
    const theirs = await org('globex')
    const made = await link(mine.id)
    const res = await create(made.token, { name: 'Okta', organizationId: theirs.id })
    expect(res.status).toBe(422)
    expect(await deps.scim.listTokens(TENANT.environmentId, theirs.id)).toHaveLength(0)
  })

  test('refuses a missing name, a stranger, a full organization and a revoked link', async () => {
    const o = await org()
    const made = await link(o.id)
    expect((await create(made.token, {})).status).toBe(422)
    expect((await create('nope')).status).toBe(401)
    for (let i = 0; i < 10; i++) {
      expect((await create(made.token, { name: `t${i}` })).status).toBe(201)
    }
    expect((await create(made.token)).status).toBe(409)
    await SetupLinks.revoke(deps, TENANT, o.id, made.id, TEST_ACTOR)
    expect((await create(made.token)).status).toBe(401)
  })

  describe('a directory push that would make a member privileged', () => {
    async function pushOwners(token: string, organizationId: string) {
      const scim = (method: string, path: string, value?: unknown) =>
        createApp(deps).request(`/v1/scim/v2${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/scim+json' },
          ...(value !== undefined && { body: JSON.stringify(value) }),
        })
      await verified(organizationId, 'acme.test')
      await deps.ssoConnections.replaceGroupRoles(
        { ...TENANT, organizationId, mappings: [{ group: 'Owners', role: 'admin' }] },
        deps.clock.now(),
        Audit.none('fixture')
      )
      const user = await scim('POST', '/Users', {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'eve@acme.test',
        emails: [{ value: 'eve@acme.test', primary: true }],
        active: true,
      })
      expect(user.status).toBe(201)
      const userId = ((await user.json()) as { id: string }).id
      const group = await scim('POST', '/Groups', {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        displayName: 'Owners',
        members: [{ value: userId }],
      })
      const role = (
        await deps.organizations.findMembership(TENANT.environmentId, organizationId, userId)
      )?.roleKey
      return { group, role, listed: await (await scim('GET', '/Groups')).json() }
    }

    test('a token a setup link minted is refused, and no role changes', async () => {
      const o = await org()
      const made = await link(o.id)
      const { token } = (await (await create(made.token)).json()) as { token: string }
      const { group, role, listed } = await pushOwners(token, o.id)
      expect(group.status).toBe(400)
      expect(((await group.json()) as { scimType: string }).scimType).toBe('invalidValue')
      expect(role).toBe('member')
      expect((listed as { totalResults: number }).totalResults).toBe(0)
    })

    test('a token an operator minted still applies a privileged mapping', async () => {
      const o = await org()
      const { token } = await ScimTokens.create(
        deps,
        TENANT,
        { organizationId: o.id, name: 'Okta' },
        TEST_ACTOR
      )
      const { group, role } = await pushOwners(token, o.id)
      expect(group.status).toBe(201)
      expect(role).toBe('admin')
    })
  })

  test('the new token opens its own organization’s directory', async () => {
    const o = await org()
    const made = await link(o.id)
    const created = (await (await create(made.token)).json()) as { token: string }
    const res = await createApp(deps).request('/v1/scim/v2/Users', {
      headers: { authorization: `Bearer ${created.token}` },
    })
    expect(res.status).toBe(200)
  })
})
