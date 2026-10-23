import { beforeEach, describe, expect, test } from 'bun:test'
import {
  BUILT_IN_ROLES,
  DEFAULT_ENVIRONMENT_SETTINGS,
  EVENT_SCHEMAS,
  MAX_CUSTOM_ROLES,
  MAX_PERMISSIONS_PER_ROLE,
  type Organization,
  type OrganizationMembership,
  type OrganizationRole,
  type OrganizationRoleList,
  type User,
} from '@tula-tech/contract'
import { createApp } from '~/index'
import { createTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'
import { comparable } from '~/testing/comparable'

const SK = 'tula_sk_dev_secret000000000000000000000000'
const PROD_SK = 'tula_sk_live_secret00000000000000000000000'
const AK = 'tula_ak_dev_agent000000000000000000000000000000'
const PK = 'tula_pk_dev_publishable0000000000000000000'

let deps: TestDeps
let app: ReturnType<typeof createApp>

/** Switch organizations on (or off) for an environment. */
function enable(environmentId: string = TEST_TENANT.environmentId, enabled = true) {
  deps.environmentSettings.seed(environmentId, {
    revision: 1,
    settings: {
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      organizations: { ...DEFAULT_ENVIRONMENT_SETTINGS.organizations, enabled },
    },
  })
}

beforeEach(async () => {
  deps = createTestDeps()
  for (const [id, kind] of [
    [TEST_TENANT.environmentId, 'development'],
    [TEST_TENANT.productionEnvironmentId, 'production'],
  ] as const) {
    deps.environments.add({
      id,
      projectId: TEST_TENANT.projectId,
      kind,
      createdAt: deps.clock.now(),
    })
  }
  await seedApiKey(deps, SK)
  await seedApiKey(deps, AK)
  await seedApiKey(deps, PK)
  await seedApiKey(deps, PROD_SK, { environmentId: TEST_TENANT.productionEnvironmentId })
  app = createApp(deps)
  enable()
})

function call(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  key: string | null = SK,
  headers: Record<string, string> = {}
) {
  return app.request(`${base}${path}`, {
    method,
    headers: {
      ...(key && { authorization: `Bearer ${key}` }),
      ...(body !== undefined && { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const roles = (
  method: string,
  path = '',
  body?: unknown,
  key: string | null = SK,
  headers: Record<string, string> = {}
) => call('/v1/admin/organization-roles', method, path, body, key, headers)

const orgs = (method: string, path = '', body?: unknown, key: string | null = SK) =>
  call('/v1/admin/organizations', method, path, body, key)

const json = async <T>(res: Response) => (await res.json()) as T
const body = async (res: Response) => json<{ code: string; params?: Record<string, unknown> }>(res)
const code = async (res: Response) => (await body(res)).code
const ifMatch = (version: number) => ({ 'if-match': `"${version}"` })

const BILLING = { key: 'billing', name: 'Billing', permissions: ['org:billing:read'] }

async function define(
  input: Record<string, unknown> = BILLING,
  key: string = SK
): Promise<OrganizationRole> {
  const res = await roles('POST', '', input, key)
  expect(res.status).toBe(201)
  return json<OrganizationRole>(res)
}

async function organization(slug = 'acme'): Promise<Organization> {
  const res = await orgs('POST', '', { name: 'Acme Corp', slug })
  expect(res.status).toBe(201)
  return json<Organization>(res)
}

async function user(email = 'maya@northline.app'): Promise<User> {
  const res = await call('/v1/admin/users', 'POST', '', { email })
  expect(res.status).toBe(201)
  return json<User>(res)
}

async function join(org: Organization, userId: string, role: string) {
  const res = await orgs('POST', `/${org.id}/memberships`, { userId, role })
  expect(res.status).toBe(201)
  return json<OrganizationMembership>(res)
}

const roleEntries = () =>
  deps.activityLog.entries.filter((entry) => entry.type.startsWith('organization_role'))
const roleActions = () => roleEntries().map((entry) => entry.type)

describe('organizations switched off', () => {
  test.each([
    ['GET', ''],
    ['POST', ''],
    ['GET', '/billing'],
    ['PATCH', '/billing'],
    ['DELETE', '/billing'],
  ])('%s %s answers organization.disabled and touches nothing', async (method, path) => {
    enable(TEST_TENANT.environmentId, false)
    const payload = method === 'POST' ? BILLING : method === 'PATCH' ? { name: 'New' } : undefined
    const res = await roles(method, path, payload, SK, method === 'PATCH' ? ifMatch(1) : {})
    expect(res.status).toBe(403)
    expect(await code(res)).toBe('organization.disabled')
    expect(roleActions()).toEqual([])
    expect(await deps.organizations.listRoles(TEST_TENANT.environmentId)).toEqual([])
  })
})

describe('credentials', () => {
  test.each([
    ['no key', null],
    ['a publishable key', PK],
    ['a key that does not exist', 'tula_sk_dev_nonsense0000000000000000000000'],
  ])('%s is refused', async (_name, key) => {
    expect((await roles('GET', '', undefined, key)).status).toBe(401)
  })

  test('an agent key reads and is refused every write', async () => {
    await define()
    expect((await roles('GET', '', undefined, AK)).status).toBe(200)
    expect((await roles('GET', '/billing', undefined, AK)).status).toBe(200)
    const before = roleActions().length
    for (const [method, path, payload, headers] of [
      ['POST', '', { ...BILLING, key: 'other' }, {}],
      ['PATCH', '/billing', { name: 'Hijacked' }, ifMatch(1)],
      ['DELETE', '/billing', undefined, {}],
    ] as const) {
      const res = await roles(method, path, payload, AK, headers)
      expect(res.status).toBe(401)
      expect(await code(res)).toBe('auth.invalid_key')
    }
    expect(roleActions().length).toBe(before)
    expect((await roles('GET', '/billing')).status).toBe(200)
  })
})

describe('GET /v1/admin/organization-roles', () => {
  test('lists the built-in roles first, then the custom ones by key, and creates the built-ins on first use', async () => {
    expect(await deps.organizations.listRoles(TEST_TENANT.environmentId)).toEqual([])
    await define({ ...BILLING, key: 'zeta' })
    await define({ ...BILLING, key: 'alpha' })
    const list = await json<OrganizationRoleList>(await roles('GET'))
    expect(list.data.map((role) => role.key)).toEqual(['admin', 'member', 'alpha', 'zeta'])
    const [admin, member] = list.data
    expect(admin).toMatchObject({ builtIn: true, version: 1 })
    expect(admin?.permissions).toEqual([...(BUILT_IN_ROLES[0]?.permissions ?? [])].sort())
    expect(member?.permissions).toEqual(['org:sys:memberships:read'])
    expect(list.data.slice(2).every((role) => !role.builtIn)).toBe(true)
  })

  test('reads one role by key, with its version as the ETag, and a built-in one too', async () => {
    const created = await define()
    const res = await roles('GET', '/billing')
    expect(res.status).toBe(200)
    expect(res.headers.get('etag')).toBe('"1"')
    expect(await json<OrganizationRole>(res)).toEqual(created)
    expect((await roles('GET', '/admin')).status).toBe(200)
    expect((await roles('GET', '/nobody')).status).toBe(404)
    expect((await roles('GET', '/Not-A-Key')).status).toBe(422)
  })
})

describe('POST /v1/admin/organization-roles', () => {
  test('defines a role at version 1 with sorted permissions and records it', async () => {
    const created = await define({
      key: 'billing',
      name: 'Billing',
      permissions: ['org:billing:write', 'org:billing:read', 'org:sys:memberships:manage'],
    })
    expect(created).toMatchObject({
      key: 'billing',
      name: 'Billing',
      builtIn: false,
      version: 1,
      permissions: ['org:billing:read', 'org:billing:write', 'org:sys:memberships:manage'],
    })
    expect(Object.keys(created).sort()).toEqual(
      ['builtIn', 'createdAt', 'id', 'key', 'name', 'permissions', 'updatedAt', 'version'].sort()
    )
    expect(roleActions()).toEqual(['organization_role.created'])
    const entry = roleEntries()[0]
    expect(entry?.actor.type).toBe('admin')
    expect(entry?.target).toEqual({ type: 'organization_role', id: created.id })
    expect(entry?.data).toEqual({ role: 'billing', permissions: 3 })
  })

  test('is answered with the version as an ETag', async () => {
    const res = await roles('POST', '', BILLING)
    expect(res.headers.get('etag')).toBe('"1"')
  })

  test.each([
    ['a key of a built-in role', { ...BILLING, key: 'admin' }],
    ['another built-in key', { ...BILLING, key: 'member' }],
  ])(
    'refuses %s as taken, in an environment that has no built-in row yet',
    async (_name, input) => {
      const res = await roles('POST', '', input)
      expect(res.status).toBe(409)
      expect(await code(res)).toBe('organization.role_exists')
      expect(roleActions()).toEqual([])
      expect(await deps.organizations.listRoles(TEST_TENANT.environmentId)).toEqual([])
    }
  )

  test('refuses a key that is taken, and records nothing more', async () => {
    await define()
    const res = await roles('POST', '', { ...BILLING, name: 'Again' })
    expect(res.status).toBe(409)
    expect(await code(res)).toBe('organization.role_exists')
    expect(roleActions()).toEqual(['organization_role.created'])
  })

  test('the same key is free in another environment', async () => {
    await define()
    enable(TEST_TENANT.productionEnvironmentId)
    const theirs = await define(BILLING, PROD_SK)
    expect(theirs.key).toBe('billing')
  })

  test.each([
    ['an upper-case key', { ...BILLING, key: 'Billing' }],
    ['a key that starts with a digit', { ...BILLING, key: '1billing' }],
    ['a key with a hyphen', { ...BILLING, key: 'bill-ing' }],
    ['a key of 33 characters', { ...BILLING, key: 'a'.repeat(33) }],
    ['no key', { name: 'Billing', permissions: [] }],
    ['an empty name', { ...BILLING, name: '  ' }],
    ['a name with a control character', { ...BILLING, name: 'Bill\u0007ing' }],
    ['a name of 101 characters', { ...BILLING, name: 'a'.repeat(101) }],
    ['no permissions list', { key: 'billing', name: 'Billing' }],
    ['a permission with a dot', { ...BILLING, permissions: ['billing.read'] }],
    ['a permission with an upper-case letter', { ...BILLING, permissions: ['org:Billing:read'] }],
    ['a permission of one segment', { ...BILLING, permissions: ['org:billing'] }],
    ['a permission of four segments outside sys', { ...BILLING, permissions: ['org:a:b:c'] }],
    ['an unknown system permission', { ...BILLING, permissions: ['org:sys:billing:read'] }],
    ['the reserved feature on its own', { ...BILLING, permissions: ['org:sys:read'] }],
    ['a permission twice', { ...BILLING, permissions: ['org:a:b', 'org:a:b'] }],
    ['a permission that is not a string', { ...BILLING, permissions: [1] }],
    ['a field it does not know', { ...BILLING, builtIn: true }],
  ])('refuses %s', async (_name, input) => {
    const res = await roles('POST', '', input)
    expect(res.status).toBe(422)
    expect(await code(res)).toBe('validation.failed')
    expect(roleActions()).toEqual([])
  })

  test('holds at most 32 permissions', async () => {
    const keys = (n: number) => Array.from({ length: n }, (_, i) => `org:feature${i}:read`)
    expect(
      (
        await roles('POST', '', {
          ...BILLING,
          key: 'full',
          permissions: keys(MAX_PERMISSIONS_PER_ROLE),
        })
      ).status
    ).toBe(201)
    const res = await roles('POST', '', {
      ...BILLING,
      key: 'over',
      permissions: keys(MAX_PERMISSIONS_PER_ROLE + 1),
    })
    expect(res.status).toBe(422)
    expect(roleActions()).toEqual(['organization_role.created'])
  })

  test('refuses the 51st custom role, and a deleted one makes room', async () => {
    for (let n = 0; n < MAX_CUSTOM_ROLES; n += 1) {
      await define({ ...BILLING, key: `role${n}` })
    }
    const over = await roles('POST', '', { ...BILLING, key: 'one_more' })
    expect(over.status).toBe(409)
    const refusal = await body(over)
    expect(refusal.code).toBe('organization.role_limit')
    expect(refusal.params).toEqual({ max: MAX_CUSTOM_ROLES })
    // The built-in roles do not count against the cap.
    expect((await json<OrganizationRoleList>(await roles('GET'))).data).toHaveLength(
      MAX_CUSTOM_ROLES + 2
    )
    // A key that is taken is still reported as taken when the environment is full.
    expect(await code(await roles('POST', '', { ...BILLING, key: 'role0' }))).toBe(
      'organization.role_exists'
    )
    expect((await roles('DELETE', '/role0')).status).toBe(204)
    expect((await roles('POST', '', { ...BILLING, key: 'one_more' })).status).toBe(201)
  })

  test('the cap holds for definitions that arrive together', async () => {
    for (let n = 0; n < MAX_CUSTOM_ROLES - 1; n += 1) {
      await define({ ...BILLING, key: `role${n}` })
    }
    const results = await Promise.all(
      ['late_a', 'late_b', 'late_c'].map((key) => roles('POST', '', { ...BILLING, key }))
    )
    expect(results.map((res) => res.status).sort()).toEqual([201, 409, 409])
  })

  test('is taken under the environment’s lock for roles', async () => {
    const calls: unknown[][] = []
    const run = deps.environmentLock.runExclusive.bind(deps.environmentLock)
    deps.environmentLock.runExclusive = (...args) => {
      calls.push(args.slice(0, 2))
      return run(...args)
    }
    await define()
    expect(calls).toEqual([[TEST_TENANT.environmentId, 'organization_roles']])
  })
})

describe('PATCH /v1/admin/organization-roles/:key', () => {
  test('renames, replaces the permissions, bumps the version and records names and a count only', async () => {
    const created = await define()
    deps.clock.advance('1m')
    const res = await roles(
      'PATCH',
      '/billing',
      { name: 'Billing team', permissions: ['org:billing:write', 'org:billing:read'] },
      SK,
      ifMatch(1)
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('etag')).toBe('"2"')
    const updated = await json<OrganizationRole>(res)
    expect(updated).toMatchObject({
      id: created.id,
      key: 'billing',
      name: 'Billing team',
      permissions: ['org:billing:read', 'org:billing:write'],
      version: 2,
    })
    expect(updated.updatedAt).not.toBe(created.updatedAt)
    const entry = roleEntries().at(-1)
    expect(entry?.type).toBe('organization_role.updated')
    expect(entry?.data).toEqual({
      role: 'billing',
      changed: ['name', 'permissions'],
      permissions: 2,
      weakened: true,
    })
    const text = JSON.stringify(entry)
    expect(text).not.toContain('Billing team')
    expect(text).not.toContain('org:billing')
  })

  test('says weakened only when the role gained a permission', async () => {
    await define({ ...BILLING, permissions: ['org:billing:read', 'org:billing:write'] })
    await roles('PATCH', '/billing', { permissions: ['org:billing:read'] }, SK, ifMatch(1))
    expect(roleEntries().at(-1)?.data).toEqual({
      role: 'billing',
      changed: ['permissions'],
      permissions: 1,
    })
    await roles('PATCH', '/billing', { name: 'Renamed' }, SK, ifMatch(2))
    expect(roleEntries().at(-1)?.data).toEqual({
      role: 'billing',
      changed: ['name'],
      permissions: 1,
    })
    await roles(
      'PATCH',
      '/billing',
      { permissions: ['org:billing:read', 'org:x:y'] },
      SK,
      ifMatch(3)
    )
    expect(roleEntries().at(-1)?.data).toMatchObject({ weakened: true })
  })

  test('a request that changes nothing writes nothing and keeps the version', async () => {
    const created = await define()
    const res = await roles(
      'PATCH',
      '/billing',
      { name: created.name, permissions: [...created.permissions].reverse() },
      SK,
      ifMatch(1)
    )
    expect(res.status).toBe(200)
    expect(await json<OrganizationRole>(res)).toEqual(created)
    expect(roleActions()).toEqual(['organization_role.created'])
  })

  test('needs If-Match: without it 428, with a malformed one 412', async () => {
    await define()
    const missing = await roles('PATCH', '/billing', { name: 'x' })
    expect(missing.status).toBe(428)
    expect(await code(missing)).toBe('precondition.required')
    for (const value of ['1', '*', 'W/"1"', '"-1"', '"abc"']) {
      const res = await roles('PATCH', '/billing', { name: 'x' }, SK, { 'if-match': value })
      expect(res.status).toBe(412)
    }
    expect(roleActions()).toEqual(['organization_role.created'])
  })

  test('over a stale version is refused with the current one, and nothing is written', async () => {
    await define()
    await roles('PATCH', '/billing', { name: 'First' }, SK, ifMatch(1))
    const res = await roles('PATCH', '/billing', { name: 'Second' }, SK, ifMatch(1))
    expect(res.status).toBe(412)
    const refusal = await body(res)
    expect(refusal.code).toBe('precondition.failed')
    expect(refusal.params).toEqual({ version: 2 })
    expect(await json<OrganizationRole>(await roles('GET', '/billing'))).toMatchObject({
      name: 'First',
      version: 2,
    })
    expect(roleActions()).toEqual(['organization_role.created', 'organization_role.updated'])
  })

  test('of two changes over one version at once exactly one is written', async () => {
    await define()
    const results = await Promise.all(
      ['One', 'Two'].map((name) => roles('PATCH', '/billing', { name }, SK, ifMatch(1)))
    )
    expect(results.map((res) => res.status).sort()).toEqual([200, 412])
  })

  test.each(['admin', 'member'])('refuses to change the built-in role %s', async (key) => {
    const res = await roles('PATCH', `/${key}`, { permissions: [] }, SK, ifMatch(1))
    expect(res.status).toBe(409)
    expect(await code(res)).toBe('organization.role_built_in')
    expect(roleActions()).toEqual([])
    const built = BUILT_IN_ROLES.find((role) => role.key === key)
    expect((await json<OrganizationRole>(await roles('GET', `/${key}`))).permissions).toEqual(
      [...(built?.permissions ?? [])].sort()
    )
  })

  test.each([
    ['a key', { key: 'other' }],
    ['nothing', {}],
    ['a malformed permission', { permissions: ['nope'] }],
    ['an unknown system permission', { permissions: ['org:sys:billing:read'] }],
    ['a repeated permission', { permissions: ['org:a:b', 'org:a:b'] }],
    ['an empty name', { name: ' ' }],
  ])('refuses %s', async (_name, input) => {
    await define()
    const res = await roles('PATCH', '/billing', input, SK, ifMatch(1))
    expect(res.status).toBe(422)
    expect(roleActions()).toEqual(['organization_role.created'])
  })

  test('an unknown role is a 404, and a malformed key a 422', async () => {
    expect((await roles('PATCH', '/nobody', { name: 'x' }, SK, ifMatch(1))).status).toBe(404)
    expect((await roles('PATCH', '/No-Key', { name: 'x' }, SK, ifMatch(1))).status).toBe(422)
  })

  test('takes the manage permission from a role only while another manager is left', async () => {
    const org = await organization()
    const maya = await user('maya@northline.app')
    const zoe = await user('zoe@northline.app')
    await define({
      key: 'owner',
      name: 'Owner',
      permissions: ['org:sys:memberships:manage', 'org:billing:read'],
    })
    await join(org, maya.id, 'owner')
    const strip = (version: number) =>
      roles('PATCH', '/owner', { permissions: ['org:billing:read'] }, SK, ifMatch(version))
    const refused = await strip(1)
    expect(refused.status).toBe(409)
    expect(await code(refused)).toBe('organization.last_manager')
    expect((await json<OrganizationRole>(await roles('GET', '/owner'))).version).toBe(1)
    // With a second manager of another role, the same change goes through.
    await join(org, zoe.id, 'admin')
    expect((await strip(1)).status).toBe(200)
  })
})

describe('DELETE /v1/admin/organization-roles/:key', () => {
  test('deletes a role no member holds and records it', async () => {
    const created = await define()
    const res = await roles('DELETE', '/billing', undefined, SK, ifMatch(1))
    expect(res.status).toBe(204)
    expect((await roles('GET', '/billing')).status).toBe(404)
    expect(roleActions()).toEqual(['organization_role.created', 'organization_role.deleted'])
    const entry = roleEntries().at(-1)
    expect(entry?.target).toEqual({ type: 'organization_role', id: created.id })
    expect(entry?.data).toEqual({ role: 'billing' })
  })

  test('If-Match is optional, and a stale one is refused', async () => {
    await define()
    await define({ ...BILLING, key: 'other' })
    const stale = await roles('DELETE', '/billing', undefined, SK, ifMatch(9))
    expect(stale.status).toBe(412)
    expect((await roles('GET', '/billing')).status).toBe(200)
    expect((await roles('DELETE', '/billing')).status).toBe(204)
    expect((await roles('DELETE', '/other', undefined, SK, { 'if-match': 'garbage' })).status).toBe(
      412
    )
  })

  test('refuses a role a member still holds, in any organization, and changes nothing', async () => {
    const first = await organization('first')
    const second = await organization('second')
    const maya = await user()
    await define()
    await join(first, maya.id, 'admin')
    await join(second, maya.id, 'billing')
    const res = await roles('DELETE', '/billing')
    expect(res.status).toBe(409)
    expect(await code(res)).toBe('organization.role_in_use')
    expect((await roles('GET', '/billing')).status).toBe(200)
    expect(roleActions()).toEqual(['organization_role.created'])
    // Once the member has another role, it can go.
    await orgs('PATCH', `/${second.id}/memberships/${maya.id}`, { role: 'member' })
    expect((await roles('DELETE', '/billing')).status).toBe(204)
  })

  test.each(['admin', 'member'])('refuses to delete the built-in role %s', async (key) => {
    const res = await roles('DELETE', `/${key}`)
    expect(res.status).toBe(409)
    expect(await code(res)).toBe('organization.role_built_in')
    expect((await roles('GET', `/${key}`)).status).toBe(200)
    expect(roleActions()).toEqual([])
  })

  test('an unknown role is a 404', async () => {
    expect((await roles('DELETE', '/nobody')).status).toBe(404)
    expect((await roles('DELETE', '/No-Key')).status).toBe(422)
  })
})

describe('another environment’s roles', () => {
  test('are not listed, read, changed or deleted by a key of this one, and cannot be given', async () => {
    enable(TEST_TENANT.productionEnvironmentId)
    const theirs = await define({ ...BILLING, key: 'theirs' }, PROD_SK)
    expect((await json<OrganizationRoleList>(await roles('GET'))).data.map((r) => r.key)).toEqual([
      'admin',
      'member',
    ])
    expect((await roles('GET', '/theirs')).status).toBe(404)
    expect((await roles('PATCH', '/theirs', { name: 'Taken over' }, SK, ifMatch(1))).status).toBe(
      404
    )
    expect((await roles('DELETE', '/theirs')).status).toBe(404)
    const org = await organization()
    const maya = await user()
    const res = await orgs('POST', `/${org.id}/memberships`, { userId: maya.id, role: 'theirs' })
    expect(res.status).toBe(422)
    expect(await code(res)).toBe('organization.role_unknown')
    expect(await json<OrganizationRole>(await roles('GET', '/theirs', undefined, PROD_SK))).toEqual(
      theirs
    )
  })
})

describe('a custom role in use', () => {
  test('is given to a member by its key, and its permissions are read from the role afterwards', async () => {
    const org = await organization()
    const maya = await user()
    const created = await define()
    const membership = await join(org, maya.id, 'billing')
    expect(membership.role).toBe('billing')
    await roles(
      'PATCH',
      '/billing',
      { permissions: ['org:billing:read', 'org:billing:write'] },
      SK,
      ifMatch(1)
    )
    // The membership names the role; the permissions are the role's, read when they are needed.
    const stored = await deps.organizations.findMembership(
      TEST_TENANT.environmentId,
      org.id,
      maya.id
    )
    expect(stored?.roleId).toBe(created.id)
    expect(Object.keys(stored ?? {})).not.toContain('permissions')
    expect(
      (await deps.organizations.findRoleById(TEST_TENANT.environmentId, created.id))?.permissions
    ).toEqual(['org:billing:read', 'org:billing:write'])
  })
})

describe('what an event carries', () => {
  test('every event of the module passes its schema and holds no name or permission', async () => {
    await define({ key: 'secret_role', name: 'Secret Name', permissions: ['org:secret:read'] })
    await roles(
      'PATCH',
      '/secret_role',
      { name: 'Renamed Secret', permissions: ['org:secret:read', 'org:secret:write'] },
      SK,
      ifMatch(1)
    )
    await roles('DELETE', '/secret_role')
    const events = roleEntries()
    expect(events.map((entry) => entry.type)).toEqual([
      'organization_role.created',
      'organization_role.updated',
      'organization_role.deleted',
    ])
    for (const entry of events) {
      const type = entry.type as keyof typeof EVENT_SCHEMAS
      const parsed = EVENT_SCHEMAS[type].safeParse({
        id: entry.id,
        type: entry.type,
        schemaVersion: 1,
        occurredAt: entry.occurredAt.toISOString(),
        actor: entry.actor,
        target: entry.target,
        data: entry.data,
      })
      expect(parsed.success).toBe(true)
      const text = JSON.stringify(comparable(entry.data))
      for (const secret of ['Secret Name', 'Renamed Secret', 'org:secret']) {
        expect(text).not.toContain(secret)
      }
    }
  })
})
