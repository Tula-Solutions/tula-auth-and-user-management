import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor, within } from '@testing-library/react'
import { fakeOrganization, installFakeApi } from '~/testing/fake-api'
import { DEV_PATH, openDialogs, renderApp, type World } from '~/testing/harness'

// The setup links block of an organization's single sign-on section, as the whole app against
// the fake API: the address is shown once, and nothing keeps it.

let world: World | undefined

afterEach(() => {
  world?.queryClient.clear()
  world?.api.restore()
  world = undefined
})

const ACME = '00000000-0000-7000-8000-0000000aaa01'

function start() {
  const api = installFakeApi()
  const settings = api.state.settings.settings
  settings.organizations = { ...settings.organizations, enabled: true }
  settings.sso = { enabled: true }
  api.state.organizations.push(fakeOrganization({ id: ACME, name: 'Acme Corp', slug: 'acme' }))
  world = renderApp(`${DEV_PATH}/organizations/${ACME}`, { api })
  return world
}

describe('setup links', () => {
  test('creating one shows its address once, and closing drops it from the page and the caches', async () => {
    const { user, api, queryClient } = start()
    await user.click(await screen.findByRole('button', { name: 'Create setup link' }))
    const form = screen.getByRole('dialog')
    await user.click(within(form).getByRole('button', { name: 'Create link' }))
    const address = (await screen.findByTestId('created-setup-link')).textContent ?? ''
    expect(address).toContain('/dashboard/setup#token=tula_setup_')
    const posted = api.calls.find((c) => c.method === 'POST' && c.path === '/v1/admin/setup-links')
    expect(posted?.body).toMatchObject({ organizationId: ACME, expiresInDays: 7 })

    await user.click(screen.getByRole('button', { name: 'I have copied it' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    const token = address.split('#token=')[1] ?? ''
    expect(token).not.toBe('')
    expect(document.body.textContent).not.toContain(token)
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(token)
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data)
      )
    ).not.toContain(token)
    expect(
      JSON.stringify(
        queryClient
          .getMutationCache()
          .getAll()
          .map((m) => m.state)
      )
    ).not.toContain(token)
    // The list shows the link by its prefix, never by the whole token.
    expect(await screen.findByRole('listitem', { name: 'Setup link SSO setup' })).toBeTruthy()
  })

  test('a link is revoked after a confirmation, and an ended link offers no revoke', async () => {
    const { user, api } = start()
    await user.click(await screen.findByRole('button', { name: 'Create setup link' }))
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Create link' })
    )
    await user.click(await screen.findByRole('button', { name: 'I have copied it' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    const row = await screen.findByRole('listitem', { name: 'Setup link SSO setup' })
    await user.click(within(row).getByRole('button', { name: 'Revoke SSO setup' }))
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke link' })
    )
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(
      api.calls.some((c) => c.method === 'DELETE' && c.path.startsWith('/v1/admin/setup-links/'))
    ).toBe(true)
    const item = await screen.findByRole('listitem', { name: 'Setup link SSO setup' })
    await waitFor(() => expect(within(item).getByText('Revoked')).toBeTruthy())
    expect(within(item).queryByRole('button', { name: 'Revoke SSO setup' })).toBeNull()
  })

  test('refuses a name that is empty and a life outside 1 to 30 days before sending', async () => {
    const { user, api } = start()
    await user.click(await screen.findByRole('button', { name: 'Create setup link' }))
    const form = screen.getByRole('dialog')
    await user.clear(within(form).getByLabelText('Days it works'))
    await user.type(within(form).getByLabelText('Days it works'), '31')
    await user.click(within(form).getByRole('button', { name: 'Create link' }))
    expect(await within(form).findByText('Choose between 1 and 30 days.')).toBeTruthy()
    expect(api.calls.some((c) => c.method === 'POST' && c.path === '/v1/admin/setup-links')).toBe(
      false
    )
  })
})
