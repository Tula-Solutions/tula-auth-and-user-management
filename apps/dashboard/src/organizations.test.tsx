import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor, within } from '@testing-library/react'
import {
  FAKE_DOMAIN_CODE,
  type FakeApi,
  type FakeDomain,
  type FakeInvitation,
  type FakeMembership,
  type FakeOrganization,
  type FakeRole,
  failure,
  fakeDomain,
  fakeInvitation,
  fakeMembership,
  fakeOrganization,
  fakeRole,
  IDS,
  installFakeApi,
} from '~/testing/fake-api'
import {
  DEV_PATH,
  holdAnswers,
  openDialogs,
  PROD_PATH,
  renderApp,
  type World,
} from '~/testing/harness'

// The organization screens: the list and an organization's page, the roles and the settings,
// and a user's memberships. Rendered as the whole app, against the fake API.

let world: World | undefined

function start(path: string, options: Parameters<typeof renderApp>[1] = {}): World {
  world = renderApp(path, options)
  return world
}

afterEach(() => {
  world?.queryClient.clear()
  world?.api.restore()
  world = undefined
})

const SECOND_USER = '00000000-0000-7000-8000-0000000000d2'
const REDIRECT = 'https://app.example.com/invitation'

interface Arrangement {
  organizations?: Partial<FakeOrganization>[]
  memberships?: Partial<FakeMembership>[]
  roles?: Partial<FakeRole>[]
  invitations?: Partial<FakeInvitation>[]
  domains?: Partial<FakeDomain>[]
  /** Switch organizations off (they are on unless this is set). */
  off?: boolean
  redirectUrls?: string[]
}

/** A fake API with organizations switched on, a second user and what a test arranges. */
function arranged(arrangement: Arrangement = {}): FakeApi {
  const api = installFakeApi()
  const settings = api.state.settings.settings
  settings.organizations = { ...settings.organizations, enabled: !arrangement.off }
  settings.urls = { ...settings.urls, allowedRedirectUrls: arrangement.redirectUrls ?? [REDIRECT] }
  api.state.users.push({
    id: SECOND_USER,
    email: 'grace@example.com',
    emailVerifiedAt: '2026-10-04T12:00:00.000Z',
    firstName: 'Grace',
    lastName: 'Hopper',
    bannedAt: null,
    lastSignInAt: null,
    createdAt: '2026-10-04T12:00:00.000Z',
  })
  api.state.organizations.push(...(arrangement.organizations ?? []).map(fakeOrganization))
  api.state.memberships.push(...(arrangement.memberships ?? []).map(fakeMembership))
  api.state.roles.push(...(arrangement.roles ?? []).map(fakeRole))
  api.state.invitations.push(...(arrangement.invitations ?? []).map(fakeInvitation))
  api.state.domains.push(...(arrangement.domains ?? []).map(fakeDomain))
  return api
}

const ACME = '00000000-0000-7000-8000-0000000aaa01'
const GLOBEX = '00000000-0000-7000-8000-0000000aaa02'
const acme = { id: ACME, name: 'Acme Corp', slug: 'acme' }
const globex = { id: GLOBEX, name: 'Globex', slug: 'globex' }

function dialog(): HTMLElement {
  return screen.getByRole('dialog')
}

function button(name: string): HTMLElement {
  return within(dialog()).getByRole('button', { name })
}

function alerts(): string[] {
  return within(dialog())
    .queryAllByRole('alert')
    .map((alert) => alert.textContent ?? '')
}

const sent = (api: FakeApi, method: string, prefix: string) =>
  api.calls.filter((call) => call.method === method && call.path.startsWith(prefix))

describe('the navigation and the switched-off state', () => {
  test('the navigation leads to the organizations, the roles and their settings', async () => {
    const { user, location } = start(`${DEV_PATH}/users`, { api: arranged() })
    await screen.findByRole('heading', { level: 1, name: 'Users' })
    await user.click(screen.getByRole('link', { name: 'Organizations' }))
    await screen.findByRole('heading', { level: 1, name: 'Organizations' })
    expect(location()).toBe(`${DEV_PATH}/organizations`)
    await user.click(screen.getByRole('link', { name: 'Roles' }))
    await screen.findByRole('heading', { level: 1, name: 'Roles' })
    await user.click(screen.getByRole('link', { name: 'Organization settings' }))
    await screen.findByRole('heading', { level: 1, name: 'Organization settings' })
    expect(location()).toBe(`${DEV_PATH}/organization-settings`)
  })

  test.each([
    ['the list', '/organizations', 'Organizations'],
    ['an organization', `/organizations/${ACME}`, 'Organizations'],
    ['the roles', '/roles', 'Roles'],
  ])('%s says organizations are off, and where to switch them on', async (_name, path, title) => {
    const api = arranged({ off: true, organizations: [acme] })
    const { user, location } = start(`${DEV_PATH}${path}`, { api })
    await screen.findByText('Organizations are switched off in this environment')
    expect(screen.queryByText('You are not allowed to see this')).toBeNull()
    if (path === '/organizations' || path === '/roles') {
      expect(screen.getByRole('heading', { level: 1, name: title })).toBeTruthy()
    }
    await user.click(
      within(screen.getByRole('main')).getByRole('link', { name: 'Organization settings' })
    )
    await waitFor(() => expect(location()).toBe(`${DEV_PATH}/organization-settings`))
  })
})

