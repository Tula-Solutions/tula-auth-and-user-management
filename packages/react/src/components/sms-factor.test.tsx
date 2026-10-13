import { afterEach, describe, expect, jest, mock, test } from 'bun:test'
import { screen, waitFor, within } from '@testing-library/react'
import {
  attempt,
  completed,
  expectAbsent,
  expectFocus,
  failure,
  json,
  NEW_PASSWORD_STEP,
  openDialogs,
  ROUTE,
  sessionTokens,
  started,
  TEST_USER,
  type World,
  world,
} from '../testing/harness'
import { SignIn } from './sign-in'
import { UserProfile } from './user-profile'

// A texted code as the second step (ADR 0025): the sign-in and reset screen, the profile's
// enrolment and removal, and the step-up dialog.

const EMAIL = 'maya@northline.app'
const PASSWORD = 'sturdy-Otter-plays-42-chess'
const SMS = {
  factors: 'GET /v1/client/me/factors',
  start: 'POST /v1/client/me/factors/sms',
  confirm: 'POST /v1/client/me/factors/sms/confirm',
  remove: 'DELETE /v1/client/me/factors/sms',
  totp: 'POST /v1/client/me/factors/totp',
  stepUp: 'POST /v1/client/sessions/step-up',
  stepUpText: 'POST /v1/client/sessions/step-up/sms-code',
  stepUpEmail: 'POST /v1/client/sessions/step-up/email-code',
  signInPrepare: 'POST /v1/client/sign-ins/attempt_1/second-factor/prepare',
  signInSecond: 'POST /v1/client/sign-ins/attempt_1/second-factor',
  resetPrepare: 'POST /v1/client/password-resets/attempt_1/second-factor/prepare',
  resetSecond: 'POST /v1/client/password-resets/attempt_1/second-factor',
} as const
const WAITING = { status: 'needs_second_factor', options: ['sms_code'] }
const PREPARED = { ...WAITING, prepared: { method: 'sms_code', destination: '***42' } }
const RECEIPT = { method: 'sms_code', destination: '***42', expiresAt: '2026-10-03T10:10:00.000Z' }
const SENT = 'We sent a 6-digit code by text message to the number ending in 42.'
/** `@tula/core`'s message for `auth.method_disabled`. */
const METHOD_OFF = 'This sign-in method is not available.'
const stepUpRequired = (methods: string) =>
  failure(403, 'auth.step_up_required', { params: { methods } })

afterEach(() => {
  jest.useRealTimers()
  mock.restore()
})

/** Sign in up to a second step that offers a texted code and nothing else. */
async function atSecondStep(w: World) {
  w.api.on(ROUTE.signIn, () => started('sign_in', { status: 'needs_password' }))
  w.api.on(ROUTE.signInPassword, () => attempt('sign_in', WAITING))
  await w.user.type(await screen.findByLabelText('Email address'), EMAIL)
  await w.user.click(screen.getByRole('button', { name: 'Continue' }))
  await w.user.type(await screen.findByLabelText('Password'), PASSWORD)
  await w.user.click(screen.getByRole('button', { name: 'Sign in' }))
  return screen.findByRole('heading', { name: 'Two-step verification' })
}

