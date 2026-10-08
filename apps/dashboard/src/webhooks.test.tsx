import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor, within } from '@testing-library/react'
import { ACTIVITY_TYPES } from '@tula/contract/event-types'
import {
  failure,
  fakeWebhookDelivery,
  fakeWebhookEndpoint,
  IDS,
  installFakeApi,
} from '~/testing/fake-api'
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

describe('rotating a signing secret', () => {
  const OVERLAP = '2026-10-05T09:30:00.000Z'

  test('a rotation during an overlap is refused in a sentence, not as an error code', async () => {
    const { user, api } = withEndpoint({ rotationOverlapEndsAt: OVERLAP })
    const notice = within(await card(HOME)).getByTestId('rotation-overlap')
    expect(notice.textContent).toContain(
      'Two secrets are signing: every delivery carries a signature for the new secret and one for the previous secret, until'
    )
    expect(notice.querySelector('time')?.getAttribute('datetime')).toBe(OVERLAP)

    await user.click(screen.getByRole('button', { name: `Rotate the secret of ${HOME}` }))
    await user.click(within(dialog()).getByRole('button', { name: 'Rotate secret' }))
    await waitFor(() =>
      expect(alerts()).toEqual([
        'A rotation is already under way: two secrets are signing, and an endpoint never has three. End the overlap first, or wait for it to end.',
      ])
    )
    expect(within(dialog()).queryAllByTestId('webhook-secret')).toHaveLength(0)
    expect(api.state.webhookEndpoints[0]?.rotationOverlapEndsAt).toBe(OVERLAP)

    // The other refusal a rotation can get.
    api.override('POST', /\/secret\/rotate$/, () =>
      failure(409, 'webhook.rotation_refused', 'Refused.', undefined, {
        reason: 'secret_unreadable',
      })
    )
    await user.click(within(dialog()).getByRole('button', { name: 'Rotate secret' }))
    await waitFor(() =>
      expect(alerts()).toEqual([
        'The server cannot open this endpoint’s current secret, so it could not keep it signing beside a new one. Check that every API instance has the same TULA_MASTER_KEY, or delete the endpoint and add it again.',
      ])
    )
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
  })

  test('ending the overlap asks first and says the old secret stops at once', async () => {
    const { user, api } = withEndpoint({ rotationOverlapEndsAt: OVERLAP })
    await user.click(
      within(await card(HOME)).getByRole('button', {
        name: `End the secret overlap of ${HOME} now`,
      })
    )
    expect(within(dialog()).getByRole('heading').textContent).toBe(
      `End the secret overlap of ${HOME} now?`
    )
    expect(dialog().textContent).toContain(
      'The previous secret stops signing at once and is deleted.'
    )
    expect(dialog().textContent).toContain(
      'A receiver that still verifies with the previous secret alone refuses every delivery from then on'
    )
    expect(api.calls.some((call) => call.method === 'DELETE')).toBe(false)
    await user.click(within(dialog()).getByRole('button', { name: 'End the overlap' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    await screen.findByText('Overlap ended: one secret signs')
    expect(api.state.webhookEndpoints[0]?.rotationOverlapEndsAt).toBeNull()
    await waitFor(() => expect(screen.queryAllByTestId('rotation-overlap')).toHaveLength(0))
  })

  test('an overlap that had already ended is said so', async () => {
    const { user, api } = withEndpoint({ rotationOverlapEndsAt: OVERLAP })
    await card(HOME)
    // It ended by itself between the list being read and the click.
    const endpoint = api.state.webhookEndpoints[0]
    if (endpoint) {
      endpoint.rotationOverlapEndsAt = null
    }
    await user.click(screen.getByRole('button', { name: `End the secret overlap of ${HOME} now` }))
    await user.click(within(dialog()).getByRole('button', { name: 'End the overlap' }))
    await waitFor(() =>
      expect(alerts()).toEqual([
        'No overlap is under way: the previous secret has already stopped signing.',
      ])
    )
  })
})

describe('sending a test event', () => {
  function outcome(): HTMLElement {
    return within(dialog()).getByTestId('send-result')
  }

  test('the type is one of the contract’s; the result is the outcome, a status code and a duration', async () => {
    const { user, api } = withEndpoint({
      eventTypes: ['session.revoked', 'user.created'],
      failingSince: '2026-10-03T08:00:00.000Z',
    })
    await user.click(
      within(await card(HOME)).getByRole('button', { name: `Send a test event to ${HOME}` })
    )
    expect(within(dialog()).getByRole('heading').textContent).toBe('Send a test event')
    // What a test event is, and what it does not do.
    expect(dialog().textContent).toContain('"test": true')
    expect(dialog().textContent).toContain(
      'It does not change the endpoint’s health: a failure does not count towards switching it off, and a success does not end a run of failures.'
    )
    const type = within(dialog()).getByLabelText('Event type') as HTMLSelectElement
    expect([...type.options].map((option) => option.value)).toEqual([...ACTIVITY_TYPES])
    // It starts on a type the endpoint subscribes to.
    expect(type.value).toBe('session.revoked')

    await user.selectOptions(type, 'api_key.created')
    await user.click(within(dialog()).getByRole('button', { name: 'Send test event' }))
    await waitFor(() =>
      expect(outcome().textContent).toBe('Delivered: the endpoint answered 204 in 41 ms.')
    )
    expect(outcome().getAttribute('data-outcome')).toBe('delivered')
    const sent = api.calls.filter((call) => call.path.endsWith('/test'))
    expect(sent.map((call) => call.body)).toEqual([{ eventType: 'api_key.created' }])
    const delivery = api.state.webhookDeliveries[0]
    expect(
      within(dialog()).getByRole('link', { name: 'See this delivery' }).getAttribute('href')
    ).toBe(
      `/dashboard${DEV_PATH}/webhooks/${api.state.webhookEndpoints[0]?.id}/deliveries/${delivery?.id}`
    )

    api.state.webhookReceiver = { statusCode: 500, durationMs: 87, failureReason: null }
    await user.click(within(dialog()).getByRole('button', { name: 'Send test event' }))
    await waitFor(() =>
      expect(outcome().textContent).toBe('Failed: the endpoint answered 500 in 87 ms.')
    )
    expect(outcome().getAttribute('data-outcome')).toBe('failed')

    api.state.webhookReceiver = { statusCode: null, durationMs: 5000, failureReason: 'timeout' }
    await user.click(within(dialog()).getByRole('button', { name: 'Send test event' }))
    await waitFor(() =>
      expect(outcome().textContent).toBe(
        'Failed: there was no answer (5000 ms). No answer within five seconds.'
      )
    )
    // Nothing about the endpoint was asked to change.
    expect(patches(api)).toEqual([])

    await user.click(within(dialog()).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    // Opened again, the last result is not shown.
    await user.click(screen.getByRole('button', { name: `Send a test event to ${HOME}` }))
    expect(within(dialog()).queryAllByTestId('send-result')).toHaveLength(0)
  })

  test('an endpoint that is off can be tested, and the limit on requests is said in words', async () => {
    const { user, api } = withEndpoint({ enabled: false, eventTypes: ['invoice.paid'] })
    api.override('POST', /\/test$/, () => {
      const response = failure(429, 'rate_limited', 'Too many requests.')
      response.headers.set('retry-after', '30')
      return response
    })
    await user.click(
      within(await card(HOME)).getByRole('button', { name: `Send a test event to ${HOME}` })
    )
    // None of its types is one the contract knows: the first of the contract's is offered.
    expect((within(dialog()).getByLabelText('Event type') as HTMLSelectElement).value).toBe(
      'user.created'
    )
    await user.click(within(dialog()).getByRole('button', { name: 'Send test event' }))
    await waitFor(() =>
      expect(alerts()).toEqual([
        'Too many requests. Try again in 30 seconds. Test events and deliveries sent again also have an allowance of their own, for the whole environment.',
      ])
    )
    expect(within(dialog()).queryAllByTestId('send-result')).toHaveLength(0)
  })
})

/** The cells of a table's body rows, as text, without the cells listed in `skip`. */
function bodyRows(table: HTMLElement, skip: number[] = []): string[][] {
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole('cell')
        .map((cell) => cell.textContent ?? '')
        .filter((_text, index) => !skip.includes(index))
    )
}

type FakeDelivery = ReturnType<typeof fakeWebhookDelivery>

/** An endpoint with deliveries, opened at its own screen (or at `options.at`). */
function withDeliveries(
  deliveries: (endpointId: string) => FakeDelivery[],
  options: {
    search?: string
    endpoint?: Parameters<typeof fakeWebhookEndpoint>[0]
    at?: (path: string, made: FakeDelivery[]) => string
  } = {}
) {
  const api = installFakeApi()
  const endpoint = fakeWebhookEndpoint({ url: HOME, ...options.endpoint })
  api.state.webhookEndpoints.push(endpoint)
  const made = deliveries(endpoint.id)
  api.state.webhookDeliveries.push(...made)
  const path = `${DEV_PATH}/webhooks/${endpoint.id}`
  const address = options.at?.(path, made) ?? `${path}${options.search ?? ''}`
  return { ...start(address, { api }), endpoint, made, path }
}

const FAILED_THREE_TIMES = [
  {
    attempt: 1,
    attemptedAt: '2026-10-03T08:00:00.000Z',
    statusCode: 500,
    durationMs: 120,
    failureReason: null,
  },
  {
    attempt: 2,
    attemptedAt: '2026-10-03T08:00:05.000Z',
    statusCode: null,
    durationMs: 5000,
    failureReason: 'timeout',
  },
  {
    attempt: 3,
    attemptedAt: '2026-10-03T08:05:00.000Z',
    statusCode: 503,
    durationMs: 87,
    failureReason: null,
  },
]

describe('the deliveries of an endpoint', () => {
  test('the endpoint and its deliveries: state in words, type, when, requests and the last result', async () => {
    const { made, path } = withDeliveries((id) => [
      fakeWebhookDelivery(id, { createdAt: '2026-10-04T09:00:00.000Z' }),
      fakeWebhookDelivery(id, {
        eventType: 'session.revoked',
        state: 'failed',
        attempts: FAILED_THREE_TIMES,
        createdAt: '2026-10-03T08:00:00.000Z',
      }),
      fakeWebhookDelivery(id, {
        state: 'pending',
        attempts: [],
        completedAt: null,
        createdAt: '2026-10-02T07:00:00.000Z',
      }),
      fakeWebhookDelivery(id, {
        eventType: 'api_key.created',
        eventId: null,
        test: true,
        state: 'failed',
        attempts: [
          {
            attempt: 1,
            attemptedAt: '2026-10-01T06:00:00.000Z',
            statusCode: null,
            durationMs: 5000,
            failureReason: 'timeout',
          },
        ],
        createdAt: '2026-10-01T06:00:00.000Z',
      }),
    ])
    await heading('Webhook endpoint')
    // The endpoint itself, with everything that can be done to it, and no link to this screen.
    const endpoint = await card(HOME)
    expect(within(endpoint).getByTestId('endpoint-state').textContent).toContain('Active')
    expect(within(endpoint).queryAllByRole('link', { name: 'Deliveries' })).toHaveLength(0)
    expect(screen.getByRole('link', { name: '← All webhook endpoints' }).getAttribute('href')).toBe(
      `/dashboard${DEV_PATH}/webhooks`
    )

    const table = await screen.findByRole('table', { name: 'Deliveries' })
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent)
    ).toEqual(['Queued', 'Event type', 'State', 'Requests', 'Last result', 'Attempts'])
    // Without the first cell, which is a time in the reader's locale.
    expect(bodyRows(table, [0])).toEqual([
      ['user.created', 'Delivered', '1', 'HTTP 204', 'See attempts'],
      ['session.revoked', 'Failed', '3', 'HTTP 503', 'See attempts'],
      ['user.created', 'Pending', '0', 'No request yet', 'See attempts'],
      [
        'api_key.createdTest event',
        'Failed',
        '1',
        'No answer within five seconds.',
        'See attempts',
      ],
    ])
    expect(
      [...table.querySelectorAll('time')].map((time) => time.getAttribute('datetime'))
    ).toEqual([
      '2026-10-04T09:00:00.000Z',
      '2026-10-03T08:00:00.000Z',
      '2026-10-02T07:00:00.000Z',
      '2026-10-01T06:00:00.000Z',
    ])
    // Every row's link says which delivery it leads to, and leads there.
    const links = within(table).getAllByRole('link')
    expect(links.map((link) => link.getAttribute('href'))).toEqual(
      made.map((delivery) => `/dashboard${path}/deliveries/${delivery.id}`)
    )
    expect(new Set(links.map((link) => link.getAttribute('aria-label'))).size).toBe(4)
    expect(links[0]?.getAttribute('aria-label')).toStartWith(
      'Attempts of the user.created delivery queued '
    )
  })

  test('the page and the filters are in the address, and what the address cannot mean is dropped', async () => {
    const { user, api, location, path, endpoint } = withDeliveries(
      (id) => [
        ...Array.from({ length: 24 }, () => fakeWebhookDelivery(id)),
        fakeWebhookDelivery(id, { eventType: 'session.revoked', state: 'failed' }),
      ],
      { search: '?state=bogus&eventType=invoice.paid&page=2' }
    )
    const list = () =>
      api
        .callsTo('GET', `/v1/admin/webhook-endpoints/${endpoint.id}/deliveries`)
        .map((call) => call.search.toString())
    const table = await screen.findByRole('table', { name: 'Deliveries' })
    expect(list()).toEqual(['page=2&size=20'])
    expect(bodyRows(table, [0, 3, 4, 5])).toEqual([
      ['user.created', 'Delivered'],
      ['user.created', 'Delivered'],
      ['user.created', 'Delivered'],
      ['user.created', 'Delivered'],
      ['session.revoked', 'Failed'],
    ])
    await user.click(screen.getByRole('button', { name: 'Previous' }))
    await waitFor(() => expect(location()).toBe(path))

    // A filter starts again at the first page.
    await user.click(await screen.findByRole('button', { name: 'Next' }))
    await waitFor(() => expect(location()).toBe(`${path}?page=2`))
    const state = screen.getByLabelText('State') as HTMLSelectElement
    expect([...state.options].map((option) => [option.value, option.textContent])).toEqual([
      ['', 'Any state'],
      ['pending', 'Pending'],
      ['delivered', 'Delivered'],
      ['failed', 'Failed'],
    ])
    await user.selectOptions(state, 'failed')
    await waitFor(() => expect(location()).toBe(`${path}?state=failed`))
    await waitFor(() => expect(list().at(-1)).toBe('state=failed&page=1&size=20'))
    await waitFor(() =>
      expect(bodyRows(screen.getByRole('table', { name: 'Deliveries' }), [0, 3, 4, 5])).toEqual([
        ['session.revoked', 'Failed'],
      ])
    )

    const type = screen.getByLabelText('Event type') as HTMLSelectElement
    expect([...type.options].map((option) => option.value)).toEqual(['', ...ACTIVITY_TYPES])
    await user.selectOptions(type, 'user.created')
    await waitFor(() => expect(location()).toBe(`${path}?state=failed&eventType=user.created`))
    expect((await screen.findByText('No delivery matches these filters')).tagName).toBe('P')
    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    await waitFor(() => expect(location()).toBe(path))
  })

  test('an endpoint with no deliveries says so, and a test event sent from here is listed', async () => {
    const { user } = withDeliveries(() => [])
    expect((await screen.findByText('Nothing has been queued for this endpoint yet')).tagName).toBe(
      'P'
    )
    expect(screen.queryAllByRole('button', { name: 'Clear filters' })).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: `Send a test event to ${HOME}` }))
    await user.click(within(dialog()).getByRole('button', { name: 'Send test event' }))
    await within(dialog()).findByTestId('send-result')
    await user.click(within(dialog()).getByRole('button', { name: 'Close' }))
    const table = await screen.findByRole('table', { name: 'Deliveries' })
    expect(bodyRows(table, [0])).toEqual([
      ['user.createdTest event', 'Delivered', '1', 'HTTP 204', 'See attempts'],
    ])
  })

  test('an endpoint of another environment is not found, and the way back is still there', async () => {
    const api = installFakeApi()
    const elsewhere = fakeWebhookEndpoint({ url: HOME, environmentId: IDS.production })
    api.state.webhookEndpoints.push(elsewhere)
    start(`${DEV_PATH}/webhooks/${elsewhere.id}`, { api })
    await screen.findByText('Webhook endpoint not found')
    await screen.findByText(
      'This environment has no webhook endpoint with that id. It may have been deleted, or the address may be mistyped.'
    )
    // Said as what it is: not as a failure to load, with a "Try again" that cannot help.
    expect(screen.queryAllByRole('alert')).toHaveLength(0)
    expect(screen.queryAllByRole('button', { name: 'Try again' })).toHaveLength(0)
    expect(screen.queryAllByRole('heading', { level: 2, name: HOME })).toHaveLength(0)
    expect(screen.getByRole('link', { name: '← All webhook endpoints' }).getAttribute('href')).toBe(
      `/dashboard${DEV_PATH}/webhooks`
    )
  })

  test('an address that names no id at all reads the same, not as a refused request', async () => {
    const { api } = start(`${DEV_PATH}/webhooks/not-an-id`)
    await screen.findByText('Webhook endpoint not found')
    expect(screen.queryAllByRole('alert')).toHaveLength(0)
    expect(screen.getByRole('link', { name: '← All webhook endpoints' }).getAttribute('href')).toBe(
      `/dashboard${DEV_PATH}/webhooks`
    )
    // Nothing is asked about deliveries of an endpoint that is not there.
    expect(api.calls.filter((call) => call.path.endsWith('/deliveries'))).toHaveLength(0)
  })

  test('a failure that is not “not found” is still a failure, with a way to try again', async () => {
    const api = installFakeApi()
    const endpoint = fakeWebhookEndpoint({ url: HOME })
    api.state.webhookEndpoints.push(endpoint)
    api.override('GET', /^\/v1\/admin\/webhook-endpoints\/[^/]+$/, () =>
      failure(500, 'internal', 'Something went wrong.')
    )
    start(`${DEV_PATH}/webhooks/${endpoint.id}`, { api })
    expect((await screen.findByRole('alert')).textContent).toContain('This could not be loaded')
    expect(screen.getAllByRole('button', { name: 'Try again' })).toHaveLength(1)
    expect(screen.queryAllByText('Webhook endpoint not found')).toHaveLength(0)
  })

  test('deleting the endpoint from its own screen leads back to the list, with no error on the way', async () => {
    const { user, api, location } = withDeliveries((id) => [fakeWebhookDelivery(id)])
    await user.click(within(await card(HOME)).getByRole('button', { name: `Delete ${HOME}` }))
    await user.click(within(dialog()).getByRole('button', { name: 'Delete endpoint' }))
    await waitFor(() => expect(location()).toBe(`${DEV_PATH}/webhooks`))
    await screen.findByText('No webhook endpoints yet')
    expect(screen.queryAllByText('This could not be loaded')).toHaveLength(0)
    expect(api.state.webhookDeliveries).toEqual([])
    // Nothing asked for the endpoint again once it was gone.
    const asked = api.calls.map((call) => `${call.method} ${call.path}`)
    expect(asked.slice(asked.findIndex((line) => line.startsWith('DELETE')) + 1)).toEqual([
      'GET /v1/admin/webhook-endpoints',
    ])
  })
})

