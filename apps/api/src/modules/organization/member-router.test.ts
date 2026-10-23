import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  type AssignableRoleList,
  type CurrentUser,
  DEFAULT_ENVIRONMENT_SETTINGS,
  type FlowAttempt,
  type Organization,
  type OrganizationMember,
  type OrganizationMemberList,
  type HybridSessionTokens as SessionTokens,
  type UserOrganization,
} from '@tula-tech/contract'
import { createApp } from '~/index'
import * as Organizations from '~/modules/organization/service'
import { createTestDeps, seedApiKey, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'

const PK = 'tula_pk_dev_publishable0000000000000000000'
const PK_B = 'tula_pk_dev_publishableb000000000000000000'
const SK = 'tula_sk_dev_secret000000000000000000000000'
const TENANT_A = { ...TEST_TENANT, apiKeyId: 'key_1' }
const TENANT_B = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.productionEnvironmentId,
}
const PASSWORD = 'correct horse battery staple'
const ORIGIN = 'https://app.northline.test'
const UNKNOWN = '00000000-0000-7000-8000-00000000dead'

let deps: TestDeps
let app: ReturnType<typeof createApp>
let revision = 0

function configure(
  organizations: Record<string, unknown> = {},
  environmentId: string = TEST_TENANT.environmentId
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

const json = async <T>(res: Response) => (await res.json()) as T
const codeOf = async (res: Response) => (await json<{ code: string }>(res)).code

function admin(method: string, path: string, body?: unknown) {
  return app.request(`/v1/admin/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${SK}`,
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

interface CallOptions {
  token?: string
  key?: string | null
  secret?: string
}

function client(method: string, path: string, body?: unknown, options: CallOptions = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-tula-client': 'ios',
    origin: ORIGIN,
  }
  if (options.key !== null) {
    headers['x-tula-publishable-key'] = options.key ?? PK
  }
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`
  }
  if (options.secret) {
    headers['x-tula-attempt'] = options.secret
  }
  return app.request(`/v1/client${path}`, {
    method,
    headers,
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
      { secret: started.attemptSecret }
    )
  )
  const session = done.session as SessionTokens
  const user = await json<CurrentUser>(
    await client('GET', '/me', undefined, { token: session.accessToken })
  )
  return { ...session, userId: user.id }
}

async function makeOrganization(slug = 'acme', name = 'Acme Corp'): Promise<Organization> {
  const res = await admin('POST', 'organizations', { name, slug })
  expect(res.status).toBe(201)
  return json<Organization>(res)
}

async function join(org: Organization, userId: string, role: string) {
  await Organizations.addMember(deps, TENANT_A, org.id, { userId, role }, TEST_ACTOR)
}

async function defineRole(key: string, permissions: string[]) {
  const res = await admin('POST', 'organization-roles', { key, name: key, permissions })
  expect(res.status).toBe(201)
}

/** An organization with an admin (maya), a member (ada) and a bystander (cy) who is in none. */
async function world() {
  const maya = await signUp('maya@northline.app')
  const ada = await signUp('ada@northline.app')
  const cy = await signUp('cy@northline.app')
  const org = await makeOrganization()
  await join(org, maya.userId, 'admin')
  await join(org, ada.userId, 'member')
  return { maya, ada, cy, org }
}

const base = (org: Organization) => `/me/organizations/${org.id}`
const as = (who: { accessToken: string }) => ({ token: who.accessToken })
const roleOf = async (org: Organization, userId: string) =>
  (await deps.organizations.findMembership(TEST_TENANT.environmentId, org.id, userId))?.roleKey

describe('organizations switched off', () => {
  test('every member route answers organization.disabled and touches nothing', async () => {
    const { maya, ada, org } = await world()
    configure({ enabled: false })
    const before = deps.activityLog.entries.length
    const calls = [
      await client('PATCH', base(org), { name: 'New' }, as(maya)),
      await client('DELETE', base(org), undefined, as(maya)),
      await client('GET', `${base(org)}/members`, undefined, as(maya)),
      await client('GET', `${base(org)}/roles`, undefined, as(maya)),
      await client('PATCH', `${base(org)}/members/${ada.userId}`, { role: 'admin' }, as(maya)),
      await client('DELETE', `${base(org)}/members/${ada.userId}`, undefined, as(maya)),
    ]
    for (const res of calls) {
      expect(res.status).toBe(403)
      expect(await codeOf(res)).toBe('organization.disabled')
    }
    expect(deps.activityLog.entries).toHaveLength(before)
    expect(await roleOf(org, ada.userId)).toBe('member')
  })
})

describe('who may call', () => {
  test('a stranger, an unknown organization and another environment alike are not a member', async () => {
    const { cy, org } = await world()
    const other = await json<Organization>(
      await app.request('/v1/admin/organizations', {
        method: 'POST',
        headers: { authorization: `Bearer ${SK}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Other', slug: 'other' }),
      })
    )
    const calls = (id: string) => [
      client('PATCH', `/me/organizations/${id}`, { name: 'x' }, as(cy)),
      client('DELETE', `/me/organizations/${id}`, undefined, as(cy)),
      client('GET', `/me/organizations/${id}/members`, undefined, as(cy)),
      client('GET', `/me/organizations/${id}/roles`, undefined, as(cy)),
      client('PATCH', `/me/organizations/${id}/members/${cy.userId}`, { role: 'member' }, as(cy)),
      client('DELETE', `/me/organizations/${id}/members/${cy.userId}`, undefined, as(cy)),
    ]
    for (const id of [org.id, other.id, UNKNOWN]) {
      for (const res of await Promise.all(calls(id))) {
        expect(res.status).toBe(403)
        expect(await codeOf(res)).toBe('organization.not_a_member')
      }
    }
  })

  test('every route needs a publishable key and a session', async () => {
    const { org, maya } = await world()
    for (const [method, path] of [
      ['PATCH', base(org)],
      ['DELETE', base(org)],
      ['GET', `${base(org)}/members`],
      ['GET', `${base(org)}/roles`],
      ['PATCH', `${base(org)}/members/${maya.userId}`],
      ['DELETE', `${base(org)}/members/${maya.userId}`],
    ] as const) {
      const body = method === 'PATCH' ? { name: 'x', role: 'member' } : undefined
      expect((await client(method, path, body, { ...as(maya), key: null })).status).toBe(401)
      expect((await client(method, path, body)).status).toBe(401)
    }
  })

  test('a member whose role lacks the permission is refused, and the refusal names it', async () => {
    const { ada, maya, org } = await world()
    const calls: Array<[Promise<Response> | Response, string]> = [
      [client('PATCH', base(org), { name: 'x' }, as(ada)), 'org:sys:organization:manage'],
      [client('DELETE', base(org), undefined, as(ada)), 'org:sys:organization:delete'],
      [client('GET', `${base(org)}/roles`, undefined, as(ada)), 'org:sys:invitations:manage'],
      [
        client('PATCH', `${base(org)}/members/${maya.userId}`, { role: 'member' }, as(ada)),
        'org:sys:memberships:manage',
      ],
      [
        client('DELETE', `${base(org)}/members/${maya.userId}`, undefined, as(ada)),
        'org:sys:memberships:manage',
      ],
    ]
    for (const [pending, permission] of calls) {
      const res = await pending
      expect(res.status).toBe(403)
      const body = await json<{ code: string; params?: { permission?: string } }>(res)
      expect(body.code).toBe('organization.permission_required')
      expect(body.params?.permission).toBe(permission)
    }
    expect((await deps.organizations.find(TEST_TENANT.environmentId, org.id))?.name).toBe(
      'Acme Corp'
    )
    expect(await roleOf(org, maya.userId)).toBe('admin')
  })

  test('the permission is read now: a demoted admin is refused on the next call', async () => {
    const { ada, maya, org } = await world()
    // Ada becomes an admin so that Maya can be demoted without leaving no manager.
    await Organizations.changeMemberRole(
      deps,
      TENANT_A,
      org.id,
      ada.userId,
      { role: 'admin' },
      TEST_ACTOR
    )
    expect((await client('PATCH', base(org), { name: 'One' }, as(maya))).status).toBe(200)
    await Organizations.changeMemberRole(
      deps,
      TENANT_A,
      org.id,
      maya.userId,
      { role: 'member' },
      TEST_ACTOR
    )
    // Maya's access token still carries the admin claims; the route does not trust them.
    const res = await client('PATCH', base(org), { name: 'Two' }, as(maya))
    expect(res.status).toBe(403)
    expect(await codeOf(res)).toBe('organization.permission_required')
  })
})

