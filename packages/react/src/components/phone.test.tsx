import { afterEach, describe, expect, mock, test } from 'bun:test'
import { act, screen, waitFor, within } from '@testing-library/react'
import {
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

const NUMBER = '+14155550142'
const VERIFIED_AT = '2030-01-01T00:05:00.000Z'
const STEP_UP = 'POST /v1/client/sessions/step-up'

afterEach(() => {
  mock.restore()
})

/** A signed-in user whose phone number the fake API keeps, as the real one does. */
function phoneWorld(options: { number?: string; enabled?: boolean } = {}) {
  const w: World = world({ signedIn: true, phone: options.enabled ?? true })
  const state = { number: options.number ?? null, pending: null as string | null, code: '482913' }
  const user = () => ({
    ...TEST_USER,
    phoneNumber: state.number,
    phoneNumberVerifiedAt: state.number ? VERIFIED_AT : null,
  })
  w.api.on(ROUTE.me, () => json(200, user()))
  w.api.on(ROUTE.sessions, () => json(200, { data: [] }))
  w.api.on(ROUTE.phone, (request) => {
    state.pending = String((request.body as { phoneNumber: string }).phoneNumber).replace(
      /[\s()-]/g,
      ''
    )
    return json(200, {
      destination: `***${state.pending.slice(-2)}`,
      expiresAt: '2030-01-01T00:10:00.000Z',
    })
  })
  w.api.on(ROUTE.phoneVerify, (request) => {
    if ((request.body as { code: string }).code !== state.code || state.pending === null) {
      return failure(422, 'verification.invalid_code')
    }
    state.number = state.pending
    state.pending = null
    return json(200, user())
  })
  w.api.on(ROUTE.phoneRemove, () => {
    state.number = null
    return new Response(null, { status: 204 })
  })
  return { w, state }
}

const section = async () =>
  (await screen.findByRole('heading', { name: 'Phone number' })).closest('section') as HTMLElement

/** Open the form and ask for a code to `typed`; resolves on the code screen. */
async function askFor(w: World, phone: HTMLElement, typed = '+1 (415) 555-0142') {
  await w.user.click(await within(phone).findByRole('button', { name: 'Add a phone number' }))
  await w.user.type(within(phone).getByLabelText('Phone number'), typed)
  await w.user.click(within(phone).getByRole('button', { name: 'Send code' }))
  return within(phone).findByLabelText('Verification code')
}

describe('<UserProfile> phone number', () => {
  test('an app that sends no text messages, and a user with no number: no section', async () => {
    const { w } = phoneWorld({ enabled: false })
    w.mount(<UserProfile />)
    expect(await screen.findByRole('heading', { name: 'Where you’re signed in' })).toBeTruthy()
    await waitFor(() => expect(w.api.calls(ROUTE.config).length).toBeGreaterThan(0))
    expectAbsent(screen.queryByRole('heading', { name: 'Phone number' }))
  })

  test('an older server, whose config says nothing about phone numbers: no section', async () => {
    const w = world({ signedIn: true })
    w.api.on(ROUTE.sessions, () => json(200, { data: [] }))
    w.mount(<UserProfile />)
    expect(await screen.findByRole('heading', { name: 'Where you’re signed in' })).toBeTruthy()
    await waitFor(() => expect(w.api.calls(ROUTE.config).length).toBeGreaterThan(0))
    expectAbsent(screen.queryByRole('heading', { name: 'Phone number' }))
  })

  test('adding a number: the number, the texted code, then the number on the account', async () => {
    const { w, state } = phoneWorld()
    const { container } = w.mount(<UserProfile />)
    const phone = await section()
    expect(within(phone).getByRole('heading', { level: 2, name: 'Phone number' })).toBeTruthy()
    expect(await within(phone).findByText('No phone number.')).toBeTruthy()

    await w.user.click(within(phone).getByRole('button', { name: 'Add a phone number' }))
    const number = within(phone).getByLabelText('Phone number') as HTMLInputElement
    await expectFocus(number)
    expect(number.type).toBe('tel')
    expect(number.autocomplete).toBe('tel')
    expect(number.getAttribute('aria-describedby')).toBeTruthy()
    expect(within(phone).getByText(/Include the country code/)).toBeTruthy()

    await w.user.type(number, '+1 (415) 555-0142')
    await w.user.click(within(phone).getByRole('button', { name: 'Send code' }))
    // The number goes as it was typed: the server decides what a phone number is.
    expect(w.api.calls(ROUTE.phone)[0]?.body).toEqual({ phoneNumber: '+1 (415) 555-0142' })

    const code = (await within(phone).findByLabelText('Verification code')) as HTMLInputElement
    await expectFocus(code)
    expect(code.autocomplete).toBe('one-time-code')
    expect(code.inputMode).toBe('numeric')
    expect(
      within(phone).getByText('We sent a 6-digit code by text message to the number ending in 42.')
    ).toBeTruthy()

    await w.user.type(code, state.code)
    await w.user.click(within(phone).getByRole('button', { name: 'Verify' }))
    expect(await within(phone).findByText('Your phone number was added.')).toBeTruthy()
    expect(w.api.calls(ROUTE.phoneVerify)[0]?.body).toEqual({ code: state.code })
    expect(within(phone).getByText(NUMBER)).toBeTruthy()
    expect(within(phone).getByText('Verified')).toBeTruthy()
    // The form is gone and reading resumes at the section's title.
    await expectFocus(within(phone).getByRole('heading', { name: 'Phone number' }))
    expectAbsent(within(phone).queryByLabelText('Verification code'))
    // The code was state only while its field was shown.
    expect(container.innerHTML).not.toContain(state.code)
    // And the client's state has the number, without another request for the user.
    expect(w.client.state).toMatchObject({ user: { phoneNumber: NUMBER } })
  })

  test('nothing typed: the fields say so and no request is made', async () => {
    const { w } = phoneWorld()
    w.mount(<UserProfile />)
    const phone = await section()
    await w.user.click(await within(phone).findByRole('button', { name: 'Add a phone number' }))
    await w.user.click(within(phone).getByRole('button', { name: 'Send code' }))
    const number = within(phone).getByLabelText('Phone number')
    await waitFor(() => expect(number.getAttribute('aria-invalid')).toBe('true'))
    expect(within(phone).getByRole('alert').textContent).toBe('This field is required.')
    await expectFocus(number)
    expect(w.api.calls(ROUTE.phone)).toHaveLength(0)

    const code = await sendCode(w, phone)
    await w.user.type(code, '123')
    await w.user.click(within(phone).getByRole('button', { name: 'Verify' }))
    await waitFor(() => expect(code.getAttribute('aria-invalid')).toBe('true'))
    expect(within(phone).getByRole('alert').textContent).toBe('Enter the 6-digit code.')
    expect(w.api.calls(ROUTE.phoneVerify)).toHaveLength(0)
  })

  test.each([
    ['phone.invalid', 422, 'Enter a phone number with its country code, such as +14155550100.'],
    ['sms.country_not_allowed', 422, 'Text messages cannot be sent to that country.'],
  ])('%s is said at the number field, which keeps what was typed', async (code, status, text) => {
    const { w } = phoneWorld()
    w.mount(<UserProfile />)
    const phone = await section()
    w.api.on(ROUTE.phone, () => failure(status, code))
    await w.user.click(await within(phone).findByRole('button', { name: 'Add a phone number' }))
    const number = within(phone).getByLabelText('Phone number') as HTMLInputElement
    await w.user.type(number, '+49 151 1234')
    await w.user.click(within(phone).getByRole('button', { name: 'Send code' }))
    await waitFor(() => expect(number.getAttribute('aria-invalid')).toBe('true'))
    expect(within(phone).getByRole('alert').textContent).toBe(text)
    await expectFocus(number)
    expect(number.value).toBe('+49 151 1234')
    expectAbsent(within(phone).queryByLabelText('Verification code'))
  })

  test.each([
    ['sms.unavailable', 503, 'The text message could not be sent. Try again later.'],
    ['sms.disabled', 403, 'Text messages are not available.'],
  ])('%s is said above the form', async (code, status, text) => {
    const { w } = phoneWorld()
    w.mount(<UserProfile />)
    const phone = await section()
    w.api.on(ROUTE.phone, () => failure(status, code))
    await w.user.click(await within(phone).findByRole('button', { name: 'Add a phone number' }))
    const number = within(phone).getByLabelText('Phone number')
    await w.user.type(number, NUMBER)
    await w.user.click(within(phone).getByRole('button', { name: 'Send code' }))
    expect((await within(phone).findByRole('alert')).textContent).toBe(text)
    expect(number.getAttribute('aria-invalid')).toBeNull()
  })

  test('asked too often: the wait is counted down and sending is held until it is over', async () => {
    const { w } = phoneWorld()
    w.mount(<UserProfile />)
    const phone = await section()
    w.api.on(ROUTE.phone, () => failure(429, 'rate_limited', {}, { 'retry-after': '42' }))
    await w.user.click(await within(phone).findByRole('button', { name: 'Add a phone number' }))
    await w.user.type(within(phone).getByLabelText('Phone number'), NUMBER)
    const send = within(phone).getByRole('button', { name: 'Send code' })
    await w.user.click(send)
    expect((await within(phone).findByRole('alert')).textContent).toMatch(/Try again in 4\ds\./)
    expect(send.getAttribute('aria-disabled')).toBe('true')
    await w.user.click(send)
    expect(w.api.calls(ROUTE.phone)).toHaveLength(1)
  })

  test('a wrong code is said at the code field, which is emptied; the right one then works', async () => {
    const { w, state } = phoneWorld()
    w.mount(<UserProfile />)
    const phone = await section()
    const code = (await askFor(w, phone)) as HTMLInputElement
    await w.user.type(code, '000000')
    await w.user.click(within(phone).getByRole('button', { name: 'Verify' }))
    await waitFor(() => expect(code.getAttribute('aria-invalid')).toBe('true'))
    expect(within(phone).getByRole('alert').textContent).toBe('That code is incorrect.')
    expect(code.value).toBe('')
    await expectFocus(code)
    expectAbsent(within(phone).queryByText(NUMBER))

    await w.user.type(code, state.code)
    await w.user.click(within(phone).getByRole('button', { name: 'Verify' }))
    expect(await within(phone).findByText(NUMBER)).toBeTruthy()
  })

  test('“Use a different number” goes back to the number, kept; “Cancel” leaves everything as it was', async () => {
    const { w } = phoneWorld()
    const { container } = w.mount(<UserProfile />)
    const phone = await section()
    await askFor(w, phone, NUMBER)
    await w.user.click(within(phone).getByRole('button', { name: 'Use a different number' }))
    const number = within(phone).getByLabelText('Phone number') as HTMLInputElement
    await expectFocus(number)
    expect(number.value).toBe(NUMBER)
    expectAbsent(within(phone).queryByLabelText('Verification code'))

    await w.user.click(within(phone).getByRole('button', { name: 'Cancel' }))
    expect(await within(phone).findByText('No phone number.')).toBeTruthy()
    await expectFocus(within(phone).getByRole('button', { name: 'Add a phone number' }))
    // A number that was only typed is not kept anywhere on the page.
    expect(container.innerHTML).not.toContain(NUMBER)
    await w.user.click(within(phone).getByRole('button', { name: 'Add a phone number' }))
    expect((within(phone).getByLabelText('Phone number') as HTMLInputElement).value).toBe('')
  })

  test('a user with a number sees it, can change it, and removes it', async () => {
    const { w, state } = phoneWorld({ number: NUMBER })
    w.mount(<UserProfile />)
    const phone = await section()
    expect(await within(phone).findByText(NUMBER)).toBeTruthy()
    expect(within(phone).getByText('Verified')).toBeTruthy()
    expectAbsent(within(phone).queryByText('No phone number.'))

    // Changing asks for the new number; the old one stays the account's until the code.
    await w.user.click(within(phone).getByRole('button', { name: 'Change phone number' }))
    await expectFocus(within(phone).getByLabelText('Phone number'))
    await w.user.click(within(phone).getByRole('button', { name: 'Cancel' }))
    expect(await within(phone).findByText(NUMBER)).toBeTruthy()

    await w.user.click(within(phone).getByRole('button', { name: 'Remove phone number' }))
    expect(await within(phone).findByText('Your phone number was removed.')).toBeTruthy()
    expect(w.api.calls(ROUTE.phoneRemove)).toHaveLength(1)
    expect(state.number).toBeNull()
    expectAbsent(within(phone).queryByText(NUMBER))
    expect(within(phone).getByText('No phone number.')).toBeTruthy()
    await expectFocus(within(phone).getByRole('heading', { name: 'Phone number' }))
    expect(w.client.state).toMatchObject({ user: { phoneNumber: null } })
  })

  test('with text messages off a number can still be seen and removed, not changed', async () => {
    const { w } = phoneWorld({ number: NUMBER, enabled: false })
    w.mount(<UserProfile />)
    const phone = await section()
    expect(await within(phone).findByText(NUMBER)).toBeTruthy()
    expectAbsent(within(phone).queryByRole('button', { name: 'Change phone number' }))
    await w.user.click(within(phone).getByRole('button', { name: 'Remove phone number' }))
    // The section stays for as long as it has this to say, though it offers nothing now.
    expect(await within(phone).findByText('Your phone number was removed.')).toBeTruthy()
    expectAbsent(within(phone).queryByRole('button', { name: 'Add a phone number' }))
  })

  test('a failed removal is reported and the number stays', async () => {
    const { w } = phoneWorld({ number: NUMBER })
    w.mount(<UserProfile />)
    const phone = await section()
    w.api.on(ROUTE.phoneRemove, () => failure(503, 'service.unavailable'))
    await w.user.click(await within(phone).findByRole('button', { name: 'Remove phone number' }))
    expect(await within(phone).findByRole('alert')).toBeTruthy()
    expect(within(phone).getByText(NUMBER)).toBeTruthy()
  })

  test('a step-up the server asks for is made, and the code is then sent', async () => {
    const { w } = phoneWorld()
    w.mount(<UserProfile />)
    const phone = await section()
    let stepped = false
    w.api.on(ROUTE.phone, () =>
      stepped
        ? json(200, { destination: '***42', expiresAt: '2030-01-01T00:10:00.000Z' })
        : failure(403, 'auth.step_up_required', { params: { methods: 'password' } })
    )
    w.api.on(STEP_UP, () => {
      stepped = true
      return json(200, sessionTokens('stepped_up'))
    })
    await w.user.click(await within(phone).findByRole('button', { name: 'Add a phone number' }))
    await w.user.type(within(phone).getByLabelText('Phone number'), NUMBER)
    await w.user.click(within(phone).getByRole('button', { name: 'Send code' }))
    const dialog = await screen.findByRole('dialog', { name: 'Confirm it is you' })
    await w.user.type(within(dialog).getByLabelText('Password'), 'sturdy-Otter-plays-42-chess')
    await w.user.click(within(dialog).getByRole('button', { name: 'Continue' }))
    expect(await within(phone).findByLabelText('Verification code')).toBeTruthy()
    expect(w.api.calls(ROUTE.phone)).toHaveLength(2)
  })

  test('a step-up the user cancels changes nothing and shows no error', async () => {
    const { w } = phoneWorld({ number: NUMBER })
    w.mount(<UserProfile />)
    const phone = await section()
    w.api.on(ROUTE.phoneRemove, () =>
      failure(403, 'auth.step_up_required', { params: { methods: 'password' } })
    )
    await w.user.click(await within(phone).findByRole('button', { name: 'Remove phone number' }))
    const dialog = await screen.findByRole('dialog', { name: 'Confirm it is you' })
    await w.user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expectAbsent(within(phone).queryByRole('alert'))
    expect(within(phone).getByText(NUMBER)).toBeTruthy()
    expect(w.api.calls(ROUTE.phoneRemove)).toHaveLength(1)
  })

  test('an answer that arrives after the user signed out sets nothing', async () => {
    const { w, state } = phoneWorld()
    w.mount(<UserProfile />)
    const phone = await section()
    const code = await askFor(w, phone)
    let release: (response: Response) => void = () => undefined
    w.api.on(ROUTE.phoneVerify, () => new Promise<Response>((resolve) => (release = resolve)))
    await w.user.type(code, state.code)
    await w.user.click(within(phone).getByRole('button', { name: 'Verify' }))
    await act(async () => {
      await w.client.session.signOut()
    })
    await waitFor(() => expect(w.client.state.status).toBe('signed-out'))
    await act(async () => {
      release(json(200, { ...TEST_USER, phoneNumber: NUMBER, phoneNumberVerifiedAt: VERIFIED_AT }))
    })
    await waitFor(() => expectAbsent(screen.queryByRole('heading', { name: 'Phone number' })))
    expect(w.client.state.status).toBe('signed-out')
  })
})

/** As `askFor`, from a form that is already open. */
async function sendCode(w: World, phone: HTMLElement) {
  await w.user.type(within(phone).getByLabelText('Phone number'), NUMBER)
  await w.user.click(within(phone).getByRole('button', { name: 'Send code' }))
  return within(phone).findByLabelText('Verification code')
}
