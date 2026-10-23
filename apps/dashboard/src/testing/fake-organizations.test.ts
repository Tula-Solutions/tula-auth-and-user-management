import { afterEach, describe, expect, test } from 'bun:test'
import {
  MAX_CUSTOM_ROLES,
  OrganizationDomainListSchema,
  OrganizationDomainSchema,
  OrganizationInvitationListSchema,
  OrganizationInvitationSchema,
  OrganizationListSchema,
  OrganizationMembershipListSchema,
  OrganizationMembershipSchema,
  OrganizationRoleListSchema,
  OrganizationRoleSchema,
  OrganizationSchema,
  UserMembershipListSchema,
} from '@tula-tech/contract'
import {
  FAKE_DOMAIN_CODE,
  type FakeApi,
  fakeDomain,
  fakeMembership,
  fakeOrganization,
  fakeRole,
  IDS,
  installFakeApi,
} from './fake-api'
import { dropMembershipsOf, lastManagerOrganizationIds } from './fake-organizations'

// The fake's organization routes answer as the API does where a screen can tell the
// difference (`apps/api/src/modules/organization`): the shapes are held to the contract's
// schemas, the refusals to the codes and statuses the service throws.

let api: FakeApi | undefined

afterEach(() => {
  api?.restore()
  api = undefined
})

const REDIRECT = 'https://app.example.com/invitation'
const ORG = '00000000-0000-7000-8000-0000000aaa01'
const OTHER = '00000000-0000-7000-8000-0000000aaa02'
const SECOND = '00000000-0000-7000-8000-0000000000d2'
const NO_SUCH = '00000000-0000-7000-8000-ffffffffffff'

/** The fake, signed in, with organizations on and one organization with one manager. */
function arranged(enabled = true): FakeApi {
  api = installFakeApi()
  api.state.signedIn = true
  const settings = api.state.settings.settings
  settings.organizations = { ...settings.organizations, enabled }
  settings.urls = { ...settings.urls, allowedRedirectUrls: [REDIRECT] }
  api.state.users.push({
    id: SECOND,
    email: 'grace@example.com',
    emailVerifiedAt: null,
    firstName: null,
    lastName: null,
    bannedAt: null,
    lastSignInAt: null,
    createdAt: '2026-10-04T12:00:00.000Z',
  })
  api.state.organizations.push(fakeOrganization({ id: ORG, name: 'Acme', slug: 'acme' }))
  api.state.memberships.push(
    fakeMembership({ organizationId: ORG, userId: IDS.user, role: 'admin' })
  )
  return api
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
  environment: string = IDS.development
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://localhost${path}`, {
    method,
    headers: {
      'x-tula-dashboard': '1',
      'x-tula-environment': environment,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, body: text === '' ? {} : JSON.parse(text) }
}

const ROOT = '/v1/admin/organizations'
const ROLES = '/v1/admin/organization-roles'

describe('while organizations are off every route says so', () => {
  test.each([
    ['GET', ROOT, undefined],
    ['POST', ROOT, { name: 'Acme', slug: 'acme-2' }],
    ['GET', `${ROOT}/${ORG}`, undefined],
    ['GET', `${ROOT}/${ORG}/memberships`, undefined],
    ['GET', `${ROOT}/${ORG}/invitations`, undefined],
    ['GET', `/v1/admin/users/${IDS.user}/organizations`, undefined],
    ['GET', ROLES, undefined],
    ['POST', ROLES, { key: 'billing', name: 'Billing', permissions: [] }],
  ])('%s %s is 403 organization.disabled', async (method, path, body) => {
    arranged(false)
    const answer = await call(method as string, path as string, body)
    expect(answer.status).toBe(403)
    expect(answer.body.code).toBe('organization.disabled')
  })
})

