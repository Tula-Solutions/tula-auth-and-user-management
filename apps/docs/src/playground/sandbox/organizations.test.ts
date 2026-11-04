import { describe, expect, test } from 'bun:test'
import {
  AssignableRoleListSchema,
  ClientConfigSchema,
  MyOrganizationInvitationListSchema,
  OrganizationDomainSchema,
  OrganizationInvitationSchema,
  OrganizationMemberListSchema,
  UserOrganizationListSchema,
} from '@tula-tech/contract'
import { isTulaError } from '@tula-tech/core'
import {
  createSandbox,
  DEFAULT_SANDBOX_SETTINGS,
  DEMO_EMAIL,
  DEMO_INVITATION_TOKEN,
  type Sandbox,
} from './index'

const PAGE = 'http://localhost:4321/playground/'
const ACME = '0198a000-0000-7000-8000-000000000001'
const GLOBEX = '0198a000-0000-7000-8000-000000000002'
const INITECH = '0198a000-0000-7000-8000-000000000003'
const HOOLI = '0198a000-0000-7000-8000-000000000004'
const GRACE = 'usr_sandbox_grace'
const ADA = 'usr_sandbox_ada'

/** A sandbox with organizations on, signed in as the demo account (Ada). */
async function make(organizations = true): Promise<Sandbox> {
  const sandbox = createSandbox({
    settings: { ...DEFAULT_SANDBOX_SETTINGS, organizations },
    pageUrl: PAGE,
  })
  await sandbox.signInAsDemo()
  return sandbox
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (isTulaError(error)) {
      return error.code
    }
    throw error
  }
  return 'resolved'
}

