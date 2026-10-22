import { describe, expect, mock, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import { TulaProvider } from '@tula-tech/react'
import {
  completed,
  expectAbsent,
  expectFocus,
  ROUTE,
  started,
  world,
} from '../../react/src/testing/harness'
import { passwordSignInSuite } from '../test-support/sign-in.suite'
import { SignIn } from './sign-in'

// The registry's sign-in runs the same suite as the prebuilt `<SignIn>`
// (`src/prebuilt-sign-in.test.tsx`).
passwordSignInSuite('the registry sign-in', ({ onComplete, forgotPassword }) => (
  <SignIn onComplete={onComplete} onForgotPassword={forgotPassword ? () => undefined : undefined} />
))

describe('the registry sign-in: what the app configures', () => {
  test('"New here?" and "Forgot password?" are drawn only when the app gives a callback for them', async () => {
    const w = world()
    const switchToSignUp = mock()
    const forgot = mock()
    w.mount(<SignIn onSwitchToSignUp={switchToSignUp} onForgotPassword={forgot} />)
    await w.user.click(await screen.findByRole('button', { name: 'Create an account' }))
    expect(switchToSignUp).toHaveBeenCalledTimes(1)

    w.api.on(ROUTE.signIn, () => started('sign_in', { status: 'needs_password' }))
    await w.user.type(screen.getByLabelText('Email address'), 'maya@northline.app')
    await w.user.click(screen.getByRole('button', { name: 'Continue' }))
    await w.user.click(await screen.findByRole('button', { name: 'Forgot password?' }))
    expect(forgot).toHaveBeenCalledTimes(1)
  })

  test('without callbacks neither link is drawn', async () => {
    const w = world()
    w.mount(<SignIn />)
    await screen.findByRole('heading', { name: 'Sign in' })
    expectAbsent(screen.queryByRole('button', { name: 'Create an account' }))
    w.api.on(ROUTE.signIn, () => started('sign_in', { status: 'needs_password' }))
    await w.user.type(screen.getByLabelText('Email address'), 'maya@northline.app')
    await w.user.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByLabelText('Password')
    expectAbsent(screen.queryByRole('button', { name: 'Forgot password?' }))
  })

  test('the title is at the level the app asks for, and the first address is the one it gives', async () => {
    const w = world()
    w.mount(<SignIn headingLevel={2} initialEmail='first@northline.app' />)
    expect(await screen.findByRole('heading', { level: 2, name: 'Sign in' })).toBeTruthy()
    expect((screen.getByLabelText('Email address') as HTMLInputElement).value).toBe(
      'first@northline.app'
    )
  })

  test('the password can be shown and hidden, and the toggle says which it is', async () => {
    const w = world()
    w.mount(<SignIn />)
    w.api.on(ROUTE.signIn, () => started('sign_in', { status: 'needs_password' }))
    await w.user.type(await screen.findByLabelText('Email address'), 'maya@northline.app')
    await w.user.click(screen.getByRole('button', { name: 'Continue' }))
    const field = (await screen.findByLabelText('Password')) as HTMLInputElement
    const toggle = screen.getByRole('button', { name: 'Show password' })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    await w.user.click(toggle)
    expect(field.type).toBe('text')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    await w.user.click(toggle)
    expect(field.type).toBe('password')
  })

  test('an empty password is refused locally and sends nothing', async () => {
    const w = world()
    w.mount(<SignIn />)
    w.api.on(ROUTE.signIn, () => started('sign_in', { status: 'needs_password' }))
    await w.user.type(await screen.findByLabelText('Email address'), 'maya@northline.app')
    await w.user.click(screen.getByRole('button', { name: 'Continue' }))
    await w.user.click(await screen.findByRole('button', { name: 'Sign in' }))
    const field = screen.getByLabelText('Password')
    expect(field.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('alert').textContent).toBe('This field is required.')
    await expectFocus(field)
    expect(w.api.calls(ROUTE.signInPassword)).toHaveLength(0)
    await w.user.type(field, 'x')
    await waitFor(() => expectAbsent(screen.queryByRole('alert')))
  })

  test('the app is told once even when the callback changes while the request is in flight', async () => {
    const w = world()
    const first = mock()
    const second = mock()
    const view = w.mount(<SignIn onComplete={first} />)
    w.api.on(ROUTE.signIn, () => started('sign_in', { status: 'needs_password' }))
    await w.user.type(await screen.findByLabelText('Email address'), 'maya@northline.app')
    await w.user.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByLabelText('Password')
    let release: (response: Response) => void = () => undefined
    w.api.on(ROUTE.signInPassword, () => new Promise<Response>((resolve) => (release = resolve)))
    await w.user.type(screen.getByLabelText('Password'), 'sturdy-Otter-plays-42-chess{Enter}')
    view.rerender(
      <TulaProvider client={w.client}>
        <SignIn onComplete={second} />
      </TulaProvider>
    )
    release(await completed('sign_in'))
    await waitFor(() => expect(second).toHaveBeenCalledTimes(1))
    expect(first).not.toHaveBeenCalled()
  })
})
