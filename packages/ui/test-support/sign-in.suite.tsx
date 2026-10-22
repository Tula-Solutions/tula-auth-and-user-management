import { describe, expect, mock, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import {
  completed,
  expectAbsent,
  expectFocus,
  failure,
  ROUTE,
  started,
  type World,
  world,
} from '../../react/src/testing/harness'

/** What a sign-in is given by the suite: the callback, and whether "Forgot password?" is wanted. */
export interface SuiteProps {
  onComplete?(result: { userId: string; sessionId: string }): void
  forgotPassword: boolean
}

const EMAIL = 'maya@northline.app'
const PASSWORD = 'sturdy-Otter-plays-42-chess'

/** Type the email and continue to the password screen. */
async function toPassword(
  w: World,
  step: { status: string; strategies?: string[] } = { status: 'needs_password' }
) {
  w.api.on(ROUTE.signIn, () => started('sign_in', step))
  await w.user.type(await screen.findByLabelText('Email address'), EMAIL)
  await w.user.click(screen.getByRole('button', { name: 'Continue' }))
}

/**
 * One behavioural suite for the password path of a sign-in, run against the prebuilt `<SignIn>`
 * and against the registry's, so that the two cannot drift: the same words, the same focus, the
 * same errors, the same requests. Neither is asked about its markup or its classes.
 *
 * @param name - What the suite is run against, for the test names.
 * @param sign - Draws the sign-in under the world's provider.
 */
export function passwordSignInSuite(name: string, sign: (props: SuiteProps) => ReactElement): void {
  describe(`${name}: the password path`, () => {
    test('email, then password, then complete: onComplete gets the ids, once, and the secret travels in a header', async () => {
      const w = world()
      const onComplete = mock()
      w.mount(sign({ onComplete, forgotPassword: true }))
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
      expect(onComplete).toHaveBeenCalledTimes(1)
    })

    test('the first screen does not take focus, and an empty email is refused locally', async () => {
      const w = world()
      w.mount(sign({ forgotPassword: true }))
      await screen.findByRole('heading', { name: 'Sign in' })
      await expectFocus(document.body)
      await w.user.click(screen.getByRole('button', { name: 'Continue' }))
      const email = screen.getByLabelText('Email address')
      expect(email.getAttribute('aria-invalid')).toBe('true')
      const alert = screen.getByRole('alert')
      expect(alert.textContent).toBe('This field is required.')
      expect(email.getAttribute('aria-describedby')).toContain(alert.id)
      await expectFocus(email)
      expect(w.api.calls(ROUTE.signIn)).toHaveLength(0)
      // Typing clears the message.
      await w.user.type(email, 'm')
      expectAbsent(screen.queryByRole('alert'))
    })

    test('a wrong password is shown on the password field, which is emptied and focused', async () => {
      const w = world()
      w.mount(sign({ forgotPassword: true }))
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
      w.mount(sign({ forgotPassword: true }))
      await toPassword(w)
      w.api.on(ROUTE.signInPassword, () =>
        failure(429, 'rate_limited', { params: { retryAfter: 2 } }, { 'retry-after': '2' })
      )
      await w.user.type(await screen.findByLabelText('Password'), 'wrong-password')
      await w.user.click(screen.getByRole('button', { name: 'Sign in' }))
      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toContain('Too many requests. Try again shortly.')
      // The countdown is drawn one render after the alert (it is read from the clock in an effect).
      await waitFor(() => expect(alert.textContent).toMatch(/Try again in [12]s\./))
      const submit = screen.getByRole('button', { name: 'Sign in' })
      expect(submit.getAttribute('aria-disabled')).toBe('true')

      // Neither a click nor Enter sends anything while locked.
      await w.user.type(screen.getByLabelText('Password'), 'another-guess{Enter}')
      await w.user.click(submit)
      expect(w.api.calls(ROUTE.signInPassword)).toHaveLength(1)

      await waitFor(() => expect(submit.getAttribute('aria-disabled')).toBeNull(), {
        timeout: 4_000,
      })
      expect(screen.getByRole('alert').textContent).not.toContain('Try again in')
    })

    test('a pending button keeps its name, is busy, and a second submit sends nothing', async () => {
      const w = world()
      w.mount(sign({ forgotPassword: true }))
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
      w.mount(sign({ forgotPassword: true }))
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
      expect(reached).toEqual([
        'Change',
        'password',
        'Show password',
        'Forgot password?',
        'Sign in',
      ])
    })

    test('"Change" goes back to the email screen with the address kept', async () => {
      const w = world()
      w.mount(sign({ forgotPassword: true }))
      await toPassword(w)
      await w.user.click(await screen.findByRole('button', { name: 'Change' }))
      const email = (await screen.findByLabelText('Email address')) as HTMLInputElement
      expect(email.value).toBe(EMAIL)
      expect(email.autocomplete).toBe('username')
    })

    test('a network failure is shown above the form and marks no field', async () => {
      const w = world()
      w.mount(sign({ forgotPassword: true }))
      w.api.on(ROUTE.signIn, () => Promise.reject(new TypeError('offline')))
      await w.user.type(await screen.findByLabelText('Email address'), EMAIL)
      await w.user.click(screen.getByRole('button', { name: 'Continue' }))
      expect((await screen.findByRole('alert')).textContent).toBe(
        'Could not reach the server. Check your connection and try again.'
      )
      expect(screen.getByLabelText('Email address').getAttribute('aria-invalid')).toBeNull()
    })

    test('needs_first_factor: the password form when it is offered, unknown strategies skipped', async () => {
      const w = world()
      w.mount(sign({ forgotPassword: true }))
      await toPassword(w, {
        status: 'needs_first_factor',
        strategies: ['hologram', 'retina', 'password'],
      })
      expect(await screen.findByLabelText('Password')).toBeTruthy()
    })

    test('needs_first_factor with nothing this version implements says so, and can start again', async () => {
      const w = world()
      w.mount(sign({ forgotPassword: true }))
      await toPassword(w, { status: 'needs_first_factor', strategies: ['retina', 'constructor'] })
      const title = await screen.findByRole('heading', { name: 'This step is not supported' })
      await expectFocus(title)
      expect(screen.getByText(/not supported by this version/)).toBeTruthy()
      await w.user.click(screen.getByRole('button', { name: 'Start again' }))
      expect(await screen.findByLabelText('Email address')).toBeTruthy()
    })

    test.each([
      ['a second factor this version cannot ask for', { status: 'needs_second_factor' }],
      ['a status from a newer server', { status: 'needs_retina_scan' }],
    ])('%s is the "not supported" screen, never a blank card', async (_name, step) => {
      const w = world()
      w.mount(sign({ forgotPassword: true }))
      await toPassword(w, step)
      expect(
        await screen.findByRole('heading', { name: 'This step is not supported' })
      ).toBeTruthy()
      expectAbsent(screen.queryByLabelText('Password'))
    })
  })
}
