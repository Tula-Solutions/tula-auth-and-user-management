import { describe, expect, spyOn, test } from 'bun:test'
import { createClient } from './client'
import { isTulaError, type TulaError } from './errors'
import { memoryStorage } from './storage'
import {
  accessToken,
  deferred,
  type FakeApi,
  failure,
  fakeApi,
  fakeEnvironment,
  json,
  manualClock,
  sessionTokens,
  TEST_BASE_URL,
  TEST_KEY,
  TEST_USER,
} from './testing/fakes'
import type { AuthState, ClientKind, FlowStep } from './types'

const SECRET = 'tula_at_s3cr3t-of-the-attempt'
const EXPIRES = '2030-01-01T00:10:00.000Z'

function attempt(kind: string, step: FlowStep, extra: Record<string, unknown> = {}) {
  return { id: 'attempt_1', kind, expiresAt: EXPIRES, step, ...extra }
}

const WAITING_EMAIL: FlowStep = {
  status: 'needs_email_verification',
  destination: 'm***@northline.app',
  strategies: ['email_code'],
}
const COMPLETE: FlowStep = { status: 'complete', userId: 'user_1', sessionId: 'session_1' }

function setup(kind: ClientKind = 'server') {
  const api: FakeApi = fakeApi()
  api.on('GET /v1/client/me', () => json(200, TEST_USER))
  const states: AuthState[] = []
  const storage = memoryStorage()
  const tula = createClient(
    {
      publishableKey: TEST_KEY,
      baseUrl: TEST_BASE_URL,
      client: kind,
      fetch: api.fetch,
      onSessionChange: (state) => states.push(state),
      ...(kind === 'web' ? {} : { storage }),
    },
    fakeEnvironment(manualClock())
  )
  return { api, tula, states, storage }
}

async function caught(promise: Promise<unknown>): Promise<TulaError> {
  try {
    await promise
  } catch (error) {
    if (isTulaError(error)) {
      return error
    }
    throw error
  }
  throw new Error('expected the call to throw')
}

describe('sign-up flow', () => {
  test('start sends the form, exposes the step, and verifyEmail completes it and signs in', async () => {
    const { api, tula, states, storage } = setup()
    api.on('POST /v1/client/sign-ups', () =>
      json(200, attempt('sign_up', WAITING_EMAIL, { attemptSecret: SECRET }))
    )
    api.on('POST /v1/client/sign-ups/attempt_1/verify-email', () =>
      json(
        200,
        attempt('sign_up', COMPLETE, {
          session: sessionTokens('first', { refreshToken: 'rt_first' }),
        })
      )
    )
    const flow = await tula.signUp.start({
      email: 'maya@northline.app',
      password: 'correct horse battery',
      firstName: 'Maya',
    })
    expect(api.requests[0]?.body).toEqual({
      email: 'maya@northline.app',
      password: 'correct horse battery',
      firstName: 'Maya',
    })
    expect(flow.id).toBe('attempt_1')
    expect(flow.kind).toBe('sign_up')
    expect(flow.expiresAt).toBe(EXPIRES)
    expect(flow.step).toEqual(WAITING_EMAIL)
    expect(tula.state.status).toBe('loading')

    const step = await flow.verifyEmail({ code: '123456' })
    expect(step).toEqual(COMPLETE)
    expect(flow.step).toEqual(COMPLETE)
    expect(api.requests[1]?.body).toEqual({ code: '123456' })
    expect(api.requests[1]?.headers.get('x-tula-attempt')).toBe(SECRET)
    expect(tula.state).toEqual({ status: 'signed-in', sessionId: 'session_1', user: TEST_USER })
    expect(states).toHaveLength(1)
    expect(await tula.session.getToken()).toBe(accessToken('first'))
    expect(await storage.get(`tula.refresh.${TEST_BASE_URL}|${TEST_KEY}`)).toBe('rt_first')
  })

  test('resendCode sends the secret and no body, and keeps the step', async () => {
    const { api, tula } = setup()
    api.on('POST /v1/client/sign-ups', () =>
      json(200, attempt('sign_up', WAITING_EMAIL, { attemptSecret: SECRET }))
    )
    api.on('POST /v1/client/sign-ups/attempt_1/resend-code', () =>
      json(200, attempt('sign_up', WAITING_EMAIL))
    )
    const flow = await tula.signUp.start({ email: 'maya@northline.app', password: 'pw' })
    expect(await flow.resendCode()).toEqual(WAITING_EMAIL)
    expect(api.requests[1]?.body).toBeUndefined()
    expect(api.requests[1]?.headers.get('x-tula-attempt')).toBe(SECRET)
  })

  test('a failed step throws and leaves the flow where it was, ready for another try', async () => {
    const { api, tula } = setup()
    api.on('POST /v1/client/sign-ups', () =>
      json(200, attempt('sign_up', WAITING_EMAIL, { attemptSecret: SECRET }))
    )
    api.on('POST /v1/client/sign-ups/attempt_1/verify-email', () =>
      failure(422, 'verification.invalid_code')
    )
    const flow = await tula.signUp.start({ email: 'maya@northline.app', password: 'pw' })
    const error = await caught(flow.verifyEmail({ code: '000000' }))
    expect(error).toMatchObject({
      code: 'verification.invalid_code',
      message: 'That code is incorrect.',
    })
    expect(flow.step).toEqual(WAITING_EMAIL)
    expect(tula.state.status).toBe('loading')
  })

  test('a start without an attempt secret is refused at once', async () => {
    const { api, tula } = setup()
    api.on('POST /v1/client/sign-ups', () => json(200, attempt('sign_up', WAITING_EMAIL)))
    expect(await caught(tula.signUp.start({ email: 'a@b.co', password: 'pw' }))).toMatchObject({
      code: 'response.invalid',
    })
  })
})

