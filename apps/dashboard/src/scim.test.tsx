import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor, within } from '@testing-library/react'
import { fakeOrganization, fakeScimToken, installFakeApi } from '~/testing/fake-api'
import { DEV_PATH, expectNothingKept, openDialogs, renderApp, type World } from '~/testing/harness'

// The SCIM section of an organization's page, rendered as the whole app against the fake API.

let world: World | undefined

afterEach(() => {
  world?.queryClient.clear()
  world?.api.restore()
  world = undefined
})

const ACME = '00000000-0000-7000-8000-0000000aaa01'

function start(tokens: Parameters<typeof fakeScimToken>[0][] = []): World {
  const api = installFakeApi()
  const settings = api.state.settings.settings
  settings.organizations = { ...settings.organizations, enabled: true }
  api.state.organizations.push(fakeOrganization({ id: ACME, name: 'Acme Corp', slug: 'acme' }))
  api.state.scimTokens.push(
    ...tokens.map((entry) => fakeScimToken({ organizationId: ACME, ...entry }))
  )
  world = renderApp(`${DEV_PATH}/organizations/${ACME}`, { api })
  return world
}

const dialog = () => screen.getByRole('dialog')

describe('SCIM tokens on the organization page', () => {
  test('the list shows last use and revocation, and offers revoke on live tokens only', async () => {
    start([
      { name: 'Okta', lastUsedAt: '2026-10-24T10:00:00.000Z' },
      { name: 'Old', revokedAt: '2026-10-25T10:00:00.000Z' },
    ])
    const table = await screen.findByRole('table', { name: 'SCIM tokens' })
    const rows = within(table).getAllByRole('row')
    const okta = rows.find((row) => row.textContent?.includes('Okta')) as HTMLElement
    const old = rows.find((row) => row.textContent?.includes('Old')) as HTMLElement
    expect(okta.textContent).toContain('Active')
    expect(okta.textContent).not.toContain('Never')
    expect(old.textContent).toContain('Revoked')
    expect(within(old).queryByRole('button', { name: 'Revoke Old' })).toBeNull()
    expect(within(okta).getByRole('button', { name: 'Revoke Okta' })).toBeTruthy()
  })

  test('a token never used says so', async () => {
    start([{ name: 'Fresh' }])
    const row = (await screen.findByText('Fresh')).closest('tr') as HTMLElement
    expect(row.textContent).toContain('Never')
  })

  test('a new token is shown once with the base URL, then never again', async () => {
    const current = start()
    const { user, api } = current
    await screen.findByText('No SCIM tokens')
    await user.click(screen.getByRole('button', { name: 'Create token' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Create token' }))
    expect(within(dialog()).getByRole('alert').textContent).toContain('Enter a name')
    await user.type(within(dialog()).getByLabelText('Name'), 'Okta')
    await user.click(within(dialog()).getByRole('button', { name: 'Create token' }))

    const token = (await within(dialog()).findByTestId('created-scim-token')).textContent ?? ''
    expect(token).toStartWith('tula_scim_')
    expect(within(dialog()).getByTestId('scim-base-url').textContent).toBe(
      `${window.location.origin}/v1/scim/v2`
    )
    expect(localStorage.length + sessionStorage.length).toBe(0)
    await user.click(within(dialog()).getByRole('button', { name: 'I have copied it' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expectNothingKept(current, [token])
    expect(api.state.scimTokens).toHaveLength(1)
    await screen.findByRole('button', { name: 'Revoke Okta' })

    // Reopened, the dialog is a fresh form: the token does not come back.
    await user.click(screen.getByRole('button', { name: 'Create token' }))
    expect(within(dialog()).queryByTestId('created-scim-token')).toBeNull()
    expect(document.documentElement.outerHTML.includes(token)).toBe(false)
  })

  test('revoking asks first, and cancelling sends nothing', async () => {
    const { user, api } = start([{ name: 'Okta' }])
    await user.click(await screen.findByRole('button', { name: 'Revoke Okta' }))
    expect(within(dialog()).getByRole('heading', { name: 'Revoke Okta?' })).toBeTruthy()
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(api.callsTo('DELETE', '/v1/admin/scim-tokens')).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Revoke Okta' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Revoke token' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(api.state.scimTokens[0]?.revokedAt).not.toBeNull()
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Revoke Okta' })).toBeNull())
  })

  test('a refused creation is said in words', async () => {
    const { user } = start(Array.from({ length: 10 }, (_, index) => ({ name: `t${index}` })))
    await screen.findByText('t0')
    await user.click(screen.getByRole('button', { name: 'Create token' }))
    await user.type(within(dialog()).getByLabelText('Name'), 'eleventh')
    await user.click(within(dialog()).getByRole('button', { name: 'Create token' }))
    expect((await within(dialog()).findByRole('alert')).textContent).toContain(
      'most SCIM tokens allowed'
    )
  })
})
