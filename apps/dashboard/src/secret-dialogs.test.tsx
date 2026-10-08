import { afterEach, describe, expect, test } from 'bun:test'
import { act, screen, waitFor, within } from '@testing-library/react'
import { fakeWebhookEndpoint, installFakeApi } from '~/testing/fake-api'
import {
  DEV_PATH,
  expectFocus,
  holdAnswers,
  openDialogs,
  renderApp,
  type World,
} from '~/testing/harness'

// A dialog whose answer carries a secret that is shown once: a new webhook endpoint, a
// rotated signing secret, a new API key. The server has acted by the time it answers, so the
// dialog must still be there to show the answer, and must forget it when it closes.

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
const WAIT = 'Wait for the server’s answer: it carries the secret, which is shown only this once.'

function dialog(): HTMLDialogElement {
  return screen.getByRole('dialog') as HTMLDialogElement
}

function button(name: string): HTMLElement {
  return within(dialog()).getByRole('button', { name })
}

/** What the platform does for Escape on a modal dialog: a `cancel` event that can be refused. */
function pressEscape(): boolean {
  const asked = new Event('cancel', { cancelable: true })
  act(() => {
    dialog().dispatchEvent(asked)
  })
  return asked.defaultPrevented
}

/**
 * Try every way out of the open dialog while its request is in flight, and expect each to be
 * refused: Cancel (which says why), Escape, and the close a second Escape forces.
 */
async function expectNoWayOut(current: World): Promise<void> {
  const cancel = button('Cancel')
  expect(cancel.getAttribute('aria-disabled')).toBe('true')
  const reason = document.getElementById(cancel.getAttribute('aria-describedby') ?? '')
  expect(reason?.textContent).toBe(WAIT)
  await current.user.click(cancel)
  expect(openDialogs()).toBe(1)
  expect(pressEscape()).toBe(true)
  expect(openDialogs()).toBe(1)
  // A browser closes a dialog on a second Escape whatever the first was answered with.
  act(() => {
    dialog().close()
  })
  expect(openDialogs()).toBe(1)
  expect(dialog().open).toBe(true)
}

describe('a dialog whose answer carries a secret cannot be left while its request is in flight', () => {
  test('a new webhook endpoint: the secret is shown when the answer comes, and the list is right', async () => {
    const current = start(`${DEV_PATH}/webhooks`)
    const { user, api } = current
    await user.click(await screen.findByRole('button', { name: 'Add endpoint' }))
    await user.type(within(dialog()).getByLabelText('Address'), HOME)
    await user.click(within(dialog()).getByRole('checkbox', { name: 'user.created' }))
    const hold = holdAnswers(
      (path, _headers, method) => method === 'POST' && path === '/v1/admin/webhook-endpoints'
    )
    await user.click(button('Add endpoint'))
    await waitFor(() => expect(hold.held()).toBe(1))
    // In words, not only a dimmed button.
    expect(button('Creating…').getAttribute('aria-busy')).toBe('true')
    await expectNoWayOut(current)
    // The server has made the endpoint and its secret; only the answer is still to come.
    expect(api.state.webhookEndpoints).toHaveLength(1)

    await act(() => hold.release())
    const secret = (await within(dialog()).findByTestId('webhook-secret')).textContent ?? ''
    expect(secret).toStartWith('whsec_')
    // The view changed under the reader: the focus is on what it now says.
    await expectFocus(
      within(dialog()).getByRole('heading', { name: 'Copy the signing secret now' })
    )
    await user.click(button('I have copied it'))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(screen.getAllByRole('heading', { level: 2, name: HOME })).toHaveLength(1)
  })

  test('a rotated secret: shown when the answer comes, with the overlap on the card', async () => {
    const api = installFakeApi()
    api.state.webhookEndpoints.push(fakeWebhookEndpoint({ url: HOME }))
    const current = start(`${DEV_PATH}/webhooks`, { api })
    const { user } = current
    await user.click(await screen.findByRole('button', { name: `Rotate the secret of ${HOME}` }))
    const hold = holdAnswers(
      (path, _headers, method) => method === 'POST' && path.endsWith('/secret/rotate')
    )
    await user.click(button('Rotate secret'))
    await waitFor(() => expect(hold.held()).toBe(1))
    expect(button('Rotating…').getAttribute('aria-busy')).toBe('true')
    await expectNoWayOut(current)
    expect(api.state.webhookEndpoints[0]?.rotationOverlapEndsAt).toBe('2026-10-05T12:00:00.000Z')

    await act(() => hold.release())
    const secret = (await within(dialog()).findByTestId('webhook-secret')).textContent ?? ''
    expect(secret).toStartWith('whsec_')
    await expectFocus(within(dialog()).getByRole('heading', { name: 'Copy the new secret now' }))
    await user.click(button('I have copied it'))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(screen.getAllByTestId('rotation-overlap')).toHaveLength(1)
  })

  test('a new API key: the same', async () => {
    const current = start(`${DEV_PATH}/api-keys`)
    const { user, api } = current
    await user.click(await screen.findByRole('button', { name: 'Create key' }))
    await user.type(within(dialog()).getByLabelText('Name'), 'Web app')
    const hold = holdAnswers(
      (path, _headers, method) => method === 'POST' && path === '/v1/admin/api-keys'
    )
    await user.click(button('Create key'))
    await waitFor(() => expect(hold.held()).toBe(1))
    expect(button('Creating…').getAttribute('aria-busy')).toBe('true')
    await expectNoWayOut(current)
    expect(api.callsTo('POST', '/v1/admin/api-keys')).toHaveLength(1)

    await act(() => hold.release())
    const key = (await within(dialog()).findByTestId('created-key')).textContent ?? ''
    expect(key).toStartWith('tula_pk_')
    await expectFocus(within(dialog()).getByRole('heading', { name: 'Copy this key now' }))
    await user.click(button('I have copied it'))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(
      screen.getAllByRole('row').filter((row) => row.textContent?.includes('Web app'))
    ).toHaveLength(1)
  })

  test('the list is marked for a refresh even when the screen that asked is gone', async () => {
    const current = start(`${DEV_PATH}/webhooks`)
    const { user, router, queryClient, location } = current
    await user.click(await screen.findByRole('button', { name: 'Add endpoint' }))
    await user.type(within(dialog()).getByLabelText('Address'), HOME)
    await user.click(within(dialog()).getByRole('checkbox', { name: 'user.created' }))
    const hold = holdAnswers(
      (path, _headers, method) => method === 'POST' && path === '/v1/admin/webhook-endpoints'
    )
    await user.click(button('Add endpoint'))
    await waitFor(() => expect(hold.held()).toBe(1))
    // The address can still change under a modal dialog (the browser's own buttons).
    await act(() => router.navigate({ href: `${DEV_PATH}/api-keys` }))
    await waitFor(() => expect(location()).toBe(`${DEV_PATH}/api-keys`))
    await screen.findByRole('heading', { level: 1, name: 'API keys' })
    const list = () => queryClient.getQueryState(['/v1/admin/webhook-endpoints'])
    expect(list()?.isInvalidated).toBe(false)

    await act(() => hold.release())
    await waitFor(() => expect(list()?.isInvalidated).toBe(true))
    // The secret is lost with the dialog, and is shown nowhere.
    expect(document.documentElement.outerHTML.includes('whsec_')).toBe(false)
    await act(() => router.navigate({ href: `${DEV_PATH}/webhooks` }))
    await screen.findByRole('heading', { level: 2, name: HOME })
  })
})