describe('sign-in flow', () => {
  test('password, then email verification, then complete', async () => {
    const { api, tula } = setup()
    api.on('POST /v1/client/sign-ins', () =>
      json(200, attempt('sign_in', { status: 'needs_password' }, { attemptSecret: SECRET }))
    )
    api.on('POST /v1/client/sign-ins/attempt_1/password', () =>
      json(200, attempt('sign_in', WAITING_EMAIL))
    )
    api.on('POST /v1/client/sign-ins/attempt_1/resend-code', () =>
      json(200, attempt('sign_in', WAITING_EMAIL))
    )
    api.on('POST /v1/client/sign-ins/attempt_1/verify-email', () =>
      json(
        200,
        attempt('sign_in', COMPLETE, { session: sessionTokens('in', { refreshToken: 'rt' }) })
      )
    )
    const flow = await tula.signIn.start({ identifier: 'maya@northline.app' })
    expect(flow.kind).toBe('sign_in')
    expect(flow.step).toEqual({ status: 'needs_password' })
    expect(await flow.submitPassword({ password: 'pw' })).toEqual(WAITING_EMAIL)
    expect(await flow.resendCode()).toEqual(WAITING_EMAIL)
    expect((await flow.verifyEmail({ code: '123456' })).status).toBe('complete')
    expect(api.requests.map((request) => request.body)).toEqual([
      { identifier: 'maya@northline.app' },
      { password: 'pw' },
      undefined,
      { code: '123456' },
    ])
    expect(
      api.requests.slice(1, 4).every((request) => request.headers.get('x-tula-attempt') === SECRET)
    ).toBe(true)
    expect(tula.state.status).toBe('signed-in')
  })

  test('the steps of a later protocol reach the app as they are: first-factor choice and second factor', async () => {
    const { api, tula } = setup()
    api.on('POST /v1/client/sign-ins', () =>
      json(
        200,
        attempt(
          'sign_in',
          { status: 'needs_first_factor', strategies: ['password', 'email_code'] },
          { attemptSecret: SECRET }
        )
      )
    )
    api.on('POST /v1/client/sign-ins/attempt_1/password', () =>
      json(200, attempt('sign_in', { status: 'needs_second_factor', options: ['totp'] }))
    )
    const flow = await tula.signIn.start({ identifier: 'maya@northline.app' })
    expect(flow.step).toEqual({
      status: 'needs_first_factor',
      strategies: ['password', 'email_code'],
    })
    const step = await flow.submitPassword({ password: 'pw' })
    expect(step).toEqual({ status: 'needs_second_factor', options: ['totp'] })
    // No session until the second factor is proven.
    expect(tula.state.status).toBe('loading')
    expect(await tula.session.getToken()).toBeNull()
  })

  test('a start that is already complete signs in', async () => {
    const { api, tula } = setup()
    api.on('POST /v1/client/sign-ins', () =>
      json(
        200,
        attempt('sign_in', COMPLETE, {
          attemptSecret: SECRET,
          session: sessionTokens('direct', { refreshToken: 'rt' }),
        })
      )
    )
    const flow = await tula.signIn.start({ identifier: 'maya@northline.app' })
    expect(flow.step.status).toBe('complete')
    expect(tula.state.status).toBe('signed-in')
  })

  test('the server decides what is valid: the SDK sends a step even when it looks out of order', async () => {
    const { api, tula } = setup()
    api.on('POST /v1/client/sign-ins', () =>
      json(200, attempt('sign_in', { status: 'needs_password' }, { attemptSecret: SECRET }))
    )
    api.on('POST /v1/client/sign-ins/attempt_1/verify-email', () =>
      failure(409, 'flow.invalid_step')
    )
    const flow = await tula.signIn.start({ identifier: 'maya@northline.app' })
    expect(await caught(flow.verifyEmail({ code: '123456' }))).toMatchObject({
      code: 'flow.invalid_step',
      status: 409,
    })
  })

  test('a completed web flow carries no refresh token: the cookie has it', async () => {
    const { api, tula } = setup('web')
    api.on('POST /v1/client/sign-ins', () =>
      json(200, attempt('sign_in', { status: 'needs_password' }, { attemptSecret: SECRET }))
    )
    api.on('POST /v1/client/sign-ins/attempt_1/password', () =>
      json(200, attempt('sign_in', COMPLETE, { session: sessionTokens('web') }))
    )
    const flow = await tula.signIn.start({ identifier: 'maya@northline.app' })
    await flow.submitPassword({ password: 'pw' })
    expect(tula.state.status).toBe('signed-in')
    expect(api.requests[0]?.headers.get('x-tula-client')).toBe('web')
  })

  test('if the session cannot be stored the step still completes in memory and the error says so', async () => {
    const { api, tula, storage } = setup()
    api.on('POST /v1/client/sign-ins', () =>
      json(200, attempt('sign_in', { status: 'needs_password' }, { attemptSecret: SECRET }))
    )
    api.on('POST /v1/client/sign-ins/attempt_1/password', () =>
      json(
        200,
        attempt('sign_in', COMPLETE, { session: sessionTokens('kept', { refreshToken: 'rt' }) })
      )
    )
    const set = spyOn(storage, 'set').mockRejectedValueOnce(new Error('disk full'))
    const flow = await tula.signIn.start({ identifier: 'maya@northline.app' })
    expect(await caught(flow.submitPassword({ password: 'pw' }))).toMatchObject({
      code: 'storage.failed',
    })
    expect(flow.step.status).toBe('complete')
    expect(tula.state.status).toBe('signed-in')
    expect(await tula.session.getToken()).toBe(accessToken('kept'))
    set.mockRestore()
  })
})

describe('a sign-in with an expired password', () => {
  const EXPIRED: FlowStep = {
    status: 'needs_new_password',
    destination: 'm***@northline.app',
    strategies: [],
    reason: 'expired',
  }

  test('stops signed out on needs_new_password, and submitNewPassword completes it', async () => {
    const { api, tula } = setup()
    api.on('POST /v1/client/sign-ins', () =>
      json(200, attempt('sign_in', { status: 'needs_password' }, { attemptSecret: SECRET }))
    )
    api.on('POST /v1/client/sign-ins/attempt_1/password', () =>
      json(200, attempt('sign_in', EXPIRED))
    )
    api.on('POST /v1/client/sign-ins/attempt_1/new-password', () =>
      json(
        200,
        attempt('sign_in', COMPLETE, { session: sessionTokens('renewed', { refreshToken: 'rt' }) })
      )
    )
    const flow = await tula.signIn.start({ identifier: 'maya@northline.app' })
    expect(await flow.submitPassword({ password: 'old pw' })).toEqual(EXPIRED)
    expect(flow.step).toEqual(EXPIRED)
    expect(tula.state.status).not.toBe('signed-in')

    expect(await flow.submitNewPassword({ password: 'a new pw' })).toEqual(COMPLETE)
    const sent = api.calls('POST /v1/client/sign-ins/attempt_1/new-password')[0]
    expect(sent?.body).toEqual({ password: 'a new pw' })
    expect(sent?.headers.get('x-tula-attempt')).toBe(SECRET)
    expect(tula.state.status).toBe('signed-in')
    expect(await tula.session.getToken()).toBe(accessToken('renewed'))
  })

  test('a refused password leaves the flow on the step, with the server’s field errors', async () => {
    const { api, tula } = setup()
    api.on('POST /v1/client/sign-ins', () =>
      json(200, attempt('sign_in', { status: 'needs_password' }, { attemptSecret: SECRET }))
    )
    api.on('POST /v1/client/sign-ins/attempt_1/password', () =>
      json(200, attempt('sign_in', EXPIRED))
    )
    api.on('POST /v1/client/sign-ins/attempt_1/new-password', () =>
      json(422, {
        status: 422,
        code: 'password.reused',
        detail: 'x',
        params: { history: 1 },
        errors: [
          { field: 'password', code: 'password.reused', message: 'x', params: { history: 1 } },
        ],
      })
    )
    const flow = await tula.signIn.start({ identifier: 'maya@northline.app' })
    await flow.submitPassword({ password: 'old pw' })
    const error = await caught(flow.submitNewPassword({ password: 'old pw' }))
    expect(error).toMatchObject({ code: 'password.reused', params: { history: 1 } })
    expect(flow.step).toEqual(EXPIRED)
    expect(tula.state.status).not.toBe('signed-in')
  })
})

