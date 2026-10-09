import { afterEach, describe, expect, mock, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import {
  attempt,
  completed,
  expectAbsent,
  expectFocus,
  failure,
  ROUTE,
  started,
  type World,
  world,
} from '../testing/harness'
import { SignIn } from './sign-in'

// Signing in with a texted code (ADR 0037): the `sms_code` first factor.

const NUMBER = '+1 415 555 0142'
const EMAIL = 'maya@northline.app'
const FIELD = 'Email address or phone number'

afterEach(() => {
  mock.restore()
})

const choice = (strategies: string[], prepared = false) => ({
  status: 'needs_first_factor' as const,
  strategies,
  ...(prepared && { prepared: { strategy: 'sms_code', destination: '***42' } }),
})

/** A world whose environment signs in with a password or a texted code. */
const smsWorld = () => world({ methods: ['password', 'smsCode'] })

/** Type an identifier on the first screen and continue. */
async function begin(w: World, identifier: string, strategies = ['password', 'sms_code']) {
  w.api.on(ROUTE.signIn, () => started('sign_in', choice(strategies)))
  w.api.on(ROUTE.signInPrepare, () => attempt('sign_in', choice(strategies, true)))
  await w.user.type(await screen.findByLabelText(FIELD), identifier)
  await w.user.click(screen.getByRole('button', { name: 'Continue' }))
}

describe('<SignIn> with a texted code', () => {
  test('the first field takes a phone number where the environment signs in with one', async () => {
    const w = smsWorld()
    w.mount(<SignIn />)
    const field = (await screen.findByLabelText(FIELD)) as HTMLInputElement
    // A text field: a browser's own check of an email field would refuse a number.
    expect(field.type).toBe('text')
    expect(field.autocomplete).toBe('username')
    expect(
      screen.getByText('For a phone number, include the country code, for example +1 415 555 0142.')
    ).toBeTruthy()
  })

  test('without the method the first field is the email field it always was', async () => {
    const w = world()
    w.mount(<SignIn />)
    const field = (await screen.findByLabelText('Email address')) as HTMLInputElement
    expect(field.type).toBe('email')
    expectAbsent(screen.queryByLabelText(FIELD))
  })

  test('a number: nothing is texted until asked, then the code signs in', async () => {
    const w = smsWorld()
    const onComplete = mock()
    w.mount(<SignIn onComplete={onComplete} />)
    await begin(w, NUMBER)

    // The start carries what was typed; the server normalises it.
    expect(w.api.calls(ROUTE.signIn)[0]?.body).toEqual({ identifier: NUMBER })
    const ask = await screen.findByRole('heading', { name: 'Text me a code' })
    await expectFocus(ask)
    expect(screen.getByText(NUMBER)).toBeTruthy()
    // A message costs money: arriving here sends none.
    expect(w.api.calls(ROUTE.signInPrepare)).toHaveLength(0)
    // A password for a phone number signs nobody in: it is not among the other ways.
    expectAbsent(screen.queryByRole('list', { name: 'Other ways to sign in' }))

    await w.user.click(screen.getByRole('button', { name: 'Text me a code' }))
    const title = await screen.findByRole('heading', { name: 'Check your phone' })
    await expectFocus(title)
    expect(w.api.calls(ROUTE.signInPrepare)[0]?.body).toEqual({ strategy: 'sms_code' })
    // It never claims a message was sent: the server answers the same for any number.
    expect(
      screen.getByText(
        'If you can sign in with the number ending in 42, we texted it a 6-digit code. Enter it here.'
      )
    ).toBeTruthy()

    const field = screen.getByLabelText('Verification code') as HTMLInputElement
    expect(field.autocomplete).toBe('one-time-code')
    expect(field.inputMode).toBe('numeric')
    w.api.on(ROUTE.signInAttempt, () => completed('sign_in'))
    await w.user.type(field, '123 456')
    await w.user.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    const sent = w.api.calls(ROUTE.signInAttempt)[0]
    expect(sent?.body).toEqual({ strategy: 'sms_code', code: '123456' })
    expect(sent?.headers.get('x-tula-attempt')).toBe('tula_at_test_secret')
    expect(document.body.innerHTML).not.toContain('123456')
  })

  test('a code that does not sign in is said about the code, on the field, and retyped', async () => {
    const w = smsWorld()
    w.mount(<SignIn />)
    await begin(w, NUMBER)
    await w.user.click(await screen.findByRole('button', { name: 'Text me a code' }))
    const field = (await screen.findByLabelText('Verification code')) as HTMLInputElement
    w.api.on(ROUTE.signInAttempt, () => failure(401, 'auth.invalid_credentials'))
    await w.user.type(field, '000000')
    await w.user.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(field.getAttribute('aria-invalid')).toBe('true'))
    expect(screen.getByRole('alert').textContent).toBe(
      'That code did not sign you in. Check it, ask for a new one, or sign in another way.'
    )
    // Not the words of a password screen.
    expectAbsent(screen.queryByText(/email or password/i))
    await expectFocus(field)
    expect(field.value).toBe('')
  })

  test('an incomplete code is refused before any request', async () => {
    const w = smsWorld()
    w.mount(<SignIn />)
    await begin(w, NUMBER)
    await w.user.click(await screen.findByRole('button', { name: 'Text me a code' }))
    await w.user.type(await screen.findByLabelText('Verification code'), '123')
    await w.user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(w.api.calls(ROUTE.signInAttempt)).toHaveLength(0)
  })

  test('a new code can be asked for, and the wait the server sets is counted down', async () => {
    const w = smsWorld()
    w.mount(<SignIn />)
    await begin(w, NUMBER)
    await w.user.click(await screen.findByRole('button', { name: 'Text me a code' }))
    await screen.findByRole('heading', { name: 'Check your phone' })
    await w.user.click(screen.getByRole('button', { name: 'Text a new code' }))
    expect(
      await screen.findByText('If you can sign in with this number, a new code is on its way.')
    ).toBeTruthy()
    expect(w.api.calls(ROUTE.signInPrepare)).toHaveLength(2)

    w.api.on(ROUTE.signInPrepare, () => failure(429, 'rate_limited', {}, { 'retry-after': '42' }))
    await w.user.click(screen.getByRole('button', { name: 'Text a new code' }))
    const waiting = await screen.findByRole('button', { name: /Text a new code in/ })
    expect(waiting.getAttribute('aria-disabled')).toBe('true')
  })

  test('asking too soon on the first screen says so and keeps the button', async () => {
    const w = smsWorld()
    w.mount(<SignIn />)
    await begin(w, NUMBER)
    w.api.on(ROUTE.signInPrepare, () => failure(429, 'rate_limited', {}, { 'retry-after': '30' }))
    await w.user.click(await screen.findByRole('button', { name: 'Text me a code' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Text me a code' })).toBeTruthy()
  })

  test('where two-step verification must be set up first, the server’s words say to sign in another way', async () => {
    const w = smsWorld()
    w.mount(<SignIn />)
    await begin(w, NUMBER)
    await w.user.click(await screen.findByRole('button', { name: 'Text me a code' }))
    w.api.on(ROUTE.signInAttempt, () => failure(403, 'mfa.enrolment_needs_other_sign_in'))
    await w.user.type(await screen.findByLabelText('Verification code'), '123456')
    await w.user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Sign in another way to set up two-step verification.'
    )
    // "Change" leads back to the first screen, for an address.
    await w.user.click(screen.getByRole('button', { name: 'Change' }))
    expect(await screen.findByLabelText(FIELD)).toBeTruthy()
  })

  test('an address is never offered a texted code', async () => {
    const w = smsWorld()
    w.mount(<SignIn />)
    await begin(w, EMAIL)
    expect(await screen.findByLabelText('Password')).toBeTruthy()
    expectAbsent(screen.queryByRole('button', { name: 'Text me a code' }))
    expectAbsent(screen.queryByRole('list', { name: 'Other ways to sign in' }))
  })

  test('a number where no texted code is offered gets the forms there are', async () => {
    const w = smsWorld()
    w.mount(<SignIn />)
    await begin(w, NUMBER, ['password'])
    expect(await screen.findByLabelText('Password')).toBeTruthy()
  })

  test('a screen that comes back to an attempt already texted for opens on the code', async () => {
    const w = smsWorld()
    w.mount(<SignIn />)
    w.api.on(ROUTE.signIn, () => started('sign_in', choice(['password', 'sms_code'], true)))
    await w.user.type(await screen.findByLabelText(FIELD), NUMBER)
    await w.user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByRole('heading', { name: 'Check your phone' })).toBeTruthy()
  })
})

// What a client released before `sms_code` does with it: the strategy is one it has no form
// for, so it is skipped beside others and "not supported" alone. This version meets the
// same rule with a strategy of a server newer than itself.
describe('a strategy this version has no form for', () => {
  test('is skipped where another is offered, and is "not supported" where it is the only one', async () => {
    const w = smsWorld()
    w.mount(<SignIn />)
    await begin(w, NUMBER, ['voice_call'])
    expect(await screen.findByRole('heading', { name: 'This step is not supported' })).toBeTruthy()
    await w.user.click(screen.getByRole('button', { name: 'Start again' }))
    await begin(w, NUMBER, ['voice_call', 'password'])
    expect(await screen.findByLabelText('Password')).toBeTruthy()
  })
})