describe('general', () => {
  test('an admin renames the organization and the answer carries their role', async () => {
    const { maya, org } = await world()
    const res = await client('PATCH', base(org), { name: 'Acme Inc' }, as(maya))
    expect(res.status).toBe(200)
    const body = await json<UserOrganization>(res)
    expect(body).toMatchObject({ id: org.id, name: 'Acme Inc', slug: 'acme', role: 'admin' })
    const entry = deps.activityLog.entries.findLast((e) => e.type === 'organization.updated')
    expect(entry?.data).toEqual({ changed: ['name'] })
    expect(JSON.stringify(entry)).not.toContain('Acme Inc')
  })

  test('a taken slug is organization.slug_taken and an empty body is refused', async () => {
    const { maya, org } = await world()
    await makeOrganization('globex', 'Globex')
    const taken = await client('PATCH', base(org), { slug: 'globex' }, as(maya))
    expect(taken.status).toBe(409)
    expect(await codeOf(taken)).toBe('organization.slug_taken')
    expect((await client('PATCH', base(org), {}, as(maya))).status).toBe(422)
  })

  test('only a holder of the delete permission deletes, and the memberships go with it', async () => {
    const { maya, ada, org } = await world()
    await defineRole('editor', ['org:sys:organization:manage'])
    await Organizations.changeMemberRole(
      deps,
      TENANT_A,
      org.id,
      ada.userId,
      { role: 'editor' },
      TEST_ACTOR
    )
    expect((await client('DELETE', base(org), undefined, as(ada))).status).toBe(403)
    const res = await client('DELETE', base(org), undefined, as(maya))
    expect(res.status).toBe(204)
    expect(await deps.organizations.find(TEST_TENANT.environmentId, org.id)).toBeNull()
    expect(await roleOf(org, ada.userId)).toBeUndefined()
    const deleted = deps.activityLog.entries.findLast((e) => e.type === 'organization.deleted')
    expect(deleted?.data).toEqual({ memberships: 2 })
  })
})