async function call(sandbox: Sandbox, method: string, path: string, body?: unknown) {
  const token =
    sandbox.client.state.status === 'signed-in' ? await sandbox.client.session.getToken() : null
  const response = await sandbox.fetch(
    new Request(`https://sandbox.tula.invalid/v1/client${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-tula-publishable-key': 'tula_pk_dev_sandbox',
        ...(token && { authorization: `Bearer ${token}` }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
  )
  return { status: response.status, json: response.status === 204 ? null : await response.json() }
}

function payload(token: string | null): Record<string, unknown> {
  return JSON.parse(atob((token ?? '').split('.')[1] ?? '')) as Record<string, unknown>
}

describe('organizations in the sandbox: configuration', () => {
  test('the client config says whether organizations are on, in the contract shape', async () => {
    for (const on of [true, false]) {
      const sandbox = createSandbox({
        settings: { ...DEFAULT_SANDBOX_SETTINGS, organizations: on },
        pageUrl: PAGE,
      })
      const { json } = await call(sandbox, 'GET', '/config')
      expect(ClientConfigSchema.parse(json).organizations).toEqual({
        enabled: on,
        allowUserCreated: true,
        personalAccount: true,
      })
    }
  })

  test('with organizations off every organization route answers organization.disabled', async () => {
    const sandbox = await make(false)
    expect(await codeOf(sandbox.client.organizations.list())).toBe('organization.disabled')
    expect(await codeOf(sandbox.client.organizations.create({ name: 'X', slug: 'x' }))).toBe(
      'organization.disabled'
    )
    expect(await codeOf(sandbox.client.organizations.invitations.preview('x'))).toBe(
      'organization.disabled'
    )
  })
})

describe('organizations in the sandbox: the list, creating and switching', () => {
  test('lists the demo account organizations, as the contract shapes them', async () => {
    const sandbox = await make()
    const { json } = await call(sandbox, 'GET', '/me/organizations')
    const list = UserOrganizationListSchema.parse(json)
    expect(list.data.map((one) => [one.name, one.role])).toEqual([
      ['Acme', 'admin'],
      ['Globex', 'member'],
    ])
    expect(list.data[1]?.permissions).toEqual(['org:sys:memberships:read'])
    expect(list.activeOrganizationId).toBeNull()
  })

  test('creating makes the caller its admin; a taken short name is refused', async () => {
    const sandbox = await make()
    const created = await sandbox.client.organizations.create({ name: 'Wayne', slug: 'wayne' })
    expect(created.role).toBe('admin')
    expect(created.permissions).toContain('org:sys:organization:delete')
    expect(
      await codeOf(sandbox.client.organizations.create({ name: 'Other', slug: 'wayne' }))
    ).toBe('organization.slug_taken')
    expect(
      await codeOf(sandbox.client.organizations.create({ name: 'Bad', slug: 'Not Valid' }))
    ).toBe('validation.failed')
  })

  test('switching puts org_id in the next access token and back to the personal account takes it out', async () => {
    const sandbox = await make()
    const switched = await sandbox.client.organizations.setActive(ACME)
    expect(payload(switched.accessToken ?? null).org_id).toBe(ACME)
    expect((await sandbox.client.organizations.list()).activeOrganizationId).toBe(ACME)
    const personal = await sandbox.client.organizations.setActive(null)
    expect(payload(personal.accessToken ?? null).org_id).toBeUndefined()
    expect(await codeOf(sandbox.client.organizations.setActive(HOOLI))).toBe(
      'organization.not_a_member'
    )
  })

  test('suggests organizations whose verified domain is the account address, and joins one as a member', async () => {
    const sandbox = await make()
    const { data } = await sandbox.client.organizations.suggestions()
    expect(data.map((one) => one.name)).toEqual(['Initech'])
    const joined = await sandbox.client.organizations.join(INITECH)
    expect(joined.role).toBe('member')
    expect((await sandbox.client.organizations.suggestions()).data).toEqual([])
    expect(await codeOf(sandbox.client.organizations.join(ACME))).toBe(
      'organization.suggestion_unavailable'
    )
  })
})

describe('organizations in the sandbox: what a role allows', () => {
  test('a member can read the member list and nothing else; the refusal names the permission', async () => {
    const sandbox = await make()
    const members = OrganizationMemberListSchema.parse(
      (await call(sandbox, 'GET', `/me/organizations/${GLOBEX}/members`)).json
    )
    expect(members.data.map((one) => [one.userId, one.role])).toEqual([
      [ADA, 'member'],
      [GRACE, 'admin'],
    ])
    expect(members.data[0]?.name).toBe('Ada Lovelace')
    const refused = await call(sandbox, 'PATCH', `/me/organizations/${GLOBEX}`, { name: 'Nope' })
    expect(refused.status).toBe(403)
    expect(refused.json).toMatchObject({
      code: 'organization.permission_required',
      params: { permission: 'org:sys:organization:manage' },
    })
    for (const [method, path] of [
      ['DELETE', `/me/organizations/${GLOBEX}`],
      ['GET', `/me/organizations/${GLOBEX}/roles`],
      ['GET', `/me/organizations/${GLOBEX}/invitations`],
      ['GET', `/me/organizations/${GLOBEX}/domains`],
      ['PATCH', `/me/organizations/${GLOBEX}/members/${GRACE}`],
    ] as const) {
      const response = await call(sandbox, method, path, { role: 'member' })
      expect(response.json).toMatchObject({ code: 'organization.permission_required' })
    }
  })

  test('a user who is not a member is told so for any organization route, including a missing one', async () => {
    const sandbox = await make()
    for (const id of [HOOLI, '0198a000-0000-7000-8000-0000000000ff']) {
      const response = await call(sandbox, 'GET', `/me/organizations/${id}/members`)
      expect(response.json).toMatchObject({ code: 'organization.not_a_member' })
    }
  })

  test('an admin renames and deletes; a rename to a taken short name is refused', async () => {
    const sandbox = await make()
    const renamed = await sandbox.client.organizations.update(ACME, { name: 'Acme Inc' })
    expect(renamed.name).toBe('Acme Inc')
    expect(await codeOf(sandbox.client.organizations.update(ACME, { slug: 'globex' }))).toBe(
      'organization.slug_taken'
    )
    await sandbox.client.organizations.remove(ACME)
    expect((await sandbox.client.organizations.list()).data.map((one) => one.name)).toEqual([
      'Globex',
    ])
  })
})

describe('organizations in the sandbox: members', () => {
  test('lists the assignable roles', async () => {
    const sandbox = await make()
    const roles = AssignableRoleListSchema.parse(
      (await call(sandbox, 'GET', `/me/organizations/${ACME}/roles`)).json
    )
    expect(roles.data.map((one) => one.key)).toEqual(['admin', 'member', 'support'])
  })

  test('changes a role and removes a member; an unknown role is refused', async () => {
    const sandbox = await make()
    const changed = await sandbox.client.organizations.members.changeRole(ACME, GRACE, 'admin')
    expect(changed.role).toBe('admin')
    expect(
      await codeOf(sandbox.client.organizations.members.changeRole(ACME, GRACE, 'owner'))
    ).toBe('organization.role_unknown')
    await sandbox.client.organizations.members.remove(ACME, GRACE)
    expect((await sandbox.client.organizations.members.list(ACME)).data).toHaveLength(1)
    expect(await codeOf(sandbox.client.organizations.members.remove(ACME, GRACE))).toBe(
      'organization.not_a_member'
    )
  })

  test('the last member who can manage members cannot leave, be removed or be demoted', async () => {
    const sandbox = await make()
    expect(await codeOf(sandbox.client.organizations.members.changeRole(ACME, ADA, 'member'))).toBe(
      'organization.last_manager'
    )
    expect(await codeOf(sandbox.client.organizations.leave(ACME))).toBe('organization.last_manager')
    // With a second admin the first may go.
    await sandbox.client.organizations.members.changeRole(ACME, GRACE, 'admin')
    await sandbox.client.organizations.leave(ACME)
    expect((await sandbox.client.organizations.list()).data.map((one) => one.name)).toEqual([
      'Globex',
    ])
  })

  test('a member may leave without holding any permission', async () => {
    const sandbox = await make()
    await sandbox.client.organizations.leave(GLOBEX)
    expect((await sandbox.client.organizations.list()).data.map((one) => one.name)).toEqual([
      'Acme',
    ])
  })
})

describe('organizations in the sandbox: invitations', () => {
  const invite = (sandbox: Sandbox, address: string, role = 'member') =>
    call(sandbox, 'POST', `/me/organizations/${ACME}/invitations`, {
      email: address,
      role,
      redirectUrl: `${PAGE}invitation`,
    })

  test('invites, lists, refuses a duplicate and a member, and revokes', async () => {
    const sandbox = await make()
    const sent = await invite(sandbox, 'new@example.com')
    const invitation = OrganizationInvitationSchema.parse(sent.json)
    expect(invitation.status).toBe('pending')
    expect(sandbox.world.inbox.some((mail) => mail.to === 'new@example.com')).toBe(true)
    expect((await invite(sandbox, 'NEW@example.com')).json).toMatchObject({
      code: 'organization.invitation_exists',
    })
    expect((await invite(sandbox, 'grace@example.test')).json).toMatchObject({
      code: 'organization.member_exists',
    })
    expect((await invite(sandbox, 'x@example.com', 'owner')).json).toMatchObject({
      code: 'organization.role_unknown',
    })
    const listed = await sandbox.client.organizations.invitations.list(ACME)
    expect(listed.data.map((one) => one.email)).toEqual(['new@example.com'])
    await sandbox.client.organizations.invitations.revoke(ACME, invitation.id)
    expect((await sandbox.client.organizations.invitations.list(ACME)).data).toEqual([])
  })

  test('an invitation to a page on another origin is refused', async () => {
    const sandbox = await make()
    const response = await call(sandbox, 'POST', `/me/organizations/${ACME}/invitations`, {
      email: 'a@example.com',
      role: 'member',
      redirectUrl: 'https://evil.example/invite',
    })
    expect(response.json).toMatchObject({ code: 'request.redirect_not_allowed' })
  })

  test('the demo invitation is previewed, then accepted by the account it was sent to', async () => {
    const sandbox = await make()
    const preview = await sandbox.client.organizations.invitations.preview(DEMO_INVITATION_TOKEN)
    expect(preview).toMatchObject({ organizationName: 'Hooli', role: 'member', email: DEMO_EMAIL })
    const joined = await sandbox.client.organizations.invitations.accept(DEMO_INVITATION_TOKEN)
    expect(joined.name).toBe('Hooli')
    expect(
      await codeOf(sandbox.client.organizations.invitations.accept(DEMO_INVITATION_TOKEN))
    ).toBe('organization.invitation_used')
  })

  test('declining ends the invitation', async () => {
    const sandbox = await make()
    await sandbox.client.organizations.invitations.decline(DEMO_INVITATION_TOKEN)
    expect(
      await codeOf(sandbox.client.organizations.invitations.preview(DEMO_INVITATION_TOKEN))
    ).toBe('organization.invitation_used')
  })

  test('another account cannot answer it, and an unknown, revoked or expired one says why', async () => {
    const sandbox = await make()
    sandbox.world.organizations.get(HOOLI)?.invitations.push({
      id: 'inv_other',
      email: 'someone@else.test',
      role: 'member',
      status: 'pending',
      invitedBy: GRACE,
      expiresAt: new Date(sandbox.world.now() + 1000).toISOString(),
      createdAt: new Date(sandbox.world.now()).toISOString(),
      token: 'other-token',
    })
    expect(await codeOf(sandbox.client.organizations.invitations.accept('other-token'))).toBe(
      'organization.invitation_wrong_account'
    )
    expect(await codeOf(sandbox.client.organizations.invitations.preview('nothing'))).toBe(
      'organization.invitation_not_found'
    )
    const revoked = sandbox.world.organizations.get(HOOLI)?.invitations[0]
    if (revoked) {
      revoked.status = 'revoked'
    }
    expect(
      await codeOf(sandbox.client.organizations.invitations.preview(DEMO_INVITATION_TOKEN))
    ).toBe('organization.invitation_revoked')
    const expiring = sandbox.world.organizations.get(HOOLI)?.invitations[1]
    if (expiring) {
      expiring.expiresAt = new Date(sandbox.world.now() - 1).toISOString()
    }
    expect(await codeOf(sandbox.client.organizations.invitations.preview('other-token'))).toBe(
      'organization.invitation_expired'
    )
  })

  test('an account whose address is not verified cannot accept', async () => {
    const sandbox = await make()
    const ada = sandbox.world.users.get(ADA)
    if (ada) {
      ada.emailVerifiedAt = null
    }
    expect(
      await codeOf(sandbox.client.organizations.invitations.accept(DEMO_INVITATION_TOKEN))
    ).toBe('organization.invitation_email_unverified')
  })
})

describe('organizations in the sandbox: custom roles', () => {
  test('a custom role can be given, and carries the permissions it holds', async () => {
    const sandbox = await make()
    const changed = await sandbox.client.organizations.members.changeRole(ACME, GRACE, 'support')
    expect(changed.role).toBe('support')
    const org = sandbox.world.organizations.get(ACME)
    expect(org?.members.find((one) => one.userId === GRACE)?.role).toBe('support')
  })

  test('a member with a custom role gets its permissions in the list, and no more', async () => {
    const sandbox = await make()
    const member = sandbox.world.organizations
      .get(GLOBEX)
      ?.members.find((one) => one.userId === ADA)
    if (member) {
      member.role = 'support'
    }
    const { json } = await call(sandbox, 'GET', '/me/organizations')
    const globex = UserOrganizationListSchema.parse(json).data.find((one) => one.id === GLOBEX)
    expect(globex).toMatchObject({
      role: 'support',
      permissions: ['org:sys:memberships:read', 'org:sys:invitations:manage'],
    })
  })

  test('roles are offered only within the permissions of the one offering them', async () => {
    const sandbox = await make()
    const member = sandbox.world.organizations
      .get(GLOBEX)
      ?.members.find((one) => one.userId === ADA)
    if (member) {
      member.role = 'support'
    }
    const roles = AssignableRoleListSchema.parse(
      (await call(sandbox, 'GET', `/me/organizations/${GLOBEX}/roles`)).json
    )
    expect(roles.data.map((one) => one.key)).toEqual(['member', 'support'])
    const refused = await call(sandbox, 'POST', `/me/organizations/${GLOBEX}/invitations`, {
      email: 'new@example.com',
      role: 'admin',
      redirectUrl: `${PAGE}invitation`,
    })
    expect(refused.json).toMatchObject({ code: 'organization.role_not_assignable' })
    const allowed = await call(sandbox, 'POST', `/me/organizations/${GLOBEX}/invitations`, {
      email: 'new@example.com',
      role: 'support',
      redirectUrl: `${PAGE}invitation`,
    })
    expect(OrganizationInvitationSchema.parse(allowed.json).role).toBe('support')
  })

  test('a role that does not exist is still refused', async () => {
    const sandbox = await make()
    expect(
      await codeOf(sandbox.client.organizations.members.changeRole(ACME, GRACE, 'billing'))
    ).toBe('organization.role_unknown')
  })
})

describe('organizations in the sandbox: how many a user may create', () => {
  test('stops at the cap with organization.limit_reached, and only counts the ones the user created', async () => {
    const sandbox = await make()
    for (const slug of ['one', 'two', 'three']) {
      await sandbox.client.organizations.create({ name: slug, slug })
    }
    expect(await codeOf(sandbox.client.organizations.create({ name: 'Four', slug: 'four' }))).toBe(
      'organization.limit_reached'
    )
    // The organizations the sandbox started with were not created by the visitor.
    expect((await sandbox.client.organizations.list()).data).toHaveLength(5)
  })
})

describe('organizations in the sandbox: my invitations', () => {
  const HOOLI_INVITATION = '0198a000-0000-7000-8000-0000000000e1'

  test('lists the pending invitations to the signed-in address, and nothing else of them', async () => {
    const sandbox = await make()
    const { json } = await call(sandbox, 'GET', '/me/organization-invitations')
    expect(MyOrganizationInvitationListSchema.parse(json).data).toEqual([
      {
        id: HOOLI_INVITATION,
        organizationName: 'Hooli',
        role: 'member',
        expiresAt: expect.any(String),
      },
    ])
    expect(JSON.stringify(json)).not.toContain(DEMO_INVITATION_TOKEN)
    expect(JSON.stringify(json)).not.toContain(DEMO_EMAIL)
  })

  test('accepts by id, once; the list is then empty', async () => {
    const sandbox = await make()
    const accepted = await sandbox.client.organizations.invitations.acceptMine(HOOLI_INVITATION)
    expect(accepted).toMatchObject({ id: HOOLI, name: 'Hooli', role: 'member' })
    expect((await sandbox.client.organizations.invitations.mine()).data).toEqual([])
    expect(
      await codeOf(sandbox.client.organizations.invitations.acceptMine(HOOLI_INVITATION))
    ).toBe('organization.invitation_used')
  })

  test('declines by id: no membership', async () => {
    const sandbox = await make()
    await sandbox.client.organizations.invitations.declineMine(HOOLI_INVITATION)
    expect((await sandbox.client.organizations.invitations.mine()).data).toEqual([])
    expect((await sandbox.client.organizations.list()).data.map((one) => one.id)).not.toContain(
      HOOLI
    )
  })

  test('another account’s invitation and an unknown id look alike; an unverified address sees none', async () => {
    const sandbox = await make()
    sandbox.world.organizations.get(HOOLI)?.invitations.push({
      id: 'inv_other',
      email: 'someone@else.test',
      role: 'member',
      status: 'pending',
      invitedBy: GRACE,
      expiresAt: new Date(sandbox.world.now() + 1000).toISOString(),
      createdAt: new Date(sandbox.world.now()).toISOString(),
      token: 'other-token',
    })
    for (const id of ['inv_other', 'nothing']) {
      expect(await codeOf(sandbox.client.organizations.invitations.acceptMine(id))).toBe(
        'organization.invitation_not_found'
      )
      expect(await codeOf(sandbox.client.organizations.invitations.declineMine(id))).toBe(
        'organization.invitation_not_found'
      )
    }
    const ada = sandbox.world.users.get(ADA)
    if (ada) {
      ada.emailVerifiedAt = null
    }
    expect((await sandbox.client.organizations.invitations.mine()).data).toEqual([])
    expect(
      await codeOf(sandbox.client.organizations.invitations.acceptMine(HOOLI_INVITATION))
    ).toBe('organization.invitation_email_unverified')
  })

  test('with organizations off every route answers organization.disabled', async () => {
    const sandbox = await make(false)
    expect(await codeOf(sandbox.client.organizations.invitations.mine())).toBe(
      'organization.disabled'
    )
    expect(
      await codeOf(sandbox.client.organizations.invitations.acceptMine(HOOLI_INVITATION))
    ).toBe('organization.disabled')
  })
})

describe('organizations in the sandbox: domains', () => {
  const claim = (sandbox: Sandbox, body: Record<string, unknown>) =>
    call(sandbox, 'POST', `/me/organizations/${ACME}/domains`, {
      mode: 'suggest',
      ...body,
    })

  test('claims a domain with an emailed code, which verifies it', async () => {
    const sandbox = await make()
    const started = await claim(sandbox, { domain: 'acme.example', email: 'me@acme.example' })
    const domain = OrganizationDomainSchema.parse(started.json)
    expect(domain.verifiedAt).toBeNull()
    expect(domain.codeExpiresAt).not.toBeNull()
    const mail = sandbox.world.inbox.find((one) => one.to === 'me@acme.example')
    expect(mail?.code).toMatch(/^\d{6}$/)
    const verified = await sandbox.client.organizations.domains.verify(
      ACME,
      domain.id,
      `${mail?.code?.slice(0, 3)} ${mail?.code?.slice(3)}`
    )
    expect(verified.verifiedAt).not.toBeNull()
    expect((await sandbox.client.organizations.domains.list(ACME)).data).toHaveLength(1)
  })

  test('refuses a public domain, a domain verified elsewhere, an address off the domain and a bad name', async () => {
    const sandbox = await make()
    expect(
      (await claim(sandbox, { domain: 'gmail.com', email: 'a@gmail.com' })).json
    ).toMatchObject({
      code: 'organization.domain_public',
    })
    expect(
      (await claim(sandbox, { domain: 'example.test', email: 'a@example.test' })).json
    ).toMatchObject({ code: 'organization.domain_taken' })
    expect(
      (await claim(sandbox, { domain: 'acme.example', email: 'a@other.example' })).json
    ).toMatchObject({ code: 'organization.domain_address_mismatch' })
    expect((await claim(sandbox, { domain: 'no dots', email: 'a@x.example' })).json).toMatchObject({
      code: 'validation.failed',
    })
    expect(
      (await claim(sandbox, { domain: 'acme.example', email: 'a@acme.example', mode: 'x' })).json
    ).toMatchObject({ code: 'validation.failed' })
  })

  test('the number of domains is bounded', async () => {
    const sandbox = await make()
    for (let at = 0; at < 5; at += 1) {
      await claim(sandbox, { domain: `d${at}.example`, email: `a@d${at}.example` })
    }
    const sixth = await claim(sandbox, { domain: 'd5.example', email: 'a@d5.example' })
    expect(sixth.json).toMatchObject({ code: 'organization.domain_limit', params: { max: 5 } })
  })

  test('a wrong code counts down, the fifth wrong guess locks it, and a claim again sends a new code', async () => {
    const sandbox = await make()
    const started = await claim(sandbox, { domain: 'acme.example', email: 'me@acme.example' })
    const { id } = OrganizationDomainSchema.parse(started.json)
    for (let left = 4; left >= 0; left -= 1) {
      const response = await call(
        sandbox,
        'POST',
        `/me/organizations/${ACME}/domains/${id}/verify`,
        { code: '000000' }
      )
      expect(response.json).toMatchObject({
        code: 'verification.invalid_code',
        params: { attemptsRemaining: left },
      })
    }
    const locked = await call(sandbox, 'POST', `/me/organizations/${ACME}/domains/${id}/verify`, {
      code: '000000',
    })
    expect(locked.json).toMatchObject({ code: 'verification.too_many_attempts' })
    const again = await claim(sandbox, { domain: 'acme.example', email: 'me@acme.example' })
    expect(OrganizationDomainSchema.parse(again.json).id).toBe(id)
    const code = [...sandbox.world.inbox]
      .reverse()
      .find((one) => one.to === 'me@acme.example')?.code
    expect(
      (await sandbox.client.organizations.domains.verify(ACME, id, code ?? '')).verifiedAt
    ).not.toBeNull()
  })

  test('a code past its time has expired', async () => {
    let now = Date.now()
    const sandbox = createSandbox({
      settings: { ...DEFAULT_SANDBOX_SETTINGS, organizations: true },
      pageUrl: PAGE,
      now: () => now,
    })
    await sandbox.signInAsDemo()
    const started = await claim(sandbox, { domain: 'acme.example', email: 'me@acme.example' })
    const { id } = OrganizationDomainSchema.parse(started.json)
    now += 11 * 60_000
    expect(await codeOf(sandbox.client.organizations.domains.verify(ACME, id, '123456'))).toBe(
      'verification.expired'
    )
  })

  test('changes the mode and removes a domain', async () => {
    const sandbox = await make()
    const started = await claim(sandbox, { domain: 'acme.example', email: 'me@acme.example' })
    const { id } = OrganizationDomainSchema.parse(started.json)
    const changed = await sandbox.client.organizations.domains.update(ACME, id, 'auto_join')
    expect(changed.mode).toBe('auto_join')
    await sandbox.client.organizations.domains.remove(ACME, id)
    expect((await sandbox.client.organizations.domains.list(ACME)).data).toEqual([])
  })

  test('a reset forgets what was created and starts again with the demo organizations', async () => {
    const sandbox = await make()
    await sandbox.client.organizations.create({ name: 'Wayne', slug: 'wayne' })
    sandbox.world.reset()
    expect([...sandbox.world.organizations.values()].map((one) => one.name).sort()).toEqual([
      'Acme',
      'Globex',
      'Hooli',
      'Initech',
    ])
  })
})
