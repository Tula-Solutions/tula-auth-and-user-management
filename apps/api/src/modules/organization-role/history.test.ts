import { beforeEach, describe, expect, test } from 'bun:test'
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  type Organization,
  type OrganizationAccessExplanation,
  type OrganizationRoleVersion,
  type OrganizationRoleVersionList,
  type User,
} from '@tula-tech/contract'
import { createApp } from '~/index'
import { createTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'

const SK = 'tula_sk_dev_secret000000000000000000000000'
const PROD_SK = 'tula_sk_live_secret00000000000000000000000'
const AK = 'tula_ak_dev_agent000000000000000000000000000000'

let deps: TestDeps
let app: ReturnType<typeof createApp>

function enable(environmentId: string) {
  deps.environmentSettings.seed(environmentId, {
    revision: 1,
    settings: {
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      organizations: { ...DEFAULT_ENVIRONMENT_SETTINGS.organizations, enabled: true },
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
    enable(id)
  }
  await seedApiKey(deps, SK)
  await seedApiKey(deps, AK)
  await seedApiKey(deps, PROD_SK, { environmentId: TEST_TENANT.productionEnvironmentId })
  app = createApp(deps)
})

function call(path: string, method = 'GET', body?: unknown, key: string = SK, headers = {}) {
  return app.request(`/v1/admin${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body !== undefined && { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}
const json = async <T>(res: Response) => (await res.json()) as T

async function billing() {
  const created = await call('/organization-roles', 'POST', {
    key: 'billing',
    name: 'Billing',
    permissions: ['org:billing:read', 'org:billing:write'],
  })
  expect(created.status).toBe(201)
  const patched = await call(
    '/organization-roles/billing',
    'PATCH',
    { permissions: ['org:billing:read', 'org:invoices:read'] },
    SK,
    { 'if-match': '"1"' }
  )
  expect(patched.status).toBe(200)
}

describe('GET /v1/admin/organization-roles/:key/versions', () => {
  test('lists every version with its count and hash, to a secret key and an agent key', async () => {
    await billing()
    for (const key of [SK, AK]) {
      const res = await call('/organization-roles/billing/versions', 'GET', undefined, key)
      expect(res.status).toBe(200)
      const { data } = await json<OrganizationRoleVersionList>(res)
      expect(data.map((v) => [v.version, v.permissionCount])).toEqual([
        [1, 2],
        [2, 2],
      ])
      expect(data[0]?.permissionsHash).toMatch(/^1\./)
      expect(data[0]?.permissionsHash).not.toBe(data[1]?.permissionsHash)
    }
  })

  test('an unknown role, and another environment’s role, are 404', async () => {
    await billing()
    expect((await call('/organization-roles/nope/versions')).status).toBe(404)
    expect(
      (await call('/organization-roles/billing/versions', 'GET', undefined, PROD_SK)).status
    ).toBe(404)
  })

  test('answers organization.disabled while organizations are off', async () => {
    deps.environmentSettings.seed(TEST_TENANT.environmentId, {
      revision: 2,
      settings: DEFAULT_ENVIRONMENT_SETTINGS,
    })
    const res = await call('/organization-roles/admin/versions')
    expect(res.status).toBe(403)
  })
})

describe('GET /v1/admin/organization-roles/:key/versions/:version', () => {
  test('gives the permissions and what changed from the version before', async () => {
    await billing()
    const v2 = await json<OrganizationRoleVersion>(
      await call('/organization-roles/billing/versions/2', 'GET', undefined, AK)
    )
    expect(v2).toMatchObject({
      version: 2,
      roleKey: 'billing',
      permissions: ['org:billing:read', 'org:invoices:read'],
      added: ['org:invoices:read'],
      removed: ['org:billing:write'],
    })
    const v1 = await json<OrganizationRoleVersion>(
      await call('/organization-roles/billing/versions/1')
    )
    expect(v1.added).toEqual(['org:billing:read', 'org:billing:write'])
    expect(v1.removed).toEqual([])
  })

  test('an unknown version is 404 and a malformed one 422', async () => {
    await billing()
    expect((await call('/organization-roles/billing/versions/9')).status).toBe(404)
    expect((await call('/organization-roles/billing/versions/0')).status).toBe(422)
  })
})

describe('GET /v1/admin/organizations/:id/members/:userId/access', () => {
  async function member(role: string) {
    const org = await json<Organization>(
      await call('/organizations', 'POST', { name: 'Acme Corp', slug: 'acme' })
    )
    const user = await json<User>(await call('/users', 'POST', { email: 'maya@northline.app' }))
    return { org, user, role }
  }
  const explain = (orgId: string, userId: string, permission: string, key = SK) =>
    call(
      `/organizations/${orgId}/members/${userId}/access?permission=${permission}`,
      'GET',
      undefined,
      key
    )

  test('explains a granted permission with the role and its version', async () => {
    await billing()
    const { org, user } = await member('billing')
    const added = await call(`/organizations/${org.id}/memberships`, 'POST', {
      userId: user.id,
      role: 'billing',
    })
    expect(added.status).toBe(201)
    const granted = await json<OrganizationAccessExplanation>(
      await explain(org.id, user.id, 'org:invoices:read', AK)
    )
    expect(granted).toMatchObject({
      member: true,
      granted: true,
      reason: 'permission_granted',
      role: { key: 'billing', version: 2 },
    })
    const denied = await json<OrganizationAccessExplanation>(
      await explain(org.id, user.id, 'org:billing:write')
    )
    expect(denied).toMatchObject({ member: true, granted: false, reason: 'permission_not_granted' })
  })

  test('a user who is not a member is not granted anything', async () => {
    const { org, user } = await member('member')
    const res = await explain(org.id, user.id, 'org:billing:read')
    expect(res.status).toBe(200)
    expect(await json<OrganizationAccessExplanation>(res)).toMatchObject({
      member: false,
      role: null,
      granted: false,
      reason: 'not_a_member',
    })
  })

  test('an unknown organization is 404, another environment’s too, a bad permission 422', async () => {
    const { org, user } = await member('member')
    expect((await explain(crypto.randomUUID(), user.id, 'org:billing:read')).status).toBe(404)
    expect((await explain(org.id, user.id, 'org:billing:read', PROD_SK)).status).toBe(404)
    expect((await explain(org.id, user.id, 'Not-A-Key')).status).toBe(422)
  })
})
