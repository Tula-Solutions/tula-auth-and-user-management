import { afterEach, describe, expect, jest, test } from 'bun:test'
import { act, render, waitFor } from '@testing-library/react'
import { Activity } from 'react'
import { TulaProvider, useTula } from '../context'
import {
  attempt,
  completed,
  failure,
  json,
  ROUTE,
  sessionTokens,
  started,
  TEST_USER,
  type World,
  world,
} from '../testing/world'
import { useAuth, useUser } from './use-auth'
import { useResetPassword, useSignIn, useSignUp } from './use-flows'
import { useSession } from './use-session'

afterEach(() => {
  jest.useRealTimers()
})

function useFlows() {
  return { signIn: useSignIn(), signUp: useSignUp(), reset: useResetPassword() }
}

/** Let what is already queued (promises, not timers) run, inside `act`. */
async function turns(count = 20): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < count; turn++) {
      await Promise.resolve()
    }
  })
}

/** A request the test answers when it chooses. */
function held(w: World, route: string) {
  const waiting: ((response: Response | Promise<Response>) => void)[] = []
  w.api.on(route, () => new Promise<Response>((resolve) => waiting.push(resolve)))
  return waiting
}

const device = (id: string, current = false) => ({
  id,
  client: 'ios',
  userAgent: null,
  ipAddress: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  lastActiveAt: '2026-10-01T00:00:00.000Z',
  expiresAt: '2030-01-01T00:00:00.000Z',
  current,
})

