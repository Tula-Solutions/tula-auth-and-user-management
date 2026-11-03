import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor, within } from '@testing-library/react'
import {
  type FakeApi,
  type FakeSsoConnection,
  fakeDomain,
  fakeOrganization,
  fakeSsoConnection,
  installFakeApi,
} from '~/testing/fake-api'
import { DEV_PATH, openDialogs, renderApp, type World } from '~/testing/harness'

// The SSO section of an organization's page and the single sign-on switch of the
// organization settings, rendered as the whole app against the fake API.

let world: World | undefined

afterEach(() => {
  world?.queryClient.clear()
  world?.api.restore()
  world = undefined
})

const ACME = '00000000-0000-7000-8000-0000000aaa01'

function arranged(options: { off?: boolean; connections?: Partial<FakeSsoConnection>[] } = {}) {
  const api = installFakeApi()
  const settings = api.state.settings.settings
  settings.organizations = { ...settings.organizations, enabled: true }
  settings.sso = { enabled: !options.off }
  api.state.organizations.push(fakeOrganization({ id: ACME, name: 'Acme Corp', slug: 'acme' }))
  api.state.domains.push(fakeDomain({ organizationId: ACME, domain: 'acme.com' }))
  api.state.ssoConnections.push(
    ...(options.connections ?? []).map((entry) =>
      fakeSsoConnection({ organizationId: ACME, ...entry })
    )
  )
  return api
}

function start(api: FakeApi, path = `${DEV_PATH}/organizations/${ACME}`): World {
  world = renderApp(path, { api })
  return world
}

const dialog = () => screen.getByRole('dialog')
const sent = (api: FakeApi, method: string) =>
  api.calls.filter(
    (call) => call.method === method && call.path.startsWith('/v1/admin/sso-connections')
  )

const DAY = 86_400_000
const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString()

const SAML = (notAfter: string) => ({
  protocol: 'saml' as const,
  name: 'Entra',
  issuer: '',
  clientId: '',
  clientSecretSet: false,
  secret: null,
  saml: {
    idpEntityId: 'https://idp.example.com/entity',
    ssoUrl: 'https://idp.example.com/sso',
    metadataUrl: null,
    certificates: [{ fingerprint: 'AB:CD', notAfter, expired: Date.parse(notAfter) <= Date.now() }],
    spEntityId: 'https://auth.example.com/sp/metadata',
    acsUrl: 'https://auth.example.com/sp/acs',
    spMetadataUrl: 'https://auth.example.com/sp/metadata',
  },
})

