import { afterEach, describe, expect, jest, mock, spyOn, test } from 'bun:test'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { isStepUpRequired } from '@tula/core'
import jsQR from 'jsqr'
import { StrictMode, useState } from 'react'
import { TulaProvider } from '../context'
import { useStepUp } from '../hooks/use-step-up'
import { useTula } from '../hooks/use-tula'
import {
  attempt,
  completed,
  expectFocus,
  failure,
  json,
  NEW_PASSWORD_STEP,
  openDialogs,
  ROUTE,
  sessionTokens,
  started,
  type World,
  world,
} from '../testing/harness'
import { SignedIn, SignedOut } from './control'
import { BACKUP_CODES_URL_LIFETIME_MS } from './mfa'
import { SignIn } from './sign-in'
import { SignUp } from './sign-up'
import { UserProfile } from './user-profile'

const EMAIL = 'maya@northline.app'
const PASSWORD = 'sturdy-Otter-plays-42-chess'
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
const URI = `otpauth://totp/Northline:maya%40northline.app?secret=${SECRET}&issuer=Northline&algorithm=SHA1&digits=6&period=30`
const CODES = [
  'abcde-fghjk',
  'mnpqr-stuvw',
  'xyz23-45678',
  '9abcd-efghj',
  'kmnpq-rstuv',
  'wxyz2-34567',
  '89abc-defgh',
  'jkmnp-qrstu',
  'vwxyz-23456',
  '789ab-cdefg',
]
const MFA = {
  factors: 'GET /v1/client/me/factors',
  start: 'POST /v1/client/me/factors/totp',
  confirm: 'POST /v1/client/me/factors/totp/confirm',
  disable: 'DELETE /v1/client/me/factors/totp',
  codes: 'POST /v1/client/me/factors/backup-codes',
  stepUp: 'POST /v1/client/sessions/step-up',
  signInSecond: 'POST /v1/client/sign-ins/attempt_1/second-factor',
  resetSecond: 'POST /v1/client/password-resets/attempt_1/second-factor',
  signInEnrol: 'POST /v1/client/sign-ins/attempt_1/factor-enrolment/totp',
  signInEnrolConfirm: 'POST /v1/client/sign-ins/attempt_1/factor-enrolment/totp/confirm',
  signUpEnrol: 'POST /v1/client/sign-ups/attempt_1/factor-enrolment/totp',
  signUpEnrolConfirm: 'POST /v1/client/sign-ups/attempt_1/factor-enrolment/totp/confirm',
} as const
const SECOND_FACTOR = { status: 'needs_second_factor', options: ['totp', 'backup_code'] }
const ENROLMENT = { status: 'needs_factor_enrolment', methods: ['totp'] }
const stepUpRequired = (methods: string) =>
  failure(403, 'auth.step_up_required', { params: { methods } })

afterEach(() => {
  jest.useRealTimers()
  mock.restore()
})

/** Everything on the page as text and markup: what a secret must not be left in. */
const page = () => document.body.innerHTML

/** Sign in up to the answer the password gets. */
async function passwordAnswers(w: World, answer: () => Response) {
  w.api.on(ROUTE.signIn, () => started('sign_in', { status: 'needs_password' }))
  w.api.on(ROUTE.signInPassword, answer)
  await w.user.type(await screen.findByLabelText('Email address'), EMAIL)
  await w.user.click(screen.getByRole('button', { name: 'Continue' }))
  await w.user.type(await screen.findByLabelText('Password'), PASSWORD)
  await w.user.click(screen.getByRole('button', { name: 'Sign in' }))
}

