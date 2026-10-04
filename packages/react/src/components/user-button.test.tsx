import { afterEach, describe, expect, mock, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import { json, openDialogs, ROUTE, TEST_USER, world } from '../testing/harness'
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
    expect(screen.queryByRole('button')).toBeNull()
  })

  test('the trigger shows initials and announces itself as a menu button', async () => {
    const w = signedIn()
    w.mount(<UserButton />)
    const trigger = await screen.findByRole('button', { name: TRIGGER })
    expect(trigger.textContent).toBe('M')
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('menu')).toBeNull()
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
    expect(document.activeElement).toBe(items[0] as HTMLElement)
    expect(trigger.getAttribute('aria-controls')).toBe(screen.getByRole('menu').id)
    expect(screen.getByText(TEST_USER.email)).toBeTruthy()

    await w.user.click(screen.getByRole('button', { name: 'elsewhere' }))
    expect(screen.queryByRole('menu')).toBeNull()

    // Clicking the trigger again toggles.
    await w.user.click(trigger)
    expect(screen.getByRole('menu')).toBeTruthy()
    await w.user.click(trigger)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  test('keyboard: arrows open and move, Home and End jump, Escape closes and returns focus', async () => {
    const w = signedIn()
    w.mount(<UserButton />)
    const trigger = await screen.findByRole('button', { name: TRIGGER })
    await w.user.tab()
    expect(document.activeElement).toBe(trigger)
    await w.user.keyboard('{ArrowDown}')
    const [manage, signOut] = screen.getAllByRole('menuitem') as [HTMLElement, HTMLElement]
    expect(document.activeElement).toBe(manage)
    await w.user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(signOut)
    // Wraps around.
    await w.user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(manage)
    await w.user.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(signOut)
    await w.user.keyboard('{Home}')
    expect(document.activeElement).toBe(manage)
    await w.user.keyboard('{End}')
    expect(document.activeElement).toBe(signOut)
    await w.user.keyboard('a')
    expect(screen.getByRole('menu')).toBeTruthy()
    await w.user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    // Enter opens too (a button's click), and Tab closes the menu behind it.
    await w.user.keyboard('{Enter}')
    expect(screen.getByRole('menu')).toBeTruthy()
    await w.user.tab()
    expect(screen.queryByRole('menu')).toBeNull()
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
    expect(screen.queryByRole('button')).toBeNull()
    expect(w.api.calls(ROUTE.signOut)).toHaveLength(1)
  })

  test('manage account: the profile opens in a dialog and closing it returns focus', async () => {
    const w = signedIn()
    w.mount(<UserButton />)
    const trigger = await screen.findByRole('button', { name: TRIGGER })
    await w.user.click(trigger)
    await w.user.click(screen.getByRole('menuitem', { name: 'Manage account' }))
    const dialog = await screen.findByRole('dialog', { name: 'Account' })
    expect((dialog as HTMLDialogElement).open).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(await screen.findByRole('heading', { level: 2, name: 'Account' })).toBeTruthy()
    await w.user.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(document.activeElement).toBe(trigger)
  })

  test('manage account goes to the profile page, or to the app’s callback, when given', async () => {
    const w = signedIn()
    const navigate = mock()
    const first = w.mount(<UserButton userProfileUrl='/account' />, { navigate })
    await w.user.click(await screen.findByRole('button', { name: TRIGGER }))
    await w.user.click(screen.getByRole('menuitem', { name: 'Manage account' }))
    expect(navigate).toHaveBeenCalledWith('/account')
    expect(screen.queryByRole('dialog')).toBeNull()
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