describe('the list of organizations', () => {
  test('with none it says so; with some it lists them with links, newest first', async () => {
    start(`${DEV_PATH}/organizations`, { api: arranged() })
    await screen.findByText('No organizations yet')
    world?.api.restore()
    world = undefined

    const { api } = start(`${DEV_PATH}/organizations`, {
      api: arranged({ organizations: [acme, globex] }),
    })
    const table = await screen.findByRole('table', { name: 'Organizations' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map((row) => within(row).getAllByRole('cell')[0]?.textContent)).toEqual([
      'Globex',
      'Acme Corp',
    ])
    expect(within(table).getByRole('link', { name: 'Acme Corp' }).getAttribute('href')).toContain(
      `/organizations/${ACME}`
    )
    expect(sent(api, 'GET', '/v1/admin/organizations')[0]?.search.get('size')).toBe('20')
  })

  test('the search is made by the server, as the operator types, and can be cleared', async () => {
    const { user, location, api } = start(`${DEV_PATH}/organizations`, {
      api: arranged({ organizations: [acme, globex] }),
    })
    await screen.findByRole('table', { name: 'Organizations' })
    // No click on Search: the typing itself is sent, once it pauses.
    await user.type(screen.getByLabelText('Search organizations'), 'glob')
    await waitFor(() => expect(location()).toBe(`${DEV_PATH}/organizations?q=glob`))
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Acme Corp' })).toBeNull())
    expect(screen.getByRole('link', { name: 'Globex' })).toBeTruthy()
    const searches = sent(api, 'GET', '/v1/admin/organizations').map((call) => call.search.get('q'))
    // One request for the finished word, not one for each key; and the page is a normal one.
    expect(searches.filter((q) => q !== null)).toEqual(['glob'])
    expect(sent(api, 'GET', '/v1/admin/organizations').at(-1)?.search.get('size')).toBe('20')
    await user.click(screen.getByRole('button', { name: 'Clear' }))
    await screen.findByRole('link', { name: 'Acme Corp' })
    expect(location()).toBe(`${DEV_PATH}/organizations`)
  })

  test('keys typed after a search was sent stay in the box', async () => {
    const { user, location } = start(`${DEV_PATH}/organizations`, {
      api: arranged({ organizations: [acme, globex] }),
    })
    await screen.findByRole('table', { name: 'Organizations' })
    const box = screen.getByLabelText('Search organizations') as HTMLInputElement
    await user.type(box, 'gl')
    await waitFor(() => expect(location()).toBe(`${DEV_PATH}/organizations?q=gl`))
    await user.type(box, 'o')
    expect(box.value).toBe('glo')
    await waitFor(() => expect(location()).toBe(`${DEV_PATH}/organizations?q=glo`))
    expect(box.value).toBe('glo')
  })

  test('a search that matches nothing says so', async () => {
    const { user } = start(`${DEV_PATH}/organizations?q=zzz`, {
      api: arranged({ organizations: [acme] }),
    })
    await screen.findByText(/No organization matches that search/)
    expect(screen.queryByRole('table')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Clear' }))
    await screen.findByRole('link', { name: 'Acme Corp' })
  })

  test('creating one derives the slug from the name, then offers the new organization', async () => {
    const { user, api, location } = start(`${DEV_PATH}/organizations`, { api: arranged() })
    await user.click(await screen.findByRole('button', { name: 'Create organization' }))
    await user.type(within(dialog()).getByLabelText('Name'), 'Northline Labs')
    expect((within(dialog()).getByLabelText('Slug') as HTMLInputElement).value).toBe(
      'northline-labs'
    )
    await user.click(button('Create organization'))
    await screen.findByRole('heading', { name: 'Organization created' })
    expect(sent(api, 'POST', '/v1/admin/organizations')[0]?.body).toEqual({
      name: 'Northline Labs',
      slug: 'northline-labs',
    })
    await user.click(within(dialog()).getByRole('link', { name: 'Open organization' }))
    await waitFor(() => expect(location()).toMatch(/\/organizations\/[0-9a-f-]{36}$/))
  })

  test('a slug that breaks the grammar, and a slug that is taken, are said on the field', async () => {
    const { user, api } = start(`${DEV_PATH}/organizations`, {
      api: arranged({ organizations: [acme] }),
    })
    await user.click(await screen.findByRole('button', { name: 'Create organization' }))
    await user.type(within(dialog()).getByLabelText('Name'), 'Acme Two')
    await user.clear(within(dialog()).getByLabelText('Slug'))
    await user.type(within(dialog()).getByLabelText('Slug'), 'Not A Slug')
    await user.click(button('Create organization'))
    await waitFor(() => expect(alerts()).toHaveLength(1))
    expect(alerts()[0]).toMatch(/lower-case letters and digits/)
    expect(sent(api, 'POST', '/v1/admin/organizations')).toHaveLength(0)

    await user.clear(within(dialog()).getByLabelText('Slug'))
    await user.type(within(dialog()).getByLabelText('Slug'), 'acme')
    await user.click(button('Create organization'))
    await waitFor(() =>
      expect(alerts()).toEqual(['Another organization in this environment already uses that slug.'])
    )
    // The form is still there to correct, and the button is back.
    await user.clear(within(dialog()).getByLabelText('Slug'))
    await user.type(within(dialog()).getByLabelText('Slug'), 'acme-two')
    await user.click(button('Create organization'))
    await screen.findByRole('heading', { name: 'Organization created' })
  })
})

describe('an organization’s page', () => {
  const manager = (role = 'admin', userId: string = IDS.user) => ({
    organizationId: ACME,
    userId,
    role,
  })

  test('shows the organization, its members with their roles and its waiting invitations', async () => {
    start(`${DEV_PATH}/organizations/${ACME}`, {
      api: arranged({
        organizations: [acme],
        memberships: [manager('admin'), manager('member', SECOND_USER)],
        invitations: [
          { organizationId: ACME, email: 'new.hire@example.com', role: 'member' },
          { organizationId: ACME, email: 'old@example.com', status: 'revoked' },
        ],
      }),
    })
    await screen.findByRole('heading', { level: 1, name: 'Acme Corp' })
    const members = await screen.findByRole('table', { name: 'Members of Acme Corp' })
    await within(members).findByRole('link', { name: 'ada@example.com' })
    const rows = within(members).getAllByRole('row').slice(1)
    expect(rows.map((row) => within(row).getAllByRole('cell')[1]?.textContent)).toEqual([
      'Admin',
      'Member',
    ])
    const invitations = await screen.findByRole('table', {
      name: 'Pending invitations to Acme Corp',
    })
    expect(within(invitations).getByText('new.hire@example.com')).toBeTruthy()
    expect(within(invitations).queryByText('old@example.com')).toBeNull()
  })

  test('shows another state of invitation on request', async () => {
    const { user } = start(`${DEV_PATH}/organizations/${ACME}`, {
      api: arranged({
        organizations: [acme],
        invitations: [{ organizationId: ACME, email: 'old@example.com', status: 'revoked' }],
      }),
    })
    await screen.findByText('No invitations are waiting')
    await user.selectOptions(screen.getByLabelText('Show invitations that are'), 'revoked')
    await screen.findByText('old@example.com')
  })

  test('an organization that does not exist is a failure with a way back, not a blank page', async () => {
    start(`${DEV_PATH}/organizations/${GLOBEX}`, { api: arranged({ organizations: [acme] }) })
    await screen.findByText('This could not be loaded')
    expect(screen.getByRole('link', { name: '← All organizations' })).toBeTruthy()
  })

  test('renaming it, and a slug already taken', async () => {
    const { user, api } = start(`${DEV_PATH}/organizations/${ACME}`, {
      api: arranged({ organizations: [acme, globex] }),
    })
    await user.click(await screen.findByRole('button', { name: 'Edit' }))
    await user.clear(within(dialog()).getByLabelText('Slug'))
    await user.type(within(dialog()).getByLabelText('Slug'), 'globex')
    await user.click(button('Save changes'))
    await waitFor(() =>
      expect(alerts()).toEqual(['Another organization in this environment already uses that slug.'])
    )
    await user.clear(within(dialog()).getByLabelText('Name'))
    await user.type(within(dialog()).getByLabelText('Name'), 'Acme Holdings')
    await user.clear(within(dialog()).getByLabelText('Slug'))
    await user.type(within(dialog()).getByLabelText('Slug'), 'acme')
    await user.click(button('Save changes'))
    await screen.findByRole('heading', { level: 1, name: 'Acme Holdings' })
    // Only what changed is sent.
    expect(sent(api, 'PATCH', `/v1/admin/organizations/${ACME}`).at(-1)?.body).toEqual({
      name: 'Acme Holdings',
    })
  })

  test('deleting it names it, says what goes with it, and goes back to the list', async () => {
    const { user, api, location } = start(`${DEV_PATH}/organizations/${ACME}`, {
      api: arranged({ organizations: [acme], memberships: [manager()] }),
    })
    await user.click(await screen.findByRole('button', { name: 'Delete organization' }))
    expect(within(dialog()).getByRole('heading').textContent).toBe('Delete Acme Corp?')
    expect(dialog().textContent).toContain('Every membership and invitation')
    await user.click(button('Delete organization'))
    await waitFor(() => expect(location()).toBe(`${DEV_PATH}/organizations`))
    expect(api.state.organizations).toHaveLength(0)
    expect(api.state.memberships).toHaveLength(0)
  })

  test('in production the slug is typed to delete it', async () => {
    const api = arranged({
      organizations: [{ ...acme, environmentId: IDS.production }],
    })
    // The fake reads one settings document: production is switched on by the same one.
    const { user } = start(`${PROD_PATH}/organizations/${ACME}`, { api })
    await user.click(await screen.findByRole('button', { name: 'Delete organization' }))
    const confirm = button('Delete organization')
    await user.click(confirm)
    expect(sent(api, 'DELETE', '/v1/admin/organizations')).toHaveLength(0)
    await user.type(within(dialog()).getByLabelText(/Type .* to confirm/), 'acme')
    await user.click(confirm)
    await waitFor(() => expect(sent(api, 'DELETE', '/v1/admin/organizations')).toHaveLength(1))
  })
})

describe('members', () => {
  const manager = (userId: string = IDS.user, role = 'admin') => ({
    organizationId: ACME,
    userId,
    role,
  })

  test('a role is changed, and the page shows it', async () => {
    const { user, api } = start(`${DEV_PATH}/organizations/${ACME}`, {
      api: arranged({
        organizations: [acme],
        memberships: [manager(IDS.user), manager(SECOND_USER, 'member')],
      }),
    })
    await user.click(
      await screen.findByRole('button', { name: 'Change the role of grace@example.com' })
    )
    expect(within(dialog()).getByRole('heading').textContent).toBe(
      'Change the role of grace@example.com?'
    )
    await user.selectOptions(within(dialog()).getByLabelText('Role'), 'admin')
    await user.click(button('Change role'))
    await waitFor(() => expect(openDialogs()).toBe(0))
    await screen.findByText('Role changed')
    expect(
      sent(api, 'PATCH', `/v1/admin/organizations/${ACME}/memberships/${SECOND_USER}`)[0]?.body
    ).toEqual({
      role: 'admin',
    })
    expect(api.state.memberships.find((entry) => entry.userId === SECOND_USER)?.role).toBe('admin')
  })

  test('the only manager cannot be demoted or removed, and the refusal is said in the dialog', async () => {
    const { user, api } = start(`${DEV_PATH}/organizations/${ACME}`, {
      api: arranged({ organizations: [acme], memberships: [manager(IDS.user)] }),
    })
    await user.click(
      await screen.findByRole('button', { name: 'Change the role of ada@example.com' })
    )
    await user.selectOptions(within(dialog()).getByLabelText('Role'), 'member')
    await user.click(button('Change role'))
    await waitFor(() => expect(alerts()[0]).toMatch(/must keep at least one member who can manage/))
    // The form is still there, and its button is back.
    await user.click(button('Cancel'))
    await waitFor(() => expect(openDialogs()).toBe(0))

    await user.click(screen.getByRole('button', { name: 'Remove ada@example.com' }))
    await user.click(button('Remove member'))
    await waitFor(() => expect(alerts()[0]).toMatch(/must keep at least one member who can manage/))
    expect(api.state.memberships).toHaveLength(1)
  })

  test('removing a member names them and the organization, and keeps their account', async () => {
    const { user, api } = start(`${DEV_PATH}/organizations/${ACME}`, {
      api: arranged({
        organizations: [acme],
        memberships: [manager(IDS.user), manager(SECOND_USER, 'member')],
      }),
    })
    await user.click(await screen.findByRole('button', { name: 'Remove grace@example.com' }))
    expect(within(dialog()).getByRole('heading').textContent).toBe(
      'Remove grace@example.com from Acme Corp?'
    )
    await user.click(button('Remove member'))
    await waitFor(() => expect(openDialogs()).toBe(0))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove grace@example.com' })).toBeNull()
    )
    expect(api.state.users.some((entry) => entry.id === SECOND_USER)).toBe(true)
  })

  test('a member is added by searching for the user and choosing a role', async () => {
    const { user, api } = start(`${DEV_PATH}/organizations/${ACME}`, {
      api: arranged({ organizations: [acme], memberships: [manager(IDS.user)] }),
    })
    await user.click(await screen.findByRole('button', { name: 'Add member' }))
    await user.click(button('Add member'))
    await waitFor(() => expect(alerts()).toEqual(['Search for a user and choose one.']))
    await user.type(within(dialog()).getByLabelText('Find a user'), 'grace')
    await user.click(within(dialog()).getByRole('button', { name: 'Search' }))
    await user.selectOptions(await within(dialog()).findByLabelText('User'), SECOND_USER)
    await user.selectOptions(within(dialog()).getByLabelText('Role'), 'member')
    await user.click(button('Add member'))
    await screen.findByText('Member added')
    expect(sent(api, 'POST', `/v1/admin/organizations/${ACME}/memberships`)[0]?.body).toEqual({
      userId: SECOND_USER,
      role: 'member',
    })
    await screen.findByRole('link', { name: 'grace@example.com' })
  })

  test('a search that finds nobody says so', async () => {
    const { user } = start(`${DEV_PATH}/organizations/${ACME}`, {
      api: arranged({ organizations: [acme] }),
    })
    await user.click(await screen.findByRole('button', { name: 'Add member' }))
    await user.type(within(dialog()).getByLabelText('Find a user'), 'nobody')
    await user.click(within(dialog()).getByRole('button', { name: 'Search' }))
    await within(dialog()).findByText('No user matches that search.')
  })

  test('a member in the list twice is refused in words', async () => {
    const { user } = start(`${DEV_PATH}/organizations/${ACME}`, {
      api: arranged({ organizations: [acme], memberships: [manager(SECOND_USER, 'member')] }),
    })
    await user.click(await screen.findByRole('button', { name: 'Add member' }))
    await user.type(within(dialog()).getByLabelText('Find a user'), 'grace')
    await user.click(within(dialog()).getByRole('button', { name: 'Search' }))
    await user.selectOptions(await within(dialog()).findByLabelText('User'), SECOND_USER)
    await user.click(button('Add member'))
    await waitFor(() =>
      expect(alerts()).toEqual(['That user is already a member of this organization.'])
    )
  })
})

describe('invitations', () => {
  test('an invitation is sent to an allowed redirect URL, with the role chosen', async () => {
    const { user, api } = start(`${DEV_PATH}/organizations/${ACME}`, {
      api: arranged({ organizations: [acme] }),
    })
    await user.click(await screen.findByRole('button', { name: 'Invite by email' }))
    await user.click(button('Send invitation'))
    await waitFor(() => expect(alerts()).toEqual(['Enter the email address to invite.']))
    await user.type(within(dialog()).getByLabelText('Email address'), 'new.hire@example.com')
    await waitFor(() =>
      expect(
        (within(dialog()).getByLabelText('The link leads to') as HTMLSelectElement).value
      ).toBe(REDIRECT)
    )
    await user.click(button('Send invitation'))
    await screen.findByText('Invitation sent')
    expect(sent(api, 'POST', `/v1/admin/organizations/${ACME}/invitations`)[0]?.body).toEqual({
      email: 'new.hire@example.com',
      role: 'member',
      redirectUrl: REDIRECT,
    })
    await screen.findByText('new.hire@example.com')
  })

  test('with no allowed redirect URL it says what is missing instead of failing', async () => {
    const { user, api } = start(`${DEV_PATH}/organizations/${ACME}`, {
      api: arranged({ organizations: [acme], redirectUrls: ['com.example.app:/oauth'] }),
    })
    await user.click(await screen.findByRole('button', { name: 'Invite by email' }))
    await within(dialog()).findByText(/no allowed https redirect URL/)
    await user.type(within(dialog()).getByLabelText('Email address'), 'new.hire@example.com')
    await user.click(button('Send invitation'))
    await waitFor(() => expect(alerts()).toEqual(['Choose where the link leads.']))
    expect(sent(api, 'POST', '/v1/admin/organizations')).toHaveLength(0)
  })

  test('an address that is waiting already is refused in words', async () => {
    const { user } = start(`${DEV_PATH}/organizations/${ACME}`, {
      api: arranged({
        organizations: [acme],
        invitations: [{ organizationId: ACME, email: 'new.hire@example.com' }],
      }),
    })
    await user.click(await screen.findByRole('button', { name: 'Invite by email' }))
    await user.type(within(dialog()).getByLabelText('Email address'), 'New.Hire@example.com')
    await waitFor(() =>
      expect(
        (within(dialog()).getByLabelText('The link leads to') as HTMLSelectElement).value
      ).toBe(REDIRECT)
    )
    await user.click(button('Send invitation'))
    await waitFor(() =>
      expect(alerts()).toEqual(['That address already has a pending invitation here.'])
    )
  })

  test('withdrawing one names the address, and the invitation leaves the waiting list', async () => {
    const { user, api } = start(`${DEV_PATH}/organizations/${ACME}`, {
      api: arranged({
        organizations: [acme],
        invitations: [{ organizationId: ACME, email: 'new.hire@example.com' }],
      }),
    })
    await user.click(
      await screen.findByRole('button', { name: 'Withdraw the invitation to new.hire@example.com' })
    )
    expect(within(dialog()).getByRole('heading').textContent).toBe(
      'Withdraw the invitation to new.hire@example.com?'
    )
    await user.click(button('Withdraw invitation'))
    await screen.findByText('Invitation withdrawn')
    await screen.findByText('No invitations are waiting')
    expect(api.state.invitations[0]?.status).toBe('revoked')
  })
})

describe('the roles screen', () => {
  const billing = { key: 'billing', name: 'Billing manager', permissions: ['org:billing:read'] }

  test('the built-in roles are read-only, and the custom ones are listed with their permissions', async () => {
    start(`${DEV_PATH}/roles`, { api: arranged({ roles: [billing] }) })
    const cards = await screen.findAllByTestId('role')
    expect(cards.map((card) => card.getAttribute('data-key'))).toEqual([
      'admin',
      'member',
      'billing',
    ])
    const [admin, member, custom] = cards as [HTMLElement, HTMLElement, HTMLElement]
    for (const builtIn of [admin, member]) {
      expect(within(builtIn).queryAllByRole('button')).toHaveLength(0)
      expect(within(builtIn).getByText('Built in')).toBeTruthy()
    }
    expect(within(admin).getByText('Manage the members')).toBeTruthy()
    expect(within(member).getByText('See the members')).toBeTruthy()
    expect(within(custom).getByText('org:billing:read')).toBeTruthy()
    expect(within(custom).getByText(/Version 1/)).toBeTruthy()
    expect(
      within(custom).getByRole('button', { name: 'Edit the role Billing manager' })
    ).toBeTruthy()
    expect(screen.getByText(/1 of 50 custom roles/)).toBeTruthy()
  })

  test('with no custom role it says so', async () => {
    start(`${DEV_PATH}/roles`, { api: arranged() })
    await screen.findByText('No custom roles yet')
  })

  test('creating a role sends the sorted set of system and own permissions', async () => {
    const { user, api } = start(`${DEV_PATH}/roles`, { api: arranged() })
    await user.click(await screen.findByRole('button', { name: 'Create role' }))
    await user.type(within(dialog()).getByLabelText('Name'), 'Support lead')
    await user.type(within(dialog()).getByLabelText('Key'), 'support_lead')
    await user.click(within(dialog()).getByLabelText('See the members'))
    await user.type(
      within(dialog()).getByLabelText('Your own permissions'),
      'org:tickets:write{Enter}org:tickets:read'
    )
    await user.click(button('Create role'))
    await screen.findByText('Role created')
    expect(sent(api, 'POST', '/v1/admin/organization-roles')[0]?.body).toEqual({
      key: 'support_lead',
      name: 'Support lead',
      permissions: ['org:sys:memberships:read', 'org:tickets:read', 'org:tickets:write'],
    })
    await screen.findByRole('heading', { name: 'Support lead' })
  })

  test.each([
    ['not a permission key', 'billing.read', /is not a permission key/],
    ['a sys key Tula does not define', 'org:sys:billing:read', /reserved sys feature/],
  ])('%s is refused on the field before anything is sent', async (_name, typed, message) => {
    const { user, api } = start(`${DEV_PATH}/roles`, { api: arranged() })
    await user.click(await screen.findByRole('button', { name: 'Create role' }))
    await user.type(within(dialog()).getByLabelText('Name'), 'Odd')
    await user.type(within(dialog()).getByLabelText('Key'), 'odd')
    await user.type(within(dialog()).getByLabelText('Your own permissions'), typed)
    await user.click(button('Create role'))
    await waitFor(() => expect(alerts()[0]).toMatch(message))
    expect(sent(api, 'POST', '/v1/admin/organization-roles')).toHaveLength(0)
  })

  test('a key that breaks the grammar, and a key that is taken (built-in ones too), are said', async () => {
    const { user } = start(`${DEV_PATH}/roles`, { api: arranged({ roles: [billing] }) })
    await user.click(await screen.findByRole('button', { name: 'Create role' }))
    await user.type(within(dialog()).getByLabelText('Name'), 'Odd')
    await user.type(within(dialog()).getByLabelText('Key'), 'Odd Key')
    await user.click(button('Create role'))
    await waitFor(() => expect(alerts()[0]).toMatch(/starts with a lower-case letter/))
    for (const taken of ['admin', 'billing']) {
      await user.clear(within(dialog()).getByLabelText('Key'))
      await user.type(within(dialog()).getByLabelText('Key'), taken)
      await user.click(button('Create role'))
      await waitFor(() =>
        expect(alerts()).toEqual(['A role with that key already exists, built-in roles included.'])
      )
    }
  })

  test('more than 32 permissions are refused before anything is sent', async () => {
    const { user, api } = start(`${DEV_PATH}/roles`, { api: arranged() })
    await user.click(await screen.findByRole('button', { name: 'Create role' }))
    await user.type(within(dialog()).getByLabelText('Name'), 'Big')
    await user.type(within(dialog()).getByLabelText('Key'), 'big')
    const many = Array.from({ length: 33 }, (_, index) => `org:feature:action_${index}`).join(' ')
    await user.click(within(dialog()).getByLabelText('Your own permissions'))
    await user.paste(many)
    await user.click(button('Create role'))
    await waitFor(() => expect(alerts()[0]).toMatch(/at most 32 permissions; this one has 33/))
    expect(sent(api, 'POST', '/v1/admin/organization-roles')).toHaveLength(0)
  })

  test('the cap of custom roles is said when the server reaches it', async () => {
    const { user } = start(`${DEV_PATH}/roles`, { api: arranged() })
    world?.api.override('POST', /^\/v1\/admin\/organization-roles$/, () =>
      failure(409, 'organization.role_limit', 'Full.', undefined, { max: 50 })
    )
    await user.click(await screen.findByRole('button', { name: 'Create role' }))
    await user.type(within(dialog()).getByLabelText('Name'), 'One more')
    await user.type(within(dialog()).getByLabelText('Key'), 'one_more')
    await user.click(button('Create role'))
    await waitFor(() =>
      expect(alerts()).toEqual([
        'This environment has the most custom roles it can have (50). Delete one first.',
      ])
    )
  })

  test('an edit carries the version it read, and only what changed', async () => {
    const { user, api } = start(`${DEV_PATH}/roles`, {
      api: arranged({ roles: [{ ...billing, version: 4 }] }),
    })
    await user.click(await screen.findByRole('button', { name: 'Edit the role Billing manager' }))
    expect((within(dialog()).getByLabelText('Key') as HTMLInputElement).readOnly).toBe(true)
    await user.clear(within(dialog()).getByLabelText('Name'))
    await user.type(within(dialog()).getByLabelText('Name'), 'Billing lead')
    await user.click(button('Save changes'))
    await screen.findByText('Role saved')
    const call = sent(api, 'PATCH', '/v1/admin/organization-roles/billing')[0]
    expect(call?.headers.get('if-match')).toBe('"4"')
    expect(call?.body).toEqual({ name: 'Billing lead' })
    expect(api.state.roles[0]?.version).toBe(5)
  })

  test('taking a permission away is not asked about; adding one is', async () => {
    const { user, api } = start(`${DEV_PATH}/roles`, {
      api: arranged({
        roles: [{ ...billing, permissions: ['org:billing:read', 'org:billing:write'] }],
      }),
    })
    await user.click(await screen.findByRole('button', { name: 'Edit the role Billing manager' }))
    await user.clear(within(dialog()).getByLabelText('Your own permissions'))
    await user.type(within(dialog()).getByLabelText('Your own permissions'), 'org:billing:read')
    await user.click(button('Save changes'))
    await screen.findByText('Role saved')
    expect(api.state.roles[0]?.permissions).toEqual(['org:billing:read'])

    await user.click(await screen.findByRole('button', { name: 'Edit the role Billing manager' }))
    await user.click(within(dialog()).getByLabelText('Manage the members'))
    await user.click(button('Save changes'))
    expect(await within(dialog()).findByTestId('weakening')).toBeTruthy()
    expect(within(dialog()).getByRole('heading').textContent).toBe(
      'Give the role Billing manager more access?'
    )
    expect(dialog().textContent).toContain('gains a permission')
    expect(dialog().textContent).toContain('Manage the members')
    expect(dialog().textContent).toContain('recorded in the audit log as a weakening')
    expect(sent(api, 'PATCH', '/v1/admin/organization-roles/billing')).toHaveLength(1)
    // Going back keeps what was typed.
    await user.click(button('Cancel'))
    expect(within(dialog()).getByLabelText('Manage the members').getAttribute('aria-checked')).toBe(
      'true'
    )
    await user.click(button('Save changes'))
    await user.click(button('Give more access'))
    await screen.findByText('Role saved')
    expect(api.state.roles[0]?.permissions).toEqual([
      'org:billing:read',
      'org:sys:memberships:manage',
    ])
  })

  test('a role changed since it was opened says so, sends nothing over the other change, and loads the current one', async () => {
    const { user, api } = start(`${DEV_PATH}/roles`, { api: arranged({ roles: [billing] }) })
    await user.click(await screen.findByRole('button', { name: 'Edit the role Billing manager' }))
    // Someone else renames it after the dialog was opened.
    const stored = api.state.roles[0] as FakeRole
    stored.name = 'Finance manager'
    stored.version = 2
    await user.clear(within(dialog()).getByLabelText('Name'))
    await user.type(within(dialog()).getByLabelText('Name'), 'Mine')
    await user.click(button('Save changes'))
    await waitFor(() => expect(alerts()[0]).toMatch(/Changed since you opened it/))
    expect(alerts()[0]).toMatch(/nothing was saved/)
    expect(api.state.roles[0]?.name).toBe('Finance manager')
    expect(sent(api, 'PATCH', '/v1/admin/organization-roles/billing')).toHaveLength(1)

    await user.click(button('Load the current version'))
    await waitFor(() =>
      expect((within(dialog()).getByLabelText('Name') as HTMLInputElement).value).toBe(
        'Finance manager'
      )
    )
    expect(alerts()).toEqual([])
    await user.clear(within(dialog()).getByLabelText('Name'))
    await user.type(within(dialog()).getByLabelText('Name'), 'Finance lead')
    await user.click(button('Save changes'))
    await screen.findByText('Role saved')
    const second = sent(api, 'PATCH', '/v1/admin/organization-roles/billing')[1]
    expect(second?.headers.get('if-match')).toBe('"2"')
    expect(api.state.roles[0]?.name).toBe('Finance lead')
  })

  test('a role deleted since it was opened is said, not retried', async () => {
    const { user, api } = start(`${DEV_PATH}/roles`, { api: arranged({ roles: [billing] }) })
    await user.click(await screen.findByRole('button', { name: 'Edit the role Billing manager' }))
    const stored = api.state.roles[0] as FakeRole
    stored.version = 2
    await user.clear(within(dialog()).getByLabelText('Name'))
    await user.type(within(dialog()).getByLabelText('Name'), 'Mine')
    await user.click(button('Save changes'))
    await waitFor(() => expect(alerts()[0]).toMatch(/Changed since you opened it/))
    api.state.roles.splice(0, 1)
    await user.click(button('Load the current version'))
    await waitFor(() => expect(alerts()[0]).toMatch(/no longer exists/))
  })

  test('a role that strips the last manager of an organization is refused in words', async () => {
    const { user } = start(`${DEV_PATH}/roles`, {
      api: arranged({
        roles: [
          { ...billing, key: 'owner', name: 'Owner', permissions: ['org:sys:memberships:manage'] },
        ],
        organizations: [acme],
        memberships: [{ organizationId: ACME, userId: IDS.user, role: 'owner' }],
      }),
    })
    await user.click(await screen.findByRole('button', { name: 'Edit the role Owner' }))
    await user.click(within(dialog()).getByLabelText('Manage the members'))
    await user.click(button('Save changes'))
    await waitFor(() => expect(alerts()[0]).toMatch(/must keep at least one member who can manage/))
  })

  test('deleting a role names it; a role in use is refused in words and stays', async () => {
    const { user, api } = start(`${DEV_PATH}/roles`, {
      api: arranged({
        roles: [billing, { key: 'idle', name: 'Idle', permissions: [] }],
        organizations: [acme],
        memberships: [{ organizationId: ACME, userId: IDS.user, role: 'billing' }],
      }),
    })
    await user.click(await screen.findByRole('button', { name: 'Delete the role Billing manager' }))
    expect(within(dialog()).getByRole('heading').textContent).toBe(
      'Delete the role Billing manager?'
    )
    await user.click(button('Delete role'))
    await waitFor(() => expect(alerts()[0]).toMatch(/Members still hold this role/))
    expect(api.state.roles.map((role) => role.key)).toEqual(['billing', 'idle'])
    await user.click(button('Cancel'))
    await waitFor(() => expect(openDialogs()).toBe(0))

    await user.click(screen.getByRole('button', { name: 'Delete the role Idle' }))
    await user.click(button('Delete role'))
    await screen.findByText('Role deleted')
    expect(api.state.roles.map((role) => role.key)).toEqual(['billing'])
    expect(
      sent(api, 'DELETE', '/v1/admin/organization-roles/idle')[0]?.headers.get('if-match')
    ).toBe('"1"')
  })

  test('in production the key is typed to delete a role', async () => {
    const api = arranged({
      roles: [{ ...billing, environmentId: IDS.production }],
    })
    const { user } = start(`${PROD_PATH}/roles`, { api })
    await user.click(await screen.findByRole('button', { name: 'Delete the role Billing manager' }))
    await user.click(button('Delete role'))
    expect(sent(api, 'DELETE', '/v1/admin/organization-roles')).toHaveLength(0)
    await user.type(within(dialog()).getByLabelText(/Type .* to confirm/), 'billing')
    await user.click(button('Delete role'))
    await waitFor(() => expect(sent(api, 'DELETE', '/v1/admin/organization-roles')).toHaveLength(1))
  })
})

describe('a confirmed change is sent once', () => {
  test('a member’s removal, held while the lists are read again, is sent once', async () => {
    const api = arranged({
      organizations: [acme],
      memberships: [
        { organizationId: ACME, userId: IDS.user, role: 'admin' },
        { organizationId: ACME, userId: SECOND_USER, role: 'member' },
      ],
    })
    const { user } = start(`${DEV_PATH}/organizations/${ACME}`, { api })
    await user.click(await screen.findByRole('button', { name: 'Remove grace@example.com' }))
    const held = holdAnswers(
      (path, _headers, method) => method === 'GET' && path.includes('/memberships')
    )
    await user.click(button('Remove member'))
    await waitFor(() => expect(sent(api, 'DELETE', '/v1/admin/organizations')).toHaveLength(1))
    await waitFor(() => expect(held.held()).toBeGreaterThan(0))
    await user.click(button('Remove member'))
    expect(sent(api, 'DELETE', '/v1/admin/organizations')).toHaveLength(1)
    await held.release()
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(sent(api, 'DELETE', '/v1/admin/organizations')).toHaveLength(1)
  })

  test('a role’s deletion, held while the list is read again, is sent once', async () => {
    const api = arranged({
      roles: [{ key: 'idle', name: 'Idle', permissions: [] }],
    })
    const { user } = start(`${DEV_PATH}/roles`, { api })
    await user.click(await screen.findByRole('button', { name: 'Delete the role Idle' }))
    const held = holdAnswers(
      (path, _headers, method) => method === 'GET' && path === '/v1/admin/organization-roles'
    )
    await user.click(button('Delete role'))
    await waitFor(() => expect(sent(api, 'DELETE', '/v1/admin/organization-roles')).toHaveLength(1))
    await waitFor(() => expect(held.held()).toBeGreaterThan(0))
    await user.click(button('Delete role'))
    await held.release()
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(sent(api, 'DELETE', '/v1/admin/organization-roles')).toHaveLength(1)
  })

  test('a new role, held while the list is read again, is created once', async () => {
    const api = arranged()
    const { user } = start(`${DEV_PATH}/roles`, { api })
    await user.click(await screen.findByRole('button', { name: 'Create role' }))
    await user.type(within(dialog()).getByLabelText('Name'), 'Support lead')
    await user.type(within(dialog()).getByLabelText('Key'), 'support_lead')
    const held = holdAnswers(
      (path, _headers, method) => method === 'GET' && path === '/v1/admin/organization-roles'
    )
    await user.click(button('Create role'))
    await waitFor(() => expect(sent(api, 'POST', '/v1/admin/organization-roles')).toHaveLength(1))
    await waitFor(() => expect(held.held()).toBeGreaterThan(0))
    await user.click(button('Create role'))
    await held.release()
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(sent(api, 'POST', '/v1/admin/organization-roles')).toHaveLength(1)
  })
})

describe('the organization settings', () => {
  const organizationsOf = (api: FakeApi) => api.state.settings.settings.organizations

  test('shows the section with its defaults and the roles to choose from', async () => {
    start(`${DEV_PATH}/organization-settings`, {
      api: arranged({ roles: [{ key: 'owner', name: 'Owner', permissions: [] }] }),
    })
    const heading = await screen.findByRole('heading', { level: 1, name: 'Organization settings' })
    expect(heading).toBeTruthy()
    expect(
      ((await screen.findByLabelText('Organizations one user may create')) as HTMLInputElement)
        .value
    ).toBe('5')
    const creator = (await screen.findByLabelText('Role of the creator')) as HTMLSelectElement
    await waitFor(() =>
      expect(Array.from(creator.options).map((option) => option.value)).toContain('owner')
    )
    expect(creator.value).toBe('admin')
    expect((screen.getByLabelText('Default role') as HTMLSelectElement).value).toBe('member')
  })

  test('switching organizations on is not asked about, and saves the whole document', async () => {
    const { user, api } = start(`${DEV_PATH}/organization-settings`, {
      api: arranged({ off: true }),
    })
    await user.click(await screen.findByRole('switch', { name: 'Organizations are on' }))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Settings saved')
    expect(openDialogs()).toBe(0)
    expect(organizationsOf(api)?.enabled).toBe(true)
  })

  test.each([
    [
      'switching them off',
      async (user: World['user']) =>
        user.click(await screen.findByRole('switch', { name: 'Organizations are on' })),
      'Organizations are switched off',
      { enabled: false },
    ],
    [
      'letting users create them',
      async (user: World['user']) =>
        user.click(await screen.findByRole('switch', { name: 'Users may create organizations' })),
      'Any signed-in user may create an organization',
      { allowUserCreated: true },
    ],
    [
      'raising the cap',
      async (user: World['user']) => {
        const field = await screen.findByLabelText('Organizations one user may create')
        await user.clear(field)
        await user.type(field, '9')
      },
      'may create more organizations than before',
      { maxCreatedPerUser: 9 },
    ],
    [
      'removing the cap',
      async (user: World['user']) =>
        user.clear(await screen.findByLabelText('Organizations one user may create')),
      'may create more organizations than before',
      { maxCreatedPerUser: null },
    ],
  ])(
    '%s asks first, and nothing is saved until it is answered',
    async (_name, change, sentence, saved) => {
      const { user, api } = start(`${DEV_PATH}/organization-settings`, { api: arranged() })
      await change(user)
      await user.click(screen.getByRole('button', { name: 'Save changes' }))
      await screen.findByRole('heading', { name: 'This weakens security. Save anyway?' })
      expect(dialog().textContent).toContain(sentence)
      expect(api.callsTo('PUT', '/v1/admin/settings')).toHaveLength(0)
      await user.click(button('Cancel'))
      await waitFor(() => expect(openDialogs()).toBe(0))
      expect(api.callsTo('PUT', '/v1/admin/settings')).toHaveLength(0)
      await user.click(screen.getByRole('button', { name: 'Save changes' }))
      await user.click(await screen.findByRole('button', { name: 'Save anyway' }))
      await screen.findByText('Settings saved')
      expect(organizationsOf(api)).toMatchObject(saved)
    }
  )

  test('lowering the cap and choosing roles are not asked about', async () => {
    const { user, api } = start(`${DEV_PATH}/organization-settings`, {
      api: arranged({ roles: [{ key: 'owner', name: 'Owner', permissions: [] }] }),
    })
    const field = await screen.findByLabelText('Organizations one user may create')
    await user.clear(field)
    await user.type(field, '2')
    const creator = screen.getByLabelText('Role of the creator')
    await waitFor(() =>
      expect(Array.from((creator as HTMLSelectElement).options).map((o) => o.value)).toContain(
        'owner'
      )
    )
    await user.selectOptions(creator, 'owner')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Settings saved')
    expect(organizationsOf(api)).toMatchObject({ maxCreatedPerUser: 2, creatorRole: 'owner' })
  })

  test('settings changed elsewhere are not saved over', async () => {
    const { user, api } = start(`${DEV_PATH}/organization-settings`, { api: arranged() })
    await user.click(
      await screen.findByRole('switch', { name: 'A session may have no organization' })
    )
    api.state.settings.revision += 1
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Changed elsewhere.')
  })
})

describe('a user’s memberships', () => {
  test('are listed on the user’s page, with the role in each and a link to the organization', async () => {
    const { user, location } = start(`${DEV_PATH}/users/${IDS.user}`, {
      api: arranged({
        organizations: [acme, globex],
        memberships: [
          { organizationId: ACME, userId: IDS.user, role: 'admin' },
          { organizationId: GLOBEX, userId: IDS.user, role: 'member' },
        ],
      }),
    })
    const table = await screen.findByRole('table', { name: 'Organizations of this user' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(
      rows.map((row) =>
        within(row)
          .getAllByRole('cell')
          .map((cell) => cell.textContent)
          .slice(0, 3)
      )
    ).toEqual([
      ['Acme Corp', 'acme', 'Admin'],
      ['Globex', 'globex', 'Member'],
    ])
    await user.click(within(table).getByRole('link', { name: 'Globex' }))
    await waitFor(() => expect(location()).toBe(`${DEV_PATH}/organizations/${GLOBEX}`))
  })

  test('a user in none says so; with organizations off the section says that', async () => {
    start(`${DEV_PATH}/users/${IDS.user}`, { api: arranged() })
    await screen.findByText('This user does not belong to any organization.')
    world?.queryClient.clear()
    world?.api.restore()
    world = undefined

    start(`${DEV_PATH}/users/${IDS.user}`, { api: arranged({ off: true }) })
    await screen.findByRole('heading', { level: 1, name: 'ada@example.com' })
    await screen.findByText('Organizations are switched off in this environment')
    expect(screen.queryByText('This could not be loaded')).toBeNull()
  })
})

describe('deleting a user who is the last manager of an organization', () => {
  test('is refused in words that name the organizations, with a link to each, and deletes nothing', async () => {
    const { user, api, location } = start(`${DEV_PATH}/users/${IDS.user}`, {
      api: arranged({
        organizations: [acme, globex],
        memberships: [
          { organizationId: ACME, userId: IDS.user, role: 'admin' },
          { organizationId: GLOBEX, userId: IDS.user, role: 'admin' },
        ],
      }),
    })
    await user.click(await screen.findByRole('button', { name: 'Delete user' }))
    await user.click(button('Delete user'))
    await waitFor(() =>
      expect(alerts()).toEqual([
        'This user is the only manager of 2 organizations. Give each another manager, or delete it, then try again.',
      ])
    )
    const links = within(dialog())
      .getAllByRole('link')
      .map((link) => link.textContent)
    await waitFor(() =>
      expect(
        within(dialog())
          .getAllByRole('link')
          .map((link) => link.textContent)
      ).toEqual(['Acme Corp', 'Globex'])
    )
    expect(links).toHaveLength(2)
    expect(api.state.users.some((entry) => entry.id === IDS.user)).toBe(true)
    // The dialog stays to be read; the way out is to give the organization another manager.
    expect(openDialogs()).toBe(1)
    await user.click(within(dialog()).getByRole('link', { name: 'Acme Corp' }))
    await waitFor(() => expect(location()).toBe(`${DEV_PATH}/organizations/${ACME}`))
  })

  test('one organization is said in the singular, and deleting works once it has another manager', async () => {
    const { user, api } = start(`${DEV_PATH}/users/${IDS.user}`, {
      api: arranged({
        organizations: [acme],
        memberships: [{ organizationId: ACME, userId: IDS.user, role: 'admin' }],
      }),
    })
    await user.click(await screen.findByRole('button', { name: 'Delete user' }))
    await user.click(button('Delete user'))
    await waitFor(() =>
      expect(alerts()[0]).toMatch(/This user is the only manager of an organization\./)
    )
    api.state.memberships.push(
      fakeMembership({ organizationId: ACME, userId: SECOND_USER, role: 'admin' })
    )
    await user.click(button('Cancel'))
    await waitFor(() => expect(openDialogs()).toBe(0))
    await user.click(screen.getByRole('button', { name: 'Delete user' }))
    await user.click(button('Delete user'))
    await waitFor(() => expect(api.state.users.some((entry) => entry.id === IDS.user)).toBe(false))
    expect(api.state.memberships.some((entry) => entry.userId === IDS.user)).toBe(false)
  })
})

describe('domains', () => {
  const claim = (overrides: Partial<FakeDomain> = {}) => ({
    organizationId: ACME,
    ...overrides,
  })
  const domainsOf = (api: FakeApi) => api.state.domains

  async function openClaimDialog(user: World['user']) {
    await user.click(await screen.findByRole('button', { name: 'Claim a domain' }))
  }

  test('lists the claims: a verified one and one that is waiting for its code and grants nothing', async () => {
    start(`${DEV_PATH}/organizations/${ACME}`, {
      api: arranged({
        organizations: [acme],
        domains: [
          claim({ domain: 'acme.com', mode: 'auto_join' }),
          claim({ domain: 'acme.io', verifiedAt: null }),
        ],
      }),
    })
    const table = await screen.findByRole('table', { name: 'Domains of Acme Corp' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(within(rows[0] as HTMLElement).getByText('acme.com')).toBeTruthy()
    expect(rows[0]?.textContent).toContain('Verified')
    expect(rows[0]?.textContent).toContain('Join automatically')
    expect(rows[1]?.textContent).toContain('Waiting for the code')
    expect(rows[1]?.textContent).toContain('grants nothing yet')
  })

  test('a lapsed domain says it needs re-verification and that it matches nobody; a current one says until when', async () => {
    start(`${DEV_PATH}/organizations/${ACME}`, {
      api: arranged({
        organizations: [acme],
        domains: [
          claim({ domain: 'acme.com' }),
          claim({
            domain: 'old.acme.com',
            mode: 'auto_join',
            verifiedAt: '2025-09-01T12:00:00.000Z',
            expiresAt: '2026-09-01T12:00:00.000Z',
          }),
        ],
      }),
    })
    const table = await screen.findByRole('table', { name: 'Domains of Acme Corp' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows[0]?.textContent).toContain('Valid until')
    expect(rows[0]?.textContent).not.toContain('Needs re-verification')
    expect(rows[1]?.textContent).toContain('Needs re-verification')
    expect(rows[1]?.textContent).toContain('joins nobody until you enter a new code')
    // A lapsed domain offers a new code, not a mode switch.
    expect(within(rows[1] as HTMLElement).queryByText('Only suggest')).toBeNull()
    expect(
      within(rows[1] as HTMLElement).getByRole('button', {
        name: 'Send a new code for old.acme.com',
      })
    ).toBeTruthy()
  })

  test('a new code re-verifies a lapsed domain through the claim path, keeping its mode', async () => {
    const { user, api } = start(`${DEV_PATH}/organizations/${ACME}`, {
      api: arranged({
        organizations: [acme],
        domains: [
          claim({
            domain: 'acme.com',
            mode: 'auto_join',
            verifiedAt: '2025-09-01T12:00:00.000Z',
            expiresAt: '2026-09-01T12:00:00.000Z',
          }),
        ],
      }),
    })
    await user.click(await screen.findByRole('button', { name: 'Send a new code for acme.com' }))
    // No mode is asked and no weakening is confirmed: nothing about the mode changes.
    // The mode that comes back with the domain is said, since it is not asked.
    expect(dialog().textContent).toContain('join automatically')
    expect(within(dialog()).queryByLabelText('When someone verified signs up on it')).toBeNull()
    await user.type(within(dialog()).getByLabelText('Address on that domain'), 'admin@acme.com')
    await user.click(button('Send code'))
    await screen.findByRole('heading', { name: 'Verify acme.com' })
    expect(sent(api, 'POST', `/v1/admin/organizations/${ACME}/domains`)[0]?.body).toEqual({
      domain: 'acme.com',
      email: 'admin@acme.com',
      mode: 'auto_join',
    })
    // Still lapsed until the code is entered.
    expect(domainsOf(api)[0]?.expiresAt).toBe('2026-09-01T12:00:00.000Z')
    await user.type(within(dialog()).getByLabelText('Code'), FAKE_DOMAIN_CODE)
    await user.click(button('Verify domain'))
    await screen.findByText('Domain verified')
    await waitFor(() => expect(openDialogs()).toBe(0))
    const table = screen.getByRole('table', { name: 'Domains of Acme Corp' })
    await waitFor(() => expect(table.textContent).not.toContain('Needs re-verification'))
    expect(table.textContent).toContain('Valid until')
    expect(domainsOf(api)[0]?.mode).toBe('auto_join')
  })

  test('a current domain is proved again without a question, keeps its mode, and a code in flight can be entered', async () => {
    const { user, api } = start(`${DEV_PATH}/organizations/${ACME}`, {
      api: arranged({
        organizations: [acme],
        domains: [
          claim({
            domain: 'acme.com',
            mode: 'auto_join',
            expiresAt: '2026-11-01T12:00:00.000Z',
          }),
          claim({
            domain: 'acme.io',
            codeExpiresAt: '2026-10-24T12:00:00.000Z',
          }),
        ],
      }),
    })
    const table = await screen.findByRole('table', { name: 'Domains of Acme Corp' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows[0]?.textContent).toContain('Send a new code before then')
    expect(
      within(rows[0] as HTMLElement).queryByRole('button', { name: /Enter the code/ })
    ).toBeNull()
    expect(
      within(rows[1] as HTMLElement).getByRole('button', { name: 'Enter the code for acme.io' })
    ).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Send a new code for acme.com' }))
    await user.type(within(dialog()).getByLabelText('Address on that domain'), 'admin@acme.com')
    await user.click(button('Send code'))
    // No weakening question: the dialog goes straight to the code.
    await screen.findByRole('heading', { name: 'Verify acme.com' })
    expect(sent(api, 'POST', `/v1/admin/organizations/${ACME}/domains`)[0]?.body).toMatchObject({
      mode: 'auto_join',
    })
  })

  test('with none it says so', async () => {
    start(`${DEV_PATH}/organizations/${ACME}`, { api: arranged({ organizations: [acme] }) })
    await screen.findByText('No domains claimed')
  })

  test('a claim sends the code, then the code verifies the domain', async () => {
    const { user, api } = start(`${DEV_PATH}/organizations/${ACME}`, {
      api: arranged({ organizations: [acme] }),
    })
    await openClaimDialog(user)
    await user.click(button('Send code'))
    await waitFor(() => expect(alerts()).toHaveLength(2))
    await user.type(within(dialog()).getByLabelText('Domain'), 'acme.com')
    await user.type(within(dialog()).getByLabelText('Address on that domain'), 'admin@acme.com')
    await user.click(button('Send code'))
    await screen.findByRole('heading', { name: 'Verify acme.com' })
    expect(sent(api, 'POST', `/v1/admin/organizations/${ACME}/domains`)[0]?.body).toEqual({
      domain: 'acme.com',
      email: 'admin@acme.com',
      mode: 'suggest',
    })
    // A wrong code is said, and the form stays.
    await user.type(within(dialog()).getByLabelText('Code'), '000000')
    await user.click(button('Verify domain'))
    await waitFor(() => expect(alerts()[0]).toMatch(/not right/))
    await user.clear(within(dialog()).getByLabelText('Code'))
    await user.type(within(dialog()).getByLabelText('Code'), FAKE_DOMAIN_CODE)
    await user.click(button('Verify domain'))
    await screen.findByText('Domain verified')
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(domainsOf(api)[0]?.verifiedAt).not.toBeNull()
    expect(screen.getByRole('table', { name: 'Domains of Acme Corp' }).textContent).toContain(
      'Verified'
    )
  })

  test('a code that is not six digits is refused before anything is sent', async () => {
    const { user, api } = start(`${DEV_PATH}/organizations/${ACME}`, {
      api: arranged({ organizations: [acme], domains: [claim({ verifiedAt: null })] }),
    })
    await user.click(await screen.findByRole('button', { name: 'Enter the code for acme.com' }))
    await user.type(within(dialog()).getByLabelText('Code'), '12')
    await user.click(button('Verify domain'))
    await waitFor(() => expect(alerts()).toEqual(['Enter the six digits from the email.']))
    expect(sent(api, 'POST', `/v1/admin/organizations/${ACME}/domains/`)).toHaveLength(0)
  })

  test.each([
    ['a public mail domain', 'gmail.com', 'admin@gmail.com', /public email domain/],
    ['an address on another domain', 'acme.com', 'admin@mail.acme.com', /exactly that domain/],
  ])('%s is refused in words', async (_name, domain, email, message) => {
    const { user } = start(`${DEV_PATH}/organizations/${ACME}`, {
      api: arranged({ organizations: [acme] }),
    })
    await openClaimDialog(user)
    await user.type(within(dialog()).getByLabelText('Domain'), domain)
    await user.type(within(dialog()).getByLabelText('Address on that domain'), email)
    await user.click(button('Send code'))
    await waitFor(() => expect(alerts()[0]).toMatch(message))
  })

  test('a domain verified for another organization is refused, and the cap is said', async () => {
    const { user } = start(`${DEV_PATH}/organizations/${ACME}`, {
      api: arranged({
        organizations: [acme, globex],
        domains: [{ organizationId: GLOBEX, domain: 'acme.com' }],
      }),
    })
    await openClaimDialog(user)
    await user.type(within(dialog()).getByLabelText('Domain'), 'acme.com')
    await user.type(within(dialog()).getByLabelText('Address on that domain'), 'admin@acme.com')
    await user.click(button('Send code'))
    await waitFor(() => expect(alerts()[0]).toMatch(/verified for an organization of this/))
    world?.api.override('POST', /domains$/, () =>
      failure(409, 'organization.domain_limit', 'Full.', undefined, { max: 10 })
    )
    await user.click(button('Send code'))
    await waitFor(() => expect(alerts()[0]).toMatch(/most domains it can have \(10\)/))
  })

  test('claiming to join people automatically asks first, and sends nothing until answered', async () => {
    const { user, api } = start(`${DEV_PATH}/organizations/${ACME}`, {
      api: arranged({ organizations: [acme] }),
    })
    await openClaimDialog(user)
    await user.type(within(dialog()).getByLabelText('Domain'), 'acme.com')
    await user.type(within(dialog()).getByLabelText('Address on that domain'), 'admin@acme.com')
    await user.selectOptions(
      within(dialog()).getByLabelText('When someone verified signs up on it'),
      'auto_join'
    )
    await user.click(button('Send code'))
    expect(await within(dialog()).findByTestId('weakening')).toBeTruthy()
    expect(within(dialog()).getByRole('heading').textContent).toBe('Join people automatically?')
    expect(dialog().textContent).toContain('becomes a member of Acme Corp straight away')
    expect(sent(api, 'POST', `/v1/admin/organizations/${ACME}/domains`)).toHaveLength(0)
    // Going back keeps what was typed.
    await user.click(button('Cancel'))
    expect((within(dialog()).getByLabelText('Domain') as HTMLInputElement).value).toBe('acme.com')
    await user.click(button('Send code'))
    await user.click(button('Send the code'))
    await screen.findByRole('heading', { name: 'Verify acme.com' })
    expect(sent(api, 'POST', `/v1/admin/organizations/${ACME}/domains`)[0]?.body).toMatchObject({
      mode: 'auto_join',
    })
  })

  test('a new code can be sent for a claim that is waiting', async () => {
    const { user, api } = start(`${DEV_PATH}/organizations/${ACME}`, {
      api: arranged({ organizations: [acme], domains: [claim({ verifiedAt: null })] }),
    })
    await user.click(await screen.findByRole('button', { name: 'Enter the code for acme.com' }))
    await user.click(button('Send a new code'))
    expect((within(dialog()).getByLabelText('Domain') as HTMLInputElement).readOnly).toBe(true)
    await user.type(within(dialog()).getByLabelText('Address on that domain'), 'admin@acme.com')
    await user.click(button('Send code'))
    await screen.findByRole('heading', { name: 'Verify acme.com' })
    expect(domainsOf(api)).toHaveLength(1)
  })

  test('switching a verified domain to joining automatically asks first; switching back does not', async () => {
    const { user, api } = start(`${DEV_PATH}/organizations/${ACME}`, {
      api: arranged({ organizations: [acme], domains: [claim()] }),
    })
    await user.click(
      await screen.findByRole('button', { name: 'Join people automatically on acme.com' })
    )
    expect(within(dialog()).getByRole('heading').textContent).toBe(
      'Join people automatically on acme.com?'
    )
    expect(dialog().textContent).toContain('no invitation')
    expect(sent(api, 'PATCH', `/v1/admin/organizations/${ACME}/domains/`)).toHaveLength(0)
    await user.click(button('Cancel'))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(domainsOf(api)[0]?.mode).toBe('suggest')

    await user.click(screen.getByRole('button', { name: 'Join people automatically on acme.com' }))
    await user.click(button('Join automatically'))
    await screen.findByText('Domain changed')
    expect(domainsOf(api)[0]?.mode).toBe('auto_join')
    expect(sent(api, 'PATCH', `/v1/admin/organizations/${ACME}/domains/`)[0]?.body).toEqual({
      mode: 'auto_join',
    })

    await user.click(
      screen.getByRole('button', { name: 'Only suggest the organization on acme.com' })
    )
    await waitFor(() => expect(domainsOf(api)[0]?.mode).toBe('suggest'))
    expect(openDialogs()).toBe(0)
  })

  test('removing a domain names it and says the members stay', async () => {
    const { user, api } = start(`${DEV_PATH}/organizations/${ACME}`, {
      api: arranged({ organizations: [acme], domains: [claim()] }),
    })
    await user.click(await screen.findByRole('button', { name: 'Remove the domain acme.com' }))
    expect(within(dialog()).getByRole('heading').textContent).toBe('Remove the domain acme.com?')
    expect(dialog().textContent).toContain('Members who already joined stay members')
    await user.click(button('Remove domain'))
    await screen.findByText('Domain removed')
    await screen.findByText('No domains claimed')
    expect(domainsOf(api)).toHaveLength(0)
  })

  test('in production the domain is typed to remove it or to join people automatically', async () => {
    const api = arranged({
      organizations: [{ ...acme, environmentId: IDS.production }],
      domains: [claim({ environmentId: IDS.production })],
    })
    const { user } = start(`${PROD_PATH}/organizations/${ACME}`, { api })
    await user.click(await screen.findByRole('button', { name: 'Remove the domain acme.com' }))
    await user.click(button('Remove domain'))
    expect(sent(api, 'DELETE', `/v1/admin/organizations/${ACME}/domains/`)).toHaveLength(0)
    await user.type(within(dialog()).getByLabelText(/Type .* to confirm/), 'acme.com')
    await user.click(button('Remove domain'))
    await waitFor(() =>
      expect(sent(api, 'DELETE', `/v1/admin/organizations/${ACME}/domains/`)).toHaveLength(1)
    )
  })

  test('a removal, held while the list is read again, is sent once', async () => {
    const api = arranged({ organizations: [acme], domains: [claim()] })
    const { user } = start(`${DEV_PATH}/organizations/${ACME}`, { api })
    await user.click(await screen.findByRole('button', { name: 'Remove the domain acme.com' }))
    const held = holdAnswers(
      (path, _headers, method) => method === 'GET' && path.endsWith('/domains')
    )
    await user.click(button('Remove domain'))
    await waitFor(() =>
      expect(sent(api, 'DELETE', `/v1/admin/organizations/${ACME}/domains/`)).toHaveLength(1)
    )
    await waitFor(() => expect(held.held()).toBeGreaterThan(0))
    await user.click(button('Remove domain'))
    await held.release()
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(sent(api, 'DELETE', `/v1/admin/organizations/${ACME}/domains/`)).toHaveLength(1)
  })

  test('a code, held while the list is read again, is verified once', async () => {
    const api = arranged({ organizations: [acme], domains: [claim({ verifiedAt: null })] })
    const { user } = start(`${DEV_PATH}/organizations/${ACME}`, { api })
    await user.click(await screen.findByRole('button', { name: 'Enter the code for acme.com' }))
    await user.type(within(dialog()).getByLabelText('Code'), FAKE_DOMAIN_CODE)
    const held = holdAnswers(
      (path, _headers, method) => method === 'GET' && path.endsWith('/domains')
    )
    await user.click(button('Verify domain'))
    await waitFor(() =>
      expect(sent(api, 'POST', `/v1/admin/organizations/${ACME}/domains/`)).toHaveLength(1)
    )
    await waitFor(() => expect(held.held()).toBeGreaterThan(0))
    await user.click(button('Verify domain'))
    await held.release()
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(sent(api, 'POST', `/v1/admin/organizations/${ACME}/domains/`)).toHaveLength(1)
  })

  test('an organization name nobody can see is written out wherever the dialogs and tables say it', async () => {
    const odd = 'Acme\u{A0}Corp'
    const written = 'Acme\\u{A0}Corp'
    const { user } = start(`${DEV_PATH}/organizations/${ACME}`, {
      api: arranged({
        organizations: [{ ...acme, name: odd }],
        memberships: [{ organizationId: ACME, userId: IDS.user, role: 'admin' }],
        domains: [claim()],
      }),
    })
    await screen.findByRole('table', { name: `Domains of ${written}` })
    expect(screen.getByRole('table', { name: `Members of ${written}` })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Join people automatically on acme.com' }))
    expect(dialog().textContent).toContain(`becomes a member of ${written}`)
    expect(dialog().textContent).not.toContain(odd)
    await user.click(button('Cancel'))
    await waitFor(() => expect(openDialogs()).toBe(0))
    await user.click(screen.getByRole('button', { name: 'Remove the domain acme.com' }))
    expect(dialog().textContent).toContain(`${written} stops suggesting`)
  })
})
