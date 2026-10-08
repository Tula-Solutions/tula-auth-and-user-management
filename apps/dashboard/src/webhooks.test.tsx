import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor, within } from '@testing-library/react'
import { failure, fakeWebhookEndpoint, IDS, installFakeApi } from '~/testing/fake-api'
import { DEV_PATH, openDialogs, PROD_PATH, renderApp, type World } from '~/testing/harness'

// The webhooks screens: an environment's endpoints, one endpoint's deliveries, one delivery's
// attempts. Rendered as the whole app, against the fake API.

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

/** What the open dialog says is wrong, in document order. */
function alerts(): string[] {
  return within(dialog())
    .queryAllByRole('alert')
    .map((alert) => alert.textContent ?? '')
}

/** The card of the endpoint with this address. */
async function card(url: string): Promise<HTMLElement> {
  const title = await screen.findByRole('heading', { level: 2, name: url })
  return title.closest('section') as HTMLElement
}

describe('the list of endpoints', () => {
  test('the navigation leads to it, and an environment without an endpoint says so', async () => {
    const { user, location, api } = start(`${DEV_PATH}/users`)
    await heading('Users')
    await user.click(screen.getByRole('link', { name: 'Webhooks' }))
    await heading('Webhooks')
    expect(location()).toBe(`${DEV_PATH}/webhooks`)
    await screen.findByText('No webhook endpoints yet')
    await screen.findByText('0 of 10 endpoints')
    expect(
      api.callsTo('GET', '/v1/admin/webhook-endpoints').at(-1)?.headers.get('x-tula-environment')
    ).toBe(IDS.development)
  })

  test('each endpoint says its state in words, and why the server switched one off', async () => {
    const api = installFakeApi()
    api.state.webhookEndpoints.push(
      fakeWebhookEndpoint({ url: 'https://hooks.example.com/active' }),
      fakeWebhookEndpoint({
        url: 'https://hooks.example.com/failing',
        failingSince: '2026-10-03T08:00:00.000Z',
        lastFailedAt: '2026-10-04T11:00:00.000Z',
      }),
      fakeWebhookEndpoint({ url: 'https://hooks.example.com/off', enabled: false }),
      fakeWebhookEndpoint({
        url: 'https://hooks.example.com/dead',
        enabled: false,
        disabledReason: 'failing',
      }),
      fakeWebhookEndpoint({
        url: 'https://hooks.example.com/gone',
        enabled: false,
        disabledReason: 'gone',
      }),
      fakeWebhookEndpoint({
        url: 'https://hooks.example.com/later',
        enabled: false,
        disabledReason: '<b>quota</b>',
      }),
      // Another environment's endpoint is not this one's.
      fakeWebhookEndpoint({
        url: 'https://hooks.example.com/production',
        environmentId: IDS.production,
      })
    )
    start(`${DEV_PATH}/webhooks`, { api })
    await heading('Webhooks')
    await screen.findByText('6 of 10 endpoints')

    const state = async (path: string) =>
      within(await card(`https://hooks.example.com/${path}`)).getByTestId('endpoint-state')
    expect((await state('active')).textContent).toBe(
      'ActiveEvents of its types are delivered to it.'
    )
    expect((await state('active')).getAttribute('data-state')).toBe('active')
    expect((await state('failing')).textContent).toContain('Active, but failing')
    expect((await state('failing')).textContent).toContain(
      'After five days of failures with no success the server switches it off.'
    )
    expect((await state('off')).textContent).toBe(
      'Switched offAn operator switched it off. Nothing is sent to it, and events from this time are not sent later.'
    )
    expect((await state('dead')).textContent).toContain('Switched off by the server')
    expect((await state('dead')).textContent).toContain(
      'Requests to it failed for five days with no success among them, so the server stopped sending.'
    )
    expect((await state('gone')).textContent).toContain(
      'It answered “410 Gone”, which means “stop”, so the server stopped sending at once.'
    )
    expect((await state('gone')).getAttribute('data-state')).toBe('off-by-server')
    // A reason a later server knows is shown as the text it is, never as markup.
    expect((await state('later')).textContent).toContain('The server’s reason: <b>quota</b>')
    expect(document.querySelector('b')).toBeNull()
    expect(
      screen.queryAllByRole('heading', { name: 'https://hooks.example.com/production' })
    ).toHaveLength(0)

    const active = await card('https://hooks.example.com/active')
    expect(within(active).getByText('user.created, session.revoked')).toBeTruthy()
    expect(within(active).getByRole('link', { name: 'Deliveries' }).getAttribute('href')).toBe(
      `/dashboard${DEV_PATH}/webhooks/${api.state.webhookEndpoints[0]?.id}`
    )
  })
})

