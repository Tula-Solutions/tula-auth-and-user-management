import { describe, expect, spyOn, test } from 'bun:test'
import { createClient } from './client'
import { isTulaError, type TulaError } from './errors'
import { memoryStorage } from './storage'
import {
  accessToken,
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
        'expiresAt',
        'id',
        'kind',
        'resendCode',
        'step',
        'submitPassword',
        'toJSON',
        'verifyEmail',
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
