import { afterEach, describe, expect, mock, test } from 'bun:test'
import { act, screen, waitFor, within } from '@testing-library/react'
import { deferred } from '../../../core/src/testing/fakes'
import { expectAbsent, expectFocus, failure, json, world } from '../testing/harness'
import {
  A,
  ACME,
  ADMIN_PERMISSIONS,
  B,
  GLOBEX,
  MEMBER_PERMISSIONS,
  ORG_ROUTE,
  ORGS_ON,
  organization,
  orgWorld,
  page,
} from '../testing/organizations'
import { OrganizationProfile } from './organization-profile'

afterEach(() => {
  mock.restore()
})

const META = { hasMore: false, nextCursor: null }
const MEMBERS = [
  {
    userId: 'user_1',
    name: 'Maya',
    email: 'maya@northline.app',
    role: 'admin',
    createdAt: '2030-01-01T00:00:00.000Z',
  },
  {
    userId: 'user_2',
    name: 'Lee',
    email: 'lee@globex.test',
    role: 'member',
    createdAt: '2030-01-02T00:00:00.000Z',
  },
  {
    userId: 'user_3',
    name: null,
    email: 'ada@example.com',
    role: 'member',
    createdAt: '2030-01-03T00:00:00.000Z',
  },
]
const ROLES = {
  data: [
    { key: 'admin', name: 'Admin' },
    { key: 'member', name: 'Member' },
  ],
}
const INVITATION = {
  id: 'inv_1',
  organizationId: A,
  email: 'grace@example.com',
  role: 'member',
  status: 'pending',
  invitedBy: 'user_1',
  expiresAt: '2030-02-01T00:00:00.000Z',
  createdAt: '2030-01-01T00:00:00.000Z',
}
const DOMAIN = (id: string, domain: string, verified: boolean, mode = 'suggest') => ({
  id,
  domain,
  mode,
  status: verified ? 'verified' : 'pending',
  verifiedAt: verified ? '2030-01-02T00:00:00.000Z' : null,
  expiresAt: verified ? '2031-01-02T00:00:00.000Z' : null,
  codeExpiresAt: verified ? null : '2030-01-03T00:00:00.000Z',
  createdAt: '2030-01-01T00:00:00.000Z',
  updatedAt: '2030-01-01T00:00:00.000Z',
})

/** An admin of Acme, with every list the tabs read answered. */
function adminWorld(options: Parameters<typeof orgWorld>[0] = {}) {
  const w = orgWorld(options)
  const state = {
    members: [...MEMBERS],
    invitations: [INVITATION],
    domains: [DOMAIN('dom_1', 'acme.com', true), DOMAIN('dom_2', 'acme.io', false)],
  }
  w.api.on(ORG_ROUTE.roles(A), () => json(200, ROLES))
  w.api.on(ORG_ROUTE.members(A), () => json(200, { data: state.members, meta: META }))
  w.api.on(ORG_ROUTE.invitations(A), () => json(200, { data: state.invitations, meta: META }))
  w.api.on(ORG_ROUTE.domains(A), () => json(200, { data: state.domains }))
  return Object.assign(w, { state })
}

async function tab(w: ReturnType<typeof adminWorld>, name: string) {
  const element = await screen.findByRole('tab', { name })
  await w.user.click(element)
  return element
}

