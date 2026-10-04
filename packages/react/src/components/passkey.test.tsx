import { afterEach, describe, expect, mock, test } from 'bun:test'
import { act, renderHook, screen, waitFor, within } from '@testing-library/react'
import { isStepUpRequired, type Passkey } from '@tula/core'
import { type ReactNode, StrictMode, useState } from 'react'
import type { PasskeyGlobals } from '../../../core/src/passkey'
import { TulaProvider } from '../context'
import { useResetPassword } from '../hooks/use-reset-password'
import { useSignIn } from '../hooks/use-sign-in'
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
  type WorldOptions,
  world,
} from '../testing/harness'
import { SignIn } from './sign-in'
import { UserProfile } from './user-profile'

const EMAIL = 'maya@northline.app'
const PASSWORD = 'sturdy-Otter-plays-42-chess'
const REQUEST = {
  challenge: 'Y2hhbGxlbmdl',
  timeout: 300_000,
  rpId: 'northline.test',
  userVerification: 'required',
}
const CREATION = {
  rp: { id: 'northline.test', name: 'Northline' },
  user: { id: 'dXNlcg', name: EMAIL, displayName: 'Maya' },
  challenge: 'Y2hhbGxlbmdl',
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  timeout: 300_000,
  excludeCredentials: [],
  authenticatorSelection: {
    residentKey: 'required',
    requireResidentKey: true,
    userVerification: 'required',
  },
  attestation: 'none',
}
const REGISTRATION = {
  id: 'Y3JlZA',
  rawId: 'Y3JlZA',
  type: 'public-key',
  response: { clientDataJSON: 'e30', attestationObject: 'YXR0', transports: ['internal'] },
  clientExtensionResults: {},
}
const ASSERTION = {
  id: 'Y3JlZA',
  rawId: 'Y3JlZA',
  type: 'public-key',
  response: {
    clientDataJSON: 'e30',
    authenticatorData: 'YXV0aA',
    signature: 'c2ln',
    userHandle: 'dXNlcg',
  },
  clientExtensionResults: {},
}
const MACBOOK: Passkey = {
  id: 'passkey_1',
  name: 'MacBook',
  synced: true,
  createdAt: '2026-03-04T10:00:00.000Z',
  lastUsedAt: '2026-05-06T10:00:00.000Z',
}
const YUBIKEY: Passkey = {
  id: 'passkey_2',
  name: 'YubiKey',
  synced: false,
  createdAt: '2026-04-05T10:00:00.000Z',
  lastUsedAt: null,
}
const PK = {
  start: 'POST /v1/client/sign-ins/passkey',
  submit: 'POST /v1/client/sign-ins/attempt_pk/passkey',
  secondOptions: 'POST /v1/client/sign-ins/attempt_1/second-factor/passkey/options',
  second: 'POST /v1/client/sign-ins/attempt_1/second-factor',
  resetSecondOptions: 'POST /v1/client/password-resets/attempt_1/second-factor/passkey/options',
  resetSecond: 'POST /v1/client/password-resets/attempt_1/second-factor',
  stepUpOptions: 'POST /v1/client/sessions/step-up/passkey',
  stepUp: 'POST /v1/client/sessions/step-up',
  list: 'GET /v1/client/me/passkeys',
  options: 'POST /v1/client/me/passkeys/options',
  create: 'POST /v1/client/me/passkeys',
  rename: 'PATCH /v1/client/me/passkeys/passkey_1',
  remove: 'DELETE /v1/client/me/passkeys/passkey_1',
} as const

afterEach(() => {
  mock.restore()
})

const named = (name: string) => Object.assign(new Error('the browser said something'), { name })

/** One call of `navigator.credentials.get` that the test answers by hand. */
interface HeldGet {
  conditional: boolean
  signal: AbortSignal | undefined
  pick(): void
  dismiss(): void
}

/**
 * A browser's WebAuthn: `get` is held until the test answers it (and rejects with `AbortError`
 * when its signal is aborted, as a browser does); `create` answers at once.
 */
function authenticator(options: { conditional?: boolean; hold?: boolean } = {}) {
  const gets: HeldGet[] = []
  const answers = {
    get: async (): Promise<unknown> => ({ toJSON: () => ASSERTION }),
    create: async (): Promise<unknown> => ({ toJSON: () => REGISTRATION }),
  }
  const creates: unknown[] = []
  const globals: PasskeyGlobals = {
    navigator: {
      credentials: {
        create(request) {
          creates.push(request)
          return answers.create()
        },
        get(request) {
          const { signal, mediation } = request as { signal?: AbortSignal; mediation?: string }
          const conditional = mediation === 'conditional'
          if (!conditional && !options.hold) {
            gets.push({ conditional, signal, pick() {}, dismiss() {} })
            return answers.get()
          }
          return new Promise((resolve, reject) => {
            gets.push({
              conditional,
              signal,
              pick: () => resolve({ toJSON: () => ASSERTION }),
              dismiss: () => reject(named('NotAllowedError')),
            })
            signal?.addEventListener('abort', () => reject(named('AbortError')))
          })
        },
      },
    },
    PublicKeyCredential: {
      isConditionalMediationAvailable: async () => options.conditional === true,
    },
  }
  return { globals, gets, creates, answers }
}

