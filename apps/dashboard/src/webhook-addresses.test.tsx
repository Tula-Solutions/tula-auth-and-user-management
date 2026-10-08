import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor, within } from '@testing-library/react'
import { fakeWebhookDelivery, fakeWebhookEndpoint, IDS, installFakeApi } from '~/testing/fake-api'
import {
  DEV_PATH,
  expectFocus,
  openDialogs,
  PROD_PATH,
  renderApp,
  type World,
} from '~/testing/harness'

// An endpoint's address is text an operator (or whoever had the secret key) typed, and it is
// what a destructive dialog names. It may hold characters nobody can see, or that turn the
// text round. Wherever it is shown, such a character is written out, and the address is
// kept apart from the direction of the text around it.

let world: World | undefined

function start(path: string, options: Parameters<typeof renderApp>[1] = {}): World {
  world = renderApp(path, options)
  return world
}

afterEach(() => {
  world?.queryClient.clear()
  world?.api.restore()
  world = undefined
})

const HOME = 'https://api.example.com/webhooks/tula'
// A right-to-left override and a zero-width space.
const HIDDEN = 'https://api.example.com/\u{202E}gnp.exe\u{200B}/tula'
const SHOWN = 'https://api.example.com/\\u{202E}gnp.exe\\u{200B}/tula'
const PLAIN = 'https://api.example.com/gnp.exe/tula'
const OVERLAP = '2026-10-05T12:00:00.000Z'

function dialog(): HTMLElement {
  return screen.getByRole('dialog')
}

function unseen(text: string | null | undefined): boolean {
  return /[\u{202E}\u{200B}]/u.test(text ?? '')
}

/** The headings of the endpoints' cards (the shell has headings of its own). */
function cardTitles(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('section[aria-labelledby] h2')]
}

/** The element that keeps an address apart from the text around it. */
function isolated(within_: HTMLElement): {
  text: string | null
  dir: string | null
  wraps: boolean
} {
  const bdi = within_.querySelector('bdi')
  return {
    text: bdi?.textContent ?? null,
    dir: bdi?.getAttribute('dir') ?? null,
    wraps: bdi?.classList.contains('break-all') ?? false,
  }
}

