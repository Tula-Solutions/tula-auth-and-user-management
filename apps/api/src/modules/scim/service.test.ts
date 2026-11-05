import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { DEFAULT_ENVIRONMENT_SETTINGS } from '@tula-tech/contract'
import { createApp } from '~/index'
import * as Audit from '~/modules/audit/service'
import * as Organizations from '~/modules/organization/service'
import * as OrganizationRoles from '~/modules/organization-role/service'
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
  // New accounts need a verified domain (TULA-162); most tests provision on this one.
  await verifiedDomain(orgId, 'acme.test')
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
    expect(user?.emailVerifiedAt).not.toBeNull()
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

describe('creating a new account', () => {
  test('is refused with 400 off the verified domains, and creates nothing', async () => {
    const res = await scim('POST', '/Users', okta('new@unverified.test'))
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ scimType: 'invalidValue' })
    expect(await deps.users.findByEmail(TENANT.environmentId, 'new@unverified.test')).toBeNull()
    const entries = (await deps.activityLog.listAudit(TENANT.environmentId, { page: 1, size: 100 }))
      .entries
    expect(entries.filter((entry) => entry.actor.type === 'directory')).toEqual([])
  })

  test('is allowed on a verified domain', async () => {
    const res = await scim('POST', '/Users', okta('new@acme.test'))
    expect(res.status).toBe(201)
  })
})