/** A world whose environment has passkeys on and whose browser can use them. */
function passkeyWorld(
  browser: ReturnType<typeof authenticator> | null = authenticator(),
  options: WorldOptions = {}
): World {
  const w = world({
    methods: ['password', 'passkey'],
    ...(browser && { passkeys: browser.globals }),
    ...options,
  })
  w.api.on(PK.start, () =>
    json(200, {
      attempt: {
        id: 'attempt_pk',
        kind: 'sign_in',
        expiresAt: '2030-01-01T00:10:00.000Z',
        step: { status: 'needs_first_factor', strategies: ['passkey'] },
        attemptSecret: 'tula_at_passkey_secret',
      },
      options: REQUEST,
    })
  )
  w.api.on(PK.submit, () => completed('sign_in'))
  return w
}

const passkeyButton = () => screen.findByRole('button', { name: 'Sign in with a passkey' })

describe('<SignIn> with a passkey', () => {
  test('no button, and a plain username field, where the environment has passkeys off', async () => {
    const w = world({ passkeys: authenticator().globals })
    w.mount(<SignIn />)
    const field = await screen.findByLabelText('Email address')
    await waitFor(() => expect(w.api.calls(ROUTE.config)).toHaveLength(1))
    expect(field.getAttribute('autocomplete')).toBe('username')
    expect(screen.queryByRole('button', { name: 'Sign in with a passkey' })).toBeNull()
  })

  test('hidden, not broken, in a browser without WebAuthn', async () => {
    const w = passkeyWorld(null)
    w.mount(<SignIn />)
    const field = await screen.findByLabelText('Email address')
    await waitFor(() => expect(field.getAttribute('autocomplete')).toBe('username webauthn'))
    expect(screen.queryByRole('button', { name: 'Sign in with a passkey' })).toBeNull()
    expect(w.api.calls(PK.start)).toHaveLength(0)
  })

  test('the button signs in with no address: one attempt of its own, then the completion', async () => {
    const browser = authenticator()
    const w = passkeyWorld(browser)
    const onComplete = mock()
    w.mount(<SignIn onComplete={onComplete} />)
    await w.user.click(await passkeyButton())
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    expect(onComplete.mock.calls[0]?.[0]).toEqual({ userId: 'user_1', sessionId: 'session_1' })
    expect(w.api.calls(PK.start)).toHaveLength(1)
    expect(w.api.calls(PK.submit)[0]?.body).toEqual({ credential: ASSERTION })
    expect(w.client.state.status).toBe('signed-in')
    // No address was asked for and no ordinary sign-in was started.
    expect(w.api.calls(ROUTE.signIn)).toHaveLength(0)
  })

  test('a dismissed dialog is said quietly, the button takes the focus back and works again', async () => {
    const browser = authenticator()
    browser.answers.get = async () => {
      throw named('NotAllowedError')
    }
    const w = passkeyWorld(browser)
    const onComplete = mock()
    w.mount(<SignIn onComplete={onComplete} />)
    const button = await passkeyButton()
    await w.user.click(button)
    const quiet = await screen.findByText(/passkey request was cancelled or timed out/)
    // A status, announced politely: not an alert, and not the browser's own words.
    expect(quiet.tagName).toBe('OUTPUT')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.body.textContent).not.toContain('the browser said something')
    await expectFocus(button)
    expect(button.getAttribute('aria-disabled')).toBeNull()

    browser.answers.get = async () => ({ toJSON: () => ASSERTION })
    await w.user.click(button)
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
  })

  test('a passkey the API refuses is an alert with the generic message', async () => {
    const w = passkeyWorld()
    w.api.on(PK.submit, () => failure(401, 'auth.invalid_credentials'))
    w.mount(<SignIn />)
    await w.user.click(await passkeyButton())
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('incorrect')
    expect(w.client.state.status).toBe('signed-out')
  })

  test('an account whose address is not verified goes on to the emailed code', async () => {
    const w = passkeyWorld()
    w.api.on(PK.submit, () =>
      json(200, {
        id: 'attempt_pk',
        kind: 'sign_in',
        expiresAt: '2030-01-01T00:10:00.000Z',
        step: {
          status: 'needs_email_verification',
          destination: 'm***@northline.app',
          strategies: ['email_code'],
        },
      })
    )
    w.mount(<SignIn />)
    await w.user.click(await passkeyButton())
    expect(await screen.findByLabelText('Verification code')).toBeTruthy()
  })

  test('after an address: offered among the other ways, on a screen of its own', async () => {
    const w = passkeyWorld()
    const onComplete = mock()
    w.mount(<SignIn onComplete={onComplete} />)
    w.api.on(ROUTE.signIn, () =>
      started('sign_in', { status: 'needs_first_factor', strategies: ['password', 'passkey'] })
    )
    await w.user.type(await screen.findByLabelText('Email address'), EMAIL)
    await w.user.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByLabelText('Password')
    await w.user.click(await passkeyButton())
    const title = await screen.findByRole('heading', { name: 'Sign in with a passkey' })
    expect(title).toBeTruthy()
    expect(screen.getByText(EMAIL)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Use your password' })).toBeTruthy()
    await w.user.click(await passkeyButton())
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    // The passkey's own attempt, not the one the address started.
    expect(w.api.calls(PK.submit)).toHaveLength(1)
    expect(w.api.calls(ROUTE.signInPassword)).toHaveLength(0)
  })

  test('after an address, in a browser without WebAuthn: the passkey is not among the ways', async () => {
    const w = passkeyWorld(null)
    w.mount(<SignIn />)
    w.api.on(ROUTE.signIn, () =>
      started('sign_in', { status: 'needs_first_factor', strategies: ['password', 'passkey'] })
    )
    await w.user.type(await screen.findByLabelText('Email address'), EMAIL)
    await w.user.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByLabelText('Password')
    expect(screen.queryByRole('button', { name: 'Sign in with a passkey' })).toBeNull()
  })

  test('where a passkey is the only way and the browser has none: the unsupported screen', async () => {
    const w = passkeyWorld(null)
    w.mount(<SignIn />)
    w.api.on(ROUTE.signIn, () =>
      started('sign_in', { status: 'needs_first_factor', strategies: ['passkey'] })
    )
    await w.user.type(await screen.findByLabelText('Email address'), EMAIL)
    await w.user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByRole('heading', { name: 'This step is not supported' })).toBeTruthy()
  })
})

