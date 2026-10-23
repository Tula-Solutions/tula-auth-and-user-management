import { describe, expect, mock, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import { accessToken } from '../../core/src/testing/fakes'
import {
  expectFocus,
  failure,
  json,
  ROUTE,
  sessionTokens,
  world,
} from '../../react/src/testing/harness'
import { OrganizationSwitcher } from './organization-switcher'

const LIST = 'GET /v1/client/me/organizations'
const ACTIVE = 'PUT /v1/client/me/organizations/active'
const CREATE = 'POST /v1/client/me/organizations'
const A = '01980000-0000-7000-8000-00000000000a'
const B = '01980000-0000-7000-8000-00000000000b'

function organization(id: string, name: string, role = 'member') {
  return {
    id,
    name,
    slug: name.toLowerCase(),
    role,
    permissions: [],
    createdAt: '2030-01-01T00:00:00.000Z',
  }
}
const ACME = organization(A, 'Acme', 'admin')
const GLOBEX = organization(B, 'Globex')

function page(data: unknown[], activeOrganizationId: string | null) {
  return json(200, { data, activeOrganizationId, meta: { hasMore: false, nextCursor: null } })
}

function switched(organizationId: string | null) {
  return json(200, {
    sessionId: 'session_1',
    organizationId,
    accessToken: accessToken('s', 60, organizationId ? { org_id: organizationId } : {}),
    accessTokenExpiresAt: '2030-01-01T00:01:00.000Z',
  })
}

/** A signed-in world whose session acts in organization A, with both organizations listed. */
function inAcme() {
  const w = world({ signedIn: true })
  w.api.on(ROUTE.refresh, () =>
    json(200, sessionTokens('access_1', { accessToken: accessToken('t', 60, { org_id: A }) }))
  )
  w.api.on(LIST, () => page([ACME, GLOBEX], A))
  return w
}

describe('the registry organization switcher: the list', () => {
  test('names the active organization and offers the personal account first', async () => {
    const w = inAcme()
    w.mount(<OrganizationSwitcher />)
    const select = (await screen.findByLabelText('Organization')) as HTMLSelectElement
    expect(select.value).toBe(A)
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      'Personal account',
      'Acme',
      'Globex',
    ])
  })

  test('a stored choice that matches no membership is shown as the personal account', async () => {
    const w = inAcme()
    w.api.on(LIST, () => page([GLOBEX], A))
    w.mount(<OrganizationSwitcher />)
    const select = (await screen.findByLabelText('Organization')) as HTMLSelectElement
    expect(select.value).toBe('')
  })

  test('says so when the user belongs to no organization', async () => {
    const w = inAcme()
    w.api.on(LIST, () => page([], null))
    w.mount(<OrganizationSwitcher />)
    expect(await screen.findByText('You are not a member of any organization yet.')).toBeTruthy()
  })

  test('a list that cannot be loaded is an alert with a way to ask again', async () => {
    const w = inAcme()
    let answered = false
    w.api.on(LIST, () => {
      if (answered) {
        return page([ACME], A)
      }
      answered = true
      return failure(500, 'internal')
    })
    w.mount(<OrganizationSwitcher />)
    expect(await screen.findByRole('alert')).toBeTruthy()
    await w.user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByLabelText('Organization')).toBeTruthy()
  })
})

describe('the registry organization switcher: switching', () => {
  test('choosing an organization makes it the active one, says so and calls onSwitch', async () => {
    const w = inAcme()
    w.api.on(ACTIVE, () => switched(B))
    const onSwitch = mock()
    w.mount(<OrganizationSwitcher onSwitch={onSwitch} />)
    await w.user.selectOptions(await screen.findByLabelText('Organization'), B)
    expect(await screen.findByText('Now working in Globex.')).toBeTruthy()
    expect(w.api.calls(ACTIVE)[0]?.body).toEqual({ organizationId: B })
    expect(onSwitch).toHaveBeenCalledWith(B)
  })

  test('choosing the personal account clears the active organization', async () => {
    const w = inAcme()
    w.api.on(ACTIVE, () => switched(null))
    const onSwitch = mock()
    w.mount(<OrganizationSwitcher onSwitch={onSwitch} />)
    await w.user.selectOptions(await screen.findByLabelText('Organization'), '')
    expect(await screen.findByText('Now using your personal account.')).toBeTruthy()
    expect(w.api.calls(ACTIVE)[0]?.body).toEqual({ organizationId: null })
    expect(onSwitch).toHaveBeenCalledWith(null)
  })

  test('a refused switch is an alert in the client words, and onSwitch is not called', async () => {
    const w = inAcme()
    w.api.on(ACTIVE, () => failure(403, 'organization.not_a_member'))
    const onSwitch = mock()
    w.mount(<OrganizationSwitcher onSwitch={onSwitch} />)
    await w.user.selectOptions(await screen.findByLabelText('Organization'), B)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).not.toContain('detail of')
    expect(onSwitch).not.toHaveBeenCalled()
  })
})

