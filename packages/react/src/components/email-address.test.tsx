import { afterEach, describe, expect, mock, test } from 'bun:test'
import { act, screen, waitFor, within } from '@testing-library/react'
import {
  expectAbsent,
  expectFocus,
  failure,
  json,
  openDialogs,
  ROUTE,
  TEST_USER,
  type World,
  world,
} from '../testing/harness'
import { UserProfile } from './user-profile'

const ADDRESS = 'maya.new@example.com'
const VERIFIED_AT = '2030-01-01T00:05:00.000Z'
const INBOX =
  'Check m***@example.com. If that address can be added to this account, the email we sent holds a 6-digit code.'

afterEach(() => {
  mock.restore()
})

/** A signed-in user with no address (an X sign-up), whose address the fake API keeps. */
function addresslessWorld(options: { email?: string } = {}) {
  const w: World = world({ signedIn: true })
  const state = {
    email: options.email ?? null,
    pending: null as string | null,
    code: '482913',
  }
  const user = () => ({
    ...TEST_USER,
    email: state.email,
    emailVerifiedAt: state.email ? VERIFIED_AT : null,
    hasPassword: false,
  })
  w.api.on(ROUTE.me, () => json(200, user()))
  w.api.on(ROUTE.sessions, () => json(200, { data: [] }))
  w.api.on(ROUTE.emailAddress, (request) => {
    state.pending = String((request.body as { email: string }).email)
    return json(200, { destination: 'm***@example.com', expiresAt: '2030-01-01T00:10:00.000Z' })
  })
  w.api.on(ROUTE.emailAddressVerify, (request) => {
    if ((request.body as { code: string }).code !== state.code || state.pending === null) {
      return failure(422, 'verification.invalid_code')
    }
    state.email = state.pending
    state.pending = null
    return json(200, user())
  })
  return { w, state }
}

const section = async () =>
  (await screen.findByRole('heading', { name: 'Email address' })).closest('section') as HTMLElement

/** Open the form and ask for a code to `typed`; resolves on the code screen. */
async function askFor(w: World, part: HTMLElement, typed = ADDRESS) {
  await w.user.click(await within(part).findByRole('button', { name: 'Add an email address' }))
  await w.user.type(within(part).getByLabelText('Email address'), typed)
  await w.user.click(within(part).getByRole('button', { name: 'Send code' }))
  return within(part).findByLabelText('Verification code')
}

