import { beforeEach, describe, expect, test } from 'bun:test'
import { DEFAULT_ENVIRONMENT_SETTINGS } from '@tula-tech/contract'
import { createApp } from '~/index'
import * as Audit from '~/modules/audit/service'
import * as Organizations from '~/modules/organization/service'
import * as ScimTokens from '~/modules/scim-token/service'
import { createInstanceTestDeps, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'

const TENANT = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }
const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User'
const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group'
// A name nothing else in a response, entry or event may repeat.
const CANARY = 'Canary-Group-7f3a'

let deps: TestDeps
let orgId: string
let token: string

async function scim(method: string, path: string, body?: unknown) {
  const res = await createApp(deps).request(`/v1/scim/v2${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/scim+json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

async function provision(userName: string) {
  const res = await scim('POST', '/Users', {
    schemas: [USER_SCHEMA],
    userName,
    emails: [{ value: userName, primary: true }],
    externalId: `ext-${userName}`,
    active: true,
  })
  expect(res.status).toBe(201)
  return res.body.id as string
}

async function mapGroups(mappings: Array<{ group: string; role: string }>) {
  await deps.ssoConnections.replaceGroupRoles(
    { ...TENANT, organizationId: orgId, mappings },
    deps.clock.now(),
    Audit.none('fixture')
  )
}

const roleOf = async (userId: string) =>
  (await deps.organizations.findMembership(TENANT.environmentId, orgId, userId))?.roleKey

const group = (displayName: string, memberIds: string[] = []) => ({
  schemas: [GROUP_SCHEMA],
  displayName,
  members: memberIds.map((value) => ({ value })),
})

beforeEach(async () => {
  deps = createInstanceTestDeps()
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
      organizations: { ...DEFAULT_ENVIRONMENT_SETTINGS.organizations, enabled: true },
    } as never,
  })
  orgId = (await Organizations.create(deps, TENANT, { name: 'Acme', slug: 'acme' }, TEST_ACTOR)).id
  token = (
    await ScimTokens.create(deps, TENANT, { organizationId: orgId, name: 'Okta' }, TEST_ACTOR)
  ).token
})

describe('SCIM Groups: CRUD, Okta shape', () => {
  test('create, get, filter, list and delete', async () => {
    const maya = await provision('maya@acme.test')
    const created = await scim('POST', '/Groups', group('Engineering', [maya]))
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({
      schemas: [GROUP_SCHEMA],
      displayName: 'Engineering',
      members: [{ value: maya }],
      meta: { resourceType: 'Group' },
    })
    const id = created.body.id as string
    expect((await scim('GET', `/Groups/${id}`)).body.displayName).toBe('Engineering')
    const found = await scim('GET', '/Groups?filter=displayName%20eq%20%22Engineering%22')
    expect(found.body.totalResults).toBe(1)
    expect(
      (await scim('GET', '/Groups?filter=displayName%20eq%20%22Nope%22')).body.totalResults
    ).toBe(0)
    expect((await scim('GET', '/Groups')).body.totalResults).toBe(1)
    expect((await scim('DELETE', `/Groups/${id}`)).status).toBe(204)
    expect((await scim('GET', `/Groups/${id}`)).status).toBe(404)
  })

  test('a taken name is 409 uniqueness, an unknown member 400, an odd filter 400', async () => {
    await scim('POST', '/Groups', group('Engineering'))
    const dup = await scim('POST', '/Groups', group('Engineering'))
    expect(dup.status).toBe(409)
    expect(dup.body.scimType).toBe('uniqueness')
    const stranger = await scim('POST', '/Groups', group('Other', [Bun.randomUUIDv7()]))
    expect(stranger.status).toBe(400)
    expect((await scim('GET', '/Groups?filter=members%20pr')).status).toBe(400)
  })

  test('excludedAttributes=members (Entra) leaves members out of a list', async () => {
    const maya = await provision('maya@acme.test')
    await scim('POST', '/Groups', group('Engineering', [maya]))
    const list = await scim('GET', '/Groups?excludedAttributes=members')
    expect(list.body.Resources[0].members).toBeUndefined()
  })

  test('discovery advertises Groups', async () => {
    const types = await scim('GET', '/ResourceTypes')
    expect(types.body.Resources.map((r: { id: string }) => r.id)).toContain('Group')
    const schemas = await scim('GET', '/Schemas')
    expect(schemas.body.Resources.map((r: { id: string }) => r.id)).toContain(GROUP_SCHEMA)
  })

  test('a group of another organization is not found', async () => {
    const other = await Organizations.create(deps, TENANT, { name: 'B', slug: 'b' }, TEST_ACTOR)
    const created = await scim('POST', '/Groups', group('Engineering'))
    const otherToken = (
      await ScimTokens.create(deps, TENANT, { organizationId: other.id, name: 'x' }, TEST_ACTOR)
    ).token
    const res = await createApp(deps).request(`/v1/scim/v2/Groups/${created.body.id}`, {
      headers: { authorization: `Bearer ${otherToken}` },
    })
    expect(res.status).toBe(404)
  })
})

describe('SCIM Groups: patch shapes', () => {
  test('Entra: members add and remove with value arrays, op in any case', async () => {
    const a = await provision('a@acme.test')
    const b = await provision('b@acme.test')
    const id = (await scim('POST', '/Groups', group('Engineering'))).body.id as string
    const added = await scim('PATCH', `/Groups/${id}`, {
      Operations: [{ op: 'Add', path: 'members', value: [{ value: a }, { value: b }] }],
    })
    expect(added.body.members).toHaveLength(2)
    const removed = await scim('PATCH', `/Groups/${id}`, {
      Operations: [{ op: 'REMOVE', path: 'members', value: [{ value: a }] }],
    })
    expect(removed.body.members).toEqual([{ value: b }])
  })

  test('Okta: a filtered path removes one member; replace and displayName work', async () => {
    const a = await provision('a@acme.test')
    const id = (await scim('POST', '/Groups', group('Engineering', [a]))).body.id as string
    const renamed = await scim('PATCH', `/Groups/${id}`, {
      Operations: [
        { op: 'replace', path: 'displayName', value: 'Platform' },
        { op: 'remove', path: `members[value eq "${a}"]` },
      ],
    })
    expect(renamed.body.displayName).toBe('Platform')
    expect(renamed.body.members).toEqual([])
    const put = await scim('PUT', `/Groups/${id}`, group('Platform', [a]))
    expect(put.body.members).toEqual([{ value: a }])
  })

  test('an unknown op is 400', async () => {
    const id = (await scim('POST', '/Groups', group('Engineering'))).body.id as string
    const res = await scim('PATCH', `/Groups/${id}`, { Operations: [{ op: 'move', path: 'x' }] })
    expect(res.status).toBe(400)
  })
})

describe('SCIM Groups: roles', () => {
  test('a mapped group gives its members the role; leaving takes it back', async () => {
    const a = await provision('a@acme.test')
    await mapGroups([{ group: 'Admins', role: 'admin' }])
    const id = (await scim('POST', '/Groups', group('Admins', [a]))).body.id as string
    expect(await roleOf(a)).toBe('admin')
    await scim('PATCH', `/Groups/${id}`, {
      Operations: [{ op: 'remove', path: 'members', value: [{ value: a }] }],
    })
    // Another manager would be needed to demote the only one: here a is the last manager.
    expect(await roleOf(a)).toBe('admin')
  })

  test('with a second manager, leaving a mapped group demotes to member', async () => {
    const a = await provision('a@acme.test')
    const boss = await provision('boss@acme.test')
    await Organizations.changeMemberRole(deps, TENANT, orgId, boss, { role: 'admin' }, TEST_ACTOR)
    await mapGroups([{ group: 'Admins', role: 'admin' }])
    const id = (await scim('POST', '/Groups', group('Admins', [a]))).body.id as string
    expect(await roleOf(a)).toBe('admin')
    await scim('DELETE', `/Groups/${id}`)
    expect(await roleOf(a)).toBe('member')
  })

  test('first mapping in saved order wins, as for an SSO sign-in', async () => {
    const a = await provision('a@acme.test')
    const boss = await provision('boss@acme.test')
    await Organizations.changeMemberRole(deps, TENANT, orgId, boss, { role: 'admin' }, TEST_ACTOR)
    await mapGroups([
      { group: 'Admins', role: 'admin' },
      { group: 'Staff', role: 'member' },
    ])
    await scim('POST', '/Groups', group('Staff', [a]))
    await scim('POST', '/Groups', group('Admins', [a]))
    expect(await roleOf(a)).toBe('admin')
  })

  test('an unmapped group changes no role', async () => {
    const a = await provision('a@acme.test')
    await scim('POST', '/Groups', group('Whatever', [a]))
    expect(await roleOf(a)).toBe('member')
  })

  test('removing the last manager through a group is 409 and nothing changes', async () => {
    const boss = await provision('boss@acme.test')
    const a = await provision('a@acme.test')
    await Organizations.changeMemberRole(deps, TENANT, orgId, boss, { role: 'admin' }, TEST_ACTOR)
    await mapGroups([{ group: 'Admins', role: 'admin' }])
    const id = (await scim('POST', '/Groups', group('Admins', [boss]))).body.id as string
    const res = await scim('PATCH', `/Groups/${id}`, {
      Operations: [
        { op: 'add', path: 'members', value: [{ value: a }] },
        { op: 'replace', path: 'displayName', value: 'Renamed' },
      ],
    })
    expect(res.status).toBe(409)
    expect(res.body.status).toBe('409')
    const after = await scim('GET', `/Groups/${id}`)
    expect(after.body.displayName).toBe('Admins')
    expect(after.body.members).toEqual([{ value: boss }])
    expect(await roleOf(boss)).toBe('admin')
    expect(await roleOf(a)).toBe('member')
    expect((await scim('DELETE', `/Groups/${id}`)).status).toBe(409)
    expect((await scim('GET', `/Groups/${id}`)).status).toBe(200)
  })

  test('a group name never reaches an audit entry or event', async () => {
    const a = await provision('a@acme.test')
    const id = (await scim('POST', '/Groups', group(CANARY, [a]))).body.id as string
    await scim('PATCH', `/Groups/${id}`, {
      Operations: [{ op: 'replace', path: 'displayName', value: `${CANARY}-2` }],
    })
    await scim('DELETE', `/Groups/${id}`)
    const entries = await deps.activityLog.listAudit(TENANT.environmentId, { page: 1, size: 200 })
    const types = entries.entries.map((e) => e.type)
    expect(types).toEqual(
      expect.arrayContaining(['scim_group.created', 'scim_group.updated', 'scim_group.deleted'])
    )
    expect(JSON.stringify(entries)).not.toContain('Canary-Group')
  })
})