describe('<SignIn> at needs_second_factor with a texted code', () => {
  test('nothing is texted on arrival; the button asks, then the code completes the sign-in', async () => {
    const w = world()
    const onComplete = mock()
    w.mount(<SignIn onComplete={onComplete} />)
    await expectFocus(await atSecondStep(w))
    // A message costs money: the screen asks with a button and claims nothing was sent.
    expect(
      screen.getByText('We will text a 6-digit code to the phone number on your account.')
    ).toBeTruthy()
    expectAbsent(screen.queryByLabelText(/Verification code/))
    expectAbsent(screen.queryByLabelText('Authentication code'))
    expect(w.api.calls(SMS.signInPrepare)).toHaveLength(0)

    w.api.on(SMS.signInPrepare, () => attempt('sign_in', PREPARED))
    await w.user.click(screen.getByRole('button', { name: 'Text me a code' }))
    expect(await screen.findByText(SENT)).toBeTruthy()
    expect(w.api.calls(SMS.signInPrepare)).toHaveLength(1)
    expect(w.api.calls(SMS.signInPrepare)[0]?.body).toEqual({ method: 'sms_code' })
    const field = screen.getByLabelText(/Verification code/) as HTMLInputElement
    // The field arrived after the screen: the focus goes to it.
    await expectFocus(field)

    // Incomplete: refused here, nothing sent.
    await w.user.type(field, '123')
    await w.user.click(screen.getByRole('button', { name: 'Verify' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Enter the 6-digit code.')
    expect(w.api.calls(SMS.signInSecond)).toHaveLength(0)

    // Wrong: said at the field, which is emptied and takes the focus.
    w.api.on(SMS.signInSecond, () => failure(422, 'mfa.invalid_code'))
    await w.user.clear(field)
    await w.user.type(field, '000000')
    await w.user.click(screen.getByRole('button', { name: 'Verify' }))
    await waitFor(() => expect(field.getAttribute('aria-invalid')).toBe('true'))
    expect(field.value).toBe('')
    await expectFocus(field)
    expect(w.api.calls(SMS.signInSecond)[0]?.body).toEqual({ method: 'sms_code', code: '000000' })

    w.api.on(SMS.signInSecond, () => completed('sign_in'))
    await w.user.type(field, '654321')
    await w.user.click(screen.getByRole('button', { name: 'Verify' }))
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    expect(w.api.calls(SMS.signInSecond).at(-1)?.body).toEqual({
      method: 'sms_code',
      code: '654321',
    })
    // One message for the whole sign-in.
    expect(w.api.calls(SMS.signInPrepare)).toHaveLength(1)
  })

  test('a send that is refused claims no code: the reason is said, a wait is counted down', async () => {
    const w = world()
    w.mount(<SignIn />)
    await atSecondStep(w)
    w.api.on(SMS.signInPrepare, () => failure(503, 'sms.unavailable'))
    await w.user.click(screen.getByRole('button', { name: 'Text me a code' }))
    expect((await screen.findByRole('alert')).textContent).not.toBe('')
    expectAbsent(screen.queryByLabelText(/Verification code/))
    expectAbsent(screen.queryByText(SENT))

    w.api.on(SMS.signInPrepare, () => failure(429, 'rate_limited', {}, { 'retry-after': '42' }))
    await w.user.click(screen.getByRole('button', { name: 'Text me a code' }))
    expect(await screen.findByText(/Try again in /)).toBeTruthy()
    const sends = w.api.calls(SMS.signInPrepare).length
    // While the wait runs the button sends nothing.
    await w.user.click(screen.getByRole('button', { name: 'Text me a code' }))
    expect(w.api.calls(SMS.signInPrepare)).toHaveLength(sends)
    expectAbsent(screen.queryByLabelText(/Verification code/))
  })

  test('the app no longer offers it: the refusal is said and nothing is claimed', async () => {
    const w = world()
    w.mount(<SignIn />)
    await atSecondStep(w)
    w.api.on(SMS.signInPrepare, () => failure(403, 'auth.method_disabled'))
    await w.user.click(screen.getByRole('button', { name: 'Text me a code' }))
    expect((await screen.findByRole('alert')).textContent).toBe(METHOD_OFF)
    expectAbsent(screen.queryByLabelText(/Verification code/))
    // Review round 1, F3: asking again can only be refused again, so the button is gone
    // rather than left as a loop. One request was made and no other can be.
    expectAbsent(screen.queryByRole('button', { name: 'Text me a code' }))
    expect(w.api.calls(SMS.signInPrepare)).toHaveLength(1)
    // The way out is still there.
    await w.user.click(screen.getByRole('button', { name: 'Back to sign in' }))
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy()
  })

  test('switched off after a code was texted: the field and "resend" go, the refusal stays', async () => {
    const w = world()
    w.mount(<SignIn />)
    await atSecondStep(w)
    w.api.on(SMS.signInPrepare, () => attempt('sign_in', PREPARED))
    await w.user.click(screen.getByRole('button', { name: 'Text me a code' }))
    await screen.findByText(SENT)
    w.api.on(SMS.signInSecond, () => failure(403, 'auth.method_disabled'))
    await w.user.type(screen.getByLabelText(/Verification code/), '123456')
    await w.user.click(screen.getByRole('button', { name: 'Verify' }))
    expect((await screen.findByRole('alert')).textContent).toBe(METHOD_OFF)
    expectAbsent(screen.queryByLabelText(/Verification code/))
    expectAbsent(screen.queryByRole('button', { name: 'Verify' }))
    expectAbsent(screen.queryByRole('button', { name: /^Resend/ }))
    expect(screen.getByRole('button', { name: 'Back to sign in' })).toBeTruthy()
  })

  test('resending: a new code is announced, and a resend asked too soon counts down on the button', async () => {
    const w = world()
    w.mount(<SignIn />)
    await atSecondStep(w)
    w.api.on(SMS.signInPrepare, () => attempt('sign_in', PREPARED))
    await w.user.click(screen.getByRole('button', { name: 'Text me a code' }))
    await screen.findByText(SENT)
    await w.user.click(screen.getByRole('button', { name: 'Resend code' }))
    expect(await screen.findByText('A new code is on its way.')).toBeTruthy()
    expect(w.api.calls(SMS.signInPrepare)).toHaveLength(2)

    w.api.on(SMS.signInPrepare, () => failure(429, 'rate_limited', {}, { 'retry-after': '30' }))
    await w.user.click(screen.getByRole('button', { name: 'Resend code' }))
    expect(await screen.findByRole('button', { name: /Resend code in / })).toBeTruthy()
    // Too soon is not a failure to announce, and the field for the code already sent stays.
    expectAbsent(screen.queryByRole('alert'))
    expect(screen.getByLabelText(/Verification code/)).toBeTruthy()
  })

  test('an attempt that already has a code opens on the field, and sends nothing', async () => {
    const w = world()
    w.mount(<SignIn />)
    w.api.on(ROUTE.signIn, () => started('sign_in', { status: 'needs_password' }))
    w.api.on(ROUTE.signInPassword, () => attempt('sign_in', PREPARED))
    await w.user.type(await screen.findByLabelText('Email address'), EMAIL)
    await w.user.click(screen.getByRole('button', { name: 'Continue' }))
    await w.user.type(await screen.findByLabelText('Password'), PASSWORD)
    await w.user.click(screen.getByRole('button', { name: 'Sign in' }))
    const title = await screen.findByRole('heading', { name: 'Two-step verification' })
    expect(screen.getByText(SENT)).toBeTruthy()
    // The screen's own focus rule holds: the title, not the field.
    await expectFocus(title)
    expect(w.api.calls(SMS.signInPrepare)).toHaveLength(0)
  })

  test('beside an authenticator app it is never drawn: the stronger factor is the screen', async () => {
    const w = world()
    w.mount(<SignIn />)
    w.api.on(ROUTE.signIn, () => started('sign_in', { status: 'needs_password' }))
    w.api.on(ROUTE.signInPassword, () =>
      attempt('sign_in', { status: 'needs_second_factor', options: ['totp', 'sms_code'] })
    )
    await w.user.type(await screen.findByLabelText('Email address'), EMAIL)
    await w.user.click(screen.getByRole('button', { name: 'Continue' }))
    await w.user.type(await screen.findByLabelText('Password'), PASSWORD)
    await w.user.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByLabelText('Authentication code')
    expectAbsent(screen.queryByRole('button', { name: 'Text me a code' }))
    expect(w.api.calls(SMS.signInPrepare)).toHaveLength(0)
  })

  test('a password reset that stops at a texted code uses the reset routes', async () => {
    const w = world()
    const onComplete = mock()
    w.mount(<SignIn onComplete={onComplete} />)
    w.api.on(ROUTE.signIn, () => started('sign_in', { status: 'needs_password' }))
    await w.user.type(await screen.findByLabelText('Email address'), EMAIL)
    await w.user.click(screen.getByRole('button', { name: 'Continue' }))
    await w.user.click(await screen.findByRole('button', { name: 'Forgot password?' }))
    w.api.on(ROUTE.reset, () => started('password_reset', NEW_PASSWORD_STEP))
    await w.user.click(await screen.findByRole('button', { name: 'Send code' }))
    w.api.on(ROUTE.resetSubmit, () => attempt('password_reset', WAITING))
    await w.user.type(await screen.findByLabelText('Verification code'), '123456')
    await w.user.type(screen.getByLabelText('New password'), PASSWORD)
    await w.user.click(screen.getByRole('button', { name: 'Reset password' }))

    w.api.on(SMS.resetPrepare, () => attempt('password_reset', PREPARED))
    await w.user.click(await screen.findByRole('button', { name: 'Text me a code' }))
    await screen.findByText(SENT)
    w.api.on(SMS.resetSecond, () => completed('password_reset'))
    await w.user.type(screen.getByLabelText(/Verification code/), '654321')
    await w.user.click(screen.getByRole('button', { name: 'Verify' }))
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    expect(w.api.calls(SMS.resetPrepare)).toHaveLength(1)
    expect(w.api.calls(SMS.resetSecond)[0]?.body).toEqual({ method: 'sms_code', code: '654321' })
    expect(w.api.calls(SMS.signInPrepare)).toHaveLength(0)
  })
})

interface SmsState {
  enabled: boolean
  inUse: boolean
  available: boolean
}

/** A signed-in profile whose factors answer carries `sms`, or leaves it out (an older server). */
function profileWorld(
  sms: SmsState | null,
  options: { policy?: 'off' | 'optional' | 'required'; totp?: boolean } = {}
) {
  const w = world({ signedIn: true, mfaPolicy: options.policy ?? 'optional' })
  const state = { sms, totp: options.totp === true }
  w.api.on(ROUTE.sessions, () => json(200, { data: [] }))
  const factors = () => ({
    totp: {
      enabled: state.totp,
      confirmedAt: state.totp ? '2026-10-03T10:00:00.000Z' : null,
    },
    backupCodes: { remaining: state.totp ? 10 : 0 },
    ...(state.sms && {
      sms: { ...state.sms, enabledAt: state.sms.enabled ? '2026-10-03T10:00:00.000Z' : null },
    }),
  })
  w.api.on(SMS.factors, () => json(200, factors()))
  return { w, state, factors }
}

const section = async () =>
  (await screen.findByRole('heading', { name: 'Two-step verification' })).closest(
    'section'
  ) as HTMLElement

describe('<UserProfile> a texted code as the second step', () => {
  test('turning it on: the message is sent when asked, the code confirms it, and the section says so', async () => {
    const { w, state, factors } = profileWorld({ enabled: false, inUse: false, available: true })
    const onChanged = mock()
    w.api.on(ROUTE.sessions, () => {
      onChanged()
      return json(200, { data: [] })
    })
    w.mount(<UserProfile />)
    const mfa = await section()
    expect(
      await within(mfa).findByText('You can also get a code by text message as your second step.')
    ).toBeTruthy()
    expect(w.api.calls(SMS.start)).toHaveLength(0)

    // The server asks for a step-up first; the action is retried once it was proven.
    let stepped = false
    w.api.on(SMS.start, () => (stepped ? json(200, RECEIPT) : stepUpRequired('password')))
    w.api.on(SMS.stepUp, () => {
      stepped = true
      return json(200, sessionTokens('stepped_up'))
    })
    await w.user.click(within(mfa).getByRole('button', { name: 'Use text messages' }))
    const dialog = await screen.findByRole('dialog', { name: 'Confirm it is you' })
    await w.user.type(within(dialog).getByLabelText('Password'), PASSWORD)
    await w.user.click(within(dialog).getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(await within(mfa).findByText(SENT)).toBeTruthy()
    expect(w.api.calls(SMS.start)).toHaveLength(2)

    const field = within(mfa).getByLabelText(/Verification code/) as HTMLInputElement
    w.api.on(SMS.confirm, () => failure(422, 'mfa.invalid_code'))
    await w.user.type(field, '000000')
    await w.user.click(within(mfa).getByRole('button', { name: 'Turn on' }))
    await waitFor(() => expect(field.getAttribute('aria-invalid')).toBe('true'))
    expect(field.value).toBe('')

    const sessionsBefore = onChanged.mock.calls.length
    w.api.on(SMS.confirm, () => {
      state.sms = { enabled: true, inUse: true, available: false }
      return json(200, factors())
    })
    await w.user.type(field, '654321')
    await w.user.click(within(mfa).getByRole('button', { name: 'Turn on' }))
    expect(
      await within(mfa).findByText(/^A code by text message is your second step since /)
    ).toBeTruthy()
    expect(within(mfa).getByText('A code by text message is now your second step.')).toBeTruthy()
    expect(w.api.calls(SMS.confirm).at(-1)?.body).toEqual({ code: '654321' })
    // Turning it on ended the user's other sessions: the list is read again.
    await waitFor(() => expect(onChanged.mock.calls.length).toBeGreaterThan(sessionsBefore))
    // The offer is gone, an authenticator app is suggested, and the code is nowhere.
    expectAbsent(within(mfa).queryByRole('button', { name: 'Use text messages' }))
    expect(
      within(mfa).getByText(
        'An authenticator app is safer than a text message. You can add one here.'
      )
    ).toBeTruthy()
    expect(within(mfa).getByRole('button', { name: 'Set up authenticator app' })).toBeTruthy()
    expect(document.body.innerHTML).not.toContain('654321')
  })

  test('a number added on the same page: the offer appears without a reload', async () => {
    const w = world({ signedIn: true, mfaPolicy: 'optional', phone: true })
    const NUMBER = '+14155550142'
    let number: string | null = null
    w.api.on(ROUTE.sessions, () => json(200, { data: [] }))
    // As the server answers: a texted code can be had only with a number on the account.
    w.api.on(SMS.factors, () =>
      json(200, {
        totp: { enabled: false, confirmedAt: null },
        backupCodes: { remaining: 0 },
        sms: { enabled: false, enabledAt: null, inUse: false, available: number !== null },
      })
    )
    w.api.on(ROUTE.phone, () =>
      json(200, { destination: '***42', expiresAt: '2030-01-01T00:10:00.000Z' })
    )
    w.api.on(ROUTE.phoneVerify, () => {
      number = NUMBER
      return json(200, {
        ...TEST_USER,
        phoneNumber: NUMBER,
        phoneNumberVerifiedAt: '2030-01-01T00:05:00.000Z',
      })
    })
    w.mount(<UserProfile />)
    const mfa = await section()
    await within(mfa).findByRole('button', { name: 'Turn on' })
    expectAbsent(within(mfa).queryByRole('button', { name: 'Use text messages' }))
    const read = w.api.calls(SMS.factors).length

    const phone = (await screen.findByRole('heading', { name: 'Phone number' })).closest(
      'section'
    ) as HTMLElement
    await w.user.click(await within(phone).findByRole('button', { name: 'Add a phone number' }))
    await w.user.type(within(phone).getByLabelText('Phone number'), NUMBER)
    await w.user.click(within(phone).getByRole('button', { name: 'Send code' }))
    await w.user.type(await within(phone).findByLabelText('Verification code'), '482913')
    await w.user.click(within(phone).getByRole('button', { name: 'Verify' }))
    await within(phone).findByText('Your phone number was added.')

    expect(await within(mfa).findByRole('button', { name: 'Use text messages' })).toBeTruthy()
    expect(w.api.calls(SMS.factors)).toHaveLength(read + 1)
  })

  test('"Cancel" leaves the form, and a refused send is said in the section with no form', async () => {
    const { w } = profileWorld({ enabled: false, inUse: false, available: true })
    w.mount(<UserProfile />)
    const mfa = await section()
    w.api.on(SMS.start, () => failure(503, 'sms.unavailable'))
    await w.user.click(await within(mfa).findByRole('button', { name: 'Use text messages' }))
    expect((await within(mfa).findByRole('alert')).textContent).not.toBe('')
    expectAbsent(within(mfa).queryByLabelText(/Verification code/))

    w.api.on(SMS.start, () => json(200, RECEIPT))
    await w.user.click(within(mfa).getByRole('button', { name: 'Use text messages' }))
    await within(mfa).findByText(SENT)
    await w.user.click(within(mfa).getByRole('button', { name: 'Cancel' }))
    expect(await within(mfa).findByRole('button', { name: 'Use text messages' })).toBeTruthy()
    expectAbsent(within(mfa).queryByLabelText(/Verification code/))
    expect(w.api.calls(SMS.confirm)).toHaveLength(0)
  })

  test.each<[string, SmsState | null, boolean]>([
    ['an older server that says nothing', null, false],
    ['a user who could not enrol it', { enabled: false, inUse: false, available: false }, false],
    ['a user who could', { enabled: false, inUse: false, available: true }, true],
  ])('it is offered only where the server says so: %s', async (_name, sms, offered) => {
    const { w } = profileWorld(sms)
    w.mount(<UserProfile />)
    const mfa = await section()
    await within(mfa).findByRole('button', { name: 'Turn on' })
    const button = within(mfa).queryByRole('button', { name: 'Use text messages' })
    expect(button !== null).toBe(offered)
  })

  test('beside an authenticator app it is shown as not used, and can be stopped', async () => {
    const { w, state } = profileWorld(
      { enabled: true, inUse: false, available: false },
      { totp: true }
    )
    w.mount(<UserProfile />)
    const mfa = await section()
    // Review round 1, F2: dormant, and said to come back.
    expect(
      await within(mfa).findByText(
        /It is not asked for while you have an authenticator app or a passkey\. If you remove that, the code by text message is your second step again\./
      )
    ).toBeTruthy()
    w.api.on(SMS.remove, () => {
      state.sms = { enabled: false, inUse: false, available: false }
      return new Response(null, { status: 204 })
    })
    await w.user.click(within(mfa).getByRole('button', { name: 'Stop using text messages' }))
    expect(
      await within(mfa).findByText('Text messages are no longer your second step.')
    ).toBeTruthy()
    expect(w.api.calls(SMS.remove)).toHaveLength(1)
    expectAbsent(within(mfa).queryByRole('button', { name: 'Stop using text messages' }))
  })

  test('in use, nothing is said about it being set aside', async () => {
    const { w } = profileWorld({ enabled: true, inUse: true, available: false })
    w.mount(<UserProfile />)
    const mfa = await section()
    await within(mfa).findByText(/^A code by text message is your second step since /)
    expectAbsent(within(mfa).queryByText(/It is not asked for while/))
  })

  test('required by the app and the only second step: it cannot be stopped, and the section says why', async () => {
    const { w } = profileWorld(
      { enabled: true, inUse: true, available: false },
      { policy: 'required' }
    )
    w.mount(<UserProfile />)
    const mfa = await section()
    await within(mfa).findByText(/^A code by text message is your second step since /)
    expectAbsent(within(mfa).queryByRole('button', { name: 'Stop using text messages' }))
    expect(
      within(mfa).getByText('This app requires two-step verification, so it cannot be turned off.')
    ).toBeTruthy()
  })

  test('with the policy off the section still shows a texted code the user has', async () => {
    const { w } = profileWorld({ enabled: true, inUse: true, available: false }, { policy: 'off' })
    w.mount(<UserProfile />)
    const mfa = await section()
    expect(
      await within(mfa).findByRole('button', { name: 'Stop using text messages' })
    ).toBeTruthy()
  })
})

describe('the step-up dialog: a texted code', () => {
  /** A profile whose "Stop using text messages" needs a step-up with `methods` first. */
  function needsStepUp(methods: string) {
    const { w, state } = profileWorld({ enabled: true, inUse: true, available: false })
    const proof = { stepped: false }
    w.api.on(SMS.remove, () => {
      if (!proof.stepped) {
        return stepUpRequired(methods)
      }
      state.sms = { enabled: false, inUse: false, available: true }
      return new Response(null, { status: 204 })
    })
    w.api.on(SMS.stepUpText, () => json(200, RECEIPT))
    return { w, proof }
  }
  const open = async (w: World) => {
    const mfa = await section()
    await w.user.click(await within(mfa).findByRole('button', { name: 'Stop using text messages' }))
    return screen.findByRole('dialog', { name: 'Confirm it is you' })
  }

  test('nothing is texted when the dialog opens; the button asks, and the code proves the step-up', async () => {
    const { w, proof } = needsStepUp('sms_code')
    w.mount(<UserProfile />)
    const dialog = await open(w)
    expect(
      within(dialog).getByText(
        'To continue, we will text a 6-digit code to the phone number on your account.'
      )
    ).toBeTruthy()
    expect(w.api.calls(SMS.stepUpText)).toHaveLength(0)
    // The second step is what is asked for: never the password, never an email.
    expectAbsent(within(dialog).queryByLabelText('Password'))
    expectAbsent(within(dialog).queryByRole('button', { name: 'Email me a code instead' }))

    await w.user.click(within(dialog).getByRole('button', { name: 'Text me a code' }))
    expect(await within(dialog).findByText(SENT)).toBeTruthy()
    const field = within(dialog).getByLabelText(/Verification code/) as HTMLInputElement
    await expectFocus(field)
    expect(w.api.calls(SMS.stepUpText)).toHaveLength(1)

    w.api.on(SMS.stepUp, () => failure(422, 'mfa.invalid_code'))
    await w.user.type(field, '000000')
    await w.user.click(within(dialog).getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(field.getAttribute('aria-invalid')).toBe('true'))
    expect(field.value).toBe('')

    w.api.on(SMS.stepUp, () => {
      proof.stepped = true
      return json(200, sessionTokens('stepped_up'))
    })
    await w.user.type(field, '654321')
    await w.user.click(within(dialog).getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(w.api.calls(SMS.stepUp).at(-1)?.body).toEqual({ method: 'sms_code', code: '654321' })
    expect(w.api.calls(SMS.remove)).toHaveLength(2)
    expect(w.api.calls(SMS.stepUpText)).toHaveLength(1)
    expect(w.api.calls(SMS.stepUpEmail)).toHaveLength(0)
    expect(document.body.innerHTML).not.toContain('654321')
  })

  test('a send the server refuses is said in the dialog, which claims no code', async () => {
    const { w } = needsStepUp('sms_code')
    w.api.on(SMS.stepUpText, () => failure(503, 'sms.unavailable'))
    w.mount(<UserProfile />)
    const dialog = await open(w)
    await w.user.click(within(dialog).getByRole('button', { name: 'Text me a code' }))
    expect((await within(dialog).findByRole('alert')).textContent).not.toBe('')
    expectAbsent(within(dialog).queryByLabelText(/Verification code/))
    await w.user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(w.api.calls(SMS.remove)).toHaveLength(1)
  })

  // Review round 1, F3. With `mfa.smsCode` or text messages switched off the server still
  // lists `sms_code` for this user (it never falls open) and refuses every call.
  test.each<[string, number, string, string]>([
    ['texted codes', 403, 'auth.method_disabled', METHOD_OFF],
    ['text messages', 403, 'sms.disabled', 'Text messages are not available.'],
    [
      'the number’s country',
      422,
      'sms.country_not_allowed',
      'Text messages cannot be sent to that country.',
    ],
  ])(
    'the app has switched %s off: the dialog says so and offers no send to repeat',
    async (_name, status, code, message) => {
      const { w } = needsStepUp('sms_code')
      w.api.on(SMS.stepUpText, () => failure(status, code))
      w.mount(<UserProfile />)
      const dialog = await open(w)
      await w.user.click(within(dialog).getByRole('button', { name: 'Text me a code' }))
      expect((await within(dialog).findByRole('alert')).textContent).toBe(message)
      expectAbsent(within(dialog).queryByRole('button', { name: 'Text me a code' }))
      expectAbsent(within(dialog).queryByLabelText(/Verification code/))
      expect(w.api.calls(SMS.stepUpText)).toHaveLength(1)
      // The dialog's own way out is what is left, and it works.
      await w.user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
      await waitFor(() => expect(openDialogs()).toBe(0))
      expect(w.api.calls(SMS.stepUp)).toHaveLength(0)
    }
  )

  test('a message that could not be sent this time keeps the button: it may work a moment later', async () => {
    const { w } = needsStepUp('sms_code')
    w.api.on(SMS.stepUpText, () => failure(503, 'sms.unavailable'))
    w.mount(<UserProfile />)
    const dialog = await open(w)
    await w.user.click(within(dialog).getByRole('button', { name: 'Text me a code' }))
    await within(dialog).findByRole('alert')
    w.api.on(SMS.stepUpText, () => json(200, RECEIPT))
    await w.user.click(within(dialog).getByRole('button', { name: 'Text me a code' }))
    expect(await within(dialog).findByLabelText(/Verification code/)).toBeTruthy()
  })

  test('a user with an authenticator app is asked for it, never for a text', async () => {
    const { w } = needsStepUp('totp,backup_code,sms_code')
    w.mount(<UserProfile />)
    const dialog = await open(w)
    expect(within(dialog).getByLabelText('Authentication code')).toBeTruthy()
    expectAbsent(within(dialog).queryByRole('button', { name: 'Text me a code' }))
    expect(w.api.calls(SMS.stepUpText)).toHaveLength(0)
  })

  test('signing out underneath the dialog closes it, and a late receipt changes nothing', async () => {
    const { w } = needsStepUp('sms_code')
    let release: (value: Response) => void = () => undefined
    w.api.on(SMS.stepUpText, () => new Promise<Response>((resolve) => (release = resolve)))
    w.mount(<UserProfile />)
    const dialog = await open(w)
    await w.user.click(within(dialog).getByRole('button', { name: 'Text me a code' }))
    await w.client.session.signOut()
    await waitFor(() => expect(openDialogs()).toBe(0))
    release(json(200, RECEIPT))
    await Promise.resolve()
    expectAbsent(screen.queryByText(SENT))
  })
})