describe('the shapes are the contract’s', () => {
  test('organizations, memberships, invitations, a user’s organizations and roles parse', async () => {
    arranged()
    api?.state.invitations.push({
      id: '00000000-0000-7000-8000-0000000bbb01',
      environmentId: IDS.development,
      organizationId: ORG,
      email: 'new.hire@example.com',
      role: 'member',
      status: 'pending',
      invitedBy: null,
      expiresAt: '2026-10-30T12:00:00.000Z',
      createdAt: '2026-10-23T12:00:00.000Z',
    })
    api?.state.roles.push(fakeRole())
    expect(OrganizationListSchema.safeParse((await call('GET', ROOT)).body).success).toBe(true)
    expect(OrganizationSchema.safeParse((await call('GET', `${ROOT}/${ORG}`)).body).success).toBe(
      true
    )
    const members = await call('GET', `${ROOT}/${ORG}/memberships`)
    expect(OrganizationMembershipListSchema.safeParse(members.body).success).toBe(true)
    const invitations = await call('GET', `${ROOT}/${ORG}/invitations`)
    expect(OrganizationInvitationListSchema.safeParse(invitations.body).success).toBe(true)
    const mine = await call('GET', `/v1/admin/users/${IDS.user}/organizations`)
    expect(UserMembershipListSchema.safeParse(mine.body).success).toBe(true)
    expect((mine.body.data as { name: string }[])[0]?.name).toBe('Acme')
    const roles = await call('GET', ROLES)
    expect(OrganizationRoleListSchema.safeParse(roles.body).success).toBe(true)
    expect((roles.body.data as { key: string }[]).map((role) => role.key)).toEqual([
      'admin',
      'member',
      'billing',
    ])
  })

  test('what a write answers parses too', async () => {
    arranged()
    const added = await call('POST', `${ROOT}/${ORG}/memberships`, {
      userId: SECOND,
      role: 'member',
    })
    expect(added.status).toBe(201)
    expect(OrganizationMembershipSchema.safeParse(added.body).success).toBe(true)
    const invited = await call('POST', `${ROOT}/${ORG}/invitations`, {
      email: 'new.hire@example.com',
      role: 'member',
      redirectUrl: REDIRECT,
    })
    expect(invited.status).toBe(201)
    expect(OrganizationInvitationSchema.safeParse(invited.body).success).toBe(true)
    const role = await call('POST', ROLES, { key: 'billing', name: 'Billing', permissions: [] })
    expect(role.status).toBe(201)
    expect(OrganizationRoleSchema.safeParse(role.body).success).toBe(true)
  })

  test('an id that is no UUID is 422, an organization that is not there is 404', async () => {
    arranged()
    expect((await call('GET', `${ROOT}/not-an-id`)).status).toBe(422)
    expect((await call('GET', `${ROOT}/${NO_SUCH}`)).status).toBe(404)
    expect((await call('GET', `/v1/admin/users/not-an-id/organizations`)).status).toBe(422)
    expect((await call('GET', `/v1/admin/users/${NO_SUCH}/organizations`)).status).toBe(404)
  })

  test('a user’s organizations are those of the environment asked about', async () => {
    arranged()
    api?.state.organizations.push(
      fakeOrganization({
        id: OTHER,
        name: 'Elsewhere',
        slug: 'elsewhere',
        environmentId: IDS.production,
      })
    )
    api?.state.memberships.push(
      fakeMembership({
        organizationId: OTHER,
        userId: IDS.user,
        environmentId: IDS.production,
      })
    )
    const dev = await call('GET', `/v1/admin/users/${IDS.user}/organizations`)
    expect(
      (dev.body.data as { organizationId: string }[]).map((row) => row.organizationId)
    ).toEqual([ORG])
  })
})