describe('an address with characters nobody can see', () => {
  test('is shown with them written out, and is told from the address without them', async () => {
    const api = installFakeApi()
    api.state.webhookEndpoints.push(
      fakeWebhookEndpoint({ url: HIDDEN }),
      fakeWebhookEndpoint({ url: PLAIN })
    )
    start(`${DEV_PATH}/webhooks`, { api })
    await screen.findByRole('heading', { level: 2, name: PLAIN })
    const titles = cardTitles()
    expect(titles.map((title) => title.textContent)).toEqual([SHOWN, PLAIN])
    expect(titles.map(isolated)).toEqual([
      { text: SHOWN, dir: 'ltr', wraps: true },
      { text: PLAIN, dir: 'ltr', wraps: true },
    ])
    // Every control of the card names the endpoint the same way.
    for (const action of ['Edit', 'Switch off', 'Send a test event to', 'Delete']) {
      expect(screen.getAllByRole('button', { name: `${action} ${SHOWN}` })).toHaveLength(1)
    }
    expect(screen.getAllByRole('button', { name: `Rotate the secret of ${SHOWN}` })).toHaveLength(1)
    // Nothing on the page holds the characters themselves, in text or in an attribute.
    expect(unseen(document.body.innerHTML)).toBe(false)
  })

  test('is written out in every dialog that names it, and wraps there', async () => {
    const api = installFakeApi()
    api.state.webhookEndpoints.push(fakeWebhookEndpoint({ url: HIDDEN }))
    const { user } = start(`${DEV_PATH}/webhooks`, { api })
    const opens: [string, string | null][] = [
      [`Delete ${SHOWN}`, `Delete ${SHOWN}?`],
      [`Switch off ${SHOWN}`, `Switch off ${SHOWN}?`],
      [`Rotate the secret of ${SHOWN}`, null],
      [`Send a test event to ${SHOWN}`, null],
    ]
    for (const [control, title] of opens) {
      await user.click(await screen.findByRole('button', { name: control }))
      await waitFor(() => expect(openDialogs()).toBe(1))
      if (title !== null) {
        expect(within(dialog()).getByRole('heading').textContent).toBe(title)
      }
      expect(isolated(dialog())).toEqual({ text: SHOWN, dir: 'ltr', wraps: true })
      expect(unseen(dialog().innerHTML)).toBe(false)
      await user.click(within(dialog()).getByRole('button', { name: /^(Cancel|Close)$/ }))
      await waitFor(() => expect(openDialogs()).toBe(0))
    }
  })

  test('is confirmed by typing what is shown, never what cannot be seen', async () => {
    const api = installFakeApi()
    api.state.webhookEndpoints.push(
      fakeWebhookEndpoint({ url: HIDDEN, environmentId: IDS.production })
    )
    const { user } = start(`${PROD_PATH}/webhooks`, { api })
    await user.click(await screen.findByRole('button', { name: `Delete ${SHOWN}` }))
    const field = within(dialog()).getByLabelText(`Type ${SHOWN} to confirm`)
    const label = dialog().querySelector('label') as HTMLElement
    expect(label.querySelector('bdi')?.textContent).toBe(SHOWN)
    const confirm = within(dialog()).getByRole('button', { name: 'Delete endpoint' })

    // The address as the server holds it is not what the dialog asked for.
    await user.click(field)
    await user.paste(HIDDEN)
    expect(confirm.getAttribute('aria-disabled')).toBe('true')
    await user.click(confirm)
    expect(api.state.webhookEndpoints).toHaveLength(1)

    await user.clear(field)
    await user.paste(SHOWN)
    expect(confirm.getAttribute('aria-disabled')).toBeNull()
    await user.click(confirm)
    await screen.findByText('Endpoint deleted')
    expect(api.state.webhookEndpoints).toHaveLength(0)
  })

  test('is written out on the endpoint’s own screen and on a delivery', async () => {
    const api = installFakeApi()
    const endpoint = fakeWebhookEndpoint({ url: HIDDEN })
    const delivery = fakeWebhookDelivery(endpoint.id)
    api.state.webhookEndpoints.push(endpoint)
    api.state.webhookDeliveries.push(delivery)
    const { router } = start(`${DEV_PATH}/webhooks/${endpoint.id}`, { api })
    expect((await screen.findByRole('heading', { level: 2, name: SHOWN })).textContent).toBe(SHOWN)
    expect(unseen(document.body.innerHTML)).toBe(false)

    await router.navigate({
      href: `${DEV_PATH}/webhooks/${endpoint.id}/deliveries/${delivery.id}`,
    })
    const facts = await screen.findByTestId('delivery-facts')
    await waitFor(() => expect(isolated(facts).text).toBe(SHOWN))
    expect(isolated(facts)).toEqual({ text: SHOWN, dir: 'ltr', wraps: true })
    expect(unseen(document.body.innerHTML)).toBe(false)
  })
})

describe('ending an overlap names the endpoint', () => {
  function withOverlap(environmentId: string, path: string): World {
    const api = installFakeApi()
    api.state.webhookEndpoints.push(
      fakeWebhookEndpoint({ url: HOME, environmentId, rotationOverlapEndsAt: OVERLAP })
    )
    return start(`${path}/webhooks`, { api })
  }

  test('in the title, like every other destructive action', async () => {
    const { user } = withOverlap(IDS.development, DEV_PATH)
    await user.click(
      await screen.findByRole('button', { name: `End the secret overlap of ${HOME} now` })
    )
    expect(within(dialog()).getByRole('heading').textContent).toBe(
      `End the secret overlap of ${HOME} now?`
    )
    expect(isolated(dialog())).toEqual({ text: HOME, dir: 'ltr', wraps: true })
    // Outside production nothing is typed.
    expect(within(dialog()).queryAllByRole('textbox')).toHaveLength(0)
  })

  test('in production the address is typed first', async () => {
    const { user, api } = withOverlap(IDS.production, PROD_PATH)
    await user.click(
      await screen.findByRole('button', { name: `End the secret overlap of ${HOME} now` })
    )
    const confirm = within(dialog()).getByRole('button', { name: 'End the overlap' })
    expect(confirm.getAttribute('aria-disabled')).toBe('true')
    await user.click(confirm)
    expect(api.calls.filter((call) => call.method === 'DELETE')).toHaveLength(0)
    expect(api.state.webhookEndpoints[0]?.rotationOverlapEndsAt).toBe(OVERLAP)

    await user.type(within(dialog()).getByLabelText(`Type ${HOME} to confirm`), HOME)
    expect(confirm.getAttribute('aria-disabled')).toBeNull()
    await user.click(confirm)
    await screen.findByText('Overlap ended: one secret signs')
    expect(api.state.webhookEndpoints[0]?.rotationOverlapEndsAt).toBeNull()
  })
})

