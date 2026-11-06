import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SsoConnection } from '~/api/generated/api.gen'
import { resetSetup, SETUP_TEST_CHANNEL } from '~/features/setup/setup-api'
import { SetupScreen } from '~/features/setup/setup-screen'

const TOKEN = 'tula_setup_0123456789abcdef0123456789abcdef_secretvalue'
const ID = '0190a000-0000-7000-8000-000000000002'

function connection(extra: Record<string, unknown> = {}) {
  return {
    id: ID,
    organizationId: '0190a000-0000-7000-8000-000000000001',
    protocol: 'oidc',
    name: 'Okta',
    status: 'draft',
    issuer: 'https://idp.example.com',
    clientId: 'abc',
    clientSecretSet: true,
    saml: null,
    attributeMapping: null,
    domains: [],
    tested: false,
    ...extra,
  } as unknown as SsoConnection
}

interface Call {
  url: string
  method: string
  body: unknown
}

/** Answer `/v1/setup` calls: the portal holds `current`, a write is recorded and answered 200. */
function stub(current: SsoConnection, extra: (call: Call) => unknown = () => undefined) {
  const calls: Call[] = []
  const spy = spyOn(globalThis, 'fetch').mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    const special = extra(call)
    const body =
      special !== undefined
        ? special
        : call.url === '/v1/setup'
          ? {
              organization: { id: current.organizationId, name: 'Acme' },
              domains: [],
              expiresAt: '2030-01-01T00:00:00.000Z',
              connections: [current],
            }
          : call.url.endsWith('/group-roles') && call.method === 'GET'
            ? { mappings: [] }
            : current
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch)
  return { calls, spy }
}

beforeEach(() => {
  resetSetup()
  window.history.replaceState(null, '', `/dashboard/setup#token=${TOKEN}`)
})
afterEach(() => {
  cleanup()
  resetSetup()
  window.history.replaceState(null, '', '/')
})