describe('one delivery', () => {
  function withDelivery(
    overrides: Parameters<typeof fakeWebhookDelivery>[1] = {},
    endpoint: Parameters<typeof fakeWebhookEndpoint>[0] = {}
  ) {
    const world = withDeliveries((id) => [fakeWebhookDelivery(id, overrides)], {
      endpoint,
      at: (path, made) => `${path}/deliveries/${made[0]?.id}`,
    })
    return { ...world, delivery: world.made[0] as FakeDelivery }
  }

  const FAILED = {
    eventType: 'session.revoked',
    state: 'failed',
    attempts: FAILED_THREE_TIMES,
    createdAt: '2026-10-03T08:00:00.000Z',
    completedAt: '2026-10-03T08:05:00.000Z',
  }

  function fact(name: string): Element | null {
    return within(screen.getByTestId('delivery-facts')).getByText(name, { selector: 'dt' })
      .nextElementSibling
  }

  test('every request is listed with its status code, its duration, its time and why it failed', async () => {
    const { path, delivery } = withDelivery(FAILED)
    await heading('Delivery')
    expect(
      (await screen.findByRole('link', { name: '← Deliveries of this endpoint' })).getAttribute(
        'href'
      )
    ).toBe(`/dashboard${path}`)
    const facts = await screen.findByTestId('delivery-facts')
    expect(fact('Endpoint')?.textContent).toBe(HOME)
    expect(fact('Event type')?.textContent).toBe('session.revoked')
    expect(fact('State')?.textContent).toBe('Failed')
    expect(fact('Event')?.textContent).toBe(delivery.eventId as string)
    expect(fact('Requests made')?.textContent).toBe('3')
    expect(
      [...facts.querySelectorAll('time')].map((time) => time.getAttribute('datetime'))
    ).toEqual(['2026-10-03T08:00:00.000Z', '2026-10-03T08:05:00.000Z'])

    const table = screen.getByRole('table', { name: 'Requests made for this delivery' })
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent)
    ).toEqual(['Request', 'When', 'Answer', 'Duration', 'What went wrong'])
    expect(bodyRows(table, [1])).toEqual([
      ['1', 'HTTP 500', '120 ms', '—'],
      ['2', 'No answer', '5000 ms', 'No answer within five seconds.'],
      ['3', 'HTTP 503', '87 ms', '—'],
    ])
    expect(
      [...table.querySelectorAll('time')].map((time) => time.getAttribute('datetime'))
    ).toEqual(['2026-10-03T08:00:00.000Z', '2026-10-03T08:00:05.000Z', '2026-10-03T08:05:00.000Z'])
  })

  test('sending it again shows the result and the new request, and says what a success does', async () => {
    const { user, api, endpoint, delivery } = withDelivery(FAILED, {
      failingSince: '2026-10-03T08:00:00.000Z',
    })
    const again = await screen.findByRole('button', { name: 'Send again' })
    expect(screen.getByTestId('send-again-note').textContent).toBe(
      'One request is made now, with the same event and the same id, and is not retried. If it gets through, the delivery is delivered and the endpoint’s run of failures ends.'
    )
    await user.click(again)
    await waitFor(() =>
      expect(screen.getByTestId('send-result').textContent).toBe(
        'Delivered: the endpoint answered 204 in 41 ms.'
      )
    )
    expect(
      api.callsTo(
        'POST',
        `/v1/admin/webhook-endpoints/${endpoint.id}/deliveries/${delivery.id}/redeliver`
      )
    ).toHaveLength(1)
    await waitFor(() =>
      expect(
        bodyRows(screen.getByRole('table', { name: 'Requests made for this delivery' }), [1]).at(-1)
      ).toEqual(['4', 'HTTP 204', '41 ms', '—'])
    )
    expect(fact('State')?.textContent).toBe('Delivered')

    // A second try that fails says that, in place of the first result.
    api.state.webhookReceiver = { statusCode: 500, durationMs: 9, failureReason: null }
    await user.click(screen.getByRole('button', { name: 'Send again' }))
    await waitFor(() =>
      expect(screen.getByTestId('send-result').textContent).toBe(
        'Failed: the endpoint answered 500 in 9 ms.'
      )
    )
  })

  test.each([
    [
      'endpoint_disabled',
      'The endpoint is switched off, and nothing is sent to one that is. Switch it on first.',
    ],
    [
      'delivery_pending',
      'The server is still retrying this delivery and will send it by itself. It can be sent again by hand once it has been delivered or given up.',
    ],
    ['attempt_limit', 'This delivery has had twenty requests, the most one delivery can have.'],
    [
      'event_gone',
      'The event is no longer kept (events are kept for 30 days), so there is nothing to send again.',
    ],
    ['a_later_word', 'This delivery cannot be sent again.'],
  ])('a delivery that cannot be sent again (%s) says why in words', async (reason, sentence) => {
    const { user, api } = withDelivery(FAILED)
    api.override('POST', /\/redeliver$/, () =>
      failure(409, 'webhook.cannot_redeliver', 'This delivery cannot be sent again.', undefined, {
        reason,
      })
    )
    await user.click(await screen.findByRole('button', { name: 'Send again' }))
    await waitFor(() =>
      expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toEqual([sentence])
    )
    expect(screen.queryAllByTestId('send-result')).toHaveLength(0)
  })

  test('the limit on requests made on demand is said in words', async () => {
    const { user, api } = withDelivery(FAILED)
    api.override('POST', /\/redeliver$/, () => {
      const response = failure(429, 'rate_limited', 'Too many requests.')
      response.headers.set('retry-after', '12')
      return response
    })
    await user.click(await screen.findByRole('button', { name: 'Send again' }))
    await waitFor(() =>
      expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toEqual([
        'Too many requests. Try again in 12 seconds. Test events and deliveries sent again also have an allowance of their own, for the whole environment.',
      ])
    )
  })

  test('a test event is marked as one and is not offered to be sent again', async () => {
    withDelivery({ eventId: null, test: true, eventType: 'api_key.created' })
    await screen.findByTestId('delivery-facts')
    expect(fact('Event')?.textContent).toBe(
      'A test event, sent on demand. It is no event of this environment.'
    )
    expect(screen.queryAllByRole('button', { name: 'Send again' })).toHaveLength(0)
    expect(screen.getByTestId('send-again-note').textContent).toBe(
      'A test event is not sent again. Send a new one from the endpoint.'
    )
  })

  test('a delivery still pending shows when it is tried next, and one with no request says so', async () => {
    withDelivery({
      state: 'pending',
      attempts: [],
      completedAt: null,
      nextAttemptAt: '2026-10-04T12:05:00.000Z',
    })
    await screen.findByTestId('delivery-facts')
    expect(fact('State')?.textContent).toBe('Pending')
    expect(fact('Next request')?.querySelector('time')?.getAttribute('datetime')).toBe(
      '2026-10-04T12:05:00.000Z'
    )
    expect(screen.getByText('No request has been made for this delivery yet.').tagName).toBe('P')
    expect(screen.queryAllByRole('table')).toHaveLength(0)
  })

  test('a delivery asked for under another endpoint is not found', async () => {
    const api = installFakeApi()
    const mine = fakeWebhookEndpoint({ url: HOME })
    const other = fakeWebhookEndpoint({ url: 'https://other.example.com/in' })
    api.state.webhookEndpoints.push(mine, other)
    const delivery = fakeWebhookDelivery(other.id)
    api.state.webhookDeliveries.push(delivery)
    start(`${DEV_PATH}/webhooks/${mine.id}/deliveries/${delivery.id}`, { api })
    await screen.findByText('Delivery not found')
    await screen.findByText(
      'This endpoint has no delivery with that id. Deliveries are kept for 90 days after they ended, and go with their endpoint when it is deleted.'
    )
    expect(screen.queryAllByRole('alert')).toHaveLength(0)
    expect(screen.queryAllByTestId('delivery-facts')).toHaveLength(0)
    expect(
      screen.getByRole('link', { name: '← Deliveries of this endpoint' }).getAttribute('href')
    ).toBe(`/dashboard${DEV_PATH}/webhooks/${mine.id}`)
  })

  test('a delivery address that names no id at all reads the same', async () => {
    const api = installFakeApi()
    const mine = fakeWebhookEndpoint({ url: HOME })
    api.state.webhookEndpoints.push(mine)
    start(`${DEV_PATH}/webhooks/${mine.id}/deliveries/not-an-id`, { api })
    await screen.findByText('Delivery not found')
    expect(screen.queryAllByRole('alert')).toHaveLength(0)
  })

  test('nor does one under an endpoint that is no id', async () => {
    start(`${DEV_PATH}/webhooks/not-an-id/deliveries/also-not`)
    await screen.findByText('Delivery not found')
    expect(screen.queryAllByRole('alert')).toHaveLength(0)
  })
})
