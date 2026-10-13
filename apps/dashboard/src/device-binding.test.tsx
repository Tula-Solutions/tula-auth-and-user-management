import { afterEach, describe, expect, test } from 'bun:test'
import { screen, waitFor, within } from '@testing-library/react'
import { IDS } from '~/testing/fake-api'
import { DEV_PATH, openDialogs, renderApp, type World } from '~/testing/harness'

// The device-binding option of a session profile (ADR 0043), on the session profiles
// screen: one more field of the settings editor's one draft, saved by its one save path.

let world: World | undefined

function start(path = `${DEV_PATH}/sessions`): World {
  world = renderApp(path)
  return world
}

afterEach(() => {
  world?.api.restore()
  world = undefined
})

/** The profiles the fake API holds, as the document's own (open) shape. */
function saved(current: World) {
  return (
    current.api.state.settings.settings.sessions as unknown as {
      profiles: Record<string, { deviceBinding: string; type: string }>
    }
  ).profiles
}

async function card(pattern: RegExp): Promise<HTMLElement> {
  return (await screen.findByRole('heading', { name: pattern })).closest('li') as HTMLElement
}

function binding(profile: HTMLElement): HTMLSelectElement {
  return within(profile).getByLabelText('Device binding') as HTMLSelectElement
}

async function save(current: World) {
  await current.user.click(screen.getByRole('button', { name: 'Save changes' }))
}

describe('device binding on the session profiles screen', () => {
  test('each profile shows its value, and says who it reaches and what a change leaves alone', async () => {
    start()
    const web = await card(/^web/)
    const mobile = await card(/^mobile/)
    expect(binding(web).value).toBe('none')
    expect(binding(mobile).value).toBe('optional')
    expect(within(web).getByText(/a browser’s session is never bound to a device key/)).toBeTruthy()
    expect(within(mobile).getByText(/Browsers are not affected\./)).toBeTruthy()
    expect(
      within(mobile).getByText(
        /A change applies to new sign-ins only: a session that exists keeps the key it has, or goes on without one\./
      )
    ).toBeTruthy()
  })

  test('asking for more is saved without a question', async () => {
    const current = start()
    await current.user.selectOptions(binding(await card(/^mobile/)), 'required')
    await save(current)
    await screen.findByText('Settings saved')
    expect(openDialogs()).toBe(0)
    expect(saved(current).mobile?.deviceBinding).toBe('required')
    expect(saved(current).web?.deviceBinding).toBe('none')
  })

  test.each([
    ['required', 'optional'],
    ['required', 'none'],
    ['optional', 'none'],
  ])('asking for less (%s to %s) asks first, in the operator’s words', async (from, to) => {
    const current = start()
    ;(saved(current).mobile as { deviceBinding: string }).deviceBinding = from
    const mobile = await card(/^mobile/)
    expect(binding(mobile).value).toBe(from)
    await current.user.selectOptions(binding(mobile), to)
    await save(current)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('This weakens security. Save anyway?')).toBeTruthy()
    expect(
      within(dialog).getByText(
        /Native apps that sign in under the “mobile” profile are asked less for a device key.*Sessions that exist are not changed/
      )
    ).toBeTruthy()
    // Nothing is sent until the answer.
    expect(saved(current).mobile?.deviceBinding).toBe(from)
    await current.user.click(within(dialog).getByRole('button', { name: 'Save anyway' }))
    await screen.findByText('Settings saved')
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(saved(current).mobile?.deviceBinding).toBe(to)
  })

  test.each(['optional', 'required'])(
    'a new profile asks what the mobile profile asks (%s), not the web profile’s nothing',
    async (mobileValue) => {
      const current = start()
      ;(saved(current).mobile as { deviceBinding: string }).deviceBinding = mobileValue
      await current.user.type(await screen.findByLabelText('New profile name'), 'kiosk')
      await current.user.click(screen.getByRole('button', { name: 'Add profile' }))
      expect(binding(await card(/^kiosk/)).value).toBe(mobileValue)
      await save(current)
      await screen.findByText('Settings saved')
      // Adding a profile weakens nothing, so nothing was asked.
      expect(openDialogs()).toBe(0)
      expect(saved(current).kiosk?.deviceBinding).toBe(mobileValue)
    }
  )

  test('a stateful profile says the value changes nothing for it', async () => {
    const current = start()
    const mobile = await card(/^mobile/)
    await current.user.selectOptions(within(mobile).getByLabelText('Type'), 'stateful')
    expect(
      within(mobile).getByText(/the value changes nothing while the type is stateful/)
    ).toBeTruthy()
  })
})

describe('a user’s sessions', () => {
  test('say in words whether each is bound to a device key', async () => {
    const current = renderApp(`${DEV_PATH}/users/${IDS.user}`)
    world = current
    const [first] = current.api.state.sessions
    current.api.state.sessions = [
      { ...first, deviceBound: true },
      { ...first, id: '00000000-0000-7000-8000-00000000f0f0', deviceBound: false },
    ]
    const table = await screen.findByRole('table', { name: 'Active sessions' })
    expect(within(table).getByRole('columnheader', { name: 'Device key' })).toBeTruthy()
    expect(within(table).getAllByText('Bound')).toHaveLength(1)
    expect(within(table).getAllByText('Not bound')).toHaveLength(1)
  })
})