describe('the setup portal, step by step', () => {
  test('saving an existing connection patches it and says so', async () => {
    const { calls, spy } = stub(connection())
    const user = userEvent.setup()
    render(<SetupScreen />)
    await user.click(await screen.findByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    const patch = calls.find((c) => c.method === 'PATCH')
    expect(patch?.url).toBe(`/v1/setup/connections/${ID}`)
    expect(patch?.body).toMatchObject({ name: 'Okta', issuer: 'https://idp.example.com' })
    expect(patch?.body).not.toHaveProperty('clientSecret')
    spy.mockRestore()
  })

  test('a SAML connection is created from pasted metadata', async () => {
    const calls: Call[] = []
    const user = userEvent.setup()
    const fresh = spyOn(globalThis, 'fetch').mockImplementation((async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const url = String(input)
      const body =
        url === '/v1/setup'
          ? {
              organization: { id: 'o', name: 'Acme' },
              domains: ['acme.test'],
              expiresAt: '2030-01-01T00:00:00.000Z',
              connections: [],
            }
          : connection({ protocol: 'saml' })
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      })
      return new Response(JSON.stringify(body), { status: 200 })
    }) as typeof fetch)
    render(<SetupScreen />)
    await screen.findByText(/Set up single sign-on for Acme/)
    await user.selectOptions(screen.getByLabelText('Protocol'), 'saml')
    await user.type(screen.getByLabelText('Connection name'), 'Entra')
    await user.selectOptions(
      screen.getByLabelText('How do you give the provider’s details?'),
      'xml'
    )
    await user.type(screen.getByLabelText('Metadata XML'), 'x')
    await user.click(screen.getByRole('button', { name: 'Create connection' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
    const post = calls.find((c) => c.method === 'POST')
    expect(post?.body).toMatchObject({ protocol: 'saml', saml: { metadataXml: 'x' } })
    await user.selectOptions(
      screen.getByLabelText('How do you give the provider’s details?'),
      'manual'
    )
    await user.type(screen.getByLabelText('Provider entity ID'), 'urn:idp')
    await user.type(screen.getByLabelText('Sign-in URL'), 'https://idp.example.com/sso')
    await user.click(screen.getByLabelText('acme.test'))
    await user.click(screen.getByRole('button', { name: 'Create connection' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2))
    expect(calls.filter((c) => c.method === 'POST')[1]?.body).toMatchObject({
      saml: { idpEntityId: 'urn:idp', ssoUrl: 'https://idp.example.com/sso' },
      domains: ['acme.test'],
    })
    fresh.mockRestore()
  })

  test('group roles are added, saved without empty rows and removed', async () => {
    const { calls, spy } = stub(connection())
    const user = userEvent.setup()
    render(<SetupScreen />)
    await user.click(await screen.findByRole('button', { name: 'Add a group' }))
    await user.click(screen.getByRole('button', { name: 'Add a group' }))
    await user.type(screen.getByLabelText('Group 1'), 'admins')
    await user.type(screen.getByLabelText('Role for group 1'), 'admin')
    await user.click(screen.getAllByRole('button', { name: 'Remove' })[1] as HTMLElement)
    await user.click(screen.getByRole('button', { name: 'Save group roles' }))
    await screen.findByText('Group roles saved.')
    const put = calls.find((c) => c.method === 'PUT')
    expect(put?.body).toEqual({ mappings: [{ group: 'admins', role: 'admin' }] })
    spy.mockRestore()
  })

  test('a blocked test window gives a link, and a passing test is shown', async () => {
    const open = spyOn(window, 'open').mockImplementation(() => null)
    const { spy } = stub(connection(), (call) => {
      if (call.method === 'POST' && call.url.endsWith('/tests')) {
        return { testId: 'T1', authorizationUrl: 'https://idp.example.com/authorize' }
      }
      if (call.url.endsWith('/tests/T1')) {
        return { status: 'passed', groups: ['admins'] }
      }
      return undefined
    })
    const user = userEvent.setup()
    render(<SetupScreen />)
    await user.click(await screen.findByRole('button', { name: 'Run a test sign-in' }))
    await screen.findByText('Open the test sign-in')
    await screen.findByText(/The test passed\. Groups received: admins\./, undefined, {
      timeout: 8000,
    })
    open.mockRestore()
    spy.mockRestore()
  })

  test('a failed test is shown with its reason', async () => {
    const popup = { location: { href: '' }, close() {} }
    const open = spyOn(window, 'open').mockImplementation(() => popup as unknown as Window)
    const { spy } = stub(connection(), (call) => {
      if (call.method === 'POST' && call.url.endsWith('/tests')) {
        return { testId: 'T2', authorizationUrl: 'https://idp.example.com/authorize' }
      }
      if (call.url.endsWith('/tests/T2')) {
        return { status: 'failed', reason: 'bad_signature', message: null }
      }
      return undefined
    })
    const user = userEvent.setup()
    render(<SetupScreen />)
    await user.click(await screen.findByRole('button', { name: 'Run a test sign-in' }))
    await screen.findByText(/The test failed \(bad_signature\)/, undefined, { timeout: 8000 })
    expect(popup.location.href).toBe('https://idp.example.com/authorize')
    open.mockRestore()
    spy.mockRestore()
  })

  test('a connection that passed its test can be activated', async () => {
    const { calls, spy } = stub(connection({ tested: true }))
    const user = userEvent.setup()
    render(<SetupScreen />)
    await user.click(await screen.findByRole('button', { name: 'Activate the connection' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true))
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ status: 'active' })
    spy.mockRestore()
  })

  test('an active connection says it is active and offers no activation', async () => {
    const { spy } = stub(connection({ status: 'active', tested: true }))
    render(<SetupScreen />)
    await screen.findByText(/This connection is active/)
    expect(screen.queryByRole('button', { name: 'Activate the connection' })).toBeNull()
    spy.mockRestore()
  })

  test('the values for a SAML provider come from the connection, with the metadata download', async () => {
    const { spy } = stub(
      connection({
        protocol: 'saml',
        saml: {
          spEntityId: 'urn:sp',
          acsUrl: 'https://tula.example/acs',
          spMetadataUrl: 'https://tula.example/meta',
        },
      })
    )
    render(<SetupScreen />)
    await screen.findByText('urn:sp')
    await screen.findByText('Download the service provider metadata')
    spy.mockRestore()
  })

  test('a message from the window the provider returned to reads the test at once', async () => {
    const open = spyOn(window, 'open').mockImplementation(() => null)
    let reads = 0
    const { spy } = stub(connection(), (call) => {
      if (call.method === 'POST' && call.url.endsWith('/tests')) {
        return { testId: 'T9', authorizationUrl: 'https://idp.example.com/authorize' }
      }
      if (call.url.endsWith('/tests/T9')) {
        reads += 1
        return { status: 'passed', groups: [] }
      }
      return undefined
    })
    const user = userEvent.setup()
    render(<SetupScreen />)
    await user.click(await screen.findByRole('button', { name: 'Run a test sign-in' }))
    await screen.findByText('Open the test sign-in')
    expect(reads).toBe(0)
    // A message about another test is ignored; the one about this test reads it.
    const channel = new BroadcastChannel(SETUP_TEST_CHANNEL)
    channel.postMessage({ testId: 'other' })
    channel.postMessage({ testId: 'T9' })
    channel.close()
    await screen.findByText(/The test passed/, undefined, { timeout: 1000 })
    expect(reads).toBe(1)
    open.mockRestore()
    spy.mockRestore()
  })

  test('a metadata file is read into the pasted metadata and sent', async () => {
    const calls: Call[] = []
    const fresh = spyOn(globalThis, 'fetch').mockImplementation((async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const url = String(input)
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      })
      const body =
        url === '/v1/setup'
          ? {
              organization: { id: 'o', name: 'Acme' },
              domains: [],
              expiresAt: '2030-01-01T00:00:00.000Z',
              connections: [],
            }
          : connection({ protocol: 'saml' })
      return new Response(JSON.stringify(body), { status: 200 })
    }) as typeof fetch)
    const user = userEvent.setup()
    render(<SetupScreen />)
    await screen.findByText(/Set up single sign-on for Acme/)
    await user.selectOptions(screen.getByLabelText('Protocol'), 'saml')
    await user.type(screen.getByLabelText('Connection name'), 'Entra')
    await user.selectOptions(
      screen.getByLabelText('How do you give the provider’s details?'),
      'xml'
    )
    const xml = '<EntityDescriptor entityID="urn:idp"/>'
    await user.upload(
      screen.getByLabelText('Metadata file'),
      new File([xml], 'metadata.xml', { type: 'text/xml' })
    )
    await waitFor(() =>
      expect((screen.getByLabelText('Metadata XML') as HTMLTextAreaElement).value).toBe(xml)
    )
    await user.click(screen.getByRole('button', { name: 'Create connection' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      saml: { metadataXml: xml },
    })
    fresh.mockRestore()
  })
})
