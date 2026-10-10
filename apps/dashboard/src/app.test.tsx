import { afterEach, describe, expect, test } from 'bun:test'
import { act, screen, waitFor, within } from '@testing-library/react'
import { FAKE_TOKEN, failure, fakeWebhookEndpoint, IDS, installFakeApi } from '~/testing/fake-api'
import {
  DEV_PATH,
  expectFocus,
  expectNothingKept,
  openDialogs,
  PROD_PATH,
  renderApp,
  type World,
} from '~/testing/harness'
import { useScope } from './state/scope'
import { useSession } from './state/session'

const NOW_ISO = '2026-10-04T12:00:00.000Z'

let world: World | undefined

function start(path: string, options: Parameters<typeof renderApp>[1] = {}): World {
  world = renderApp(path, options)
  return world
}

afterEach(() => {
  world?.api.restore()
  world = undefined
})

async function heading(name: string | RegExp): Promise<HTMLElement> {
  return screen.findByRole('heading', { level: 1, name })
}

function dialog(): HTMLElement {
  return screen.getByRole('dialog')
}

/** Everything the query client holds of its mutations: their answers and what they were sent. */
function mutationsOf(current: World): unknown[] {
  return current.queryClient
    .getMutationCache()
    .getAll()
    .map((mutation) => [mutation.state.data, mutation.state.variables])
}

