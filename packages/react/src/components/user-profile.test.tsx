import { afterEach, describe, expect, mock, test } from 'bun:test'
import { act, screen, waitFor, within } from '@testing-library/react'
import type { Session } from '@tula/core'
import { StrictMode } from 'react'
import {
  attempt,
  expectAbsent,
  expectFocus,
  failure,
  json,
  openDialogs,
  ROUTE,
  sessionTokens,
  TEST_USER,
  type World,
  world,
} from '../testing/harness'
import { UserProfile } from './user-profile'

const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    client: 'web',
    userAgent: CHROME_MAC,
    ipAddress: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    lastActiveAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
    expiresAt: '2030-01-01T00:00:00.000Z',
    current: false,
    ...overrides,
  }
}

afterEach(() => {
  mock.restore()
})

function signedInWorld(sessions: Session[]): World {
  const w = world({ signedIn: true })
  let list = sessions
  w.api.on(ROUTE.sessions, () => json(200, { data: list }))
  w.api.on(ROUTE.revokeOthers, () => {
    const ended = list.filter((entry) => !entry.current).length
    list = list.filter((entry) => entry.current)
    return json(200, { revoked: ended })
  })
  for (const entry of sessions) {
    w.api.on(`DELETE /v1/client/sessions/${entry.id}`, () => {
      list = list.filter((other) => other.id !== entry.id)
      return new Response(null, { status: 204 })
    })
  }
  return w
}