describe('the SSO section', () => {
  test('lists a connection with its protocol, status and bound domains', async () => {
    start(arranged({ connections: [{ name: 'Okta', status: 'active', domains: ['acme.com'] }] }))
    const card = await screen.findByRole('listitem', { name: 'Connection Okta' })
    expect(within(card).getByText('OIDC')).toBeTruthy()
    expect(within(card).getByText('Active')).toBeTruthy()
    expect(within(card).getByText('acme.com')).toBeTruthy()
    expect(within(card).getByText('Saved, never shown again')).toBeTruthy()
  })

  test('creates an OIDC connection, sends the secret once and never shows it again', async () => {
    const api = arranged()
    const { user } = start(api)
    await user.click(await screen.findByRole('button', { name: 'New connection' }))
    await user.type(within(dialog()).getByLabelText('Name'), 'Okta')
    await user.type(within(dialog()).getByLabelText('Issuer'), 'https://login.example.com')
    await user.type(within(dialog()).getByLabelText('Client id'), 'abc')
    await user.type(within(dialog()).getByLabelText('Client secret'), 'sup3r-secret')
    await user.type(within(dialog()).getByLabelText('Domains'), 'acme.com')
    await user.click(within(dialog()).getByRole('button', { name: 'Create connection' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    const [post] = sent(api, 'POST')
    expect(post?.body).toMatchObject({
      organizationId: ACME,
      protocol: 'oidc',
      name: 'Okta',
      clientSecret: 'sup3r-secret',
      domains: ['acme.com'],
    })
    const card = await screen.findByRole('listitem', { name: 'Connection Okta' })
    expect(within(card).getByText('Draft')).toBeTruthy()
    expect(document.body.textContent).not.toContain('sup3r-secret')
    expect(
      api.calls.some(
        (call) => call.method === 'GET' && JSON.stringify(call.body ?? '').includes('sup3r-secret')
      )
    ).toBe(false)
  })

  test('creates a SAML connection from a metadata address and shows the provider values', async () => {
    const api = arranged()
    const { user } = start(api)
    await user.click(await screen.findByRole('button', { name: 'New connection' }))
    await user.type(within(dialog()).getByLabelText('Name'), 'Entra')
    await user.selectOptions(within(dialog()).getByLabelText('Protocol'), 'saml')
    await user.type(
      within(dialog()).getByLabelText('Metadata address'),
      'https://idp.example.com/metadata'
    )
    await user.click(within(dialog()).getByRole('button', { name: 'Create connection' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(sent(api, 'POST')[0]?.body).toMatchObject({
      protocol: 'saml',
      saml: { metadataUrl: 'https://idp.example.com/metadata' },
    })
    const card = await screen.findByRole('listitem', { name: 'Connection Entra' })
    expect(within(card).getByText('SAML')).toBeTruthy()
    expect(within(card).getByRole('button', { name: 'Copy Entity id' })).toBeTruthy()
    expect(within(card).getByRole('button', { name: 'Copy Reply URL (ACS)' })).toBeTruthy()
    const download = within(card).getByRole('link', { name: 'Download the metadata' })
    expect(download.getAttribute('download')).toBe('tula-sp-metadata.xml')
  })

  test('says what a refused create means', async () => {
    const { user } = start(arranged({ connections: [{ name: 'Okta' }] }))
    await user.click(await screen.findByRole('button', { name: 'New connection' }))
    await user.type(within(dialog()).getByLabelText('Name'), 'Okta')
    await user.type(within(dialog()).getByLabelText('Issuer'), 'https://login.example.com')
    await user.type(within(dialog()).getByLabelText('Client id'), 'abc')
    await user.type(within(dialog()).getByLabelText('Client secret'), 'x')
    await user.click(within(dialog()).getByRole('button', { name: 'Create connection' }))
    expect(
      await within(dialog()).findByText(
        'This organization already has a connection with that name.'
      )
    ).toBeTruthy()
  })

  test('a certificate ending within 30 days is warned about, an expired one more strongly', async () => {
    start(
      arranged({
        connections: [
          { id: '00000000-0000-7000-8000-00000000e001', ...SAML(inDays(10)) },
          { id: '00000000-0000-7000-8000-00000000e002', ...SAML(inDays(-1)), name: 'Old' },
          { id: '00000000-0000-7000-8000-00000000e003', ...SAML(inDays(90)), name: 'Fresh' },
        ],
      })
    )
    const soon = await screen.findByRole('listitem', { name: 'Connection Entra' })
    expect(within(soon).getByText('Expires within 30 days')).toBeTruthy()
    expect(within(soon).getByRole('status').textContent).toContain('expires within 30 days')
    const old = screen.getByRole('listitem', { name: 'Connection Old' })
    expect(within(old).getByText('Expired')).toBeTruthy()
    expect(within(old).getByRole('alert').textContent).toContain('has expired')
    const fresh = screen.getByRole('listitem', { name: 'Connection Fresh' })
    expect(within(fresh).queryByText('Expired')).toBeNull()
    expect(within(fresh).queryByText('Expires within 30 days')).toBeNull()
  })

  test('edits a connection: only the changed fields are sent and an empty secret keeps the saved one', async () => {
    const api = arranged({ connections: [{ name: 'Okta' }] })
    const { user } = start(api)
    await user.click(await screen.findByRole('button', { name: 'Edit Okta' }))
    expect((within(dialog()).getByLabelText('Client secret') as HTMLInputElement).value).toBe('')
    await user.clear(within(dialog()).getByLabelText('Name'))
    await user.type(within(dialog()).getByLabelText('Name'), 'Okta SSO')
    await user.click(within(dialog()).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(sent(api, 'PATCH')[0]?.body).toEqual({ name: 'Okta SSO' })
    expect(api.state.ssoConnections[0]?.secret).toBe('seed-secret')
  })

  test('activates and disables a connection after a confirmation', async () => {
    const api = arranged({ connections: [{ name: 'Okta' }] })
    const { user } = start(api)
    await user.click(await screen.findByRole('button', { name: 'Activate Okta' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Activate' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(sent(api, 'PATCH')[0]?.body).toEqual({ status: 'active' })
    await user.click(await screen.findByRole('button', { name: 'Disable Okta' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Disable' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(api.state.ssoConnections[0]?.status).toBe('disabled')
  })

  test('deletes a connection, and says when it cannot be deleted', async () => {
    const api = arranged({
      connections: [{ name: 'Okta' }, { name: 'Used', used: true }],
    })
    const { user } = start(api)
    await user.click(await screen.findByRole('button', { name: 'Delete Used' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Delete connection' }))
    expect(await within(dialog()).findByText(/Disable it instead of deleting it/)).toBeTruthy()
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    await user.click(screen.getByRole('button', { name: 'Delete Okta' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Delete connection' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(api.state.ssoConnections.map((entry) => entry.name)).toEqual(['Used'])
  })

  test('with single sign-on off it says so and links to the settings', async () => {
    start(arranged({ off: true }))
    expect(
      await screen.findByText('Single sign-on is switched off in this environment')
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'New connection' })).toBeNull()
  })

  test('the settings screen switches single sign-on on', async () => {
    const api = arranged({ off: true })
    const { user } = start(api, `${DEV_PATH}/organization-settings`)
    await user.click(await screen.findByRole('switch', { name: 'Single sign-on is on' }))
    await user.click(screen.getByRole('button', { name: /^Save/ }))
    await waitFor(() => expect(api.state.settings.settings.sso?.enabled).toBe(true))
  })
})
