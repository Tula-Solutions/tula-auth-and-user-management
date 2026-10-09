import { afterEach, describe, expect, jest, test } from 'bun:test'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import { ApiError } from '~/api/errors'
import { clearToasts, notify, TOAST_MS, Toaster } from '~/components/toaster'
import { useEnvironment } from '~/features/shell/environment-context'
import { RouteError } from '~/routes/__root'
import { failure, IDS, installFakeApi } from '~/testing/fake-api'
import { DEV_PATH, openDialogs, renderApp, type World } from '~/testing/harness'

// The rest of each screen: the controls the walk through the app (app.test.tsx) did not touch.

let world: World | undefined

function start(path: string, options: Parameters<typeof renderApp>[1] = {}): World {
  world = renderApp(path, options)
  return world
}

afterEach(() => {
  world?.api.restore()
  world = undefined
})

function dialog(): HTMLElement {
  return screen.getByRole('dialog')
}

describe('lists', () => {
  test('a list of several pages moves with Previous and Next, in the address', async () => {
    const api = installFakeApi()
    api.override('GET', /^\/v1\/admin\/users$/, (call) => ({
      meta: {
        totalCount: 45,
        totalPages: 3,
        page: Number(call.search.get('page') ?? 1),
        perPage: 20,
      },
      data: api.state.users,
    }))
    const { user, location } = start(`${DEV_PATH}/users?page=2`, { api })
    await screen.findByText('Page 2 of 3 · 45 entries')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(location()).toBe(`${DEV_PATH}/users?page=3`))
    await screen.findByText('Page 3 of 3 · 45 entries')
    expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Previous' }))
    await user.click(await screen.findByRole('button', { name: 'Previous' }))
    await waitFor(() => expect(location()).toBe(`${DEV_PATH}/users`))
  })

  test('the audit log pages too, and the instance log’s filters go to the address', async () => {
    const api = installFakeApi()
    api.override('GET', /^\/v1\/admin\/audit-logs$/, (call) => ({
      meta: {
        totalCount: 60,
        totalPages: 3,
        page: Number(call.search.get('page') ?? 1),
        perPage: 25,
      },
      data: api.state.audit,
    }))
    const { user, location } = start(`${DEV_PATH}/audit-log`, { api })
    await user.click(await screen.findByRole('button', { name: 'Next' }))
    await waitFor(() => expect(location()).toBe(`${DEV_PATH}/audit-log?page=2`))

    await user.click(screen.getByRole('link', { name: 'Instance audit log' }))
    await screen.findByRole('heading', { level: 1, name: 'Instance audit log' })
    await user.selectOptions(screen.getByLabelText('Action'), 'project.created')
    await user.type(screen.getByLabelText('Actor id'), 'dash-session')
    await user.click(screen.getByRole('button', { name: 'Apply filters' }))
    await waitFor(() => expect(location()).toContain('/instance/audit-log?action=project.created'))
    await waitFor(() =>
      expect(
        world?.api.callsTo('GET', '/v1/instance/audit-logs').at(-1)?.search.get('action')
      ).toBe('project.created')
    )
  })

  test('an environment’s bare address opens its users', async () => {
    const { location } = start(DEV_PATH)
    await screen.findByRole('heading', { level: 1, name: 'Users' })
    expect(location()).toBe(`${DEV_PATH}/users`)
  })
})

