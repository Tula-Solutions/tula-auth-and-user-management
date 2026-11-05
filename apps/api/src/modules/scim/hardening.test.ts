import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { DEFAULT_ENVIRONMENT_SETTINGS } from '@tula-tech/contract'
import { createApp } from '~/index'
import * as Audit from '~/modules/audit/service'
import * as Organizations from '~/modules/organization/service'
import * as ScimTokens from '~/modules/scim-token/service'
import { createInstanceTestDeps, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'

const TENANT = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }
const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User'
const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group'

let deps: TestDeps
let orgId: string
let token: string

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
  await verifiedDomain(orgId, 'acme.test')
})

describe('SCIM hardening (TULA-171)', () => {
  test('H-055: a deactivating PUT with a userName that is not an email still deactivates', async () => {
    const id = await provision('a@acme.test')
    const res = await scim('PUT', `/Users/${id}`, {
      schemas: [USER_SCHEMA],
      userName: 'DOMAIN\\a',
      active: false,
    })
    expect(res.status).toBe(200)
    expect(res.body.active).toBe(false)
  })

  test('H-052: one PATCH cannot add more members than the per-request cap', async () => {
    const id = (await scim('POST', '/Groups', group('Big'))).body.id as string
    const members = Array.from({ length: 1001 }, () => ({ value: Bun.randomUUIDv7() }))
    const lookups = spyOn(deps.scim, 'findUser')
    const res = await scim('PATCH', `/Groups/${id}`, {
      Operations: [{ op: 'add', path: 'members', value: members }],
    })
    expect(res.status).toBe(400)
    expect(lookups).not.toHaveBeenCalled()
    expect(res.body.scimType).toBe('invalidValue')
  })
})
