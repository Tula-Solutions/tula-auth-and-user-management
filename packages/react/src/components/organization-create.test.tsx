import { afterEach, describe, expect, mock, test } from 'bun:test'
import { act, screen, waitFor } from '@testing-library/react'
import { deferred } from '../../../core/src/testing/fakes'
import { expectAbsent, expectFocus, failure, json, world } from '../testing/harness'
import {
  A,
  activated,
  B,
  ORG_ROUTE,
  ORGS_ON,
  organization,
  orgWorld,
} from '../testing/organizations'
import { CreateOrganization } from './organization-create'

afterEach(() => {
  mock.restore()
})

const NEW_ORG = organization(B, 'Globex', 'admin', ['org:sys:memberships:manage'])

async function fill(w: ReturnType<typeof orgWorld>, name: string, slug?: string) {
  await w.user.type(await screen.findByLabelText('Name'), name)
  if (slug !== undefined) {
    const field = screen.getByLabelText('Short name')
    await w.user.clear(field)
    await w.user.type(field, slug)
  }
}

describe('<CreateOrganization>', () => {
  test('renders nothing while signed out', async () => {
    const w = world({ organizations: ORGS_ON })
    w.mount(<CreateOrganization />)
    await waitFor(() => expect(w.client.state.status).toBe('signed-out'))
    expectAbsent(screen.queryByRole('heading'))
  })

  test('says so where the environment does not let users create organizations', async () => {
    const w = orgWorld({ config: { ...ORGS_ON, allowUserCreated: false } })
    w.mount(<CreateOrganization />)
    expect(await screen.findByText('Creating organizations is not available here.')).toBeTruthy()
    expectAbsent(screen.queryByLabelText('Name'))
    expect(w.api.calls(ORG_ROUTE.create)).toHaveLength(0)
  })

  test.each([
    ['organizations are off', { enabled: false, allowUserCreated: true, personalAccount: true }],
    ['the server says nothing about them', undefined],
  ])('says so when %s', async (_name, organizations) => {
    const w = world({ signedIn: true, organizations })
    w.mount(<CreateOrganization />)
    expect(await screen.findByText('Creating organizations is not available here.')).toBeTruthy()
    expectAbsent(screen.queryByLabelText('Name'))
  })

  test('the short name follows the name until the user types their own', async () => {
    const w = orgWorld()
    w.mount(<CreateOrganization />)
    await w.user.type(await screen.findByLabelText('Name'), 'Globex Corp & Sons')
    const slug = screen.getByLabelText('Short name') as HTMLInputElement
    expect(slug.value).toBe('globex-corp-sons')
    await w.user.clear(slug)
    await w.user.type(slug, 'mine')
    await w.user.type(screen.getByLabelText('Name'), ' Ltd')
    expect(slug.value).toBe('mine')
    expect(screen.getByText(/Lower-case letters, digits and hyphens/)).toBeTruthy()
  })

  test('creates the organization, makes it the active one and says so, with the focus on the title', async () => {
    const w = orgWorld({ active: null })
    const onCreated = mock()
    w.api.on(ORG_ROUTE.create, () => json(201, NEW_ORG))
    w.api.on(ORG_ROUTE.active, () => activated(B))
    w.mount(<CreateOrganization onCreated={onCreated} />)
    await fill(w, 'Globex')
    await w.user.click(screen.getByRole('button', { name: 'Create organization' }))
    const title = await screen.findByRole('heading', { name: 'Organization created' })
    await expectFocus(title)
    expect(screen.getByText('Globex was created and is now the active organization.')).toBeTruthy()
    expect(w.api.calls(ORG_ROUTE.create)[0]?.body).toEqual({ name: 'Globex', slug: 'globex' })
    expect(w.api.calls(ORG_ROUTE.active)[0]?.body).toEqual({ organizationId: B })
    expect(w.client.state.status === 'signed-in' && w.client.state.organizationId).toBe(B)
    expect(onCreated).toHaveBeenCalledTimes(1)
    expect((onCreated.mock.calls[0]?.[0] as { id: string } | undefined)?.id).toBe(B)
    // The form is gone: a second submit could only answer "short name taken" for their own.
    expectAbsent(screen.queryByLabelText('Name'))
  })

  test('goes to afterCreateUrl instead of drawing the confirmation', async () => {
    const w = orgWorld({ active: null })
    const navigate = mock()
    w.api.on(ORG_ROUTE.create, () => json(201, NEW_ORG))
    w.mount(<CreateOrganization afterCreateUrl='/welcome' />, { navigate })
    await fill(w, 'Globex')
    await w.user.click(screen.getByRole('button', { name: 'Create organization' }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/welcome'))
    expectAbsent(screen.queryByRole('heading', { name: 'Organization created' }))
  })

  test('switchToNew={false} creates and does not switch', async () => {
    const w = orgWorld()
    w.api.on(ORG_ROUTE.create, () => json(201, NEW_ORG))
    w.mount(<CreateOrganization switchToNew={false} />)
    await fill(w, 'Globex')
    await w.user.click(screen.getByRole('button', { name: 'Create organization' }))
    expect(await screen.findByText('Globex was created.')).toBeTruthy()
    expect(w.api.calls(ORG_ROUTE.active)).toHaveLength(0)
  })

  test('a switch that failed is said: the organization exists, and the form is not offered again', async () => {
    const w = orgWorld({ active: null })
    w.api.on(ORG_ROUTE.create, () => json(201, NEW_ORG))
    w.api.on(ORG_ROUTE.active, () => failure(403, 'organization.not_a_member'))
    w.mount(<CreateOrganization />)
    await fill(w, 'Globex')
    await w.user.click(screen.getByRole('button', { name: 'Create organization' }))
    expect(
      await screen.findByText(
        'Globex was created, but switching to it failed. Choose it from the list.'
      )
    ).toBeTruthy()
    expectAbsent(screen.queryByLabelText('Name'))
  })

  test('an empty name or short name is said under the field, focus goes to the first, nothing is sent', async () => {
    const w = orgWorld()
    w.mount(<CreateOrganization />)
    const name = await screen.findByLabelText('Name')
    await w.user.click(screen.getByRole('button', { name: 'Create organization' }))
    expect((await screen.findAllByRole('alert')).map((alert) => alert.textContent)).toEqual([
      'Enter a name for the organization.',
      'Enter a short name.',
    ])
    await expectFocus(name)
    expect(name.getAttribute('aria-invalid')).toBe('true')
    expect(w.api.calls(ORG_ROUTE.create)).toHaveLength(0)
    // Typing clears the message of the field being fixed.
    await w.user.type(name, 'G')
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toEqual([
      'Enter a short name.',
    ])
  })

  test('a taken short name is announced under that field and focuses it', async () => {
    const w = orgWorld()
    w.api.on(ORG_ROUTE.create, () => failure(409, 'organization.slug_taken'))
    w.mount(<CreateOrganization />)
    await fill(w, 'Globex')
    await w.user.click(screen.getByRole('button', { name: 'Create organization' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('An organization with that slug already exists.')
    const slug = screen.getByLabelText('Short name')
    await expectFocus(slug)
    expect(slug.getAttribute('aria-describedby')?.split(' ')).toContain(alert.id)
  })

  test.each([
    ['organization.limit_reached', 'You have reached the number of organizations you can create.'],
    [
      'organization.creation_disabled',
      'Creating an organization is not allowed in this environment.',
    ],
  ])('%s is announced above the form', async (code, message) => {
    const w = orgWorld()
    w.api.on(ORG_ROUTE.create, () => failure(403, code))
    w.mount(<CreateOrganization />)
    await fill(w, 'Globex')
    await w.user.click(screen.getByRole('button', { name: 'Create organization' }))
    expect((await screen.findByRole('alert')).textContent).toBe(message)
  })

  test('a rate limit says when to try again, once', async () => {
    const w = orgWorld()
    w.api.on(ORG_ROUTE.create, () => failure(429, 'rate_limited', {}, { 'retry-after': '41' }))
    w.mount(<CreateOrganization />)
    await fill(w, 'Globex')
    await w.user.click(screen.getByRole('button', { name: 'Create organization' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/^Too many requests\. Try again in /)
    )
  })

  test('the button is pending while the request is in flight and ignores a second click', async () => {
    const w = orgWorld()
    const held = deferred<Response>()
    w.api.on(ORG_ROUTE.create, () => held.promise)
    w.mount(<CreateOrganization />)
    await fill(w, 'Globex')
    const button = screen.getByRole('button', { name: 'Create organization' })
    await w.user.click(button)
    await waitFor(() => expect(button.getAttribute('aria-busy')).toBe('true'))
    await w.user.click(button)
    expect(w.api.calls(ORG_ROUTE.create)).toHaveLength(1)
    held.resolve(failure(409, 'organization.slug_taken'))
    await screen.findByRole('alert')
  })

  test('an answer that arrives after the session ended is not shown or acted on', async () => {
    const w = orgWorld({ active: null })
    const held = deferred<Response>()
    const onCreated = mock()
    w.api.on(ORG_ROUTE.create, () => held.promise)
    w.mount(<CreateOrganization onCreated={onCreated} />)
    await fill(w, 'Globex')
    await w.user.click(screen.getByRole('button', { name: 'Create organization' }))
    await waitFor(() => expect(w.api.calls(ORG_ROUTE.create)).toHaveLength(1))
    await act(async () => {
      await w.client.session.signOut()
    })
    await act(async () => held.resolve(json(201, NEW_ORG)))
    await waitFor(() => expect(w.client.state.status).toBe('signed-out'))
    // Settled: nothing was switched and the caller was not told about a session that is gone.
    expect(w.api.calls(ORG_ROUTE.active)).toHaveLength(0)
    expect(onCreated).not.toHaveBeenCalled()
    expectAbsent(screen.queryByRole('heading', { name: 'Organization created' }))
  })

  test('the cancel button appears only where the host asks for it', async () => {
    const w = orgWorld({ active: A })
    w.mount(<CreateOrganization />)
    await screen.findByLabelText('Name')
    expectAbsent(screen.queryByRole('button', { name: 'Cancel' }))
  })
})