describe('password reset flow', () => {
  test('submit sends the code and the new password together and signs in', async () => {
    const { api, tula } = setup()
    const waiting: FlowStep = {
      status: 'needs_new_password',
      destination: 'm***@northline.app',
      strategies: ['email_code'],
    }
    api.on('POST /v1/client/password-resets', () =>
      json(200, attempt('password_reset', waiting, { attemptSecret: SECRET }))
    )
    api.on('POST /v1/client/password-resets/attempt_1/resend-code', () =>
      json(200, attempt('password_reset', waiting))
    )
    api.on('POST /v1/client/password-resets/attempt_1/password', () =>
      json(
        200,
        attempt('password_reset', COMPLETE, {
          session: sessionTokens('reset', { refreshToken: 'rt' }),
        })
      )
    )
    const flow = await tula.resetPassword.start({ email: 'maya@northline.app' })
    expect(flow.kind).toBe('password_reset')
    expect(flow.step).toEqual(waiting)
    expect(await flow.resendCode()).toEqual(waiting)
    expect((await flow.submit({ code: '123456', password: 'a new long password' })).status).toBe(
      'complete'
    )
    expect(api.requests[2]?.body).toEqual({ code: '123456', password: 'a new long password' })
    expect(api.requests[2]?.headers.get('x-tula-attempt')).toBe(SECRET)
    expect(tula.state.status).toBe('signed-in')
  })
})

describe('the attempt secret stays inside the flow', () => {
  test('it is not a property, not in JSON, not in a console rendering, and not in storage', async () => {
    const { api, tula, storage } = setup()
    api.on('POST /v1/client/sign-ins', () =>
      json(200, attempt('sign_in', { status: 'needs_password' }, { attemptSecret: SECRET }))
    )
    api.on('POST /v1/client/sign-ins/attempt_1/password', () =>
      json(
        200,
        attempt('sign_in', COMPLETE, { session: sessionTokens('s', { refreshToken: 'rt_secret' }) })
      )
    )
    const get = spyOn(storage, 'get')
    const set = spyOn(storage, 'set')
    const flow = await tula.signIn.start({ identifier: 'maya@northline.app' })
    await flow.submitPassword({ password: 'pw' })

    expect(flow.toJSON()).toEqual({
      id: 'attempt_1',
      kind: 'sign_in',
      step: COMPLETE,
      expiresAt: EXPIRES,
    })
    expect(Object.keys(flow).sort()).toEqual(
      [
        'attemptFirstFactor',
        'confirmTotpEnrolment',
        'discard',
        'expiresAt',
        'id',
        'kind',
        'prepareFirstFactor',
        'prepareSecondFactor',
        'resendCode',
        'startTotpEnrolment',
        'step',
        'submitNewPassword',
        'submitPassword',
        'submitSecondFactor',
        'submitSecondFactorWithPasskey',
        'toJSON',
        'verifyEmail',
        'waitForEmailLink',
      ].sort()
    )
    const renderings = [
      JSON.stringify(flow),
      Bun.inspect(flow, { depth: 10 }),
      String(flow),
      JSON.stringify(Object.getOwnPropertyDescriptors(flow)),
    ].join('\n')
    expect(renderings).not.toContain(SECRET)
    // A completed flow does not keep the session's tokens either.
    expect(renderings).not.toContain('rt_secret')
    expect(renderings).not.toContain(accessToken('s'))
    expect(JSON.stringify([...get.mock.calls, ...set.mock.calls])).not.toContain(SECRET)
    expect(Object.isFrozen(flow)).toBe(true)
  })

  test('a failed step’s error does not contain it', async () => {
    const { api, tula } = setup()
    api.on('POST /v1/client/sign-ins', () =>
      json(200, attempt('sign_in', { status: 'needs_password' }, { attemptSecret: SECRET }))
    )
    api.on('POST /v1/client/sign-ins/attempt_1/password', () =>
      Promise.reject(new TypeError('offline'))
    )
    const flow = await tula.signIn.start({ identifier: 'maya@northline.app' })
    const error = await caught(flow.submitPassword({ password: 'pw' }))
    expect(JSON.stringify(error) + String(error.stack) + Bun.inspect(error)).not.toContain(SECRET)
  })

  test('two flows keep their own secrets', async () => {
    const { api, tula } = setup()
    let started = 0
    api.on('POST /v1/client/sign-ins', () => {
      started += 1
      return json(200, {
        ...attempt('sign_in', { status: 'needs_password' }, { attemptSecret: `secret_${started}` }),
        id: `attempt_${started}`,
      })
    })
    api.on('POST /v1/client/sign-ins/attempt_1/password', () =>
      failure(401, 'auth.invalid_credentials')
    )
    api.on('POST /v1/client/sign-ins/attempt_2/password', () =>
      failure(401, 'auth.invalid_credentials')
    )
    const first = await tula.signIn.start({ identifier: 'a@b.co' })
    const second = await tula.signIn.start({ identifier: 'c@d.co' })
    await caught(second.submitPassword({ password: 'pw' }))
    await caught(first.submitPassword({ password: 'pw' }))
    expect(api.requests.slice(2).map((request) => request.headers.get('x-tula-attempt'))).toEqual([
      'secret_2',
      'secret_1',
    ])
  })
})

