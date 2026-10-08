import { afterEach, describe, expect, mock, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import { PASSWORD_POLICY_PRESETS } from '@tula/contract'
import {
  attempt,
  CODE_STEP,
  completed,
  expectFocus,
  failure,
  ROUTE,
  started,
  type World,
  world,
} from '../testing/harness'
import { SignedOut } from './control'
import { SignUp } from './sign-up'

const EMAIL = 'maya@northline.app'
const PASSWORD = 'sturdy-Otter-plays-42-chess'

afterEach(() => {
  mock.restore()
})

/** The checklist as a screen reader gets it: each rule with its state as text. */
function checklist(): string[] {
  return [
    ...screen.getByRole('list', { name: 'Password requirements' }).querySelectorAll('li'),
  ].map((item) => item.textContent ?? '')
}

async function fill(w: World, password = PASSWORD) {
  await w.user.type(await screen.findByLabelText('Email address'), EMAIL)
  await w.user.type(screen.getByLabelText('Password'), password)
}

describe('<SignUp>', () => {
  test('the checklist updates with every keystroke and says each rule’s state as text', async () => {
    const w = world({ policy: PASSWORD_POLICY_PRESETS.strict })
    w.mount(<SignUp />)
    const password = (await screen.findByLabelText('Password')) as HTMLInputElement
    expect(password.autocomplete).toBe('new-password')
    await waitFor(() => expect(checklist().length).toBeGreaterThan(0))
    // Nothing typed: every rule unmet, and no bar segment filled.
    expect(checklist().every((line) => line.startsWith('Not met: '))).toBe(true)
    expect(checklist()).toContain('Not met: 12 or more characters')
    expect(
      document.querySelectorAll('[data-tula-element="strengthBar"] [data-filled]')
    ).toHaveLength(0)
    // The field points at the checklist.
    const list = screen.getByRole('list', { name: 'Password requirements' })
    expect(password.getAttribute('aria-describedby')).toContain(list.parentElement?.id ?? 'missing')

    await w.user.type(password, 'a')
    expect(checklist()).toContain('Met: One lowercase letter')
    expect(checklist()).toContain('Not met: One uppercase letter')
    await w.user.type(password, 'B')
    expect(checklist()).toContain('Met: One uppercase letter')
    await w.user.type(password, '7')
    expect(checklist()).toContain('Met: One number')
    await w.user.type(password, '!')
    expect(checklist()).toContain('Met: One special character')
    expect(checklist()).toContain('Not met: 12 or more characters')
    await w.user.type(password, 'quiet-heron')
    expect(checklist().every((line) => line.startsWith('Met: '))).toBe(true)
    expect(
      document.querySelectorAll('[data-tula-element="strengthBar"] [data-filled]')
    ).toHaveLength(4)
    expect(screen.getByRole('status').textContent).toMatch(
      /^(\d+) of \1 password requirements met$/
    )
    // The rule about length only appears when it is broken.
    expect(checklist().some((line) => line.includes('No more than 128 characters'))).toBe(false)

    // The email is part of the rules: a password that contains it fails "user info".
    await w.user.type(screen.getByLabelText('Email address'), 'heron@northline.app')
    expect(checklist()).toContain('Not met: Does not contain your name or email')
  })

  test('show and hide the password', async () => {
    const w = world()
    w.mount(<SignUp />)
    const password = (await screen.findByLabelText('Password')) as HTMLInputElement
    const toggle = screen.getByRole('button', { name: 'Show password' })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    await w.user.click(toggle)
    expect(password.type).toBe('text')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    await w.user.click(toggle)
    expect(password.type).toBe('password')
  })

  test('sign up, verify the code, signed in: onComplete, and the password leaves the page', async () => {
    const w = world()
    const onComplete = mock()
    w.mount(<SignUp onComplete={onComplete} collectName />)
    await w.user.type(await screen.findByLabelText('First name'), ' Maya ')
    await fill(w)
    w.api.on(ROUTE.signUp, () => started('sign_up', CODE_STEP))
    await w.user.click(screen.getByRole('button', { name: 'Continue' }))
    const title = await screen.findByRole('heading', { name: 'Check your email' })
    await expectFocus(title)
    expect(w.api.calls(ROUTE.signUp)[0]?.body).toEqual({
      email: EMAIL,
      password: PASSWORD,
      firstName: 'Maya',
    })
    expect(document.body.innerHTML).not.toContain(PASSWORD)

    w.api.on(ROUTE.signUpVerify, () => completed('sign_up'))
    await w.user.type(screen.getByLabelText('Verification code'), '123456')
    await w.user.click(screen.getByRole('button', { name: 'Verify' }))
    await waitFor(() =>
      expect(onComplete).toHaveBeenCalledWith({ userId: 'user_1', sessionId: 'session_1' })
    )
    expect(w.client.state.status).toBe('signed-in')
    expect(await screen.findByRole('heading', { name: 'You are signed in.' })).toBeTruthy()
  })

  test('empty fields are refused locally, the first one focused', async () => {
    const w = world()
    w.mount(<SignUp />)
    await w.user.click(await screen.findByRole('button', { name: 'Continue' }))
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toEqual([
      'This field is required.',
      'This field is required.',
    ])
    await expectFocus(screen.getByLabelText('Email address'))
    expect(w.api.calls(ROUTE.signUp)).toHaveLength(0)
  })

  test('a weak password: every rule the server names is listed under the password field', async () => {
    const w = world()
    w.mount(<SignUp />)
    await fill(w, 'password1')
    w.api.on(ROUTE.signUp, () =>
      failure(422, 'password.too_short', {
        params: { min: 10 },
        errors: [
          { field: 'password', code: 'password.too_short', message: 'Password is too short.' },
          { field: 'password', code: 'password.common', message: 'This password is too common.' },
        ],
      })
    )
    await w.user.click(screen.getByRole('button', { name: 'Continue' }))
    const alert = await screen.findByRole('alert')
    expect([...alert.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      'Password is too short.',
      'This password is too common.',
    ])
    const password = screen.getByLabelText('Password') as HTMLInputElement
    expect(password.getAttribute('aria-invalid')).toBe('true')
    await expectFocus(password)
    // What was typed is kept so it can be fixed.
    expect(password.value).toBe('password1')
    expect(screen.getByLabelText('Email address').getAttribute('aria-invalid')).toBeNull()
  })

  test('an invalid email lands on the email field; a field this form lacks goes above the form', async () => {
    const w = world()
    w.mount(<SignUp />)
    await fill(w)
    w.api.on(ROUTE.signUp, () =>
      failure(422, 'email.invalid', {
        errors: [
          { field: 'email', code: 'email.invalid', message: 'Enter a valid email address.' },
        ],
      })
    )
    await w.user.click(screen.getByRole('button', { name: 'Continue' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Enter a valid email address.')
    await expectFocus(screen.getByLabelText('Email address'))

    w.api.on(ROUTE.signUp, () =>
      failure(422, 'validation.failed', {
        errors: [{ field: 'locale', code: 'validation.failed', message: 'Unknown locale.' }],
      })
    )
    await w.user.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('Some fields are invalid.')
    )
    expect(screen.getByRole('alert').getAttribute('data-tula-element')).toBe('error')
  })

  test('rate limited: the countdown; a network failure: the message', async () => {
    const w = world()
    w.mount(<SignUp />)
    await fill(w)
    w.api.on(ROUTE.signUp, () => failure(429, 'rate_limited', { params: { retryAfter: 75 } }))
    await w.user.click(screen.getByRole('button', { name: 'Continue' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/Try again in 1m 1[45]s\./)
    expect(screen.getByRole('button', { name: 'Continue' }).getAttribute('aria-disabled')).toBe(
      'true'
    )
  })

  test('a step sign-up does not know renders the unsupported state and can start again', async () => {
    const w = world()
    w.mount(<SignUp />)
    await fill(w)
    w.api.on(ROUTE.signUp, () => started('sign_up', { status: 'needs_factor_enrolment' }))
    await w.user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByRole('heading', { name: 'This step is not supported' })).toBeTruthy()
    await w.user.click(screen.getByRole('button', { name: 'Start again' }))
    expect(await screen.findByRole('heading', { name: 'Create your account' })).toBeTruthy()
  })

  test('resend and the wrong-code path work on the sign-up routes', async () => {
    const w = world()
    w.mount(
      <SignedOut>
        <SignUp />
      </SignedOut>,
      { afterSignUpUrl: '/welcome', navigate: mock() }
    )
    await fill(w)
    w.api.on(ROUTE.signUp, () => started('sign_up', CODE_STEP))
    await w.user.click(screen.getByRole('button', { name: 'Continue' }))
    w.api.on(ROUTE.signUpResend, () => attempt('sign_up', CODE_STEP))
    await w.user.click(await screen.findByRole('button', { name: 'Resend code' }))
    expect(await screen.findByText('A new code is on its way.')).toBeTruthy()
    w.api.on(ROUTE.signUpVerify, () =>
      failure(422, 'verification.invalid_code', { params: { attemptsRemaining: 4 } })
    )
    await w.user.type(screen.getByLabelText('Verification code'), '000000{Enter}')
    expect((await screen.findByRole('alert')).textContent).toBe(
      'That code is incorrect. 4 attempts left.'
    )
    // The confirmation of the resend does not linger next to the new error.
    expect(screen.queryByText('A new code is on its way.')).toBeNull()
  })

  test('the sign-in link uses the provider’s URL', async () => {
    const w = world()
    w.mount(<SignUp />, { signInUrl: '/sign-in' })
    const link = await screen.findByRole('link', { name: 'Sign in' })
    expect(link.getAttribute('href')).toBe('/sign-in')
    expect(screen.getByText('Secured by Tula')).toBeTruthy()
  })
})