describe('linking an existing account', () => {
  test('is allowed on a verified domain, and the account stays unmanaged', async () => {
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

  test('an operator’s ban outlives the directory: a routine active:true does not lift it', async () => {
    const id = await provision()
    await Users.ban(deps, TENANT, id, TEST_ACTOR)
    const put = await scim('PUT', `/Users/${id}`, okta('maya@acme.test', { active: true }))
    expect(put.status).toBe(200)
    expect((await deps.users.findById(TENANT.environmentId, id))?.bannedAt).not.toBeNull()
    const patch = await scim('PATCH', `/Users/${id}`, {
      Operations: [{ op: 'replace', path: 'active', value: true }],
    })
    expect(patch.status).toBe(200)
    expect((await deps.users.findById(TENANT.environmentId, id))?.bannedAt).not.toBeNull()
  })

  test('a create that repairs an operator-banned account does not lift the ban', async () => {
    const insert = spyOn(deps.scim, 'insertUser').mockImplementationOnce(async () => {
      throw new Error('crash')
    })
    const gone = spyOn(deps.users, 'delete').mockImplementationOnce(async () => {
      throw new Error('crash again')
    })
    await scim('POST', '/Users', okta('banned@acme.test'))
    insert.mockRestore()
    gone.mockRestore()
    const orphan = await deps.users.findByEmail(TENANT.environmentId, 'banned@acme.test')
    await Users.ban(deps, TENANT, orphan?.id ?? '', TEST_ACTOR)
    const retry = await scim('POST', '/Users', okta('banned@acme.test'))
    expect(retry.status).toBe(201)
    expect(
      (await deps.users.findById(TENANT.environmentId, retry.body.id))?.bannedAt
    ).not.toBeNull()
  })

  test('PUT with active false deactivates', async () => {
    const id = await provision()
    const res = await scim('PUT', `/Users/${id}`, okta('maya@acme.test', { active: false }))
    expect(res.body.active).toBe(false)
    expect(await members(id)).toBe(0)
  })

  test('an unmanaged user is never banned and keeps their sessions; delete leaves the account', async () => {
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

describe('create is one unit, and a directory rename reaches the user', () => {
  test('a racing duplicate externalId leaves no orphan account', async () => {
    const spy = spyOn(deps.scim, 'insertUser').mockImplementationOnce(
      async () => 'external_id_taken'
    )
    const res = await scim('POST', '/Users', okta('race@acme.test'))
    spy.mockRestore()
    expect(res.body).toMatchObject({ status: '409', scimType: 'uniqueness' })
    expect(await deps.users.findByEmail(TENANT.environmentId, 'race@acme.test')).toBeNull()
    // The retry works: nothing is left to collide with.
    expect((await scim('POST', '/Users', okta('race@acme.test'))).status).toBe(201)
  })

  test('PUT applies the names of a managed user and leaves the address', async () => {
    const id = await provision()
    const res = await scim(
      'PUT',
      `/Users/${id}`,
      okta('maya@acme.test', { name: { givenName: 'Maya', familyName: 'Lindqvist' } })
    )
    expect(res.status).toBe(200)
    expect(res.body.name).toMatchObject({ familyName: 'Lindqvist' })
    const user = await deps.users.findById(TENANT.environmentId, id)
    expect(user?.lastName).toBe('Lindqvist')
    expect(user?.email).toBe('maya@acme.test')
  })

  test('PATCH applies name.givenName by path and name inside an object, and records names only', async () => {
    const id = await provision()
    await scim('PATCH', `/Users/${id}`, {
      Operations: [{ op: 'Replace', path: 'name.givenName', value: 'Mayaa' }],
    })
    await scim('PATCH', `/Users/${id}`, {
      Operations: [{ op: 'replace', value: { name: { familyName: 'Okoro' } } }],
    })
    const user = await deps.users.findById(TENANT.environmentId, id)
    expect([user?.firstName, user?.lastName]).toEqual(['Mayaa', 'Okoro'])
    const entries = (
      await deps.activityLog.listAudit(TENANT.environmentId, { page: 1, size: 100 })
    ).entries.filter((entry) => entry.type === 'user.scim_updated')
    expect(entries).toHaveLength(2)
    expect(JSON.stringify(entries)).not.toContain('Okoro')
  })

  test('an account the directory only linked keeps its names', async () => {
    const existing = await Users.create(
      deps,
      TENANT,
      { email: 'lee@acme.test', emailVerified: true, firstName: 'Lee' },
      TEST_ACTOR
    )
    await scim('POST', '/Users', okta('lee@acme.test'))
    await scim('PUT', `/Users/${existing.id}`, okta('lee@acme.test', { name: { givenName: 'X' } }))
    expect((await deps.users.findById(TENANT.environmentId, existing.id))?.firstName).toBe('Lee')
  })
})

describe('the default role is the connection’s (DECISIONS 10)', () => {
  async function connection(status: 'active' | 'draft', defaultRole: string, tested: boolean) {
    const now = deps.clock.now()
    await deps.ssoConnections.insert(
      {
        id: Bun.randomUUIDv7(),
        ...TENANT,
        organizationId: orgId,
        protocol: 'oidc',
        saml: null,
        name: `c-${defaultRole}-${status}-${tested}`,
        status,
        issuer: 'https://idp.example',
        clientId: 'c',
        clientSecretSealed: 's',
        attributeMapping: null,
        defaultRole,
        enforced: false,
        breakGlassRole: null,
        trustIdpMfa: false,
        domains: [],
        testedFingerprint: tested ? 'f' : null,
        createdAt: now,
        updatedAt: now,
      },
      Audit.none('fixture')
    )
  }
  const roleOf = async (userId: string) =>
    (await deps.organizations.findMembership(TENANT.environmentId, orgId, userId))?.roleKey
  const viewer = () =>
    OrganizationRoles.create(
      deps,
      TENANT,
      { key: 'viewer', name: 'Viewer', permissions: [] },
      TEST_ACTOR
    )

  test('a provisioned member gets the active connection’s default role, mapped groups or not', async () => {
    await viewer()
    await connection('active', 'viewer', true)
    expect(await roleOf(await provision('a@acme.test'))).toBe('viewer')
    await deps.ssoConnections.replaceGroupRoles(
      { ...TENANT, organizationId: orgId, mappings: [{ group: 'Admins', role: 'admin' }] },
      deps.clock.now(),
      Audit.none('fixture')
    )
    const id = await provision('b@acme.test')
    const other = await scim('POST', '/Groups', {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
      displayName: 'Other',
      members: [{ value: id }],
    })
    expect(other.status).toBe(201)
    expect(await roleOf(id)).toBe('viewer')
  })

  test('no active connection: the latest tested one; none at all: member', async () => {
    expect(await roleOf(await provision('a@acme.test'))).toBe('member')
    await viewer()
    await connection('draft', 'viewer', false)
    expect(await roleOf(await provision('b@acme.test'))).toBe('member')
    await connection('draft', 'viewer', true)
    expect(await roleOf(await provision('c@acme.test'))).toBe('viewer')
  })
})

describe('a directory renames the address of an account it manages (DECISIONS 14)', () => {
  const emailOf = async (id: string) => (await deps.users.findById(TENANT.environmentId, id))?.email

  test('PUT and PATCH change it on a verified domain, audited without the address, sessions kept', async () => {
    const id = await provision('maya@acme.test')
    const put = await scim('PUT', `/Users/${id}`, okta('maya.o@acme.test'))
    expect(put.status).toBe(200)
    expect(put.body.userName).toBe('maya.o@acme.test')
    expect(await emailOf(id)).toBe('maya.o@acme.test')
    const patch = await scim('PATCH', `/Users/${id}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'Replace', path: 'userName', value: 'maya.k@acme.test' }],
    })
    expect(patch.body.userName).toBe('maya.k@acme.test')
    const entries = (await deps.activityLog.listAudit(TENANT.environmentId, { page: 1, size: 100 }))
      .entries
    expect(entries.map((e) => e.type)).toContain('user.scim_updated')
    expect(JSON.stringify(entries)).not.toContain('maya.k@acme.test')
  })

  test('off the verified domains it is a 400 and nothing changes; a taken address is a 409', async () => {
    const id = await provision('maya@acme.test')
    await provision('lee@acme.test')
    const off = await scim('PUT', `/Users/${id}`, okta('maya@elsewhere.test'))
    expect(off.status).toBe(400)
    const taken = await scim('PUT', `/Users/${id}`, okta('lee@acme.test'))
    expect(taken.body).toMatchObject({ status: '409', scimType: 'uniqueness' })
    expect(await emailOf(id)).toBe('maya@acme.test')
  })

  test('a request refused for an externalId another user holds stores no new address', async () => {
    const id = await provision('maya@acme.test')
    await provision('lee@acme.test')
    const res = await scim(
      'PUT',
      `/Users/${id}`,
      okta('maya.o@acme.test', { externalId: 'ext-lee@acme.test' })
    )
    expect(res.status).toBe(409)
    expect(await emailOf(id)).toBe('maya@acme.test')
  })

  test('a deactivation sent with an off-domain userName still takes effect', async () => {
    const id = await provision('maya@acme.test')
    const res = await scim('PUT', `/Users/${id}`, okta('maya@elsewhere.test', { active: false }))
    expect(res.status).toBe(200)
    expect(res.body.active).toBe(false)
    expect(await members(id)).toBe(0)
    expect(await emailOf(id)).toBe('maya@acme.test')
  })

  test('an account the directory only linked keeps its address', async () => {
    const existing = await Users.create(
      deps,
      TENANT,
      { email: 'lee@acme.test', emailVerified: true },
      TEST_ACTOR
    )
    const id = (await scim('POST', '/Users', okta('lee@acme.test'))).body.id as string
    expect(id).toBe(existing.id)
    const put = await scim('PUT', `/Users/${id}`, okta('lee2@acme.test'))
    expect(put.status).toBe(200)
    expect(await emailOf(id)).toBe('lee@acme.test')
  })
})

describe('create converges after a crash, and resources say where they are', () => {
  test('an account left without a SCIM row is completed by the retry, not 409 for ever', async () => {
    const insert = spyOn(deps.scim, 'insertUser').mockImplementationOnce(async () => {
      throw new Error('crash')
    })
    const gone = spyOn(deps.users, 'delete').mockImplementationOnce(async () => {
      throw new Error('crash again')
    })
    const first = await scim('POST', '/Users', okta('orphan@acme.test'))
    insert.mockRestore()
    gone.mockRestore()
    expect(first.status).toBe(500)
    const orphan = await deps.users.findByEmail(TENANT.environmentId, 'orphan@acme.test')
    expect(orphan).not.toBeNull()
    const retry = await scim('POST', '/Users', okta('orphan@acme.test'))
    expect(retry.status).toBe(201)
    expect(retry.body.id).toBe(orphan?.id)
    expect(await members(retry.body.id)).toBe(1)
  })

  test.each([
    ['refused', () => async () => 'external_id_taken' as const],
    [
      'throws',
      () => async () => {
        throw new Error('crash')
      },
    ],
  ])(
    'a repaired account that belongs to another organization survives an insert that %s',
    async (_name, impl) => {
      const id = await provision('kept@acme.test')
      const other = await Organizations.create(deps, TENANT, { name: 'B', slug: 'bee' }, TEST_ACTOR)
      await Organizations.addMember(
        deps,
        TENANT,
        other.id,
        { userId: id, role: 'member' },
        TEST_ACTOR
      )
      // The directory deletes her: kept for B, only the SCIM row goes.
      expect((await scim('DELETE', `/Users/${id}`)).status).toBe(204)
      const insert = spyOn(deps.scim, 'insertUser').mockImplementationOnce(impl() as never)
      const retry = await scim('POST', '/Users', okta('kept@acme.test'))
      insert.mockRestore()
      expect(retry.status).not.toBe(201)
      expect(await deps.users.findById(TENANT.environmentId, id)).not.toBeNull()
      expect(await members(id)).toBe(1)
    }
  )

  test('a User and a Group carry meta.location under PUBLIC_URL', async () => {
    const id = await provision()
    const user = await scim('GET', `/Users/${id}`)
    expect(user.body.meta.location).toBe(`${deps.config.publicUrl}/v1/scim/v2/Users/${id}`)
    const group = await scim('POST', '/Groups', {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
      displayName: 'Eng',
    })
    expect(group.body.meta.location).toBe(
      `${deps.config.publicUrl}/v1/scim/v2/Groups/${group.body.id}`
    )
  })
})