describe('deleting needs a recent authentication', () => {
  /** The session's access token after the sign-in has aged past the step-up window. */
  async function aged(session: SessionTokens): Promise<string> {
    deps.clock.advance('11m')
    const refreshed = await client('POST', '/sessions/refresh', {
      refreshToken: session.refreshToken,
    })
    expect(refreshed.status).toBe(200)
    return (await json<{ accessToken: string }>(refreshed)).accessToken
  }

  test('a stale session is refused with auth.step_up_required and nothing is deleted', async () => {
    const { maya, org } = await world()
    const token = await aged(maya)
    const before = deps.activityLog.entries.length
    const res = await client('DELETE', base(org), undefined, { token })
    expect(res.status).toBe(403)
    expect(await codeOf(res)).toBe('auth.step_up_required')
    expect(await deps.organizations.find(TEST_TENANT.environmentId, org.id)).not.toBeNull()
    expect(deps.activityLog.entries).toHaveLength(before)
  })

  test('the stale refusal comes before the permission check: a member learns nothing from it', async () => {
    const { ada, org } = await world()
    const token = await aged(ada)
    const res = await client('DELETE', base(org), undefined, { token })
    expect(await codeOf(res)).toBe('auth.step_up_required')
  })

  test('after a step-up the same call deletes', async () => {
    const { maya, org } = await world()
    const stale = await aged(maya)
    expect((await client('DELETE', base(org), undefined, { token: stale })).status).toBe(403)
    const stepped = await client(
      'POST',
      '/sessions/step-up',
      { method: 'password', password: PASSWORD },
      { token: stale }
    )
    expect(stepped.status).toBe(200)
    const fresh = (await json<{ accessToken: string }>(stepped)).accessToken
    expect((await client('DELETE', base(org), undefined, { token: fresh })).status).toBe(204)
    expect(await deps.organizations.find(TEST_TENANT.environmentId, org.id)).toBeNull()
  })

  test('the other member routes do not ask for it', async () => {
    const { maya, org } = await world()
    const token = await aged(maya)
    expect((await client('GET', `${base(org)}/members`, undefined, { token })).status).toBe(200)
    expect((await client('PATCH', base(org), { name: 'Renamed' }, { token })).status).toBe(200)
  })
})