describe('<UserProfile>', () => {
  test('renders nothing while signed out', async () => {
    const w = world()
    const { container } = w.mount(<UserProfile />)
    await waitFor(() => expect(w.client.state.status).toBe('signed-out'))
    expectAbsent(container.querySelector('[data-tula-element="card"]'))
  })

  test('profile, and the devices with this one marked', async () => {
    const w = signedInWorld([
      session('session_1', { current: true }),
      session('session_2', { userAgent: SAFARI_IPHONE }),
      session('session_3', { userAgent: null, client: 'server' }),
    ])
    w.mount(<UserProfile />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Account' })).toBeTruthy()
    expect(await screen.findByText(TEST_USER.email)).toBeTruthy()
    expect(screen.getByText('Maya')).toBeTruthy()
    expect(screen.getByText('Verified')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: 'Where you’re signed in' })).toBeTruthy()

    const rows = await screen.findAllByRole('listitem')
    const devices = rows.filter((row) => row.getAttribute('data-tula-element') === 'sessionItem')
    expect(devices).toHaveLength(3)
    const [current, phone, unknown] = devices as [HTMLElement, HTMLElement, HTMLElement]
    expect(within(current).getByText('Chrome on macOS')).toBeTruthy()
    expect(within(current).getByText('This device')).toBeTruthy()
    expect(within(current).getByText('Active now')).toBeTruthy()
    // This device has no sign-out button of its own.
    expectAbsent(within(current).queryByRole('button'))
    expect(within(phone).getByText('Safari on iPhone')).toBeTruthy()
    expect(within(phone).getByText('Last active 2 days ago')).toBeTruthy()
    expect(within(phone).getByRole('button', { name: 'Sign out Safari on iPhone' })).toBeTruthy()
    expect(within(unknown).getByText('Unknown device')).toBeTruthy()
  })

  test('sign out one device, then all the others', async () => {
    const w = signedInWorld([
      session('session_1', { current: true }),
      session('session_2', { userAgent: SAFARI_IPHONE }),
      session('session_3'),
      session('session_4'),
    ])
    w.mount(<UserProfile />)
    await w.user.click(await screen.findByRole('button', { name: 'Sign out Safari on iPhone' }))
    expect(await screen.findByText('That device was signed out.')).toBeTruthy()
    expectAbsent(screen.queryByText('Safari on iPhone'))
    expect(w.api.calls('DELETE /v1/client/sessions/session_2')).toHaveLength(1)

    await w.user.click(screen.getByRole('button', { name: 'Sign out of all other devices' }))
    expect(await screen.findByText('Signed out of 2 other devices.')).toBeTruthy()
    // Only this device is left, and with it nothing to sign out.
    expectAbsent(screen.queryByRole('button', { name: 'Sign out of all other devices' }))
    expect(w.client.state.status).toBe('signed-in')
  })

  test('a failed list, and a failed revoke, are reported', async () => {
    const w = world({ signedIn: true })
    w.api.on(ROUTE.sessions, () => failure(503, 'service.unavailable'))
    w.mount(<UserProfile />)
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The service is temporarily unavailable. Try again shortly.'
    )
    expectAbsent(screen.queryByText('Loading your devices…'))
  })

  test('a revoke the server refuses leaves the list and shows why', async () => {
    const w = signedInWorld([session('session_1', { current: true }), session('session_2')])
    w.api.on('DELETE /v1/client/sessions/session_2', () => failure(404, 'resource.not_found'))
    w.api.on(ROUTE.revokeOthers, () => failure(503, 'service.unavailable'))
    w.mount(<UserProfile />)
    await w.user.click(await screen.findByRole('button', { name: 'Sign out Chrome on macOS' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The requested resource does not exist.'
    )
    await w.user.click(screen.getByRole('button', { name: 'Sign out of all other devices' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'The service is temporarily unavailable. Try again shortly.'
      )
    )
    expect(screen.getAllByText('Chrome on macOS')).toHaveLength(2)
  })

  test('change password: fields emptied, a confirmation, and the device list fetched again', async () => {
    const w = signedInWorld([session('session_1', { current: true }), session('session_2')])
    w.api.on(ROUTE.changePassword, () => new Response(null, { status: 204 }))
    w.mount(<UserProfile headingLevel={2} />)
    const current = (await screen.findByLabelText('Current password')) as HTMLInputElement
    const next = screen.getByLabelText('New password') as HTMLInputElement
    expect(current.autocomplete).toBe('current-password')
    expect(next.autocomplete).toBe('new-password')
    expect(screen.getByRole('heading', { level: 3, name: 'Password' })).toBeTruthy()
    // The checklist knows the user: their email may not be part of the password.
    await w.user.type(next, 'maya-is-here-42')
    expect(await screen.findByText('Does not contain your name or email')).toBeTruthy()
    expect(
      screen
        .getByText('Does not contain your name or email')
        .parentElement?.getAttribute('data-met')
    ).toBe('false')
    await w.user.clear(next)

    await w.user.click(screen.getByRole('button', { name: 'Update password' }))
    expect(screen.getAllByRole('alert')).toHaveLength(2)
    await expectFocus(current)

    const before = w.api.calls(ROUTE.sessions).length
    await w.user.type(current, 'old-password-123')
    await w.user.type(next, 'quiet-Heron-wades-17-rivers')
    await w.user.click(screen.getByRole('button', { name: 'Update password' }))
    expect(
      await screen.findByText('Your password was changed. Your other devices were signed out.')
    ).toBeTruthy()
    expect(w.api.calls(ROUTE.changePassword)[0]?.body).toEqual({
      currentPassword: 'old-password-123',
      newPassword: 'quiet-Heron-wades-17-rivers',
    })
    expect(current.value).toBe('')
    expect(next.value).toBe('')
    expect(document.body.innerHTML).not.toContain('quiet-Heron-wades-17-rivers')
    await waitFor(() => expect(w.api.calls(ROUTE.sessions).length).toBe(before + 1))
  })

  test.each([
    [
      'a wrong current password',
      failure(401, 'auth.invalid_credentials'),
      'Current password',
      'That is not your current password.',
    ],
    [
      'a new password the policy rejects',
      failure(422, 'password.too_short', {
        errors: [
          { field: 'newPassword', code: 'password.too_short', message: 'Password is too short.' },
        ],
      }),
      'New password',
      'Password is too short.',
    ],
    [
      'a rule reported for the field `password`',
      failure(422, 'password.breached', {
        errors: [{ field: 'password', code: 'password.breached', message: 'Breached.' }],
      }),
      'New password',
      'Breached.',
    ],
  ] as [string, Response, string, string][])(
    '%s is shown on its field',
    async (_name, response, label, message) => {
      const w = signedInWorld([session('session_1', { current: true })])
      w.api.on(ROUTE.changePassword, () => response)
      w.mount(<UserProfile />)
      await w.user.type(await screen.findByLabelText('Current password'), 'old-password-123')
      await w.user.type(screen.getByLabelText('New password'), 'short')
      await w.user.click(screen.getByRole('button', { name: 'Update password' }))
      expect((await screen.findByRole('alert')).textContent).toBe(message)
      const field = screen.getByLabelText(label) as HTMLInputElement
      expect(field.getAttribute('aria-invalid')).toBe('true')
      expect(document.activeElement === field).toBe(true)
      // A wrong current password is retyped from scratch; a refused new one is kept to be fixed.
      expect(field.value).toBe(label === 'Current password' ? '' : 'short')
    }
  )

  test('a half-typed password and its messages do not carry over to another user (F2)', async () => {
    const w = signedInWorld([session('session_1', { current: true })])
    w.mount(<UserProfile />)
    await w.user.type(await screen.findByLabelText('Current password'), 'first-users-password')
    await w.user.click(screen.getByRole('button', { name: 'Update password' }))
    expect(screen.getAllByRole('alert')).toHaveLength(1)

    w.api.on(ROUTE.me, () =>
      json(200, { ...TEST_USER, id: 'user_2', email: 'other@northline.app' })
    )
    w.api.on(ROUTE.signIn, () =>
      attempt(
        'sign_in',
        { status: 'complete', userId: 'user_2', sessionId: 'session_2' },
        {
          attemptSecret: 'tula_at_test_secret',
          session: sessionTokens('other', { sessionId: 'session_2' }),
        }
      )
    )
    await act(async () => {
      await w.client.signIn.start({ identifier: 'other@northline.app' })
    })
    expect(await screen.findByText('other@northline.app')).toBeTruthy()
    expect((screen.getByLabelText('Current password') as HTMLInputElement).value).toBe('')
    expectAbsent(screen.queryByRole('alert'))
  })

  test('the device list is fetched once, however often effects run', async () => {
    const w = signedInWorld([session('session_1', { current: true })])
    w.mount(
      <StrictMode>
        <UserProfile />
      </StrictMode>
    )
    await screen.findByText('Chrome on macOS')
    expect(w.api.calls(ROUTE.sessions)).toHaveLength(1)
  })

  test('an account without a password, and a lockout, are shown above the form', async () => {
    const w = signedInWorld([session('session_1', { current: true })])
    w.api.on(ROUTE.changePassword, () => failure(409, 'password.not_set'))
    w.mount(<UserProfile />)
    await w.user.type(await screen.findByLabelText('Current password'), 'old-password-123')
    await w.user.type(screen.getByLabelText('New password'), 'quiet-Heron-wades-17-rivers')
    await w.user.click(screen.getByRole('button', { name: 'Update password' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'This account has no password yet.'
    )

    w.api.on(ROUTE.changePassword, () =>
      failure(429, 'rate_limited', { params: { retryAfter: 30 } })
    )
    await w.user.click(screen.getByRole('button', { name: 'Update password' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/Try again in (30|29)s\./)
    )
    expect(
      screen.getByRole('button', { name: 'Update password' }).getAttribute('aria-disabled')
    ).toBe('true')
  })

  test('a user without a password is told how to add one instead of being asked for the current one', async () => {
    const w = signedInWorld([session('session_1', { current: true })])
    w.api.on(ROUTE.me, () => json(200, { ...TEST_USER, hasPassword: false }))
    w.mount(<UserProfile />)
    const heading = await screen.findByRole('heading', { name: 'Password' })
    const section = heading.closest('section') as HTMLElement
    expect(section.getAttribute('aria-labelledby')).toBe(heading.id)
    expect(section.textContent).toContain('This account has no password')
    expect(section.textContent).toContain('Forgot password?')
    expectAbsent(screen.queryByLabelText('Current password'))
    expectAbsent(screen.queryByLabelText('New password'))
    expectAbsent(screen.queryByRole('button', { name: 'Update password' }))
    expect(w.api.calls(ROUTE.changePassword)).toHaveLength(0)
  })

  test('a user with no email address: no address line, no badge and no password section', async () => {
    const w = signedInWorld([session('session_1', { current: true })])
    w.api.on(ROUTE.me, () =>
      json(200, {
        ...TEST_USER,
        firstName: 'Nelly',
        email: null,
        emailVerifiedAt: null,
        hasPassword: false,
      })
    )
    const { container } = w.mount(<UserProfile />)
    expect(await screen.findByText('Nelly')).toBeTruthy()
    await screen.findByRole('heading', { level: 2, name: 'Where you’re signed in' })
    expectAbsent(container.querySelector('.tula-profile-email'))
    expectAbsent(screen.queryByText('Not verified'))
    expectAbsent(screen.queryByText('Verified'))
    // A password signs in beside an address: there is none to add one to, and "Forgot
    // password?" would have nowhere to send its email.
    expectAbsent(screen.queryByRole('heading', { name: 'Password' }))
    expectAbsent(screen.queryByLabelText('Current password'))
    expect(container.textContent).not.toContain('Forgot password?')
    expect(container.textContent).not.toContain('null')
    expect(w.api.calls(ROUTE.changePassword)).toHaveLength(0)
  })

  test('a server that does not say whether there is a password still gets the form', async () => {
    const w = signedInWorld([session('session_1', { current: true })])
    const { hasPassword: _unsaid, ...older } = TEST_USER
    w.api.on(ROUTE.me, () => json(200, older))
    w.mount(<UserProfile />)
    expect(await screen.findByLabelText('Current password')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Update password' })).toBeTruthy()
  })

  test.each([
    ['the server answers 503', () => failure(503, 'service.unavailable')],
    ['the request gets no answer', () => Promise.reject(new TypeError('offline'))],
  ])(
    'sign out when %s: no navigation, an announced error, and trying again finishes it',
    async (_name, refuse) => {
      const w = signedInWorld([session('session_1', { current: true })])
      let failing = true
      w.api.on(ROUTE.signOut, () => (failing ? refuse() : new Response(null, { status: 204 })))
      const navigate = mock()
      w.mount(<UserProfile afterSignOutUrl='/bye' />, { navigate, afterSignOutUrl: '/' })
      const buttons = await screen.findAllByRole('button', { name: 'Sign out' })
      await w.user.click(buttons.at(-1) as HTMLElement)

      // The server may still hold the session (and the browser its cookie): say so, go nowhere.
      const dialog = await screen.findByRole('dialog')
      expect(within(dialog).getByRole('alert').textContent).toContain('may still be signed in')
      expect(navigate).not.toHaveBeenCalled()

      failing = false
      await w.user.click(within(dialog).getByRole('button', { name: 'Try again' }))
      await waitFor(() => expect(navigate).toHaveBeenCalledWith('/bye'))
      await waitFor(() => expect(openDialogs()).toBe(0))
      expect(w.api.calls(ROUTE.signOut)).toHaveLength(2)
    }
  )

  test('sign out: the server is told, then the after-sign-out URL', async () => {
    const w = signedInWorld([session('session_1', { current: true })])
    const navigate = mock()
    const { container } = w.mount(<UserProfile afterSignOutUrl='/bye' />, {
      navigate,
      afterSignOutUrl: '/',
    })
    const buttons = await screen.findAllByRole('button', { name: 'Sign out' })
    await w.user.click(buttons.at(-1) as HTMLElement)
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/bye'))
    expect(w.client.state.status).toBe('signed-out')
    expectAbsent(container.querySelector('[data-tula-element="card"]'))
    expect(openDialogs()).toBe(0)
  })

  test('an unverified email says so', async () => {
    const w = signedInWorld([session('session_1', { current: true })])
    w.api.on(ROUTE.me, () => json(200, { ...TEST_USER, emailVerifiedAt: null, firstName: null }))
    w.mount(<UserProfile />)
    expect(await screen.findByText('Not verified')).toBeTruthy()
  })
})