describe('answers are checked before a flow is built or a session installed (review F4)', () => {
  test.each([
    ['an empty object', {}],
    [
      'no id',
      {
        kind: 'sign_in',
        expiresAt: EXPIRES,
        step: { status: 'needs_password' },
        attemptSecret: SECRET,
      },
    ],
    ['no step', { id: 'a', kind: 'sign_in', expiresAt: EXPIRES, attemptSecret: SECRET }],
    [
      'a step without a status',
      { id: 'a', kind: 'sign_in', expiresAt: EXPIRES, step: {}, attemptSecret: SECRET },
    ],
    ['an array', []],
  ] as [string, unknown][])('a start answered with %s is response.invalid', async (_name, body) => {
    const { api, tula } = setup()
    api.on('POST /v1/client/sign-ins', () => json(200, body))
    expect(await caught(tula.signIn.start({ identifier: 'a@b.co' }))).toMatchObject({
      code: 'response.invalid',
      status: 0,
    })
    expect(tula.state.status).toBe('loading')
  })

  test.each([
    ['no session', {}],
    ['a session without tokens', { session: {} }],
    [
      'a session with no session id',
      { session: { accessToken: 'a.b.c', accessTokenExpiresAt: EXPIRES } },
    ],
  ] as [string, Record<string, unknown>][])(
    'a complete step with %s is response.invalid: the flow does not move and nobody is signed in',
    async (_name, extra) => {
      const { api, tula, states, storage } = setup()
      api.on('POST /v1/client/sign-ins', () =>
        json(200, attempt('sign_in', { status: 'needs_password' }, { attemptSecret: SECRET }))
      )
      api.on('POST /v1/client/sign-ins/attempt_1/password', () =>
        json(200, attempt('sign_in', COMPLETE, extra))
      )
      const set = spyOn(storage, 'set')
      const flow = await tula.signIn.start({ identifier: 'a@b.co' })
      expect(await caught(flow.submitPassword({ password: 'pw' }))).toMatchObject({
        code: 'response.invalid',
      })
      expect(flow.step).toEqual({ status: 'needs_password' })
      expect(tula.state.status).toBe('loading')
      expect(states).toEqual([])
      expect(set).not.toHaveBeenCalled()
      set.mockRestore()
    }
  )

  test('a step answered with something that is not an attempt leaves the flow as it was', async () => {
    const { api, tula } = setup()
    api.on('POST /v1/client/sign-ins', () =>
      json(200, attempt('sign_in', { status: 'needs_password' }, { attemptSecret: SECRET }))
    )
    api.on('POST /v1/client/sign-ins/attempt_1/password', () => json(200, { ok: true }))
    const flow = await tula.signIn.start({ identifier: 'a@b.co' })
    expect(await caught(flow.submitPassword({ password: 'pw' }))).toMatchObject({
      code: 'response.invalid',
    })
    expect(flow.step).toEqual({ status: 'needs_password' })
  })
})

