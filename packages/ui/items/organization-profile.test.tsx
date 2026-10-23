import { describe, expect, test } from 'bun:test'
import { screen } from '@testing-library/react'
import { accessToken } from '../../core/src/testing/fakes'
import { failure, json, ROUTE, sessionTokens, world } from '../../react/src/testing/harness'
import { OrganizationProfile } from './organization-profile'

const LIST = 'GET /v1/client/me/organizations'
const A = '01980000-0000-7000-8000-00000000000a'
const B = '01980000-0000-7000-8000-00000000000b'

function organization(id: string, role: string, permissions: string[]) {
  return {
    id,
    name: 'Acme',
    slug: 'acme',
    role,
    permissions,
    createdAt: '2030-03-09T23:59:00.000Z',
  }
}

function page(listed: unknown[], active: string | null) {
  return json(200, {
    data: listed,
    activeOrganizationId: active,
    meta: { hasMore: false, nextCursor: null },
  })
}

/** A signed-in world whose session acts in `active` (or in none), with `listed` as its list. */
function inOrganization(active: string | null, listed: unknown[]) {
  const w = world({ signedIn: true })
  w.api.on(ROUTE.refresh, () =>
    json(
      200,
      sessionTokens('access_1', {
        accessToken: accessToken('t', 60, active ? { org_id: active } : {}),
      })
    )
  )
  w.api.on(LIST, () => page(listed, active))
  return w
}

describe('the registry organization profile', () => {
  test('shows the name, short name, role, creation date and what the role allows', async () => {
    const w = inOrganization(A, [
      organization(A, 'billing_manager', ['org:billing:read', 'org:sys:memberships:read']),
    ])
    w.mount(<OrganizationProfile />)
    const group = await screen.findByRole('group', { name: 'Acme' })
    expect(screen.getByRole('heading', { level: 2, name: 'Acme' })).toBeTruthy()
    // The date is drawn in UTC, so that the same day shows on every server and every browser.
    expect(group.textContent).toContain('Mar 9, 2030')
    expect(group.textContent).toContain('billing_manager')
    expect(screen.getByText('org:billing:read')).toBeTruthy()
    expect(screen.getByText('You can see who the members are.')).toBeTruthy()
  })

  test('the heading level is a prop', async () => {
    const w = inOrganization(A, [organization(A, 'member', [])])
    w.mount(<OrganizationProfile headingLevel={3} />)
    expect(await screen.findByRole('heading', { level: 3, name: 'Acme' })).toBeTruthy()
  })

  test('a role that manages memberships says so', async () => {
    const w = inOrganization(A, [
      organization(A, 'admin', ['org:sys:memberships:manage', 'org:sys:memberships:read']),
    ])
    w.mount(<OrganizationProfile />)
    expect(await screen.findByText('You can manage members.')).toBeTruthy()
  })

  test('a role with no permissions says so, and cannot see the members', async () => {
    const w = inOrganization(A, [organization(A, 'guest', [])])
    w.mount(<OrganizationProfile />)
    expect(await screen.findByText('Your role has no permissions.')).toBeTruthy()
    expect(screen.getByText('You cannot see the members.')).toBeTruthy()
  })

  test('with no active organization it says the personal account is in use', async () => {
    const w = inOrganization(null, [organization(A, 'member', [])])
    w.mount(<OrganizationProfile />)
    expect(
      await screen.findByText('No organization is active. You are using your personal account.')
    ).toBeTruthy()
  })

  test('a membership that is gone from the list is not drawn as a profile', async () => {
    const w = inOrganization(A, [organization(B, 'member', [])])
    w.mount(<OrganizationProfile />)
    expect((await screen.findByRole('alert')).textContent).toContain(
      'You are no longer a member of this organization.'
    )
    expect(screen.queryByRole('group')).toBeNull()
  })

  test('a list that cannot be loaded is an alert with a way to ask again', async () => {
    const w = inOrganization(A, [])
    let answered = false
    w.api.on(LIST, () => {
      if (answered) {
        return page([organization(A, 'member', [])], A)
      }
      answered = true
      return failure(500, 'internal')
    })
    w.mount(<OrganizationProfile />)
    expect(await screen.findByRole('alert')).toBeTruthy()
    await w.user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('group', { name: 'Acme' })).toBeTruthy()
  })
})
