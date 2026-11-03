import { beforeEach, describe, expect, test } from 'bun:test'
import { DEFAULT_ENVIRONMENT_SETTINGS } from '@tula-tech/contract'
import { createApp } from '~/index'
import * as Audit from '~/modules/audit/service'
import * as Organizations from '~/modules/organization/service'
import * as ScimTokens from '~/modules/scim-token/service'
import * as Sessions from '~/modules/session/service'
import * as Users from '~/modules/user/service'
import { createInstanceTestDeps, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'

const TENANT = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }
const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User'

let deps: TestDeps
let orgId: string
let token: string

function configure(organizations = true) {
  deps.environmentSettings.seed(TEST_TENANT.environmentId, {
    revision: 1,
    settings: {
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      organizations: { ...DEFAULT_ENVIRONMENT_SETTINGS.organizations, enabled: organizations },
    } as never,
  })
}

async function verifiedDomain(organizationId: string, domain: string) {
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

async function scim(method: string, path: string, body?: unknown, bearer = token) {
  const res = await createApp(deps).request(`/v1/scim/v2${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/scim+json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  return {
    status: res.status,
    type: res.headers.get('content-type'),
    body: text ? JSON.parse(text) : null,
  }
}

/** Okta's create shape. */
const okta = (userName: string, extra: Record<string, unknown> = {}) => ({
  schemas: [USER_SCHEMA],
  userName,
  name: { givenName: 'Maya', familyName: 'Okafor' },
  emails: [{ value: userName, primary: true, type: 'work' }],
  externalId: `ext-${userName}`,
  active: true,
  ...extra,
})

const provision = async (userName = 'maya@acme.test') => {
  const created = await scim('POST', '/Users', okta(userName))
  expect(created.status).toBe(201)
  return created.body.id as string
}

const members = async (userId: string) =>
  (
    await deps.organizations.listUserMemberships(TENANT.environmentId, userId, {
      page: 1,
      size: 10,
    })
  ).total

beforeEach(async () => {
  deps = createInstanceTestDeps()
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  configure()
  const org = await Organizations.create(deps, TENANT, { name: 'Acme', slug: 'acme' }, TEST_ACTOR)
  orgId = org.id
  token = (
    await ScimTokens.create(deps, TENANT, { organizationId: orgId, name: 'Okta' }, TEST_ACTOR)
  ).token
})

describe('SCIM Users: create, get, list', () => {
  test('Okta create provisions a managed user and a member, answered as SCIM', async () => {
    const created = await scim('POST', '/Users', okta('maya@acme.test'))
    expect(created.status).toBe(201)
    expect(created.type).toContain('application/scim+json')
    expect(created.body).toMatchObject({
      schemas: [USER_SCHEMA],
      userName: 'maya@acme.test',
      externalId: 'ext-maya@acme.test',
      active: true,
      name: { givenName: 'Maya', familyName: 'Okafor' },
    })
    const user = await deps.users.findById(TENANT.environmentId, created.body.id)
    expect(user?.managedByDirectoryId).toBe(orgId)
    expect(user?.emailVerifiedAt).toBeNull()
    expect(await members(created.body.id)).toBe(1)
    const got = await scim('GET', `/Users/${created.body.id}`)
    expect(got.body.id).toBe(created.body.id)
  })

  test('active as the string "False" (Entra) is a deactivated user; a word that is no boolean is a 400', async () => {
    const entra = await scim('POST', '/Users', okta('lee@acme.test', { active: 'False' }))
    expect(entra.status).toBe(201)
    expect(entra.body.active).toBe(false)
    expect(await members(entra.body.id)).toBe(0)
    const bad = await scim('POST', '/Users', okta('kim@acme.test', { active: 'maybe' }))
    expect(bad.status).toBe(400)
    expect(bad.body.scimType).toBe('invalidValue')
  })

  test('a duplicate userName or externalId is a SCIM 409 uniqueness', async () => {
    await provision()
    const same = await scim('POST', '/Users', okta('MAYA@acme.test', { externalId: 'other' }))
    expect(same.status).toBe(409)
    expect(same.body).toMatchObject({ status: '409', scimType: 'uniqueness' })
    expect(same.body.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:Error'])
    const ext = await scim(
      'POST',
      '/Users',
      okta('nia@acme.test', { externalId: 'ext-maya@acme.test' })
    )
    expect(ext.body).toMatchObject({ status: '409', scimType: 'uniqueness' })
  })

  test('filters on userName and externalId, paging, and an unsupported filter', async () => {
    for (const name of ['a@acme.test', 'b@acme.test', 'c@acme.test']) {
      await provision(name)
    }
    const byName = await scim(
      'GET',
      `/Users?filter=${encodeURIComponent('userName eq "B@acme.test"')}`
    )
    expect(byName.body.totalResults).toBe(1)
    expect(byName.body.Resources[0].userName).toBe('b@acme.test')
    const byExt = await scim(
      'GET',
      `/Users?filter=${encodeURIComponent('externalId eq "ext-c@acme.test"')}`
    )
    expect(byExt.body.Resources.map((r: { userName: string }) => r.userName)).toEqual([
      'c@acme.test',
    ])
    const none = await scim(
      'GET',
      `/Users?filter=${encodeURIComponent('userName eq "z@acme.test"')}`
    )
    expect(none.body).toMatchObject({ totalResults: 0, Resources: [] })
    const page = await scim('GET', '/Users?startIndex=2&count=1')
    expect(page.body).toMatchObject({ totalResults: 3, startIndex: 2, itemsPerPage: 1 })
    const bad = await scim('GET', `/Users?filter=${encodeURIComponent('userName co "a"')}`)
    expect(bad.body).toMatchObject({ status: '400', scimType: 'invalidFilter' })
  })

  test('another organization’s directory does not see or touch these users', async () => {
    const id = await provision()
    const other = await Organizations.create(deps, TENANT, { name: 'B', slug: 'bee' }, TEST_ACTOR)
    const otherToken = (
      await ScimTokens.create(deps, TENANT, { organizationId: other.id, name: 'x' }, TEST_ACTOR)
    ).token
    expect((await scim('GET', `/Users/${id}`, undefined, otherToken)).status).toBe(404)
    expect((await scim('GET', '/Users', undefined, otherToken)).body.totalResults).toBe(0)
    expect((await scim('DELETE', `/Users/${id}`, undefined, otherToken)).status).toBe(404)
  })

  test('discovery documents answer', async () => {
    expect((await scim('GET', '/ServiceProviderConfig')).body.patch).toEqual({ supported: true })
    expect((await scim('GET', '/ResourceTypes')).body.Resources[0].id).toBe('User')
    expect((await scim('GET', '/Schemas')).body.Resources[0].id).toBe(USER_SCHEMA)
  })

  test('a malformed body is a SCIM 400 and a wrong token a SCIM 401', async () => {
    expect((await scim('POST', '/Users', { userName: 'not an email' })).body).toMatchObject({
      status: '400',
      scimType: 'invalidValue',
    })
    const refused = await scim('GET', '/Users', undefined, 'tula_scim_nope')
    expect(refused.status).toBe(401)
    expect(refused.body.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:Error'])
  })
})

describe('linking an existing account', () => {
  test('is allowed on a verified domain, and the account stays unmanaged', async () => {
    await verifiedDomain(orgId, 'acme.test')
    const existing = await Users.create(
      deps,
      TENANT,
      { email: 'lee@acme.test', emailVerified: true },
      TEST_ACTOR
    )
    const linked = await scim('POST', '/Users', okta('lee@acme.test'))
    expect(linked.status).toBe(201)
    expect(linked.body.id).toBe(existing.id)
    const user = await deps.users.findById(TENANT.environmentId, existing.id)
    expect(user?.managedByDirectoryId ?? null).toBeNull()
    expect(await members(existing.id)).toBe(1)
  })

  test('is refused with 409 off the verified domains', async () => {
    await Users.create(deps, TENANT, { email: 'lee@elsewhere.test' }, TEST_ACTOR)
    const res = await scim('POST', '/Users', okta('lee@elsewhere.test'))
    expect(res.body).toMatchObject({ status: '409', scimType: 'uniqueness' })
  })
})

describe('deactivation, reactivation and deletion', () => {
  const sessionOf = async (userId: string) =>
    Sessions.create(deps, TENANT, { userId, client: 'web', userAgent: null, ipAddress: null })

  test('Entra "False" on a path bans a managed user, drops access at once, and reactivation restores it', async () => {
    const id = await provision()
    const tokens = await sessionOf(id)
    const off = await scim('PATCH', `/Users/${id}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'Replace', path: 'active', value: 'False' }],
    })
    expect(off.body.active).toBe(false)
    expect(await members(id)).toBe(0)
    expect((await deps.users.findById(TENANT.environmentId, id))?.bannedAt).not.toBeNull()
    expect(await deps.revokedSessions.has(tokens.sessionId, deps.clock.now())).toBe(true)

    const on = await scim('PATCH', `/Users/${id}`, {
      Operations: [{ op: 'replace', value: { active: true } }],
    })
    expect(on.body.active).toBe(true)
    expect(await members(id)).toBe(1)
    expect((await deps.users.findById(TENANT.environmentId, id))?.bannedAt).toBeNull()
  })

  test('PUT with active false deactivates', async () => {
    const id = await provision()
    const res = await scim('PUT', `/Users/${id}`, okta('maya@acme.test', { active: false }))
    expect(res.body.active).toBe(false)
    expect(await members(id)).toBe(0)
  })

  test('an unmanaged user is never banned and keeps their sessions; delete leaves the account', async () => {
    await verifiedDomain(orgId, 'acme.test')
    const lee = await Users.create(deps, TENANT, { email: 'lee@acme.test' }, TEST_ACTOR)
    await scim('POST', '/Users', okta('lee@acme.test'))
    const tokens = await sessionOf(lee.id)
    const off = await scim('PATCH', `/Users/${lee.id}`, {
      Operations: [{ op: 'replace', path: 'active', value: false }],
    })
    expect(off.body.active).toBe(false)
    expect(await members(lee.id)).toBe(0)
    expect((await deps.users.findById(TENANT.environmentId, lee.id))?.bannedAt).toBeNull()
    expect(await deps.revokedSessions.has(tokens.sessionId, deps.clock.now())).toBe(false)
    expect((await scim('DELETE', `/Users/${lee.id}`)).status).toBe(204)
    expect(await deps.users.findById(TENANT.environmentId, lee.id)).not.toBeNull()
    expect((await scim('GET', `/Users/${lee.id}`)).status).toBe(404)
  })

  test('a managed user with another membership is not banned or deleted', async () => {
    const id = await provision()
    const other = await Organizations.create(deps, TENANT, { name: 'B', slug: 'bee' }, TEST_ACTOR)
    await Organizations.addMember(
      deps,
      TENANT,
      other.id,
      { userId: id, role: 'member' },
      TEST_ACTOR
    )
    await scim('PATCH', `/Users/${id}`, {
      Operations: [{ op: 'replace', path: 'active', value: false }],
    })
    expect((await deps.users.findById(TENANT.environmentId, id))?.bannedAt).toBeNull()
    expect((await scim('DELETE', `/Users/${id}`)).status).toBe(204)
    expect(await deps.users.findById(TENANT.environmentId, id)).not.toBeNull()
    expect(await members(id)).toBe(1)
  })

  test('deleting a managed user with no other membership deletes the account', async () => {
    const id = await provision()
    expect((await scim('DELETE', `/Users/${id}`)).status).toBe(204)
    expect(await deps.users.findById(TENANT.environmentId, id)).toBeNull()
  })

  test('the organization’s last manager cannot be deactivated or deleted: SCIM 409', async () => {
    const id = await provision()
    await Organizations.changeMemberRole(deps, TENANT, orgId, id, { role: 'admin' }, TEST_ACTOR)
    const off = await scim('PATCH', `/Users/${id}`, {
      Operations: [{ op: 'replace', path: 'active', value: false }],
    })
    expect(off.status).toBe(409)
    expect(off.body.status).toBe('409')
    expect((await scim('DELETE', `/Users/${id}`)).status).toBe(409)
    expect((await deps.users.findById(TENANT.environmentId, id))?.bannedAt).toBeNull()
    expect(await members(id)).toBe(1)
  })
})

describe('audit and ownership', () => {
  test('changes are recorded with the directory as actor and ids only', async () => {
    const id = await provision()
    await scim('PATCH', `/Users/${id}`, {
      Operations: [{ op: 'replace', path: 'active', value: false }],
    })
    const entries = (
      await deps.activityLog.listAudit(TENANT.environmentId, { page: 1, size: 100 })
    ).entries.filter((entry) => entry.actor.type === 'directory')
    const types = entries.map((entry) => entry.type)
    expect(types).toEqual(
      expect.arrayContaining(['user.created', 'user.scim_provisioned', 'user.banned'])
    )
    expect(JSON.stringify(entries)).not.toContain('maya@acme.test')
  })

  test('the address of a managed user cannot be set or changed from the client side', async () => {
    const id = await provision()
    await expect(
      Users.setEmail(deps, TENANT, id, 'other@acme.test', TEST_ACTOR)
    ).rejects.toMatchObject({ code: 'email.already_set' })
  })

  test('a disabled organizations feature refuses the whole group', async () => {
    configure(false)
    const res = await scim('GET', '/Users')
    expect(res.status).toBe(403)
    expect(res.body.status).toBe('403')
  })
})