describe('what the service refuses, the fake refuses', () => {
  test('a slug is unique in its environment', async () => {
    arranged()
    const taken = await call('POST', ROOT, { name: 'Acme Two', slug: 'acme' })
    expect(taken.status).toBe(409)
    expect(taken.body.code).toBe('organization.slug_taken')
    const bad = await call('POST', ROOT, { name: 'Acme Two', slug: 'Not A Slug' })
    expect(bad.status).toBe(422)
  })

  test('the only manager cannot be demoted, removed or stripped by a role change', async () => {
    arranged()
    const demote = await call('PATCH', `${ROOT}/${ORG}/memberships/${IDS.user}`, { role: 'member' })
    expect(demote.status).toBe(409)
    expect(demote.body.code).toBe('organization.last_manager')
    const remove = await call('DELETE', `${ROOT}/${ORG}/memberships/${IDS.user}`)
    expect(remove.status).toBe(409)
    expect(remove.body.code).toBe('organization.last_manager')
    api?.state.roles.push(fakeRole({ key: 'owner', permissions: ['org:sys:memberships:manage'] }))
    api?.state.memberships.splice(
      0,
      1,
      fakeMembership({ organizationId: ORG, userId: IDS.user, role: 'owner' })
    )
    const stripped = await call(
      'PATCH',
      `${ROLES}/owner`,
      { permissions: [] },
      { 'if-match': '"1"' }
    )
    expect(stripped.status).toBe(409)
    expect(stripped.body.code).toBe('organization.last_manager')
  })

  test('a member is added once, and with a role that exists', async () => {
    arranged()
    expect(
      (await call('POST', `${ROOT}/${ORG}/memberships`, { userId: IDS.user, role: 'member' })).body
        .code
    ).toBe('organization.member_exists')
    expect(
      (await call('POST', `${ROOT}/${ORG}/memberships`, { userId: SECOND, role: 'nonesuch' })).body
        .code
    ).toBe('organization.role_unknown')
    expect(
      (await call('POST', `${ROOT}/${ORG}/memberships`, { userId: NO_SUCH, role: 'member' })).status
    ).toBe(404)
  })

  test('an invitation needs an allowed redirect URL and is one pending per address', async () => {
    arranged()
    const wrong = await call('POST', `${ROOT}/${ORG}/invitations`, {
      email: 'new.hire@example.com',
      role: 'member',
      redirectUrl: 'https://elsewhere.example.com/x',
    })
    expect(wrong.status).toBe(422)
    const body = {
      email: 'new.hire@example.com',
      role: 'member',
      redirectUrl: REDIRECT,
    }
    expect((await call('POST', `${ROOT}/${ORG}/invitations`, body)).status).toBe(201)
    const again = await call('POST', `${ROOT}/${ORG}/invitations`, {
      ...body,
      email: 'New.Hire@example.com',
    })
    expect(again.status).toBe(409)
    expect(again.body.code).toBe('organization.invitation_exists')
  })

  test('an invitation is withdrawn once; a used one cannot be', async () => {
    arranged()
    const made = await call('POST', `${ROOT}/${ORG}/invitations`, {
      email: 'new.hire@example.com',
      role: 'member',
      redirectUrl: REDIRECT,
    })
    const id = made.body.id as string
    expect((await call('DELETE', `${ROOT}/${ORG}/invitations/${id}`)).status).toBe(204)
    const again = await call('DELETE', `${ROOT}/${ORG}/invitations/${id}`)
    expect(again.status).toBe(410)
    expect(again.body.code).toBe('organization.invitation_used')
    expect((await call('DELETE', `${ROOT}/${ORG}/invitations/${NO_SUCH}`)).body.code).toBe(
      'organization.invitation_not_found'
    )
  })
})