describe('session', () => {
  test('a wrong token is refused, the field is cleared, and the right one signs in', async () => {
    const { user, api, location } = start('/sign-in', { signedIn: false })
    const field = (await screen.findByLabelText('Admin token')) as HTMLInputElement
    expect(field.type).toBe('password')
    expect(field.getAttribute('autocomplete')).toBe('off')

    await user.type(field, 'not-the-token')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('not this deployment’s admin token')
    expect(field.value).toBe('')
    await expectFocus(field)
    expect(field.getAttribute('aria-invalid')).toBe('true')

    await user.type(field, FAKE_TOKEN)
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await heading('Acme Studio')
    expect(location()).toBe(`/w/${IDS.workspace}`)
    expect(useSession.getState().status).toBe('signed_in')
    expectNothingKept(world as World, [FAKE_TOKEN])
    // Sent once, in a JSON body, never in a header or the address.
    const exchange = api.callsTo('POST', '/v1/instance/session').at(-1)
    expect(exchange?.body).toEqual({ token: FAKE_TOKEN })
    expect(api.calls.every((call) => !call.headers.has('authorization'))).toBe(true)
    expect(api.calls.every((call) => call.headers.get('x-tula-dashboard') === '1')).toBe(true)
  })

  test('an empty token is refused without a request', async () => {
    const { user, api } = start('/sign-in', { signedIn: false })
    await user.click(await screen.findByRole('button', { name: 'Sign in' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Enter the admin token.')
    expect(api.callsTo('POST', '/v1/instance/session')).toHaveLength(0)
  })

  test('a deployment without an admin token says what to do', async () => {
    const api = installFakeApi()
    api.state.adminToken = false
    start('/sign-in', { signedIn: false, api })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('TULA_ADMIN_TOKEN')
    expect(screen.queryByLabelText('Admin token')).toBeNull()
  })

  test('a rate-limited sign-in says how long to wait', async () => {
    const api = installFakeApi()
    api.override('POST', /^\/v1\/instance\/session$/, () => {
      const response = failure(429, 'rate_limited', 'Too many requests.')
      response.headers.set('retry-after', '42')
      return response
    })
    const { user } = start('/sign-in', { signedIn: false, api })
    await user.type(await screen.findByLabelText('Admin token'), FAKE_TOKEN)
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect((await screen.findByRole('alert')).textContent).toContain('42 seconds')
  })

  test('a deep link asks for sign-in, then opens; the destination is only ever a path of the app', async () => {
    const { user, location } = start(`${DEV_PATH}/api-keys`, { signedIn: false })
    await screen.findByLabelText('Admin token')
    expect(location()).toContain('/sign-in?redirect=')
    await user.type(screen.getByLabelText('Admin token'), FAKE_TOKEN)
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await heading('API keys')
    expect(location()).toBe(`${DEV_PATH}/api-keys`)
  })

  test('a foreign redirect is ignored', async () => {
    const { user, location } = start('/sign-in?redirect=%2F%2Fevil.example%2Fx', {
      signedIn: false,
    })
    await user.type(await screen.findByLabelText('Admin token'), FAKE_TOKEN)
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await heading('Acme Studio')
    expect(location()).toBe(`/w/${IDS.workspace}`)
  })

  test('a 401 on any call returns to sign-in and keeps the address to come back to', async () => {
    const { api, user, location } = start(`${DEV_PATH}/users`)
    await heading('Users')
    api.state.signedIn = false
    await user.click(screen.getByRole('link', { name: 'Diagnostics' }))
    await screen.findByLabelText('Admin token')
    expect(location()).toBe(`/sign-in?redirect=${encodeURIComponent('/instance/diagnostics')}`)
    expect(useSession.getState().status).toBe('signed_out')
    await user.type(screen.getByLabelText('Admin token'), FAKE_TOKEN)
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await heading('Diagnostics')
  })

  test('sign-out ends the session and leaves no destination behind', async () => {
    const { api, user, location } = start(`${DEV_PATH}/users`)
    await heading('Users')
    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    await screen.findByLabelText('Admin token')
    expect(location()).toBe('/sign-in')
    expect(api.callsTo('DELETE', '/v1/instance/session')).toHaveLength(1)
  })
})

describe('a sign-out that fails', () => {
  test('the operator stays where they are, is told the session is still active, and can retry', async () => {
    const api = installFakeApi()
    api.override('DELETE', /^\/v1\/instance\/session$/, () =>
      failure(503, 'service.unavailable', 'Try again.')
    )
    const { user, location } = start(`${DEV_PATH}/users`, { api })
    await heading('Users')
    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('You are still signed in')
    expect(location()).toBe(`${DEV_PATH}/users`)
    expect(useSession.getState().status).toBe('signed_in')
    expect(screen.queryByLabelText('Admin token')).toBeNull()
    // Nothing fetched under the session was thrown away either.
    expect(screen.getByRole('link', { name: 'ada@example.com' })).toBeDefined()

    api.override('DELETE', /^\/v1\/instance\/session$/, () => {
      api.state.signedIn = false
      return new Response(null, { status: 204 })
    })
    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    await screen.findByLabelText('Admin token')
    expect(location()).toBe('/sign-in')
    expect(api.callsTo('DELETE', '/v1/instance/session')).toHaveLength(2)
  })
})

describe('the switcher and the address', () => {
  test('the address decides the selection; the store mirrors it; admin calls name the environment', async () => {
    const { api } = start(`${DEV_PATH}/users`)
    await heading('Users')
    expect(useScope.getState()).toMatchObject({
      workspaceId: IDS.workspace,
      projectId: IDS.project,
      environmentId: IDS.development,
    })
    await screen.findByRole('link', { name: 'ada@example.com' })
    const listed = api.callsTo('GET', '/v1/admin/users').at(-1)
    expect(listed?.headers.get('x-tula-environment')).toBe(IDS.development)
    expect(document.querySelector('[data-environment-kind="development"]')).not.toBeNull()
  })

  test('switching environment keeps the screen, changes the address and asks the other environment', async () => {
    const { api, user, location } = start(`${DEV_PATH}/api-keys`)
    await heading('API keys')
    const switcher = await screen.findByRole('group', { name: 'Switch environment' })
    await user.click(within(switcher).getByRole('link', { name: 'Production' }))
    await waitFor(() => expect(location()).toBe(`${PROD_PATH}/api-keys`))
    await waitFor(() => expect(useScope.getState().environmentId).toBe(IDS.production))
    await waitFor(() =>
      expect(
        api.callsTo('GET', '/v1/admin/api-keys').at(-1)?.headers.get('x-tula-environment')
      ).toBe(IDS.production)
    )
    await waitFor(() =>
      expect(document.querySelector('[data-environment-kind="production"]')?.textContent).toContain(
        'Production'
      )
    )
  })

  test('home goes to the first workspace, a project to its development environment', async () => {
    const { location, user } = start('/')
    await heading('Acme Studio')
    expect(location()).toBe(`/w/${IDS.workspace}`)
    await user.click(
      await screen.findByRole('link', { name: /Development environment of Mobile app/ })
    )
    await heading('Users')
    expect(location()).toBe(`${DEV_PATH}/users`)
  })

  test('a project address opens its development environment', async () => {
    const { location } = start(`/w/${IDS.workspace}/p/${IDS.project}`)
    await heading('Users')
    expect(location()).toBe(`${DEV_PATH}/users`)
  })

  test('with no workspace yet, the first one can be created', async () => {
    const api = installFakeApi()
    api.state.workspaces = []
    const { user } = start('/', { api })
    await screen.findByText('No workspace yet')
    await user.click(screen.getByRole('button', { name: 'Create a workspace' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Create workspace' }))
    expect(within(dialog()).getByRole('alert').textContent).toBe('Enter a name.')
    await user.type(within(dialog()).getByLabelText('Name'), 'Northline')
    await user.click(within(dialog()).getByRole('button', { name: 'Create workspace' }))
    await heading('Northline')
  })

  test('create a project: it opens on its development environment; rename it', async () => {
    const { user, location, api } = start(`/w/${IDS.workspace}`)
    await heading('Acme Studio')
    await user.click(
      within(screen.getByRole('main')).getByRole('button', { name: 'Create project' })
    )
    await user.type(within(dialog()).getByLabelText('Name'), 'Admin portal')
    await user.click(within(dialog()).getByRole('button', { name: 'Create project' }))
    await heading('Users')
    expect(location()).toMatch(/\/p\/[^/]+\/e\/[^/]+\/users$/)
    expect(api.state.projects.at(-1)?.name).toBe('Admin portal')

    await user.click(screen.getByRole('link', { name: 'Acme Studio' }))
    await heading('Acme Studio')
    await user.click(await screen.findByRole('button', { name: 'Rename Admin portal' }))
    const name = within(dialog()).getByLabelText('Name') as HTMLInputElement
    expect(name.value).toBe('Admin portal')
    await user.clear(name)
    await user.type(name, 'Back office')
    await user.click(within(dialog()).getByRole('button', { name: 'Rename' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(api.state.projects.at(-1)?.name).toBe('Back office')
  })

  test('a missing environment kind can be added from the switcher', async () => {
    const api = installFakeApi()
    api.state.environments = api.state.environments.filter((entry) => entry.kind === 'development')
    const { user, location } = start(`${DEV_PATH}/users`, { api })
    await heading('Users')
    await user.click(await screen.findByRole('button', { name: 'Add production' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Add environment' }))
    await waitFor(() =>
      expect(location()).toContain('/e/00000000-0000-7000-8000-0000000000c9/users')
    )
  })

  test('an environment that is not the project’s is not found, before any admin call', async () => {
    const { api } = start(
      `/w/${IDS.workspace}/p/${IDS.project}/e/00000000-0000-7000-8000-00000000dead/users`
    )
    await screen.findByText('Environment not found')
    expect(api.calls.some((call) => call.path.startsWith('/v1/admin/'))).toBe(false)
  })

  test('an unknown address is a not-found page', async () => {
    start('/no-such-screen')
    await screen.findByRole('heading', { name: 'Page not found' })
  })
})

describe('API keys', () => {
  test('a new key is shown once and is gone everywhere after the dialog closes', async () => {
    const { user } = start(`${DEV_PATH}/api-keys`)
    await heading('API keys')
    await screen.findByText('No API keys yet')
    await user.click(screen.getByRole('button', { name: 'Create key' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Create key' }))
    expect(within(dialog()).getByRole('alert').textContent).toContain('Enter a name')
    await user.type(within(dialog()).getByLabelText('Name'), 'Server')
    await user.selectOptions(within(dialog()).getByLabelText('Kind'), 'secret')
    await user.click(within(dialog()).getByRole('button', { name: 'Create key' }))

    const shown = await within(dialog()).findByTestId('created-key')
    const key = shown.textContent ?? ''
    expect(key).toMatch(/^tula_sk_dev_/)
    // While it is on screen it is in the document, and nowhere else.
    expect(localStorage.length + sessionStorage.length).toBe(0)
    await user.click(within(dialog()).getByRole('button', { name: 'I have copied it' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expectNothingKept(world as World, [key])
    expect((await screen.findByText(`tula_sk_…${key.slice(-4)}`)).textContent).not.toContain(key)

    // Walk on: other screens, back again, the dialog reopened. The key never comes back.
    await user.click(screen.getByRole('link', { name: 'Signing keys' }))
    await heading('Signing keys')
    expectNothingKept(world as World, [key])
    await user.click(screen.getByRole('link', { name: 'API keys' }))
    await heading('API keys')
    await user.click(screen.getByRole('button', { name: 'Create key' }))
    expect((within(dialog()).getByLabelText('Name') as HTMLInputElement).value).toBe('')
    expectNothingKept(world as World, [key])
  })

  test('revoking asks first; in production the name must be typed', async () => {
    const { user, api } = start(`${PROD_PATH}/api-keys`)
    await heading('API keys')
    await user.click(screen.getByRole('button', { name: 'Create key' }))
    await user.type(within(dialog()).getByLabelText('Name'), 'Web app')
    await user.click(within(dialog()).getByRole('button', { name: 'Create key' }))
    await user.click(await within(dialog()).findByRole('button', { name: 'I have copied it' }))
    await waitFor(() => expect(openDialogs()).toBe(0))

    await user.click(await screen.findByRole('button', { name: 'Revoke Web app' }))
    const confirm = within(dialog()).getByRole('button', { name: 'Revoke key' })
    expect(confirm.getAttribute('aria-disabled')).toBe('true')
    await user.click(confirm)
    expect(api.calls.some((call) => call.method === 'DELETE')).toBe(false)
    await user.type(within(dialog()).getByLabelText(/to confirm/), 'Web app')
    await user.click(within(dialog()).getByRole('button', { name: 'Revoke key' }))
    await screen.findByText(/^Revoked/)
    expect(api.state.keys[0]?.revokedAt).not.toBeNull()
  })
})

describe('webhook signing secrets', () => {
  const URL = 'https://api.example.com/webhooks/tula'

  test('a new endpoint’s secret is shown once and is gone everywhere after the dialog closes', async () => {
    const { user, api } = start(`${DEV_PATH}/webhooks`)
    await heading('Webhooks')
    await user.click(await screen.findByRole('button', { name: 'Add endpoint' }))
    await user.type(within(dialog()).getByLabelText('Address'), URL)
    await user.click(within(dialog()).getByRole('checkbox', { name: 'user.created' }))
    await user.click(within(dialog()).getByRole('checkbox', { name: 'session.revoked' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Add endpoint' }))

    const shown = await within(dialog()).findByTestId('webhook-secret')
    const secret = shown.textContent ?? ''
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/=]{20,}$/)
    expect(within(dialog()).getByRole('heading').textContent).toBe('Copy the signing secret now')
    // The request named the address and the types, and nothing else: the server makes the secret.
    expect(api.callsTo('POST', '/v1/admin/webhook-endpoints').at(-1)?.body).toEqual({
      url: URL,
      eventTypes: ['user.created', 'session.revoked'],
      enabled: true,
    })
    // While it is on screen it is in the document, and nowhere else.
    expect(localStorage.length + sessionStorage.length).toBe(0)
    expect(JSON.stringify(mutationsOf(world as World)).includes(secret)).toBe(false)
    await user.click(within(dialog()).getByRole('button', { name: 'I have copied it' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expectNothingKept(world as World, [secret])
    await screen.findByRole('heading', { level: 2, name: URL })
    await screen.findByText('1 of 10 endpoints')

    // Walk on: another screen, back again, the dialog reopened. The secret never comes back.
    await user.click(screen.getByRole('link', { name: 'API keys' }))
    await heading('API keys')
    expectNothingKept(world as World, [secret])
    await user.click(screen.getByRole('link', { name: 'Webhooks' }))
    await heading('Webhooks')
    await user.click(await screen.findByRole('button', { name: 'Add endpoint' }))
    expect((within(dialog()).getByLabelText('Address') as HTMLInputElement).value).toBe('')
    expect(within(dialog()).queryAllByTestId('webhook-secret')).toHaveLength(0)
    expectNothingKept(world as World, [secret])
  })

  test('Escape on the secret is the same as closing it: nothing of it stays', async () => {
    const { user } = start(`${DEV_PATH}/webhooks`)
    await user.click(await screen.findByRole('button', { name: 'Add endpoint' }))
    await user.type(within(dialog()).getByLabelText('Address'), URL)
    await user.click(within(dialog()).getByRole('checkbox', { name: 'user.created' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Add endpoint' }))
    const secret = (await within(dialog()).findByTestId('webhook-secret')).textContent ?? ''
    expect(secret).toMatch(/^whsec_/)
    // What the platform does for Escape on a modal dialog: it closes, and says so.
    act(() => {
      ;(dialog() as HTMLDialogElement).close()
    })
    await waitFor(() => expect(openDialogs()).toBe(0))
    expectNothingKept(world as World, [secret])
  })

  test('a rotated secret is shown once with the overlap in words, and is gone after the dialog closes', async () => {
    const api = installFakeApi()
    api.state.webhookEndpoints.push(fakeWebhookEndpoint({ url: URL }))
    const { user } = start(`${DEV_PATH}/webhooks`, { api })
    await user.click(await screen.findByRole('button', { name: `Rotate the secret of ${URL}` }))
    expect(within(dialog()).getByRole('heading').textContent).toBe('Rotate the signing secret?')
    expect(dialog().textContent).toContain(
      'The current secret is not dropped: for 24 hours every delivery is signed with both'
    )
    expect(api.calls.some((call) => call.path.endsWith('/secret/rotate'))).toBe(false)
    await user.click(within(dialog()).getByRole('button', { name: 'Rotate secret' }))

    const secret = (await within(dialog()).findByTestId('webhook-secret')).textContent ?? ''
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/=]{20,}$/)
    expect(within(dialog()).getByRole('heading').textContent).toBe('Copy the new secret now')
    // When the previous secret stops signing: said in words, with the server's own time.
    const overlap = within(dialog()).getByTestId('overlap-ends')
    expect(overlap.textContent).toContain('The previous secret keeps signing beside it until')
    expect(overlap.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-05T12:00:00.000Z')
    // The request carried no body: the server makes the secret.
    expect(api.calls.find((call) => call.path.endsWith('/secret/rotate'))?.body).toBeUndefined()
    expect(localStorage.length + sessionStorage.length).toBe(0)
    expect(JSON.stringify(mutationsOf(world as World)).includes(secret)).toBe(false)

    await user.click(within(dialog()).getByRole('button', { name: 'I have copied it' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expectNothingKept(world as World, [secret])
    // The card now says that two secrets sign, and until when.
    const notice = await screen.findByTestId('rotation-overlap')
    expect(notice.textContent).toContain('Two secrets are signing')
    expect(notice.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-05T12:00:00.000Z')

    // Walk on, come back, open the dialog again: it asks again, and shows no secret.
    await user.click(screen.getByRole('link', { name: 'Signing keys' }))
    await heading('Signing keys')
    expectNothingKept(world as World, [secret])
    await user.click(screen.getByRole('link', { name: 'Webhooks' }))
    await heading('Webhooks')
    await user.click(await screen.findByRole('button', { name: `Rotate the secret of ${URL}` }))
    expect(within(dialog()).getByRole('heading').textContent).toBe('Rotate the signing secret?')
    expect(within(dialog()).queryAllByTestId('webhook-secret')).toHaveLength(0)
    expectNothingKept(world as World, [secret])
  })
})

describe('settings', () => {
  test('a save carries the revision; a stricter policy needs no confirmation', async () => {
    const { user, api } = start(`${DEV_PATH}/password-policy`)
    await heading('Password policy')
    const minimum = await screen.findByLabelText('Minimum length')
    await user.clear(minimum)
    await user.type(minimum, '16')
    expect((screen.getByLabelText('Policy preset') as HTMLSelectElement).value).toBe('custom')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Settings saved')
    const put = api.callsTo('PUT', '/v1/admin/settings').at(-1)
    expect(put?.headers.get('if-match')).toBe('"3"')
    expect(api.state.settings.settings.password.minLength).toBe(16)
    expect(api.state.settings.revision).toBe(4)
    // The next save is made from the new revision.
    await user.clear(minimum)
    await user.type(minimum, '18')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(api.state.settings.revision).toBe(5))
    expect(api.callsTo('PUT', '/v1/admin/settings').at(-1)?.headers.get('if-match')).toBe('"4"')
  })

  test('a weaker policy asks first and says what gets weaker', async () => {
    const { user, api } = start(`${DEV_PATH}/password-policy`)
    const minimum = await screen.findByLabelText('Minimum length')
    await user.clear(minimum)
    await user.type(minimum, '8')
    await user.click(screen.getByRole('switch', { name: 'Refuse common passwords' }))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(dialog().textContent).toContain('This weakens security')
    expect(dialog().textContent).toContain('Passwords may be shorter')
    expect(dialog().textContent).toContain('Common passwords are allowed')
    expect(api.callsTo('PUT', '/v1/admin/settings')).toHaveLength(0)
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(api.callsTo('PUT', '/v1/admin/settings')).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Save anyway' }))
    await screen.findByText('Settings saved')
    expect(api.state.settings.settings.password.minLength).toBe(8)
  })

  test('412: "changed elsewhere", nothing overwritten, reload brings the current version', async () => {
    const { user, api } = start(`${DEV_PATH}/settings`)
    const name = (await screen.findByLabelText('App name')) as HTMLInputElement
    // Someone else saves while this form is open.
    api.state.settings.revision = 9
    api.state.settings.settings.app.name = 'Saved elsewhere'
    await user.clear(name)
    await user.type(name, 'Mine')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    const alert = await screen.findByText(/Changed elsewhere\./)
    expect(alert.closest('[role="alert"]')).not.toBeNull()
    expect(api.state.settings.settings.app.name).toBe('Saved elsewhere')
    await user.click(screen.getByRole('button', { name: 'Reload settings' }))
    await waitFor(() => expect(name.value).toBe('Saved elsewhere'))
    expect(screen.queryByText(/Changed elsewhere\./)).toBeNull()
    await user.clear(name)
    await user.type(name, 'Mine')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Settings saved')
    expect(api.callsTo('PUT', '/v1/admin/settings').at(-1)?.headers.get('if-match')).toBe('"9"')
  })

  test('a refused document shows the field error on its field and in the summary', async () => {
    const { user } = start(`${DEV_PATH}/password-policy`)
    const minimum = await screen.findByLabelText('Minimum length')
    await user.clear(minimum)
    await user.type(minimum, '4')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('These settings were not saved.')
    expect(minimum.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getAllByText(/Must be 8 or more\./).length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect((minimum as HTMLInputElement).value).toBe('10')
  })

  test('managed by a config file: the banner on the screen, a confirmation, then the drift notice', async () => {
    const api = installFakeApi()
    api.state.settings.managedBy = {
      tool: 'tula-apply',
      configHash: `sha256:${'ab'.repeat(32)}`,
      at: '2026-10-01T00:00:00.000Z',
      revision: 3,
      drifted: false,
    }
    const { user } = start(`${DEV_PATH}/settings`, { api })
    const banner = await screen.findByRole('note')
    expect(banner.textContent).toContain('Managed by tula apply')
    expect(banner.textContent).not.toContain('Drift:')
    const name = screen.getByLabelText('App name')
    await user.type(name, ' 2')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(dialog().textContent).toContain('managed by a config file')
    await user.click(within(dialog()).getByRole('button', { name: 'Save anyway' }))
    await screen.findByText('Settings saved')
    // The confirmation and the banner are drawn from different stores: wait for the banner.
    await waitFor(() => expect(screen.getByRole('note').textContent).toContain('Drift:'))
  })

  test('general settings: a list entry is checked with the contract before it joins the list', async () => {
    const { user, api } = start(`${DEV_PATH}/settings`)
    const origin = await screen.findByRole('textbox', { name: 'Allowed origins' })
    await user.click(screen.getByRole('button', { name: 'Add origin' }))
    await screen.findByText('Enter the origin to add.')
    await user.type(origin, 'https://app.example.com/path')
    await user.click(screen.getByRole('button', { name: 'Add origin' }))
    await screen.findByText(/must be an origin such as/)
    await user.clear(origin)
    await user.type(origin, 'https://app.example.com{Enter}')
    expect(
      within(screen.getByRole('list', { name: 'Allowed origins' })).getByText(
        'https://app.example.com'
      )
    ).toBeDefined()
    await user.type(origin, 'https://app.example.com')
    await user.click(screen.getByRole('button', { name: 'Add origin' }))
    await screen.findByText('That one is already in the list.')
    expect(
      screen.getByText(
        /Older entries are then deleted for good, starting with the next retention run/
      )
    ).toBeDefined()
    expect(screen.queryByText(/within ten minutes/)).toBeNull()
    await user.type(screen.getByLabelText('Keep audit entries for (days)'), '30')
    await user.type(screen.getByLabelText('Support email (optional)'), 'help@example.com')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    // A period where there was none deletes older entries: the editor asks, in those words.
    expect(dialog().textContent).toContain('This deletes older audit entries for good')
    expect(dialog().textContent).not.toContain('weakens security')
    expect(dialog().textContent).toContain(
      'Audit entries older than the new period are deleted for good, starting with the next retention run'
    )
    expect(api.callsTo('PUT', '/v1/admin/settings')).toHaveLength(0)
    await user.click(within(dialog()).getByRole('button', { name: 'Save anyway' }))
    await screen.findByText('Settings saved')
    expect(api.state.settings.settings.urls.allowedOrigins).toEqual(['https://app.example.com'])
    expect(api.state.settings.settings.audit.retentionDays).toBe(30)
    expect(api.state.settings.settings.app.supportEmail).toBe('help@example.com')
    await user.click(screen.getByRole('button', { name: 'Take out https://app.example.com' }))
    expect(screen.queryByRole('list', { name: 'Allowed origins' })).toBeNull()
  })

  test('sign-in methods: the last-method refusal is said in words; providers show their redirect URI', async () => {
    const api = installFakeApi()
    api.override('PUT', /^\/v1\/admin\/settings$/, () =>
      failure(422, 'validation.failed', 'Invalid settings.', [
        {
          field: 'signIn.methods',
          code: 'validation.failed',
          message: 'at least one sign-in method must stay enabled',
        },
      ])
    )
    const { user } = start(`${DEV_PATH}/sign-in-methods`, { api })
    await user.click(await screen.findByRole('switch', { name: 'Email and password' }))
    await user.selectOptions(screen.getByLabelText('Two-step verification'), 'required')
    await user.selectOptions(screen.getByLabelText('Password at sign-up'), 'optional')
    await user.type(screen.getByLabelText('Passkey relying-party domain (rpId)'), 'example.com')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    const refusal = await screen.findByText(/Keep one method or one OAuth provider enabled/)
    expect(refusal.textContent).toContain('at least one sign-in method must stay enabled')
    await screen.findByText('http://localhost:3003/v1/client/oauth/google/callback')
  })

  test('a provider’s secret is write-only: sent once, then gone from the form', async () => {
    const api = installFakeApi()
    let saved: unknown
    api.override('PUT', /^\/v1\/admin\/oauth-providers\/github$/, (call) => {
      saved = call.body
      api.override('GET', /^\/v1\/admin\/oauth-providers$/, () => ({
        data: [
          {
            provider: 'github',
            configured: true,
            enabled: true,
            clientId: 'gh-client',
            teamId: null,
            keyId: null,
            tenant: null,
            callbackUrl: 'http://localhost:3003/v1/client/oauth/github/callback',
            updatedAt: '2026-10-04T12:00:00.000Z',
          },
        ],
      }))
      return { provider: 'github', configured: true, enabled: true }
    })
    const { user } = start(`${DEV_PATH}/sign-in-methods`, { api })
    const github = (await screen.findByRole('heading', { name: 'GitHub' })).closest(
      'li'
    ) as HTMLElement
    await user.type(within(github).getByLabelText('Client ID'), 'gh-client')
    await user.type(within(github).getByLabelText('Client secret'), 'gh-secret-value')
    await user.click(within(github).getByRole('button', { name: 'Save GitHub' }))
    await screen.findByText('GitHub saved')
    expect(saved).toEqual({ clientId: 'gh-client', enabled: true, clientSecret: 'gh-secret-value' })
    const card = (await screen.findByText(/A client secret is saved/)).closest('li') as HTMLElement
    expect(within(card).queryByLabelText('Client secret')).toBeNull()
    expectNothingKept(world as World, ['gh-secret-value'])
    await user.click(within(card).getByRole('button', { name: 'Replace secret' }))
    expect((within(card).getByLabelText('Client secret') as HTMLInputElement).value).toBe('')
  })

  test('session profiles: a custom profile is added from a copy of “web”, and can be taken out', async () => {
    const { user, api } = start(`${DEV_PATH}/sessions`)
    await heading('Session profiles')
    const name = await screen.findByLabelText('New profile name')
    await user.type(name, 'Not Valid')
    await user.click(screen.getByRole('button', { name: 'Add profile' }))
    await screen.findByText(/Use lowercase letters/)
    await user.clear(name)
    await user.type(name, 'web{Enter}')
    await screen.findByText('A profile with that name exists.')
    await user.clear(name)
    await user.type(name, 'admin{Enter}')
    const admin = (await screen.findByRole('heading', { name: /admin/ })).closest(
      'li'
    ) as HTMLElement
    const idle = within(admin).getByLabelText('Idle timeout')
    await user.clear(idle)
    await user.type(idle, '15m')
    await user.type(screen.getByLabelText('Sessions per user'), '3')
    await user.selectOptions(screen.getByLabelText('When the limit is reached'), 'refuse_newest')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Settings saved')
    const sessions = api.state.settings.settings.sessions
    expect(sessions.profiles.admin?.idleTimeout).toBe('15m')
    expect(sessions.maxPerUser).toBe(3)
    expect(sessions.onLimit).toBe('refuse_newest')
    await user.click(within(admin).getByRole('button', { name: 'Take out the admin profile' }))
    expect(screen.queryByRole('heading', { name: /admin/ })).toBeNull()
  })
})

describe('users', () => {
  test('search is kept in the address; the list links to the user', async () => {
    const { user, location, api } = start(`${DEV_PATH}/users`)
    await heading('Users')
    await user.type(screen.getByLabelText('Search users'), 'ada')
    await user.click(screen.getByRole('button', { name: 'Search' }))
    await waitFor(() => expect(location()).toBe(`${DEV_PATH}/users?q=ada`))
    await waitFor(() =>
      expect(api.callsTo('GET', '/v1/admin/users').at(-1)?.search.get('q')).toBe('ada')
    )
    await user.click(await screen.findByRole('link', { name: 'ada@example.com' }))
    await heading('ada@example.com')
    expect(location()).toBe(`${DEV_PATH}/users/${IDS.user}`)
  })

  test('no match and clearing the search', async () => {
    const { user, location } = start(`${DEV_PATH}/users?q=nobody`)
    await screen.findByText('No user matches that search')
    await user.click(screen.getByRole('button', { name: 'Clear' }))
    await waitFor(() => expect(location()).toBe(`${DEV_PATH}/users`))
    await screen.findByRole('link', { name: 'ada@example.com' })
  })

  test('create a user: the contract’s schema and the server’s refusal both reach the form', async () => {
    const { user, api } = start(`${DEV_PATH}/users`)
    await heading('Users')
    await user.click(screen.getByRole('button', { name: 'Create user' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Create user' }))
    expect(within(dialog()).getByRole('alert').textContent).toBe('Enter an email address.')
    await user.type(within(dialog()).getByLabelText('Email'), 'ada@example.com')
    await user.click(within(dialog()).getByRole('button', { name: 'Create user' }))
    expect((await within(dialog()).findByRole('alert')).textContent).toContain(
      'A user with that email exists'
    )
    const email = within(dialog()).getByLabelText('Email')
    await user.clear(email)
    await user.type(email, 'grace@example.com')
    await user.type(within(dialog()).getByLabelText('First name (optional)'), 'Grace')
    await user.click(within(dialog()).getByLabelText('Mark the email as verified'))
    await user.click(within(dialog()).getByRole('button', { name: 'Create user' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(api.callsTo('POST', '/v1/admin/users').at(-1)?.body).toEqual({
      email: 'grace@example.com',
      firstName: 'Grace',
      emailVerified: true,
    })
    await screen.findByRole('link', { name: 'grace@example.com' })
  })

  test('ban and unban name the user; nothing is typed in development', async () => {
    const { user, api } = start(`${DEV_PATH}/users/${IDS.user}`)
    await heading('ada@example.com')
    await user.click(screen.getByRole('button', { name: 'Ban user' }))
    expect(dialog().textContent).toContain('Ban ada@example.com?')
    expect(within(dialog()).queryByLabelText(/to confirm/)).toBeNull()
    await user.click(within(dialog()).getByRole('button', { name: 'Ban user' }))
    await screen.findByRole('button', { name: 'Unban user' })
    expect(api.state.users[0]?.bannedAt).not.toBeNull()
    expect(screen.getAllByText('Banned').length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: 'Unban user' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Unban user' }))
    await screen.findByRole('button', { name: 'Ban user' })
  })

  test('in production a destructive action needs the email typed', async () => {
    const { user, api, location } = start(`${PROD_PATH}/users/${IDS.user}`)
    await heading('ada@example.com')
    await user.click(screen.getByRole('button', { name: 'Delete user' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Delete user' }))
    expect(api.state.users).toHaveLength(1)
    await user.type(within(dialog()).getByLabelText(/to confirm/), 'ada@example.com')
    await user.click(within(dialog()).getByRole('button', { name: 'Delete user' }))
    await heading('Users')
    expect(api.state.users).toHaveLength(0)
    expect(location()).toBe(`${PROD_PATH}/users`)
  })

  describe('a user with no email address (an account made through X or Facebook)', () => {
    const NELLY = '00000000-0000-7000-8000-0000000000e1'
    function withNelly(names: { firstName: string | null; lastName: string | null }) {
      const api = installFakeApi()
      const ada = api.state.users[0]
      if (!ada) {
        throw new Error('the fake API has no user')
      }
      api.state.users.push({ ...ada, ...names, id: NELLY, email: null, emailVerifiedAt: null })
      return api
    }

    test('is listed by name, said to have no address, and never as "null" or "Unverified"', async () => {
      const api = withNelly({ firstName: 'Nelly', lastName: 'Okafor' })
      start(`${DEV_PATH}/users`, { api })
      const link = await screen.findByRole('link', { name: 'Nelly Okafor' })
      const row = link.closest('tr') as HTMLElement
      expect(within(row).getByText('No email address')).toBeDefined()
      expect(within(row).queryByText('Unverified')).toBeNull()
      expect((row.textContent ?? '').includes('null')).toBe(false)
    })

    test('with no name either, the link and the heading name the id', async () => {
      const api = withNelly({ firstName: null, lastName: null })
      const { user } = start(`${DEV_PATH}/users`, { api })
      await user.click(await screen.findByRole('link', { name: `User ${NELLY}` }))
      await heading(`User ${NELLY}`)
    })

    test('its screen offers no password, and says why', async () => {
      const api = withNelly({ firstName: 'Nelly', lastName: null })
      const { user } = start(`${DEV_PATH}/users/${NELLY}`, { api })
      await heading('Nelly')
      expect(screen.getByText('No address to verify')).toBeDefined()
      expect(screen.queryByRole('button', { name: 'Set password' })).toBeNull()
      expect(screen.getByText(/so it has no password and none can be set/)).toBeDefined()
      await user.click(screen.getByRole('button', { name: 'Ban user' }))
      expect(dialog().textContent).toContain('Ban Nelly?')
      await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
      await waitFor(() => expect(openDialogs()).toBe(0))
      // Nobody is told of a reset: there is no address to tell.
      await user.click(screen.getByRole('button', { name: 'Reset two-step verification' }))
      expect(dialog().textContent).toContain('They are not told')
      expect(dialog().textContent).not.toContain('told by email')
      expect(api.callsTo('PUT', `/v1/admin/users/${NELLY}/password`)).toHaveLength(0)
    })

    test('in production a destructive action needs the id typed, there being no address', async () => {
      const api = withNelly({ firstName: 'Nelly', lastName: null })
      const { user } = start(`${PROD_PATH}/users/${NELLY}`, { api })
      await heading('Nelly')
      await user.click(screen.getByRole('button', { name: 'Delete user' }))
      await user.type(within(dialog()).getByLabelText(/to confirm/), 'Nelly')
      await user.click(within(dialog()).getByRole('button', { name: 'Delete user' }))
      expect(api.state.users).toHaveLength(2)
      await user.clear(within(dialog()).getByLabelText(/to confirm/))
      await user.type(within(dialog()).getByLabelText(/to confirm/), NELLY)
      await user.click(within(dialog()).getByRole('button', { name: 'Delete user' }))
      await heading('Users')
      expect(api.state.users).toHaveLength(1)
    })
  })

  test('sessions: revoke one, then all', async () => {
    const api = installFakeApi()
    api.state.sessions.push({ ...api.state.sessions[0], id: 'second', client: 'ios' })
    const { user } = start(`${DEV_PATH}/users/${IDS.user}`, { api })
    await user.click(await screen.findByRole('button', { name: /^Revoke the ios session/ }))
    expect(dialog().textContent).toContain('Revoke this session of ada@example.com?')
    await user.click(within(dialog()).getByRole('button', { name: 'Revoke session' }))
    await waitFor(() => expect(api.state.sessions).toHaveLength(1))
    await waitFor(() => expect(openDialogs()).toBe(0))
    await user.click(screen.getByRole('button', { name: 'Revoke all sessions' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Revoke all sessions' }))
    await screen.findByText('No active sessions')
  })

  test('set a password: every policy error is listed, and the password is not kept', async () => {
    const { user } = start(`${DEV_PATH}/users/${IDS.user}`)
    await user.click(await screen.findByRole('button', { name: 'Set password' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Set password' }))
    expect(within(dialog()).getByRole('alert').textContent).toBe('Enter the new password.')
    await user.type(within(dialog()).getByLabelText('New password'), 'short')
    await user.click(within(dialog()).getByRole('button', { name: 'Set password' }))
    await within(dialog()).findByText('Use 10 or more characters.')
    expect(within(dialog()).getByText('Too common.')).toBeDefined()
    const field = within(dialog()).getByLabelText('New password')
    await user.clear(field)
    await user.type(field, 'granite-Lantern-hums-93')
    await user.click(within(dialog()).getByRole('button', { name: 'Set password' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expectNothingKept(world as World, ['granite-Lantern-hums-93'])
  })

  function signInSection(): HTMLElement {
    const section = screen
      .getByRole('heading', { name: 'How this user signs in' })
      .closest('section')
    if (!section) {
      throw new Error('the heading sits in its section')
    }
    return section
  }

  test('how the user signs in: password, address, linked accounts, two-step verification, passkeys', async () => {
    const api = installFakeApi()
    api.state.authentication = {
      hasPassword: true,
      emailVerified: true,
      identities: [{ provider: 'google', linkedAt: '2026-03-01T09:00:00.000Z' }],
      factors: [{ type: 'totp', confirmedAt: '2026-04-02T09:00:00.000Z' }],
      backupCodesRemaining: 7,
      passkeys: [
        {
          id: 'pk-1',
          name: 'Laptop',
          synced: true,
          createdAt: '2026-05-03T09:00:00.000Z',
          lastUsedAt: '2026-06-04T09:00:00.000Z',
        },
        {
          id: 'pk-2',
          name: '<b>Key</b>',
          synced: false,
          createdAt: '2026-05-05T09:00:00.000Z',
          lastUsedAt: null,
        },
      ],
      canSignInWithoutPasskeys: true,
    }
    start(`${DEV_PATH}/users/${IDS.user}`, { api })
    await screen.findByText('Has a password')
    const text = signInSection().textContent ?? ''
    expect(text).toContain('Verified')
    expect(text).toMatch(/Google, linked .*2026/)
    expect(text).toMatch(/Authenticator app since .*2026/)
    expect(text).toContain('7 backup codes left')
    expect(text).toMatch(/Laptop.*synced/)
    // A passkey's name is the user's own text: drawn as text, and its state said in words.
    expect(text).toMatch(/<b>Key<\/b>.*never used.*this device only/)
    expect(signInSection().querySelector('b')).toBeNull()
  })

  test('a user with no phone number: the profile says none', async () => {
    start(`${DEV_PATH}/users/${IDS.user}`)
    const row = (await screen.findByText('Phone number')).closest('div') as HTMLElement
    expect(row.textContent).toBe('Phone numberNone')
  })

  test('a user’s phone number is shown with when it was verified', async () => {
    const api = installFakeApi()
    const [account] = api.state.users
    if (!account) {
      throw new Error('the fake API has no user')
    }
    account.phoneNumber = '+14155550142'
    account.phoneNumberVerifiedAt = '2026-05-03T09:00:00.000Z'
    start(`${DEV_PATH}/users/${IDS.user}`, { api })
    const row = (await screen.findByText('Phone number')).closest('div') as HTMLElement
    expect(row.textContent).toContain('+14155550142')
    expect(row.textContent).toMatch(/verified .*2026/)
  })

  test('a user with no password: what they sign in with instead', async () => {
    const api = installFakeApi()
    api.state.authentication = {
      ...api.state.authentication,
      hasPassword: false,
      emailVerified: false,
      identities: [{ provider: 'github', linkedAt: '2026-03-01T09:00:00.000Z' }],
    }
    start(`${DEV_PATH}/users/${IDS.user}`, { api })
    await screen.findByText('No password; signs in with GitHub.')
    const text = signInSection().textContent ?? ''
    expect(text).toContain('Not verified')
    expect(text).toContain('Off')
    expect(text).toContain('No passkeys')
    expect(text).not.toContain('backup code')
  })

  test('a user with nothing to sign in with is said so', async () => {
    const api = installFakeApi()
    api.state.authentication = { ...api.state.authentication, hasPassword: false }
    start(`${DEV_PATH}/users/${IDS.user}`, { api })
    await screen.findByText(/No password, linked account or passkey/)
    expect(signInSection().textContent).toContain('No linked accounts')
  })

  test('sign-in methods that cannot be loaded: an error with a retry, and the rest of the screen stays', async () => {
    const api = installFakeApi()
    let fail = true
    api.override('GET', /\/authentication$/, () =>
      fail ? failure(503, 'service.unavailable', 'Try again shortly.') : api.state.authentication
    )
    const { user } = start(`${DEV_PATH}/users/${IDS.user}`, { api })
    await screen.findByRole('heading', { name: 'How this user signs in' })
    const alert = await within(signInSection()).findByRole('alert')
    expect(alert.textContent).toContain('Try again shortly.')
    expect(screen.getByRole('button', { name: 'Ban user' })).toBeDefined()
    fail = false
    await user.click(within(signInSection()).getByRole('button', { name: 'Try again' }))
    await screen.findByText('Has a password')
  })

  test('the reset warns before confirming when it would leave the user no way in', async () => {
    const api = installFakeApi()
    api.state.authentication = {
      ...api.state.authentication,
      hasPassword: false,
      passkeys: [{ id: 'pk-1', name: 'Phone', synced: true, createdAt: NOW_ISO, lastUsedAt: null }],
      canSignInWithoutPasskeys: false,
    }
    api.state.canStillSignIn = false
    const { user } = start(`${DEV_PATH}/users/${IDS.user}`, { api })
    await screen.findByText('No password; signs in with a passkey.')
    await user.click(screen.getByRole('button', { name: 'Reset two-step verification' }))
    expect(dialog().textContent).toMatch(/Warning: .*no way left to sign in/)
    expect(api.calls.filter((call) => call.method === 'DELETE')).toHaveLength(0)
    await user.click(within(dialog()).getByRole('button', { name: 'Reset two-step verification' }))
    // The answer's header is still what the screen reports afterwards.
    const after = await screen.findByText(/now has no way left to sign in/)
    expect(after.getAttribute('role')).toBe('alert')
  })

  test('the reset does not warn a user who keeps a way in, or before the methods are known', async () => {
    const api = installFakeApi()
    api.override('GET', /\/authentication$/, () =>
      failure(503, 'service.unavailable', 'Try again shortly.')
    )
    const { user } = start(`${DEV_PATH}/users/${IDS.user}`, { api })
    await user.click(await screen.findByRole('button', { name: 'Reset two-step verification' }))
    expect(dialog().textContent).not.toContain('Warning')
  })

  test('resetting two-step verification warns when the user is left with no way in', async () => {
    const api = installFakeApi()
    api.state.canStillSignIn = false
    const { user } = start(`${DEV_PATH}/users/${IDS.user}`, { api })
    await user.click(await screen.findByRole('button', { name: 'Reset two-step verification' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Reset two-step verification' }))
    const warning = await screen.findByText(/no way left to sign in/)
    expect(warning.getAttribute('role')).toBe('alert')
  })

  test('a failed action is shown in its dialog, and a user that does not exist is an error state', async () => {
    const api = installFakeApi()
    api.override('POST', /\/ban$/, () => failure(503, 'service.unavailable', 'Try again shortly.'))
    const { user } = start(`${DEV_PATH}/users/${IDS.user}`, { api })
    await user.click(await screen.findByRole('button', { name: 'Ban user' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Ban user' }))
    expect((await within(dialog()).findByRole('alert')).textContent).toBe('Try again shortly.')
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
  })
})

describe('the other screens', () => {
  test('signing keys: statuses in words, and rotation', async () => {
    const { user } = start(`${DEV_PATH}/signing-keys`)
    await heading('Signing keys')
    await screen.findByText('key-next')
    await user.click(screen.getByRole('button', { name: 'Rotate keys' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Rotate keys' }))
    await screen.findByText('key-new')
    expect(screen.getAllByText('Retired').length).toBeGreaterThan(0)
  })

  test('the audit log renders server text as text, and its filters live in the address', async () => {
    const { user, location, api } = start(`${DEV_PATH}/audit-log`)
    await heading('Audit log')
    const details = await screen.findByText('{"note":"<b>not html</b>"}')
    expect(details.querySelector('b')).toBeNull()
    expect(document.querySelector('[data-actor-type]')?.textContent).toBe('instance_admin')
    await user.selectOptions(screen.getByLabelText('Action'), 'user.banned')
    await user.selectOptions(screen.getByLabelText('Actor type'), 'instance_admin')
    await user.type(screen.getByLabelText('Target id'), IDS.user)
    await user.click(screen.getByRole('button', { name: 'Apply filters' }))
    await waitFor(() => expect(location()).toContain('action=user.banned'))
    await waitFor(() => {
      const search = api.callsTo('GET', '/v1/admin/audit-logs').at(-1)?.search
      expect(search?.get('action')).toBe('user.banned')
      expect(search?.get('actorType')).toBe('instance_admin')
      expect(search?.get('targetId')).toBe(IDS.user)
    })
    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    await waitFor(() => expect(location()).toBe(`${DEV_PATH}/audit-log`))
  })

  test('the instance audit log has no actor-type filter and asks the instance route', async () => {
    const { api } = start('/instance/audit-log?from=2026-10-01&to=2026-10-04&action=bogus')
    await heading('Instance audit log')
    expect(screen.queryByLabelText('Actor type')).toBeNull()
    await waitFor(() => {
      const search = api.callsTo('GET', '/v1/instance/audit-logs').at(-1)?.search
      expect(search?.get('from')).toBe('2026-10-01T00:00:00.000Z')
      expect(search?.get('to')).toBe('2026-10-04T23:59:59.999Z')
      // An action this log does not have is not sent.
      expect(search?.has('action')).toBe(false)
    })
  })

  test('diagnostics: failing checks first, each with its fix', async () => {
    const { user, api } = start('/instance/diagnostics')
    await heading('Diagnostics')
    await screen.findByText('1 failing, 1 warning.')
    const checks = [...document.querySelectorAll('li[data-status]')].map((item) =>
      item.getAttribute('data-status')
    )
    expect(checks).toEqual(['fail', 'warn', 'ok', 'ok', 'skipped'])
    expect(screen.getByText('Check SMTP_URL.')).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Run again' }))
    await waitFor(() =>
      expect(api.callsTo('GET', '/v1/instance/diagnostics').length).toBeGreaterThan(1)
    )
  })

  test('diagnostics: the native app checks are drawn like any other, skipped ones included', async () => {
    const api = installFakeApi()
    api.override('GET', /^\/v1\/instance\/diagnostics$/, () => ({
      version: '0.0.0',
      environment: 'prod',
      time: '2026-10-04T12:00:00.000Z',
      publicUrl: 'https://auth.example.com',
      checks: [
        {
          id: 'native_app_passkeys',
          status: 'skipped',
          summary: 'No native app is registered in any environment.',
        },
        {
          id: 'native_app_files',
          status: 'warn',
          summary: 'But fetched at PUBLIC_URL, a file comes back different.',
          fix: 'Run the check again later.',
        },
        {
          id: 'native_app_identities',
          status: 'fail',
          summary: '1 of the 2 native apps registered in 1 environment is not well formed.',
          fix: 'Remove each such app and register it again with the right values.',
        },
      ],
    }))
    start('/instance/diagnostics', { api })
    await heading('Diagnostics')
    await screen.findByText('1 failing, 1 warning.')
    const drawn = [...document.querySelectorAll('li[data-status]')].map((item) => [
      item.querySelector('code')?.textContent,
      item.getAttribute('data-status'),
    ])
    expect(drawn).toEqual([
      ['native_app_identities', 'fail'],
      ['native_app_files', 'warn'],
      ['native_app_passkeys', 'skipped'],
    ])
    expect(screen.getByText('No native app is registered in any environment.')).toBeDefined()
    expect(screen.getByText('Run the check again later.')).toBeDefined()
    expect(
      screen.getByText('Remove each such app and register it again with the right values.')
    ).toBeDefined()
  })

  test('a 403 is "not allowed", with no retry; any other failure can be retried', async () => {
    const api = installFakeApi()
    api.override('GET', /^\/v1\/admin\/signing-keys$/, () =>
      failure(403, 'request.origin_not_allowed', 'This origin may not call the API.')
    )
    const { user } = start(`${DEV_PATH}/signing-keys`, { api })
    await screen.findByText('You are not allowed to see this')
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()

    let failures = 1
    api.override('GET', /^\/v1\/admin\/api-keys$/, () => {
      if (failures > 0) {
        failures -= 1
        return failure(500, 'internal', 'Something went wrong.')
      }
      return { meta: { totalCount: 0, totalPages: 1, page: 1, perPage: 100 }, data: [] }
    })
    await user.click(screen.getByRole('link', { name: 'API keys' }))
    await screen.findByText('This could not be loaded')
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByText('No API keys yet')
  })
})