describe('the provider', () => {
  test('a hook outside it says so', () => {
    expect(() => render(<Probe />)).toThrow(/inside <TulaProvider>/)
    function Probe() {
      useTula()
      return null
    }
  })

  test('finds out who is signed in, once, also under StrictMode', async () => {
    const w = world({ signedIn: true })
    const { result } = w.render(() => ({ auth: useAuth(), user: useUser(), tula: useTula() }), true)
    expect(result.current.auth).toMatchObject({
      status: 'loading',
      isLoaded: false,
      isSignedIn: false,
      sessionId: null,
    })
    expect(result.current.user).toMatchObject({ isLoaded: false, isSignedIn: false, user: null })
    await waitFor(() => expect(result.current.user.user).toEqual(TEST_USER))
    expect(result.current.auth).toMatchObject({
      status: 'signed-in',
      isLoaded: true,
      isSignedIn: true,
      sessionId: 'session_1',
    })
    expect(result.current.tula).toBe(w.client)
    expect(w.api.calls(ROUTE.refresh)).toHaveLength(1)
    expect(w.store.calls.filter((call) => call.operation === 'get')).toHaveLength(1)
    expect(await result.current.auth.getToken()).toBeString()
    expect(await result.current.user.reload()).toEqual(TEST_USER)
  })

  test('nothing stored: signed out, and no request', async () => {
    const w = world()
    const { result } = w.render(() => useAuth())
    await waitFor(() => expect(result.current.status).toBe('signed-out'))
    expect(result.current).toMatchObject({ isLoaded: true, isSignedIn: false, sessionId: null })
    expect(await result.current.getToken()).toBeNull()
    expect(w.api.requests).toEqual([])
  })

  test('offline at launch: still loading, nobody signed out, and it tries again with a growing delay', async () => {
    jest.useFakeTimers()
    const w = world({ signedIn: true })
    let online = false
    const answer = w.api.fetch
    w.api.on(ROUTE.refresh, () => {
      if (!online) {
        throw new TypeError('Network request failed')
      }
      return json(200, { sessionId: 'session_1', accessToken: 'never used' })
    })
    void answer
    const { result } = w.render(() => useAuth())
    await turns()
    // One load: the request and core's one immediate repeat of a refresh that got no answer.
    expect(w.api.calls(ROUTE.refresh)).toHaveLength(2)
    expect(result.current.status).toBe('loading')
    expect(w.storedToken()).toBe('rt_0')

    await act(async () => {
      jest.advanceTimersByTime(1_900)
    })
    await turns()
    expect(w.api.calls(ROUTE.refresh)).toHaveLength(2)
    await act(async () => {
      jest.advanceTimersByTime(200)
    })
    await turns()
    expect(w.api.calls(ROUTE.refresh)).toHaveLength(4)
    // The second wait is twice the first.
    await act(async () => {
      jest.advanceTimersByTime(2_100)
    })
    await turns()
    expect(w.api.calls(ROUTE.refresh)).toHaveLength(4)
    expect(result.current.status).toBe('loading')
    expect(w.states).toEqual([])
    expect(w.storedToken()).toBe('rt_0')

    online = true
    w.api.on(ROUTE.refresh, () => failure(401, 'session.expired'))
    await act(async () => {
      jest.advanceTimersByTime(2_000)
    })
    await turns()
    // Only the server's own answer ends the session.
    expect(result.current.status).toBe('signed-out')
    expect(w.storedToken()).toBeUndefined()
  })

  test('a locked secure store at launch: still loading, nothing sent, and signed in once it can be read', async () => {
    jest.useFakeTimers()
    const w = world({ signedIn: true })
    w.store.fail('get', new Error('User interaction is not allowed.'))
    const { result } = w.render(() => useAuth())
    await turns()
    expect(result.current.status).toBe('loading')
    expect(w.api.requests).toEqual([])

    w.store.fail('get', null)
    await act(async () => {
      jest.advanceTimersByTime(2_100)
    })
    await turns()
    expect(result.current.status).toBe('signed-in')
    expect(w.storedToken()).toBe('rt_1')
  })

  test('a key the API refuses at launch: still loading and still trying, and the hook says why until a try succeeds', async () => {
    jest.useFakeTimers()
    const w = world({ signedIn: true })
    let refused = true
    w.api.on(ROUTE.refresh, () =>
      refused
        ? failure(401, 'auth.invalid_key')
        : json(200, sessionTokens('loaded', { refreshToken: 'rt_1' }))
    )
    const { result } = w.render(() => useAuth())
    expect(result.current.loadError).toBeNull()
    await turns()

    // Not the session's refusal: nobody is signed out, the token stays, and the app is told.
    expect(result.current.status).toBe('loading')
    expect(result.current.isLoaded).toBe(false)
    expect(result.current.loadError).toMatchObject({ code: 'auth.invalid_key', status: 401 })
    expect(w.storedToken()).toBe('rt_0')
    expect(w.states).toEqual([])
    // Nothing of the session or the key is in what the app is handed.
    const handed = `${JSON.stringify(result.current.loadError)} ${result.current.loadError?.message}`
    expect(handed).not.toContain('rt_0')
    expect(handed).not.toContain('tula_pk_')

    // It is tried again all the same: the provider does not decide which failures are final.
    const asked = w.api.calls(ROUTE.refresh).length
    await act(async () => {
      jest.advanceTimersByTime(2_100)
    })
    await turns()
    expect(w.api.calls(ROUTE.refresh).length).toBeGreaterThan(asked)
    expect(result.current.status).toBe('loading')
    expect(result.current.loadError).toMatchObject({ code: 'auth.invalid_key' })

    // The key is put right: the next try succeeds and the error is gone with it.
    refused = false
    await act(async () => {
      jest.advanceTimersByTime(4_100)
    })
    await turns()
    expect(result.current.status).toBe('signed-in')
    expect(result.current.loadError).toBeNull()
    expect(w.storedToken()).toBe('rt_1')
  })

  test('a locked secure store at launch is said as storage.failed, and a sign-in that overtakes a failed load clears it', async () => {
    jest.useFakeTimers()
    const w = world({ signedIn: true })
    w.store.fail('get', new Error('User interaction is not allowed.'))
    w.api.on(ROUTE.signIn, () => started('sign_in', { status: 'needs_password' }))
    w.api.on(ROUTE.signInPassword, () => completed('sign_in'))
    const { result } = w.render(() => useAuth())
    await turns()
    expect(result.current.status).toBe('loading')
    expect(result.current.loadError).toMatchObject({ code: 'storage.failed', status: 0 })

    // The user signs in while the store is still unreadable: no try of the load succeeded,
    // and the hook still stops reporting the failure, because it is no longer loading.
    await act(async () => {
      const flow = await w.client.signIn.start({ identifier: 'maya@northline.app' })
      await flow.submitPassword({ password: 'x' })
    })
    await turns()
    expect(result.current.status).toBe('signed-in')
    expect(result.current.loadError).toBeNull()
  })

  test('an unmounted provider leaves no retry behind', async () => {
    jest.useFakeTimers()
    const w = world({ signedIn: true })
    w.api.on(ROUTE.refresh, () => {
      throw new TypeError('Network request failed')
    })
    const { unmount } = w.render(() => useAuth())
    await turns()
    const asked = w.api.calls(ROUTE.refresh).length
    unmount()
    jest.advanceTimersByTime(120_000)
    await turns()
    expect(w.api.calls(ROUTE.refresh)).toHaveLength(asked)
  })
})