describe('the registry organization switcher: a new organization', () => {
  test('is offered only where the app asks for it', async () => {
    const w = inAcme()
    w.mount(<OrganizationSwitcher />)
    await screen.findByLabelText('Organization')
    expect(screen.queryByRole('button', { name: 'New organization' })).toBeNull()
  })

  test('creates the organization, switches to it and gives the focus back to the list', async () => {
    const w = inAcme()
    let created = false
    w.api.on(LIST, () => page(created ? [ACME, GLOBEX] : [ACME], A))
    w.api.on(CREATE, () => {
      created = true
      return json(201, GLOBEX)
    })
    w.api.on(ACTIVE, () => switched(B))
    const onSwitch = mock()
    w.mount(<OrganizationSwitcher allowCreate onSwitch={onSwitch} />)
    await w.user.click(await screen.findByRole('button', { name: 'New organization' }))
    await w.user.type(screen.getByLabelText('Name'), ' Globex ')
    await w.user.type(screen.getByLabelText('Short name'), 'globex')
    await w.user.click(screen.getByRole('button', { name: 'Create organization' }))
    expect(
      await screen.findByText('Globex was created and is now the active organization.')
    ).toBeTruthy()
    expect(w.api.calls(CREATE)[0]?.body).toEqual({ name: 'Globex', slug: 'globex' })
    expect(w.api.calls(ACTIVE)[0]?.body).toEqual({ organizationId: B })
    expect(onSwitch).toHaveBeenCalledWith(B)
    expect(screen.queryByLabelText('Name')).toBeNull()
    await expectFocus(screen.getByLabelText('Organization'))
  })

  test('an empty field is named and takes the focus, and nothing is sent', async () => {
    const w = inAcme()
    w.mount(<OrganizationSwitcher allowCreate />)
    await w.user.click(await screen.findByRole('button', { name: 'New organization' }))
    await w.user.click(screen.getByRole('button', { name: 'Create organization' }))
    expect((await screen.findAllByRole('alert')).length).toBe(2)
    await expectFocus(screen.getByLabelText('Name'))
    expect(w.api.calls(CREATE)).toHaveLength(0)
    await w.user.type(screen.getByLabelText('Name'), 'G')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    await w.user.click(screen.getByRole('button', { name: 'Create organization' }))
    await expectFocus(screen.getByLabelText('Short name'))
  })

  test('a refused creation stays in the form as an alert, and Cancel drops the form', async () => {
    const w = inAcme()
    w.api.on(CREATE, () => failure(409, 'organization.slug_taken'))
    w.mount(<OrganizationSwitcher allowCreate />)
    await w.user.click(await screen.findByRole('button', { name: 'New organization' }))
    await w.user.type(screen.getByLabelText('Name'), 'Acme')
    await w.user.type(screen.getByLabelText('Short name'), 'acme')
    await w.user.click(screen.getByRole('button', { name: 'Create organization' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBeTruthy())
    expect(w.api.calls(ACTIVE)).toHaveLength(0)
    await w.user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('Name')).toBeNull()
    expect(screen.getByRole('button', { name: 'New organization' })).toBeTruthy()
  })

  test('an organization that was created but could not be switched to closes the form and says so', async () => {
    const w = inAcme()
    w.api.on(CREATE, () => json(201, GLOBEX))
    w.api.on(ACTIVE, () => failure(500, 'internal'))
    const onSwitch = mock()
    w.mount(<OrganizationSwitcher allowCreate onSwitch={onSwitch} />)
    await w.user.click(await screen.findByRole('button', { name: 'New organization' }))
    await w.user.type(screen.getByLabelText('Name'), 'Globex')
    await w.user.type(screen.getByLabelText('Short name'), 'globex')
    await w.user.click(screen.getByRole('button', { name: 'Create organization' }))
    expect(
      await screen.findByText(
        'Globex was created, but switching to it failed. Choose it from the list.'
      )
    ).toBeTruthy()
    // The form is gone, so the user cannot submit the same short name again.
    expect(screen.queryByLabelText('Name')).toBeNull()
    expect(w.api.calls(CREATE)).toHaveLength(1)
    expect(onSwitch).not.toHaveBeenCalled()
  })
})