describe('<SignIn> passkeys in the address field’s autofill', () => {
  const conditionalGets = (browser: ReturnType<typeof authenticator>) =>
    browser.gets.filter((get) => get.conditional)
  const live = (browser: ReturnType<typeof authenticator>) =>
    conditionalGets(browser).filter((get) => get.signal?.aborted === false)

  test('nothing is asked where the browser has no conditional mediation', async () => {
    const browser = authenticator({ conditional: false })
    const w = passkeyWorld(browser)
    w.mount(<SignIn />)
    await passkeyButton()
    await act(async () => {
      await Promise.resolve()
    })
    expect(browser.gets).toHaveLength(0)
    expect(w.api.calls(PK.start)).toHaveLength(0)
  })

  test('one request waits in the background, the form stays usable, and picking a passkey signs in', async () => {
    const browser = authenticator({ conditional: true })
    const w = passkeyWorld(browser)
    const onComplete = mock()
    w.mount(<SignIn onComplete={onComplete} />)
    await waitFor(() => expect(live(browser)).toHaveLength(1))
    // Nothing is pending on screen: the form is not blocked by the waiting request.
    const proceed = screen.getByRole('button', { name: 'Continue' })
    expect(proceed.getAttribute('aria-disabled')).toBeNull()
    expect((await passkeyButton()).getAttribute('aria-busy')).toBeNull()
    await w.user.type(screen.getByLabelText('Email address'), 'ma')
    expect(live(browser)).toHaveLength(1)

    live(browser)[0]?.pick()
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    expect(w.api.calls(PK.submit)[0]?.body).toEqual({ credential: ASSERTION })
  })

  test('StrictMode runs the effect twice: the second request does not die with the first one’s signal', async () => {
    const browser = authenticator({ conditional: true })
    const w = passkeyWorld(browser)
    const onComplete = mock()
    w.mount(
      <StrictMode>
        <SignIn onComplete={onComplete} />
      </StrictMode>
    )
    await waitFor(() => expect(live(browser)).toHaveLength(1))
    // Give a second request every chance to appear, or the live one to be aborted.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(live(browser)).toHaveLength(1)
    live(browser)[0]?.pick()
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
  })

  test('the button ends the waiting request before it starts its own, and a dismissal starts a new wait', async () => {
    const browser = authenticator({ conditional: true, hold: true })
    const w = passkeyWorld(browser)
    w.mount(<SignIn />)
    await waitFor(() => expect(live(browser)).toHaveLength(1))
    const waiting = live(browser)[0]

    await w.user.click(await passkeyButton())
    await waitFor(() => expect(browser.gets.filter((get) => !get.conditional)).toHaveLength(1))
    // Only one WebAuthn request is pending: the autofill one was aborted first.
    expect(waiting?.signal?.aborted).toBe(true)
    expect(live(browser)).toHaveLength(0)
    // Its ending is the screen's own doing: nothing is said about it.
    expect(screen.queryByRole('alert')).toBeNull()

    const modal = browser.gets.find((get) => !get.conditional)
    await act(async () => {
      modal?.dismiss()
    })
    expect(await screen.findByText(/passkey request was cancelled or timed out/)).toBeTruthy()
    await waitFor(() => expect(live(browser)).toHaveLength(1))
    expect(live(browser)[0]).not.toBe(waiting)
  })

  test('leaving the screen ends the waiting request and the open dialog', async () => {
    const browser = authenticator({ conditional: true, hold: true })
    const w = passkeyWorld(browser)
    const view = w.mount(<SignIn />)
    await waitFor(() => expect(live(browser)).toHaveLength(1))
    await w.user.click(await passkeyButton())
    await waitFor(() => expect(browser.gets.filter((get) => !get.conditional)).toHaveLength(1))
    view.unmount()
    expect(browser.gets.every((get) => get.signal?.aborted === true)).toBe(true)
  })

  test('a passkey picked from autofill that the API refuses is said', async () => {
    const browser = authenticator({ conditional: true })
    const w = passkeyWorld(browser)
    w.api.on(PK.submit, () => failure(401, 'auth.invalid_credentials'))
    w.mount(<SignIn />)
    await waitFor(() => expect(live(browser)).toHaveLength(1))
    live(browser)[0]?.pick()
    expect((await screen.findByRole('alert')).textContent).toContain('incorrect')
  })
})

