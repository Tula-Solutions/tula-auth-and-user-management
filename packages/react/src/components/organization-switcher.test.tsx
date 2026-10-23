import { afterEach, describe, expect, mock, test } from 'bun:test'
import { act, screen, waitFor, within } from '@testing-library/react'
import { deferred } from '../../../core/src/testing/fakes'
import { expectAbsent, expectFocus, failure, json, openDialogs, world } from '../testing/harness'
import {
  A,
  ACME,
  activated,
  B,
  C,
  GLOBEX,
  ORG_ROUTE,
  ORGS_ON,
  organization,
  orgWorld,
  page,
} from '../testing/organizations'
import { OrganizationSwitcher } from './organization-switcher'

afterEach(() => {
  mock.restore()
})

const TRIGGER = 'Organization: Acme'

async function open(w: ReturnType<typeof orgWorld>, name = TRIGGER) {
  const trigger = await screen.findByRole('button', { name })
  await w.user.click(trigger)
  return trigger
}

describe('<OrganizationSwitcher>', () => {
  test('renders nothing while signed out', async () => {
    const w = world({ organizations: ORGS_ON })
    w.mount(<OrganizationSwitcher />)
    await waitFor(() => expect(w.client.state.status).toBe('signed-out'))
    expectAbsent(screen.queryByRole('button'))
  })

  test.each([
    ['organizations are off', { enabled: false, allowUserCreated: true, personalAccount: true }],
    ['the server says nothing about them', undefined],
  ])('renders nothing when %s', async (_name, organizations) => {
    const w = world({ signedIn: true, organizations })
    w.mount(<OrganizationSwitcher />)
    await waitFor(() => expect(w.client.state.status).toBe('signed-in'))
    await waitFor(() => expect(w.api.calls('GET /v1/client/config').length).toBeGreaterThan(0))
    expectAbsent(screen.queryByRole('button'))
  })

  test('the trigger names the active organization and announces a disclosure', async () => {
    const w = orgWorld()
    w.mount(<OrganizationSwitcher />)
    const trigger = await screen.findByRole('button', { name: TRIGGER })
    expect(trigger.textContent).toContain('Acme')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expectAbsent(screen.queryByRole('group', { name: 'Organizations' }))
  })

  test('with no active organization the trigger says personal account', async () => {
    const w = orgWorld({ active: null })
    w.mount(<OrganizationSwitcher />)
    expect(
      await screen.findByRole('button', { name: 'Organization: Personal account' })
    ).toBeTruthy()
  })

  test('opening moves the focus into the panel; the list marks the current choice in words', async () => {
    const w = orgWorld()
    w.mount(<OrganizationSwitcher />)
    const trigger = await open(w)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const panel = await screen.findByRole('group', { name: 'Organizations' })
    expect(trigger.getAttribute('aria-controls')).toBe(panel.id)
    const items = await within(panel).findAllByRole('button')
    expect(items.map((item) => item.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Personal account',
      'Acme (current)',
      'Globex',
      'Manage organization',
      'Create organization',
    ])
    const current = screen.getByRole('button', { name: /^Acme/ })
    expect(current.getAttribute('aria-current')).toBe('true')
    expectAbsent(document.querySelector('[aria-current]:not([aria-current="true"])'))
    await expectFocus(items[0] as HTMLElement)
  })

  test('Escape closes the panel and returns the focus; so do a click and a focus move outside', async () => {
    const w = orgWorld()
    w.mount(
      <>
        <OrganizationSwitcher />
        <button type='button'>elsewhere</button>
      </>
    )
    const trigger = await open(w)
    await screen.findByRole('group', { name: 'Organizations' })
    await w.user.keyboard('{Escape}')
    expectAbsent(screen.queryByRole('group', { name: 'Organizations' }))
    await expectFocus(trigger)

    await w.user.click(trigger)
    await screen.findByRole('group', { name: 'Organizations' })
    await w.user.click(screen.getByRole('button', { name: 'elsewhere' }))
    expectAbsent(screen.queryByRole('group', { name: 'Organizations' }))

    await w.user.click(trigger)
    await screen.findByRole('group', { name: 'Organizations' })
    act(() => screen.getByRole('button', { name: 'elsewhere' }).focus())
    await waitFor(() => expectAbsent(screen.queryByRole('group', { name: 'Organizations' })))
  })

  test('choosing another organization switches the session, closes, announces and tells the app', async () => {
    const w = orgWorld()
    const onSwitch = mock()
    w.mount(<OrganizationSwitcher onSwitch={onSwitch} />)
    const trigger = await open(w)
    await w.user.click(await screen.findByRole('button', { name: 'Globex' }))
    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith(B))
    expect(w.api.calls(ORG_ROUTE.active)[0]?.body).toEqual({ organizationId: B })
    expectAbsent(screen.queryByRole('group', { name: 'Organizations' }))
    await expectFocus(trigger)
    expect(await screen.findByRole('status')).toBeTruthy()
    expect(screen.getByText('Now working in Globex.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Organization: Globex' })).toBeTruthy()
  })

  test('"Personal account" clears the active organization', async () => {
    const w = orgWorld()
    const onSwitch = mock()
    w.mount(<OrganizationSwitcher onSwitch={onSwitch} />)
    await open(w)
    await w.user.click(await screen.findByRole('button', { name: 'Personal account' }))
    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith(null))
    expect(w.api.calls(ORG_ROUTE.active)[0]?.body).toEqual({ organizationId: null })
    expect(screen.getByText('Now using your personal account.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Organization: Personal account' })).toBeTruthy()
  })

  test('choosing the current organization only closes the panel', async () => {
    const w = orgWorld()
    const onSwitch = mock()
    w.mount(<OrganizationSwitcher onSwitch={onSwitch} />)
    const trigger = await open(w)
    await w.user.click(await screen.findByRole('button', { name: /^Acme/ }))
    expectAbsent(screen.queryByRole('group', { name: 'Organizations' }))
    await expectFocus(trigger)
    expect(w.api.calls(ORG_ROUTE.active)).toHaveLength(0)
    expect(onSwitch).not.toHaveBeenCalled()
  })

  test('without a personal account the choice is not offered', async () => {
    const w = orgWorld({ config: { ...ORGS_ON, personalAccount: false } })
    w.mount(<OrganizationSwitcher />)
    await open(w)
    await screen.findByRole('button', { name: 'Globex' })
    expectAbsent(screen.queryByRole('button', { name: 'Personal account' }))
  })

  test('a refused switch is announced in the panel, which stays open', async () => {
    const w = orgWorld()
    const onSwitch = mock()
    w.api.on(ORG_ROUTE.active, () => failure(403, 'organization.not_a_member'))
    w.mount(<OrganizationSwitcher onSwitch={onSwitch} />)
    await open(w)
    await w.user.click(await screen.findByRole('button', { name: 'Globex' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('You are not a member of that organization.')
    expect(screen.getByRole('group', { name: 'Organizations' })).toBeTruthy()
    expect(onSwitch).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: TRIGGER })).toBeTruthy()
  })

  test('a list that could not be fetched is said, and "Try again" fetches it', async () => {
    const w = orgWorld()
    let attempts = 0
    w.api.on(ORG_ROUTE.list, () => {
      attempts += 1
      return attempts === 1 ? failure(503, 'service.unavailable') : page([ACME, GLOBEX], A)
    })
    w.mount(<OrganizationSwitcher />)
    await open(w, 'Organization: Organization')
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBeTruthy()
    await w.user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('button', { name: 'Globex' })).toBeTruthy()
    expectAbsent(screen.queryByRole('alert'))
  })

  test('while the list is on its way the panel says so', async () => {
    const w = orgWorld()
    const held = deferred<Response>()
    w.api.on(ORG_ROUTE.list, () => held.promise)
    w.mount(<OrganizationSwitcher />)
    await open(w, 'Organization: Organization')
    expect(await screen.findByText('Loading your organizations…')).toBeTruthy()
    await act(async () => held.resolve(page([ACME, GLOBEX], A)))
    // The focus moves into the panel once the list is there.
    const first = await screen.findByRole('button', { name: 'Personal account' })
    await expectFocus(first)
  })

  test('a user in no organization is told so and can create one', async () => {
    const w = orgWorld({ active: null, organizations: [] })
    w.mount(<OrganizationSwitcher />)
    await open(w, 'Organization: Personal account')
    expect(await screen.findByText('You are not a member of any organization yet.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Create organization' })).toBeTruthy()
    expectAbsent(screen.queryByRole('button', { name: 'Manage organization' }))
  })

  test('"Create organization" is left out where users may not create them', async () => {
    const w = orgWorld({ config: { ...ORGS_ON, allowUserCreated: false } })
    w.mount(<OrganizationSwitcher />)
    await open(w)
    await screen.findByRole('button', { name: 'Globex' })
    expectAbsent(screen.queryByRole('button', { name: 'Create organization' }))
    expect(screen.getByRole('button', { name: 'Manage organization' })).toBeTruthy()
  })

  describe('suggestions', () => {
    test('organizations the user may join are listed; joining reads the list again and does not switch', async () => {
      const w = orgWorld({ organizations: [ACME] })
      w.api.on(ORG_ROUTE.suggestions, () =>
        json(200, { data: [{ id: B, name: 'Globex', slug: 'globex' }] })
      )
      w.api.on(ORG_ROUTE.join(B), () => {
        w.organizations.push(GLOBEX)
        return json(201, GLOBEX)
      })
      w.mount(<OrganizationSwitcher />)
      await open(w)
      expect(await screen.findByText('You can join')).toBeTruthy()
      await w.user.click(screen.getByRole('button', { name: 'Join Globex' }))
      await waitFor(() => expectAbsent(screen.queryByRole('button', { name: 'Join Globex' })))
      expect(screen.getByText('You joined Globex.')).toBeTruthy()
      expect(await screen.findByRole('button', { name: 'Globex' })).toBeTruthy()
      expect(w.api.calls(ORG_ROUTE.active)).toHaveLength(0)
    })

    test('a suggestion the server now refuses is said', async () => {
      const w = orgWorld({ organizations: [ACME] })
      w.api.on(ORG_ROUTE.suggestions, () =>
        json(200, { data: [{ id: B, name: 'Globex', slug: 'globex' }] })
      )
      w.api.on(ORG_ROUTE.join(B), () => failure(403, 'organization.suggestion_unavailable'))
      w.mount(<OrganizationSwitcher />)
      await open(w)
      await w.user.click(await screen.findByRole('button', { name: 'Join Globex' }))
      expect((await screen.findByRole('alert')).textContent).toBe(
        'You cannot join that organization.'
      )
      expect(screen.getByRole('button', { name: 'Join Globex' })).toBeTruthy()
    })

    test('suggestions that could not be fetched are said', async () => {
      const w = orgWorld()
      w.api.on(ORG_ROUTE.suggestions, () => failure(503, 'service.unavailable'))
      w.mount(<OrganizationSwitcher />)
      await open(w)
      expect(await screen.findByRole('alert')).toBeTruthy()
      // The user's own organizations are still there.
      expect(screen.getByRole('button', { name: 'Globex' })).toBeTruthy()
    })
  })

  describe('an invitation handed over by the app', () => {
    const PREVIEW = {
      organizationName: 'Initech',
      role: 'member',
      email: 'maya@northline.app',
      expiresAt: '2030-02-01T00:00:00.000Z',
    }

    test('is shown on the trigger and in the panel; accepting joins, reads the list and tells the app', async () => {
      const w = orgWorld()
      const onHandled = mock()
      w.api.on(ORG_ROUTE.previewInvitation, () => json(200, PREVIEW))
      w.api.on(ORG_ROUTE.acceptInvitation, () => {
        w.organizations.push(organization(C, 'Initech', 'member', []))
        return json(200, organization(C, 'Initech', 'member', []))
      })
      w.mount(<OrganizationSwitcher invitationToken='tok_1' onInvitationHandled={onHandled} />)
      const trigger = await screen.findByRole('button', {
        name: 'Organization: Acme. You have an invitation.',
      })
      expect(trigger.textContent).toContain('Invitation')
      await w.user.click(trigger)
      expect(await screen.findByText('Initech invited you to join as member.')).toBeTruthy()
      expect(w.api.calls(ORG_ROUTE.previewInvitation)[0]?.body).toEqual({ token: 'tok_1' })
      await w.user.click(screen.getByRole('button', { name: 'Accept' }))
      await waitFor(() => expect(onHandled).toHaveBeenCalledWith('accepted'))
      expect(w.api.calls(ORG_ROUTE.acceptInvitation)[0]?.body).toEqual({ token: 'tok_1' })
      expect(await screen.findByRole('button', { name: 'Initech' })).toBeTruthy()
      expect(screen.getByText('You joined Initech.')).toBeTruthy()
      expectAbsent(screen.queryByRole('button', { name: 'Accept' }))
    })

    test('declining says so and tells the app', async () => {
      const w = orgWorld()
      const onHandled = mock()
      w.api.on(ORG_ROUTE.previewInvitation, () => json(200, PREVIEW))
      w.api.on(ORG_ROUTE.declineInvitation, () => new Response(null, { status: 204 }))
      w.mount(<OrganizationSwitcher invitationToken='tok_1' onInvitationHandled={onHandled} />)
      await w.user.click(
        await screen.findByRole('button', { name: 'Organization: Acme. You have an invitation.' })
      )
      await w.user.click(await screen.findByRole('button', { name: 'Decline' }))
      await waitFor(() => expect(onHandled).toHaveBeenCalledWith('declined'))
      expect(screen.getByText('Invitation declined.')).toBeTruthy()
    })

    test.each([
      ['organization.invitation_expired', 'This invitation has expired.'],
      ['organization.invitation_used', 'This invitation was already used.'],
    ])('an invitation that cannot be shown (%s) is said in the panel', async (code, message) => {
      const w = orgWorld()
      w.api.on(ORG_ROUTE.previewInvitation, () => failure(410, code))
      w.mount(<OrganizationSwitcher invitationToken='tok_1' />)
      await open(w)
      expect((await screen.findByRole('alert')).textContent).toBe(message)
      expectAbsent(screen.queryByRole('button', { name: 'Accept' }))
    })

    test('an answer the server refuses (another account) is announced and the choice stays', async () => {
      const w = orgWorld()
      const onHandled = mock()
      w.api.on(ORG_ROUTE.previewInvitation, () => json(200, PREVIEW))
      w.api.on(ORG_ROUTE.acceptInvitation, () =>
        failure(403, 'organization.invitation_wrong_account')
      )
      w.mount(<OrganizationSwitcher invitationToken='tok_1' onInvitationHandled={onHandled} />)
      await w.user.click(
        await screen.findByRole('button', { name: 'Organization: Acme. You have an invitation.' })
      )
      await w.user.click(await screen.findByRole('button', { name: 'Accept' }))
      expect((await screen.findByRole('alert')).textContent).toBe(
        'This invitation was sent to another email address.'
      )
      expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy()
      expect(onHandled).not.toHaveBeenCalled()
    })

    test('no token, no request', async () => {
      const w = orgWorld()
      w.mount(<OrganizationSwitcher />)
      await open(w)
      await screen.findByRole('button', { name: 'Globex' })
      expect(w.api.calls(ORG_ROUTE.previewInvitation)).toHaveLength(0)
    })
  })

  describe('manage and create', () => {
    test('"Manage organization" opens the profile in a dialog; closing it returns the focus', async () => {
      const w = orgWorld()
      w.api.on(ORG_ROUTE.roles(A), () => json(200, { data: [] }))
      w.mount(<OrganizationSwitcher />)
      const trigger = await open(w)
      await w.user.click(await screen.findByRole('button', { name: 'Manage organization' }))
      const dialog = await screen.findByRole('dialog', { name: 'Organization' })
      expect((dialog as HTMLDialogElement).open).toBe(true)
      expectAbsent(screen.queryByRole('group', { name: 'Organizations' }))
      expect(await within(dialog).findByRole('tablist')).toBeTruthy()
      await w.user.click(screen.getByRole('button', { name: 'Close' }))
      await waitFor(() => expect(openDialogs()).toBe(0))
      await expectFocus(trigger)
    })

    test('with a profile page it navigates instead', async () => {
      const w = orgWorld()
      const navigate = mock()
      w.mount(<OrganizationSwitcher organizationProfileUrl='/org' />, { navigate })
      await open(w)
      await w.user.click(await screen.findByRole('button', { name: 'Manage organization' }))
      expect(navigate).toHaveBeenCalledWith('/org')
      expectAbsent(screen.queryByRole('dialog'))
    })

    test('"Create organization" opens the form in a dialog; Cancel returns the focus', async () => {
      const w = orgWorld()
      w.mount(<OrganizationSwitcher />)
      const trigger = await open(w)
      await w.user.click(await screen.findByRole('button', { name: 'Create organization' }))
      const dialog = await screen.findByRole('dialog', { name: 'Create an organization' })
      expect(await within(dialog).findByLabelText('Name')).toBeTruthy()
      await w.user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
      await waitFor(() => expect(openDialogs()).toBe(0))
      await expectFocus(trigger)
    })

    test('an organization created in the dialog closes it, switches and tells the app', async () => {
      const w = orgWorld()
      const onSwitch = mock()
      w.api.on(ORG_ROUTE.create, () => json(201, organization(C, 'Initech', 'admin', [])))
      w.api.on(ORG_ROUTE.active, () => activated(C))
      w.mount(<OrganizationSwitcher onSwitch={onSwitch} />)
      await open(w)
      await w.user.click(await screen.findByRole('button', { name: 'Create organization' }))
      const dialog = await screen.findByRole('dialog', { name: 'Create an organization' })
      await w.user.type(await within(dialog).findByLabelText('Name'), 'Initech')
      await w.user.click(within(dialog).getByRole('button', { name: 'Create organization' }))
      await waitFor(() => expect(onSwitch).toHaveBeenCalledWith(C))
      await waitFor(() => expect(openDialogs()).toBe(0))
      expect(
        screen.getByText('Initech was created and is now the active organization.')
      ).toBeTruthy()
    })

    test('with a creation page it navigates instead', async () => {
      const w = orgWorld()
      const navigate = mock()
      w.mount(<OrganizationSwitcher createOrganizationUrl='/new-org' />, { navigate })
      await open(w)
      await w.user.click(await screen.findByRole('button', { name: 'Create organization' }))
      expect(navigate).toHaveBeenCalledWith('/new-org')
    })

    test('the provider’s destinations are used when the component names none', async () => {
      const w = orgWorld()
      const navigate = mock()
      w.mount(<OrganizationSwitcher />, {
        navigate,
        organizationProfileUrl: '/p-org',
        createOrganizationUrl: '/p-new',
      })
      await open(w)
      await w.user.click(await screen.findByRole('button', { name: 'Manage organization' }))
      expect(navigate).toHaveBeenLastCalledWith('/p-org')
      await w.user.click(await screen.findByRole('button', { name: TRIGGER }))
      await w.user.click(await screen.findByRole('button', { name: 'Create organization' }))
      expect(navigate).toHaveBeenLastCalledWith('/p-new')
    })
  })

  test('a switch that finishes after the session ended is neither announced nor passed on', async () => {
    const w = orgWorld()
    const onSwitch = mock()
    const held = deferred<Response>()
    w.api.on(ORG_ROUTE.active, () => held.promise)
    w.mount(<OrganizationSwitcher onSwitch={onSwitch} />)
    await open(w)
    await w.user.click(await screen.findByRole('button', { name: 'Globex' }))
    await waitFor(() => expect(w.api.calls(ORG_ROUTE.active)).toHaveLength(1))
    await act(async () => {
      await w.client.session.signOut()
    })
    await act(async () => held.resolve(activated(B)))
    expect(onSwitch).not.toHaveBeenCalled()
    expectAbsent(screen.queryByText('Now working in Globex.'))
  })

  test('a second choice while one is being sent is ignored', async () => {
    const w = orgWorld()
    const held = deferred<Response>()
    w.api.on(ORG_ROUTE.active, () => held.promise)
    w.mount(<OrganizationSwitcher />)
    await open(w)
    await w.user.click(await screen.findByRole('button', { name: 'Globex' }))
    await w.user.click(screen.getByRole('button', { name: 'Personal account' }))
    expect(w.api.calls(ORG_ROUTE.active)).toHaveLength(1)
    await act(async () => held.resolve(activated(B)))
  })
})