describe('<UserProfile> email address for an account without one', () => {
  test('a user with an address: no section', async () => {
    const { w } = addresslessWorld({ email: 'maya@example.com' })
    w.mount(<UserProfile />)
    expect(await screen.findByRole('heading', { name: 'Where you’re signed in' })).toBeTruthy()
    expect(await screen.findByText('maya@example.com')).toBeTruthy()
    expectAbsent(screen.queryByRole('heading', { name: 'Email address' }))
  })

  test('adding an address: the address, the emailed code, then the address on the account', async () => {
    const { w, state } = addresslessWorld()
    const { container } = w.mount(<UserProfile />)
    const part = await section()
    expect(within(part).getByRole('heading', { level: 2, name: 'Email address' })).toBeTruthy()
    expect(within(part).getByText('This account has no email address.')).toBeTruthy()

    await w.user.click(within(part).getByRole('button', { name: 'Add an email address' }))
    const address = within(part).getByLabelText('Email address') as HTMLInputElement
    await expectFocus(address)
    expect(address.type).toBe('email')
    expect(address.autocomplete).toBe('email')

    await w.user.type(address, ADDRESS)
    await w.user.click(within(part).getByRole('button', { name: 'Send code' }))
    expect(w.api.calls(ROUTE.emailAddress)[0]?.body).toEqual({ email: ADDRESS })

    const code = (await within(part).findByLabelText('Verification code')) as HTMLInputElement
    await expectFocus(code)
    // Where to look, and never "we sent a code": a taken address is sent none.
    expect(within(part).getByText(INBOX)).toBeTruthy()
    // Only the server's mask of the address is drawn once it was sent.
    expect(part.textContent).not.toContain(ADDRESS)

    await w.user.type(code, state.code)
    await w.user.click(within(part).getByRole('button', { name: 'Verify' }))
    expect(await within(part).findByText('Your email address was added.')).toBeTruthy()
    expect(w.api.calls(ROUTE.emailAddressVerify)[0]?.body).toEqual({ code: state.code })
    // The form is gone, reading resumes at the section's title, and the profile has the address.
    await expectFocus(within(part).getByRole('heading', { name: 'Email address' }))
    expectAbsent(within(part).queryByLabelText('Verification code'))
    expectAbsent(within(part).queryByRole('button', { name: 'Add an email address' }))
    expect(await screen.findByText(ADDRESS)).toBeTruthy()
    // The code was state only while its field was shown.
    expect(container.innerHTML).not.toContain(state.code)
    // And the client's state has the address, without another request for the user.
    expect(w.client.state).toMatchObject({ user: { email: ADDRESS } })
  })

  test('nothing typed: the fields say so and no request is made', async () => {
    const { w } = addresslessWorld()
    w.mount(<UserProfile />)
    const part = await section()
    await w.user.click(await within(part).findByRole('button', { name: 'Add an email address' }))
    await w.user.click(within(part).getByRole('button', { name: 'Send code' }))
    expect(await within(part).findByRole('alert')).toBeTruthy()
    expect(w.api.calls(ROUTE.emailAddress)).toHaveLength(0)

    await w.user.type(within(part).getByLabelText('Email address'), ADDRESS)
    await w.user.click(within(part).getByRole('button', { name: 'Send code' }))
    await within(part).findByLabelText('Verification code')
    await w.user.click(within(part).getByRole('button', { name: 'Verify' }))
    expect(await within(part).findByRole('alert')).toBeTruthy()
    expect(w.api.calls(ROUTE.emailAddressVerify)).toHaveLength(0)
  })

  test('an address the server refuses is said at its field', async () => {
    const { w } = addresslessWorld()
    w.mount(<UserProfile />)
    const part = await section()
    w.api.on(ROUTE.emailAddress, () => failure(422, 'email.invalid'))
    await w.user.click(await within(part).findByRole('button', { name: 'Add an email address' }))
    const address = within(part).getByLabelText('Email address')
    await w.user.type(address, 'maya@nowhere')
    await w.user.click(within(part).getByRole('button', { name: 'Send code' }))
    await waitFor(() => expect(address.getAttribute('aria-invalid')).toBe('true'))
    expectAbsent(within(part).queryByLabelText('Verification code'))
  })

  test('a wrong code is said at the code field, which is emptied; the right one then works', async () => {
    const { w, state } = addresslessWorld()
    w.mount(<UserProfile />)
    const part = await section()
    const code = (await askFor(w, part)) as HTMLInputElement
    await w.user.type(code, '000000')
    await w.user.click(within(part).getByRole('button', { name: 'Verify' }))
    await waitFor(() => expect(code.getAttribute('aria-invalid')).toBe('true'))
    expect(code.value).toBe('')
    await w.user.type(code, state.code)
    await w.user.click(within(part).getByRole('button', { name: 'Verify' }))
    expect(await within(part).findByText('Your email address was added.')).toBeTruthy()
  })

  test('“Use a different address” goes back to the address, kept; “Cancel” leaves everything as it was', async () => {
    const { w } = addresslessWorld()
    w.mount(<UserProfile />)
    const part = await section()
    await askFor(w, part)
    await w.user.click(within(part).getByRole('button', { name: 'Use a different address' }))
    const address = within(part).getByLabelText('Email address') as HTMLInputElement
    await expectFocus(address)
    expect(address.value).toBe(ADDRESS)
    await w.user.click(within(part).getByRole('button', { name: 'Cancel' }))
    await expectFocus(within(part).getByRole('button', { name: 'Add an email address' }))
    expect(within(part).getByText('This account has no email address.')).toBeTruthy()
    expect(w.api.calls(ROUTE.emailAddressVerify)).toHaveLength(0)
  })

  test('a user with nothing to step up with is told to sign in again, and nothing is shown as an error', async () => {
    const { w } = addresslessWorld()
    w.mount(<UserProfile />)
    const part = await section()
    w.api.on(ROUTE.emailAddress, () =>
      failure(403, 'auth.step_up_required', { params: { methods: '' } })
    )
    await w.user.click(await within(part).findByRole('button', { name: 'Add an email address' }))
    await w.user.type(within(part).getByLabelText('Email address'), ADDRESS)
    await w.user.click(within(part).getByRole('button', { name: 'Send code' }))
    const dialog = await screen.findByRole('dialog', { name: 'Confirm it is you' })
    expect(
      within(dialog).getByText('For your security, sign out and sign in again to continue.')
    ).toBeTruthy()
    await w.user.click(within(dialog).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expectAbsent(within(part).queryByRole('alert'))
    expectAbsent(within(part).queryByLabelText('Verification code'))
    expect(w.api.calls(ROUTE.emailAddress)).toHaveLength(1)
  })

  test('an answer that arrives after the user signed out sets nothing', async () => {
    const { w, state } = addresslessWorld()
    w.mount(<UserProfile />)
    const part = await section()
    const code = await askFor(w, part)
    let release: (response: Response) => void = () => undefined
    w.api.on(
      ROUTE.emailAddressVerify,
      () => new Promise<Response>((resolve) => (release = resolve))
    )
    await w.user.type(code, state.code)
    await w.user.click(within(part).getByRole('button', { name: 'Verify' }))
    await act(async () => {
      await w.client.session.signOut()
    })
    await waitFor(() => expect(w.client.state.status).toBe('signed-out'))
    await act(async () => {
      release(json(200, { ...TEST_USER, email: ADDRESS, emailVerifiedAt: VERIFIED_AT }))
    })
    await waitFor(() => expectAbsent(screen.queryByRole('heading', { name: 'Email address' })))
    expect(w.client.state.status).toBe('signed-out')
  })
})