describe('the member list', () => {
  test('looks every member up in one call, not one per member', async () => {
    const { maya, org } = await world()
    const one = spyOn(deps.users, 'findById')
    const many = spyOn(deps.users, 'findByIds')
    const res = await client('GET', `${base(org)}/members`, undefined, as(maya))
    expect(res.status).toBe(200)
    expect((await json<OrganizationMemberList>(res)).data).toHaveLength(2)
    expect(many).toHaveBeenCalledTimes(1)
    expect(one).not.toHaveBeenCalled()
    one.mockRestore()
    many.mockRestore()
  })
})

describe('members', () => {
  test('a member reads the list with names and addresses; a stranger does not', async () => {
    const { maya, ada, org } = await world()
    const res = await client('GET', `${base(org)}/members`, undefined, as(ada))
    expect(res.status).toBe(200)
    const body = await json<OrganizationMemberList>(res)
    expect(body.meta.totalCount).toBe(2)
    expect(body.data.map((m) => [m.email, m.role])).toEqual([
      ['maya@northline.app', 'admin'],
      ['ada@northline.app', 'member'],
    ])
    expect(body.data.every((m) => m.name === null)).toBe(true)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect((await client('GET', `${base(org)}/members?page=0`, undefined, as(maya))).status).toBe(
      422
    )
  })

  test('a role with neither read nor manage cannot read the list', async () => {
    const { ada, org } = await world()
    await defineRole('billing', ['org:billing:read'])
    await Organizations.changeMemberRole(
      deps,
      TENANT_A,
      org.id,
      ada.userId,
      { role: 'billing' },
      TEST_ACTOR
    )
    const res = await client('GET', `${base(org)}/members`, undefined, as(ada))
    expect(res.status).toBe(403)
    expect(await codeOf(res)).toBe('organization.permission_required')
  })

  test('an admin changes a role; the audit entry holds ids and keys, never the address', async () => {
    const { maya, ada, org } = await world()
    const res = await client(
      'PATCH',
      `${base(org)}/members/${ada.userId}`,
      { role: 'admin' },
      as(maya)
    )
    expect(res.status).toBe(200)
    expect(await json<OrganizationMember>(res)).toMatchObject({
      userId: ada.userId,
      email: 'ada@northline.app',
      role: 'admin',
    })
    expect(await roleOf(org, ada.userId)).toBe('admin')
    const entry = deps.activityLog.entries.findLast(
      (e) => e.type === 'organization_membership.role_changed'
    )
    expect(JSON.stringify(entry)).not.toContain('northline.app')
  })

  test('a role the caller does not hold all of is role_not_assignable, and an unknown one role_unknown', async () => {
    const { ada, maya, cy, org } = await world()
    await defineRole('people', ['org:sys:memberships:manage', 'org:sys:memberships:read'])
    await Organizations.changeMemberRole(
      deps,
      TENANT_A,
      org.id,
      ada.userId,
      { role: 'people' },
      TEST_ACTOR
    )
    const tooMuch = await client(
      'PATCH',
      `${base(org)}/members/${ada.userId}`,
      { role: 'admin' },
      as(ada)
    )
    expect(tooMuch.status).toBe(403)
    expect(await codeOf(tooMuch)).toBe('organization.role_not_assignable')
    const unknown = await client(
      'PATCH',
      `${base(org)}/members/${maya.userId}`,
      { role: 'nope' },
      as(ada)
    )
    expect(unknown.status).toBe(422)
    expect(await codeOf(unknown)).toBe('organization.role_unknown')
    // What they hold they may give, to a member who holds no more than they do.
    await join(org, cy.userId, 'member')
    const ok = await client(
      'PATCH',
      `${base(org)}/members/${cy.userId}`,
      { role: 'people' },
      as(ada)
    )
    expect(ok.status).toBe(200)
  })

  test('a manager cannot demote or remove a member who holds more than they do', async () => {
    const { ada, maya, cy, org } = await world()
    await defineRole('people', ['org:sys:memberships:manage', 'org:sys:memberships:read'])
    await Organizations.changeMemberRole(
      deps,
      TENANT_A,
      org.id,
      ada.userId,
      { role: 'people' },
      TEST_ACTOR
    )
    // Maya is an admin: she holds permissions that Ada's role does not.
    const demote = await client(
      'PATCH',
      `${base(org)}/members/${maya.userId}`,
      { role: 'member' },
      as(ada)
    )
    expect(demote.status).toBe(403)
    expect(await codeOf(demote)).toBe('organization.permission_required')
    const removal = await client(
      'DELETE',
      `${base(org)}/members/${maya.userId}`,
      undefined,
      as(ada)
    )
    expect(removal.status).toBe(403)
    expect(await codeOf(removal)).toBe('organization.permission_required')
    expect(await roleOf(org, maya.userId)).toBe('admin')
    // A member whose role is within Ada's can be removed, and leaving is never refused.
    await join(org, cy.userId, 'member')
    const ok = await client('DELETE', `${base(org)}/members/${cy.userId}`, undefined, as(ada))
    expect(ok.status).toBe(204)
    const leave = await client('DELETE', `${base(org)}/members/${ada.userId}`, undefined, as(ada))
    expect(leave.status).toBe(204)
  })

  test('the last manager cannot be demoted, removed or leave; with a second one they can', async () => {
    const { maya, ada, org } = await world()
    const demote = await client(
      'PATCH',
      `${base(org)}/members/${maya.userId}`,
      { role: 'member' },
      as(maya)
    )
    expect(demote.status).toBe(409)
    expect(await codeOf(demote)).toBe('organization.last_manager')
    const leave = await client('DELETE', `${base(org)}/members/${maya.userId}`, undefined, as(maya))
    expect(leave.status).toBe(409)
    expect(await codeOf(leave)).toBe('organization.last_manager')
    expect(await roleOf(org, maya.userId)).toBe('admin')
    await Organizations.changeMemberRole(
      deps,
      TENANT_A,
      org.id,
      ada.userId,
      { role: 'admin' },
      TEST_ACTOR
    )
    expect(
      (await client('DELETE', `${base(org)}/members/${maya.userId}`, undefined, as(maya))).status
    ).toBe(204)
    expect(await roleOf(org, maya.userId)).toBeUndefined()
  })

  test('a member leaves with no permission; removing someone else needs manage', async () => {
    const { maya, ada, org } = await world()
    const other = await signUp('bo@northline.app')
    await join(org, other.userId, 'member')
    const refused = await client(
      'DELETE',
      `${base(org)}/members/${other.userId}`,
      undefined,
      as(ada)
    )
    expect(refused.status).toBe(403)
    expect(await codeOf(refused)).toBe('organization.permission_required')
    expect(await roleOf(org, other.userId)).toBe('member')
    const left = await client('DELETE', `${base(org)}/members/${ada.userId}`, undefined, as(ada))
    expect(left.status).toBe(204)
    expect(await roleOf(org, ada.userId)).toBeUndefined()
    const removed = await client(
      'DELETE',
      `${base(org)}/members/${other.userId}`,
      undefined,
      as(maya)
    )
    expect(removed.status).toBe(204)
    // Gone for good: a second removal is a 404, not a second audit entry.
    const again = await client(
      'DELETE',
      `${base(org)}/members/${other.userId}`,
      undefined,
      as(maya)
    )
    expect(again.status).toBe(404)
  })

  test('a removed member is refused at once, though their token still carries the claims', async () => {
    const { maya, ada, org } = await world()
    await client('DELETE', `${base(org)}/members/${ada.userId}`, undefined, as(maya))
    for (const res of [
      await client('GET', `${base(org)}/members`, undefined, as(ada)),
      await client('DELETE', `${base(org)}/members/${ada.userId}`, undefined, as(ada)),
    ]) {
      expect(res.status).toBe(403)
      expect(await codeOf(res)).toBe('organization.not_a_member')
    }
  })
})

describe('roles on offer', () => {
  test('an admin is offered every role, and a narrower manager only what they hold', async () => {
    const { maya, ada, org } = await world()
    await defineRole('people', ['org:sys:memberships:manage', 'org:sys:memberships:read'])
    await defineRole('billing', ['org:billing:read'])
    const all = await json<AssignableRoleList>(
      await client('GET', `${base(org)}/roles`, undefined, as(maya))
    )
    // `billing` holds a custom permission the built-in admin does not: no stronger than theirs.
    expect(all.data.map((r) => r.key)).toEqual(['admin', 'member', 'people'])
    expect(all.data[0]).toEqual({ key: 'admin', name: 'Admin' })
    await Organizations.changeMemberRole(
      deps,
      TENANT_A,
      org.id,
      ada.userId,
      { role: 'people' },
      TEST_ACTOR
    )
    const narrow = await json<AssignableRoleList>(
      await client('GET', `${base(org)}/roles`, undefined, as(ada))
    )
    expect(narrow.data.map((r) => r.key)).toEqual(['member', 'people'])
  })
})