describe('<SignIn> at needs_second_factor', () => {
  // Three tests, not one: each signs in to get here, and one test that did it three times
  // came within a second of the runner's limit.
  test('asks for the authenticator code, and refuses one that is too short without sending it', async () => {
    const w = world()
    w.mount(<SignIn />)
    await passwordAnswers(w, () => attempt('sign_in', SECOND_FACTOR))
    const title = await screen.findByRole('heading', { name: 'Two-step verification' })
    await expectFocus(title)
    const field = screen.getByLabelText('Authentication code') as HTMLInputElement
    expect(field.autocomplete).toBe('one-time-code')
    expect(field.inputMode).toBe('numeric')

    await w.user.type(field, '123')
    await w.user.click(screen.getByRole('button', { name: 'Verify' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Enter the 6-digit code.')
    expect(w.api.calls(MFA.signInSecond)).toHaveLength(0)
  })

  test('a wrong authenticator code is refused in the field, which is emptied and takes the focus', async () => {
    const w = world()
    w.mount(<SignIn />)
    await passwordAnswers(w, () => attempt('sign_in', SECOND_FACTOR))
    await screen.findByRole('heading', { name: 'Two-step verification' })
    const field = screen.getByLabelText('Authentication code') as HTMLInputElement

    w.api.on(MFA.signInSecond, () => failure(422, 'mfa.invalid_code'))
    await w.user.type(field, '111 111')
    await w.user.click(screen.getByRole('button', { name: 'Verify' }))
    await waitFor(() => expect(field.getAttribute('aria-invalid')).toBe('true'))
    // A wrong code is retyped from scratch, and the field takes the focus.
    expect(field.value).toBe('')
    await expectFocus(field)
    expect(w.api.calls(MFA.signInSecond)[0]?.body).toEqual({ method: 'totp', code: '111111' })
  })

  test('the right authenticator code completes the sign-in', async () => {
    const w = world()
    const onComplete = mock()
    w.mount(<SignIn onComplete={onComplete} />)
    await passwordAnswers(w, () => attempt('sign_in', SECOND_FACTOR))
    await screen.findByRole('heading', { name: 'Two-step verification' })
    const field = screen.getByLabelText('Authentication code') as HTMLInputElement

    w.api.on(MFA.signInSecond, () => completed('sign_in'))
    await w.user.type(field, '222222')
    await w.user.click(screen.getByRole('button', { name: 'Verify' }))
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    expect(onComplete).toHaveBeenCalledWith({ userId: 'user_1', sessionId: 'session_1' })
  })

  test('"Use a backup code" switches the form, and back; a backup code is sent as typed', async () => {
    const w = world()
    const onComplete = mock()
    w.mount(<SignIn onComplete={onComplete} />)
    await passwordAnswers(w, () => attempt('sign_in', SECOND_FACTOR))
    await w.user.click(await screen.findByRole('button', { name: 'Use a backup code' }))
    const field = screen.getByLabelText('Backup code') as HTMLInputElement
    expect(screen.queryByLabelText('Authentication code')).toBeNull()
    // The new field takes the focus: it is where the user types next.
    await expectFocus(field)
    await w.user.click(screen.getByRole('button', { name: 'Verify' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Enter a backup code.')

    await w.user.click(screen.getByRole('button', { name: 'Use your authenticator app' }))
    expect(screen.getByLabelText('Authentication code')).toBeTruthy()
    await w.user.click(screen.getByRole('button', { name: 'Use a backup code' }))

    w.api.on(MFA.signInSecond, () =>
      attempt(
        'sign_in',
        { status: 'complete', userId: 'user_1', sessionId: 'session_1' },
        { session: sessionTokens('signed_in'), backupCodesRemaining: 9 }
      )
    )
    await w.user.type(screen.getByLabelText('Backup code'), ' ABCDE fghjk ')
    await w.user.click(screen.getByRole('button', { name: 'Verify' }))
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    expect(w.api.calls(MFA.signInSecond)[0]?.body).toEqual({
      method: 'backup_code',
      code: 'ABCDE fghjk',
    })
    expect(field.isConnected).toBe(false)
  })

  test('a lockout is counted down and the form refuses to send meanwhile', async () => {
    const w = world()
    w.mount(<SignIn />)
    await passwordAnswers(w, () => attempt('sign_in', SECOND_FACTOR))
    w.api.on(MFA.signInSecond, () =>
      failure(429, 'rate_limited', { params: { retryAfter: 30 } }, { 'retry-after': '30' })
    )
    await w.user.type(await screen.findByLabelText('Authentication code'), '123456')
    await w.user.click(screen.getByRole('button', { name: 'Verify' }))
    expect(await screen.findByText(/Try again in \d+s\./)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Verify' }).getAttribute('aria-disabled')).toBe(
      'true'
    )
    await w.user.type(screen.getByLabelText('Authentication code'), '123456')
    await w.user.click(screen.getByRole('button', { name: 'Verify' }))
    expect(w.api.calls(MFA.signInSecond)).toHaveLength(1)
  })

  test('only the options the step offers are drawn; "Back to sign in" starts again', async () => {
    const w = world()
    w.mount(<SignIn />)
    await passwordAnswers(w, () =>
      attempt('sign_in', { status: 'needs_second_factor', options: ['totp', 'sms_code'] })
    )
    await screen.findByLabelText('Authentication code')
    expect(screen.queryByRole('button', { name: 'Use a backup code' })).toBeNull()
    await w.user.click(screen.getByRole('button', { name: 'Back to sign in' }))
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy()
  })

  test('a password reset that stops at the second factor uses the reset route', async () => {
    const w = world()
    const onComplete = mock()
    w.mount(<SignIn onComplete={onComplete} />)
    await w.user.click(await screen.findByRole('button', { name: 'Continue' })).catch(() => {})
    w.api.on(ROUTE.signIn, () => started('sign_in', { status: 'needs_password' }))
    await w.user.type(screen.getByLabelText('Email address'), EMAIL)
    await w.user.click(screen.getByRole('button', { name: 'Continue' }))
    await w.user.click(await screen.findByRole('button', { name: 'Forgot password?' }))
    w.api.on(ROUTE.reset, () => started('password_reset', NEW_PASSWORD_STEP))
    await w.user.click(await screen.findByRole('button', { name: 'Send code' }))
    w.api.on(ROUTE.resetSubmit, () => attempt('password_reset', SECOND_FACTOR))
    await w.user.type(await screen.findByLabelText('Verification code'), '123456')
    await w.user.type(screen.getByLabelText('New password'), PASSWORD)
    await w.user.click(screen.getByRole('button', { name: 'Reset password' }))

    w.api.on(MFA.resetSecond, () => completed('password_reset'))
    await w.user.type(await screen.findByLabelText('Authentication code'), '123456')
    await w.user.click(screen.getByRole('button', { name: 'Verify' }))
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    expect(w.api.calls(MFA.resetSecond)).toHaveLength(1)
  })
})

/** Rasterise the page's QR code and read it with a real decoder. */
function decodeQr(): string | undefined {
  const svg = screen.getByRole('img', { name: /QR code for your authenticator app/ })
  const [min, , side] = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number) as [
    number,
    number,
    number,
  ]
  expect(svg.querySelector('rect')?.getAttribute('fill')).toBe('#fff')
  const dark = new Set<string>()
  const d = svg.querySelector('path')?.getAttribute('d') ?? ''
  for (const [, x, y, width] of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    for (let column = 0; column < Number(width); column++) {
      dark.add(`${Number(x) + column},${y}`)
    }
  }
  const scale = 4
  const pixels = side * scale
  const data = new Uint8ClampedArray(pixels * pixels * 4).fill(255)
  for (let py = 0; py < pixels; py++) {
    for (let px = 0; px < pixels; px++) {
      if (dark.has(`${Math.floor(px / scale) + min},${Math.floor(py / scale) + min}`)) {
        data.fill(0, (py * pixels + px) * 4, (py * pixels + px) * 4 + 3)
      }
    }
  }
  // The quiet zone the standard asks for is part of the drawing.
  expect(min).toBe(-4)
  return jsQR(data, pixels, pixels)?.data
}

describe('<SignIn> at needs_factor_enrolment', () => {
  test('sets up an authenticator, shows the codes above an app that has moved on, and completes only once they are saved', async () => {
    const w = world()
    const onComplete = mock()
    w.mount(
      <StrictMode>
        <SignedOut>
          <SignIn onComplete={onComplete} />
        </SignedOut>
        <SignedIn>
          <p>The app’s home page</p>
        </SignedIn>
      </StrictMode>
    )
    await passwordAnswers(w, () => attempt('sign_in', ENROLMENT))
    expect(
      await screen.findByRole('heading', { name: 'Set up two-step verification' })
    ).toBeTruthy()
    expect(screen.getByText(/This app requires two-step verification/)).toBeTruthy()
    // Nothing is asked of the server until the user says so.
    expect(w.api.calls(MFA.signInEnrol)).toHaveLength(0)

    w.api.on(MFA.signInEnrol, () => json(200, { secret: SECRET, uri: URI }))
    await w.user.click(screen.getByRole('button', { name: 'Set up authenticator app' }))
    // The setup key, in groups of four, labelled; and a QR code a phone reads the URI from.
    const key = await screen.findByRole('group', { name: 'Setup key' })
    expect(within(key).getByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toBeTruthy()
    await waitFor(() => expect(decodeQr()).toBe(URI))
    expect(w.api.calls(MFA.signInEnrol)).toHaveLength(1)

    w.api.on(MFA.signInEnrolConfirm, () => failure(422, 'mfa.invalid_code'))
    await w.user.type(screen.getByLabelText('Authentication code'), '000000')
    await w.user.click(screen.getByRole('button', { name: 'Turn on' }))
    await waitFor(() =>
      expect(screen.getByLabelText('Authentication code').getAttribute('aria-invalid')).toBe('true')
    )

    w.api.on(MFA.signInEnrolConfirm, () =>
      attempt(
        'sign_in',
        { status: 'complete', userId: 'user_1', sessionId: 'session_1' },
        { session: sessionTokens('signed_in'), backupCodes: CODES }
      )
    )
    await w.user.type(screen.getByLabelText('Authentication code'), '123456')
    await w.user.click(screen.getByRole('button', { name: 'Turn on' }))

    // The client is signed in and the app has taken the sign-in page away; the codes are
    // still shown, in a modal dialog of the provider's.
    const dialog = await screen.findByRole('dialog', { name: 'Save your backup codes' })
    expect(await screen.findByText('The app’s home page')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Set up two-step verification' })).toBeNull()
    const list = within(dialog).getByRole('list', { name: 'Backup codes' })
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent)
    ).toEqual(CODES)
    // The secret went with the screen that showed it.
    expect(page()).not.toContain('JBSW')
    expect(onComplete).not.toHaveBeenCalled()

    // Leaving needs an explicit "I saved them".
    await w.user.click(within(dialog).getByRole('button', { name: 'Done' }))
    expect(within(dialog).getByRole('alert').textContent).toBe(
      'Confirm that you have saved the codes.'
    )
    const saved = within(dialog).getByLabelText('I have saved these codes')
    await expectFocus(saved)
    expect(onComplete).not.toHaveBeenCalled()
    await w.user.click(saved)
    await w.user.click(within(dialog).getByRole('button', { name: 'Done' }))

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('dialog')).toBeNull()
    // Nothing of the codes is left anywhere on the page.
    for (const code of CODES) {
      expect(page()).not.toContain(code)
    }
  })

  test('"Cancel" drops the secret; a failed start says why', async () => {
    const w = world()
    w.mount(<SignIn />)
    await passwordAnswers(w, () => attempt('sign_in', ENROLMENT))
    w.api.on(MFA.signInEnrol, () => failure(403, 'mfa.not_available'))
    await w.user.click(await screen.findByRole('button', { name: 'Set up authenticator app' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Two-step verification is not available for this app.'
    )

    w.api.on(MFA.signInEnrol, () => json(200, { secret: SECRET, uri: URI }))
    await w.user.click(screen.getByRole('button', { name: 'Set up authenticator app' }))
    await screen.findByRole('group', { name: 'Setup key' })
    await w.user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('group', { name: 'Setup key' })).toBeNull()
    expect(page()).not.toContain('JBSW')
  })
})

describe('<SignUp> at needs_factor_enrolment', () => {
  test('a new account enrols before it completes', async () => {
    const w = world()
    const onComplete = mock()
    w.mount(<SignUp onComplete={onComplete} />)
    w.api.on(ROUTE.signUp, () => started('sign_up', ENROLMENT))
    await w.user.type(await screen.findByLabelText('Email address'), EMAIL)
    await w.user.type(screen.getByLabelText('Password'), PASSWORD)
    await w.user.click(screen.getByRole('button', { name: 'Continue' }))

    w.api.on(MFA.signUpEnrol, () => json(200, { secret: SECRET, uri: URI }))
    await w.user.click(await screen.findByRole('button', { name: 'Set up authenticator app' }))
    w.api.on(MFA.signUpEnrolConfirm, () =>
      attempt(
        'sign_up',
        { status: 'complete', userId: 'user_1', sessionId: 'session_1' },
        { session: sessionTokens('signed_in'), backupCodes: CODES }
      )
    )
    await w.user.type(await screen.findByLabelText('Authentication code'), '123456')
    await w.user.click(screen.getByRole('button', { name: 'Turn on' }))
    const dialog = await screen.findByRole('dialog', { name: 'Save your backup codes' })
    await w.user.click(within(dialog).getByLabelText('I have saved these codes'))
    await w.user.click(within(dialog).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
  })
})

/** A signed-in world whose user has, or has not, two-step verification on. */
function profileWorld(options: { enabled: boolean; policy?: 'off' | 'optional' | 'required' }) {
  const w = world({ signedIn: true, mfaPolicy: options.policy ?? 'optional' })
  const state = { enabled: options.enabled, remaining: options.enabled ? 10 : 0 }
  w.api.on(ROUTE.sessions, () => json(200, { data: [] }))
  w.api.on(MFA.factors, () =>
    json(200, {
      totp: {
        enabled: state.enabled,
        confirmedAt: state.enabled ? '2026-10-03T10:00:00.000Z' : null,
      },
      backupCodes: { remaining: state.remaining },
    })
  )
  return { w, state }
}

const section = async () =>
  (await screen.findByRole('heading', { name: 'Two-step verification' })).closest(
    'section'
  ) as HTMLElement

describe('<UserProfile> two-step verification', () => {
  test('turning it on: step-up with the password, QR and key, the code, then the backup codes', async () => {
    const { w, state } = profileWorld({ enabled: false })
    w.mount(<UserProfile />)
    const mfa = await section()
    expect(await within(mfa).findByText(/^Off\./)).toBeTruthy()

    // The server asks for a step-up first; the provider's dialog collects the password.
    let stepped = false
    w.api.on(MFA.start, () =>
      stepped ? json(200, { secret: SECRET, uri: URI }) : stepUpRequired('password')
    )
    w.api.on(MFA.stepUp, () => failure(401, 'auth.invalid_credentials'))
    await w.user.click(within(mfa).getByRole('button', { name: 'Turn on' }))
    const dialog = await screen.findByRole('dialog', { name: 'Confirm it is you' })
    const password = within(dialog).getByLabelText('Password') as HTMLInputElement
    await w.user.click(within(dialog).getByRole('button', { name: 'Continue' }))
    expect(within(dialog).getByRole('alert').textContent).toBe('This field is required.')
    await w.user.type(password, 'wrong password')
    await w.user.click(within(dialog).getByRole('button', { name: 'Continue' }))
    expect(await within(dialog).findByText('That password is incorrect.')).toBeTruthy()
    expect(password.value).toBe('')

    w.api.on(MFA.stepUp, () => {
      stepped = true
      return json(200, sessionTokens('stepped_up'))
    })
    await w.user.type(password, PASSWORD)
    await w.user.click(within(dialog).getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(w.api.calls(MFA.stepUp).at(-1)?.body).toEqual({ method: 'password', password: PASSWORD })
    // The action was retried once, with the stepped-up token.
    expect(w.api.calls(MFA.start)).toHaveLength(2)

    await within(mfa).findByRole('group', { name: 'Setup key' })
    await waitFor(() => expect(decodeQr()).toBe(URI))
    w.api.on(MFA.confirm, () => failure(422, 'mfa.invalid_code'))
    await w.user.type(within(mfa).getByLabelText('Authentication code'), '000000')
    await w.user.click(within(mfa).getByRole('button', { name: 'Turn on' }))
    await waitFor(() =>
      expect(within(mfa).getByLabelText('Authentication code').getAttribute('aria-invalid')).toBe(
        'true'
      )
    )

    w.api.on(MFA.confirm, () => {
      state.enabled = true
      state.remaining = 10
      return json(200, { codes: CODES })
    })
    await w.user.type(within(mfa).getByLabelText('Authentication code'), '123456')
    await w.user.click(within(mfa).getByRole('button', { name: 'Turn on' }))
    const list = await within(mfa).findByRole('list', { name: 'Backup codes' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(10)
    expect(page()).not.toContain('JBSW')

    await w.user.click(within(mfa).getByLabelText('I have saved these codes'))
    await w.user.click(within(mfa).getByRole('button', { name: 'Done' }))
    expect(await within(mfa).findByText(/^On since /)).toBeTruthy()
    expect(within(mfa).getByText('10 backup codes left.')).toBeTruthy()
    expect(within(mfa).getByText('Two-step verification is on.')).toBeTruthy()
    for (const code of CODES) {
      expect(page()).not.toContain(code)
    }
  })

  test('copy and download hand the codes to the user and nowhere else', async () => {
    const { w } = profileWorld({ enabled: true })
    w.mount(<UserProfile />)
    const mfa = await section()
    w.api.on(MFA.codes, () => json(200, { codes: CODES }))
    await w.user.click(await within(mfa).findByRole('button', { name: 'New backup codes' }))
    await within(mfa).findByRole('list', { name: 'Backup codes' })

    const written: string[] = []
    spyOn(navigator.clipboard, 'writeText').mockImplementation(async (text) => {
      written.push(text)
    })
    await w.user.click(within(mfa).getByRole('button', { name: 'Copy' }))
    expect(await within(mfa).findByText('Copied.')).toBeTruthy()
    expect(written).toEqual([`${CODES.join('\n')}\n`])

    spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))
    await w.user.click(within(mfa).getByRole('button', { name: 'Copy' }))
    expect(await within(mfa).findByText(/Could not copy/)).toBeTruthy()

    const blobs: Blob[] = []
    const create = spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      blobs.push(blob as Blob)
      return 'blob:codes'
    })
    const revoke = spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const clicked: { href: string; download: string }[] = []
    spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      clicked.push({ href: this.href, download: this.download })
    })
    await w.user.click(within(mfa).getByRole('button', { name: 'Download' }))
    expect(create).toHaveBeenCalledTimes(1)
    expect(await blobs[0]?.text()).toBe(`${CODES.join('\n')}\n`)
    expect(clicked).toEqual([{ href: 'blob:codes', download: 'backup-codes.txt' }])
    // Not yet: see "the downloaded file's URL outlives the click".
    expect(revoke).not.toHaveBeenCalled()

    await w.user.click(within(mfa).getByLabelText('I have saved these codes'))
    await w.user.click(within(mfa).getByRole('button', { name: 'Done' }))
    expect(await within(mfa).findByText('Your earlier backup codes no longer work.')).toBeTruthy()
  })

  /** Open the backup codes in the profile and spy on everything a download touches. */
  async function codesWithDownloadSpies() {
    const { w } = profileWorld({ enabled: true })
    const view = w.mount(<UserProfile />)
    const mfa = await section()
    w.api.on(MFA.codes, () => json(200, { codes: CODES }))
    await w.user.click(await within(mfa).findByRole('button', { name: 'New backup codes' }))
    await within(mfa).findByRole('list', { name: 'Backup codes' })
    spyOn(URL, 'createObjectURL').mockReturnValue('blob:codes')
    const revoke = spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    // Whether the link was in the document at the moment it was clicked.
    const attached: boolean[] = []
    spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      attached.push(this.isConnected)
    })
    // From here on the test owns the clock: the download's one timer fires when it says so.
    jest.useFakeTimers()
    return { view, mfa, revoke, attached }
  }

  test('the downloaded file’s URL outlives the click: the link is in the document when clicked, and the URL is revoked only later', async () => {
    const { mfa, revoke, attached } = await codesWithDownloadSpies()
    fireEvent.click(within(mfa).getByRole('button', { name: 'Download' }))
    // A browser that resolves blob URLs asynchronously (Safari) would otherwise save an empty
    // file, and these codes are shown once.
    expect(attached).toEqual([true])
    expect(revoke).not.toHaveBeenCalled()
    // The link does not stay on the page.
    expect(document.querySelector('a[download]')).toBeNull()
    jest.advanceTimersByTime(BACKUP_CODES_URL_LIFETIME_MS - 1)
    expect(revoke).not.toHaveBeenCalled()
    jest.advanceTimersByTime(1)
    expect(revoke.mock.calls).toEqual([['blob:codes']])
    // Never twice.
    jest.advanceTimersByTime(BACKUP_CODES_URL_LIFETIME_MS)
    expect(revoke).toHaveBeenCalledTimes(1)
  })

  test('leaving the screen before the delay has passed revokes the URL then, once', async () => {
    const { view, mfa, revoke } = await codesWithDownloadSpies()
    fireEvent.click(within(mfa).getByRole('button', { name: 'Download' }))
    jest.advanceTimersByTime(1_000)
    expect(revoke).not.toHaveBeenCalled()
    view.unmount()
    expect(revoke.mock.calls).toEqual([['blob:codes']])
    jest.advanceTimersByTime(BACKUP_CODES_URL_LIFETIME_MS)
    expect(revoke).toHaveBeenCalledTimes(1)
  })

  test('turning it off: step-up with the authenticator or a backup code, never the password', async () => {
    const { w, state } = profileWorld({ enabled: true })
    w.mount(<UserProfile />)
    const mfa = await section()
    let stepped = false
    w.api.on(MFA.disable, () => {
      if (!stepped) {
        return stepUpRequired('totp,backup_code')
      }
      state.enabled = false
      return new Response(null, { status: 204 })
    })
    await w.user.click(await within(mfa).findByRole('button', { name: 'Turn off' }))
    const dialog = await screen.findByRole('dialog', { name: 'Confirm it is you' })
    expect(within(dialog).queryByLabelText('Password')).toBeNull()
    const field = within(dialog).getByLabelText('Authentication code')
    // A modal dialog opens on the field it is for.
    await expectFocus(field)

    w.api.on(MFA.stepUp, () => failure(422, 'mfa.invalid_code'))
    await w.user.type(field, '000000')
    await w.user.click(within(dialog).getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(field.getAttribute('aria-invalid')).toBe('true'))

    await w.user.click(within(dialog).getByRole('button', { name: 'Use a backup code' }))
    w.api.on(MFA.stepUp, () => {
      stepped = true
      return json(200, sessionTokens('stepped_up'))
    })
    await w.user.type(within(dialog).getByLabelText('Backup code'), CODES[0] as string)
    await w.user.click(within(dialog).getByRole('button', { name: 'Continue' }))
    expect(await within(mfa).findByText('Two-step verification is off.')).toBeTruthy()
    expect(w.api.calls(MFA.stepUp).at(-1)?.body).toEqual({ method: 'backup_code', code: CODES[0] })
    expect(within(mfa).getByRole('button', { name: 'Turn on' })).toBeTruthy()
    expect(page()).not.toContain(CODES[0] as string)
  })

  test('a step-up the user cancels changes nothing and shows no error', async () => {
    const { w } = profileWorld({ enabled: true })
    w.mount(<UserProfile />)
    const mfa = await section()
    w.api.on(MFA.disable, () => stepUpRequired('totp'))
    await w.user.click(await within(mfa).findByRole('button', { name: 'Turn off' }))
    const dialog = await screen.findByRole('dialog', { name: 'Confirm it is you' })
    await w.user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(within(mfa).queryByRole('alert')).toBeNull()
    expect(w.api.calls(MFA.disable)).toHaveLength(1)
    expect(within(mfa).getByRole('button', { name: 'Turn off' })).toBeTruthy()
  })

  test('a user with no way to step up is told to sign in again', async () => {
    const { w } = profileWorld({ enabled: false })
    w.mount(<UserProfile />)
    const mfa = await section()
    w.api.on(MFA.start, () => stepUpRequired(''))
    await w.user.click(await within(mfa).findByRole('button', { name: 'Turn on' }))
    const dialog = await screen.findByRole('dialog', { name: 'Confirm it is you' })
    expect(within(dialog).getByText(/sign out and sign in again/)).toBeTruthy()
    await w.user.click(within(dialog).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
  })

  test('another failure is shown in the section', async () => {
    const { w } = profileWorld({ enabled: true })
    w.mount(<UserProfile />)
    const mfa = await section()
    w.api.on(MFA.codes, () => failure(409, 'mfa.not_enabled'))
    await w.user.click(await within(mfa).findByRole('button', { name: 'New backup codes' }))
    expect((await within(mfa).findByRole('alert')).textContent).toBe(
      'Two-step verification is not on for this account.'
    )
  })

  test('required by the app: it cannot be turned off, and the section says why', async () => {
    const { w, state } = profileWorld({ enabled: true, policy: 'required' })
    state.remaining = 1
    w.mount(<UserProfile />)
    const mfa = await section()
    expect(await within(mfa).findByText(/cannot be turned off/)).toBeTruthy()
    expect(within(mfa).queryByRole('button', { name: 'Turn off' })).toBeNull()
    expect(within(mfa).getByText('1 backup code left.')).toBeTruthy()
  })

  test.each<[string, 'off' | undefined, boolean, boolean]>([
    ['off and not enrolled: hidden', 'off', false, false],
    ['off but still enrolled: shown, so it can be turned off', 'off', true, true],
    ['a server that says nothing about it: hidden, and never asked', undefined, false, false],
  ])('%s', async (_name, policy, enabled, shown) => {
    const w = world({ signedIn: true, mfaPolicy: policy })
    w.api.on(ROUTE.sessions, () => json(200, { data: [] }))
    w.api.on(MFA.factors, () =>
      json(200, {
        totp: { enabled, confirmedAt: enabled ? '2026-10-03T10:00:00.000Z' : null },
        backupCodes: { remaining: enabled ? 10 : 0 },
      })
    )
    w.mount(<UserProfile />)
    await screen.findByRole('heading', { name: 'Where you’re signed in' })
    await waitFor(() => expect(w.api.calls(MFA.factors).length).toBe(policy === undefined ? 0 : 1))
    if (shown) {
      expect(await screen.findByRole('button', { name: 'Turn off' })).toBeTruthy()
    } else {
      await waitFor(() =>
        expect(screen.queryAllByRole('heading', { name: 'Two-step verification' }).length).toBe(0)
      )
    }
  })

  test('changing the password asks a user with two-step verification for it first', async () => {
    const { w } = profileWorld({ enabled: true })
    w.mount(<UserProfile />)
    let stepped = false
    w.api.on(ROUTE.changePassword, () =>
      stepped ? new Response(null, { status: 204 }) : stepUpRequired('totp')
    )
    w.api.on(MFA.stepUp, () => {
      stepped = true
      return json(200, sessionTokens('stepped_up'))
    })
    await w.user.type(await screen.findByLabelText('Current password'), PASSWORD)
    await w.user.type(screen.getByLabelText('New password'), `${PASSWORD}-new`)
    await w.user.click(screen.getByRole('button', { name: 'Update password' }))
    const dialog = await screen.findByRole('dialog', { name: 'Confirm it is you' })
    await w.user.type(within(dialog).getByLabelText('Authentication code'), '123456')
    await w.user.click(within(dialog).getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText(/^Your password was changed\./)).toBeTruthy()
    expect(w.api.calls(ROUTE.changePassword)).toHaveLength(2)
  })
})

describe('useStepUp', () => {
  function Sensitive(props: { onResult(result: string): void }) {
    const tula = useTula()
    const withStepUp = useStepUp()
    const [busy, setBusy] = useState(false)
    const act = async () => {
      setBusy(true)
      try {
        const { codes } = await withStepUp(() => tula.mfa.regenerateBackupCodes())
        props.onResult(`codes:${codes.length}`)
      } catch (error) {
        props.onResult(isStepUpRequired(error) ? 'declined' : 'failed')
      }
      setBusy(false)
    }
    return (
      <button type='button' onClick={act} disabled={busy}>
        Renew
      </button>
    )
  }

  test('an action that needs no step-up runs once and opens nothing', async () => {
    const w = world({ signedIn: true })
    const onResult = mock()
    w.api.on(MFA.codes, () => json(200, { codes: CODES }))
    w.mount(<Sensitive onResult={onResult} />)
    await waitFor(() => expect(w.client.state.status).toBe('signed-in'))
    await w.user.click(screen.getByRole('button', { name: 'Renew' }))
    await waitFor(() => expect(onResult).toHaveBeenCalledWith('codes:10'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(w.api.calls(MFA.codes)).toHaveLength(1)
  })

  test('the action is retried once: a second refusal is the caller’s to handle', async () => {
    const w = world({ signedIn: true })
    const onResult = mock()
    w.api.on(MFA.codes, () => stepUpRequired('totp'))
    w.api.on(MFA.stepUp, () => json(200, sessionTokens('stepped_up')))
    w.mount(<Sensitive onResult={onResult} />)
    await waitFor(() => expect(w.client.state.status).toBe('signed-in'))
    await w.user.click(screen.getByRole('button', { name: 'Renew' }))
    const dialog = await screen.findByRole('dialog', { name: 'Confirm it is you' })
    await w.user.type(within(dialog).getByLabelText('Authentication code'), '123456')
    await w.user.click(within(dialog).getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(onResult).toHaveBeenCalledWith('declined'))
    expect(w.api.calls(MFA.codes)).toHaveLength(2)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('Escape closes the dialog as a cancel; a sign-out underneath closes it too', async () => {
    const w = world({ signedIn: true })
    const onResult = mock()
    w.api.on(MFA.codes, () => stepUpRequired('totp'))
    w.mount(<Sensitive onResult={onResult} />)
    await waitFor(() => expect(w.client.state.status).toBe('signed-in'))
    await w.user.click(screen.getByRole('button', { name: 'Renew' }))
    const dialog = await screen.findByRole('dialog', { name: 'Confirm it is you' })
    // What the browser sends a modal dialog on Escape. Through `fireEvent`, so that React
    // has drawn what follows from it before the next line runs.
    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    await waitFor(() => expect(onResult).toHaveBeenCalledWith('declined'))
    expect(onResult).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(openDialogs()).toBe(0))

    await w.user.click(screen.getByRole('button', { name: 'Renew' }))
    await screen.findByRole('dialog', { name: 'Confirm it is you' })
    await act(() => w.client.session.signOut())
    await waitFor(() => expect(openDialogs()).toBe(0))
    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(2))
    expect(onResult).toHaveBeenLastCalledWith('declined')
  })
})

describe('the step-up dialog: a code by email', () => {
  const SEND = 'POST /v1/client/sessions/step-up/email-code'
  const RECEIPT = {
    method: 'email_code',
    destination: 'm***@northline.app',
    expiresAt: '2026-10-03T10:10:00.000Z',
  }
  const turnOn = async (w: World) => {
    const mfa = await section()
    await w.user.click(await within(mfa).findByRole('button', { name: 'Turn on' }))
    return screen.findByRole('dialog', { name: 'Confirm it is you' })
  }
  /** A profile whose "Turn on" needs a step-up with `methods` until one is proven. */
  function needsStepUp(methods: string) {
    const { w } = profileWorld({ enabled: false })
    const state = { stepped: false }
    w.api.on(MFA.start, () =>
      state.stepped ? json(200, { secret: SECRET, uri: URI }) : stepUpRequired(methods)
    )
    w.api.on(SEND, () => json(200, RECEIPT))
    return { w, state }
  }

  test('the only method: the code is sent once when the dialog opens, even under StrictMode, and proves the step-up', async () => {
    const { w, state } = needsStepUp('email_code')
    render(
      <StrictMode>
        <TulaProvider client={w.client}>
          <UserProfile />
        </TulaProvider>
      </StrictMode>
    )
    const dialog = await turnOn(w)
    expect(
      await within(dialog).findByText('Enter the 6-digit code we sent to m***@northline.app.')
    ).toBeTruthy()
    const code = within(dialog).getByLabelText(/Verification code/) as HTMLInputElement
    await expectFocus(code)
    expect(w.api.calls(SEND)).toHaveLength(1)
    expect(within(dialog).queryByLabelText('Password')).toBeNull()

    // Incomplete: refused here, nothing sent.
    await w.user.type(code, '123')
    await w.user.click(within(dialog).getByRole('button', { name: 'Continue' }))
    expect(within(dialog).getByRole('alert').textContent).toBe('Enter the 6-digit code.')
    expect(w.api.calls(MFA.stepUp)).toHaveLength(0)

    // Wrong: announced under the field with the guesses left, and retyped from scratch.
    w.api.on(MFA.stepUp, () =>
      failure(422, 'verification.invalid_code', { params: { attemptsRemaining: 4 } })
    )
    await w.user.clear(code)
    await w.user.type(code, '000000')
    await w.user.click(within(dialog).getByRole('button', { name: 'Continue' }))
    await waitFor(() =>
      expect(within(dialog).queryByRole('alert')?.textContent).toBe(
        'That code is incorrect. 4 attempts left.'
      )
    )
    expect(code.value).toBe('')
    expect(code.getAttribute('aria-invalid')).toBe('true')
    await expectFocus(code)

    w.api.on(MFA.stepUp, () => {
      state.stepped = true
      return json(200, sessionTokens('stepped_up'))
    })
    await w.user.type(code, '654321')
    await w.user.click(within(dialog).getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(w.api.calls(MFA.stepUp).at(-1)?.body).toEqual({ method: 'email_code', code: '654321' })
    expect(w.api.calls(MFA.start)).toHaveLength(2)
    expect(w.api.calls(SEND)).toHaveLength(1)
    // The code is gone with the dialog.
    expect(page()).not.toContain('654321')
  })

  test('next to a password nothing is emailed until the user asks, and they can go back', async () => {
    const { w } = needsStepUp('password,email_code')
    w.mount(<UserProfile />)
    const dialog = await turnOn(w)
    const password = within(dialog).getByLabelText('Password')
    await expectFocus(password)
    expect(w.api.calls(SEND)).toHaveLength(0)

    await w.user.click(within(dialog).getByRole('button', { name: 'Email me a code instead' }))
    const code = await within(dialog).findByLabelText(/Verification code/)
    await expectFocus(code)
    expect(w.api.calls(SEND)).toHaveLength(1)
    expect(within(dialog).queryByLabelText('Password')).toBeNull()

    await w.user.click(within(dialog).getByRole('button', { name: 'Use your password instead' }))
    await expectFocus(await within(dialog).findByLabelText('Password'))
    // Going back and forth sends no second email: the code this dialog sent can still be typed.
    await w.user.click(within(dialog).getByRole('button', { name: 'Email me a code instead' }))
    await expectFocus(await within(dialog).findByLabelText(/Verification code/))
    expect(
      within(dialog).getByText('Enter the 6-digit code we sent to m***@northline.app.')
    ).toBeTruthy()
    expect(w.api.calls(SEND)).toHaveLength(1)
    await w.user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
  })

  // Review finding F7: a first send refused as too soon was taken to mean "a code is already
  // in your inbox". This dialog sent none, and the refusal can be caused by someone else.
  test('a first send that is refused for now claims no code: the wait is counted down, then "Send code" sends', async () => {
    const { w } = needsStepUp('email_code')
    w.api.on(SEND, () =>
      failure(429, 'rate_limited', { params: { retryAfter: 1 } }, { 'retry-after': '1' })
    )
    w.mount(<UserProfile />)
    const dialog = await turnOn(w)
    expect(await within(dialog).findByText(/Try again in \ds\./)).toBeTruthy()
    expect(within(dialog).getByRole('alert').textContent).not.toBe('')
    expect(dialog.textContent).not.toMatch(/we sent|we emailed|code is on its way/i)
    expect(within(dialog).queryByLabelText(/Verification code/)).toBeNull()
    expect(within(dialog).queryByRole('button', { name: /Resend code/ })).toBeNull()
    const send = within(dialog).getByRole('button', { name: 'Send code' })
    expect(send.getAttribute('aria-disabled')).toBe('true')
    await w.user.click(send)
    expect(w.api.calls(SEND)).toHaveLength(1)

    // Once the server's wait is over the same button sends, and only then is a code asked for.
    w.api.on(SEND, () => json(200, RECEIPT))
    await waitFor(() => expect(send.getAttribute('aria-disabled')).not.toBe('true'), {
      timeout: 3_000,
    })
    await w.user.click(within(dialog).getByRole('button', { name: 'Send code' }))
    await expectFocus(await within(dialog).findByLabelText(/Verification code/))
    expect(
      within(dialog).getByText('Enter the 6-digit code we sent to m***@northline.app.')
    ).toBeTruthy()
    expect(w.api.calls(SEND)).toHaveLength(2)
  })

  test('resending: a new code is announced; sooner than the server allows, the button counts down', async () => {
    const { w } = needsStepUp('email_code')
    w.mount(<UserProfile />)
    const dialog = await turnOn(w)
    await within(dialog).findByLabelText(/Verification code/)
    await w.user.click(within(dialog).getByRole('button', { name: 'Resend code' }))
    await waitFor(() =>
      expect(within(dialog).getByRole('status').textContent).toBe('A new code is on its way.')
    )
    expect(w.api.calls(SEND)).toHaveLength(2)

    w.api.on(SEND, () => failure(429, 'rate_limited', {}, { 'retry-after': '42' }))
    await w.user.click(within(dialog).getByRole('button', { name: 'Resend code' }))
    const waiting = await within(dialog).findByRole('button', { name: /^Resend code in 4\ds$/ })
    expect(waiting.getAttribute('aria-disabled')).toBe('true')
    expect(within(dialog).getByRole('status').textContent).toBe('')
    // The code can still be submitted while the resend waits.
    expect(
      within(dialog).getByRole('button', { name: 'Continue' }).getAttribute('aria-disabled')
    ).not.toBe('true')
    await w.user.click(waiting)
    expect(w.api.calls(SEND)).toHaveLength(3)
  })

  test('a code that expired or ran out of guesses says so above the form, and a new one can be sent', async () => {
    const { w } = needsStepUp('email_code')
    w.mount(<UserProfile />)
    const dialog = await turnOn(w)
    const code = await within(dialog).findByLabelText(/Verification code/)
    w.api.on(MFA.stepUp, () => failure(410, 'verification.expired'))
    await w.user.type(code, '123456')
    await w.user.click(within(dialog).getByRole('button', { name: 'Continue' }))
    await waitFor(() =>
      expect(within(dialog).queryByRole('alert')?.textContent).toContain(
        'That code has expired. Request a new one.'
      )
    )
    await w.user.click(within(dialog).getByRole('button', { name: 'Resend code' }))
    await waitFor(() => expect(w.api.calls(SEND)).toHaveLength(2))
    await waitFor(() => expect(within(dialog).queryByRole('alert')).toBeNull())
  })

  test('when the email cannot be sent the dialog says so and offers to try again', async () => {
    const { w } = needsStepUp('email_code')
    w.api.on(SEND, () => failure(500, 'internal'))
    w.mount(<UserProfile />)
    const dialog = await turnOn(w)
    const alert = await within(dialog).findByRole('alert')
    expect(alert.textContent).not.toBe('')
    expect(within(dialog).queryByLabelText(/Verification code/)).toBeNull()
    w.api.on(SEND, () => json(200, RECEIPT))
    await w.user.click(within(dialog).getByRole('button', { name: 'Send code' }))
    await expectFocus(await within(dialog).findByLabelText(/Verification code/))
    expect(w.api.calls(SEND)).toHaveLength(2)
  })

  test('a user with a second factor is never offered a code by email', async () => {
    const { w } = profileWorld({ enabled: true })
    w.api.on(MFA.disable, () => stepUpRequired('totp,backup_code,email_code'))
    w.mount(<UserProfile />)
    const mfa = await section()
    await w.user.click(await within(mfa).findByRole('button', { name: 'Turn off' }))
    const dialog = await screen.findByRole('dialog', { name: 'Confirm it is you' })
    expect(within(dialog).queryByRole('button', { name: /Email me a code/ })).toBeNull()
    expect(w.api.calls(SEND)).toHaveLength(0)
  })

  test('signing out underneath the dialog closes it and a late receipt changes nothing', async () => {
    const { w } = needsStepUp('email_code')
    let release: (response: Response) => void = () => undefined
    w.api.on(SEND, () => new Promise<Response>((resolve) => (release = resolve)))
    w.mount(<UserProfile />)
    await turnOn(w)
    await waitFor(() => expect(w.api.calls(SEND)).toHaveLength(1))
    await act(() => w.client.session.signOut())
    await waitFor(() => expect(openDialogs()).toBe(0))
    await act(async () => release(json(200, RECEIPT)))
    expect(page()).not.toContain('m***@northline.app')
  })
})
