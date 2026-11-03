import { afterEach, describe, expect, mock, test } from 'bun:test'
import { screen, waitFor, within } from '@testing-library/react'
import { accessToken } from '../../../core/src/testing/fakes'
import { expectAbsent, failure, json, sessionTokens } from '../testing/harness'
import {
  A,
  ADMIN_PERMISSIONS,
  GLOBEX,
  MEMBER_PERMISSIONS,
  organization,
  orgWorld,
} from '../testing/organizations'
import { OrganizationProfile } from './organization-profile'

afterEach(() => {
  mock.restore()
})

const BASE = `/v1/client/me/organizations/${A}/sso-connections`
const SSO_ACME = organization(A, 'Acme', 'admin', [...ADMIN_PERMISSIONS, 'org:sys:sso:manage'])
const CONNECTION = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  organizationId: A,
  protocol: 'oidc',
  name: 'Okta',
  status: 'draft',
  issuer: 'https://idp.example.com',
  clientId: 'client-1',
  clientSecretSet: true,
  saml: null,
  attributeMapping: null,
  groupRoles: null,
  tested: false,
  defaultRole: 'member',
  enforced: false,
  breakGlassRole: null,
  trustIdpMfa: false,
  domains: ['acme.com'],
  createdAt: '2030-01-01T00:00:00.000Z',
  updatedAt: '2030-01-01T00:00:00.000Z',
  ...over,
})

function ssoWorld(connections: ReturnType<typeof CONNECTION>[] = [CONNECTION()]) {
  const w = orgWorld({ organizations: [SSO_ACME, GLOBEX] })
  const state = { connections }
  w.api.on(`GET ${BASE}`, () => json(200, { connections: state.connections }))
  w.api.on(`GET /v1/client/me/organizations/${A}/roles`, () =>
    json(200, { data: [{ key: 'admin', name: 'Admin' }] })
  )
  return Object.assign(w, { state })
}

describe('<OrganizationProfile>: Single sign-on', () => {
  test('the tab is drawn only for a role that holds org:sys:sso:manage', async () => {
    const without = orgWorld({
      organizations: [organization(A, 'Acme', 'member', MEMBER_PERMISSIONS), GLOBEX],
    })
    without.mount(<OrganizationProfile />)
    await screen.findAllByRole('tab')
    expectAbsent(screen.queryByRole('tab', { name: 'Single sign-on' }))
  })

  test('lists connections with their state and never a secret', async () => {
    const w = ssoWorld()
    w.mount(<OrganizationProfile section='sso' />)
    expect(await screen.findByText('Okta')).toBeTruthy()
    expect(screen.getByText('Draft')).toBeTruthy()
    expect(screen.getByText('A client secret is saved.')).toBeTruthy()
    expect(document.body.textContent).not.toContain('secret-value')
  })

  test('creating sends the connection, and the secret is gone from the page after', async () => {
    const w = ssoWorld([])
    w.api.on(`POST ${BASE}`, () => {
      w.state.connections = [CONNECTION()]
      return json(201, CONNECTION())
    })
    w.mount(<OrganizationProfile section='sso' />)
    await w.user.type(await screen.findByLabelText('Name'), 'Okta')
    await w.user.type(screen.getByLabelText('Issuer'), 'https://idp.example.com')
    await w.user.type(screen.getByLabelText('Client ID'), 'client-1')
    const secret = screen.getByLabelText('Client secret') as HTMLInputElement
    expect(secret.type).toBe('password')
    await w.user.type(secret, 'secret-value')
    await w.user.click(screen.getByRole('button', { name: 'Add connection' }))
    expect(await screen.findByText('Okta was added as a draft.')).toBeTruthy()
    expect(w.api.calls(`POST ${BASE}`)[0]?.body).toEqual({
      protocol: 'oidc',
      name: 'Okta',
      issuer: 'https://idp.example.com',
      clientId: 'client-1',
      clientSecret: 'secret-value',
    })
    expect((screen.getByLabelText('Client secret') as HTMLInputElement).value).toBe('')
  })

  test('an empty form says what is missing and sends nothing', async () => {
    const w = ssoWorld([])
    w.mount(<OrganizationProfile section='sso' />)
    await w.user.click(await screen.findByRole('button', { name: 'Add connection' }))
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0)
    expect(w.api.calls(`POST ${BASE}`)).toHaveLength(0)
  })

  test('turning a draft on sends the status', async () => {
    const w = ssoWorld()
    w.api.on(`PATCH ${BASE}/c1`, () => json(200, CONNECTION({ status: 'active' })))
    w.mount(<OrganizationProfile section='sso' />)
    await w.user.click(await screen.findByRole('button', { name: 'Turn on Okta' }))
    expect(await screen.findByText('Okta was updated.')).toBeTruthy()
    expect(w.api.calls(`PATCH ${BASE}/c1`)[0]?.body).toEqual({ status: 'active' })
  })

  test('switching enforcement off is a weakening: it steps up, then repeats', async () => {
    const w = ssoWorld([CONNECTION({ status: 'active', enforced: true })])
    let stepped = false
    w.api.on(`PATCH ${BASE}/c1`, () =>
      stepped
        ? json(200, CONNECTION({ status: 'active', enforced: false }))
        : failure(403, 'auth.step_up_required', { params: { methods: 'password' } })
    )
    w.api.on('POST /v1/client/sessions/step-up', () => {
      stepped = true
      return json(
        200,
        sessionTokens('stepped_up', { accessToken: accessToken('stepped_up', 60, { org_id: A }) })
      )
    })
    w.mount(<OrganizationProfile section='sso' />)
    await w.user.click(await screen.findByRole('button', { name: 'Stop requiring Okta' }))
    const dialog = await screen.findByRole('dialog', { name: 'Confirm it is you' })
    await w.user.type(within(dialog).getByLabelText('Password'), 'sturdy-Otter-plays-42-chess')
    await w.user.click(within(dialog).getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('Okta was updated.')).toBeTruthy()
    expect(w.api.calls(`PATCH ${BASE}/c1`)).toHaveLength(2)
  })

  test('deleting asks first, then deletes', async () => {
    const w = ssoWorld()
    w.api.on(`DELETE ${BASE}/c1`, () => {
      w.state.connections = []
      return new Response(null, { status: 204 })
    })
    w.mount(<OrganizationProfile section='sso' />)
    await w.user.click(await screen.findByRole('button', { name: 'Delete Okta' }))
    expect(w.api.calls(`DELETE ${BASE}/c1`)).toHaveLength(0)
    await w.user.click(screen.getByRole('button', { name: 'Yes, delete' }))
    expect(await screen.findByText('Okta was deleted.')).toBeTruthy()
    expect(await screen.findByText('No connections yet.')).toBeTruthy()
  })

  test('a connection in use is refused with the server message', async () => {
    const w = ssoWorld()
    w.api.on(`DELETE ${BASE}/c1`, () => failure(409, 'sso.connection_in_use'))
    w.mount(<OrganizationProfile section='sso' />)
    await w.user.click(await screen.findByRole('button', { name: 'Delete Okta' }))
    await w.user.click(screen.getByRole('button', { name: 'Yes, delete' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
  })

  test('a refusal because the role changed reads the permissions again', async () => {
    const w = ssoWorld()
    w.api.on(`GET ${BASE}`, () => failure(403, 'organization.permission_required'))
    w.mount(<OrganizationProfile section='sso' />)
    await waitFor(() =>
      expect(w.api.calls('GET /v1/client/me/organizations').length).toBeGreaterThan(1)
    )
  })
})
