import { beforeEach, describe, expect, test } from 'bun:test'
import {
  BUILT_IN_ROLES,
  DEFAULT_ENVIRONMENT_SETTINGS,
  EVENT_SCHEMAS,
  type Organization,
  type OrganizationList,
  type OrganizationMembership,
  type OrganizationMembershipList,
  type User,
} from '@tula-tech/contract'
import { createApp } from '~/index'
import { createTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'
import { comparable } from '~/testing/comparable'

const SK = 'tula_sk_dev_secret000000000000000000000000'
const PROD_SK = 'tula_sk_live_secret00000000000000000000000'
const AK = 'tula_ak_dev_agent000000000000000000000000000000'
const PK = 'tula_pk_dev_publishable0000000000000000000'
const UNKNOWN = '00000000-0000-7000-8000-00000000dead'

let deps: TestDeps
let app: ReturnType<typeof createApp>

/** Switch organizations on (or leave the defaults) for an environment. */
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

function call(base: string, method: string, path: string, body?: unknown, key: string | null = SK) {
  return app.request(`${base}${path}`, {
    method,
    headers: {
      ...(key && { authorization: `Bearer ${key}` }),
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const orgs = (method: string, path = '', body?: unknown, key: string | null = SK) =>
  call('/v1/admin/organizations', method, path, body, key)

const json = async <T>(res: Response) => (await res.json()) as T
const code = async (res: Response) => (await json<{ code: string }>(res)).code

async function organization(slug = 'acme', key = SK): Promise<Organization> {
  const res = await orgs('POST', '', { name: 'Acme Corp', slug }, key)
  expect(res.status).toBe(201)
  return json<Organization>(res)
}

async function user(email = 'maya@northline.app', key = SK): Promise<User> {
  const res = await call('/v1/admin/users', 'POST', '', { email }, key)
  expect(res.status).toBe(201)
  return json<User>(res)
}

async function join(
  org: Organization,
  userId: string,
  role: string,
  key = SK
): Promise<OrganizationMembership> {
  const res = await orgs('POST', `/${org.id}/memberships`, { userId, role }, key)
  expect(res.status).toBe(201)
  return json<OrganizationMembership>(res)
}

/** The organization actions recorded so far: the users the tests make record their own. */
const organizationEntries = () =>
  deps.activityLog.entries.filter((entry) => entry.type.startsWith('organization'))
const actions = () => organizationEntries().map((entry) => entry.type)

describe('organizations switched off', () => {
  test.each([
    ['GET', ''],
    ['POST', ''],
    ['GET', `/${UNKNOWN}`],
    ['PATCH', `/${UNKNOWN}`],
    ['DELETE', `/${UNKNOWN}`],
    ['GET', `/${UNKNOWN}/memberships`],
    ['POST', `/${UNKNOWN}/memberships`],
    ['PATCH', `/${UNKNOWN}/memberships/${UNKNOWN}`],
    ['DELETE', `/${UNKNOWN}/memberships/${UNKNOWN}`],
  ])('%s %s answers organization.disabled and touches nothing', async (method, path) => {
    enable(TEST_TENANT.environmentId, false)
    const body =
      method === 'POST' && path === ''
        ? { name: 'Acme', slug: 'acme' }
        : method === 'POST'
          ? { userId: UNKNOWN, role: 'member' }
          : method === 'PATCH' && path.includes('memberships')
            ? { role: 'member' }
            : method === 'PATCH'
              ? { name: 'New' }
              : undefined
    const res = await orgs(method, path, body)
    expect(res.status).toBe(403)
    expect(await code(res)).toBe('organization.disabled')
    expect(actions()).toEqual([])
  })

  test('is the default of an environment that saved nothing', async () => {
    deps = createTestDeps()
    deps.environments.add({
      id: TEST_TENANT.environmentId,
      projectId: TEST_TENANT.projectId,
      kind: 'development',
      createdAt: deps.clock.now(),
    })
    await seedApiKey(deps, SK)
    app = createApp(deps)
    expect(await code(await orgs('GET'))).toBe('organization.disabled')
  })

  test('switching it off again keeps what was stored, and switching it on restores it', async () => {
    const created = await organization()
    enable(TEST_TENANT.environmentId, false)
    expect((await orgs('GET', `/${created.id}`)).status).toBe(403)
    enable()
    expect(await json<Organization>(await orgs('GET', `/${created.id}`))).toEqual(created)
  })
})

describe('credentials', () => {
  test.each([
    ['no key', null],
    ['a publishable key', PK],
    ['a key that does not exist', 'tula_sk_dev_nonsense0000000000000000000000'],
  ])('%s is refused', async (_name, key) => {
    const res = await orgs('GET', '', undefined, key)
    expect(res.status).toBe(401)
  })

  test('an agent key reads and is refused every write', async () => {
    const created = await organization()
    const maya = await user()
    expect((await orgs('GET', '', undefined, AK)).status).toBe(200)
    expect((await orgs('GET', `/${created.id}`, undefined, AK)).status).toBe(200)
    expect((await orgs('GET', `/${created.id}/memberships`, undefined, AK)).status).toBe(200)
    const before = actions().length
    for (const [method, path, body] of [
      ['POST', '', { name: 'Other', slug: 'other' }],
      ['PATCH', `/${created.id}`, { name: 'Renamed' }],
      ['DELETE', `/${created.id}`, undefined],
      ['POST', `/${created.id}/memberships`, { userId: maya.id, role: 'admin' }],
    ] as const) {
      // The method is judged before the key (secretKey()): the answer is the one a wrong key gets.
      const res = await orgs(method, path, body, AK)
      expect(res.status).toBe(401)
      expect(await code(res)).toBe('auth.invalid_key')
    }
    expect(actions().length).toBe(before)
    expect((await orgs('GET', `/${created.id}`)).status).toBe(200)
  })
})

describe('POST /v1/admin/organizations', () => {
  test('creates an organization with no member and records it', async () => {
    const created = await organization()
    expect(created).toMatchObject({ name: 'Acme Corp', slug: 'acme', createdBy: null })
    expect(Object.keys(created).sort()).toEqual(
      ['createdAt', 'createdBy', 'id', 'name', 'slug', 'updatedAt'].sort()
    )
    expect(await json<Organization>(await orgs('GET', `/${created.id}`))).toEqual(created)
    expect(
      (await json<OrganizationMembershipList>(await orgs('GET', `/${created.id}/memberships`))).meta
        .totalCount
    ).toBe(0)
    expect(actions()).toEqual(['organization.created'])
    const entry = organizationEntries()[0]
    expect(entry?.actor.type).toBe('admin')
    expect(entry?.target).toEqual({ type: 'organization', id: created.id })
  })

  test('refuses a slug that is taken, with a code, and records nothing more', async () => {
    await organization('acme')
    const res = await orgs('POST', '', { name: 'Again', slug: 'acme' })
    expect(res.status).toBe(409)
    expect(await code(res)).toBe('organization.slug_taken')
    expect(actions()).toEqual(['organization.created'])
  })

  test.each([
    ['an upper-case slug', { name: 'A', slug: 'Acme' }],
    ['a slug with a space', { name: 'A', slug: 'ac me' }],
    ['a slug that starts with a hyphen', { name: 'A', slug: '-acme' }],
    ['a slug of one character', { name: 'A', slug: 'a' }],
    ['a slug of 49 characters', { name: 'A', slug: 'a'.repeat(49) }],
    ['an empty name', { name: '  ', slug: 'acme' }],
    ['a name with a control character', { name: 'A\u0007', slug: 'acme' }],
    ['a name of 101 characters', { name: 'a'.repeat(101), slug: 'acme' }],
    ['a field it does not know', { name: 'A', slug: 'acme', createdBy: UNKNOWN }],
  ])('refuses %s', async (_name, body) => {
    const res = await orgs('POST', '', body)
    expect(res.status).toBe(422)
    expect(await code(res)).toBe('validation.failed')
    expect(actions()).toEqual([])
  })

  test('the same slug is free in another environment', async () => {
    await organization('acme')
    enable(TEST_TENANT.productionEnvironmentId)
    const theirs = await organization('acme', PROD_SK)
    expect(theirs.slug).toBe('acme')
  })
})

describe('reading, renaming and deleting', () => {
  test('lists newest first, a page at a time', async () => {
    const first = await organization('first')
    deps.clock.advance('1m')
    const second = await organization('second')
    deps.clock.advance('1m')
    const third = await organization('third')
    const page = await json<OrganizationList>(await orgs('GET', '?size=2'))
    expect(page.meta).toEqual({ totalCount: 3, totalPages: 2, page: 1, perPage: 2 })
    expect(page.data.map((one) => one.id)).toEqual([third.id, second.id])
    const next = await json<OrganizationList>(await orgs('GET', '?size=2&page=2'))
    expect(next.data.map((one) => one.id)).toEqual([first.id])
    expect((await orgs('GET', '?size=0')).status).toBe(422)
    expect((await orgs('GET', '?size=101')).status).toBe(422)
  })

  test('q searches a name or slug prefix on the server, whatever the page', async () => {
    await organization('acme')
    await orgs('POST', '', { name: 'Zeta Labs', slug: 'zeta' })
    await orgs('POST', '', { name: 'Acorn', slug: 'acorn' })
    const found = await json<OrganizationList>(await orgs('GET', '?q=AC&size=1'))
    expect(found.meta).toEqual({ totalCount: 2, totalPages: 2, page: 1, perPage: 1 })
    expect((await json<OrganizationList>(await orgs('GET', '?q=zeta%20l'))).data).toHaveLength(1)
    expect((await json<OrganizationList>(await orgs('GET', '?q=%25'))).data).toHaveLength(0)
    // Blank means no search.
    expect((await json<OrganizationList>(await orgs('GET', '?q=%20'))).meta.totalCount).toBe(3)
    expect((await orgs('GET', `?q=${'a'.repeat(101)}`)).status).toBe(422)
  })

  test('renames, changes a slug, and records the names of the fields only', async () => {
    const created = await organization()
    deps.clock.advance('1m')
    const res = await orgs('PATCH', `/${created.id}`, { name: 'Acme Inc', slug: 'acme-inc' })
    expect(res.status).toBe(200)
    expect(await json<Organization>(res)).toMatchObject({ name: 'Acme Inc', slug: 'acme-inc' })
    const entry = organizationEntries().at(-1)
    expect(entry?.type).toBe('organization.updated')
    expect(entry?.data).toEqual({ changed: ['name', 'slug'] })
    expect(JSON.stringify(entry)).not.toContain('Acme Inc')
    expect(JSON.stringify(entry)).not.toContain('acme-inc')
  })

  test('a request that changes nothing writes nothing', async () => {
    const created = await organization()
    const res = await orgs('PATCH', `/${created.id}`, { name: created.name, slug: created.slug })
    expect(res.status).toBe(200)
    expect(await json<Organization>(res)).toEqual(created)
    expect(actions()).toEqual(['organization.created'])
  })

  test('an update that names nothing is refused, and a slug another has is a conflict', async () => {
    const created = await organization('mine')
    await organization('taken')
    expect((await orgs('PATCH', `/${created.id}`, {})).status).toBe(422)
    const taken = await orgs('PATCH', `/${created.id}`, { slug: 'taken' })
    expect(taken.status).toBe(409)
    expect(await code(taken)).toBe('organization.slug_taken')
  })

  test('deletes an organization with its memberships and records how many', async () => {
    const created = await organization()
    const maya = await user()
    await join(created, maya.id, 'admin')
    const res = await orgs('DELETE', `/${created.id}`)
    expect(res.status).toBe(204)
    expect((await orgs('GET', `/${created.id}`)).status).toBe(404)
    expect(actions()).toEqual([
      'organization.created',
      'organization_membership.added',
      'organization.deleted',
    ])
    expect(organizationEntries().at(-1)?.data).toEqual({ memberships: 1 })
    // The user is still there.
    expect((await call('/v1/admin/users', 'GET', `/${maya.id}`)).status).toBe(200)
  })

  test('an unknown organization is a 404, and a malformed id is a 422', async () => {
    for (const method of ['GET', 'DELETE']) {
      expect((await orgs(method, `/${UNKNOWN}`)).status).toBe(404)
    }
    expect((await orgs('PATCH', `/${UNKNOWN}`, { name: 'x' })).status).toBe(404)
    expect((await orgs('GET', '/not-a-uuid')).status).toBe(422)
  })
})

describe('another environment’s organizations', () => {
  test('are not listed, read, changed, deleted or joined by a key of this one', async () => {
    enable(TEST_TENANT.productionEnvironmentId)
    const theirs = await organization('theirs', PROD_SK)
    const maya = await user()
    expect((await json<OrganizationList>(await orgs('GET'))).data).toEqual([])
    expect((await orgs('GET', `/${theirs.id}`)).status).toBe(404)
    expect((await orgs('PATCH', `/${theirs.id}`, { name: 'Taken over' })).status).toBe(404)
    expect((await orgs('DELETE', `/${theirs.id}`)).status).toBe(404)
    expect((await orgs('GET', `/${theirs.id}/memberships`)).status).toBe(404)
    expect(
      (await orgs('POST', `/${theirs.id}/memberships`, { userId: maya.id, role: 'admin' })).status
    ).toBe(404)
    // Untouched, and nothing of the attempts is on record in the other environment.
    expect(
      await json<Organization>(await orgs('GET', `/${theirs.id}`, undefined, PROD_SK))
    ).toEqual(theirs)
    expect(
      organizationEntries().filter(
        (entry) => entry.environmentId === TEST_TENANT.productionEnvironmentId
      )
    ).toHaveLength(1)
  })

  test('a user of another environment cannot be added', async () => {
    enable(TEST_TENANT.productionEnvironmentId)
    const mine = await organization('mine')
    const theirUser = await user('them@northline.app', PROD_SK)
    const res = await orgs('POST', `/${mine.id}/memberships`, {
      userId: theirUser.id,
      role: 'member',
    })
    expect(res.status).toBe(404)
    expect(actions()).toEqual(['organization.created'])
  })
})

describe('memberships', () => {
  test('adds a user with each built-in role, lists them oldest first and records each', async () => {
    const created = await organization()
    const maya = await user('maya@northline.app')
    deps.clock.advance('1m')
    const zoe = await user('zoe@northline.app')
    const first = await join(created, maya.id, 'admin')
    deps.clock.advance('1m')
    const second = await join(created, zoe.id, 'member')
    expect(first).toMatchObject({ organizationId: created.id, userId: maya.id, role: 'admin' })
    expect(second.role).toBe('member')
    const listed = await json<OrganizationMembershipList>(
      await orgs('GET', `/${created.id}/memberships?size=1`)
    )
    expect(listed.meta).toEqual({ totalCount: 2, totalPages: 2, page: 1, perPage: 1 })
    expect(listed.data).toEqual([first])
    expect(actions()).toEqual([
      'organization.created',
      'organization_membership.added',
      'organization_membership.added',
    ])
    const entry = organizationEntries().at(-1)
    expect(entry?.target).toEqual({ type: 'organization_membership', id: second.id })
    expect(entry?.data).toEqual({ organizationId: created.id, userId: zoe.id, role: 'member' })
  })

  test('the roles of an environment that has none yet are created on first use', async () => {
    const created = await organization()
    expect(await deps.organizations.listRoles(TEST_TENANT.environmentId)).toEqual([])
    await join(created, (await user()).id, 'member')
    const roles = await deps.organizations.listRoles(TEST_TENANT.environmentId)
    expect(roles.map((role) => [role.key, role.builtIn, role.permissions])).toEqual(
      BUILT_IN_ROLES.map((role) => [role.key, true, [...role.permissions]])
    )
  })

  test('refuses an unknown role, an unknown user and a user who is a member already', async () => {
    const created = await organization()
    const maya = await user()
    const role = await orgs('POST', `/${created.id}/memberships`, {
      userId: maya.id,
      role: 'owner',
    })
    expect(role.status).toBe(422)
    expect(await code(role)).toBe('organization.role_unknown')
    expect(
      (await orgs('POST', `/${created.id}/memberships`, { userId: UNKNOWN, role: 'member' })).status
    ).toBe(404)
    expect(
      (await orgs('POST', `/${created.id}/memberships`, { userId: maya.id, role: 'Member' })).status
    ).toBe(422)
    await join(created, maya.id, 'member')
    const again = await orgs('POST', `/${created.id}/memberships`, {
      userId: maya.id,
      role: 'admin',
    })
    expect(again.status).toBe(409)
    expect(await code(again)).toBe('organization.member_exists')
    expect(actions()).toEqual(['organization.created', 'organization_membership.added'])
  })

  test('changes a role and records the one it was and the one it is', async () => {
    const created = await organization()
    const maya = await user('maya@northline.app')
    const zoe = await user('zoe@northline.app')
    await join(created, maya.id, 'admin')
    const member = await join(created, zoe.id, 'member')
    const res = await orgs('PATCH', `/${created.id}/memberships/${zoe.id}`, { role: 'admin' })
    expect(res.status).toBe(200)
    expect(await json<OrganizationMembership>(res)).toMatchObject({ id: member.id, role: 'admin' })
    const entry = organizationEntries().at(-1)
    expect(entry?.type).toBe('organization_membership.role_changed')
    expect(entry?.data).toEqual({
      organizationId: created.id,
      userId: zoe.id,
      role: 'admin',
      previousRole: 'member',
    })
    // The same role again writes nothing.
    const before = actions().length
    expect(
      (await orgs('PATCH', `/${created.id}/memberships/${zoe.id}`, { role: 'admin' })).status
    ).toBe(200)
    expect(actions().length).toBe(before)
  })

  test('the last member who can manage members cannot be demoted or removed', async () => {
    const created = await organization()
    const maya = await user('maya@northline.app')
    const zoe = await user('zoe@northline.app')
    await join(created, maya.id, 'admin')
    await join(created, zoe.id, 'member')
    const before = actions().length

    const demote = await orgs('PATCH', `/${created.id}/memberships/${maya.id}`, { role: 'member' })
    expect(demote.status).toBe(409)
    expect(await code(demote)).toBe('organization.last_manager')
    const remove = await orgs('DELETE', `/${created.id}/memberships/${maya.id}`)
    expect(remove.status).toBe(409)
    expect(await code(remove)).toBe('organization.last_manager')
    expect(actions().length).toBe(before)

    // With another admin the first can go; the other is then the last.
    await orgs('PATCH', `/${created.id}/memberships/${zoe.id}`, { role: 'admin' })
    expect((await orgs('DELETE', `/${created.id}/memberships/${maya.id}`)).status).toBe(204)
    const last = await orgs('DELETE', `/${created.id}/memberships/${zoe.id}`)
    expect(await code(last)).toBe('organization.last_manager')
  })

  test('deleting the only manager of an organization is refused, and changes nothing', async () => {
    const created = await organization()
    const maya = await user('maya@northline.app')
    const zoe = await user('zoe@northline.app')
    await join(created, maya.id, 'admin')
    await join(created, zoe.id, 'member')
    const before = deps.activityLog.entries.length

    const refused = await call('/v1/admin/users', 'DELETE', `/${maya.id}`)
    expect(refused.status).toBe(409)
    expect(await json<{ code: string; params: Record<string, unknown> }>(refused)).toMatchObject({
      status: 409,
      code: 'user.last_organization_manager',
      params: { organizationIds: created.id, count: 1 },
    })
    expect(deps.activityLog.entries.length).toBe(before)
    expect((await call('/v1/admin/users', 'GET', `/${maya.id}`)).status).toBe(200)
    expect(
      (await json<OrganizationMembershipList>(await orgs('GET', `/${created.id}/memberships`))).data
        .length
    ).toBe(2)

    // A user who manages nothing is deleted as before, and so is the manager once there is another.
    expect((await call('/v1/admin/users', 'DELETE', `/${zoe.id}`)).status).toBe(204)
    const second = await user('lee@northline.app')
    await join(created, second.id, 'admin')
    expect((await call('/v1/admin/users', 'DELETE', `/${maya.id}`)).status).toBe(204)
    const last = await call('/v1/admin/users', 'DELETE', `/${second.id}`)
    expect(await code(last)).toBe('user.last_organization_manager')
    expect((await orgs('DELETE', `/${created.id}`)).status).toBe(204)
    expect((await call('/v1/admin/users', 'DELETE', `/${second.id}`)).status).toBe(204)
  })

  test('removes a member, keeps the user, and records it', async () => {
    const created = await organization()
    const maya = await user('maya@northline.app')
    const zoe = await user('zoe@northline.app')
    await join(created, maya.id, 'admin')
    const member = await join(created, zoe.id, 'member')
    const res = await orgs('DELETE', `/${created.id}/memberships/${zoe.id}`)
    expect(res.status).toBe(204)
    expect(
      (await json<OrganizationMembershipList>(await orgs('GET', `/${created.id}/memberships`))).data
    ).toHaveLength(1)
    expect((await call('/v1/admin/users', 'GET', `/${zoe.id}`)).status).toBe(200)
    const entry = organizationEntries().at(-1)
    expect(entry?.type).toBe('organization_membership.removed')
    expect(entry?.target).toEqual({ type: 'organization_membership', id: member.id })
    expect((await orgs('DELETE', `/${created.id}/memberships/${zoe.id}`)).status).toBe(404)
    expect(
      (await orgs('PATCH', `/${created.id}/memberships/${zoe.id}`, { role: 'admin' })).status
    ).toBe(404)
  })
})

describe('what an event carries', () => {
  test('every event of the module passes its schema and holds no name, slug or address', async () => {
    const created = await organization('secret-slug')
    const maya = await user('maya@northline.app')
    const zoe = await user('zoe@northline.app')
    await join(created, maya.id, 'admin')
    await join(created, zoe.id, 'member')
    await orgs('PATCH', `/${created.id}/memberships/${zoe.id}`, { role: 'admin' })
    await orgs('PATCH', `/${created.id}`, { name: 'Renamed Corp', slug: 'renamed-slug' })
    await orgs('DELETE', `/${created.id}/memberships/${zoe.id}`)
    await orgs('DELETE', `/${created.id}`)
    const events = organizationEntries()
    expect(new Set(events.map((entry) => entry.type)).size).toBe(6)
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
      for (const secret of ['secret-slug', 'Acme Corp', 'Renamed Corp', 'renamed-slug', '@']) {
        expect(text).not.toContain(secret)
      }
    }
  })
})

describe('GET /v1/admin/users/:userId/organizations', () => {
  const memberships = (userId: string, key: string | null = SK) =>
    call(`/v1/admin/users/${userId}/organizations`, 'GET', '', undefined, key)

  test('lists the organizations a user belongs to, the first joined at the top', async () => {
    const maya = await user()
    const acme = await organization('acme')
    const globex = await organization('globex')
    await organization('other')
    await join(acme, maya.id, 'admin')
    await join(globex, maya.id, 'member')
    const res = await memberships(maya.id)
    expect(res.status).toBe(200)
    const list = await json<{
      meta: { totalCount: number }
      data: Record<string, unknown>[]
    }>(res)
    expect(list.meta.totalCount).toBe(2)
    expect(list.data.map((row) => [row.slug, row.role])).toEqual([
      ['acme', 'admin'],
      ['globex', 'member'],
    ])
    // The organization's identity and the role key, and nothing else: no permission list.
    expect(Object.keys(list.data[0] ?? {}).sort()).toEqual(
      ['joinedAt', 'name', 'organizationId', 'role', 'slug'].sort()
    )
  })

  test('answers an empty page for a user in no organization', async () => {
    const maya = await user()
    const list = await json<{ meta: { totalCount: number }; data: unknown[] }>(
      await memberships(maya.id)
    )
    expect(list.meta.totalCount).toBe(0)
    expect(list.data).toEqual([])
  })

  test('is not found for a user that does not exist', async () => {
    expect((await memberships(UNKNOWN)).status).toBe(404)
  })

  test('answers organization.disabled and reads nothing while organizations are off', async () => {
    const maya = await user()
    enable(TEST_TENANT.environmentId, false)
    const res = await memberships(maya.id)
    expect(res.status).toBe(403)
    expect(await code(res)).toBe('organization.disabled')
  })

  test('does not show another environment’s user, and is refused without a secret key', async () => {
    const maya = await user('maya@northline.app', PROD_SK)
    expect((await memberships(maya.id)).status).toBe(404)
    expect((await memberships(maya.id, PK)).status).toBe(401)
    expect((await memberships(maya.id, null)).status).toBe(401)
    expect((await memberships(maya.id, AK)).status).toBe(404)
  })
})