describe('roles', () => {
  test('a change needs the version it read, and a stale one is refused', async () => {
    arranged()
    api?.state.roles.push(fakeRole())
    const without = await call('PATCH', `${ROLES}/billing`, { name: 'Finance' })
    expect(without.status).toBe(428)
    const stale = await call(
      'PATCH',
      `${ROLES}/billing`,
      { name: 'Finance' },
      { 'if-match': '"7"' }
    )
    expect(stale.status).toBe(412)
    const malformed = await call(
      'PATCH',
      `${ROLES}/billing`,
      { name: 'Finance' },
      { 'if-match': 'x' }
    )
    expect(malformed.status).toBe(412)
    const done = await call('PATCH', `${ROLES}/billing`, { name: 'Finance' }, { 'if-match': '"1"' })
    expect(done.status).toBe(200)
    expect(done.body.version).toBe(2)
    // A change that changes nothing keeps the version.
    const same = await call('PATCH', `${ROLES}/billing`, { name: 'Finance' }, { 'if-match': '"2"' })
    expect(same.body.version).toBe(2)
  })

  test('a built-in role is never changed or deleted, and a key is not reused', async () => {
    arranged()
    const taken = await call('POST', ROLES, { key: 'admin', name: 'Mine', permissions: [] })
    expect(taken.body.code).toBe('organization.role_exists')
    const built = await call('DELETE', `${ROLES}/admin`, undefined, { 'if-match': '"1"' })
    expect(built.status).toBe(409)
    expect(built.body.code).toBe('organization.role_built_in')
  })

  test('a role in use is not deleted; an idle one is', async () => {
    arranged()
    api?.state.roles.push(fakeRole(), fakeRole({ key: 'idle', name: 'Idle', permissions: [] }))
    api?.state.memberships.push(
      fakeMembership({ organizationId: ORG, userId: SECOND, role: 'billing' })
    )
    const used = await call('DELETE', `${ROLES}/billing`, undefined, { 'if-match': '"1"' })
    expect(used.status).toBe(409)
    expect(used.body.code).toBe('organization.role_in_use')
    expect((await call('DELETE', `${ROLES}/idle`, undefined, { 'if-match': '"1"' })).status).toBe(
      204
    )
  })

  test('the cap of custom roles holds, with the number', async () => {
    arranged()
    for (let index = 0; index < MAX_CUSTOM_ROLES; index += 1) {
      api?.state.roles.push(fakeRole({ key: `role_${index}`, name: `Role ${index}` }))
    }
    const over = await call('POST', ROLES, { key: 'one_more', name: 'One more', permissions: [] })
    expect(over.status).toBe(409)
    expect(over.body.code).toBe('organization.role_limit')
    expect((over.body.params as { max: number }).max).toBe(MAX_CUSTOM_ROLES)
  })
})

describe('domains', () => {
  const DOMAINS = `${ROOT}/${ORG}/domains`
  const start = { domain: 'acme.com', email: 'admin@acme.com', mode: 'suggest' }

  test('a claim waits for its code, which verifies it; the shapes are the contract’s', async () => {
    arranged()
    const claimed = await call('POST', DOMAINS, start)
    expect(claimed.status).toBe(201)
    expect(OrganizationDomainSchema.safeParse(claimed.body).success).toBe(true)
    expect(claimed.body.verifiedAt).toBeNull()
    expect(claimed.body.code).toBeUndefined()
    const id = claimed.body.id as string
    const wrong = await call('POST', `${DOMAINS}/${id}/verify`, { code: '000000' })
    expect(wrong.status).toBe(422)
    expect(wrong.body.code).toBe('verification.invalid_code')
    const right = await call('POST', `${DOMAINS}/${id}/verify`, { code: FAKE_DOMAIN_CODE })
    expect(right.status).toBe(200)
    expect(right.body.verifiedAt).not.toBeNull()
    const list = await call('GET', DOMAINS)
    expect(OrganizationDomainListSchema.safeParse(list.body).success).toBe(true)
  })

  test('the service’s refusals: public domain, other domain, taken, cap, bad ids', async () => {
    arranged()
    expect(
      (await call('POST', DOMAINS, { ...start, domain: 'gmail.com', email: 'a@gmail.com' })).body
        .code
    ).toBe('organization.domain_public')
    expect((await call('POST', DOMAINS, { ...start, email: 'a@mail.acme.com' })).body.code).toBe(
      'organization.domain_address_mismatch'
    )
    expect((await call('POST', DOMAINS, { ...start, domain: 'Acme.com' })).status).toBe(422)
    api?.state.organizations.push(fakeOrganization({ id: OTHER, slug: 'other' }))
    api?.state.domains.push(fakeDomain({ organizationId: OTHER, domain: 'acme.com' }))
    expect((await call('POST', DOMAINS, start)).body.code).toBe('organization.domain_taken')
    for (let index = 0; index < 10; index += 1) {
      api?.state.domains.push(fakeDomain({ organizationId: ORG, domain: `d${index}.example.org` }))
    }
    const over = await call('POST', DOMAINS, {
      ...start,
      domain: 'extra.example.org',
      email: 'a@extra.example.org',
    })
    expect(over.body.code).toBe('organization.domain_limit')
    expect((over.body.params as { max: number }).max).toBe(10)
    expect((await call('PATCH', `${DOMAINS}/not-a-claim`, { mode: 'auto_join' })).status).toBe(404)
  })

  test('a code works once, expires, and is counted', async () => {
    arranged()
    const pending = fakeDomain({
      organizationId: ORG,
      verifiedAt: null,
      codeExpiresAt: '2026-10-22T00:00:00.000Z',
    })
    api?.state.domains.push(pending)
    const expired = await call('POST', `${DOMAINS}/${pending.id}/verify`, {
      code: FAKE_DOMAIN_CODE,
    })
    expect(expired.body.code).toBe('verification.expired')
    const fresh = await call('POST', DOMAINS, start)
    expect(fresh.status).toBe(201)
    const id = (await call('GET', DOMAINS)).body.data as { id: string; domain: string }[]
    const claim = id.find((entry) => entry.domain === 'acme.com')
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await call('POST', `${DOMAINS}/${claim?.id}/verify`, { code: '000000' })
    }
    const locked = await call('POST', `${DOMAINS}/${claim?.id}/verify`, { code: FAKE_DOMAIN_CODE })
    expect(locked.status).toBe(429)
    expect(locked.body.code).toBe('verification.too_many_attempts')
  })

  test('a mode is changed, a domain removed, and an organization takes its claims with it', async () => {
    arranged()
    const claim = fakeDomain({ organizationId: ORG })
    api?.state.domains.push(claim)
    const changed = await call('PATCH', `${DOMAINS}/${claim.id}`, { mode: 'auto_join' })
    expect(changed.body.mode).toBe('auto_join')
    expect((await call('DELETE', `${DOMAINS}/${claim.id}`)).status).toBe(204)
    api?.state.domains.push(fakeDomain({ organizationId: ORG, domain: 'again.example.org' }))
    expect((await call('DELETE', `${ROOT}/${ORG}`)).status).toBe(204)
    expect(api?.state.domains).toEqual([])
  })
})

