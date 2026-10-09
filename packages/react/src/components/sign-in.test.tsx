import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { render, screen, waitFor } from '@testing-library/react'
import { PASSWORD_POLICY_PRESETS } from '@tula/contract'
import { Activity } from 'react'
import { TulaProvider } from '../context'
import {
  attempt,
  CODE_STEP,
  completed,
  EXPIRED_PASSWORD_STEP,
  expectAbsent,
  expectFocus,
  failure,
  NEW_PASSWORD_STEP,
  ROUTE,
  started,
  type World,
  world,
} from '../testing/harness'
import { SignedOut } from './control'
import { SignIn } from './sign-in'

const EMAIL = 'maya@northline.app'
const PASSWORD = 'sturdy-Otter-plays-42-chess'

afterEach(() => {
  mock.restore()
})

/** Type the email and continue to the password screen. */
async function toPassword(
  w: World,
  step: { status: string; strategies?: string[] } = { status: 'needs_password' }
) {
  w.api.on(ROUTE.signIn, () => started('sign_in', step))
  await w.user.type(await screen.findByLabelText('Email address'), EMAIL)
  await w.user.click(screen.getByRole('button', { name: 'Continue' }))
}

describe('<SignIn> draws the step the server answers with', () => {
  test('email, then password, then complete: onComplete gets the ids and the secret travels in a header', async () => {
    const w = world()
    const onComplete = mock()
    w.mount(<SignIn onComplete={onComplete} />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeTruthy()
    // The app's name arrives with the environment's config.
    expect(await screen.findByText('to continue to Northline')).toBeTruthy()

    await toPassword(w)
    const title = await screen.findByRole('heading', { name: 'Enter your password' })
    // The new step's title takes focus, so the change is announced.
    await expectFocus(title)
    expect(screen.getByText(EMAIL)).toBeTruthy()

    w.api.on(ROUTE.signInPassword, () => completed('sign_in'))
    const field = screen.getByLabelText('Password') as HTMLInputElement
    expect(field.autocomplete).toBe('current-password')
    expect(field.type).toBe('password')
    await w.user.type(field, PASSWORD)
    await w.user.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    expect(onComplete).toHaveBeenCalledWith({ userId: 'user_1', sessionId: 'session_1' })
    expect(await screen.findByRole('heading', { name: 'You are signed in.' })).toBeTruthy()
    expect(w.client.state.status).toBe('signed-in')

    expect(w.api.calls(ROUTE.signIn)[0]?.body).toEqual({ identifier: EMAIL })
    const sent = w.api.calls(ROUTE.signInPassword)[0]
    expect(sent?.body).toEqual({ password: PASSWORD })
    expect(sent?.headers.get('x-tula-attempt')).toBe('tula_at_test_secret')
    // Neither the password nor the attempt's secret is anywhere in the page.
    expect(document.body.innerHTML).not.toContain(PASSWORD)
    expect(document.body.innerHTML).not.toContain('tula_at_test_secret')
  })

  test('the first screen does not take focus, and an empty email is refused locally', async () => {
    const w = world()
    w.mount(<SignIn />)
    await screen.findByRole('heading', { name: 'Sign in' })
    await expectFocus(document.body)
    await w.user.click(screen.getByRole('button', { name: 'Continue' }))
    const email = screen.getByLabelText('Email address')
    expect(email.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('alert').textContent).toBe('This field is required.')
    expect(email.getAttribute('aria-describedby')).toContain(screen.getByRole('alert').id)
    await expectFocus(email)
    expect(w.api.calls(ROUTE.signIn)).toHaveLength(0)
    // Typing clears the message.
    await w.user.type(email, 'm')
    expectAbsent(screen.queryByRole('alert'))
  })

  test('a wrong password is shown on the password field, which is emptied and focused', async () => {
    const w = world()
    w.mount(<SignIn />)
    await toPassword(w)
    w.api.on(ROUTE.signInPassword, () => failure(401, 'auth.invalid_credentials'))
    const field = (await screen.findByLabelText('Password')) as HTMLInputElement
    await w.user.type(field, 'wrong-password')
    await w.user.keyboard('{Enter}')
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('The email or password is incorrect.')
    expect(field.getAttribute('aria-invalid')).toBe('true')
    expect(field.getAttribute('aria-describedby')).toContain(alert.id)
    expect(field.value).toBe('')
    await expectFocus(field)
  })

  test('a lockout shows the server’s countdown and refuses to submit until it ends', async () => {
    const w = world()
    w.mount(<SignIn />)
    await toPassword(w)
    w.api.on(ROUTE.signInPassword, () =>
      failure(429, 'rate_limited', { params: { retryAfter: 2 } }, { 'retry-after': '2' })
    )
    await w.user.type(await screen.findByLabelText('Password'), 'wrong-password')
    await w.user.click(screen.getByRole('button', { name: 'Sign in' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Too many requests. Try again shortly.')
    // The countdown is drawn one render after the alert (`useCountdown` starts in an effect).
    await waitFor(() => expect(alert.textContent).toMatch(/Try again in [12]s\./))
    const submit = screen.getByRole('button', { name: 'Sign in' })
    expect(submit.getAttribute('aria-disabled')).toBe('true')

    // Neither a click nor Enter sends anything while locked.
    await w.user.type(screen.getByLabelText('Password'), 'another-guess{Enter}')
    await w.user.click(submit)
    expect(w.api.calls(ROUTE.signInPassword)).toHaveLength(1)

    await waitFor(() => expect(submit.getAttribute('aria-disabled')).toBeNull(), { timeout: 4_000 })
    expect(screen.getByRole('alert').textContent).not.toContain('Try again in')
  })

  test('a pending button keeps its name, is busy, and a second submit sends nothing', async () => {
    const w = world()
    w.mount(<SignIn />)
    let release: (response: Response) => void = () => undefined
    w.api.on(ROUTE.signIn, () => new Promise<Response>((resolve) => (release = resolve)))
    await w.user.type(await screen.findByLabelText('Email address'), EMAIL)
    await w.user.click(screen.getByRole('button', { name: 'Continue' }))
    const button = screen.getByRole('button', { name: 'Continue' })
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(button.getAttribute('aria-disabled')).toBe('true')
    await w.user.click(button)
    await w.user.type(screen.getByLabelText('Email address'), '{Enter}')
    expect(w.api.calls(ROUTE.signIn)).toHaveLength(1)
    release(await started('sign_in', { status: 'needs_password' }))
    expect(await screen.findByRole('heading', { name: 'Enter your password' })).toBeTruthy()
  })

  test('Tab goes from the title to the password before it reaches "Forgot password?"', async () => {
    const w = world()
    w.mount(<SignIn />)
    await toPassword(w)
    const title = await screen.findByRole('heading', { name: 'Enter your password' })
    await expectFocus(title)
    const reached: string[] = []
    for (let presses = 0; presses < 5; presses++) {
      await w.user.tab()
      const element = document.activeElement as HTMLElement
      reached.push(
        element.getAttribute('aria-label') ??
          element.getAttribute('name') ??
          element.textContent ??
          ''
      )
    }
    // The hidden username field (for password managers) is not a stop.
    expect(reached).toEqual(['Change', 'password', 'Show password', 'Forgot password?', 'Sign in'])
  })

  test('"Change" goes back to the email screen with the address kept', async () => {
    const w = world()
    w.mount(<SignIn />)
    await toPassword(w)
    await w.user.click(await screen.findByRole('button', { name: 'Change' }))
    const email = (await screen.findByLabelText('Email address')) as HTMLInputElement
    expect(email.value).toBe(EMAIL)
    expect(email.autocomplete).toBe('username')
  })

  test('a network failure and an unavailable service are shown above the form', async () => {
    const w = world()
    w.mount(<SignIn />)
    w.api.on(ROUTE.signIn, () => Promise.reject(new TypeError('offline')))
    await w.user.type(await screen.findByLabelText('Email address'), EMAIL)
    await w.user.click(screen.getByRole('button', { name: 'Continue' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Could not reach the server. Check your connection and try again.'
    )
    // Not about a field: nothing is marked invalid.
    expect(screen.getByLabelText('Email address').getAttribute('aria-invalid')).toBeNull()

    w.api.on(ROUTE.signIn, () => failure(503, 'service.unavailable'))
    await w.user.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'The service is temporarily unavailable. Try again shortly.'
      )
    )
  })
})

describe('<SignIn> first factors and steps it does not know', () => {
  test('needs_first_factor: the password form when it is offered, unknown strategies skipped', async () => {
    const w = world()
    w.mount(<SignIn />)
    await toPassword(w, {
      status: 'needs_first_factor',
      strategies: ['hologram', 'retina', 'password'],
    })
    expect(await screen.findByLabelText('Password')).toBeTruthy()
  })

  test('needs_first_factor with nothing this version implements says so, and can start again', async () => {
    const w = world()
    w.mount(<SignIn />)
    await toPassword(w, { status: 'needs_first_factor', strategies: ['retina', 'constructor'] })
    const title = await screen.findByRole('heading', { name: 'This step is not supported' })
    await expectFocus(title)
    expect(screen.getByText(/not supported by this version/)).toBeTruthy()
    await w.user.click(screen.getByRole('button', { name: 'Start again' }))
    expect(await screen.findByLabelText('Email address')).toBeTruthy()
  })

  test.each([
    [
      'a second factor this version cannot ask for',
      { status: 'needs_second_factor', options: ['retina'] },
    ],
    ['a second-factor step with no options', { status: 'needs_second_factor' }],
    ['an enrolment of a method this version cannot enrol', { status: 'needs_factor_enrolment' }],
    ['a status from a newer server', { status: 'needs_retina_scan' }],
    // A sign-in draws a new-password screen for the one reason it knows (`expired`), never
    // for the step as such: with no reason it is a reset's step, and a reason from a newer
    // server is not this version's to guess at.
    ['needs_new_password in a sign-in, with no reason', NEW_PASSWORD_STEP],
    [
      'needs_new_password in a sign-in, with no reason and nothing to send with it',
      { status: 'needs_new_password', destination: 'm***@example.com', strategies: [] },
    ],
    [
      'needs_new_password in a sign-in, for a reason from a newer server',
      { ...EXPIRED_PASSWORD_STEP, reason: 'future' },
    ],
  ] as [string, { status: string }][])(
    '%s renders the unsupported state, never a blank card',
    async (_name, step) => {
      const w = world()
      w.mount(<SignIn />)
      await toPassword(w)
      w.api.on(ROUTE.signInPassword, () => attempt('sign_in', step))
      await w.user.type(await screen.findByLabelText('Password'), PASSWORD)
      await w.user.click(screen.getByRole('button', { name: 'Sign in' }))
      expect(
        await screen.findByRole('heading', { name: 'This step is not supported' })
      ).toBeTruthy()
      expectAbsent(screen.queryByRole('heading', { name: 'Your password has expired' }))
      expectAbsent(screen.queryByLabelText('New password'))
      expect(w.client.state.status).toBe('signed-out')
    }
  )
})

describe('<SignIn> an expired password', () => {
  const NEW_PASSWORD = 'quiet-Heron-reads-77-maps'
  const reused = 'You have used this password recently. Choose a different one.'

  /** Sign in with a right password that has expired, as far as the new-password screen. */
  async function toExpired(w: World) {
    w.mount(<SignIn />)
    await toPassword(w)
    w.api.on(ROUTE.signInPassword, () => attempt('sign_in', EXPIRED_PASSWORD_STEP))
    await w.user.type(await screen.findByLabelText('Password'), PASSWORD)
    await w.user.click(screen.getByRole('button', { name: 'Sign in' }))
    return (await screen.findByLabelText('New password')) as HTMLInputElement
  }
  const line = (text: string) =>
    screen.getByText(text, { exact: false }).closest('li') as HTMLElement

  test('says the password has expired, asks for a new one and nothing else, and signs in', async () => {
    const w = world()
    const field = await toExpired(w)
    const title = screen.getByRole('heading', { name: 'Your password has expired' })
    // The title takes the focus, so the reason is what a screen reader says first.
    await expectFocus(title)
    expect(screen.getByText('Choose a new password to finish signing in.')).toBeTruthy()
    expect(screen.getByText(EMAIL)).toBeTruthy()
    expect(field.autocomplete).toBe('new-password')
    expect(field.type).toBe('password')
    // No emailed code belongs to this step, and nobody is signed in yet.
    expectAbsent(screen.queryByLabelText('Verification code'))
    expectAbsent(screen.queryByRole('button', { name: 'Send a new code' }))
    expect(w.client.state.status).toBe('signed-out')
    // The policy's checklist is drawn for the new password.
    await waitFor(() =>
      expect(line('Not your current password').getAttribute('data-state')).toBe('pending')
    )

    w.api.on(ROUTE.signInNewPassword, () => completed('sign_in'))
    await w.user.type(field, NEW_PASSWORD)
    await w.user.click(screen.getByRole('button', { name: 'Save password and sign in' }))
    expect(await screen.findByRole('heading', { name: 'You are signed in.' })).toBeTruthy()
    expect(w.client.state.status).toBe('signed-in')
    const sent = w.api.calls(ROUTE.signInNewPassword)[0]
    expect(sent?.body).toEqual({ password: NEW_PASSWORD })
    expect(sent?.headers.get('x-tula-attempt')).toBe('tula_at_test_secret')
    expect(document.body.innerHTML).not.toContain(NEW_PASSWORD)
  })

  test('with no history in the policy the line still says "not your current password"', async () => {
    const w = world()
    const field = await toExpired(w)
    await waitFor(() =>
      expect(line('Not your current password').getAttribute('data-state')).toBe('pending')
    )
    expect(line('Not your current password').textContent).toBe(
      'Checked when you save: Not your current password (Checked when you save)'
    )

    w.api.on(ROUTE.signInNewPassword, () =>
      failure(422, 'password.reused', {
        params: { history: 1 },
        errors: [
          { field: 'password', code: 'password.reused', message: reused, params: { history: 1 } },
        ],
      })
    )
    await w.user.type(field, PASSWORD)
    await w.user.click(screen.getByRole('button', { name: 'Save password and sign in' }))
    expect((await screen.findByRole('alert')).textContent).toContain(reused)
    expect(line('Not your current password').getAttribute('data-state')).toBe('failed')
    expect(line('Not your current password').textContent).toBe('Not met: Not your current password')
    // Still on the step, the field focused, nobody signed in.
    await expectFocus(field)
    expect(screen.getByRole('heading', { name: 'Your password has expired' })).toBeTruthy()
    expect(w.client.state.status).toBe('signed-out')
    // The refusal was about what was sent: the line waits again once the field is edited.
    await w.user.type(field, '-again')
    expect(line('Not your current password').getAttribute('data-state')).toBe('pending')
  })

  test('with a history in the policy the line names its number', async () => {
    const w = world({
      policy: { ...PASSWORD_POLICY_PRESETS.recommended, preset: 'custom', history: 3 },
    })
    await toExpired(w)
    await waitFor(() =>
      expect(line('Not one of your last 3 passwords').getAttribute('data-state')).toBe('pending')
    )
  })

  test('an empty password is refused locally; the server’s rules land on the field', async () => {
    const w = world()
    const field = await toExpired(w)
    await w.user.click(screen.getByRole('button', { name: 'Save password and sign in' }))
    expect((await screen.findByRole('alert')).textContent).toContain('This field is required')
    expect(w.api.calls(ROUTE.signInNewPassword)).toHaveLength(0)

    const tooShort = 'Use at least 12 characters.'
    w.api.on(ROUTE.signInNewPassword, () =>
      failure(422, 'password.too_short', {
        errors: [{ field: 'password', code: 'password.too_short', message: tooShort }],
      })
    )
    await w.user.type(field, 'short')
    await w.user.click(screen.getByRole('button', { name: 'Save password and sign in' }))
    await waitFor(() => expect(field.getAttribute('aria-invalid')).toBe('true'))
    expect(screen.getByRole('alert').textContent).toContain(tooShort)
    await expectFocus(field)
  })

  test('a password replaced elsewhere meanwhile: the message, and "Change" starts again', async () => {
    const w = world()
    const field = await toExpired(w)
    w.api.on(ROUTE.signInNewPassword, () => failure(409, 'flow.invalid_step'))
    await w.user.type(field, NEW_PASSWORD)
    await w.user.click(screen.getByRole('button', { name: 'Save password and sign in' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(w.client.state.status).toBe('signed-out')
    await w.user.click(screen.getByRole('button', { name: 'Change' }))
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy()
    expect((screen.getByLabelText('Email address') as HTMLInputElement).value).toBe(EMAIL)
  })

  test('too many tries shows the server’s countdown and refuses to submit until it ends', async () => {
    const w = world()
    const field = await toExpired(w)
    w.api.on(ROUTE.signInNewPassword, () =>
      failure(429, 'rate_limited', { params: { retryAfter: 30 } }, { 'retry-after': '30' })
    )
    await w.user.type(field, NEW_PASSWORD)
    const submit = screen.getByRole('button', { name: 'Save password and sign in' })
    await w.user.click(submit)
    const alert = await screen.findByRole('alert')
    // The countdown is drawn one render after the alert (`useCountdown` starts in an effect).
    await waitFor(() => expect(alert.textContent).toMatch(/Try again in (30|29)s\./))
    expect(submit.getAttribute('aria-disabled')).toBe('true')
    await w.user.click(submit)
    expect(w.api.calls(ROUTE.signInNewPassword)).toHaveLength(1)
  })

  test('after a second factor the same screen is drawn', async () => {
    const w = world()
    w.mount(<SignIn />)
    await toPassword(w)
    w.api.on(ROUTE.signInPassword, () =>
      attempt('sign_in', { status: 'needs_second_factor', options: ['totp'] })
    )
    await w.user.type(await screen.findByLabelText('Password'), PASSWORD)
    await w.user.click(screen.getByRole('button', { name: 'Sign in' }))
    w.api.on('POST /v1/client/sign-ins/attempt_1/second-factor', () =>
      attempt('sign_in', EXPIRED_PASSWORD_STEP)
    )
    await w.user.type(await screen.findByLabelText('Authentication code'), '123456')
    await w.user.click(screen.getByRole('button', { name: 'Verify' }))
    const title = await screen.findByRole('heading', { name: 'Your password has expired' })
    await expectFocus(title)
    expect(w.client.state.status).toBe('signed-out')
  })
})

describe('<SignIn> email verification', () => {
  async function toCode(w: World) {
    w.mount(<SignIn />)
    await toPassword(w)
    w.api.on(ROUTE.signInPassword, () => attempt('sign_in', CODE_STEP))
    await w.user.type(await screen.findByLabelText('Password'), PASSWORD)
    await w.user.click(screen.getByRole('button', { name: 'Sign in' }))
    return (await screen.findByLabelText('Verification code')) as HTMLInputElement
  }

  test('the code field is a one-time-code field; a pasted code with spaces is accepted', async () => {
    const w = world()
    const field = await toCode(w)
    expect(screen.getByText('Enter the 6-digit code we sent to m***@northline.app.')).toBeTruthy()
    expect(field.autocomplete).toBe('one-time-code')
    expect(field.inputMode).toBe('numeric')
    field.focus()
    await w.user.paste('123 456')
    expect(field.value).toBe('123456')
    await w.user.clear(field)
    await w.user.type(field, '12ab34567890')
    expect(field.value).toBe('123456')

    w.api.on(ROUTE.signInVerify, () => completed('sign_in'))
    await w.user.click(screen.getByRole('button', { name: 'Verify' }))
    await waitFor(() => expect(w.client.state.status).toBe('signed-in'))
    expect(w.api.calls(ROUTE.signInVerify)[0]?.body).toEqual({ code: '123456' })
  })

  test('an incomplete code is refused locally; a wrong one shows the attempts left; an expired one says so', async () => {
    const w = world()
    const field = await toCode(w)
    await w.user.type(field, '123')
    await w.user.click(screen.getByRole('button', { name: 'Verify' }))
    expect(screen.getByRole('alert').textContent).toBe('Enter the 6-digit code.')
    expect(w.api.calls(ROUTE.signInVerify)).toHaveLength(0)

    w.api.on(ROUTE.signInVerify, () =>
      failure(422, 'verification.invalid_code', { params: { attemptsRemaining: 2 } })
    )
    await w.user.type(field, '456')
    await w.user.click(screen.getByRole('button', { name: 'Verify' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('That code is incorrect. 2 attempts left.')
    )
    expect(field.value).toBe('')
    await expectFocus(field)

    w.api.on(ROUTE.signInVerify, () =>
      failure(422, 'verification.invalid_code', { params: { attemptsRemaining: 1 } })
    )
    await w.user.type(field, '111111{Enter}')
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('That code is incorrect. 1 attempt left.')
    )

    w.api.on(ROUTE.signInVerify, () => failure(410, 'verification.expired'))
    await w.user.type(field, '222222{Enter}')
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'That code has expired. Request a new one.'
      )
    )

    w.api.on(ROUTE.signInVerify, () => failure(429, 'verification.too_many_attempts'))
    await w.user.type(field, '333333{Enter}')
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'Too many incorrect codes. Request a new one.'
      )
    )
  })

  test('resend: the server’s cooldown is counted down on the button, then a new code can be asked for', async () => {
    const w = world()
    await toCode(w)
    w.api.on(ROUTE.signInResend, () =>
      failure(429, 'rate_limited', { params: { retryAfter: 1 } }, { 'retry-after': '1' })
    )
    await w.user.click(screen.getByRole('button', { name: 'Resend code' }))
    const waiting = await screen.findByRole('button', { name: /Resend code in \ds/ })
    expect(waiting.getAttribute('aria-disabled')).toBe('true')
    // The cooldown is about emails: the code can still be submitted meanwhile.
    expect(screen.getByRole('button', { name: 'Verify' }).getAttribute('aria-disabled')).toBeNull()
    await w.user.click(waiting)
    expect(w.api.calls(ROUTE.signInResend)).toHaveLength(1)

    w.api.on(ROUTE.signInResend, () => attempt('sign_in', CODE_STEP))
    const again = await screen.findByRole('button', { name: 'Resend code' }, { timeout: 3_000 })
    await w.user.click(again)
    expect(await screen.findByText('A new code is on its way.')).toBeTruthy()
    expect(w.api.calls(ROUTE.signInResend)).toHaveLength(2)
  })
})

describe('<SignIn> forgotten password', () => {
  async function toReset(w: World) {
    await toPassword(w)
    await w.user.click(await screen.findByRole('button', { name: 'Forgot password?' }))
    return (await screen.findByLabelText('Email address')) as HTMLInputElement
  }

  test('reset: email prefilled, then code and new password together, then signed in', async () => {
    const w = world()
    const onComplete = mock()
    w.mount(<SignIn onComplete={onComplete} />)
    const email = await toReset(w)
    expect(screen.getByRole('heading', { name: 'Reset your password' })).toBeTruthy()
    expect(email.value).toBe(EMAIL)

    w.api.on(ROUTE.reset, () => started('password_reset', NEW_PASSWORD_STEP))
    await w.user.click(screen.getByRole('button', { name: 'Send code' }))
    const title = await screen.findByRole('heading', { name: 'Choose a new password' })
    await expectFocus(title)
    expect(w.api.calls(ROUTE.reset)[0]?.body).toEqual({ email: EMAIL })

    const password = screen.getByLabelText('New password') as HTMLInputElement
    expect(password.autocomplete).toBe('new-password')
    // The live checklist, from the environment's policy.
    expect(await screen.findByText('10 or more characters')).toBeTruthy()

    // Both fields are needed.
    await w.user.click(screen.getByRole('button', { name: 'Reset password' }))
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toEqual([
      'Enter the 6-digit code.',
      'This field is required.',
    ])
    await expectFocus(screen.getByLabelText('Verification code'))

    w.api.on(ROUTE.resetSubmit, () => completed('password_reset'))
    await w.user.type(screen.getByLabelText('Verification code'), '123456')
    await w.user.type(password, PASSWORD)
    await w.user.click(screen.getByRole('button', { name: 'Reset password' }))
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    expect(w.api.calls(ROUTE.resetSubmit)[0]?.body).toEqual({ code: '123456', password: PASSWORD })
  })

  test('the server’s password rules land on the password field, a wrong code on the code field', async () => {
    const w = world()
    w.mount(<SignIn />)
    await toReset(w)
    w.api.on(ROUTE.reset, () => started('password_reset', NEW_PASSWORD_STEP))
    await w.user.click(screen.getByRole('button', { name: 'Send code' }))
    const password = await screen.findByLabelText('New password')
    const code = screen.getByLabelText('Verification code')

    w.api.on(ROUTE.resetSubmit, () =>
      failure(422, 'password.too_short', {
        params: { min: 10 },
        errors: [
          {
            field: 'password',
            code: 'password.too_short',
            message: 'Password is too short.',
            params: { min: 10 },
          },
          {
            field: 'password',
            code: 'password.breached',
            message: 'This password appeared in a data breach. Choose a different one.',
          },
        ],
      })
    )
    await w.user.type(code, '123456')
    await w.user.type(password, 'short')
    await w.user.click(screen.getByRole('button', { name: 'Reset password' }))
    const alert = await screen.findByRole('alert')
    expect([...alert.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      'Password is too short.',
      'This password appeared in a data breach. Choose a different one.',
    ])
    expect(password.getAttribute('aria-invalid')).toBe('true')
    expect(code.getAttribute('aria-invalid')).toBeNull()
    await expectFocus(password)

    w.api.on(ROUTE.resetSubmit, () =>
      failure(422, 'verification.invalid_code', { params: { attemptsRemaining: 4 } })
    )
    await w.user.click(screen.getByRole('button', { name: 'Reset password' }))
    await waitFor(() => expect(code.getAttribute('aria-invalid')).toBe('true'))
    expect(screen.getByRole('alert').textContent).toBe('That code is incorrect.')
    await expectFocus(code)
  })

  test('resend, a second factor after a reset, and the way back to sign-in', async () => {
    const w = world()
    w.mount(<SignIn />)
    await toReset(w)
    w.api.on(ROUTE.reset, () => started('password_reset', NEW_PASSWORD_STEP))
    await w.user.click(screen.getByRole('button', { name: 'Send code' }))
    await screen.findByLabelText('New password')

    w.api.on(ROUTE.resetResend, () => attempt('password_reset', NEW_PASSWORD_STEP))
    await w.user.click(screen.getByRole('button', { name: 'Resend code' }))
    expect(await screen.findByText('A new code is on its way.')).toBeTruthy()

    w.api.on(ROUTE.resetSubmit, () =>
      attempt('password_reset', { status: 'needs_second_factor', options: ['sms_code'] })
    )
    await w.user.type(screen.getByLabelText('Verification code'), '123456')
    await w.user.type(screen.getByLabelText('New password'), PASSWORD)
    await w.user.click(screen.getByRole('button', { name: 'Reset password' }))
    expect(await screen.findByRole('heading', { name: 'This step is not supported' })).toBeTruthy()
    await w.user.click(screen.getByRole('button', { name: 'Start again' }))
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy()
  })

  test('reset: the history rule waits for the server, fails on `password.reused`, and waits again', async () => {
    const reused = 'You have used this password recently. Choose a different one.'
    const w = world({
      policy: { ...PASSWORD_POLICY_PRESETS.recommended, preset: 'custom', history: 3 },
    })
    w.mount(<SignIn />)
    await toReset(w)
    w.api.on(ROUTE.reset, () => started('password_reset', NEW_PASSWORD_STEP))
    await w.user.click(screen.getByRole('button', { name: 'Send code' }))
    const password = (await screen.findByLabelText('New password')) as HTMLInputElement
    const line = () => {
      const item = screen.getByText('Not one of your last 3 passwords', { exact: false })
      return item.closest('li') as HTMLElement
    }
    await waitFor(() => expect(line().getAttribute('data-state')).toBe('pending'))
    expect(line().textContent).toBe(
      'Checked when you save: Not one of your last 3 passwords (Checked when you save)'
    )

    w.api.on(ROUTE.resetSubmit, () =>
      failure(422, 'password.reused', {
        params: { history: 3 },
        errors: [
          { field: 'password', code: 'password.reused', message: reused, params: { history: 3 } },
        ],
      })
    )
    await w.user.type(screen.getByLabelText('Verification code'), '123456')
    await w.user.type(password, PASSWORD)
    expect(line().className).not.toContain('tula-is-met')
    await w.user.click(screen.getByRole('button', { name: 'Reset password' }))
    expect((await screen.findByRole('alert')).textContent).toContain(reused)
    expect(line().getAttribute('data-state')).toBe('failed')
    expect(line().textContent).toBe('Not met: Not one of your last 3 passwords')
    await expectFocus(password)
    // The code is still good: another password can be tried with it.
    await w.user.type(password, '-again')
    expect(line().getAttribute('data-state')).toBe('pending')
  })

  test('"Back to sign in" leaves the reset; an empty email is refused locally', async () => {
    const w = world()
    w.mount(<SignIn />)
    const email = await toReset(w)
    await w.user.clear(email)
    await w.user.click(screen.getByRole('button', { name: 'Send code' }))
    expect(screen.getByRole('alert').textContent).toBe('This field is required.')
    expect(w.api.calls(ROUTE.reset)).toHaveLength(0)
    await w.user.type(email, 'x')
    expectAbsent(screen.queryByRole('alert'))
    await w.user.click(screen.getByRole('button', { name: 'Back to sign in' }))
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy()
  })
})

describe('<SignIn> navigation', () => {
  test('afterSignInUrl is followed with window.location.assign, resolved against the page', async () => {
    const w = world()
    const assign = spyOn(window.location, 'assign').mockImplementation(() => undefined)
    w.mount(<SignIn />, { afterSignInUrl: '/app' })
    await toPassword(w)
    w.api.on(ROUTE.signInPassword, () => completed('sign_in'))
    await w.user.type(await screen.findByLabelText('Password'), PASSWORD)
    await w.user.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1))
    expect(assign).toHaveBeenCalledWith('http://localhost:5173/app')
  })

  test('the app’s navigate gets the URL as written; the component’s URL wins over the provider’s', async () => {
    const w = world()
    const navigate = mock()
    w.mount(<SignIn afterSignInUrl='/dashboard' />, { afterSignInUrl: '/app', navigate })
    await toPassword(w)
    w.api.on(ROUTE.signInPassword, () => completed('sign_in'))
    await w.user.type(await screen.findByLabelText('Password'), PASSWORD)
    await w.user.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/dashboard'))
    expect(navigate).toHaveBeenCalledTimes(1)
  })

  test('a URL that is not http(s) is never followed', async () => {
    const w = world()
    const assign = spyOn(window.location, 'assign').mockImplementation(() => undefined)
    const navigate = mock()
    // biome-ignore lint/suspicious/noTemplateCurlyInString: not a template: a hostile URL
    w.mount(
      <SignIn afterSignInUrl='javascript:alert(document.domain)' signUpUrl='javascript:alert(1)' />,
      { navigate }
    )
    await screen.findByRole('heading', { name: 'Sign in' })
    expectAbsent(screen.queryByRole('link'))
    await toPassword(w)
    w.api.on(ROUTE.signInPassword, () => completed('sign_in'))
    await w.user.type(await screen.findByLabelText('Password'), PASSWORD)
    await w.user.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(w.client.state.status).toBe('signed-in'))
    expect(assign).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })

  test('someone already signed in is sent on without a form', async () => {
    const w = world({ signedIn: true })
    const navigate = mock()
    w.mount(<SignIn />, { afterSignInUrl: '/app', navigate })
    expect(await screen.findByRole('heading', { name: 'You are signed in.' })).toBeTruthy()
    expect(navigate).toHaveBeenCalledWith('/app')
    expectAbsent(screen.queryByLabelText('Email address'))
  })

  test('inside <SignedOut>, which unmounts it on sign-in, completion is still reported', async () => {
    const w = world()
    const onComplete = mock()
    w.mount(
      <SignedOut>
        <SignIn onComplete={onComplete} />
      </SignedOut>
    )
    await toPassword(w)
    w.api.on(ROUTE.signInPassword, () => completed('sign_in'))
    await w.user.type(await screen.findByLabelText('Password'), PASSWORD)
    await w.user.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    expectAbsent(screen.queryByRole('heading'))
  })

  test('the sign-up link: a real link with a URL, a button with a callback, nothing with neither', async () => {
    const w = world()
    const navigate = mock()
    const first = w.mount(<SignIn signUpUrl='/sign-up' />, { navigate })
    const link = (await screen.findByRole('link', {
      name: 'Create an account',
    })) as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/sign-up')
    await w.user.click(link)
    expect(navigate).toHaveBeenCalledWith('/sign-up')
    first.unmount()

    const onSwitch = mock()
    const second = w.mount(<SignIn onSwitchToSignUp={onSwitch} />)
    await w.user.click(await screen.findByRole('button', { name: 'Create an account' }))
    expect(onSwitch).toHaveBeenCalledTimes(1)
    second.unmount()

    const third = w.mount(<SignIn signUpUrl='/sign-up' onSwitchToSignUp={onSwitch} />)
    await w.user.click(await screen.findByRole('link', { name: 'Create an account' }))
    expect(onSwitch).toHaveBeenCalledTimes(2)
    third.unmount()

    w.mount(<SignIn />)
    await screen.findByRole('heading', { name: 'Sign in' })
    expectAbsent(screen.queryByText('New here?'))
  })

  test('initialEmail fills the field; headingLevel sets the title’s level', async () => {
    const w = world()
    w.mount(<SignIn initialEmail={EMAIL} headingLevel={2} />)
    expect(await screen.findByRole('heading', { level: 2, name: 'Sign in' })).toBeTruthy()
    expect((screen.getByLabelText('Email address') as HTMLInputElement).value).toBe(EMAIL)
  })
})

describe('<SignIn> inside <Activity> (F3)', () => {
  test('hidden and shown again half-way: the screen and the attempt still agree, and it completes', async () => {
    const w = world()
    const onComplete = mock()
    const tree = (mode: 'visible' | 'hidden') => (
      <TulaProvider client={w.client}>
        <Activity mode={mode}>
          <SignIn onComplete={onComplete} />
        </Activity>
      </TulaProvider>
    )
    const { rerender } = render(tree('visible'))
    await toPassword(w)
    await screen.findByRole('heading', { name: 'Enter your password' })

    // Hiding tears the component's effects down and keeps its state; showing runs them again.
    rerender(tree('hidden'))
    rerender(tree('visible'))
    expect(screen.getByRole('heading', { name: 'Enter your password' })).toBeTruthy()

    w.api.on(ROUTE.signInPassword, () => completed('sign_in'))
    await w.user.type(screen.getByLabelText('Password'), PASSWORD)
    await w.user.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    // The step on screen was acted on with the attempt it belongs to: no local refusal.
    expectAbsent(screen.queryByText(/not valid at this step/))
    expect(w.api.calls(ROUTE.signInPassword)[0]?.headers.get('x-tula-attempt')).toBe(
      'tula_at_test_secret'
    )
  })
})