describe('useAuth', () => {
  test('signOut signs out, deletes the stored token and tells the server', async () => {
    const w = world({ signedIn: true })
    w.api.on(ROUTE.signOut, () => new Response(null, { status: 204 }))
    const { result } = w.render(() => useAuth())
    await waitFor(() => expect(result.current.isSignedIn).toBe(true))
    await act(async () => {
      await result.current.signOut()
    })
    expect(result.current).toMatchObject({ status: 'signed-out', isSignedIn: false })
    expect(w.storedToken()).toBeUndefined()
  })

  test('a sign-out the server was not told of rejects: the app is signed out and can say the session may live on', async () => {
    const w = world({ signedIn: true })
    w.api.on(ROUTE.signOut, () => {
      throw new TypeError('Network request failed')
    })
    const { result } = w.render(() => useAuth())
    await waitFor(() => expect(result.current.isSignedIn).toBe(true))
    let refused: unknown
    await act(async () => {
      refused = await result.current.signOut().catch((error: unknown) => error)
    })
    expect(refused).toMatchObject({ code: 'network.failed' })
    expect(result.current.status).toBe('signed-out')
    expect(w.storedToken()).toBeUndefined()

    // Asked again, the server is told with the token that was kept in memory for that.
    w.api.on(ROUTE.signOut, () => new Response(null, { status: 204 }))
    await act(async () => {
      await result.current.signOut()
    })
    expect(w.api.calls(ROUTE.signOut).at(-1)?.body).toEqual({ refreshToken: 'rt_1' })
  })
})

describe('useUser', () => {
  test('a user that could not be fetched is asked for once more, quietly', async () => {
    jest.useFakeTimers()
    const w = world({ signedIn: true })
    w.api.on(ROUTE.me, () => failure(503, 'service.unavailable'))
    const { result } = w.render(() => useUser())
    await turns()
    expect(result.current).toMatchObject({ isLoaded: true, isSignedIn: true, user: null })
    const asked = w.api.calls(ROUTE.me).length
    await act(async () => {
      jest.advanceTimersByTime(3_100)
    })
    await turns()
    expect(w.api.calls(ROUTE.me)).toHaveLength(asked + 1)
    expect(result.current.user).toBeNull()
    expect(w.client.state.status).toBe('signed-in')
  })
})