/** Sign in with the password up to the answer it gets. */
async function passwordAnswers(w: World, answer: () => Response) {
  w.api.on(ROUTE.signIn, () => started('sign_in', { status: 'needs_password' }))
  w.api.on(ROUTE.signInPassword, answer)
  await w.user.type(await screen.findByLabelText('Email address'), EMAIL)
  await w.user.click(screen.getByRole('button', { name: 'Continue' }))
  await w.user.type(await screen.findByLabelText('Password'), PASSWORD)
  await w.user.click(screen.getByRole('button', { name: 'Sign in' }))
}

describe('a passkey as the second factor', () => {
  const secondFactor = (options: ('totp' | 'backup_code' | 'passkey')[]) => () =>
    attempt('sign_in', { status: 'needs_second_factor', options })

  test('where it is the only one: "Use your passkey" proves it and signs in', async () => {
    const w = passkeyWorld()
    const onComplete = mock()
    w.api.on(PK.secondOptions, () => json(200, { ...REQUEST, allowCredentials: [] }))
    w.api.on(PK.second, () => completed('sign_in'))
    w.mount(<SignIn onComplete={onComplete} />)
    await passwordAnswers(w, secondFactor(['passkey']))
    expect(await screen.findByText('Use your passkey to finish signing in.')).toBeTruthy()
    await w.user.click(screen.getByRole('button', { name: 'Use your passkey' }))
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    expect(w.api.calls(PK.second)[0]?.body).toEqual({ method: 'passkey', credential: ASSERTION })
  })

  test('where it is the only one and the browser has no WebAuthn: it says so, with the way back', async () => {
    const w = passkeyWorld(null)
    w.mount(<SignIn />)
    await passwordAnswers(w, secondFactor(['passkey']))
    expect(await screen.findByText(/This browser cannot use passkeys/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Use your passkey' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Back to sign in' })).toBeTruthy()
  })

  test('next to a code: the code first, the passkey one click away, and back again', async () => {
    const browser = authenticator()
    browser.answers.get = async () => {
      throw named('NotAllowedError')
    }
    const w = passkeyWorld(browser)
    w.api.on(PK.secondOptions, () => json(200, { ...REQUEST, allowCredentials: [] }))
    w.mount(<SignIn />)
    await passwordAnswers(w, secondFactor(['totp', 'backup_code', 'passkey']))
    await screen.findByLabelText('Authentication code')
    expect(screen.getByRole('button', { name: 'Use a backup code' })).toBeTruthy()
    await w.user.click(await screen.findByRole('button', { name: 'Use your passkey instead' }))
    const use = await screen.findByRole('button', { name: 'Use your passkey' })
    await expectFocus(use)
    expect(screen.getByRole('button', { name: 'Use your authenticator app' })).toBeTruthy()

    await w.user.click(use)
    expect(await screen.findByText(/passkey request was cancelled or timed out/)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    await expectFocus(use)
    // Nothing was sent to be judged, and nothing of the dismissal follows to the code form.
    expect(w.api.calls(PK.second)).toHaveLength(0)
    await w.user.click(screen.getByRole('button', { name: 'Use your authenticator app' }))
    await expectFocus(await screen.findByLabelText('Authentication code'))
    expect(screen.queryByText(/passkey request was cancelled/)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  test('next to a code, in a browser without WebAuthn: the passkey is not offered', async () => {
    const w = passkeyWorld(null)
    w.mount(<SignIn />)
    await passwordAnswers(w, secondFactor(['totp', 'passkey']))
    await screen.findByLabelText('Authentication code')
    expect(screen.queryByRole('button', { name: 'Use your passkey instead' })).toBeNull()
  })

  test('a refused passkey is an alert; a wrong code afterwards is the code field’s', async () => {
    const w = passkeyWorld()
    w.api.on(PK.secondOptions, () => json(200, { ...REQUEST, allowCredentials: [] }))
    w.api.on(PK.second, () => failure(401, 'auth.invalid_credentials'))
    w.mount(<SignIn />)
    await passwordAnswers(w, secondFactor(['totp', 'passkey']))
    await w.user.click(await screen.findByRole('button', { name: 'Use your passkey instead' }))
    await w.user.click(await screen.findByRole('button', { name: 'Use your passkey' }))
    expect((await screen.findByRole('alert')).textContent).toContain('incorrect')
    await w.user.click(screen.getByRole('button', { name: 'Use your authenticator app' }))
    await screen.findByLabelText('Authentication code')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

const stepUpRequired = (methods: string) =>
  failure(403, 'auth.step_up_required', { params: { methods } })

/** A button that makes a sensitive call through `useStepUp`, and says how it went. */
function Sensitive() {
  const tula = useTula()
  const withStepUp = useStepUp()
  const [result, setResult] = useState('idle')
  const run = async () => {
    try {
      await withStepUp(() => tula.mfa.regenerateBackupCodes())
      setResult('done')
    } catch (error) {
      setResult(isStepUpRequired(error) ? 'declined' : 'failed')
    }
  }
  return (
    <>
      <button type='button' onClick={run}>
        Renew
      </button>
      <p>result: {result}</p>
    </>
  )
}

describe('the step-up dialog with a passkey', () => {
  const CODES = 'POST /v1/client/me/factors/backup-codes'

  /** A signed-in world whose sensitive call asks for a step-up until one was made. */
  function steppingWorld(
    methods: string,
    browser = authenticator() as ReturnType<typeof authenticator> | null
  ) {
    const w = passkeyWorld(browser, { signedIn: true })
    let stepped = false
    w.api.on(CODES, () =>
      stepped ? json(200, { codes: ['abcde-fghjk'] }) : stepUpRequired(methods)
    )
    w.api.on(PK.stepUpOptions, () => json(200, { ...REQUEST, allowCredentials: [] }))
    w.api.on(PK.stepUp, () => {
      stepped = true
      const fresh = sessionTokens('stepped')
      return json(200, {
        sessionId: fresh.sessionId,
        accessToken: fresh.accessToken,
        accessTokenExpiresAt: fresh.accessTokenExpiresAt,
      })
    })
    return w
  }
  const open = async (w: World) => {
    w.mount(<Sensitive />)
    await w.user.click(await screen.findByRole('button', { name: 'Renew' }))
    return screen.findByRole('dialog')
  }

  test('alone: the passkey steps the session up and the action runs again', async () => {
    const w = steppingWorld('passkey')
    const dialog = await open(w)
    expect(within(dialog).getByText('Use your passkey to continue.')).toBeTruthy()
    expect(within(dialog).queryByLabelText('Password')).toBeNull()
    await w.user.click(within(dialog).getByRole('button', { name: 'Use your passkey' }))
    expect(await screen.findByText('result: done')).toBeTruthy()
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(w.api.calls(PK.stepUp)[0]?.body).toEqual({ method: 'passkey', credential: ASSERTION })
    expect(w.api.calls(CODES)).toHaveLength(2)
  })

  test('next to the password and an emailed code: the passkey first, no email sent unasked', async () => {
    const w = steppingWorld('passkey,password,email_code')
    const dialog = await open(w)
    expect(await within(dialog).findByRole('button', { name: 'Use your passkey' })).toBeTruthy()
    expect(w.api.calls('POST /v1/client/sessions/step-up/email-code')).toHaveLength(0)
    await w.user.click(within(dialog).getByRole('button', { name: 'Use your password instead' }))
    const password = await within(dialog).findByLabelText('Password')
    await expectFocus(password)
    await w.user.click(within(dialog).getByRole('button', { name: 'Use your passkey instead' }))
    await expectFocus(await within(dialog).findByRole('button', { name: 'Use your passkey' }))
    expect(within(dialog).getByRole('button', { name: 'Email me a code instead' })).toBeTruthy()
  })

  test('a dismissed passkey dialog is quiet and the user can still cancel', async () => {
    const browser = authenticator()
    browser.answers.get = async () => {
      throw named('NotAllowedError')
    }
    const w = steppingWorld('passkey,password', browser)
    const dialog = await open(w)
    const use = await within(dialog).findByRole('button', { name: 'Use your passkey' })
    await w.user.click(use)
    expect(await within(dialog).findByText(/passkey request was cancelled/)).toBeTruthy()
    expect(within(dialog).queryByRole('alert')).toBeNull()
    await expectFocus(use)
    await w.user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByText('result: declined')).toBeTruthy()
    expect(w.api.calls(PK.stepUp)).toHaveLength(0)
  })

  test('for a user with two-step verification: next to the codes, never the password', async () => {
    const w = steppingWorld('totp,backup_code,passkey')
    const dialog = await open(w)
    await within(dialog).findByLabelText('Authentication code')
    expect(within(dialog).queryByLabelText('Password')).toBeNull()
    await w.user.click(
      await within(dialog).findByRole('button', { name: 'Use your passkey instead' })
    )
    expect(within(dialog).getByText('Use your passkey to continue.')).toBeTruthy()
    await w.user.click(within(dialog).getByRole('button', { name: 'Use your passkey' }))
    expect(await screen.findByText('result: done')).toBeTruthy()
  })

  test('in a browser without WebAuthn: the password where there is one, an explanation where there is not', async () => {
    const w = steppingWorld('passkey,password', null)
    const dialog = await open(w)
    expect(await within(dialog).findByLabelText('Password')).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: 'Use your passkey instead' })).toBeNull()
    await w.user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
  })

  test('a passkey is all the user has and this browser cannot use one: it says so', async () => {
    const w = steppingWorld('passkey', null)
    const dialog = await open(w)
    expect(await within(dialog).findByText(/This browser cannot use passkeys/)).toBeTruthy()
    await w.user.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(await screen.findByText('result: declined')).toBeTruthy()
  })
})

describe('<UserProfile> passkeys', () => {
  /** A signed-in world with the user's passkeys behind the list route. */
  function profileWorld(
    initial: Passkey[],
    browser: ReturnType<typeof authenticator> | null = authenticator(),
    options: WorldOptions = {}
  ) {
    const w = passkeyWorld(browser, { signedIn: true, ...options })
    const state = { list: [...initial] }
    w.api.on(ROUTE.sessions, () => json(200, { data: [] }))
    w.api.on(PK.list, () => json(200, { passkeys: state.list }))
    w.api.on(PK.options, () => json(200, CREATION))
    w.api.on(PK.create, () => {
      const created = { ...YUBIKEY, id: 'passkey_3', name: 'Passkey' }
      state.list = [...state.list, created]
      return json(201, created)
    })
    w.api.on(PK.rename, (request) => {
      const { name } = request.body as { name: string }
      state.list = state.list.map((entry) =>
        entry.id === 'passkey_1' ? { ...entry, name } : entry
      )
      return json(200, { ...MACBOOK, name })
    })
    w.api.on(PK.remove, () => {
      state.list = state.list.filter((entry) => entry.id !== 'passkey_1')
      return new Response(null, { status: 204 })
    })
    return w
  }
  const section = async () =>
    (await screen.findByRole('heading', { name: 'Passkeys' })).closest('section') as HTMLElement

  test('left out, with no request, where the environment has passkeys off', async () => {
    const w = world({ signedIn: true, passkeys: authenticator().globals })
    w.api.on(ROUTE.sessions, () => json(200, { data: [] }))
    w.mount(<UserProfile />)
    await screen.findByRole('heading', { name: 'Where you’re signed in' })
    await waitFor(() => expect(w.api.calls(ROUTE.config)).toHaveLength(1))
    expect(screen.queryByRole('heading', { name: 'Passkeys' })).toBeNull()
    expect(w.api.calls(PK.list)).toHaveLength(0)
  })

  test('lists each passkey with its name, kind and dates as text', async () => {
    const w = profileWorld([MACBOOK, YUBIKEY])
    w.mount(<UserProfile />)
    const rows = within(await section()).getAllByRole('listitem')
    await waitFor(() => expect(within(rows[0] as HTMLElement).queryByText('MacBook')).toBeTruthy())
    const first = rows[0]?.textContent ?? ''
    expect(first).toContain('Synced across your devices')
    expect(first).toContain('Added Mar 4, 2026')
    expect(first).toContain('Last used May 6, 2026')
    const second = rows[1]?.textContent ?? ''
    expect(second).toContain('YubiKey')
    expect(second).toContain('On this device only')
    expect(second).toContain('Not used yet')
    // Nothing of a credential is on the page: the list carries names and dates only.
    expect(document.body.innerHTML).not.toContain('Y3JlZA')
  })

  test('with none: says so; adding one runs the ceremony, reloads the list and confirms', async () => {
    const browser = authenticator()
    const w = profileWorld([], browser)
    w.mount(<UserProfile />)
    const area = await section()
    expect(await within(area).findByText('You have no passkeys yet.')).toBeTruthy()
    await w.user.click(within(area).getByRole('button', { name: 'Add a passkey' }))
    expect(await within(area).findByText('Your passkey was added.')).toBeTruthy()
    expect(browser.creates).toHaveLength(1)
    expect(w.api.calls(PK.create)[0]?.body).toEqual({ credential: REGISTRATION })
    expect(within(area).getByText('Passkey')).toBeTruthy()
    expect(w.api.calls(PK.list)).toHaveLength(2)
  })

  test('adding goes through the step-up dialog when the server asks for one', async () => {
    const w = profileWorld([])
    let stepped = false
    w.api.on(PK.options, () => (stepped ? json(200, CREATION) : stepUpRequired('password')))
    w.api.on(PK.stepUp, () => {
      stepped = true
      const fresh = sessionTokens('stepped')
      return json(200, {
        sessionId: fresh.sessionId,
        accessToken: fresh.accessToken,
        accessTokenExpiresAt: fresh.accessTokenExpiresAt,
      })
    })
    w.mount(<UserProfile />)
    const area = await section()
    await w.user.click(await within(area).findByRole('button', { name: 'Add a passkey' }))
    const dialog = await screen.findByRole('dialog')
    await w.user.type(within(dialog).getByLabelText('Password'), PASSWORD)
    await w.user.click(within(dialog).getByRole('button', { name: 'Continue' }))
    expect(await within(area).findByText('Your passkey was added.')).toBeTruthy()

    // Declining the dialog is the user's choice: nothing is said and nothing was created.
    stepped = false
    await w.user.click(within(area).getByRole('button', { name: 'Add a passkey' }))
    const again = await screen.findByRole('dialog')
    await w.user.click(within(again).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(openDialogs()).toBe(0))
    expect(within(area).queryByRole('alert')).toBeNull()
    expect(w.api.calls(PK.create)).toHaveLength(1)
  })

  test('a dismissed dialog is quiet; "already on this device" and the limit are messages', async () => {
    const browser = authenticator()
    const w = profileWorld([MACBOOK], browser)
    w.mount(<UserProfile />)
    const area = await section()
    const add = await within(area).findByRole('button', { name: 'Add a passkey' })

    browser.answers.create = async () => {
      throw named('NotAllowedError')
    }
    await w.user.click(add)
    expect(await within(area).findByText(/passkey request was cancelled/)).toBeTruthy()
    expect(within(area).queryByRole('alert')).toBeNull()
    await expectFocus(add)
    expect(add.getAttribute('aria-disabled')).toBeNull()

    browser.answers.create = async () => {
      throw named('InvalidStateError')
    }
    await w.user.click(add)
    expect((await within(area).findByRole('alert')).textContent).toBe(
      'This device already has a passkey for this account.'
    )
    await expectFocus(add)

    browser.answers.create = async () => ({ toJSON: () => REGISTRATION })
    w.api.on(PK.create, () => failure(409, 'passkey.limit_reached'))
    await w.user.click(add)
    await waitFor(() =>
      expect(within(area).getByRole('alert').textContent).not.toContain('already has a passkey')
    )
    expect(w.api.calls(PK.create)).toHaveLength(1)
    expect(within(area).queryByText('Your passkey was added.')).toBeNull()
  })

  test('rename: a field under the row, a name is required, and focus returns to "Rename"', async () => {
    const w = profileWorld([MACBOOK, YUBIKEY])
    w.mount(<UserProfile />)
    const area = await section()
    const rename = await within(area).findByRole('button', { name: 'Rename MacBook' })
    await w.user.click(rename)
    const field = await within(area).findByLabelText('Passkey name')
    await expectFocus(field)
    expect((field as HTMLInputElement).value).toBe('MacBook')
    // One thing at a time: the other row and "Add" wait.
    expect(
      within(area).getByRole('button', { name: 'Remove YubiKey' }).getAttribute('aria-disabled')
    ).toBe('true')
    expect(
      within(area).getByRole('button', { name: 'Add a passkey' }).getAttribute('aria-disabled')
    ).toBe('true')

    await w.user.clear(field)
    await w.user.click(within(area).getByRole('button', { name: 'Save' }))
    expect(await within(area).findByText('Enter a name.')).toBeTruthy()
    expect(w.api.calls(PK.rename)).toHaveLength(0)

    await w.user.type(field, 'Work laptop')
    await w.user.click(within(area).getByRole('button', { name: 'Save' }))
    expect(await within(area).findByText('The passkey was renamed.')).toBeTruthy()
    expect(w.api.calls(PK.rename)[0]?.body).toEqual({ name: 'Work laptop' })
    await expectFocus(await within(area).findByRole('button', { name: 'Rename Work laptop' }))
    expect(within(area).queryByLabelText('Passkey name')).toBeNull()
  })

  test('rename can be cancelled, and a refusal keeps the field open with its message', async () => {
    const w = profileWorld([MACBOOK])
    w.mount(<UserProfile />)
    const area = await section()
    const rename = await within(area).findByRole('button', { name: 'Rename MacBook' })
    await w.user.click(rename)
    await w.user.click(await within(area).findByRole('button', { name: 'Cancel' }))
    await expectFocus(rename)
    expect(within(area).queryByLabelText('Passkey name')).toBeNull()

    w.api.on(PK.rename, () => failure(404, 'resource.not_found'))
    await w.user.click(rename)
    await w.user.click(await within(area).findByRole('button', { name: 'Save' }))
    expect(await within(area).findByRole('alert')).toBeTruthy()
    expect(within(area).getByLabelText('Passkey name')).toBeTruthy()
  })

  test('remove asks first; "Cancel" keeps it, the confirmation removes it', async () => {
    const w = profileWorld([MACBOOK, YUBIKEY])
    w.mount(<UserProfile />)
    const area = await section()
    const remove = await within(area).findByRole('button', { name: 'Remove MacBook' })
    await w.user.click(remove)
    const question = await within(area).findByRole('group', {
      name: 'Remove “MacBook”? You will no longer be able to sign in with it.',
    })
    // The focus lands on the answer that changes nothing.
    await expectFocus(within(question).getByRole('button', { name: 'Cancel' }))
    await w.user.click(within(question).getByRole('button', { name: 'Cancel' }))
    await expectFocus(remove)
    expect(w.api.calls(PK.remove)).toHaveLength(0)

    await w.user.click(remove)
    await w.user.click(await within(area).findByRole('button', { name: 'Remove passkey' }))
    expect(await within(area).findByText('The passkey was removed.')).toBeTruthy()
    expect(w.api.calls(PK.remove)).toHaveLength(1)
    expect(within(area).queryByText('MacBook')).toBeNull()
    expect(within(area).getByText('YubiKey')).toBeTruthy()
    await expectFocus(within(area).getByRole('heading', { name: 'Passkeys' }))
  })

  test('the last way to sign in cannot be removed: the server’s message, and the passkey stays', async () => {
    const w = profileWorld([MACBOOK])
    w.api.on(PK.remove, () => failure(409, 'passkey.last_sign_in_method'))
    w.mount(<UserProfile />)
    const area = await section()
    const remove = await within(area).findByRole('button', { name: 'Remove MacBook' })
    await w.user.click(remove)
    await w.user.click(await within(area).findByRole('button', { name: 'Remove passkey' }))
    const alert = await within(area).findByRole('alert')
    expect(alert.textContent?.length).toBeGreaterThan(10)
    expect(within(area).getByText('MacBook')).toBeTruthy()
    expect(within(area).queryByRole('group')).toBeNull()
    await expectFocus(remove)
  })

  test('in a browser without WebAuthn the section explains itself and still lists and removes', async () => {
    const w = profileWorld([MACBOOK], null)
    w.mount(<UserProfile />)
    const area = await section()
    expect(await within(area).findByText(/This browser cannot create passkeys/)).toBeTruthy()
    expect(within(area).queryByRole('button', { name: 'Add a passkey' })).toBeNull()
    expect(await within(area).findByRole('button', { name: 'Remove MacBook' })).toBeTruthy()
  })

  test('a list that cannot be loaded is an error, not an empty list', async () => {
    const w = profileWorld([MACBOOK])
    w.api.on(PK.list, () => failure(500, 'internal'))
    w.mount(<UserProfile />)
    const area = await section()
    expect(await within(area).findByRole('alert')).toBeTruthy()
    expect(within(area).queryByText('You have no passkeys yet.')).toBeNull()
    expect(within(area).queryByText('Loading your passkeys…')).toBeNull()
  })

  test('a result that arrives after the session ended is dropped', async () => {
    const browser = authenticator()
    let finish: (value: unknown) => void = () => undefined
    browser.answers.create = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    const w = profileWorld([], browser)
    w.mount(<UserProfile />)
    const area = await section()
    await w.user.click(await within(area).findByRole('button', { name: 'Add a passkey' }))
    await waitFor(() => expect(browser.creates).toHaveLength(1))
    await act(async () => {
      await w.client.session.signOut()
    })
    await act(async () => {
      finish({ toJSON: () => REGISTRATION })
      await Promise.resolve()
    })
    expect(screen.queryByText('Your passkey was added.')).toBeNull()
    // The dialog that was open was ended with the session.
    const request = browser.creates[0] as { signal?: AbortSignal }
    expect(request.signal?.aborted).toBe(true)
  })
})

describe('the hooks’ passkey actions', () => {
  const wrapper = (w: World) =>
    function Wrapper(props: { children: ReactNode }) {
      return <TulaProvider client={w.client}>{props.children}</TulaProvider>
    }

  test('useSignIn: canUsePasskey, withPasskey, and a dismissed dialog as the error', async () => {
    const browser = authenticator()
    const w = passkeyWorld(browser)
    const { result } = renderHook(() => useSignIn(), { wrapper: wrapper(w) })
    expect(result.current.canUsePasskey()).toBe(true)
    browser.answers.get = async () => {
      throw named('NotAllowedError')
    }
    await act(async () => {
      expect(await result.current.withPasskey()).toBeNull()
    })
    expect(result.current.error?.code).toBe('passkey.cancelled')
    browser.answers.get = async () => ({ toJSON: () => ASSERTION })
    await act(async () => {
      expect((await result.current.withPasskey())?.status).toBe('complete')
    })
    expect(result.current.step?.status).toBe('complete')
  })

  test('useSignIn and useResetPassword: the passkey as the second factor', async () => {
    const w = passkeyWorld()
    w.api.on(ROUTE.signIn, () =>
      started('sign_in', { status: 'needs_second_factor', options: ['passkey'] })
    )
    w.api.on(PK.secondOptions, () => json(200, { ...REQUEST, allowCredentials: [] }))
    w.api.on(PK.second, () => completed('sign_in'))
    const signIn = renderHook(() => useSignIn(), { wrapper: wrapper(w) })
    await act(async () => {
      await signIn.result.current.start({ identifier: EMAIL })
    })
    await act(async () => {
      expect((await signIn.result.current.submitSecondFactorWithPasskey())?.status).toBe('complete')
    })
    signIn.unmount()

    const other = passkeyWorld()
    other.api.on(ROUTE.reset, () => started('password_reset', NEW_PASSWORD_STEP))
    other.api.on(ROUTE.resetSubmit, () =>
      attempt('password_reset', { status: 'needs_second_factor', options: ['passkey'] })
    )
    other.api.on(PK.resetSecondOptions, () => json(200, { ...REQUEST, allowCredentials: [] }))
    other.api.on(PK.resetSecond, () => completed('password_reset'))
    const reset = renderHook(() => useResetPassword(), { wrapper: wrapper(other) })
    await act(async () => {
      await reset.result.current.start({ email: EMAIL })
    })
    await act(async () => {
      await reset.result.current.submit({ code: '123456', password: PASSWORD })
    })
    await act(async () => {
      expect((await reset.result.current.submitSecondFactorWithPasskey())?.status).toBe('complete')
    })
    expect(other.api.calls(PK.resetSecond)[0]?.body).toEqual({
      method: 'passkey',
      credential: ASSERTION,
    })
  })

  test('adopting a passkey sign-in discards the attempt it replaces', async () => {
    const w = passkeyWorld()
    w.api.on(ROUTE.signIn, () => started('sign_in', { status: 'needs_password' }))
    const { result } = renderHook(() => useSignIn(), { wrapper: wrapper(w) })
    await act(async () => {
      await result.current.start({ identifier: EMAIL })
    })
    expect(result.current.step?.status).toBe('needs_password')
    const flow = await w.client.signIn.withPasskey()
    act(() => result.current.adopt(flow))
    expect(result.current.step?.status).toBe('complete')
    // The password belongs to the attempt that was left: the adopted flow has no such step.
    w.api.on(ROUTE.signInPassword, () => completed('sign_in'))
    await act(async () => {
      await result.current.submitPassword({ password: PASSWORD })
    })
    expect(w.api.calls(ROUTE.signInPassword)).toHaveLength(0)
  })
})