describe('the user’s deletion', () => {
  test('lastManagerOrganizationIds names the organizations the user alone manages', () => {
    arranged()
    const state = api?.state as FakeApi['state']
    state.organizations.push(
      fakeOrganization({ id: OTHER, slug: 'other' }),
      fakeOrganization({ id: NO_SUCH, slug: 'third', environmentId: IDS.production })
    )
    state.memberships.push(
      fakeMembership({ organizationId: OTHER, userId: IDS.user, role: 'admin' }),
      fakeMembership({ organizationId: OTHER, userId: SECOND, role: 'admin' })
    )
    // OTHER has two managers; only ORG hangs on this user.
    expect(lastManagerOrganizationIds(state, IDS.development, IDS.user)).toEqual([ORG])
    expect(lastManagerOrganizationIds(state, IDS.development, SECOND)).toEqual([])
    expect(lastManagerOrganizationIds(state, IDS.production, IDS.user)).toEqual([])
  })

  test('the fake API refuses the deletion with the ids and the count, and deletes after a handover', async () => {
    arranged()
    const refused = await call('DELETE', `/v1/admin/users/${IDS.user}`)
    expect(refused.status).toBe(409)
    expect(refused.body.code).toBe('user.last_organization_manager')
    expect(refused.body.params).toEqual({ organizationIds: ORG, count: 1 })
    api?.state.memberships.push(
      fakeMembership({ organizationId: ORG, userId: SECOND, role: 'admin' })
    )
    expect((await call('DELETE', `/v1/admin/users/${IDS.user}`)).status).toBe(204)
    expect(api?.state.memberships.some((entry) => entry.userId === IDS.user)).toBe(false)
  })

  test('dropMembershipsOf takes a user out of every organization', () => {
    arranged()
    const state = api?.state as FakeApi['state']
    dropMembershipsOf(state, IDS.user)
    expect(state.memberships).toEqual([])
  })
})
