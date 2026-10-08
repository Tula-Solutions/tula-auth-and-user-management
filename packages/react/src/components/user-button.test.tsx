import { afterEach, describe, expect, mock, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import { TulaProvider, useTulaContext } from '../context'
import {
  expectAbsent,
  expectFocus,
  failure,
  json,
  openDialogs,
  ROUTE,
  TEST_USER,
  world,
} from '../testing/harness'
import { UserButton } from './user-button'

afterEach(() => {
  mock.restore()
})

function signedIn() {
  const w = world({ signedIn: true })
  w.api.on(ROUTE.sessions, () => json(200, { data: [] }))
  return w
}

const TRIGGER = 'Account menu for Maya'

describe('<UserButton>', () => {
  test('renders nothing while signed out', async () => {
    const w = world()
    w.mount(<UserButton />)
    await waitFor(() => expect(w.client.state.status).toBe('signed-out'))
    expectAbsent(screen.queryByRole('button'))
  })

  test('the trigger shows initials and announces itself as a menu button', async () => {
    const w = signedIn()
    w.mount(<UserButton />)
    const trigger = await screen.findByRole('button', { name: TRIGGER })
    expect(trigger.textContent).toBe('M')
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expectAbsent(screen.queryByRole('menu'))
  })

  test('mouse: click opens with focus on the first item, a click outside closes', async () => {
    const w = signedIn()
    w.mount(
      <>
        <UserButton />
        <button type='button'>elsewhere</button>
      </>
    )
    const trigger = await screen.findByRole('button', { name: TRIGGER })
    await w.user.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const items = screen.getAllByRole('menuitem')
    expect(items.map((item) => item.textContent)).toEqual(['Manage account', 'Sign out'])
    await expectFocus(items[0] as HTMLElement)
    expect(trigger.getAttribute('aria-controls')).toBe(screen.getByRole('menu').id)
    expect(screen.getByText(TEST_USER.email)).toBeTruthy()

    await w.user.click(screen.getByRole('button', { name: 'elsewhere' }))
    expectAbsent(screen.queryByRole('menu'))

    // Clicking the trigger again toggles.
    await w.user.click(trigger)
    expect(screen.getByRole('menu')).toBeTruthy()
    await w.user.click(trigger)
    expectAbsent(screen.queryByRole('menu'))
  })

  test('keyboard: arrows open and move, Home and End jump, Escape closes and returns focus', async () => {
    const w = signedIn()
    w.mount(<UserButton />)
    const trigger = await screen.findByRole('button', { name: TRIGGER })
    await w.user.tab()
    await expectFocus(trigger)
    await w.user.keyboard('{ArrowDown}')
    const [manage, signOut] = screen.getAllByRole('menuitem') as [HTMLElement, HTMLElement]
    await expectFocus(manage)
    await w.user.keyboard('{ArrowDown}')
    await expectFocus(signOut)
    // Wraps around.
    await w.user.keyboard('{ArrowDown}')
    await expectFocus(manage)
    await w.user.keyboard('{ArrowUp}')
    await expectFocus(signOut)
    await w.user.keyboard('{Home}')
    await expectFocus(manage)
    await w.user.keyboard('{End}')
    await expectFocus(signOut)
    await w.user.keyboard('a')
    expect(screen.getByRole('menu')).toBeTruthy()
    await w.user.keyboard('{Escape}')
    expectAbsent(screen.queryByRole('menu'))
    await expectFocus(trigger)

    // Enter opens too (a button's click), and Tab closes the menu behind it.
    await w.user.keyboard('{Enter}')
    expect(screen.getByRole('menu')).toBeTruthy()
    await w.user.tab()
    expectAbsent(screen.queryByRole('menu'))
    trigger.focus()
    await w.user.keyboard('{ArrowUp}')
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  test('sign out: signed out, the menu gone, then the after-sign-out URL', async () => {
    const w = signedIn()
    const navigate = mock()
    w.mount(<UserButton />, { afterSignOutUrl: '/', navigate })
    await w.user.click(await screen.findByRole('button', { name: TRIGGER }))
    await w.user.click(screen.getByRole('menuitem', { name: 'Sign out' }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'))
    expect(w.client.state.status).toBe('signed-out')
    expectAbsent(screen.queryByRole('button'))
    expect(w.api.calls(ROUTE.signOut)).toHaveLength(1)
  })

  test.each([
    ['the server answers 503', () => failure(503, 'service.unavailable')],
    ['the request gets no answer', () => Promise.reject(new TypeError('offline'))],
  ])(
    'sign out when %s: no navigation, an announced error, and trying again finishes it',
    async (_name, refuse) => {
      const w = signedIn()
      let failing = true
      w.api.on(ROUTE.signOut, () => (failing ? refuse() : new Response(null, { status: 204 })))
      const navigate = mock()
      w.mount(<UserButton />, { afterSignOutUrl: '/', navigate })
      await w.user.click(await screen.findByRole('button', { name: TRIGGER }))
      await w.user.click(screen.getByRole('menuitem', { name: 'Sign out' }))

      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toContain('may still be signed in')
      expect(openDialogs()).toBe(1)
      expect(navigate).not.toHaveBeenCalled()

      // A second failure changes nothing: still here, still said, still no navigation.
      const retry = () => screen.getByRole('button', { name: 'Try again' })
      await w.user.click(retry())
      await waitFor(() => expect(w.api.calls(ROUTE.signOut)).toHaveLength(2))
      await waitFor(() => expect(retry().getAttribute('aria-disabled')).toBeNull())
      expect(screen.getByRole('alert').textContent).toContain('may still be signed in')
      expect(navigate).not.toHaveBeenCalled()

      failing = false
      await w.user.click(retry())
      await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'))
      await waitFor(() => expect(openDialogs()).toBe(0))
      expect(navigate).toHaveBeenCalledTimes(1)
      expect(w.api.calls(ROUTE.signOut)).toHaveLength(3)
    }
  )

  test('a failed sign-out that is closed stays where it is', async () => {
    const w = signedIn()
    w.api.on(ROUTE.signOut, () => failure(503, 'service.unavailable'))
    const navigate = mock()
    w.mount(<UserButton />, { afterSignOutUrl: '/', navigate })
    await w.user.click(await screen.findByRole('button', { name: TRIGGER }))
    await w.user.click(screen.getByRole('menuitem', { name: 'Sign out' }))
    await screen.findByRole('alert')
    await w.user.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(navigate).not.toHaveBeenCalled()
    expect(w.api.calls(ROUTE.signOut)).toHaveLength(1)
  })

  test('a client that holds its own refresh token: "Try again" reaches the server with it (review E1)', async () => {
    const w = world({ signedIn: true, kind: 'server' })
    w.api.on(ROUTE.sessions, () => json(200, { data: [] }))
    let failing = true
    w.api.on(ROUTE.signOut, () =>
      failing ? Promise.reject(new TypeError('offline')) : new Response(null, { status: 204 })
    )
    const navigate = mock()
    w.mount(<UserButton />, { afterSignOutUrl: '/', navigate })
    await w.user.click(await screen.findByRole('button', { name: TRIGGER }))
    await w.user.click(screen.getByRole('menuitem', { name: 'Sign out' }))
    await screen.findByRole('alert')
    expect(w.api.calls(ROUTE.signOut).map((request) => request.body)).toEqual([
      { refreshToken: 'rt_1' },
    ])

    failing = false
    await w.user.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'))
    await waitFor(() => expect(openDialogs()).toBe(0))
    // The retry is a request, with the token the first one could not deliver.
    expect(w.api.calls(ROUTE.signOut).map((request) => request.body)).toEqual([
      { refreshToken: 'rt_1' },
      { refreshToken: 'rt_1' },
    ])
    expect(w.client.state.status).toBe('signed-out')
  })

  test('closing the failed-sign-out dialog, its opener gone, puts focus on the first control that can take it (review E2)', async () => {
    const w = signedIn()
    w.api.on(ROUTE.signOut, () => failure(503, 'service.unavailable'))
    w.mount(
      <>
        <button type='button' disabled>
          disabled
        </button>
        <button type='button' tabIndex={-1}>
          skipped
        </button>
        <div hidden>
          <button type='button'>hidden</button>
        </div>
        <input type='hidden' />
        <UserButton />
        <a href='/first'>first</a>
        <button type='button'>second</button>
      </>
    )
    await w.user.click(await screen.findByRole('button', { name: TRIGGER }))
    // The item that asked is unmounted with the menu: the client is signed out at once.
    await w.user.click(screen.getByRole('menuitem', { name: 'Sign out' }))
    await screen.findByRole('alert')
    await w.user.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    await expectFocus(screen.getByRole('link', { name: 'first' }))
  })

  test('with nothing on the page that can take focus, closing the dialog leaves it alone', async () => {
    const w = signedIn()
    w.api.on(ROUTE.signOut, () => failure(503, 'service.unavailable'))
    w.mount(<UserButton />)
    await w.user.click(await screen.findByRole('button', { name: TRIGGER }))
    await w.user.click(screen.getByRole('menuitem', { name: 'Sign out' }))
    await screen.findByRole('alert')
    await w.user.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    await expectFocus(document.body)
  })

  test('closing the failed-sign-out dialog returns focus to its opener when that is still there', async () => {
    const w = signedIn()
    w.api.on(ROUTE.signOut, () => failure(503, 'service.unavailable'))
    function Leave() {
      const { signOut } = useTulaContext()
      return (
        <button type='button' onClick={() => void signOut()}>
          Leave
        </button>
      )
    }
    w.mount(
      <>
        <a href='/first'>first</a>
        <Leave />
      </>
    )
    await waitFor(() => expect(w.client.state.status).toBe('signed-in'))
    const opener = screen.getByRole('button', { name: 'Leave' })
    await w.user.click(opener)
    await screen.findByRole('alert')
    await w.user.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    await expectFocus(opener)
  })

  test('the failed-sign-out dialog closes when the provider is given another client (review E3)', async () => {
    const w = signedIn()
    const other = world()
    w.api.on(ROUTE.signOut, () => failure(503, 'service.unavailable'))
    const view = w.mount(<UserButton />)
    await w.user.click(await screen.findByRole('button', { name: TRIGGER }))
    await w.user.click(screen.getByRole('menuitem', { name: 'Sign out' }))
    await screen.findByRole('alert')
    expect(openDialogs()).toBe(1)
    view.rerender(
      <TulaProvider client={other.client}>
        <UserButton />
      </TulaProvider>
    )
    await waitFor(() => expect(openDialogs()).toBe(0))
    // Nothing of the first client's sign-out was sent again, to either API.
    expect(w.api.calls(ROUTE.signOut)).toHaveLength(1)
    expect(other.api.calls(ROUTE.signOut)).toHaveLength(0)
  })

  test('manage account: the profile opens in a dialog and closing it returns focus', async () => {
    const w = signedIn()
    w.mount(<UserButton />)
    const trigger = await screen.findByRole('button', { name: TRIGGER })
    await w.user.click(trigger)
    await w.user.click(screen.getByRole('menuitem', { name: 'Manage account' }))
    const dialog = await screen.findByRole('dialog', { name: 'Account' })
    expect((dialog as HTMLDialogElement).open).toBe(true)
    expectAbsent(screen.queryByRole('menu'))
    expect(await screen.findByRole('heading', { level: 2, name: 'Account' })).toBeTruthy()
    await w.user.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    await expectFocus(trigger)
  })

  test('manage account goes to the profile page, or to the app’s callback, when given', async () => {
    const w = signedIn()
    const navigate = mock()
    const first = w.mount(<UserButton userProfileUrl='/account' />, { navigate })
    await w.user.click(await screen.findByRole('button', { name: TRIGGER }))
    await w.user.click(screen.getByRole('menuitem', { name: 'Manage account' }))
    expect(navigate).toHaveBeenCalledWith('/account')
    expectAbsent(screen.queryByRole('dialog'))
    first.unmount()

    const onManageAccount = mock()
    w.mount(<UserButton onManageAccount={onManageAccount} userProfileUrl='/account' />, {
      navigate,
    })
    await w.user.click(await screen.findByRole('button', { name: TRIGGER }))
    await w.user.click(screen.getByRole('menuitem', { name: 'Manage account' }))
    expect(onManageAccount).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledTimes(1)
  })

  test('a user with no name is named by their email, with its first letter as the avatar', async () => {
    const w = signedIn()
    w.api.on(ROUTE.me, () => json(200, { ...TEST_USER, firstName: null, lastName: null }))
    w.mount(<UserButton />)
    const trigger = await screen.findByRole('button', {
      name: `Account menu for ${TEST_USER.email}`,
    })
    expect(trigger.textContent).toBe('M')
  })
})
