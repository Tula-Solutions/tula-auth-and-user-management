import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SetupPortal, SsoConnection } from '~/api/generated/api.gen'
import { resetSetup, setupRequest } from '~/features/setup/setup-api'
import { SetupScreen } from '~/features/setup/setup-screen'

const TOKEN = 'tula_setup_0123456789abcdef0123456789abcdef_secretvalue'
const ORG = '0190a000-0000-7000-8000-000000000001'
const CONNECTION_ID = '0190a000-0000-7000-8000-000000000002'

const connection = {
  id: CONNECTION_ID,
  organizationId: ORG,
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
} as unknown as SsoConnection

function portal(connections: SsoConnection[]): SetupPortal {
  return {
    organization: { id: ORG, name: 'Acme' },
    domains: ['acme.test'],
    expiresAt: '2030-01-01T00:00:00.000Z',
    connections,
  }
}

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  credentials: RequestCredentials | undefined
  body: unknown
}

/** Answer `/v1/setup` calls from a table and record each call. */
function stubFetch(answer: (call: Call) => { status: number; body: unknown }) {
  const calls: Call[] = []
  const spy = spyOn(globalThis, 'fetch').mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: { ...(init?.headers as Record<string, string>) },
      credentials: init?.credentials,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    const { status, body } = answer(call)
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch)
  return { calls, spy }
}

function openAt(hash: string) {
  window.history.replaceState(null, '', `/dashboard/setup${hash}`)
}

beforeEach(() => {
  resetSetup()
})
afterEach(() => {
  cleanup()
  resetSetup()
  window.history.replaceState(null, '', '/')
})

describe('the setup portal', () => {
  test('takes the token out of the address, keeps it in memory and sends it only as a header', async () => {
    openAt(`#token=${TOKEN}`)
    const { calls, spy } = stubFetch(() => ({ status: 200, body: portal([]) }))
    render(<SetupScreen />)
    await screen.findByText(/Set up single sign-on for Acme/)
    expect(window.location.hash).toBe('')
    expect(window.location.href).not.toContain('secretvalue')
    expect(calls[0]?.url).toBe('/v1/setup')
    expect(calls[0]?.headers['x-tula-setup-token']).toBe(TOKEN)
    expect(calls[0]?.credentials).toBe('omit')
    expect(JSON.stringify({ ...localStorage })).not.toContain('secretvalue')
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('secretvalue')
    expect(document.body.textContent).not.toContain('secretvalue')
    spy.mockRestore()
  })

  test('an address with no token is an invalid link and calls nothing', async () => {
    openAt('')
    const { calls, spy } = stubFetch(() => ({ status: 200, body: portal([]) }))
    render(<SetupScreen />)
    await screen.findByText('This setup link is not valid')
    expect(calls).toHaveLength(0)
    spy.mockRestore()
  })

  test.each([401, 403])('a link the server refuses (%d) is shown as not valid', async (status) => {
    openAt(`#token=${TOKEN}`)
    const { spy } = stubFetch(() => ({
      status,
      body: { status, code: 'auth.invalid_key', detail: 'no' },
    }))
    render(<SetupScreen />)
    await screen.findByText('This setup link is not valid')
    spy.mockRestore()
  })

  test('a window the identity provider returned to holds no token and asks for no portal', async () => {
    openAt('#tula_test=0190a000-0000-7000-8000-000000000009')
    const { calls, spy } = stubFetch(() => ({ status: 200, body: portal([]) }))
    render(<SetupScreen />)
    await screen.findByText('Test sign-in finished')
    expect(calls).toHaveLength(0)
    spy.mockRestore()
  })

  test('creates a connection with the form and then shows the values to give the provider', async () => {
    openAt(`#token=${TOKEN}`)
    let created = false
    const { calls, spy } = stubFetch((call) => {
      if (call.method === 'POST' && call.url === '/v1/setup/connections') {
        created = true
        return { status: 201, body: connection }
      }
      if (call.url.endsWith('/group-roles')) {
        return { status: 200, body: { mappings: [] } }
      }
      return { status: 200, body: portal(created ? [connection] : []) }
    })
    const user = userEvent.setup()
    render(<SetupScreen />)
    await screen.findByText(/Set up single sign-on for Acme/)
    await user.type(screen.getByLabelText('Connection name'), 'Okta')
    await user.type(screen.getByLabelText('Issuer address'), 'https://idp.example.com')
    await user.type(screen.getByLabelText('Client ID'), 'abc')
    await user.type(screen.getByLabelText('Client secret'), 'hunter2')
    await user.click(screen.getByLabelText('acme.test'))
    await user.click(screen.getByRole('button', { name: 'Create connection' }))
    await screen.findByText(`${window.location.origin}/v1/sso/callback/${CONNECTION_ID}`)
    const post = calls.find((c) => c.method === 'POST')
    expect(post?.body).toMatchObject({
      protocol: 'oidc',
      name: 'Okta',
      issuer: 'https://idp.example.com',
      clientId: 'abc',
      clientSecret: 'hunter2',
      domains: ['acme.test'],
    })
    // The typed secret is not kept once it was sent.
    expect(document.body.textContent).not.toContain('hunter2')
    spy.mockRestore()
  })

  test('activation waits for a passing test', async () => {
    openAt(`#token=${TOKEN}`)
    const { spy } = stubFetch((call) =>
      call.url.endsWith('/group-roles')
        ? { status: 200, body: { mappings: [] } }
        : { status: 200, body: portal([connection]) }
    )
    render(<SetupScreen />)
    const button = await screen.findByRole('button', { name: 'Activate the connection' })
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(true))
    spy.mockRestore()
  })

  test('creates a SCIM token, shows it once, keeps it out of storage and drops it on a reload', async () => {
    openAt(`#token=${TOKEN}`)
    const secret = 'tula_scim_00000000000000000000000000000000_scimsecretvalue0123456789'
    const { calls, spy } = stubFetch((call) =>
      call.method === 'POST' && call.url === '/v1/setup/scim-tokens'
        ? {
            status: 201,
            body: {
              id: CONNECTION_ID,
              organizationId: CONNECTION_ID,
              name: 'Okta',
              prefix: 'tula_scim_0000',
              lastUsedAt: null,
              revokedAt: null,
              createdAt: '2026-01-01T00:00:00.000Z',
              token: secret,
            },
          }
        : { status: 200, body: portal([]) }
    )
    const user = userEvent.setup()
    const first = render(<SetupScreen />)
    await screen.findByText(/Set up single sign-on for Acme/)
    expect(document.body.textContent).not.toContain('scimsecretvalue')
    await user.type(screen.getByLabelText('Token name'), 'Okta')
    await user.click(screen.getByRole('button', { name: 'Create a SCIM token' }))
    await screen.findByText(secret)
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'Okta' })
    expect(JSON.stringify({ ...localStorage })).not.toContain('scimsecretvalue')
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('scimsecretvalue')
    expect(window.location.href).not.toContain('scimsecretvalue')
    // Leaving the page loses it; the portal has no way to read it back.
    first.unmount()
    resetSetup()
    openAt(`#token=${TOKEN}`)
    render(<SetupScreen />)
    await screen.findByText(/Set up single sign-on for Acme/)
    expect(document.body.textContent).not.toContain('scimsecretvalue')
    spy.mockRestore()
  })

  test('a call without a held token is refused before any request', async () => {
    const { calls, spy } = stubFetch(() => ({ status: 200, body: {} }))
    await expect(setupRequest('')).rejects.toMatchObject({ code: 'auth.invalid_key' })
    expect(calls).toHaveLength(0)
    spy.mockRestore()
  })
})