describe('the shell', () => {
  test('the workspace switcher navigates; a workspace can be created from the navigation', async () => {
    const api = installFakeApi()
    api.state.workspaces.push({
      id: '00000000-0000-7000-8000-0000000000a2',
      name: 'Second',
      createdAt: '',
    })
    const { user, location } = start(`${DEV_PATH}/users`, { api })
    const switcher = (await screen.findByLabelText('Workspace')) as HTMLSelectElement
    await waitFor(() => expect(switcher.options.length).toBe(2))
    await user.selectOptions(switcher, 'Second')
    await waitFor(() => expect(location()).toBe('/w/00000000-0000-7000-8000-0000000000a2'))
    await screen.findByText('No projects yet.')

    await user.click(screen.getByRole('button', { name: 'New workspace' }))
    await user.type(within(dialog()).getByLabelText('Name'), 'Third')
    await user.click(within(dialog()).getByRole('button', { name: 'Create workspace' }))
    await screen.findByRole('heading', { level: 1, name: 'Third' })

    await user.click(screen.getAllByRole('button', { name: 'Create project' })[0] as HTMLElement)
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
  })

  test('on a narrow screen the navigation opens as a dialog and closes on navigation', async () => {
    const { user } = start(`${DEV_PATH}/users`)
    await screen.findByRole('heading', { level: 1, name: 'Users' })
    await user.click(screen.getByRole('button', { name: 'Menu' }))
    expect(within(dialog()).getByRole('navigation', { name: 'Environment' })).toBeDefined()
    await user.click(within(dialog()).getByRole('link', { name: 'Signing keys' }))
    await screen.findByRole('heading', { level: 1, name: 'Signing keys' })
    await waitFor(() => expect(openDialogs()).toBe(0))
    await user.click(screen.getByRole('button', { name: 'Menu' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
  })

  test('a server refusal of a new project is shown on the name', async () => {
    const api = installFakeApi()
    api.override('POST', /^\/v1\/instance\/projects$/, () =>
      failure(422, 'validation.failed', 'Invalid.', [
        { field: 'name', code: 'validation.failed', message: 'That name is taken.' },
      ])
    )
    const { user } = start(`/w/${IDS.workspace}`, { api })
    await screen.findByRole('heading', { level: 1, name: 'Acme Studio' })
    await user.click(
      within(screen.getByRole('main')).getByRole('button', { name: 'Create project' })
    )
    await user.type(within(dialog()).getByLabelText('Name'), 'x'.repeat(101))
    await user.click(within(dialog()).getByRole('button', { name: 'Create project' }))
    expect(within(dialog()).getByRole('alert').textContent).toBe('Use 100 characters or fewer.')
    await user.clear(within(dialog()).getByLabelText('Name'))
    await user.type(within(dialog()).getByLabelText('Name'), 'Mobile app')
    await user.click(within(dialog()).getByRole('button', { name: 'Create project' }))
    // Waited for as text: the server's message, not whichever alert is on screen first.
    await waitFor(() =>
      expect(
        within(dialog())
          .queryAllByRole('alert')
          .map((alert) => alert.textContent)
      ).toEqual(['That name is taken.'])
    )
  })

  test('a route that threw shows the error with a retry; a screen outside an environment is a bug', () => {
    let retried = 0
    render(
      <RouteError
        error={new ApiError({ status: 500, code: 'internal', detail: 'It broke.' })}
        reset={() => {
          retried += 1
        }}
      />
    )
    expect(screen.getByRole('alert').textContent).toContain('It broke.')
    screen.getByRole('button', { name: 'Try again' }).click()
    expect(retried).toBe(1)
    function Lost() {
      useEnvironment()
      return null
    }
    expect(() => render(<Lost />)).toThrow('useEnvironment must be used under an environment route')
  })

  test('a confirmation goes away by itself', () => {
    // The clock is the test's: waiting the five seconds out in real time is slow, and on a
    // loaded machine it is not five seconds.
    clearToasts()
    jest.useFakeTimers()
    try {
      const shown = () => screen.queryAllByText('Done').length
      render(<Toaster />)
      act(() => notify('Done'))
      expect(shown()).toBe(1)
      act(() => {
        jest.advanceTimersByTime(TOAST_MS - 1)
      })
      expect(shown()).toBe(1)
      act(() => {
        jest.advanceTimersByTime(1)
      })
      expect(shown()).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })

  test('a confirmation taken off the screen leaves no timer behind', () => {
    // Confirmations outlive the screen that drew them (the store is the app's): start clean.
    clearToasts()
    jest.useFakeTimers()
    try {
      const view = render(<Toaster />)
      act(() => notify('Done'))
      expect(jest.getTimerCount()).toBe(1)
      view.unmount()
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      jest.useRealTimers()
      clearToasts()
    }
  })
})

describe('settings controls', () => {
  test('password policy: a preset fills every rule; a hand edit makes it custom', async () => {
    const { user, api } = start(`${DEV_PATH}/password-policy`)
    const preset = (await screen.findByLabelText('Policy preset')) as HTMLSelectElement
    await user.selectOptions(preset, 'strict')
    expect(preset.value).toBe('strict')
    await user.click(screen.getByRole('switch', { name: 'Require a number' }))
    expect(preset.value).toBe('custom')
    await user.selectOptions(preset, 'recommended')
    await user.selectOptions(preset, 'custom')
    for (const [label, value] of [
      ['Maximum length', '200'],
      ['Kinds of character required', '3'],
      ['Longest run of one character', '4'],
      ['Previous passwords remembered', '5'],
      ['Password expires after (days)', '90'],
    ] as const) {
      const field = screen.getByLabelText(label)
      await user.clear(field)
      await user.type(field, value)
    }
    await user.selectOptions(screen.getByLabelText('Breached-password check'), 'block')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    if (openDialogs() > 0) {
      await user.click(within(dialog()).getByRole('button', { name: 'Save anyway' }))
    }
    await screen.findByText('Settings saved')
    expect(api.state.settings.settings.password).toMatchObject({
      preset: 'custom',
      maxLength: 200,
      minCharacterClasses: 3,
      maxRepeatedChars: 4,
      history: 5,
      expiryDays: 90,
      breachCheck: 'block',
    })
  })

  test('session profiles: every field of a profile is editable', async () => {
    const { user, api } = start(`${DEV_PATH}/sessions`)
    const web = (await screen.findByRole('heading', { name: /^web/ })).closest('li') as HTMLElement
    await user.selectOptions(within(web).getByLabelText('Type'), 'stateful')
    for (const [label, value] of [
      ['Access token lifetime', '5m'],
      ['Absolute timeout', '14d'],
      ['Step-up after', '15m'],
      ['Refresh reuse grace period', '20s'],
    ] as const) {
      const field = within(web).getByLabelText(label)
      await user.clear(field)
      await user.type(field, value)
    }
    await user.click(within(web).getByRole('switch', { name: 'Clients may ask for this profile' }))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Save anyway' }))
    await screen.findByText('Settings saved')
    expect(api.state.settings.settings.sessions.profiles.web).toMatchObject({
      type: 'stateful',
      accessTokenTtl: '5m',
      absoluteTimeout: '14d',
      stepUpAfter: '15m',
      clientSelectable: true,
      refresh: { reuseGracePeriod: '20s' },
    })
  })

  test('general settings: redirect URLs and notices', async () => {
    const { user, api } = start(`${DEV_PATH}/settings`)
    const url = await screen.findByRole('textbox', { name: 'Allowed redirect URLs' })
    await user.type(url, 'ftp://example.com/x')
    await user.click(screen.getByRole('button', { name: 'Add URL' }))
    expect(
      screen.getAllByRole('alert').some((alert) => alert.textContent?.startsWith('This '))
    ).toBe(true)
    await user.clear(url)
    await user.type(url, 'https://app.example.com/callback')
    await user.click(screen.getByRole('button', { name: 'Add URL' }))
    await user.click(screen.getByRole('switch', { name: 'Their password was changed' }))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(dialog().textContent).toContain('no longer told when their password changes')
    await user.click(within(dialog()).getByRole('button', { name: 'Save anyway' }))
    await screen.findByText('Settings saved')
    expect(api.state.settings.settings.urls.allowedRedirectUrls).toEqual([
      'https://app.example.com/callback',
    ])
    expect(api.state.settings.settings.notifications.passwordChanged).toBe(false)
  })

  describe('the Microsoft card', () => {
    const TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47'
    const listed = (over: Record<string, unknown> = {}) => ({
      data: [
        {
          provider: 'microsoft',
          configured: false,
          enabled: false,
          clientId: null,
          teamId: null,
          keyId: null,
          tenant: null,
          callbackUrl: 'http://localhost:3003/v1/client/oauth/microsoft/callback',
          updatedAt: null,
          ...over,
        },
      ],
    })
    const card = () =>
      screen.getByRole('heading', { name: 'Microsoft' }).closest('li') as HTMLElement
    const select = () => within(card()).getByLabelText('Who can sign in') as HTMLSelectElement

    test('asks who can sign in, has no default, and sends one organization’s tenant id', async () => {
      const api = installFakeApi()
      const bodies: Record<string, unknown>[] = []
      api.override('GET', /^\/v1\/admin\/oauth-providers$/, () => listed())
      api.override('PUT', /^\/v1\/admin\/oauth-providers\/microsoft$/, (call) => {
        const body = call.body as Record<string, unknown>
        bodies.push(body)
        return typeof body.tenant === 'string' && body.tenant !== 'not-a-tenant'
          ? { provider: 'microsoft' }
          : failure(422, 'validation.failed', 'Invalid.', [
              { field: 'tenant', code: 'validation.failed', message: 'tenant is required' },
            ])
      })
      const { user } = start(`${DEV_PATH}/sign-in-methods`, { api })
      await screen.findByRole('heading', { name: 'Microsoft' })
      expect(select().value).toBe('')
      expect(within(card()).queryByLabelText('Directory (tenant) ID') === null).toBe(true)
      await user.type(within(card()).getByLabelText('Application (client) ID'), 'ms-client')
      await user.type(within(card()).getByLabelText('Client secret'), 'ms-secret-value')

      // Nothing chosen: no tenant is invented, and the refusal is said at the question.
      await user.click(within(card()).getByRole('button', { name: 'Save Microsoft' }))
      await within(card()).findByText('tenant is required')
      expect(bodies[0]).toEqual({
        clientId: 'ms-client',
        enabled: true,
        clientSecret: 'ms-secret-value',
      })
      expect(select().getAttribute('aria-invalid')).toBe('true')

      // One organization: its id is typed, and a refusal of it is said at the id.
      await user.selectOptions(select(), 'tenant')
      const id = within(card()).getByLabelText('Directory (tenant) ID') as HTMLInputElement
      await user.type(id, 'not-a-tenant')
      await user.click(within(card()).getByRole('button', { name: 'Save Microsoft' }))
      await waitFor(() => expect(bodies).toHaveLength(2))
      await waitFor(() => expect(id.getAttribute('aria-invalid')).toBe('true'))
      expect(bodies[1]?.tenant).toBe('not-a-tenant')
      await user.clear(id)
      await user.type(id, ` ${TENANT} `)
      await user.click(within(card()).getByRole('button', { name: 'Save Microsoft' }))
      await screen.findByText('Microsoft saved')
      expect(bodies[2]).toEqual({
        clientId: 'ms-client',
        enabled: true,
        tenant: TENANT,
        clientSecret: 'ms-secret-value',
      })
      // Saved: the secret is gone from the page.
      expect(document.documentElement.outerHTML.includes('ms-secret-value')).toBe(false)
    })

    test.each([
      ['common', 'common', null],
      ['organizations', 'organizations', null],
      ['consumers', 'consumers', null],
      [TENANT, 'tenant', TENANT],
    ])(
      'a stored tenant %p is shown as %p, and saved again without the secret',
      async (tenant, choice, id) => {
        const api = installFakeApi()
        const bodies: unknown[] = []
        api.override('GET', /^\/v1\/admin\/oauth-providers$/, () =>
          listed({ configured: true, enabled: true, clientId: 'ms-client', tenant })
        )
        api.override('PUT', /^\/v1\/admin\/oauth-providers\/microsoft$/, (call) => {
          bodies.push(call.body)
          return { provider: 'microsoft' }
        })
        const { user } = start(`${DEV_PATH}/sign-in-methods`, { api })
        await screen.findByRole('heading', { name: 'Microsoft' })
        expect(select().value).toBe(choice)
        const field = within(card()).queryByLabelText(
          'Directory (tenant) ID'
        ) as HTMLInputElement | null
        expect(field?.value ?? null).toBe(id)
        await user.click(within(card()).getByRole('button', { name: 'Save Microsoft' }))
        await screen.findByText('Microsoft saved')
        expect(bodies).toEqual([{ clientId: 'ms-client', enabled: true, tenant }])
      }
    )

    test('every other provider has no such question', async () => {
      start(`${DEV_PATH}/sign-in-methods`)
      await screen.findByRole('heading', { name: 'Microsoft' })
      expect(screen.getAllByLabelText('Who can sign in')).toHaveLength(1)
    })
  })

  describe('providers by the server’s name', () => {
    const listed = (provider: string, over: Record<string, unknown> = {}) => ({
      provider,
      configured: false,
      enabled: false,
      clientId: null,
      teamId: null,
      keyId: null,
      tenant: null,
      callbackUrl: `http://localhost:3003/v1/oauth/callback/${provider}`,
      updatedAt: null,
      ...over,
    })

    test.each([
      ['discord', 'Discord'],
      ['linkedin', 'LinkedIn'],
      ['x', 'X'],
      ['facebook', 'Facebook'],
    ])('the %s card takes a client id and a secret, and nothing else', async (provider, name) => {
      const api = installFakeApi()
      const bodies: unknown[] = []
      api.override('GET', /^\/v1\/admin\/oauth-providers$/, () => ({ data: [listed(provider)] }))
      api.override('PUT', new RegExp(`^/v1/admin/oauth-providers/${provider}$`), (call) => {
        bodies.push(call.body)
        return { provider }
      })
      const { user } = start(`${DEV_PATH}/sign-in-methods`, { api })
      const card = (await screen.findByRole('heading', { name })).closest('li') as HTMLElement
      expect(
        within(card).getByText(`http://localhost:3003/v1/oauth/callback/${provider}`)
      ).toBeTruthy()
      for (const absent of ['Who can sign in', 'Team ID', 'Key ID', 'Private key (.p8)']) {
        expect(within(card).queryByLabelText(absent) === null).toBe(true)
      }
      await user.type(within(card).getByLabelText('Client ID'), 'the-client')
      await user.type(within(card).getByLabelText('Client secret'), 'the-secret-value')
      await user.click(within(card).getByRole('button', { name: `Save ${name}` }))
      await screen.findByText(`${name} saved`)
      expect(bodies).toEqual([
        { clientId: 'the-client', enabled: true, clientSecret: 'the-secret-value' },
      ])
      // Saved: the secret is gone from the page.
      expect(document.documentElement.outerHTML.includes('the-secret-value')).toBe(false)
      // Only the two providers that are asked for no address say what that costs.
      expect((card.textContent ?? '').includes('is asked for no email address')).toBe(
        provider === 'x' || provider === 'facebook'
      )
    })

    // A later server lists a provider this version has no form for, or a name that is a
    // property of every object. Neither gets a card whose fields would be a guess.
    test('a provider this version does not know has no card, and the known ones keep theirs', async () => {
      const api = installFakeApi()
      api.override('GET', /^\/v1\/admin\/oauth-providers$/, () => ({
        data: [
          listed('twitch'),
          listed('constructor'),
          listed('__proto__'),
          listed('toString'),
          listed('discord'),
        ],
      }))
      start(`${DEV_PATH}/sign-in-methods`, { api })
      await screen.findByRole('heading', { name: 'Discord' })
      const section = screen.getByRole('heading', { name: 'OAuth providers' }).closest('section')
      const cards = within(section as HTMLElement).getAllByRole('listitem')
      expect(cards).toHaveLength(1)
      const text = section?.textContent ?? ''
      for (const unknown of ['twitch', 'constructor', '__proto__', 'toString', 'function']) {
        expect(text.includes(unknown)).toBe(false)
      }
    })

    test.each([
      [['discord'], 'No password; signs in with Discord.'],
      [['linkedin', 'github'], 'No password; signs in with LinkedIn and GitHub.'],
      [['x', 'facebook'], 'No password; signs in with X and Facebook.'],
      // Unknown to this version: said as the server names it, never looked up as a property.
      [['twitch'], 'No password; signs in with twitch.'],
      [['constructor', 'toString'], 'No password; signs in with constructor and toString.'],
      [['__proto__'], 'No password; signs in with __proto__.'],
    ])('a user who signs in with %p: %s', async (providers, sentence) => {
      const api = installFakeApi()
      api.state.authentication = {
        ...api.state.authentication,
        hasPassword: false,
        identities: providers.map((provider) => ({
          provider,
          linkedAt: '2026-03-01T09:00:00.000Z',
        })),
      }
      start(`${DEV_PATH}/users/${IDS.user}`, { api })
      await screen.findByText(sentence)
    })

    // A second factor's type is the server's word too: `FACTOR_NAME['constructor']` is a
    // function of `Object.prototype`, which React draws as nothing.
    test.each([
      ['totp', 'Authenticator app since '],
      ['sms', 'sms since '],
      ['constructor', 'constructor since '],
      ['toString', 'toString since '],
      ['__proto__', '__proto__ since '],
    ])('a second factor the server calls %p is listed as “%s…”', async (type, start_) => {
      const api = installFakeApi()
      api.state.authentication = {
        ...api.state.authentication,
        factors: [{ type, confirmedAt: '2026-03-01T09:00:00.000Z' }],
      }
      start(`${DEV_PATH}/users/${IDS.user}`, { api })
      const line = await screen.findByText((_text, element) =>
        element?.tagName === 'LI' ? (element.textContent ?? '').startsWith(start_) : false
      )
      expect(line.textContent?.startsWith(start_)).toBe(true)
    })
  })

  test('Apple takes a team, a key id and a private key; a provider can be removed; “enabled” may be refused', async () => {
    const api = installFakeApi()
    const bodies: unknown[] = []
    api.override('PUT', /^\/v1\/admin\/oauth-providers\/apple$/, (call) => {
      bodies.push(call.body)
      return { provider: 'apple' }
    })
    api.override('GET', /^\/v1\/admin\/oauth-providers$/, () => ({
      data: [
        {
          provider: 'apple',
          configured: false,
          enabled: false,
          clientId: null,
          teamId: null,
          keyId: null,
          tenant: null,
          callbackUrl: 'http://localhost:3003/v1/client/oauth/apple/callback',
          updatedAt: null,
        },
        {
          provider: 'google',
          configured: true,
          enabled: true,
          clientId: 'g-client',
          teamId: null,
          keyId: null,
          tenant: null,
          callbackUrl: 'http://localhost:3003/v1/client/oauth/google/callback',
          updatedAt: null,
        },
      ],
    }))
    api.override('PUT', /^\/v1\/admin\/oauth-providers\/google$/, () =>
      failure(422, 'validation.failed', 'Invalid.', [
        {
          field: 'enabled',
          code: 'validation.failed',
          message: 'at least one sign-in method must stay enabled',
        },
      ])
    )
    let removed = 0
    api.override('DELETE', /^\/v1\/admin\/oauth-providers\/google$/, () => {
      removed += 1
      return new Response(null, { status: 204 })
    })
    const { user } = start(`${DEV_PATH}/sign-in-methods`, { api })
    const apple = (await screen.findByRole('heading', { name: 'Apple' })).closest(
      'li'
    ) as HTMLElement
    await user.type(within(apple).getByLabelText('Services ID (client id)'), 'com.example.web')
    await user.type(within(apple).getByLabelText('Team ID'), 'TEAM123456')
    await user.type(within(apple).getByLabelText('Key ID'), 'KEY1234567')
    await user.type(within(apple).getByLabelText('Private key (.p8)'), 'PEM')
    await user.click(within(apple).getByRole('button', { name: 'Save Apple' }))
    await screen.findByText('Apple saved')
    expect(bodies[0]).toEqual({
      clientId: 'com.example.web',
      enabled: true,
      teamId: 'TEAM123456',
      keyId: 'KEY1234567',
      privateKey: 'PEM',
    })

    const google = screen.getByRole('heading', { name: 'Google' }).closest('li') as HTMLElement
    await user.click(within(google).getByRole('switch', { name: 'Let users sign in with Google' }))
    await user.click(within(google).getByRole('button', { name: 'Save Google' }))
    const refusal = await within(google).findByRole('alert')
    expect(refusal.textContent).toContain('Google was not switched off')

    await user.click(within(google).getByRole('button', { name: 'Remove Google' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(removed).toBe(0)
    await user.click(within(google).getByRole('button', { name: 'Remove Google' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Remove Google' }))
    await screen.findByText('Google removed')
    expect(removed).toBe(1)
  })
})