describe('a secret is forgotten when its dialog closes, with no reload in between', () => {
  test('adding a second endpoint starts from the empty form', async () => {
    const { user } = start(`${DEV_PATH}/webhooks`)
    await user.click(await screen.findByRole('button', { name: 'Add endpoint' }))
    await user.type(within(dialog()).getByLabelText('Address'), HOME)
    await user.click(within(dialog()).getByRole('checkbox', { name: 'user.created' }))
    await user.click(button('Add endpoint'))
    const secret = (await within(dialog()).findByTestId('webhook-secret')).textContent ?? ''
    await user.click(button('I have copied it'))
    await waitFor(() => expect(openDialogs()).toBe(0))

    await user.click(screen.getByRole('button', { name: 'Add endpoint' }))
    expect(within(dialog()).getByRole('heading').textContent).toBe('Add a webhook endpoint')
    expect((within(dialog()).getByLabelText('Address') as HTMLInputElement).value).toBe('')
    expect(screen.queryAllByTestId('webhook-secret')).toHaveLength(0)
    expect(document.documentElement.outerHTML.includes(secret)).toBe(false)
  })

  test('rotating asks again, and does not show the last secret', async () => {
    const api = installFakeApi()
    api.state.webhookEndpoints.push(fakeWebhookEndpoint({ url: HOME }))
    const { user } = start(`${DEV_PATH}/webhooks`, { api })
    const open = () =>
      user.click(screen.getByRole('button', { name: `Rotate the secret of ${HOME}` }))
    await screen.findByRole('heading', { level: 2, name: HOME })
    await open()
    await user.click(button('Rotate secret'))
    const secret = (await within(dialog()).findByTestId('webhook-secret')).textContent ?? ''
    await user.click(button('I have copied it'))
    await waitFor(() => expect(openDialogs()).toBe(0))

    await open()
    expect(within(dialog()).getByRole('heading').textContent).toBe('Rotate the signing secret?')
    expect(screen.queryAllByTestId('webhook-secret')).toHaveLength(0)
    expect(document.documentElement.outerHTML.includes(secret)).toBe(false)
  })
})