describe('<OrganizationProfile>: what it can say', () => {
  test('renders nothing while signed out, or where organizations are off', async () => {
    const off = world({ signedIn: true, organizations: { ...ORGS_ON, enabled: false } })
    off.mount(<OrganizationProfile />)
    await waitFor(() => expect(off.api.calls('GET /v1/client/config').length).toBeGreaterThan(0))
    expectAbsent(screen.queryByRole('heading'))
  })

  test('with no active organization it says the user is on their personal account', async () => {
    const w = orgWorld({ active: null })
    w.mount(<OrganizationProfile />)
    expect(
      await screen.findByText('No organization is active. You are using your personal account.')
    ).toBeTruthy()
    expectAbsent(screen.queryByRole('tablist'))
  })

  test('while the list is on its way it says so', async () => {
    const w = adminWorld()
    const held = deferred<Response>()
    w.api.on(ORG_ROUTE.list, () => held.promise)
    w.mount(<OrganizationProfile />)
    expect(await screen.findByText('Loading your organizations…')).toBeTruthy()
    await act(async () => held.resolve(page([ACME, GLOBEX], A)))
    expect(await screen.findByRole('tablist')).toBeTruthy()
  })

  test('a list that could not be fetched is said, and "Try again" fetches it', async () => {
    const w = adminWorld()
    let down = true
    w.api.on(ORG_ROUTE.list, () => {
      const refuse = down
      return refuse ? failure(503, 'service.unavailable') : page([ACME, GLOBEX], A)
    })
    w.mount(<OrganizationProfile />)
    const retry = await screen.findByRole('button', { name: 'Try again' })
    down = false
    await w.user.click(retry)
    expect(await screen.findByRole('tablist')).toBeTruthy()
  })

  test('a user who is not a member of the organization is told so', async () => {
    const w = adminWorld()
    w.mount(<OrganizationProfile organizationId={'01980000-0000-7000-8000-0000000000ff'} />)
    expect(await screen.findByText('You are no longer a member of this organization.')).toBeTruthy()
    expectAbsent(screen.queryByRole('tablist'))
  })

  test('a user removed meanwhile lands on the same message, with the focus on its title', async () => {
    const w = adminWorld()
    w.mount(<OrganizationProfile />)
    await screen.findByRole('tablist')
    w.organizations = [GLOBEX]
    // The next thing the profile asks the server answers "not a member".
    w.api.on(ORG_ROUTE.members(A), () => failure(403, 'organization.not_a_member'))
    await tab(w, 'Members')
    expect(await screen.findByText('You are no longer a member of this organization.')).toBeTruthy()
    await expectFocus(screen.getByRole('heading', { name: 'Organization' }))
    expectAbsent(screen.queryByRole('tablist'))
  })

  test('it can manage another organization than the active one', async () => {
    const w = adminWorld()
    w.mount(<OrganizationProfile organizationId={B} />)
    expect((await screen.findAllByText('Globex')).length).toBeGreaterThan(0)
    // Globex holds a plain member: General and Members only.
    expect((await screen.findAllByRole('tab')).map((entry) => entry.textContent)).toEqual([
      'General',
      'Members',
    ])
  })

  test('a section this version does not know is not supported, and offers the general settings', async () => {
    const w = adminWorld()
    w.mount(<OrganizationProfile section={'billing' as never} />)
    expect(await screen.findByText('This section is not supported')).toBeTruthy()
    expectAbsent(screen.queryByRole('tablist'))
    await w.user.click(screen.getByRole('button', { name: 'Show general settings' }))
    expect(await screen.findByRole('tablist')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('true')
  })

  test('section opens a tab first', async () => {
    const w = adminWorld()
    w.mount(<OrganizationProfile section='members' />)
    expect(await screen.findByText('Lee')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Members' }).getAttribute('aria-selected')).toBe('true')
  })
})

describe('<OrganizationProfile>: tabs', () => {
  test('an admin sees all four; the panel is labelled by its tab', async () => {
    const w = adminWorld()
    w.mount(<OrganizationProfile />)
    const tabs = await screen.findAllByRole('tab')
    expect(tabs.map((entry) => entry.textContent)).toEqual([
      'General',
      'Members',
      'Invitations',
      'Domains',
    ])
    expect(screen.getByRole('tablist').getAttribute('aria-label')).toBe('Organization settings')
    expect(tabs.map((entry) => entry.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'false',
      'false',
    ])
    expect(tabs.map((entry) => entry.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1'])
    const panel = screen.getByRole('tabpanel')
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs[0]?.id ?? '')
    expect(tabs[0]?.getAttribute('aria-controls')).toBe(panel.id)
    expectAbsent(screen.queryByRole('heading', { name: 'Members' }))
  })

  test('a member sees General and Members; a role with no permission only General', async () => {
    const reader = adminWorld({
      organizations: [{ ...ACME, role: 'member', permissions: MEMBER_PERMISSIONS }],
    })
    reader.mount(<OrganizationProfile />)
    expect((await screen.findAllByRole('tab')).map((entry) => entry.textContent)).toEqual([
      'General',
      'Members',
    ])
  })

  test('a role with no permission at all sees General only', async () => {
    const w = adminWorld({ organizations: [{ ...ACME, role: 'guest', permissions: [] }] })
    w.mount(<OrganizationProfile />)
    expect((await screen.findAllByRole('tab')).map((entry) => entry.textContent)).toEqual([
      'General',
    ])
  })

  test('arrows, Home and End move between tabs and select them; the focus follows', async () => {
    const w = adminWorld()
    w.mount(<OrganizationProfile />)
    const [general, members, invitations, domains] = (await screen.findAllByRole('tab')) as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ]
    general.focus()
    await w.user.keyboard('{ArrowRight}')
    await expectFocus(members)
    expect(members.getAttribute('aria-selected')).toBe('true')
    await w.user.keyboard('{ArrowRight}')
    await expectFocus(invitations)
    await w.user.keyboard('{End}')
    await expectFocus(domains)
    await w.user.keyboard('{ArrowRight}')
    await expectFocus(general)
    await w.user.keyboard('{ArrowLeft}')
    await expectFocus(domains)
    await w.user.keyboard('{Home}')
    await expectFocus(general)
    await w.user.keyboard('a')
    expect(general.getAttribute('aria-selected')).toBe('true')
  })

  test('a tab the role no longer has gives way to General, and the user is told', async () => {
    const w = adminWorld()
    w.mount(<OrganizationProfile section='invitations' />, { invitationUrl: '/join' })
    await w.user.type(await screen.findByLabelText('Email address'), 'a@b.co')
    // The role lost the permission; the next call the section makes is refused.
    w.organizations = [{ ...ACME, role: 'member', permissions: MEMBER_PERMISSIONS }, GLOBEX]
    w.api.on(ORG_ROUTE.invite(A), () => failure(403, 'organization.permission_required'))
    await w.user.click(screen.getByRole('button', { name: 'Send invitation' }))
    await waitFor(() => expectAbsent(screen.queryByRole('tab', { name: 'Invitations' })))
    expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('true')
    expect(
      await screen.findByText(
        'Your permissions in this organization changed. What you can do was updated.'
      )
    ).toBeTruthy()
  })
})

describe('<OrganizationProfile>: General', () => {
  test('an admin renames the organization; the list is read again and the change is said', async () => {
    const w = adminWorld()
    w.api.on(ORG_ROUTE.update(A), () => json(200, { ...ACME, name: 'Acme Inc' }))
    w.mount(<OrganizationProfile />)
    const name = (await screen.findByLabelText('Name')) as HTMLInputElement
    expect(name.value).toBe('Acme')
    await w.user.clear(name)
    await w.user.type(name, 'Acme Inc')
    const before = w.api.calls(ORG_ROUTE.list).length
    await w.user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText('Your changes were saved.')).toBeTruthy()
    expect(w.api.calls(ORG_ROUTE.update(A))[0]?.body).toEqual({ name: 'Acme Inc', slug: 'acme' })
    expect(w.api.calls(ORG_ROUTE.list).length).toBeGreaterThan(before)
  })

  test('an edited short name is sent, and clearing it says it is required', async () => {
    const w = adminWorld()
    w.api.on(ORG_ROUTE.update(A), () => json(200, { ...ACME, slug: 'acme-two' }))
    w.mount(<OrganizationProfile />)
    const slug = (await screen.findByLabelText('Short name')) as HTMLInputElement
    await w.user.clear(slug)
    await w.user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(w.api.calls(ORG_ROUTE.update(A)).length).toBe(0)
    await w.user.type(slug, 'acme-two')
    await w.user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText('Your changes were saved.')).toBeTruthy()
    expect(w.api.calls(ORG_ROUTE.update(A))[0]?.body).toEqual({ name: 'Acme', slug: 'acme-two' })
  })

  test('a taken short name is announced under that field', async () => {
    const w = adminWorld()
    w.api.on(ORG_ROUTE.update(A), () => failure(409, 'organization.slug_taken'))
    w.mount(<OrganizationProfile />)
    await screen.findByLabelText('Name')
    await w.user.click(screen.getByRole('button', { name: 'Save changes' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('An organization with that slug already exists.')
    await expectFocus(screen.getByLabelText('Short name'))
  })

  test('an empty name is said under the field and nothing is sent', async () => {
    const w = adminWorld()
    w.mount(<OrganizationProfile />)
    const name = await screen.findByLabelText('Name')
    await w.user.clear(name)
    await w.user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Enter a name for the organization.'
    )
    expect(w.api.calls(ORG_ROUTE.update(A))).toHaveLength(0)
  })

  test('a member who cannot manage sees the details and no form, no delete', async () => {
    const w = adminWorld({
      organizations: [{ ...ACME, role: 'member', permissions: MEMBER_PERMISSIONS }],
    })
    w.mount(<OrganizationProfile />)
    expect(
      await screen.findByText(
        'Only members who can manage the organization can change these details.'
      )
    ).toBeTruthy()
    expectAbsent(screen.queryByLabelText('Name'))
    expect(screen.getByText('member')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Leave organization' })).toBeTruthy()
    expectAbsent(screen.queryByRole('button', { name: 'Delete organization' }))
  })

  test('leaving asks first; Cancel returns the focus to the button', async () => {
    const w = adminWorld()
    w.mount(<OrganizationProfile />)
    const leave = await screen.findByRole('button', { name: 'Leave organization' })
    await w.user.click(leave)
    const question = await screen.findByRole('group', { name: 'Leave Acme?' })
    await expectFocus(within(question).getByRole('button', { name: 'Cancel' }))
    await w.user.click(within(question).getByRole('button', { name: 'Cancel' }))
    expectAbsent(screen.queryByRole('group', { name: 'Leave Acme?' }))
    await expectFocus(leave)
    expect(w.api.requests.some((request) => request.method === 'DELETE')).toBe(false)
  })

  test('leaving the active organization moves the session to the personal account and says so', async () => {
    const w = adminWorld()
    const onGone = mock()
    const navigate = mock()
    w.api.on(`DELETE ${ORG_ROUTE.member(A, 'user_1')}`, () => {
      w.organizations = [GLOBEX]
      return new Response(null, { status: 204 })
    })
    w.mount(<OrganizationProfile onGone={onGone} afterLeaveUrl='/left' />, { navigate })
    await w.user.click(await screen.findByRole('button', { name: 'Leave organization' }))
    await w.user.click(await screen.findByRole('button', { name: 'Yes, leave' }))
    const title = await screen.findByRole('heading', { name: 'Organization' })
    expect(await screen.findByText('You left Acme.')).toBeTruthy()
    await expectFocus(title)
    expect(onGone).toHaveBeenCalledWith('left', A)
    expect(navigate).toHaveBeenCalledWith('/left')
    expect(w.api.calls(ORG_ROUTE.active)[0]?.body).toEqual({ organizationId: null })
    expect(w.client.state.status === 'signed-in' && w.client.state.organizationId).toBeNull()
  })

  test('without a personal account the session moves to another organization', async () => {
    const w = adminWorld({ config: { ...ORGS_ON, personalAccount: false } })
    w.api.on(`DELETE ${ORG_ROUTE.member(A, 'user_1')}`, () => {
      w.organizations = [GLOBEX]
      return new Response(null, { status: 204 })
    })
    w.mount(<OrganizationProfile />)
    await w.user.click(await screen.findByRole('button', { name: 'Leave organization' }))
    await w.user.click(await screen.findByRole('button', { name: 'Yes, leave' }))
    expect(await screen.findByText('You left Acme.')).toBeTruthy()
    expect(w.api.calls(ORG_ROUTE.active)[0]?.body).toEqual({ organizationId: B })
  })

  test('the last manager cannot leave: the reason is shown and the page stays', async () => {
    const w = adminWorld()
    w.api.on(`DELETE ${ORG_ROUTE.member(A, 'user_1')}`, () =>
      failure(409, 'organization.last_manager')
    )
    w.mount(<OrganizationProfile />)
    await w.user.click(await screen.findByRole('button', { name: 'Leave organization' }))
    await w.user.click(await screen.findByRole('button', { name: 'Yes, leave' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(
      'An organization must keep at least one member who can manage its members.'
    )
    expect(screen.getByRole('tablist')).toBeTruthy()
    expect(w.api.calls(ORG_ROUTE.active)).toHaveLength(0)
  })

  test('deleting asks for the name to be typed, and only then can it be confirmed', async () => {
    const w = adminWorld()
    const onGone = mock()
    w.api.on(
      ORG_ROUTE.remove(A).replace('DELETE ', 'DELETE '),
      () => new Response(null, { status: 204 })
    )
    w.mount(<OrganizationProfile onGone={onGone} />)
    await w.user.click(await screen.findByRole('button', { name: 'Delete organization' }))
    const question = await screen.findByRole('group', { name: 'Type Acme to confirm' })
    const field = within(question).getByLabelText('Name')
    await expectFocus(field)
    const confirm = within(question).getByRole('button', { name: 'Delete this organization' })
    expect(confirm.getAttribute('aria-disabled')).toBe('true')
    await w.user.click(confirm)
    expect(w.api.calls(`DELETE /v1/client/me/organizations/${A}`)).toHaveLength(0)
    await w.user.type(field, 'acme')
    expect(confirm.getAttribute('aria-disabled')).toBe('true')
    await w.user.clear(field)
    await w.user.type(field, 'Acme')
    expect(confirm.getAttribute('aria-disabled')).toBeNull()
    w.organizations = [GLOBEX]
    await w.user.click(confirm)
    expect(await screen.findByText('Acme was deleted.')).toBeTruthy()
    expect(onGone).toHaveBeenCalledWith('deleted', A)
    expect(w.api.calls(`DELETE /v1/client/me/organizations/${A}`)).toHaveLength(1)
  })

  test('a delete the server refuses because the role changed reads the permissions again and removes the control', async () => {
    const w = adminWorld()
    w.api.on(`DELETE /v1/client/me/organizations/${A}`, () =>
      failure(403, 'organization.permission_required')
    )
    w.mount(<OrganizationProfile />)
    await w.user.click(await screen.findByRole('button', { name: 'Delete organization' }))
    const question = await screen.findByRole('group', { name: 'Type Acme to confirm' })
    await w.user.type(within(question).getByLabelText('Name'), 'Acme')
    w.organizations = [{ ...ACME, role: 'member', permissions: MEMBER_PERMISSIONS }, GLOBEX]
    await w.user.click(within(question).getByRole('button', { name: 'Delete this organization' }))
    await waitFor(() => expectAbsent(screen.queryByRole('button', { name: 'Delete organization' })))
    expect(
      await screen.findByText(
        'Your permissions in this organization changed. What you can do was updated.'
      )
    ).toBeTruthy()
    expectAbsent(screen.queryByLabelText('Name'))
  })

  test('a leave that finishes after the session ended is not acted on', async () => {
    const w = adminWorld()
    const onGone = mock()
    const held = deferred<Response>()
    w.api.on(`DELETE ${ORG_ROUTE.member(A, 'user_1')}`, () => held.promise)
    w.mount(<OrganizationProfile onGone={onGone} />)
    await w.user.click(await screen.findByRole('button', { name: 'Leave organization' }))
    await w.user.click(await screen.findByRole('button', { name: 'Yes, leave' }))
    await waitFor(() =>
      expect(w.api.calls(`DELETE ${ORG_ROUTE.member(A, 'user_1')}`)).toHaveLength(1)
    )
    await act(async () => {
      await w.client.session.signOut()
    })
    await act(async () => held.resolve(new Response(null, { status: 204 })))
    expect(onGone).not.toHaveBeenCalled()
    expect(w.api.calls(ORG_ROUTE.active)).toHaveLength(0)
  })
})

describe('<OrganizationProfile>: Members', () => {
  test('lists the members with their roles; an admin can change a role and remove another member', async () => {
    const w = adminWorld()
    w.mount(<OrganizationProfile />)
    await tab(w, 'Members')
    expect(await screen.findByText('Lee')).toBeTruthy()
    expect(screen.getByText('lee@globex.test')).toBeTruthy()
    // A member with no name is named by the address, and has no second line saying the same.
    expect(screen.getAllByText('ada@example.com')).toHaveLength(1)
    const mine = screen.getByRole('combobox', { name: 'Role of Maya' }) as HTMLSelectElement
    expect(mine.value).toBe('admin')
    expect(
      within(mine)
        .getAllByRole('option')
        .map((option) => option.textContent)
    ).toEqual(['Admin', 'Member'])
    expect(screen.getByText('You')).toBeTruthy()
    expectAbsent(screen.queryByRole('button', { name: 'Remove Maya' }))
    expect(screen.getByRole('button', { name: 'Remove Lee' })).toBeTruthy()
  })

  test('a role that only reads sees the roles as text and no controls', async () => {
    const w = adminWorld({
      organizations: [{ ...ACME, role: 'member', permissions: MEMBER_PERMISSIONS }],
    })
    w.mount(<OrganizationProfile section='members' />)
    expect(await screen.findByText('Lee')).toBeTruthy()
    expect(screen.getAllByText('Role: member').length).toBeGreaterThan(0)
    expectAbsent(screen.queryByRole('combobox'))
    expectAbsent(screen.queryByRole('button', { name: /^Remove/ }))
    expect(w.api.calls(ORG_ROUTE.roles(A))).toHaveLength(0)
  })

  test('changing a role sends it, reads the list again and says what happened', async () => {
    const w = adminWorld()
    w.api.on(`PATCH ${ORG_ROUTE.member(A, 'user_2')}`, () => {
      w.state.members = w.state.members.map((member) =>
        member.userId === 'user_2' ? { ...member, role: 'admin' } : member
      )
      return json(200, { ...MEMBERS[1], role: 'admin' })
    })
    w.mount(<OrganizationProfile section='members' />)
    const select = await screen.findByRole('combobox', { name: 'Role of Lee' })
    await w.user.selectOptions(select, 'admin')
    expect(await screen.findByText('The role of Lee is now Admin.')).toBeTruthy()
    expect(w.api.calls(`PATCH ${ORG_ROUTE.member(A, 'user_2')}`)[0]?.body).toEqual({
      role: 'admin',
    })
    expect((screen.getByRole('combobox', { name: 'Role of Lee' }) as HTMLSelectElement).value).toBe(
      'admin'
    )
  })

  test('a role change the server refuses is announced and the row keeps its role', async () => {
    const w = adminWorld()
    w.api.on(`PATCH ${ORG_ROUTE.member(A, 'user_1')}`, () =>
      failure(409, 'organization.last_manager')
    )
    w.mount(<OrganizationProfile section='members' />)
    await w.user.selectOptions(
      await screen.findByRole('combobox', { name: 'Role of Maya' }),
      'member'
    )
    expect((await screen.findByRole('alert')).textContent).toBe(
      'An organization must keep at least one member who can manage its members.'
    )
    expect(
      (screen.getByRole('combobox', { name: 'Role of Maya' }) as HTMLSelectElement).value
    ).toBe('admin')
  })

  test('changing the user’s own role reads their organizations again', async () => {
    const w = adminWorld()
    w.api.on(`PATCH ${ORG_ROUTE.member(A, 'user_1')}`, () =>
      json(200, { ...MEMBERS[0], role: 'member' })
    )
    w.mount(<OrganizationProfile section='members' />)
    await screen.findByText('Lee')
    const before = w.api.calls(ORG_ROUTE.list).length
    await w.user.selectOptions(screen.getByRole('combobox', { name: 'Role of Maya' }), 'member')
    await screen.findByText('The role of Maya is now Member.')
    expect(w.api.calls(ORG_ROUTE.list).length).toBeGreaterThan(before)
  })

  test('removing asks first; the row goes, the focus moves to the section title', async () => {
    const w = adminWorld()
    w.api.on(`DELETE ${ORG_ROUTE.member(A, 'user_2')}`, () => {
      w.state.members = w.state.members.filter((member) => member.userId !== 'user_2')
      return new Response(null, { status: 204 })
    })
    w.mount(<OrganizationProfile section='members' />)
    const remove = await screen.findByRole('button', { name: 'Remove Lee' })
    await w.user.click(remove)
    const question = await screen.findByRole('group', {
      name: 'Remove Lee from Acme? They keep their account.',
    })
    await w.user.click(within(question).getByRole('button', { name: 'Yes, remove' }))
    expect(await screen.findByText('Lee was removed.')).toBeTruthy()
    expectAbsent(screen.queryByRole('button', { name: 'Remove Lee' }))
    await expectFocus(screen.getByRole('heading', { name: 'Members' }))
  })

  test('Cancel on the question keeps the member and returns the focus to the button', async () => {
    const w = adminWorld()
    w.mount(<OrganizationProfile section='members' />)
    const remove = await screen.findByRole('button', { name: 'Remove Lee' })
    await w.user.click(remove)
    await w.user.click(await screen.findByRole('button', { name: 'Cancel' }))
    await expectFocus(remove)
    expect(w.api.calls(`DELETE ${ORG_ROUTE.member(A, 'user_2')}`)).toHaveLength(0)
  })

  test('a member list that could not be fetched is said, and "Try again" fetches it', async () => {
    const w = adminWorld()
    let attempts = 0
    w.api.on(ORG_ROUTE.members(A), () => {
      attempts += 1
      return attempts === 1
        ? failure(503, 'service.unavailable')
        : json(200, { data: MEMBERS, meta: META })
    })
    w.mount(<OrganizationProfile section='members' />)
    expect(await screen.findByRole('alert')).toBeTruthy()
    await w.user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Lee')).toBeTruthy()
    expectAbsent(screen.queryByRole('alert'))
  })

  test('no members is said; loading is said', async () => {
    const w = adminWorld()
    const held = deferred<Response>()
    w.api.on(ORG_ROUTE.members(A), () => held.promise)
    w.mount(<OrganizationProfile section='members' />)
    expect(await screen.findByText('Loading members…')).toBeTruthy()
    await act(async () => held.resolve(json(200, { data: [], meta: META })))
    expect(await screen.findByText('There are no members to show.')).toBeTruthy()
  })

  test('a member whose role the user may not give still shows that role', async () => {
    const w = adminWorld()
    w.api.on(ORG_ROUTE.roles(A), () => json(200, { data: [{ key: 'member', name: 'Member' }] }))
    w.mount(<OrganizationProfile section='members' />)
    const select = await screen.findByRole('combobox', { name: 'Role of Maya' })
    expect((select as HTMLSelectElement).value).toBe('admin')
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent)
    ).toEqual(['admin', 'Member'])
  })
})

describe('<OrganizationProfile>: Invitations', () => {
  test('lists the pending invitations with the role and the expiry', async () => {
    const w = adminWorld()
    w.mount(<OrganizationProfile section='invitations' />, { invitationUrl: '/join' })
    expect(await screen.findByText('grace@example.com')).toBeTruthy()
    expect(screen.getByText(/Role: Member · Expires /)).toBeTruthy()
  })

  test('says when no invitation is waiting', async () => {
    const w = adminWorld()
    w.state.invitations = []
    w.mount(<OrganizationProfile section='invitations' />, { invitationUrl: '/join' })
    expect(await screen.findByText('No invitations are waiting.')).toBeTruthy()
  })

  test('inviting sends the address, the chosen role and the app’s invitation page', async () => {
    const w = adminWorld()
    w.api.on(ORG_ROUTE.invite(A), () => {
      w.state.invitations.push({ ...INVITATION, id: 'inv_2', email: 'ada@example.org' })
      return json(201, { ...INVITATION, id: 'inv_2', email: 'ada@example.org' })
    })
    w.mount(<OrganizationProfile section='invitations' />, { invitationUrl: '/join' })
    const email = await screen.findByLabelText('Email address')
    await w.user.type(email, ' ada@example.org ')
    expect((screen.getByLabelText('Role') as HTMLSelectElement).value).toBe('member')
    await w.user.selectOptions(screen.getByLabelText('Role'), 'admin')
    await w.user.click(screen.getByRole('button', { name: 'Send invitation' }))
    expect(await screen.findByText('Invitation sent to ada@example.org.')).toBeTruthy()
    const body = w.api.calls(ORG_ROUTE.invite(A))[0]?.body as {
      email: string
      role: string
      redirectUrl: string
    }
    expect(body.email).toBe('ada@example.org')
    expect(body.role).toBe('admin')
    expect(new URL(body.redirectUrl).pathname).toBe('/join')
    expect((email as HTMLInputElement).value).toBe('')
    expect(await screen.findByText('ada@example.org')).toBeTruthy()
  })

  test('the component’s own invitationUrl wins over the provider’s', async () => {
    const w = adminWorld()
    w.api.on(ORG_ROUTE.invite(A), () => json(201, INVITATION))
    w.mount(<OrganizationProfile section='invitations' invitationUrl='/own' />, {
      invitationUrl: '/join',
    })
    await w.user.type(await screen.findByLabelText('Email address'), 'a@b.co')
    await w.user.click(screen.getByRole('button', { name: 'Send invitation' }))
    await screen.findByText('Invitation sent to a@b.co.')
    const body = w.api.calls(ORG_ROUTE.invite(A))[0]?.body as { redirectUrl: string }
    expect(new URL(body.redirectUrl).pathname).toBe('/own')
  })

  test('without a page for the link the form says invitations cannot be sent and sends nothing', async () => {
    const w = adminWorld()
    w.mount(<OrganizationProfile section='invitations' />)
    expect(await screen.findByText('Invitations cannot be sent from here yet.')).toBeTruthy()
    expectAbsent(screen.queryByLabelText('Email address'))
    expect(w.api.calls(ORG_ROUTE.invite(A))).toHaveLength(0)
  })

  test('an invitation page that is not a safe destination is no page', async () => {
    const w = adminWorld()
    w.mount(<OrganizationProfile section='invitations' invitationUrl='javascript:alert(1)' />)
    expect(await screen.findByText('Invitations cannot be sent from here yet.')).toBeTruthy()
  })

  test('an empty address is said under the field and nothing is sent', async () => {
    const w = adminWorld()
    w.mount(<OrganizationProfile section='invitations' />, { invitationUrl: '/join' })
    await w.user.click(await screen.findByRole('button', { name: 'Send invitation' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Enter an email address.')
    await expectFocus(screen.getByLabelText('Email address'))
    expect(w.api.calls(ORG_ROUTE.invite(A))).toHaveLength(0)
  })

  test.each([
    ['organization.member_exists', 'That user is already a member of this organization.', 'field'],
    ['organization.invitation_exists', 'That address already has a pending invitation.', 'field'],
    [
      'organization.role_not_assignable',
      'You can only invite to a role no stronger than yours.',
      'form',
    ],
  ])('%s is announced', async (code, message, where) => {
    const w = adminWorld()
    w.api.on(ORG_ROUTE.invite(A), () => failure(409, code))
    w.mount(<OrganizationProfile section='invitations' />, { invitationUrl: '/join' })
    await w.user.type(await screen.findByLabelText('Email address'), 'a@b.co')
    await w.user.click(screen.getByRole('button', { name: 'Send invitation' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(message)
    if (where === 'field') {
      await expectFocus(screen.getByLabelText('Email address'))
    }
  })

  test('revoking asks first, then withdraws the invitation and reads the list again', async () => {
    const w = adminWorld()
    w.api.on(ORG_ROUTE.revoke(A, 'inv_1'), () => {
      w.state.invitations = []
      return new Response(null, { status: 204 })
    })
    w.mount(<OrganizationProfile section='invitations' />, { invitationUrl: '/join' })
    await w.user.click(
      await screen.findByRole('button', { name: 'Revoke the invitation for grace@example.com' })
    )
    const question = await screen.findByRole('group', {
      name: 'Revoke the invitation for grace@example.com? Its link stops working.',
    })
    await w.user.click(within(question).getByRole('button', { name: 'Yes, revoke' }))
    expect(
      await screen.findByText('The invitation for grace@example.com was revoked.')
    ).toBeTruthy()
    expect(await screen.findByText('No invitations are waiting.')).toBeTruthy()
    await expectFocus(screen.getByRole('heading', { name: 'Invitations' }))
  })

  test('an invitation that was already used is said when it is revoked', async () => {
    const w = adminWorld()
    w.api.on(ORG_ROUTE.revoke(A, 'inv_1'), () => failure(410, 'organization.invitation_used'))
    w.mount(<OrganizationProfile section='invitations' />, { invitationUrl: '/join' })
    await w.user.click(
      await screen.findByRole('button', { name: 'Revoke the invitation for grace@example.com' })
    )
    await w.user.click(await screen.findByRole('button', { name: 'Yes, revoke' }))
    expect((await screen.findByRole('alert')).textContent).toBe('This invitation was already used.')
  })

  test('invitations that could not be fetched are said; "Try again" fetches them', async () => {
    const w = adminWorld()
    let attempts = 0
    w.api.on(ORG_ROUTE.invitations(A), () => {
      attempts += 1
      return attempts === 1
        ? failure(503, 'service.unavailable')
        : json(200, { data: [INVITATION], meta: META })
    })
    w.mount(<OrganizationProfile section='invitations' />, { invitationUrl: '/join' })
    expect(await screen.findByRole('alert')).toBeTruthy()
    await w.user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('grace@example.com')).toBeTruthy()
  })

  test('a rate limit says when to try again', async () => {
    const w = adminWorld()
    w.api.on(ORG_ROUTE.invite(A), () => failure(429, 'rate_limited', {}, { 'retry-after': '30' }))
    w.mount(<OrganizationProfile section='invitations' />, { invitationUrl: '/join' })
    await w.user.type(await screen.findByLabelText('Email address'), 'a@b.co')
    await w.user.click(screen.getByRole('button', { name: 'Send invitation' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/^Too many requests\. Try again in /)
    )
  })
})

describe('<OrganizationProfile>: Domains', () => {
  test('lists verified domains with what they do, and claims waiting for a code', async () => {
    const w = adminWorld()
    w.mount(<OrganizationProfile section='domains' />)
    expect(await screen.findByText('acme.com')).toBeTruthy()
    expect(screen.getByText('Verified')).toBeTruthy()
    expect(screen.getByText('Waiting for the code')).toBeTruthy()
    const mode = screen.getAllByLabelText('When someone signs up with a verified address on it')
    // One for the verified domain, one for the claim form.
    expect(mode).toHaveLength(2)
    expect(screen.getByLabelText('Code for acme.io')).toBeTruthy()
    expectAbsent(screen.queryByLabelText('Code for acme.com'))
  })

  test('a lapsed verification is offered a new code, not the mode', async () => {
    const w = adminWorld()
    const lapsed = {
      ...DOMAIN('dom_3', 'old.example', true),
      status: 'needs_reverification',
      expiresAt: '2030-01-03T00:00:00.000Z',
    }
    w.api.on(ORG_ROUTE.domains(A), () => json(200, { data: [lapsed] }))
    w.mount(<OrganizationProfile section='domains' />)
    expect(await screen.findByText('old.example')).toBeTruthy()
    expect(screen.getByText('Needs verifying again')).toBeTruthy()
    expect(screen.getByLabelText('Code for old.example')).toBeTruthy()
    expect(
      screen.getAllByLabelText('When someone signs up with a verified address on it')
    ).toHaveLength(1)
  })

  test('says when there are no domains, and while loading', async () => {
    const w = adminWorld()
    const held = deferred<Response>()
    w.api.on(ORG_ROUTE.domains(A), () => held.promise)
    w.mount(<OrganizationProfile section='domains' />)
    expect(await screen.findByText('Loading domains…')).toBeTruthy()
    await act(async () => held.resolve(json(200, { data: [] })))
    expect(await screen.findByText('No domains yet.')).toBeTruthy()
  })

  test('claiming sends the domain, an address and the mode; the code field of the new claim takes the focus', async () => {
    const w = adminWorld()
    w.state.domains = []
    w.api.on(ORG_ROUTE.claim(A), () => {
      const claim = DOMAIN('dom_9', 'globex.test', false)
      w.state.domains.push(claim)
      return json(201, claim)
    })
    w.mount(<OrganizationProfile section='domains' />)
    await w.user.type(await screen.findByLabelText('Domain'), 'globex.test')
    await w.user.type(screen.getByLabelText('An address on that domain'), 'lee@globex.test')
    await w.user.selectOptions(
      screen.getByLabelText('When someone signs up with a verified address on it'),
      'auto_join'
    )
    await w.user.click(screen.getByRole('button', { name: 'Send a code' }))
    expect(await screen.findByText('We emailed a code to lee@globex.test.')).toBeTruthy()
    expect(w.api.calls(ORG_ROUTE.claim(A))[0]?.body).toEqual({
      domain: 'globex.test',
      email: 'lee@globex.test',
      mode: 'auto_join',
    })
    await expectFocus(await screen.findByLabelText('Code for globex.test'))
  })

  test.each([
    [
      'organization.domain_public',
      'A public email domain cannot be claimed by an organization.',
      'Domain',
    ],
    ['organization.domain_taken', 'That domain is verified for an organization already.', 'Domain'],
    ['organization.domain_limit', 'This organization has the most domains it can have.', 'Domain'],
    [
      'organization.domain_address_mismatch',
      'That address is not on the domain.',
      'An address on that domain',
    ],
  ])('%s is announced under its field', async (code, message, field) => {
    const w = adminWorld()
    w.api.on(ORG_ROUTE.claim(A), () => failure(409, code))
    w.mount(<OrganizationProfile section='domains' />)
    await w.user.type(await screen.findByLabelText('Domain'), 'gmail.com')
    await w.user.type(screen.getByLabelText('An address on that domain'), 'a@gmail.com')
    await w.user.click(screen.getByRole('button', { name: 'Send a code' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(message)
    await expectFocus(screen.getByLabelText(field))
  })

  test('an empty claim is said under both fields and nothing is sent', async () => {
    const w = adminWorld()
    w.mount(<OrganizationProfile section='domains' />)
    await w.user.click(await screen.findByRole('button', { name: 'Send a code' }))
    expect((await screen.findAllByRole('alert')).map((alert) => alert.textContent)).toEqual([
      'Enter a domain, for example acme.com.',
      'Enter an address on that domain.',
    ])
    expect(w.api.calls(ORG_ROUTE.claim(A))).toHaveLength(0)
  })

  test('the emailed code verifies the domain', async () => {
    const w = adminWorld()
    w.api.on(ORG_ROUTE.verify(A, 'dom_2'), () => {
      w.state.domains = w.state.domains.map((domain) =>
        domain.id === 'dom_2' ? DOMAIN('dom_2', 'acme.io', true) : domain
      )
      return json(200, DOMAIN('dom_2', 'acme.io', true))
    })
    w.mount(<OrganizationProfile section='domains' />)
    const code = await screen.findByLabelText('Code for acme.io')
    await w.user.type(code, '12 34-56')
    expect((code as HTMLInputElement).value).toBe('123456')
    await w.user.click(screen.getByRole('button', { name: 'Verify' }))
    expect(await screen.findByText('acme.io is verified.')).toBeTruthy()
    expect(w.api.calls(ORG_ROUTE.verify(A, 'dom_2'))[0]?.body).toEqual({ code: '123456' })
    expectAbsent(screen.queryByLabelText('Code for acme.io'))
  })

  test('a code of the wrong length is said and nothing is sent', async () => {
    const w = adminWorld()
    w.mount(<OrganizationProfile section='domains' />)
    await w.user.type(await screen.findByLabelText('Code for acme.io'), '123')
    await w.user.click(screen.getByRole('button', { name: 'Verify' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Enter the 6-digit code.')
    expect(w.api.calls(ORG_ROUTE.verify(A, 'dom_2'))).toHaveLength(0)
  })

  test('a wrong code is announced under the field with the guesses left', async () => {
    const w = adminWorld()
    w.api.on(ORG_ROUTE.verify(A, 'dom_2'), () =>
      failure(400, 'verification.invalid_code', { params: { attemptsRemaining: 3 } })
    )
    w.mount(<OrganizationProfile section='domains' />)
    await w.user.type(await screen.findByLabelText('Code for acme.io'), '123456')
    await w.user.click(screen.getByRole('button', { name: 'Verify' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBeTruthy()
    const field = screen.getByLabelText('Code for acme.io')
    await expectFocus(field)
    expect(field.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText(/3 (tries|attempts|guesses) left/)).toBeTruthy()
  })

  test('changing what a verified domain does sends the mode', async () => {
    const w = adminWorld()
    w.api.on(`PATCH ${ORG_ROUTE.domain(A, 'dom_1')}`, () =>
      json(200, DOMAIN('dom_1', 'acme.com', true, 'auto_join'))
    )
    w.mount(<OrganizationProfile section='domains' />)
    await screen.findByText('acme.com')
    const [verified] = screen.getAllByLabelText(
      'When someone signs up with a verified address on it'
    )
    await w.user.selectOptions(verified as HTMLElement, 'auto_join')
    expect(await screen.findByText('acme.com was updated.')).toBeTruthy()
    expect(w.api.calls(`PATCH ${ORG_ROUTE.domain(A, 'dom_1')}`)[0]?.body).toEqual({
      mode: 'auto_join',
    })
  })

  test('a mode this version does not know is labelled as not supported and kept', async () => {
    const w = adminWorld()
    w.state.domains = [DOMAIN('dom_1', 'acme.com', true, 'invite_only')]
    w.mount(<OrganizationProfile section='domains' />)
    await screen.findByText('acme.com')
    const [select] = screen.getAllByLabelText('When someone signs up with a verified address on it')
    expect((select as HTMLSelectElement).value).toBe('invite_only')
    expect(
      within(select as HTMLElement).getByRole('option', { name: 'Not supported by this version' })
    ).toBeTruthy()
  })

  test('removing asks first, then removes the domain', async () => {
    const w = adminWorld()
    w.api.on(`DELETE ${ORG_ROUTE.domain(A, 'dom_1')}`, () => {
      w.state.domains = w.state.domains.filter((domain) => domain.id !== 'dom_1')
      return new Response(null, { status: 204 })
    })
    w.mount(<OrganizationProfile section='domains' />)
    await w.user.click(await screen.findByRole('button', { name: 'Remove acme.com' }))
    const question = await screen.findByRole('group', {
      name: 'Remove acme.com? People who sign up later are no longer offered this organization. The members it brought stay.',
    })
    await w.user.click(within(question).getByRole('button', { name: 'Yes, remove' }))
    expect(await screen.findByText('acme.com was removed.')).toBeTruthy()
    expectAbsent(screen.queryByRole('button', { name: 'Remove acme.com' }))
    await expectFocus(screen.getByRole('heading', { name: 'Domains' }))
  })

  test('"Send a new code" fills the claim form with the domain and waits for the address', async () => {
    const w = adminWorld()
    w.mount(<OrganizationProfile section='domains' />)
    await screen.findByLabelText('Code for acme.io')
    await w.user.click(screen.getByRole('button', { name: 'Send a new code' }))
    expect((screen.getByLabelText('Domain') as HTMLInputElement).value).toBe('acme.io')
    await expectFocus(screen.getByLabelText('An address on that domain'))
  })

  test('a role that cannot manage domains is refused by the server and loses the tab', async () => {
    const w = adminWorld()
    w.api.on(ORG_ROUTE.domains(A), () => failure(403, 'auth.forbidden'))
    w.organizations = [{ ...ACME, role: 'member', permissions: MEMBER_PERMISSIONS }, GLOBEX]
    w.mount(<OrganizationProfile section='domains' />)
    expect(await screen.findByRole('tab', { name: 'General' })).toBeTruthy()
    expectAbsent(screen.queryByRole('tab', { name: 'Domains' }))
  })
})

describe('<OrganizationProfile>: results belong to the session', () => {
  test('a member list that arrives after the session ended is not drawn', async () => {
    const w = adminWorld()
    const held = deferred<Response>()
    w.api.on(ORG_ROUTE.members(A), () => held.promise)
    w.mount(<OrganizationProfile section='members' />)
    expect(await screen.findByText('Loading members…')).toBeTruthy()
    await act(async () => {
      await w.client.session.signOut()
    })
    await act(async () => held.resolve(json(200, { data: MEMBERS, meta: META })))
    expectAbsent(screen.queryByText('Lee'))
    expectAbsent(screen.queryByRole('heading'))
  })

  test('another organization’s permissions are never used for this one', async () => {
    const w = orgWorld({
      organizations: [
        organization(A, 'Acme', 'member', MEMBER_PERMISSIONS),
        organization(B, 'Globex', 'admin', ADMIN_PERMISSIONS),
      ],
    })
    w.api.on(ORG_ROUTE.members(A), () => json(200, { data: MEMBERS, meta: META }))
    w.api.on(ORG_ROUTE.members(B), () => json(200, { data: MEMBERS, meta: META }))
    w.api.on(ORG_ROUTE.roles(B), () => json(200, ROLES))
    w.mount(<OrganizationProfile organizationId={A} section='members' />)
    await screen.findByText('Lee')
    // The user is an admin of Globex and a member of Acme: Acme's list has no controls.
    expectAbsent(screen.queryByRole('combobox'))
    expect(w.api.calls(ORG_ROUTE.roles(B))).toHaveLength(0)
  })
})