describe('the focus is somewhere when what had it is gone', () => {
  test('after a deletion from the list it is on the page’s heading', async () => {
    const api = installFakeApi()
    api.state.webhookEndpoints.push(
      fakeWebhookEndpoint({ url: HOME }),
      fakeWebhookEndpoint({ url: PLAIN })
    )
    const { user } = start(`${DEV_PATH}/webhooks`, { api })
    await user.click(await screen.findByRole('button', { name: `Delete ${HOME}` }))
    await user.click(within(dialog()).getByRole('button', { name: 'Delete endpoint' }))
    await screen.findByText('Endpoint deleted')
    await waitFor(() => expect(cardTitles().map((title) => title.textContent)).toEqual([PLAIN]))
    await expectFocus(screen.getByRole('heading', { level: 1, name: 'Webhooks' }))
  })

  test('after the last endpoint is deleted, too', async () => {
    const api = installFakeApi()
    api.state.webhookEndpoints.push(fakeWebhookEndpoint({ url: HOME }))
    const { user } = start(`${DEV_PATH}/webhooks`, { api })
    await user.click(await screen.findByRole('button', { name: `Delete ${HOME}` }))
    await user.click(within(dialog()).getByRole('button', { name: 'Delete endpoint' }))
    await screen.findByText('No webhook endpoints yet')
    await expectFocus(screen.getByRole('heading', { level: 1, name: 'Webhooks' }))
  })

  test('after an overlap is ended it is on the endpoint’s own heading', async () => {
    const api = installFakeApi()
    api.state.webhookEndpoints.push(
      fakeWebhookEndpoint({ url: PLAIN }),
      fakeWebhookEndpoint({ url: HOME, rotationOverlapEndsAt: OVERLAP })
    )
    const { user } = start(`${DEV_PATH}/webhooks`, { api })
    await user.click(
      await screen.findByRole('button', { name: `End the secret overlap of ${HOME} now` })
    )
    await user.click(within(dialog()).getByRole('button', { name: 'End the overlap' }))
    await screen.findByText('Overlap ended: one secret signs')
    await waitFor(() => expect(openDialogs()).toBe(0))
    await expectFocus(screen.getByRole('heading', { level: 2, name: HOME }))
  })
})

describe('an event type that could be misread says what it is about, where it is chosen', () => {
  const REGISTERED =
    'A hook (a question the server asks your backend before a sign-up) was registered. Not sent when a hook is asked.'
  const REMOVED =
    'A hook (a question the server asks your backend before a sign-up) was removed. Not sent when a hook is asked.'

  function described(control: HTMLElement): string | null {
    const ids = control.getAttribute('aria-describedby')?.split(' ') ?? []
    const text = ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
    return text === '' ? null : text
  }

  test('among the checkboxes of an endpoint’s form', async () => {
    const { user } = start(`${DEV_PATH}/webhooks`)
    await user.click(await screen.findByRole('button', { name: 'Add endpoint' }))
    expect(described(within(dialog()).getByRole('checkbox', { name: 'hook.created' }))).toBe(
      REGISTERED
    )
    expect(described(within(dialog()).getByRole('checkbox', { name: 'user.created' }))).toBeNull()
  })

  test('under the type of a test event, for the type that is chosen', async () => {
    const api = installFakeApi()
    api.state.webhookEndpoints.push(fakeWebhookEndpoint({ url: HOME }))
    const { user } = start(`${DEV_PATH}/webhooks`, { api })
    await user.click(await screen.findByRole('button', { name: `Send a test event to ${HOME}` }))
    const type = within(dialog()).getByLabelText('Event type')
    expect(described(type)).toBeNull()
    await user.selectOptions(type, 'hook.deleted')
    expect(described(type)).toBe(REMOVED)
  })

  test('under the filter of the delivery list', async () => {
    const api = installFakeApi()
    const endpoint = fakeWebhookEndpoint({ url: HOME })
    api.state.webhookEndpoints.push(endpoint)
    const { user } = start(`${DEV_PATH}/webhooks/${endpoint.id}`, { api })
    const type = await screen.findByLabelText('Event type')
    expect(described(type)).toBeNull()
    await user.selectOptions(type, 'hook.deleted')
    await waitFor(() => expect(described(screen.getByLabelText('Event type'))).toBe(REMOVED))
  })
})