describe('the flow hooks', () => {
  test('sign up with a password and the emailed code: the screens in order, then signed in with the token in the secure store', async () => {
    const w = world()
    w.api.on(ROUTE.signUp, () =>
      started('sign_up', { status: 'needs_email_verification', destination: 'm***@northline.app' })
    )
    w.api.on(ROUTE.signUpResend, () =>
      attempt('sign_up', { status: 'needs_email_verification', destination: 'm***@northline.app' })
    )
    w.api.on(ROUTE.signUpVerify, () => completed('sign_up'))
    const { result } = w.render(() => ({ signUp: useSignUp(), auth: useAuth() }))
    expect(result.current.signUp).toMatchObject({
      step: null,
      screen: null,
      isPending: false,
      error: null,
    })
    await act(async () => {
      const step = await result.current.signUp.start({
        email: 'maya@northline.app',
        password: 'sturdy-Otter-plays-42-chess',
        firstName: 'Maya',
      })
      expect(step?.status).toBe('needs_email_verification')
    })
    expect(result.current.signUp.screen).toBe('needs_email_verification')
    expect(result.current.signUp.step).toMatchObject({ destination: 'm***@northline.app' })
    await act(async () => {
      expect((await result.current.signUp.resendCode())?.status).toBe('needs_email_verification')
      expect((await result.current.signUp.verifyEmail({ code: '123456' }))?.status).toBe('complete')
    })
    expect(result.current.signUp.screen).toBe('complete')
    expect(result.current.auth.isSignedIn).toBe(true)
    expect(w.storedToken()).toBe('rt_signed_in')
    expect(w.api.calls(ROUTE.signUp)[0]?.body).toEqual({
      email: 'maya@northline.app',
      password: 'sturdy-Otter-plays-42-chess',
      firstName: 'Maya',
    })
    // Every call after the start presents the attempt's secret, which the hook never exposes.
    expect(w.api.calls(ROUTE.signUpVerify)[0]?.headers.get('x-tula-attempt')).toBe(
      'tula_at_test_secret'
    )
    expect(JSON.stringify(result.current.signUp)).not.toContain('tula_at_test_secret')
  })

  test('sign in with the password; a wrong one is an error on the same screen', async () => {
    const w = world()
    w.api.on(ROUTE.signIn, () => started('sign_in', { status: 'needs_password' }))
    w.api.on(ROUTE.signInPassword, () => failure(401, 'auth.invalid_credentials'))
    const { result } = w.render(() => useSignIn())
    await act(async () => {
      await result.current.start({ identifier: 'maya@northline.app' })
    })
    expect(result.current.screen).toBe('needs_password')
    await act(async () => {
      expect(await result.current.submitPassword({ password: 'wrong' })).toBeNull()
    })
    expect(result.current).toMatchObject({
      screen: 'needs_password',
      isPending: false,
      error: { code: 'auth.invalid_credentials', status: 401 },
    })
    act(() => result.current.clearError())
    expect(result.current.error).toBeNull()

    w.api.on(ROUTE.signInPassword, () => completed('sign_in'))
    await act(async () => {
      await result.current.submitPassword({ password: 'sturdy-Otter-plays-42-chess' })
    })
    expect(result.current).toMatchObject({ screen: 'complete', error: null })
    expect(w.client.state.status).toBe('signed-in')
    expect(w.storedToken()).toBe('rt_signed_in')
  })

  test('sign in with an emailed code: nothing is sent until asked, then the code completes', async () => {
    const w = world()
    const offered = { status: 'needs_first_factor', strategies: ['password', 'email_code'] }
    w.api.on(ROUTE.signIn, () => started('sign_in', offered))
    w.api.on(ROUTE.signInPrepare, () =>
      attempt('sign_in', {
        ...offered,
        prepared: { strategy: 'email_code', destination: 'm***@northline.app' },
      })
    )
    w.api.on(ROUTE.signInAttempt, () => completed('sign_in'))
    const { result } = w.render(() => useSignIn())
    await act(async () => {
      await result.current.start({ identifier: 'maya@northline.app' })
    })
    expect(result.current.screen).toBe('needs_first_factor')
    expect(w.api.calls(ROUTE.signInPrepare)).toEqual([])
    await act(async () => {
      await result.current.prepareFirstFactor({ strategy: 'email_code' })
    })
    expect(result.current.step).toMatchObject({ prepared: { strategy: 'email_code' } })
    // A code is asked for, never a link: an app has no browser to honour one in.
    expect(w.api.calls(ROUTE.signInPrepare)[0]?.body).toEqual({ strategy: 'email_code' })
    await act(async () => {
      await result.current.attemptFirstFactor({ strategy: 'email_code', code: '123456' })
    })
    expect(w.api.calls(ROUTE.signInAttempt)[0]?.body).toEqual({
      strategy: 'email_code',
      code: '123456',
    })
    expect(result.current.screen).toBe('complete')
    expect(w.storedToken()).toBe('rt_signed_in')
  })

  test('the later steps of a sign-in: an unverified address, a second factor, an enrolment, an expired password', async () => {
    const w = world()
    const { result } = w.render(() => useSignIn())
    w.api.on(ROUTE.signIn, () => started('sign_in', { status: 'needs_password' }))
    await act(async () => {
      await result.current.start({ identifier: 'maya@northline.app' })
    })

    const unverified = { status: 'needs_email_verification', destination: 'm***@northline.app' }
    w.api.on(ROUTE.signInPassword, () => attempt('sign_in', unverified))
    w.api.on(ROUTE.signInResend, () => attempt('sign_in', unverified))
    const second = { status: 'needs_second_factor', options: ['totp', 'backup_code', 'sms_code'] }
    w.api.on(ROUTE.signInVerify, () => attempt('sign_in', second))
    w.api.on(ROUTE.signInSecondPrepare, () =>
      attempt('sign_in', { ...second, prepared: { method: 'sms_code', destination: '•••• 42' } })
    )
    const enrol = { status: 'needs_factor_enrolment', methods: ['totp'] }
    w.api.on(ROUTE.signInSecond, () => attempt('sign_in', enrol))
    w.api.on(ROUTE.signInTotpStart, () =>
      json(200, { factorId: 'factor_1', secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/x' })
    )
    const expired = { status: 'needs_new_password', reason: 'expired', strategies: [] }
    w.api.on(ROUTE.signInTotpConfirm, () =>
      attempt('sign_in', expired, { backupCodes: ['aaaa-bbbb', 'cccc-dddd'] })
    )
    w.api.on(ROUTE.signInNewPassword, () => completed('sign_in'))

    await act(async () => {
      await result.current.submitPassword({ password: 'x' })
    })
    expect(result.current.screen).toBe('needs_email_verification')
    await act(async () => {
      await result.current.resendCode()
      await result.current.verifyEmail({ code: '123456' })
    })
    expect(result.current.screen).toBe('needs_second_factor')
    await act(async () => {
      await result.current.prepareSecondFactor({ method: 'sms_code' })
    })
    expect(w.api.calls(ROUTE.signInSecondPrepare)[0]?.body).toEqual({ method: 'sms_code' })
    await act(async () => {
      await result.current.submitSecondFactor({ method: 'totp', code: '123456' })
    })
    expect(result.current.screen).toBe('needs_factor_enrolment')
    await act(async () => {
      const enrolment = await result.current.startTotpEnrolment()
      expect(enrolment).toMatchObject({ secret: 'JBSWY3DPEHPK3PXP' })
    })
    // The secret was handed to the caller and is kept by nothing the hook returns.
    expect(JSON.stringify(result.current)).not.toContain('JBSWY3DPEHPK3PXP')
    await act(async () => {
      const confirmed = await result.current.confirmTotpEnrolment({ code: '123456' })
      expect(confirmed?.backupCodes).toEqual(['aaaa-bbbb', 'cccc-dddd'])
    })
    expect(JSON.stringify(result.current)).not.toContain('aaaa-bbbb')
    expect(result.current.screen).toBe('needs_new_password')
    await act(async () => {
      await result.current.submitNewPassword({ password: 'a-new-Sturdy-otter-77' })
    })
    expect(result.current.screen).toBe('complete')
    expect(w.client.state.status).toBe('signed-in')
  })

  test('a failed enrolment action resolves null and leaves an error', async () => {
    const w = world()
    w.api.on(ROUTE.signIn, () =>
      started('sign_in', { status: 'needs_factor_enrolment', methods: ['totp'] })
    )
    w.api.on(ROUTE.signInTotpStart, () => failure(429, 'rate_limited'))
    w.api.on(ROUTE.signInTotpConfirm, () => failure(422, 'mfa.invalid_code'))
    const { result } = w.render(() => useSignIn())
    await act(async () => {
      await result.current.start({ identifier: 'maya@northline.app' })
      expect(await result.current.startTotpEnrolment()).toBeNull()
    })
    expect(result.current.error?.code).toBe('rate_limited')
    await act(async () => {
      expect(await result.current.confirmTotpEnrolment({ code: '000000' })).toBeNull()
    })
    expect(result.current).toMatchObject({
      screen: 'needs_factor_enrolment',
      error: { code: 'mfa.invalid_code' },
    })
  })

  test('reset a password: the code and the new password together, then a second factor', async () => {
    const w = world()
    w.api.on(ROUTE.reset, () =>
      started('password_reset', { status: 'needs_new_password', strategies: ['email_code'] })
    )
    w.api.on(ROUTE.resetResend, () =>
      attempt('password_reset', { status: 'needs_new_password', strategies: ['email_code'] })
    )
    const second = { status: 'needs_second_factor', options: ['sms_code'] }
    w.api.on(ROUTE.resetSubmit, () => attempt('password_reset', second))
    w.api.on(ROUTE.resetSecondPrepare, () => attempt('password_reset', second))
    w.api.on(ROUTE.resetSecond, () => completed('password_reset'))
    const { result } = w.render(() => useResetPassword())
    await act(async () => {
      await result.current.start({ email: 'maya@northline.app' })
    })
    expect(result.current.screen).toBe('needs_new_password')
    await act(async () => {
      await result.current.resendCode()
      await result.current.submit({ code: '123456', password: 'a-new-Sturdy-otter-77' })
    })
    expect(result.current.screen).toBe('needs_second_factor')
    await act(async () => {
      await result.current.prepareSecondFactor({ method: 'sms_code' })
      await result.current.submitSecondFactor({ method: 'sms_code', code: '123456' })
    })
    expect(result.current.screen).toBe('complete')
    expect(w.client.state.status).toBe('signed-in')
  })

  test('an action before start fails locally with flow.invalid_step and sends nothing', async () => {
    const w = world()
    const { result } = w.render(useFlows)
    await waitFor(() => expect(w.client.state.status).toBe('signed-out'))
    await act(async () => {
      expect(await result.current.signIn.submitPassword({ password: 'x' })).toBeNull()
      expect(await result.current.signUp.verifyEmail({ code: '123456' })).toBeNull()
      expect(await result.current.reset.submit({ code: '123456', password: 'x' })).toBeNull()
    })
    for (const flow of Object.values(result.current)) {
      expect(flow.error).toMatchObject({ code: 'flow.invalid_step', status: 0 })
    }
    expect(w.api.requests).toEqual([])
  })

  test('one action at a time: a second call while one is pending resolves null and sends nothing', async () => {
    const w = world()
    const waiting = held(w, ROUTE.signIn)
    const { result } = w.render(() => useSignIn())
    let first: Promise<unknown> = Promise.resolve()
    await act(async () => {
      first = result.current.start({ identifier: 'maya@northline.app' })
      expect(await result.current.start({ identifier: 'maya@northline.app' })).toBeNull()
    })
    expect(result.current.isPending).toBe(true)
    expect(w.api.calls(ROUTE.signIn)).toHaveLength(1)
    await act(async () => {
      waiting[0]?.(started('sign_in', { status: 'needs_password' }))
      await first
    })
    expect(result.current).toMatchObject({ screen: 'needs_password', isPending: false })
  })

  test('reset leaves the attempt: a late answer for it is dropped, and a late `complete` signs nobody in', async () => {
    const w = world()
    w.api.on(ROUTE.signIn, () => started('sign_in', { status: 'needs_password' }))
    const waiting = held(w, ROUTE.signInPassword)
    const { result } = w.render(() => useSignIn())
    let pending: Promise<unknown> = Promise.resolve()
    await act(async () => {
      await result.current.start({ identifier: 'maya@northline.app' })
    })
    await act(async () => {
      pending = result.current.submitPassword({ password: 'x' })
      await Promise.resolve()
    })
    act(() => result.current.reset())
    expect(result.current).toMatchObject({ step: null, screen: null, error: null })
    await act(async () => {
      waiting[0]?.(completed('sign_in'))
      await pending
    })
    expect(result.current).toMatchObject({
      step: null,
      screen: null,
      error: null,
      isPending: false,
    })
    expect(w.client.state.status).not.toBe('signed-in')
    expect(w.storedToken()).toBeUndefined()
  })

  test('a start answered after the screen was left is discarded: its attempt cannot be acted on', async () => {
    const w = world()
    const waiting = held(w, ROUTE.signIn)
    const { result } = w.render(() => useSignIn())
    let pending: Promise<unknown> = Promise.resolve()
    await act(async () => {
      pending = result.current.start({ identifier: 'maya@northline.app' })
      await Promise.resolve()
    })
    act(() => result.current.reset())
    await act(async () => {
      waiting[0]?.(started('sign_in', { status: 'needs_password' }))
      await pending
    })
    expect(result.current.step).toBeNull()
    await act(async () => {
      expect(await result.current.submitPassword({ password: 'x' })).toBeNull()
    })
    expect(result.current.error?.code).toBe('flow.invalid_step')
    expect(w.api.calls(ROUTE.signInPassword)).toEqual([])
  })

  test('reset lets go of a request under way: "start again" works at once, and the old answer changes nothing', async () => {
    const w = world()
    let starts = 0
    w.api.on(ROUTE.signIn, () => {
      starts += 1
      return started('sign_in', { status: 'needs_password' })
    })
    const waiting = held(w, ROUTE.signInPassword)
    const { result } = w.render(() => useSignIn())
    let abandoned: Promise<unknown> = Promise.resolve()
    await act(async () => {
      await result.current.start({ identifier: 'maya@northline.app' })
    })
    await act(async () => {
      abandoned = result.current.submitPassword({ password: 'x' })
      await Promise.resolve()
    })
    expect(result.current.isPending).toBe(true)
    act(() => result.current.reset())
    // Not waiting for a request nobody wants any more.
    expect(result.current.isPending).toBe(false)
    await act(async () => {
      expect(await result.current.start({ identifier: 'ana@northline.app' })).toEqual({
        status: 'needs_password',
      })
    })
    expect(starts).toBe(2)
    expect(result.current).toMatchObject({ screen: 'needs_password', isPending: false })
    // The abandoned request answers while the new attempt is on screen: nothing moves, and
    // its caller is not handed a step of an attempt that was left.
    await act(async () => {
      waiting[0]?.(completed('sign_in'))
      expect(await abandoned).toBeNull()
    })
    expect(result.current).toMatchObject({ screen: 'needs_password', isPending: false })
    expect(w.client.state.status).not.toBe('signed-in')
  })

  test('an abandoned request that answers does not free the place a later request holds', async () => {
    const w = world()
    w.api.on(ROUTE.signIn, () => started('sign_in', { status: 'needs_password' }))
    const waiting = held(w, ROUTE.signInPassword)
    const { result } = w.render(() => useSignIn())
    let abandoned: Promise<unknown> = Promise.resolve()
    let later: Promise<unknown> = Promise.resolve()
    await act(async () => {
      await result.current.start({ identifier: 'maya@northline.app' })
    })
    await act(async () => {
      abandoned = result.current.submitPassword({ password: 'x' })
      await Promise.resolve()
    })
    act(() => result.current.reset())
    await act(async () => {
      await result.current.start({ identifier: 'maya@northline.app' })
    })
    await act(async () => {
      later = result.current.submitPassword({ password: 'y' })
      await Promise.resolve()
    })
    await act(async () => {
      waiting[0]?.(failure(401, 'auth.invalid_credentials'))
      await abandoned
    })
    // Still the later request's turn: no error of the old one, still pending, no third request.
    expect(result.current).toMatchObject({ isPending: true, error: null })
    await act(async () => {
      expect(await result.current.submitPassword({ password: 'z' })).toBeNull()
    })
    expect(w.api.calls(ROUTE.signInPassword)).toHaveLength(2)
    await act(async () => {
      waiting[1]?.(completed('sign_in'))
      await later
    })
    expect(result.current).toMatchObject({ screen: 'complete', isPending: false })
  })

  test('a start that answers after a reset resolves null: its step is nobody’s', async () => {
    const w = world()
    const waiting = held(w, ROUTE.signIn)
    const { result } = w.render(() => useSignIn())
    let pending: Promise<unknown> = Promise.resolve('not settled')
    await act(async () => {
      pending = result.current.start({ identifier: 'maya@northline.app' })
      await Promise.resolve()
    })
    act(() => result.current.reset())
    await act(async () => {
      waiting[0]?.(started('sign_in', { status: 'needs_password' }))
      expect(await pending).toBeNull()
    })
  })

  test('an answer that arrives while the screen is hidden is kept: the step is current and nothing is left pending', async () => {
    const w = world()
    w.api.on(ROUTE.signIn, () => started('sign_in', { status: 'needs_password' }))
    const waiting = held(w, ROUTE.signInPassword)
    let seen: ReturnType<typeof useSignIn> | undefined
    function Probe() {
      seen = useSignIn()
      return null
    }
    // `<Activity mode="hidden">` runs every effect's cleanup and keeps the state.
    const tree = (mode: 'visible' | 'hidden') => (
      <TulaProvider client={w.client}>
        <Activity mode={mode}>
          <Probe />
        </Activity>
      </TulaProvider>
    )
    const view = render(tree('visible'))
    let pending: Promise<unknown> = Promise.resolve()
    await act(async () => {
      await seen?.start({ identifier: 'maya@northline.app' })
    })
    await act(async () => {
      pending = seen?.submitPassword({ password: 'x' }) ?? Promise.resolve()
      await Promise.resolve()
    })
    view.rerender(tree('hidden'))
    await act(async () => {
      waiting[0]?.(completed('sign_in'))
      await pending
    })
    view.rerender(tree('visible'))
    await turns()
    expect(seen).toMatchObject({ screen: 'complete', isPending: false, error: null })
  })

  test('starting again replaces the attempt, and the one it replaces is left', async () => {
    const w = world()
    let starts = 0
    w.api.on(ROUTE.signIn, () => {
      starts += 1
      return started('sign_in', {
        status: starts === 1 ? 'needs_password' : 'needs_first_factor',
        ...(starts === 1 ? {} : { strategies: ['email_code'] }),
      })
    })
    const { result } = w.render(() => useSignIn())
    await act(async () => {
      await result.current.start({ identifier: 'maya@northline.app' })
      await result.current.start({ identifier: 'ana@northline.app' })
    })
    expect(result.current.screen).toBe('needs_first_factor')
  })

  test('an answer that arrives after the screen is gone sets nothing', async () => {
    const w = world()
    const waiting = held(w, ROUTE.signIn)
    const { result, unmount } = w.render(() => useSignIn())
    let pending: Promise<unknown> = Promise.resolve()
    await act(async () => {
      pending = result.current.start({ identifier: 'maya@northline.app' })
      await Promise.resolve()
    })
    unmount()
    waiting[0]?.(failure(429, 'rate_limited'))
    expect(await pending).toBeNull()
    expect(result.current.error).toBeNull()
  })

  test('a failure that is not the API’s becomes one error type and shows no detail', async () => {
    const w = world()
    w.api.on(ROUTE.reset, () => {
      throw new RangeError('a bug, not an API answer: secret detail')
    })
    const { result } = w.render(() => useResetPassword())
    await act(async () => {
      await result.current.start({ email: 'maya@northline.app' })
    })
    expect(result.current.error?.message).not.toContain('secret detail')
    expect(['network.failed', 'internal']).toContain(result.current.error?.code ?? '')
  })

  test('a provider that is given another client starts every flow afresh', async () => {
    const a = world()
    const b = world()
    a.api.on(ROUTE.signIn, () => started('sign_in', { status: 'needs_password' }))
    let latest = undefined as unknown as ReturnType<typeof useSignIn>
    function Probe() {
      latest = useSignIn()
      return null
    }
    const tree = (client: World['client']) => (
      <TulaProvider client={client}>
        <Probe />
      </TulaProvider>
    )
    const { rerender } = render(tree(a.client))
    await act(async () => {
      await latest.start({ identifier: 'maya@northline.app' })
    })
    expect(latest.screen).toBe('needs_password')
    rerender(tree(b.client))
    await waitFor(() => expect(latest.step).toBeNull())
    await waitFor(() => expect(b.client.state.status).toBe('signed-out'))
  })
})

describe('a step this version does not know is drawn as "not supported"', () => {
  test.each([
    ['a status nobody has heard of', { status: 'needs_retina_scan' }],
    [
      'a first factor offered only as a passkey',
      { status: 'needs_first_factor', strategies: ['passkey'] },
    ],
    [
      'a second factor offered only as a passkey',
      { status: 'needs_second_factor', options: ['passkey'] },
    ],
    [
      'an enrolment of a factor it cannot enrol',
      { status: 'needs_factor_enrolment', methods: ['hardware_key'] },
    ],
    [
      'a new password asked for an unknown reason',
      { status: 'needs_new_password', reason: 'compromised', strategies: [] },
    ],
  ])(
    '%s: the step is kept as sent, the screen is not_supported, and nothing is sent for it',
    async (_name, step) => {
      const w = world()
      w.api.on(ROUTE.signIn, () => started('sign_in', step))
      const { result } = w.render(() => useSignIn())
      await act(async () => {
        expect(await result.current.start({ identifier: 'maya@northline.app' })).toEqual(
          step as never
        )
      })
      expect(result.current.screen).toBe('not_supported')
      expect(result.current.step).toEqual(step as never)
      expect(result.current.error).toBeNull()
      // The start, and no guessed action after it.
      expect(w.api.requests.map((request) => request.path)).toEqual(['/v1/client/sign-ins'])
      expect(w.client.state.status).not.toBe('signed-in')
      // Starting again is what the screen offers.
      act(() => result.current.reset())
      expect(result.current).toMatchObject({ step: null, screen: null })
    }
  )

  test('an unknown step in the middle of a flow, and in a sign-up and a reset', async () => {
    const w = world()
    w.api.on(ROUTE.signUp, () => started('sign_up', { status: 'needs_captcha' }))
    w.api.on(ROUTE.reset, () => started('password_reset', { status: 'needs_captcha' }))
    w.api.on(ROUTE.signIn, () => started('sign_in', { status: 'needs_password' }))
    w.api.on(ROUTE.signInPassword, () => attempt('sign_in', { status: 'needs_captcha' }))
    const { result } = w.render(useFlows)
    await act(async () => {
      await result.current.signUp.start({ email: 'maya@northline.app', password: 'x' })
      await result.current.reset.start({ email: 'maya@northline.app' })
      await result.current.signIn.start({ identifier: 'maya@northline.app' })
      await result.current.signIn.submitPassword({ password: 'x' })
    })
    for (const flow of Object.values(result.current)) {
      expect(flow.screen).toBe('not_supported')
      expect(flow.error).toBeNull()
    }
  })
})

describe('useSession', () => {
  test('lists the devices, signs one out and signs out the others', async () => {
    const w = world({ signedIn: true })
    let list = [device('session_1', true), device('session_2'), device('session_3')]
    w.api.on(ROUTE.sessions, () => json(200, { data: list }))
    w.api.on('DELETE /v1/client/sessions/session_2', () => {
      list = list.filter((entry) => entry.id !== 'session_2')
      return new Response(null, { status: 204 })
    })
    w.api.on(ROUTE.revokeOthers, () => {
      list = list.filter((entry) => entry.current)
      return json(200, { revoked: 1 })
    })
    const { result } = w.render(() => useSession(), true)
    expect(result.current).toMatchObject({ sessionId: null, sessions: null, error: null })
    await waitFor(() => expect(result.current.sessions).toHaveLength(3))
    expect(result.current).toMatchObject({ sessionId: 'session_1', isLoading: false })
    // StrictMode ran the effect twice; the second run joined the first request.
    expect(w.api.calls(ROUTE.sessions)).toHaveLength(1)

    await act(async () => {
      expect(await result.current.revoke('session_2')).toBe(true)
    })
    expect(result.current.sessions?.map((entry) => entry.id)).toEqual(['session_1', 'session_3'])
    await act(async () => {
      expect(await result.current.revokeOthers()).toBe(1)
    })
    expect(result.current.sessions?.map((entry) => entry.id)).toEqual(['session_1'])
    await act(async () => {
      await result.current.reload()
    })
    expect(result.current.error).toBeNull()
  })

  test('failures are an error, never a rejection, and the list is kept', async () => {
    const w = world({ signedIn: true })
    w.api.on(ROUTE.sessions, () => json(200, { data: [device('session_1', true)] }))
    w.api.on('DELETE /v1/client/sessions/session_9', () => failure(404, 'session.not_found'))
    w.api.on(ROUTE.revokeOthers, () => failure(403, 'auth.step_up_required'))
    const { result } = w.render(() => useSession())
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))
    await act(async () => {
      expect(await result.current.revoke('session_9')).toBe(false)
    })
    expect(result.current.error?.code).toBe('session.not_found')
    await act(async () => {
      expect(await result.current.revokeOthers()).toBeNull()
    })
    expect(result.current.error?.code).toBe('auth.step_up_required')
    expect(result.current.sessions).toHaveLength(1)

    w.api.on(ROUTE.sessions, () => failure(503, 'service.unavailable'))
    await act(async () => {
      await result.current.reload()
    })
    expect(result.current).toMatchObject({
      error: { code: 'service.unavailable' },
      isLoading: false,
    })
  })

  test('signed out: no list and no request', async () => {
    const w = world()
    const { result } = w.render(() => useSession())
    await waitFor(() => expect(w.client.state.status).toBe('signed-out'))
    await act(async () => {
      await result.current.reload()
    })
    expect(result.current).toMatchObject({ sessionId: null, sessions: null, isLoading: false })
    expect(w.api.requests).toEqual([])
  })

  test('sign out while the device list is on its way: the late list is not shown', async () => {
    const w = world({ signedIn: true })
    w.api.on(ROUTE.signOut, () => new Response(null, { status: 204 }))
    const waiting = held(w, ROUTE.sessions)
    const seen: (string[] | null)[] = []
    w.render(() => {
      const { sessions } = useSession()
      seen.push(sessions ? sessions.map((entry) => entry.id) : null)
    })
    await waitFor(() => expect(waiting).toHaveLength(1))
    await act(async () => {
      await w.client.session.signOut()
    })
    await act(async () => {
      waiting[0]?.(json(200, { data: [device('session_1', true)] }))
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(seen.filter((entry) => entry !== null)).toEqual([])
  })
})