describe('a flow sends one action at a time, and none once it is complete (review F6)', () => {
  async function completed() {
    const context = setup()
    context.api.on('POST /v1/client/sign-ins', () =>
      json(200, attempt('sign_in', { status: 'needs_password' }, { attemptSecret: SECRET }))
    )
    context.api.on('POST /v1/client/sign-ins/attempt_1/password', () =>
      json(
        200,
        attempt('sign_in', COMPLETE, { session: sessionTokens('done', { refreshToken: 'rt' }) })
      )
    )
    const flow = await context.tula.signIn.start({ identifier: 'a@b.co' })
    await flow.submitPassword({ password: 'pw' })
    return { ...context, flow }
  }

  test('every action on a completed flow is refused locally, without a request', async () => {
    const { api, flow } = await completed()
    const requests = api.requests.length
    for (const action of [
      () => flow.submitPassword({ password: 'pw' }),
      () => flow.verifyEmail({ code: '123456' }),
      () => flow.resendCode(),
    ]) {
      expect(await caught(action())).toMatchObject({
        code: 'flow.invalid_step',
        status: 0,
        message: 'That action is not valid at this step. Please start again.',
      })
    }
    expect(api.requests).toHaveLength(requests)
  })

  test('a completed flow no longer holds its secret: a later request cannot carry it', async () => {
    const { api, flow } = await completed()
    await caught(flow.resendCode())
    expect(
      api.requests.filter((request) => request.headers.get('x-tula-attempt') === SECRET)
    ).toHaveLength(1)
  })

  test('a second action while one is in flight is flow.busy, locally; the first is unaffected', async () => {
    const { api, tula } = setup()
    api.on('POST /v1/client/sign-ins', () =>
      json(200, attempt('sign_in', { status: 'needs_password' }, { attemptSecret: SECRET }))
    )
    let answer: (response: Response) => void = () => undefined
    api.on(
      'POST /v1/client/sign-ins/attempt_1/password',
      () => new Promise<Response>((resolve) => (answer = resolve))
    )
    const flow = await tula.signIn.start({ identifier: 'a@b.co' })
    const first = flow.submitPassword({ password: 'pw' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const busy = await caught(flow.submitPassword({ password: 'pw' }))
    expect(busy).toMatchObject({ code: 'flow.busy', status: 0 })
    expect(busy.message).toBe(
      'Another step of this flow is still being sent. Wait for it to finish.'
    )
    expect((await caught(flow.resendCode())).code).toBe('flow.busy')
    expect(api.requests).toHaveLength(2)
    answer(failure(401, 'auth.invalid_credentials'))
    expect((await caught(first)).code).toBe('auth.invalid_credentials')
    // The failed action released the flow.
    answer = () => undefined
    const retry = flow.submitPassword({ password: 'pw' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(api.requests).toHaveLength(3)
    answer(
      json(
        200,
        attempt('sign_in', COMPLETE, { session: sessionTokens('ok', { refreshToken: 'rt' }) })
      )
    )
    expect((await retry).status).toBe('complete')
  })
})

const NEEDS_SECOND: FlowStep = { status: 'needs_second_factor', options: ['totp', 'backup_code'] }
const NEEDS_ENROLMENT: FlowStep = { status: 'needs_factor_enrolment', methods: ['totp'] }
const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
const TOTP_URI = `otpauth://totp/Tula:maya%40northline.app?secret=${TOTP_SECRET}&issuer=Tula`
const BACKUP_CODES = ['2a3b4-c5d6e', '7f8g9-h2j3k', 'm4n5p-q6r7s']
/** Everything a flow hands over once and must keep nowhere. */
const HANDED_OVER = [TOTP_SECRET, TOTP_URI, ...BACKUP_CODES]

/** A sign-in that has reached `needs_second_factor`. */
async function atSecondFactor(context: ReturnType<typeof setup>) {
  context.api.on('POST /v1/client/sign-ins', () =>
    json(200, attempt('sign_in', NEEDS_SECOND, { attemptSecret: SECRET }))
  )
  return context.tula.signIn.start({ identifier: 'maya@northline.app' })
}

describe('second factor in a flow', () => {
  const ROUTE = 'POST /v1/client/sign-ins/attempt_1/second-factor'

  test('submitSecondFactor sends the method and code with the secret, completes the flow and signs in', async () => {
    const context = setup()
    const { api, tula } = context
    const flow = await atSecondFactor(context)
    expect(tula.state.status).toBe('loading')
    api.on(ROUTE, () =>
      json(
        200,
        attempt('sign_in', COMPLETE, { session: sessionTokens('mfa', { refreshToken: 'rt_mfa' }) })
      )
    )
    const result = await flow.submitSecondFactor({ method: 'totp', code: '123456' })
    expect(result).toEqual({ step: COMPLETE })
    expect(api.calls(ROUTE)[0]?.body).toEqual({ method: 'totp', code: '123456' })
    expect(api.calls(ROUTE)[0]?.headers.get('x-tula-attempt')).toBe(SECRET)
    expect(flow.step).toEqual(COMPLETE)
    expect(tula.state).toMatchObject({ status: 'signed-in', sessionId: 'session_1' })
    expect(await tula.session.getToken()).toBe(accessToken('mfa'))
  })

  test('a backup code answers how many are left, to the caller only', async () => {
    const context = setup()
    const flow = await atSecondFactor(context)
    context.api.on(ROUTE, () =>
      json(
        200,
        attempt('sign_in', COMPLETE, {
          session: sessionTokens('mfa', { refreshToken: 'rt_mfa' }),
          backupCodesRemaining: 9,
        })
      )
    )
    expect(await flow.submitSecondFactor({ method: 'backup_code', code: '2a3b4-c5d6e' })).toEqual({
      step: COMPLETE,
      backupCodesRemaining: 9,
    })
    expect(context.api.calls(ROUTE)[0]?.body).toEqual({
      method: 'backup_code',
      code: '2a3b4-c5d6e',
    })
    expect(JSON.stringify(flow)).not.toContain('backupCodesRemaining')
    expect(JSON.stringify(flow)).not.toContain('2a3b4')
  })

  test('a wrong code is mfa.invalid_code, leaves the step and signs nobody in; the next try works', async () => {
    const context = setup()
    const { api, tula, states } = context
    const flow = await atSecondFactor(context)
    api.on(ROUTE, () => failure(422, 'mfa.invalid_code'))
    expect(await caught(flow.submitSecondFactor({ method: 'totp', code: '000000' }))).toMatchObject(
      { code: 'mfa.invalid_code', status: 422, message: 'That code is incorrect.' }
    )
    expect(flow.step).toEqual(NEEDS_SECOND)
    expect(tula.state.status).toBe('loading')
    expect(states).toEqual([])

    api.on(ROUTE, () =>
      failure(429, 'rate_limited', { params: { retryAfter: 30 } }, { 'retry-after': '30' })
    )
    expect(await caught(flow.submitSecondFactor({ method: 'totp', code: '000000' }))).toMatchObject(
      { code: 'rate_limited', retryAfterMs: 30_000 }
    )

    api.on(ROUTE, () => json(200, attempt('sign_in', COMPLETE, { session: sessionTokens('ok') })))
    expect((await flow.submitSecondFactor({ method: 'totp', code: '123456' })).step).toEqual(
      COMPLETE
    )
  })

  test.each([['nine'], [-1], [1.5], [null]])(
    'a completed answer whose backupCodesRemaining is %p is response.invalid and signs nobody in',
    async (remaining) => {
      const context = setup()
      const flow = await atSecondFactor(context)
      context.api.on(ROUTE, () =>
        json(
          200,
          attempt('sign_in', COMPLETE, {
            session: sessionTokens('mfa'),
            backupCodesRemaining: remaining,
          })
        )
      )
      expect(
        await caught(flow.submitSecondFactor({ method: 'backup_code', code: 'x' }))
      ).toMatchObject({ code: 'response.invalid', status: 0 })
      expect(flow.step).toEqual(NEEDS_SECOND)
      expect(context.tula.state.status).toBe('loading')
      expect(await context.tula.session.getToken().catch(() => 'no token')).not.toBe(
        accessToken('mfa')
      )
    }
  )

  test('a 200 that is not an attempt is response.invalid', async () => {
    const context = setup()
    const flow = await atSecondFactor(context)
    context.api.on(ROUTE, () => json(200, ['not', 'an', 'attempt']))
    expect(await caught(flow.submitSecondFactor({ method: 'totp', code: '123456' }))).toMatchObject(
      { code: 'response.invalid' }
    )
    expect(flow.step).toEqual(NEEDS_SECOND)
  })

  test('a second submit while one is in flight is flow.busy, and one after completion flow.invalid_step; neither sends a request', async () => {
    const context = setup()
    const flow = await atSecondFactor(context)
    let release!: (response: Response) => void
    context.api.on(
      ROUTE,
      () =>
        new Promise<Response>((resolve) => {
          release = resolve
        })
    )
    const first = flow.submitSecondFactor({ method: 'totp', code: '123456' })
    expect(await caught(flow.submitSecondFactor({ method: 'totp', code: '123456' }))).toMatchObject(
      { code: 'flow.busy', status: 0 }
    )
    expect(await caught(flow.startTotpEnrolment())).toMatchObject({ code: 'flow.busy' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    release(json(200, attempt('sign_in', COMPLETE, { session: sessionTokens('ok') })))
    await first
    expect(await caught(flow.submitSecondFactor({ method: 'totp', code: '123456' }))).toMatchObject(
      { code: 'flow.invalid_step', status: 0 }
    )
    expect(context.api.calls(ROUTE)).toHaveLength(1)
  })

  test('a password reset that stops at the second factor is completed the same way', async () => {
    const { api, tula } = setup()
    api.on('POST /v1/client/password-resets', () =>
      json(
        200,
        attempt(
          'password_reset',
          {
            status: 'needs_new_password',
            destination: 'm***@northline.app',
            strategies: ['email_code'],
          },
          { attemptSecret: SECRET }
        )
      )
    )
    api.on('POST /v1/client/password-resets/attempt_1/password', () =>
      json(200, attempt('password_reset', NEEDS_SECOND))
    )
    const route = 'POST /v1/client/password-resets/attempt_1/second-factor'
    api.on(route, () =>
      json(
        200,
        attempt('password_reset', COMPLETE, {
          session: sessionTokens('reset'),
          backupCodesRemaining: 0,
        })
      )
    )
    const flow = await tula.resetPassword.start({ email: 'maya@northline.app' })
    expect(await flow.submit({ code: '123456', password: 'a new long password' })).toEqual(
      NEEDS_SECOND
    )
    expect(tula.state.status).toBe('loading')
    expect(await flow.submitSecondFactor({ method: 'backup_code', code: 'abcde-fghij' })).toEqual({
      step: COMPLETE,
      backupCodesRemaining: 0,
    })
    expect(api.calls(route)[0]?.headers.get('x-tula-attempt')).toBe(SECRET)
    expect(tula.state.status).toBe('signed-in')
  })
})

describe('enrolling an authenticator inside a flow (policy: required)', () => {
  type Context = ReturnType<typeof setup>
  const KINDS = [
    [
      'sign_up',
      'sign-ups',
      ({ tula }: Context) => tula.signUp.start({ email: 'maya@northline.app', password: 'pw' }),
    ],
    [
      'sign_in',
      'sign-ins',
      ({ tula }: Context) => tula.signIn.start({ identifier: 'maya@northline.app' }),
    ],
    [
      'password_reset',
      'password-resets',
      ({ tula }: Context) => tula.resetPassword.start({ email: 'maya@northline.app' }),
    ],
  ] as const

  test.each(KINDS)(
    '%s: start hands over the secret and URI, confirm completes the flow and hands over the backup codes; nothing keeps them',
    async (kind, path, start) => {
      const context = setup()
      const { api, tula, storage } = context
      const set = spyOn(storage, 'set')
      api.on(`POST /v1/client/${path}`, () =>
        json(200, attempt(kind, NEEDS_ENROLMENT, { attemptSecret: SECRET }))
      )
      const startRoute = `POST /v1/client/${path}/attempt_1/factor-enrolment/totp`
      const confirmRoute = `${startRoute}/confirm`
      api.on(startRoute, () => json(200, { secret: TOTP_SECRET, uri: TOTP_URI, extra: 'ignored' }))
      api.on(confirmRoute, () =>
        json(
          200,
          attempt(kind, COMPLETE, {
            session: sessionTokens('enrolled', { refreshToken: 'rt_enrolled' }),
            backupCodes: BACKUP_CODES,
          })
        )
      )
      const flow = await start(context)
      expect(flow.step).toEqual(NEEDS_ENROLMENT)

      expect(await flow.startTotpEnrolment()).toEqual({ secret: TOTP_SECRET, uri: TOTP_URI })
      expect(api.calls(startRoute)[0]?.headers.get('x-tula-attempt')).toBe(SECRET)
      expect(api.calls(startRoute)[0]?.body).toBeUndefined()
      // Starting does not move the flow, and may be repeated (it replaces the pending secret).
      expect(flow.step).toEqual(NEEDS_ENROLMENT)
      await flow.startTotpEnrolment()
      expect(api.calls(startRoute)).toHaveLength(2)

      const result = await flow.confirmTotpEnrolment({ code: '123456' })
      expect(result).toEqual({ step: COMPLETE, backupCodes: BACKUP_CODES })
      expect(api.calls(confirmRoute)[0]?.body).toEqual({ code: '123456' })
      expect(api.calls(confirmRoute)[0]?.headers.get('x-tula-attempt')).toBe(SECRET)
      expect(tula.state).toMatchObject({ status: 'signed-in', sessionId: 'session_1' })
      expect(flow.step).toEqual(COMPLETE)

      const visible =
        JSON.stringify(flow) +
        JSON.stringify(tula) +
        JSON.stringify(tula.state) +
        Bun.inspect(flow, { depth: 10 }) +
        Bun.inspect(tula, { depth: 10 }) +
        JSON.stringify(set.mock.calls)
      for (const secret of HANDED_OVER) {
        expect(visible).not.toContain(secret)
      }
      // Only the refresh token was stored.
      expect(set.mock.calls.map((call) => call[1])).toEqual(['rt_enrolled'])
      expect(await caught(flow.startTotpEnrolment())).toMatchObject({ code: 'flow.invalid_step' })
    }
  )

  async function atEnrolment(context: Context) {
    context.api.on('POST /v1/client/sign-ins', () =>
      json(200, attempt('sign_in', NEEDS_ENROLMENT, { attemptSecret: SECRET }))
    )
    return context.tula.signIn.start({ identifier: 'maya@northline.app' })
  }
  const START = 'POST /v1/client/sign-ins/attempt_1/factor-enrolment/totp'
  const CONFIRM = `${START}/confirm`

  test.each([
    ['no secret', { uri: TOTP_URI }],
    ['an empty secret', { secret: '', uri: TOTP_URI }],
    ['a URI that is not otpauth', { secret: TOTP_SECRET, uri: 'https://evil.example/qr' }],
    ['a list', [TOTP_SECRET, TOTP_URI]],
    ['a string', 'ok'],
  ])('a start answered with %s is response.invalid', async (_name, body) => {
    const context = setup()
    const flow = await atEnrolment(context)
    context.api.on(START, () => json(200, body))
    const error = await caught(flow.startTotpEnrolment())
    expect(error).toMatchObject({ code: 'response.invalid', status: 0 })
    expect(JSON.stringify(error)).not.toContain(TOTP_SECRET)
    expect(flow.step).toEqual(NEEDS_ENROLMENT)
  })

  test.each([
    ['no codes', undefined],
    ['an empty list', []],
    ['codes that are not strings', [1, 2, 3]],
    ['an empty code', ['2a3b4-c5d6e', '']],
    ['a string', '2a3b4-c5d6e'],
  ])(
    'a confirm answered with %s is response.invalid: nobody is signed in and the flow stays where it was',
    async (_name, backupCodes) => {
      const context = setup()
      const { api, tula, states, storage } = context
      const set = spyOn(storage, 'set')
      const flow = await atEnrolment(context)
      api.on(CONFIRM, () =>
        json(
          200,
          attempt('sign_in', COMPLETE, {
            session: sessionTokens('enrolled', { refreshToken: 'rt_enrolled' }),
            backupCodes,
          })
        )
      )
      expect(await caught(flow.confirmTotpEnrolment({ code: '123456' }))).toMatchObject({
        code: 'response.invalid',
        status: 0,
      })
      expect(flow.step).toEqual(NEEDS_ENROLMENT)
      expect(tula.state.status).toBe('loading')
      expect(states).toEqual([])
      expect(set).not.toHaveBeenCalled()
    }
  )

  test('a confirm answered with codes but no session is response.invalid', async () => {
    const context = setup()
    const flow = await atEnrolment(context)
    context.api.on(CONFIRM, () =>
      json(200, attempt('sign_in', COMPLETE, { backupCodes: BACKUP_CODES }))
    )
    const error = await caught(flow.confirmTotpEnrolment({ code: '123456' }))
    expect(error).toMatchObject({ code: 'response.invalid' })
    expect(JSON.stringify(error)).not.toContain(BACKUP_CODES[0])
    expect(flow.step).toEqual(NEEDS_ENROLMENT)
  })

  test('a wrong code and an expired enrolment are the server’s errors; the flow can go on', async () => {
    const context = setup()
    const flow = await atEnrolment(context)
    context.api.on(CONFIRM, () => failure(422, 'mfa.invalid_code'))
    expect(await caught(flow.confirmTotpEnrolment({ code: '000000' }))).toMatchObject({
      code: 'mfa.invalid_code',
      status: 422,
    })
    context.api.on(CONFIRM, () => failure(410, 'mfa.enrolment_expired'))
    expect(await caught(flow.confirmTotpEnrolment({ code: '123456' }))).toMatchObject({
      code: 'mfa.enrolment_expired',
      status: 410,
      message: 'This setup has expired. Start again.',
    })
    expect(flow.step).toEqual(NEEDS_ENROLMENT)
    context.api.on(START, () => failure(409, 'flow.invalid_step'))
    expect(await caught(flow.startTotpEnrolment())).toMatchObject({
      code: 'flow.invalid_step',
      status: 409,
    })
  })

  test('when the session cannot be saved on the device, the backup codes still reach the caller, with the failure beside them', async () => {
    const context = setup()
    const { api, tula, storage } = context
    const flow = await atEnrolment(context)
    spyOn(storage, 'set').mockRejectedValue(new Error('keychain locked'))
    api.on(CONFIRM, () =>
      json(
        200,
        attempt('sign_in', COMPLETE, {
          session: sessionTokens('enrolled', { refreshToken: 'rt_enrolled' }),
          backupCodes: BACKUP_CODES,
        })
      )
    )
    const result = await flow.confirmTotpEnrolment({ code: '123456' })
    expect(result.backupCodes).toEqual(BACKUP_CODES)
    expect(result.step).toEqual(COMPLETE)
    expect(result.failure).toMatchObject({ code: 'storage.failed', status: 0 })
    expect(JSON.stringify(result.failure)).not.toContain(BACKUP_CODES[0])
    // Signed in all the same, in memory.
    expect(tula.state.status).toBe('signed-in')
    expect(await tula.session.getToken()).toBe(accessToken('enrolled'))
  })

  test('a failure that is not the SDK’s own is not swallowed', async () => {
    const context = setup()
    const flow = await atEnrolment(context)
    context.api.on(CONFIRM, () =>
      json(
        200,
        attempt('sign_in', COMPLETE, {
          session: sessionTokens('enrolled'),
          backupCodes: BACKUP_CODES,
        })
      )
    )
    context.tula.onChange(() => {
      throw new Error('listener bug')
    })
    const reported = spyOn(globalThis, 'reportError').mockImplementation(() => undefined)
    // A listener's bug is reported, not thrown: the codes arrive without a `failure`.
    expect(await flow.confirmTotpEnrolment({ code: '123456' })).toEqual({
      step: COMPLETE,
      backupCodes: BACKUP_CODES,
    })
    expect(reported).toHaveBeenCalledTimes(1)
    reported.mockRestore()
  })
})

describe('a discarded flow is over: its late answers sign nobody in', () => {
  const NEW_PASSWORD: FlowStep = {
    status: 'needs_new_password',
    destination: 'm***@northline.app',
    strategies: ['email_code'],
  }
  const done = (kind: string, label: string) =>
    json(
      200,
      attempt(kind, COMPLETE, { session: sessionTokens(label, { refreshToken: `rt_${label}` }) })
    )

  const kinds = [
    {
      kind: 'sign_in',
      start: 'POST /v1/client/sign-ins',
      first: { status: 'needs_password' } as FlowStep,
      action: 'POST /v1/client/sign-ins/attempt_1/password',
      begin: (tula: ReturnType<typeof setup>['tula']) =>
        tula.signIn.start({ identifier: 'maya@northline.app' }),
      act: (flow: unknown) =>
        (flow as { submitPassword(input: { password: string }): Promise<FlowStep> }).submitPassword(
          { password: 'correct horse' }
        ),
    },
    {
      kind: 'sign_up',
      start: 'POST /v1/client/sign-ups',
      first: WAITING_EMAIL,
      action: 'POST /v1/client/sign-ups/attempt_1/verify-email',
      begin: (tula: ReturnType<typeof setup>['tula']) =>
        tula.signUp.start({ email: 'maya@northline.app', password: 'correct horse battery' }),
      act: (flow: unknown) =>
        (flow as { verifyEmail(input: { code: string }): Promise<FlowStep> }).verifyEmail({
          code: '123456',
        }),
    },
    {
      kind: 'password_reset',
      start: 'POST /v1/client/password-resets',
      first: NEW_PASSWORD,
      action: 'POST /v1/client/password-resets/attempt_1/password',
      begin: (tula: ReturnType<typeof setup>['tula']) =>
        tula.resetPassword.start({ email: 'maya@northline.app' }),
      act: (flow: unknown) =>
        (flow as { submit(input: { code: string; password: string }): Promise<FlowStep> }).submit({
          code: '123456',
          password: 'correct horse battery',
        }),
    },
  ]

  test.each(kinds)(
    '$kind: an answer that arrives after discard() is dropped, and the flow takes no further action',
    async (row) => {
      const { api, tula, states, storage } = setup()
      api.on(row.start, () => json(200, attempt(row.kind, row.first, { attemptSecret: SECRET })))
      const held = deferred<Response>()
      api.on(row.action, () => held.promise)
      const flow = await row.begin(tula)
      const submitting = caught(row.act(flow))
      await Promise.resolve()

      // The user leaves the attempt (another method, "start again") while the answer is on its way.
      flow.discard()
      held.resolve(done(row.kind, 'late'))
      const error = await submitting
      expect(error.code).toBe('flow.invalid_step')
      expect(error.status).toBe(0)

      // Nobody was signed in through the attempt that was left, and nothing was stored.
      expect(tula.state.status).not.toBe('signed-in')
      expect(states.some((state) => state.status === 'signed-in')).toBe(false)
      expect(await storage.get(`tula.refresh.${TEST_BASE_URL}|${TEST_KEY}`)).toBeNull()
      expect(flow.step).toEqual(row.first)

      // The secret is forgotten: every later action is refused without a request.
      const before = api.requests.length
      expect((await caught(row.act(flow))).code).toBe('flow.invalid_step')
      expect(api.requests).toHaveLength(before)
      expect(JSON.stringify(api.requests.map((request) => request.body))).not.toContain('late')
    }
  )

  test('discard() between an action’s wait for the session and its request sends nothing', async () => {
    const { api, tula } = setup()
    api.on('POST /v1/client/sign-ins', () =>
      json(200, attempt('sign_in', { status: 'needs_password' }, { attemptSecret: SECRET }))
    )
    const flow = await tula.signIn.start({ identifier: 'maya@northline.app' })
    const submitting = caught(flow.submitPassword({ password: 'correct horse' }))
    flow.discard()
    expect((await submitting).code).toBe('flow.invalid_step')
    expect(api.calls('POST /v1/client/sign-ins/attempt_1/password')).toHaveLength(0)
  })

  test('discard() on a completed flow changes nothing', async () => {
    const { api, tula } = setup()
    api.on('POST /v1/client/sign-ins', () =>
      json(200, attempt('sign_in', { status: 'needs_password' }, { attemptSecret: SECRET }))
    )
    api.on('POST /v1/client/sign-ins/attempt_1/password', () => done('sign_in', 'kept'))
    const flow = await tula.signIn.start({ identifier: 'maya@northline.app' })
    await flow.submitPassword({ password: 'correct horse' })
    flow.discard()
    expect(tula.state.status).toBe('signed-in')
    expect(flow.step).toEqual(COMPLETE)
  })
})

describe('a texted code as the second factor in a flow', () => {
  const WAITING: FlowStep = { status: 'needs_second_factor', options: ['sms_code'] }
  const PREPARED: FlowStep = {
    ...WAITING,
    prepared: { method: 'sms_code', destination: '***42' },
  }

  test.each([
    ['sign_in', 'sign-ins'],
    ['password_reset', 'password-resets'],
  ] as const)(
    'in a %s: nothing is asked for until prepareSecondFactor, which sends only the method, and the code completes it',
    async (kind, path) => {
      const { api, tula } = setup()
      const prepare = `POST /v1/client/${path}/attempt_1/second-factor/prepare`
      const submit = `POST /v1/client/${path}/attempt_1/second-factor`
      api.on(`POST /v1/client/${path}`, () =>
        json(200, attempt(kind, WAITING, { attemptSecret: SECRET }))
      )
      api.on(prepare, () => json(200, attempt(kind, PREPARED)))
      api.on(submit, () =>
        json(200, attempt(kind, COMPLETE, { session: sessionTokens('sms', { refreshToken: 'r' }) }))
      )
      const flow =
        kind === 'sign_in'
          ? await tula.signIn.start({ identifier: 'maya@northline.app' })
          : await tula.resetPassword.start({ email: 'maya@northline.app' })
      expect(api.calls(prepare)).toHaveLength(0)

      // Whatever else the caller's object holds stays here.
      const asked = { method: 'sms_code', code: '999999', phoneNumber: '+14155550100' } as const
      expect(await flow.prepareSecondFactor(asked)).toEqual(PREPARED)
      expect(api.calls(prepare)[0]?.body).toEqual({ method: 'sms_code' })
      expect(api.calls(prepare)[0]?.headers.get('x-tula-attempt')).toBe(SECRET)
      expect(flow.step).toEqual(PREPARED)
      expect(tula.state.status).not.toBe('signed-in')

      expect(await flow.submitSecondFactor({ method: 'sms_code', code: '123456' })).toEqual({
        step: COMPLETE,
      })
      expect(api.calls(submit)[0]?.body).toEqual({ method: 'sms_code', code: '123456' })
      expect(tula.state.status).toBe('signed-in')
    }
  )

  test.each([
    ['rate_limited', 429],
    ['auth.method_disabled', 403],
    ['sms.unavailable', 503],
    ['mfa.needs_other_sign_in', 403],
  ])('a refusal (%s) is passed on and the flow stays on its step', async (code, status) => {
    const { api, tula } = setup()
    api.on('POST /v1/client/sign-ins', () =>
      json(200, attempt('sign_in', WAITING, { attemptSecret: SECRET }))
    )
    api.on('POST /v1/client/sign-ins/attempt_1/second-factor/prepare', () => failure(status, code))
    const flow = await tula.signIn.start({ identifier: 'maya@northline.app' })
    expect(await caught(flow.prepareSecondFactor({ method: 'sms_code' }))).toMatchObject({
      code,
      status,
    })
    expect(flow.step).toEqual(WAITING)
    expect(tula.state.status).not.toBe('signed-in')
  })

  test('a completed flow asks for nothing', async () => {
    const { api, tula } = setup()
    api.on('POST /v1/client/sign-ins', () =>
      json(
        200,
        attempt('sign_in', COMPLETE, { attemptSecret: SECRET, session: sessionTokens('s') })
      )
    )
    const flow = await tula.signIn.start({ identifier: 'maya@northline.app' })
    expect(await caught(flow.prepareSecondFactor({ method: 'sms_code' }))).toMatchObject({
      code: 'flow.invalid_step',
    })
    expect(api.calls('POST /v1/client/sign-ins/attempt_1/second-factor/prepare')).toHaveLength(0)
  })
})