describe('adding an endpoint', () => {
  test('the form is checked with the contract’s schema before anything is sent', async () => {
    const { user, api } = start(`${DEV_PATH}/webhooks`)
    await heading('Webhooks')
    await user.click(await screen.findByRole('button', { name: 'Add endpoint' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Add endpoint' }))
    const address = within(dialog()).getByLabelText('Address')
    expect(address.getAttribute('aria-invalid')).toBe('true')
    expect(alerts()).toEqual([
      'Enter the address of your endpoint, starting with https://.',
      'Choose at least one event type.',
    ])
    expect(api.callsTo('POST', '/v1/admin/webhook-endpoints')).toHaveLength(0)

    // The group of checkboxes is named, and says what is wrong with it.
    const types = within(dialog()).getByRole('group', { name: 'Event types' })
    expect(types.getAttribute('aria-describedby')).not.toBeNull()

    await user.type(address, 'https://api.example.com/web hooks')
    await user.click(within(types).getByRole('checkbox', { name: 'user.created' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Add endpoint' }))
    expect(alerts()).toEqual(['Must not contain spaces or control characters.'])
    expect(api.callsTo('POST', '/v1/admin/webhook-endpoints')).toHaveLength(0)
  })

  test('an address the server may not call is refused in a sentence, on the field', async () => {
    const { user, api } = start(`${DEV_PATH}/webhooks`)
    await heading('Webhooks')
    await user.click(await screen.findByRole('button', { name: 'Add endpoint' }))
    const address = within(dialog()).getByLabelText('Address')
    await user.click(within(dialog()).getByRole('checkbox', { name: 'user.created' }))

    const refusals: [string, string][] = [
      ['http://api.example.com/webhooks', 'The address must start with https://.'],
      [
        'https://10.0.0.8/webhooks',
        'The address leads to a private or local network address, which the server does not call. Use an address on the public internet.',
      ],
      [
        'https://nowhere.invalid/webhooks',
        'The host name of the address could not be resolved. Check the spelling.',
      ],
      [
        'https://user:pw@api.example.com/webhooks',
        'That is not an address the server can call. Enter a full https:// URL with no user name or password in it.',
      ],
    ]
    for (const [url, sentence] of refusals) {
      await user.clear(address)
      await user.type(address, url)
      await user.click(within(dialog()).getByRole('button', { name: 'Add endpoint' }))
      await waitFor(() => expect(alerts()).toEqual([sentence]))
    }
    expect(api.state.webhookEndpoints).toHaveLength(0)

    // A word this version does not know still gets a sentence, never the bare code.
    api.override('POST', /^\/v1\/admin\/webhook-endpoints$/, () =>
      failure(422, 'webhook.url_not_allowed', 'Not allowed.', undefined, {
        reason: 'port_not_allowed',
      })
    )
    await user.click(within(dialog()).getByRole('button', { name: 'Add endpoint' }))
    await waitFor(() => expect(alerts()).toEqual(['The server cannot deliver to that address.']))
  })

  test('the eleventh endpoint is refused in words', async () => {
    const api = installFakeApi()
    for (let index = 0; index < 10; index += 1) {
      api.state.webhookEndpoints.push(
        fakeWebhookEndpoint({ url: `https://hooks.example.com/${index}` })
      )
    }
    const { user } = start(`${DEV_PATH}/webhooks`, { api })
    await screen.findByText('10 of 10 endpoints')
    await user.click(screen.getByRole('button', { name: 'Add endpoint' }))
    await user.type(within(dialog()).getByLabelText('Address'), 'https://hooks.example.com/11')
    await user.click(within(dialog()).getByRole('checkbox', { name: 'user.created' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Add endpoint' }))
    await waitFor(() =>
      expect(alerts()).toEqual([
        'This environment already has 10 webhook endpoints, the most one can have. Delete one first.',
      ])
    )
    expect(api.state.webhookEndpoints).toHaveLength(10)
  })

  test('a field the server refuses is shown on that field; cancel forgets what was typed', async () => {
    const api = installFakeApi()
    api.override('POST', /^\/v1\/admin\/webhook-endpoints$/, () =>
      failure(422, 'validation.failed', 'The request is not valid.', [
        {
          field: 'eventTypes',
          code: 'validation.failed',
          message: 'An event type is listed more than once.',
        },
      ])
    )
    const { user } = start(`${DEV_PATH}/webhooks`, { api })
    await user.click(await screen.findByRole('button', { name: 'Add endpoint' }))
    await user.type(within(dialog()).getByLabelText('Address'), 'https://api.example.com/tula')
    await user.click(within(dialog()).getByRole('checkbox', { name: 'user.created' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Add endpoint' }))
    await waitFor(() => expect(alerts()).toEqual(['An event type is listed more than once.']))

    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    await user.click(screen.getByRole('button', { name: 'Add endpoint' }))
    expect((within(dialog()).getByLabelText('Address') as HTMLInputElement).value).toBe('')
    expect(
      within(dialog()).getByRole('checkbox', { name: 'user.created' }).getAttribute('aria-checked')
    ).toBe('false')
    expect(alerts()).toEqual([])
  })
})

const HOME = 'https://api.example.com/webhooks/tula'

/** A fake API with one endpoint in an environment, and the app opened on its webhooks. */
function withEndpoint(
  overrides: Parameters<typeof fakeWebhookEndpoint>[0] = {},
  path = DEV_PATH
): World {
  const api = installFakeApi()
  api.state.webhookEndpoints.push(fakeWebhookEndpoint({ url: HOME, ...overrides }))
  return start(`${path}/webhooks`, { api })
}

function patches(api: World['api']): unknown[] {
  return api.calls.filter((call) => call.method === 'PATCH').map((call) => call.body)
}

describe('changing an endpoint', () => {
  test('an edit sends only what changed, and nothing when nothing did', async () => {
    const { user, api } = withEndpoint()
    await user.click(within(await card(HOME)).getByRole('button', { name: `Edit ${HOME}` }))
    const address = within(dialog()).getByLabelText('Address') as HTMLInputElement
    expect(address.value).toBe(HOME)
    const box = (name: string) => within(dialog()).getByRole('checkbox', { name })
    expect(box('user.created').getAttribute('aria-checked')).toBe('true')
    expect(box('session.revoked').getAttribute('aria-checked')).toBe('true')
    expect(box('api_key.created').getAttribute('aria-checked')).toBe('false')

    await user.click(within(dialog()).getByRole('button', { name: 'Save changes' }))
    expect(alerts()).toEqual(['Change the address or the event types first.'])
    expect(patches(api)).toEqual([])

    await user.click(box('session.revoked'))
    await user.click(box('api_key.created'))
    await user.click(within(dialog()).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    await screen.findByText('Endpoint saved')
    expect(patches(api)).toEqual([{ eventTypes: ['user.created', 'api_key.created'] }])
    expect(within(await card(HOME)).getByText('user.created, api_key.created')).toBeTruthy()

    // The address alone: refused by the guard in a sentence, then accepted.
    await user.click(within(await card(HOME)).getByRole('button', { name: `Edit ${HOME}` }))
    const again = within(dialog()).getByLabelText('Address')
    await user.clear(again)
    await user.type(again, 'http://api.example.com/v2')
    await user.click(within(dialog()).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(alerts()).toEqual(['The address must start with https://.']))
    await user.clear(again)
    await user.click(within(dialog()).getByRole('button', { name: 'Save changes' }))
    expect(alerts()).toEqual(['Enter the address of your endpoint, starting with https://.'])
    await user.type(again, 'https://api.example.com/v2')
    await user.click(within(dialog()).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(patches(api).at(-1)).toEqual({ url: 'https://api.example.com/v2' })
    await card('https://api.example.com/v2')
  })

  test('an event type this dashboard does not know is said, and kept unless the types change', async () => {
    const { user, api } = withEndpoint({ eventTypes: ['user.created', 'invoice.paid'] })
    await user.click(within(await card(HOME)).getByRole('button', { name: `Edit ${HOME}` }))
    expect(within(dialog()).getByTestId('unknown-types').textContent).toBe(
      'This endpoint also subscribes to types this version of the dashboard does not know: invoice.paid. They stay as they are unless you change the event types here; a change replaces the whole list.'
    )
    const address = within(dialog()).getByLabelText('Address')
    await user.type(address, '/v2')
    await user.click(within(dialog()).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(patches(api)).toEqual([{ url: `${HOME}/v2` }])
  })

  test('switching off and on asks first and says what happens to events and pending deliveries', async () => {
    const { user, api } = withEndpoint()
    await user.click(within(await card(HOME)).getByRole('button', { name: `Switch off ${HOME}` }))
    expect(within(dialog()).getByRole('heading').textContent).toBe(`Switch off ${HOME}?`)
    expect(dialog().textContent).toContain('events that happen while it is off are not sent later')
    await user.click(within(dialog()).getByRole('button', { name: 'Switch off' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    await screen.findByText('Endpoint switched off')
    expect(patches(api)).toEqual([{ enabled: false }])
    await waitFor(async () =>
      expect(
        within(await card(HOME))
          .getByTestId('endpoint-state')
          .getAttribute('data-state')
      ).toBe('off')
    )

    await user.click(within(await card(HOME)).getByRole('button', { name: `Switch on ${HOME}` }))
    expect(dialog().textContent).toContain(
      'Deliveries that were pending are tried again unless they are more than three days old.'
    )
    await user.click(within(dialog()).getByRole('button', { name: 'Switch on' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    await screen.findByText('Endpoint switched on')
    expect(patches(api)).toEqual([{ enabled: false }, { enabled: true }])
  })

  test('an endpoint the server switched off is switched on the same way, and is active again', async () => {
    const { user } = withEndpoint({
      enabled: false,
      disabledReason: 'gone',
      failingSince: '2026-10-01T00:00:00.000Z',
    })
    const state = async () => within(await card(HOME)).getByTestId('endpoint-state')
    expect((await state()).getAttribute('data-state')).toBe('off-by-server')
    await user.click(within(await card(HOME)).getByRole('button', { name: `Switch on ${HOME}` }))
    await user.click(within(dialog()).getByRole('button', { name: 'Switch on' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    await waitFor(async () => expect((await state()).getAttribute('data-state')).toBe('active'))
  })

  test('a change the server refuses is said in the dialog, which stays open', async () => {
    const { user, api } = withEndpoint()
    api.override('PATCH', /^\/v1\/admin\/webhook-endpoints\/[^/]+$/, () =>
      failure(503, 'service.unavailable', 'The service is unavailable. Try again shortly.')
    )
    await user.click(within(await card(HOME)).getByRole('button', { name: `Switch off ${HOME}` }))
    await user.click(within(dialog()).getByRole('button', { name: 'Switch off' }))
    await waitFor(() =>
      expect(alerts()).toEqual(['The service is unavailable. Try again shortly.'])
    )
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    // Opened again, the old failure is not shown.
    await user.click(within(await card(HOME)).getByRole('button', { name: `Switch off ${HOME}` }))
    expect(alerts()).toEqual([])
  })
})

describe('deleting an endpoint', () => {
  test('the confirmation names the endpoint and says its deliveries and its log go with it', async () => {
    const { user, api } = withEndpoint()
    await user.click(within(await card(HOME)).getByRole('button', { name: `Delete ${HOME}` }))
    expect(within(dialog()).getByRole('heading').textContent).toBe(`Delete ${HOME}?`)
    expect(dialog().textContent).toContain(
      'Its signing secret, its pending deliveries and the log of everything delivered to it are deleted with it, and cannot be brought back.'
    )
    // Development: nothing to type.
    expect(within(dialog()).queryAllByLabelText(/to confirm/)).toHaveLength(0)
    await user.click(within(dialog()).getByRole('button', { name: 'Delete endpoint' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    await screen.findByText('Endpoint deleted')
    await screen.findByText('No webhook endpoints yet')
    expect(api.state.webhookEndpoints).toHaveLength(0)
  })

  test('in production the address must be typed', async () => {
    const { user, api } = withEndpoint({ environmentId: IDS.production }, PROD_PATH)
    await user.click(within(await card(HOME)).getByRole('button', { name: `Delete ${HOME}` }))
    const confirm = within(dialog()).getByRole('button', { name: 'Delete endpoint' })
    expect(confirm.getAttribute('aria-disabled')).toBe('true')
    await user.click(confirm)
    await user.type(within(dialog()).getByLabelText(/to confirm/), 'https://api.example.com')
    await user.click(confirm)
    expect(api.calls.some((call) => call.method === 'DELETE')).toBe(false)
    await user.type(within(dialog()).getByLabelText(/to confirm/), '/webhooks/tula')
    await user.click(within(dialog()).getByRole('button', { name: 'Delete endpoint' }))
    await screen.findByText('No webhook endpoints yet')
    expect(api.state.webhookEndpoints).toHaveLength(0)
  })
})
