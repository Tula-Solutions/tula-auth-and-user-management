import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { act, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { TulaProvider } from '../context'
import { useEmailLinkCallback } from '../hooks/use-email-link-callback'
import {
  attempt,
  CODE_STEP,
  completed,
  expectAbsent,
  expectFocus,
  type FakeLinkStorage,
  type FakeTimers,
  failure,
  fakeLinkStorage,
  fakePage,
  fakeTimers,
  json,
  ROUTE,
  sessionTokens,
  started,
  type World,
  world,
} from '../testing/harness'
import { EmailLinkCallback } from './email-link-callback'
import { SignIn } from './sign-in'
import { SignUp } from './sign-up'

const EMAIL = 'maya@northline.app'
const DESTINATION = 'm***@northline.app'
const BINDING = 'tula_lb_b1nd1ng-of-the-link'
const LINK_URL = 'http://localhost:5173/auth/link'

afterEach(() => {
  mock.restore()
})

type Strategy = 'password' | 'email_code' | 'email_link'
const choice = (strategies: Strategy[], prepared?: 'email_code' | 'email_link') => ({
  status: 'needs_first_factor' as const,
  strategies,
  ...(prepared && { prepared: { strategy: prepared, destination: DESTINATION } }),
})
const ALL: Strategy[] = ['password', 'email_code', 'email_link']

/** Answer `first-factor/prepare` with the step for whatever strategy was asked for. */
function emails(w: World, strategies: Strategy[]) {
  w.api.on(ROUTE.signInPrepare, (request) => {
    const { strategy } = request.body as { strategy: 'email_code' | 'email_link' }
    return attempt(
      'sign_in',
      choice(strategies, strategy),
      strategy === 'email_link' ? { linkBinding: BINDING } : {}
    )
  })
}

/** Type the email and continue. */
async function begin(w: World, strategies: Strategy[]) {
  w.api.on(ROUTE.signIn, () => started('sign_in', choice(strategies)))
  emails(w, strategies)
  await w.user.type(await screen.findByLabelText('Email address'), EMAIL)
  await w.user.click(screen.getByRole('button', { name: 'Continue' }))
}

const alternatives = () =>
  screen
    .queryAllByRole('list', { name: 'Other ways to sign in' })
    .flatMap((list) => [...list.querySelectorAll('button')].map((button) => button.textContent))

function linkWorld(): { w: World; storage: FakeLinkStorage; timers: FakeTimers } {
  const storage = fakeLinkStorage()
  const timers = fakeTimers()
  return { w: world({ linkStorage: storage, timers }), storage, timers }
}

describe('<SignIn> with an emailed code', () => {
  test('where the code is the only method, Continue goes straight to the code and the code signs in', async () => {
    const w = world()
    const onComplete = mock()
    w.mount(<SignIn onComplete={onComplete} />)
    await begin(w, ['email_code'])

    const title = await screen.findByRole('heading', { name: 'Check your email' })
    await expectFocus(title)
    expect(screen.getByText(`Enter the 6-digit code we sent to ${DESTINATION}.`)).toBeTruthy()
    expect(screen.getByText(EMAIL)).toBeTruthy()
    expect(w.api.calls(ROUTE.signInPrepare)[0]?.body).toEqual({ strategy: 'email_code' })
    // Nothing else to choose from.
    expect(alternatives()).toEqual([])

    const field = screen.getByLabelText('Verification code') as HTMLInputElement
    expect(field.autocomplete).toBe('one-time-code')
    expect(field.inputMode).toBe('numeric')
    w.api.on(ROUTE.signInAttempt, () => completed('sign_in'))
    await w.user.type(field, '123 456')
    await w.user.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    expect(onComplete).toHaveBeenCalledWith({ userId: 'user_1', sessionId: 'session_1' })
    const sent = w.api.calls(ROUTE.signInAttempt)[0]
    expect(sent?.body).toEqual({ strategy: 'email_code', code: '123456' })
    expect(sent?.headers.get('x-tula-attempt')).toBe('tula_at_test_secret')
    expect(document.body.innerHTML).not.toContain('123456')
    expect(document.body.innerHTML).not.toContain('tula_at_test_secret')
  })

  test('when the email could not be sent at once, the screen offers to send it and counts the wait down', async () => {
    const w = world()
    w.mount(<SignIn />)
    w.api.on(ROUTE.signIn, () => started('sign_in', choice(['email_code'])))
    w.api.on(ROUTE.signInPrepare, () => failure(429, 'rate_limited', {}, { 'retry-after': '60' }))
    await w.user.type(await screen.findByLabelText('Email address'), EMAIL)
    await w.user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByRole('heading', { name: 'Email me a code' })).toBeTruthy()
    expect(screen.getByText('We will email you a 6-digit code to sign in with.')).toBeTruthy()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Too many requests')
    // The countdown is drawn one render after the alert (`useCountdown` starts in an effect).
    await waitFor(() => expect(alert.textContent).toMatch(/Try again in (1m 0s|59s)\./))
    expect(
      screen.getByRole('button', { name: 'Email me a code' }).getAttribute('aria-disabled')
    ).toBe('true')
  })

  test('offered beside the password: the password form first, the email methods as other ways in', async () => {
    const w = world()
    w.mount(<SignIn />)
    await begin(w, ['password', 'email_code'])
    expect(await screen.findByLabelText('Password')).toBeTruthy()
    expect(w.api.calls(ROUTE.signInPrepare)).toHaveLength(0)
    expect(alternatives()).toEqual(['Email me a code'])

    // Choosing it asks for the email: one click.
    await w.user.click(screen.getByRole('button', { name: 'Email me a code' }))
    const title = await screen.findByRole('heading', { name: 'Check your email' })
    await expectFocus(title)
    expect(screen.getByLabelText('Verification code')).toBeTruthy()
    expect(w.api.calls(ROUTE.signInPrepare)).toHaveLength(1)
    expect(alternatives()).toEqual(['Use your password'])

    // And back to the password; the email that was sent is not sent again on the way back.
    await w.user.click(screen.getByRole('button', { name: 'Use your password' }))
    expect(await screen.findByLabelText('Password')).toBeTruthy()
    expect(alternatives()).toEqual(['Email me a code'])
    await w.user.click(screen.getByRole('button', { name: 'Email me a code' }))
    expect(await screen.findByLabelText('Verification code')).toBeTruthy()
    expect(w.api.calls(ROUTE.signInPrepare)).toHaveLength(1)
  })

  test('an email that cannot be sent yet leaves the method’s screen offering to send it', async () => {
    const w = world()
    w.mount(<SignIn />)
    await begin(w, ['password', 'email_code'])
    w.api.on(ROUTE.signInPrepare, () => failure(429, 'rate_limited', {}, { 'retry-after': '60' }))
    await w.user.click(await screen.findByRole('button', { name: 'Email me a code' }))
    const title = await screen.findByRole('heading', { name: 'Email me a code' })
    await expectFocus(title)
    // The countdown is drawn one render after the alert (`useCountdown` starts in an effect).
    expect(await screen.findByText(/Try again in (1m 0s|59s)\./)).toBeTruthy()
    const button = screen.getByRole('button', { name: 'Email me a code' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(alternatives()).toEqual(['Use your password'])
  })

  test('a wrong code is shown on the field with the guesses left, and the field is emptied', async () => {
    const w = world()
    w.mount(<SignIn />)
    await begin(w, ['email_code'])
    w.api.on(ROUTE.signInAttempt, () =>
      failure(422, 'verification.invalid_code', { params: { attemptsRemaining: 2 } })
    )
    const field = (await screen.findByLabelText('Verification code')) as HTMLInputElement
    await w.user.type(field, '000000')
    await w.user.click(screen.getByRole('button', { name: 'Sign in' }))
    const error = await screen.findByText(/That code is incorrect\. 2 attempts left\./)
    expect(error.getAttribute('role')).toBe('alert')
    expect(field.getAttribute('aria-invalid')).toBe('true')
    await waitFor(() => expect(field.value).toBe(''))
    await expectFocus(field)
  })

  test('an incomplete code is caught before anything is sent', async () => {
    const w = world()
    w.mount(<SignIn />)
    await begin(w, ['email_code'])
    await w.user.type(await screen.findByLabelText('Verification code'), '123')
    await w.user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Enter the 6-digit code.')).toBeTruthy()
    expect(w.api.calls(ROUTE.signInAttempt)).toHaveLength(0)
  })

  test('a new email can be asked for; the answer is announced, and a refusal is counted down', async () => {
    const w = world()
    w.mount(<SignIn />)
    await begin(w, ['email_code'])
    await screen.findByLabelText('Verification code')
    await w.user.click(screen.getByRole('button', { name: 'Send a new email' }))
    expect(await screen.findByText('A new email is on its way.')).toBeTruthy()
    expect(w.api.calls(ROUTE.signInPrepare)).toHaveLength(2)

    w.api.on(ROUTE.signInPrepare, () => failure(429, 'rate_limited', {}, { 'retry-after': '60' }))
    await w.user.click(screen.getByRole('button', { name: 'Send a new email' }))
    const waiting = await screen.findByRole('button', { name: /Send a new email in (1m 0s|59s)/ })
    expect(waiting.getAttribute('aria-disabled')).toBe('true')
    expectAbsent(screen.queryByText('A new email is on its way.'))
    // The code can still be submitted while a new email has to wait.
    expect(screen.getByRole('button', { name: 'Sign in' }).getAttribute('aria-disabled')).toBeNull()
  })

  test('“Change” goes back to the address', async () => {
    const w = world()
    w.mount(<SignIn />)
    await begin(w, ['email_code'])
    await screen.findByLabelText('Verification code')
    await w.user.click(screen.getByRole('button', { name: 'Change' }))
    expect(await screen.findByLabelText('Email address')).toBeTruthy()
  })
})

describe('<SignIn> with an emailed link', () => {
  test('is offered only with a link page, in a browser that can keep the binding', async () => {
    for (const [props, storage, offered] of [
      [{ emailLinkUrl: '/auth/link' }, true, true],
      [{}, true, false],
      [{ emailLinkUrl: 'javascript:alert(1)' }, true, false],
      [{ emailLinkUrl: '/auth/link' }, false, false],
    ] as const) {
      const w = world(storage ? { linkStorage: fakeLinkStorage() } : {})
      const view = w.mount(<SignIn {...props} />)
      await begin(w, ALL)
      await screen.findByLabelText('Password')
      await waitFor(() =>
        expect(alternatives()).toEqual(
          offered ? ['Email me a code', 'Email me a link'] : ['Email me a code']
        )
      )
      view.unmount()
    }
  })

  test('the provider’s link page is used when the component has none', async () => {
    const w = world({ linkStorage: fakeLinkStorage() })
    w.mount(<SignIn />, { emailLinkUrl: '/auth/link' })
    await begin(w, ALL)
    await waitFor(() => expect(alternatives()).toContain('Email me a link'))
  })

  test('asks for a link to the absolute page URL, waits, and signs in here when the link is opened', async () => {
    const { w, storage, timers } = linkWorld()
    const onComplete = mock()
    w.mount(<SignIn emailLinkUrl='/auth/link' onComplete={onComplete} />)
    await begin(w, ALL)
    await w.user.click(await screen.findByRole('button', { name: 'Email me a link' }))

    const title = await screen.findByRole('heading', { name: 'Check your email' })
    // "About to send" became "sent": the new title takes focus so the change is announced.
    await expectFocus(title)
    expect(w.api.calls(ROUTE.signInPrepare)[0]?.body).toEqual({
      strategy: 'email_link',
      redirectUrl: LINK_URL,
    })
    expect(
      screen.getByText(
        `We sent a sign-in link to ${DESTINATION}. Open it in this browser and you will be signed in here.`
      )
    ).toBeTruthy()
    expect(screen.getByText('Waiting for you to open the link…')).toBeTruthy()
    expect(screen.getByText(/Reading the email on another device\?/)).toBeTruthy()
    // The code from the same email can be typed here, so it is not offered as another way.
    expect(screen.getByLabelText('Verification code')).toBeTruthy()
    expect(alternatives()).toEqual(['Use your password'])
    // The binding is in shared storage; the page shows neither it nor the attempt's secret.
    expect(storage.entries.size).toBe(1)
    expect(document.body.innerHTML).not.toContain(BINDING)
    expect(document.body.innerHTML).not.toContain('tula_at_test_secret')

    // The page is waiting on one timer. Nothing has been asked yet.
    await waitFor(() => expect(timers.pending()).toHaveLength(1))
    expect(w.api.calls(ROUTE.signInAttempt)).toHaveLength(0)

    w.api.on(ROUTE.signInAttempt, () => completed('sign_in'))
    await act(async () => {
      timers.fire()
    })
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    expect(w.api.calls(ROUTE.signInAttempt)[0]?.body).toEqual({ strategy: 'email_link' })
    expect(await screen.findByRole('heading', { name: 'You are signed in.' })).toBeTruthy()
    expect(timers.pending()).toEqual([])
    expect(storage.entries.size).toBe(0)
  })

  test('the code from the link’s email signs in from the waiting screen', async () => {
    const { w, timers } = linkWorld()
    const onComplete = mock()
    w.mount(<SignIn emailLinkUrl='/auth/link' onComplete={onComplete} />)
    await begin(w, ['email_code', 'email_link'])
    // Without a password the first screen offers the code; the link is the other way.
    expect(await screen.findByRole('heading', { name: 'Email me a code' })).toBeTruthy()
    await w.user.click(await screen.findByRole('button', { name: 'Email me a link' }))
    const field = await screen.findByLabelText('Verification code')
    w.api.on(ROUTE.signInAttempt, () => completed('sign_in'))
    await w.user.type(field, '654321')
    await w.user.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    expect(w.api.calls(ROUTE.signInAttempt)[0]?.body).toEqual({
      strategy: 'email_code',
      code: '654321',
    })
    // The wait ended with the sign-in.
    await waitFor(() => expect(timers.pending()).toEqual([]))
  })

  test('leaving the waiting screen stops the wait and forgets the binding', async () => {
    const { w, storage, timers } = linkWorld()
    const view = w.mount(<SignIn emailLinkUrl='/auth/link' />)
    await begin(w, ALL)
    await w.user.click(await screen.findByRole('button', { name: 'Email me a link' }))
    await screen.findByText('Waiting for you to open the link…')
    await waitFor(() => expect(timers.pending()).toHaveLength(1))

    // Switching to the password keeps the attempt but stops asking the server.
    await w.user.click(screen.getByRole('button', { name: 'Use your password' }))
    await screen.findByLabelText('Password')
    await waitFor(() => expect(timers.pending()).toEqual([]))
    expect(storage.entries.size).toBe(1)
    // The link screen is one click away again, waits again, and no second email was sent.
    await w.user.click(screen.getByRole('button', { name: 'Email me a link' }))
    await screen.findByText('Waiting for you to open the link…')
    await waitFor(() => expect(timers.pending()).toHaveLength(1))
    expect(w.api.calls(ROUTE.signInPrepare)).toHaveLength(1)

    // Going back to the address leaves the attempt: nothing is left in the browser.
    await w.user.click(screen.getByRole('button', { name: 'Change' }))
    await screen.findByLabelText('Email address')
    await waitFor(() => expect(timers.pending()).toEqual([]))
    expect(storage.entries.size).toBe(0)
    expect(w.api.calls(ROUTE.signInAttempt)).toHaveLength(0)
    view.unmount()
  })

  test('unmounting while waiting leaves no timer running', async () => {
    const { w, timers } = linkWorld()
    const view = w.mount(<SignIn emailLinkUrl='/auth/link' />)
    await begin(w, ALL)
    await w.user.click(await screen.findByRole('button', { name: 'Email me a link' }))
    await waitFor(() => expect(timers.pending()).toHaveLength(1))
    view.unmount()
    await waitFor(() => expect(timers.pending()).toEqual([]))
  })

  test('under StrictMode, where effects run twice, the page still waits and still signs in', async () => {
    const { w, timers } = linkWorld()
    const onComplete = mock()
    render(
      <StrictMode>
        <TulaProvider client={w.client}>
          <SignIn emailLinkUrl='/auth/link' onComplete={onComplete} />
        </TulaProvider>
      </StrictMode>
    )
    await begin(w, ALL)
    await w.user.click(await screen.findByRole('button', { name: 'Email me a link' }))
    await screen.findByText('Waiting for you to open the link…')
    // The effect was set up, cleaned up and set up again: one wait is left, on one timer.
    await waitFor(() => expect(timers.pending()).toHaveLength(1))
    w.api.on(ROUTE.signInAttempt, () => completed('sign_in'))
    await act(async () => {
      timers.fire()
    })
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    expect(timers.pending()).toEqual([])
  })

  test('a wait that ends in a refusal shows why', async () => {
    const { w, timers } = linkWorld()
    w.mount(<SignIn emailLinkUrl='/auth/link' />)
    await begin(w, ALL)
    await w.user.click(await screen.findByRole('button', { name: 'Email me a link' }))
    await waitFor(() => expect(timers.pending()).toHaveLength(1))
    w.api.on(ROUTE.signInAttempt, () => failure(404, 'flow.not_found'))
    await act(async () => {
      timers.fire()
    })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('This attempt does not exist or has expired.')
    expect(timers.pending()).toEqual([])
  })

  test('a link page the environment does not allow is reported, and nothing waits', async () => {
    const { w, timers } = linkWorld()
    w.mount(<SignIn emailLinkUrl='/auth/link' />)
    await begin(w, ALL)
    w.api.on(ROUTE.signInPrepare, () => failure(400, 'request.redirect_not_allowed'))
    await w.user.click(await screen.findByRole('button', { name: 'Email me a link' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('This redirect URL is not allowed for this app.')
    // The link's own screen, saying what it would do, with the refusal on it.
    expect(screen.getByRole('heading', { name: 'Email me a link' })).toBeTruthy()
    expect(
      screen.getByText('We will email you a link that signs you in on this device.')
    ).toBeTruthy()
    expect(timers.pending()).toEqual([])
  })

  test('with a link already emailed, switching to the code needs no new email', async () => {
    const { w } = linkWorld()
    w.mount(<SignIn emailLinkUrl='/auth/link' />)
    w.api.on(ROUTE.signIn, () => started('sign_in', choice(ALL, 'email_link')))
    emails(w, ALL)
    await w.user.type(await screen.findByLabelText('Email address'), EMAIL)
    await w.user.click(screen.getByRole('button', { name: 'Continue' }))
    // The step says a link was emailed: the waiting screen is drawn straight away.
    expect(await screen.findByText('Waiting for you to open the link…')).toBeTruthy()
    expect(w.api.calls(ROUTE.signInPrepare)).toHaveLength(0)
  })
})

describe('<SignUp> where the password is optional', () => {
  test('says so, and an empty one starts a sign-up without a password', async () => {
    const w = world({ signUpPassword: 'optional' })
    w.mount(<SignUp />)
    const field = (await screen.findByLabelText('Password (optional)')) as HTMLInputElement
    expect(field.required).toBe(false)
    expect(
      screen.getByText('Leave it empty to sign in with a code we email you instead.')
    ).toBeTruthy()
    expect(field.getAttribute('aria-describedby')).toBe(
      screen.getByText('Leave it empty to sign in with a code we email you instead.').id
    )
    // No requirements are listed for a password nobody is typing.
    expectAbsent(screen.queryByRole('list', { name: 'Password requirements' }))

    w.api.on(ROUTE.signUp, () => started('sign_up', CODE_STEP))
    await w.user.type(screen.getByLabelText('Email address'), EMAIL)
    await w.user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeTruthy()
    expect(w.api.calls(ROUTE.signUp)[0]?.body).toEqual({ email: EMAIL })
  })

  test('a password that is typed is sent and checked as usual', async () => {
    const w = world({ signUpPassword: 'optional' })
    w.mount(<SignUp />)
    const field = await screen.findByLabelText('Password (optional)')
    await w.user.type(field, 'sturdy-Otter-plays-42-chess')
    expect(await screen.findByText('10 or more characters')).toBeTruthy()
    w.api.on(ROUTE.signUp, () => started('sign_up', CODE_STEP))
    await w.user.type(screen.getByLabelText('Email address'), EMAIL)
    await w.user.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Check your email' })
    expect(w.api.calls(ROUTE.signUp)[0]?.body).toEqual({
      email: EMAIL,
      password: 'sturdy-Otter-plays-42-chess',
    })
  })

  test('where it is required, an empty password is still caught', async () => {
    const w = world()
    w.mount(<SignUp />)
    const field = (await screen.findByLabelText('Password')) as HTMLInputElement
    expect(field.required).toBe(true)
    await w.user.type(screen.getByLabelText('Email address'), EMAIL)
    await w.user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('This field is required.')).toBeTruthy()
    expect(w.api.calls(ROUTE.signUp)).toHaveLength(0)
  })
})

describe('<EmailLinkCallback>', () => {
  const ADDRESS = `${LINK_URL}#tula_link=l1nk-t0k3n&tula_attempt=attempt_1`

  function landing(options: { url?: string; signedIn?: boolean; binding?: boolean } = {}) {
    const storage = fakeLinkStorage()
    const timers = fakeTimers()
    const page = fakePage(options.url ?? ADDRESS)
    const w = world({ linkStorage: storage, timers, page, signedIn: options.signedIn })
    if (options.binding !== false) {
      storage.setItem(
        'tula.link.attempt_1',
        JSON.stringify({
          b: BINDING,
          e: 9_999_999_999_999,
          s: 'https://auth.test|tula_pk_dev_unit00000000000000000000000000',
        })
      )
    }
    return { w, storage, timers, page }
  }

  test('checks the link, takes it out of the address, and says “signed in” once the session is here', async () => {
    const { w, page, timers, storage } = landing()
    const navigate = mock()
    w.api.on(ROUTE.signInLink, () => json(200, { status: 'verified' }))
    w.mount(<EmailLinkCallback afterSignInUrl='/app' />, { navigate })
    expect(await screen.findByRole('heading', { level: 1, name: 'Signing you in…' })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('Checking your sign-in link.')

    await waitFor(() => expect(w.api.calls(ROUTE.signInLink)).toHaveLength(1))
    expect(w.api.calls(ROUTE.signInLink)[0]?.body).toEqual({
      token: 'l1nk-t0k3n',
      attemptId: 'attempt_1',
      binding: BINDING,
    })
    expect(page.current).toBe(LINK_URL)
    expect(storage.entries.size).toBe(0)

    // The tab that started the sign-in finishes it; this one finds the session in the cookie.
    w.api.on(ROUTE.refresh, () => json(200, sessionTokens('from_cookie')))
    await waitFor(() => expect(timers.pending()).toHaveLength(1))
    await act(async () => {
      timers.fire()
    })
    expect(await screen.findByRole('heading', { name: 'You are signed in.' })).toBeTruthy()
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/app'))
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(document.body.innerHTML).not.toContain('l1nk-t0k3n')
    expect(document.body.innerHTML).not.toContain(BINDING)
  })

  test('onComplete is called instead of navigating', async () => {
    const { w, timers } = landing()
    const onComplete = mock()
    const assign = spyOn(window.location, 'assign').mockImplementation(() => undefined)
    w.api.on(ROUTE.signInLink, () => json(200, { status: 'verified' }))
    w.mount(<EmailLinkCallback afterSignInUrl='/app' onComplete={onComplete} />)
    await waitFor(() => expect(w.api.calls(ROUTE.signInLink)).toHaveLength(1))
    w.api.on(ROUTE.refresh, () => json(200, sessionTokens('from_cookie')))
    await waitFor(() => expect(timers.pending()).toHaveLength(1))
    await act(async () => {
      timers.fire()
    })
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    expect(assign).not.toHaveBeenCalled()
  })

  test('accepted but not finished here: “continue in your other tab”, and signed in if that tab finishes later', async () => {
    const { w, timers } = landing()
    w.api.on(ROUTE.signInLink, () => json(200, { status: 'verified' }))
    w.mount(<EmailLinkCallback signInUrl='/sign-in' />)
    await waitFor(() => expect(timers.pending()).toHaveLength(1))
    await act(async () => {
      timers.fire()
    })
    const title = await screen.findByRole('heading', { name: 'Continue in your other tab' })
    await expectFocus(title)
    expect(screen.getByText(/Go back to the tab where you started signing in/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/sign-in')

    w.api.on(ROUTE.refresh, () => json(200, sessionTokens('late')))
    await act(async () => {
      await w.client.session.refresh()
    })
    expect(await screen.findByRole('heading', { name: 'You are signed in.' })).toBeTruthy()
  })

  test('opened in a browser that did not ask for it: says where to open it, and that the code works', async () => {
    const { w } = landing({ binding: false })
    w.api.on(ROUTE.signInLink, () => failure(409, 'verification.different_browser'))
    w.mount(<EmailLinkCallback signInUrl='/sign-in' />)
    const title = await screen.findByRole('heading', { name: 'Open this link where you started' })
    await expectFocus(title)
    expect(
      screen.getByText(/only works in the browser where you asked for it/).textContent
    ).toContain('enter the 6-digit code from the same email there')
    expect(w.api.calls(ROUTE.signInLink)[0]?.body).toEqual({
      token: 'l1nk-t0k3n',
      attemptId: 'attempt_1',
    })
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeTruthy()
    expect(w.client.state.status).not.toBe('signed-in')
  })

  test('a dead link says so', async () => {
    const { w } = landing()
    w.api.on(ROUTE.signInLink, () => failure(410, 'verification.expired'))
    w.mount(<EmailLinkCallback />)
    expect(await screen.findByRole('heading', { name: 'This link has expired' })).toBeTruthy()
    expect(screen.getByText(/works once, for ten minutes/)).toBeTruthy()
    // No sign-in page was given: no link is invented.
    expectAbsent(screen.queryByRole('link'))
  })

  test('an address with no link in it says so and sends nothing', async () => {
    const { w } = landing({ url: LINK_URL })
    w.mount(<EmailLinkCallback />)
    expect(await screen.findByRole('heading', { name: 'No sign-in link here' })).toBeTruthy()
    expect(w.api.calls(ROUTE.signInLink)).toHaveLength(0)
  })

  test('someone already signed in who lands without a link is sent on', async () => {
    const { w } = landing({ url: LINK_URL, signedIn: true })
    const navigate = mock()
    w.mount(<EmailLinkCallback afterSignInUrl='/app' />, { navigate })
    expect(await screen.findByRole('heading', { name: 'You are signed in.' })).toBeTruthy()
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/app'))
  })

  test('a failure to check the link shows the reason', async () => {
    const { w } = landing()
    w.api.on(ROUTE.signInLink, () => failure(429, 'rate_limited', {}, { 'retry-after': '30' }))
    w.mount(<EmailLinkCallback />)
    expect(
      await screen.findByRole('heading', { name: 'We could not check your link' })
    ).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('Too many requests')
  })

  test('a link that arrives by a fragment change alone (no page load) is checked and removed too', async () => {
    const { w, page } = landing({ url: LINK_URL, binding: false })
    w.mount(<EmailLinkCallback />)
    expect(await screen.findByRole('heading', { name: 'No sign-in link here' })).toBeTruthy()

    // Some other fragment: nothing is sent and the page stays as it is.
    page.current = `${LINK_URL}#section`
    await act(async () => {
      window.dispatchEvent(new Event('hashchange'))
    })
    expect(screen.getByRole('heading', { name: 'No sign-in link here' })).toBeTruthy()
    expect(w.api.calls(ROUTE.signInLink)).toHaveLength(0)

    // The link pasted into this tab's address bar.
    w.api.on(ROUTE.signInLink, () => failure(410, 'verification.expired'))
    page.current = ADDRESS
    await act(async () => {
      window.dispatchEvent(new Event('hashchange'))
    })
    expect(await screen.findByRole('heading', { name: 'This link has expired' })).toBeTruthy()
    expect(w.api.calls(ROUTE.signInLink)).toHaveLength(1)
    expect(page.current).toBe(LINK_URL)
  })

  test('once the page is gone, a fragment change does nothing', async () => {
    const { w, page } = landing({ url: LINK_URL })
    const view = w.mount(<EmailLinkCallback />)
    await screen.findByRole('heading', { name: 'No sign-in link here' })
    view.unmount()
    page.current = ADDRESS
    window.dispatchEvent(new Event('hashchange'))
    expect(w.api.calls(ROUTE.signInLink)).toHaveLength(0)
  })

  test('under StrictMode the link is still sent once', async () => {
    const { w } = landing()
    w.api.on(ROUTE.signInLink, () => failure(410, 'verification.expired'))
    render(
      <StrictMode>
        <TulaProvider client={w.client}>
          <EmailLinkCallback />
        </TulaProvider>
      </StrictMode>
    )
    expect(await screen.findByRole('heading', { name: 'This link has expired' })).toBeTruthy()
    expect(w.api.calls(ROUTE.signInLink)).toHaveLength(1)
  })

  test('the hook alone reports the outcome, for a page of the app’s own', async () => {
    const { w } = landing({ binding: false })
    w.api.on(ROUTE.signInLink, () => failure(409, 'verification.different_browser'))
    function Page() {
      const { status, error } = useEmailLinkCallback()
      return (
        <p>
          {status}:{String(error)}
        </p>
      )
    }
    w.mount(<Page />)
    expect(await screen.findByText('loading:null')).toBeTruthy()
    expect(await screen.findByText('different_browser:null')).toBeTruthy()
  })
})
