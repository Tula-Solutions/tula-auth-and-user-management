import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { createClient, createTulaClient, DEFAULT_TIMEOUT_MS } from './client'
import { isTulaError, type TulaError } from './errors'
import * as Core from './index'
import { memoryStorage } from './storage'
import {
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

const CONFIG = {
  app: { name: 'Northline', supportEmail: null },
  signIn: { methods: ['password'] },
  password: { preset: 'recommended', minLength: 10 },
}

function setup(options: Partial<Core.TulaClientOptions> = {}) {
  const api = fakeApi()
  api.on('GET /v1/client/me', () => json(200, TEST_USER))
  api.on('POST /v1/client/sessions/refresh', () =>
    json(200, sessionTokens('a', { refreshToken: 'rt_1' }))
  )
  const tula = createClient(
    {
      publishableKey: TEST_KEY,
      baseUrl: TEST_BASE_URL,
      client: 'server',
      fetch: api.fetch,
      ...options,
    },
    fakeEnvironment(manualClock())
  )
  return { api, tula }
}

async function signedIn(options: Partial<Core.TulaClientOptions> = {}) {
  const storage = memoryStorage()
  await storage.set(`tula.refresh.${TEST_BASE_URL}|${TEST_KEY}`, 'rt_0')
  const context = setup({ storage, ...options })
  await context.tula.load()
  return context
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

describe('createTulaClient options', () => {
  const valid = { publishableKey: TEST_KEY, baseUrl: TEST_BASE_URL }

  test.each([
    ['a secret key', { ...valid, publishableKey: 'tula_sk_dev_abc' }, /secret key/],
    ['something that is not a key', { ...valid, publishableKey: 'pk_live_abc' }, /publishable key/],
    [
      'a missing key',
      { ...valid, publishableKey: undefined as unknown as string },
      /publishable key/,
    ],
    ['a relative URL', { ...valid, baseUrl: '/api/auth' }, /absolute URL/],
    ['a non-http URL', { ...valid, baseUrl: 'ftp://auth.test' }, /http\(s\)/],
    [
      'storage for a web client',
      { ...valid, client: 'web' as const, storage: memoryStorage() },
      /takes no `storage`/,
    ],
    ['a zero timeout', { ...valid, timeoutMs: 0 }, /timeoutMs/],
    ['a timeout that is not a number', { ...valid, timeoutMs: Number.NaN }, /timeoutMs/],
  ] as [string, Core.TulaClientOptions, RegExp][])('refuses %s', (_name, options, message) => {
    expect(() => createTulaClient(options)).toThrow(message)
    expect(() => createTulaClient(options)).toThrow(TypeError)
  })

  test('an error about a secret key does not repeat the key', () => {
    try {
      createTulaClient({ ...valid, publishableKey: 'tula_sk_dev_very-secret-value' })
    } catch (error) {
      expect(String(error)).not.toContain('very-secret-value')
    }
  })

  test('creating a client sends nothing and starts in loading', () => {
    const { api, tula } = setup()
    expect(tula.state).toEqual({ status: 'loading' })
    expect(api.requests).toHaveLength(0)
  })

  test('the base URL may carry a path and trailing slashes', async () => {
    const { api, tula } = setup({ baseUrl: 'https://example.com/auth///' })
    api.on('GET /auth/v1/client/config', () => json(200, CONFIG))
    expect(await tula.config.get()).toEqual(CONFIG as unknown as Core.ClientConfig)
  })

  test('outside a browser the default kind is server, with memory storage', async () => {
    const api = fakeApi()
    api.on('POST /v1/client/sign-ins', () => failure(403, 'auth.method_disabled'))
    const tula = createTulaClient({ ...valid, fetch: api.fetch })
    await caught(tula.signIn.start({ identifier: 'a@b.co' }))
    expect(api.requests[0]?.headers.get('x-tula-client')).toBe('server')
    expect((await tula.load()).status).toBe('signed-out')
  })

  describe('in a browser', () => {
    const globals = globalThis as { document?: unknown }
    afterEach(() => {
      delete globals.document
    })

    test('the default kind is web', async () => {
      globals.document = {}
      const api = fakeApi()
      api.on('POST /v1/client/sessions/refresh', () => failure(401, 'auth.unauthenticated'))
      const tula = createTulaClient({ ...valid, fetch: api.fetch })
      expect((await tula.load()).status).toBe('signed-out')
      expect(api.requests[0]?.headers.get('x-tula-client')).toBe('web')
    })
  })

  test('without a fetch option the global fetch is used, looked up at call time', async () => {
    const spy = spyOn(globalThis, 'fetch').mockImplementation((async () =>
      json(200, CONFIG)) as unknown as typeof fetch)
    const tula = createTulaClient(valid)
    await tula.config.get()
    expect(spy).toHaveBeenCalledTimes(1)
    const [request] = spy.mock.calls[0] ?? []
    expect(request).toMatchObject({ url: `${TEST_BASE_URL}/v1/client/config` })
    spy.mockRestore()
  })
})

describe('config', () => {
  test('is fetched once and kept; force fetches again', async () => {
    const { api, tula } = setup()
    api.on('GET /v1/client/config', () => json(200, CONFIG))
    const [first, second] = await Promise.all([tula.config.get(), tula.config.get()])
    expect(first).toBe(second)
    await tula.config.get()
    expect(api.requests).toHaveLength(1)
    await tula.config.get({ force: true })
    expect(api.requests).toHaveLength(2)
    expect(api.requests[0]?.headers.has('authorization')).toBe(false)
  })

  test('a failed fetch is not kept', async () => {
    const { api, tula } = setup()
    api.on('GET /v1/client/config', () => failure(503, 'service.unavailable'))
    expect(await caught(tula.config.get())).toMatchObject({
      code: 'service.unavailable',
      status: 503,
    })
    api.on('GET /v1/client/config', () => json(200, CONFIG))
    expect(await tula.config.get()).toMatchObject({ app: { name: 'Northline' } })
  })

  test('a stale failure does not evict a newer answer', async () => {
    const { api, tula } = setup()
    let rejectFirst: (reason: unknown) => void = () => undefined
    api.on('GET /v1/client/config', () => new Promise((_resolve, reject) => (rejectFirst = reject)))
    const first = tula.config.get()
    await new Promise((resolve) => setTimeout(resolve, 0))
    api.on('GET /v1/client/config', () => json(200, CONFIG))
    await tula.config.get({ force: true })
    rejectFirst(new TypeError('offline'))
    await caught(first)
    await tula.config.get()
    expect(api.requests).toHaveLength(2)
  })
})

describe('session and user calls', () => {
  test('list, revokeOthers, user.get and changePassword send the access token', async () => {
    const { api, tula } = await signedIn()
    const session = {
      id: 'session_1',
      client: 'server',
      userAgent: null,
      ipAddress: null,
      createdAt: '2030-01-01T00:00:00.000Z',
      lastActiveAt: '2030-01-01T00:00:00.000Z',
      expiresAt: '2030-01-08T00:00:00.000Z',
      current: true,
    }
    api.on('GET /v1/client/sessions', () => json(200, { data: [session] }))
    api.on('POST /v1/client/sessions/revoke-others', () => json(200, { revoked: 3 }))
    api.on('POST /v1/client/me/password', () => new Response(null, { status: 204 }))
    expect(await tula.session.list()).toEqual([session as Core.Session])
    expect(await tula.session.revokeOthers()).toBe(3)
    expect(await tula.user.get()).toEqual(TEST_USER)
    expect(
      await tula.user.changePassword({
        currentPassword: 'old password',
        newPassword: 'new password 1',
      })
    ).toBeUndefined()
    const sent = api.requests.slice(-4)
    expect(
      sent.every((request) => request.headers.get('authorization')?.startsWith('Bearer ey'))
    ).toBe(true)
    expect(sent[3]?.body).toEqual({
      currentPassword: 'old password',
      newPassword: 'new password 1',
    })
    expect(tula.state.status).toBe('signed-in')
  })

  test('a revoke the API refuses leaves the session as it was', async () => {
    const { api, tula } = await signedIn()
    api.on('DELETE /v1/client/sessions/session_1', () => failure(404, 'resource.not_found'))
    expect(await caught(tula.session.revoke('session_1'))).toMatchObject({
      code: 'resource.not_found',
    })
    expect(tula.state.status).toBe('signed-in')
  })
})

describe('user.phone', () => {
  const NUMBER = '+14155550142'
  const ASK = 'POST /v1/client/me/phone'
  const VERIFY = 'POST /v1/client/me/phone/verify'
  const REMOVE = 'DELETE /v1/client/me/phone'
  const WITH_NUMBER = {
    ...TEST_USER,
    phoneNumber: NUMBER,
    phoneNumberVerifiedAt: '2030-01-01T00:05:00.000Z',
  }

  test('request sends the number with the access token and returns only the receipt', async () => {
    const { api, tula } = await signedIn()
    api.on(ASK, () =>
      json(200, {
        destination: '***42',
        expiresAt: '2030-01-01T00:10:00.000Z',
        // Not part of the answer: whatever else a 200 held does not travel further.
        code: '123456',
      })
    )
    expect(await tula.user.phone.request({ phoneNumber: '+1 (415) 555-0142' })).toEqual({
      destination: '***42',
      expiresAt: '2030-01-01T00:10:00.000Z',
    })
    const sent = api.calls(ASK)[0]
    expect(sent?.body).toEqual({ phoneNumber: '+1 (415) 555-0142' })
    expect(sent?.headers.get('authorization')).toMatch(/^Bearer ey/)
    // Asking changes nothing about who is signed in or what is known of them.
    expect(tula.state).toMatchObject({ status: 'signed-in', user: TEST_USER })
  })

  test.each([
    ['a page', 'not json'],
    ['no destination', { expiresAt: '2030-01-01T00:10:00.000Z' }],
    ['no expiry', { destination: '***42' }],
  ])('a 200 that is not a receipt (%s) is response.invalid', async (_name, body) => {
    const { api, tula } = await signedIn()
    api.on(ASK, () =>
      typeof body === 'string' ? new Response(body, { status: 200 }) : json(200, body)
    )
    expect((await caught(tula.user.phone.request({ phoneNumber: NUMBER }))).code).toBe(
      'response.invalid'
    )
  })

  test('verify sends the code, returns the user and shows the number in the state', async () => {
    const { api, tula } = await signedIn()
    api.on(VERIFY, () => json(200, WITH_NUMBER))
    expect(await tula.user.phone.verify({ code: '123456' })).toEqual(WITH_NUMBER)
    expect(api.calls(VERIFY)[0]?.body).toEqual({ code: '123456' })
    expect(tula.state).toMatchObject({ status: 'signed-in', user: WITH_NUMBER })
  })

  test('a number verified for one session is not installed into the next one', async () => {
    const { api, tula } = await signedIn()
    let release: (response: Response) => void = () => undefined
    api.on(VERIFY, () => new Promise<Response>((resolve) => (release = resolve)))
    const verifying = tula.user.phone.verify({ code: '123456' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const other = { ...TEST_USER, id: 'user_2', email: 'other@northline.app' }
    api.on('GET /v1/client/me', () => json(200, other))
    api.on('POST /v1/client/sign-ins', () =>
      json(200, {
        id: 'attempt_1',
        kind: 'sign_in',
        expiresAt: '2030-01-01T00:10:00.000Z',
        step: { status: 'complete', userId: 'user_2', sessionId: 'session_2' },
        attemptSecret: 'tula_at_secret',
        session: sessionTokens('b', { sessionId: 'session_2', refreshToken: 'rt_2' }),
      })
    )
    await tula.signIn.start({ identifier: other.email })
    await new Promise((resolve) => setTimeout(resolve, 0))

    release(json(200, WITH_NUMBER))
    expect(await verifying).toEqual(WITH_NUMBER)
    expect(tula.state).toMatchObject({ sessionId: 'session_2', user: other })
  })

  test('remove deletes the number and the state’s user no longer has one', async () => {
    const { api, tula } = await signedIn()
    api.on(VERIFY, () => json(200, WITH_NUMBER))
    await tula.user.phone.verify({ code: '123456' })
    api.on(REMOVE, () => new Response(null, { status: 204 }))
    expect(await tula.user.phone.remove()).toBeUndefined()
    expect(api.calls(REMOVE)).toHaveLength(1)
    expect(tula.state).toMatchObject({
      status: 'signed-in',
      user: { ...TEST_USER, phoneNumber: null, phoneNumberVerifiedAt: null },
    })
  })

  test.each([
    [
      'request',
      ASK,
      'sms.disabled',
      403,
      (tula: Core.TulaClient) => tula.user.phone.request({ phoneNumber: NUMBER }),
    ],
    [
      'request',
      ASK,
      'sms.country_not_allowed',
      422,
      (tula: Core.TulaClient) => tula.user.phone.request({ phoneNumber: NUMBER }),
    ],
    [
      'request',
      ASK,
      'phone.invalid',
      422,
      (tula: Core.TulaClient) => tula.user.phone.request({ phoneNumber: 'x' }),
    ],
    [
      'request',
      ASK,
      'sms.unavailable',
      503,
      (tula: Core.TulaClient) => tula.user.phone.request({ phoneNumber: NUMBER }),
    ],
    [
      'verify',
      VERIFY,
      'verification.invalid_code',
      422,
      (tula: Core.TulaClient) => tula.user.phone.verify({ code: '000000' }),
    ],
    [
      'verify',
      VERIFY,
      'verification.expired',
      410,
      (tula: Core.TulaClient) => tula.user.phone.verify({ code: '000000' }),
    ],
    [
      'remove',
      REMOVE,
      'auth.step_up_required',
      403,
      (tula: Core.TulaClient) => tula.user.phone.remove(),
    ],
  ] as const)(
    '%s refused by the API (%s on %s) throws that code, with a message, and changes nothing',
    async (_name, route, code, status, call) => {
      const { api, tula } = await signedIn()
      api.on(route, () => failure(status, code))
      const error = await caught(call(tula))
      expect(error).toMatchObject({ code, status })
      // A message of the client's own table, not the server's detail.
      expect(error.message).not.toBe('')
      expect(error.message).not.toContain('detail of')
      expect(api.calls(route)).toHaveLength(1)
      expect(tula.state).toMatchObject({ status: 'signed-in', user: TEST_USER })
    }
  )

  test('nothing of a number or a code is kept in storage', async () => {
    const storage = memoryStorage()
    await storage.set(`tula.refresh.${TEST_BASE_URL}|${TEST_KEY}`, 'rt_0')
    const set = spyOn(storage, 'set')
    const { api, tula } = setup({ storage })
    await tula.load()
    api.on(ASK, () => json(200, { destination: '***42', expiresAt: '2030-01-01T00:10:00.000Z' }))
    api.on(VERIFY, () => json(200, WITH_NUMBER))
    await tula.user.phone.request({ phoneNumber: NUMBER })
    await tula.user.phone.verify({ code: '654321' })
    const written = JSON.stringify(set.mock.calls)
    expect(written).not.toContain(NUMBER)
    expect(written).not.toContain('654321')
  })
})

describe('user.get belongs to the session that asked', () => {
  test('a user fetched for one session is not installed into the next one', async () => {
    const { api, tula } = await signedIn()
    let release: (response: Response) => void = () => undefined
    api.on('GET /v1/client/me', () => new Promise<Response>((resolve) => (release = resolve)))
    const fetching = tula.user.get()
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Someone else signs in while the request is on its way.
    const other = { ...TEST_USER, id: 'user_2', email: 'other@northline.app' }
    api.on('GET /v1/client/me', () => json(200, other))
    api.on('POST /v1/client/sign-ins', () =>
      json(200, {
        id: 'attempt_1',
        kind: 'sign_in',
        expiresAt: '2030-01-01T00:10:00.000Z',
        step: { status: 'complete', userId: 'user_2', sessionId: 'session_2' },
        attemptSecret: 'tula_at_secret',
        session: sessionTokens('b', { sessionId: 'session_2', refreshToken: 'rt_2' }),
      })
    )
    await tula.signIn.start({ identifier: other.email })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(tula.state).toMatchObject({ sessionId: 'session_2', user: other })

    release(json(200, TEST_USER))
    // The caller still gets what it asked for; the state keeps the new session's user.
    expect(await fetching).toEqual(TEST_USER)
    expect(tula.state).toMatchObject({ sessionId: 'session_2', user: other })
  })

  test('a client that has not loaded yet restores its session and installs the user', async () => {
    const storage = memoryStorage()
    await storage.set(`tula.refresh.${TEST_BASE_URL}|${TEST_KEY}`, 'rt_0')
    const { tula } = setup({ storage })
    expect(await tula.user.get()).toEqual(TEST_USER)
    expect(tula.state).toMatchObject({ status: 'signed-in', user: TEST_USER })
  })
})

describe('messages', () => {
  test('the messages option and setMessages decide the language of every error', async () => {
    const { api, tula } = setup({ messages: { 'auth.method_disabled': 'No disponible.' } })
    api.on('POST /v1/client/sign-ins', () => failure(403, 'auth.method_disabled'))
    expect((await caught(tula.signIn.start({ identifier: 'a@b.co' }))).message).toBe(
      'No disponible.'
    )
    tula.setMessages({
      'auth.method_disabled': 'Nicht verfügbar.',
      'auth.unauthenticated': 'Bitte anmelden.',
    })
    expect((await caught(tula.signIn.start({ identifier: 'a@b.co' }))).message).toBe(
      'Nicht verfügbar.'
    )
    await tula.load()
    expect((await caught(tula.user.get())).message).toBe('Bitte anmelden.')
    tula.setMessages({})
    expect((await caught(tula.signIn.start({ identifier: 'a@b.co' }))).message).toBe(
      'This sign-in method is not available.'
    )
  })
})

describe('two-step verification (client.mfa)', () => {
  const FACTORS = 'GET /v1/client/me/factors'
  const TOTP = 'POST /v1/client/me/factors/totp'
  const CONFIRM = 'POST /v1/client/me/factors/totp/confirm'
  const DISABLE = 'DELETE /v1/client/me/factors/totp'
  const BACKUP = 'POST /v1/client/me/factors/backup-codes'
  const REFRESH = 'POST /v1/client/sessions/refresh'
  const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
  const TOTP_URI = `otpauth://totp/Tula:maya%40northline.app?secret=${TOTP_SECRET}&issuer=Tula`
  const CODES = ['2a3b4-c5d6e', '7f8g9-h2j3k', 'm4n5p-q6r7s']
  const NEW_CODES = ['zzzz2-yyyy3', 'xxxx4-wwww5']
  const bearer = (label: string) => `Bearer ${sessionTokens(label).accessToken}`

  /** A signed-in client (token `a`) whose later refreshes answer `next_1`, `next_2`, … */
  async function enrolling() {
    const storage = memoryStorage()
    await storage.set(`tula.refresh.${TEST_BASE_URL}|${TEST_KEY}`, 'rt_0')
    const context = setup({ storage })
    await context.tula.load()
    let count = 0
    context.api.on(REFRESH, () => {
      count += 1
      return json(200, sessionTokens(`next_${count}`, { refreshToken: `rt_next_${count}` }))
    })
    return { ...context, storage }
  }

  test('get answers what is enrolled, with the access token', async () => {
    const { api, tula } = await signedIn()
    const factors = {
      totp: { enabled: true, confirmedAt: '2030-01-01T00:00:00.000Z' },
      backupCodes: { remaining: 8 },
    }
    api.on(FACTORS, () => json(200, factors))
    expect(await tula.mfa.get()).toEqual(factors)
    expect(api.calls(FACTORS)[0]?.headers.get('authorization')).toBe(bearer('a'))
  })

  test.each([
    ['a page that is not the API', { html: '<html>' }],
    ['no backup codes', { totp: { enabled: false, confirmedAt: null } }],
    [
      'a count that is not a number',
      { totp: { enabled: false, confirmedAt: null }, backupCodes: { remaining: '8' } },
    ],
    [
      'enabled that is not a boolean',
      { totp: { enabled: 'yes', confirmedAt: null }, backupCodes: { remaining: 0 } },
    ],
    [
      'a confirmedAt that is neither a date nor null',
      { totp: { enabled: true, confirmedAt: 7 }, backupCodes: { remaining: 0 } },
    ],
    ['a list', []],
  ])('get answered with %s is response.invalid', async (_name, body) => {
    const { api, tula } = await signedIn()
    api.on(FACTORS, () => json(200, body))
    expect(await caught(tula.mfa.get())).toMatchObject({ code: 'response.invalid', status: 0 })
  })

  test('nobody signed in: every call fails locally with auth.unauthenticated', async () => {
    const { api, tula } = setup()
    api.on(REFRESH, () => failure(401, 'auth.unauthenticated'))
    await tula.load()
    const before = api.requests.length
    for (const call of [
      () => tula.mfa.get(),
      () => tula.mfa.startTotp(),
      () => tula.mfa.confirmTotp({ code: '123456' }),
      () => tula.mfa.disableTotp(),
      () => tula.mfa.regenerateBackupCodes(),
      () => tula.session.stepUp({ method: 'password', password: 'pw' }),
    ]) {
      expect(await caught(call())).toMatchObject({ code: 'auth.unauthenticated' })
    }
    expect(api.requests).toHaveLength(before)
  })

  test('startTotp hands over the secret and its URI and nothing else', async () => {
    const { api, tula } = await signedIn()
    api.on(TOTP, () => json(200, { secret: TOTP_SECRET, uri: TOTP_URI, extra: 'ignored' }))
    expect(await tula.mfa.startTotp()).toEqual({ secret: TOTP_SECRET, uri: TOTP_URI })
    expect(api.calls(TOTP)[0]?.body).toBeUndefined()
    expect(api.calls(TOTP)[0]?.headers.get('authorization')).toBe(bearer('a'))
  })

  test.each([
    ['no URI', { secret: TOTP_SECRET }],
    ['a URI that is not otpauth', { secret: TOTP_SECRET, uri: 'javascript:alert(1)' }],
    ['a secret that is not a string', { secret: 7, uri: TOTP_URI }],
  ])(
    'startTotp answered with %s is response.invalid, and the error carries no secret',
    async (_name, body) => {
      const { api, tula } = await signedIn()
      api.on(TOTP, () => json(200, body))
      const error = await caught(tula.mfa.startTotp())
      expect(error).toMatchObject({ code: 'response.invalid', status: 0 })
      expect(JSON.stringify(error) + error.stack).not.toContain(TOTP_SECRET)
    }
  )

  test.each([
    ['mfa.not_available', 403],
    ['mfa.already_enabled', 409],
  ])('startTotp refused with %s is that error', async (code, status) => {
    const { api, tula } = await signedIn()
    api.on(TOTP, () => failure(status, code))
    expect(await caught(tula.mfa.startTotp())).toMatchObject({ code, status })
  })

  test('confirmTotp returns the backup codes and refreshes the session once, so the next token carries the proof', async () => {
    const { api, tula } = await enrolling()
    const states: unknown[] = []
    tula.onChange((state) => states.push(state))
    api.on(CONFIRM, () => json(200, { codes: CODES, extra: 'ignored' }))
    expect(await tula.mfa.confirmTotp({ code: '123456' })).toEqual({ codes: CODES })
    expect(api.calls(CONFIRM)[0]?.body).toEqual({ code: '123456' })
    expect(api.calls(CONFIRM)[0]?.headers.get('authorization')).toBe(bearer('a'))
    // One refresh after the load's, made by the confirm itself.
    expect(api.calls(REFRESH)).toHaveLength(2)
    expect(await tula.session.getToken()).toBe(sessionTokens('next_1').accessToken)
    expect(api.calls(REFRESH)).toHaveLength(2)
    // A refresh is not a change of state.
    expect(states).toEqual([])
  })

  test('if that refresh cannot be made the codes are returned all the same, and the next getToken() asks again', async () => {
    const { api, tula } = await enrolling()
    api.on(CONFIRM, () => json(200, { codes: CODES }))
    api.on(REFRESH, () => failure(503, 'service.unavailable'))
    expect(await tula.mfa.confirmTotp({ code: '123456' })).toEqual({ codes: CODES })
    expect(api.calls(REFRESH)).toHaveLength(2)
    expect(tula.state.status).toBe('signed-in')

    // Still failing: the token in hand is valid and is used, but a refresh was asked for.
    expect(await tula.session.getToken()).toBe(sessionTokens('a').accessToken)
    expect(api.calls(REFRESH)).toHaveLength(3)
    // Working again: the next call gets the token that carries the proof.
    api.on(REFRESH, () => json(200, sessionTokens('proven', { refreshToken: 'rt_p' })))
    expect(await tula.session.getToken()).toBe(sessionTokens('proven').accessToken)
    expect(api.calls(REFRESH)).toHaveLength(4)
    expect(await tula.session.getToken()).toBe(sessionTokens('proven').accessToken)
    expect(api.calls(REFRESH)).toHaveLength(4)
  })

  test('if that refresh gets no answer, the codes are returned all the same', async () => {
    const { api, tula } = await enrolling()
    api.on(CONFIRM, () => json(200, { codes: CODES }))
    api.on(REFRESH, () => {
      throw new TypeError('offline')
    })
    expect(await tula.mfa.confirmTotp({ code: '123456' })).toEqual({ codes: CODES })
    expect(tula.state.status).toBe('signed-in')
  })

  test('if that refresh says the session is over, the codes are still returned and the client is signed out', async () => {
    const { api, tula } = await enrolling()
    api.on(CONFIRM, () => json(200, { codes: CODES }))
    api.on(REFRESH, () => failure(401, 'session.revoked'))
    expect(await tula.mfa.confirmTotp({ code: '123456' })).toEqual({ codes: CODES })
    expect(tula.state).toEqual({ status: 'signed-out' })
  })

  test('a sign-out while the confirm is in flight stays a sign-out: the codes are returned and no refresh is made', async () => {
    const { api, tula } = await enrolling()
    api.on('POST /v1/client/sessions/sign-out', () => new Response(null, { status: 204 }))
    let release!: (response: Response) => void
    api.on(
      CONFIRM,
      () =>
        new Promise<Response>((resolve) => {
          release = resolve
        })
    )
    const confirming = tula.mfa.confirmTotp({ code: '123456' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await tula.session.signOut()
    release(json(200, { codes: CODES }))
    expect(await confirming).toEqual({ codes: CODES })
    expect(tula.state).toEqual({ status: 'signed-out' })
    expect(api.calls(REFRESH)).toHaveLength(1)
  })

  test.each([
    ['no codes', {}],
    ['an empty list', { codes: [] }],
    ['codes that are not strings', { codes: [1, 2] }],
    ['a list', CODES],
  ])(
    'confirmTotp answered with %s is response.invalid, and no refresh is made',
    async (_name, body) => {
      const { api, tula } = await enrolling()
      api.on(CONFIRM, () => json(200, body))
      expect(await caught(tula.mfa.confirmTotp({ code: '123456' }))).toMatchObject({
        code: 'response.invalid',
        status: 0,
      })
      expect(api.calls(REFRESH)).toHaveLength(1)
    }
  )

  test.each([
    ['mfa.invalid_code', 422],
    ['mfa.enrolment_expired', 410],
    ['rate_limited', 429],
  ])('confirmTotp refused with %s is that error, and no refresh is made', async (code, status) => {
    const { api, tula } = await enrolling()
    api.on(CONFIRM, () => failure(status, code))
    expect(await caught(tula.mfa.confirmTotp({ code: '000000' }))).toMatchObject({ code, status })
    expect(api.calls(REFRESH)).toHaveLength(1)
  })

  test('disableTotp sends a DELETE; a policy that requires it is the server’s error', async () => {
    const { api, tula } = await signedIn()
    api.on(DISABLE, () => new Response(null, { status: 204 }))
    expect(await tula.mfa.disableTotp()).toBeUndefined()
    expect(api.calls(DISABLE)[0]?.headers.get('authorization')).toBe(bearer('a'))
    api.on(DISABLE, () => failure(403, 'mfa.required_by_policy'))
    expect(await caught(tula.mfa.disableTotp())).toMatchObject({
      code: 'mfa.required_by_policy',
      status: 403,
    })
    api.on(DISABLE, () => failure(409, 'mfa.not_enabled'))
    expect(await caught(tula.mfa.disableTotp())).toMatchObject({ code: 'mfa.not_enabled' })
  })

  test('regenerateBackupCodes returns the new codes; a malformed answer is response.invalid', async () => {
    const { api, tula } = await signedIn()
    api.on(BACKUP, () => json(200, { codes: NEW_CODES, extra: 'ignored' }))
    expect(await tula.mfa.regenerateBackupCodes()).toEqual({ codes: NEW_CODES })
    expect(api.calls(BACKUP)[0]?.body).toBeUndefined()
    api.on(BACKUP, () => json(200, { codes: 'zzzz2-yyyy3' }))
    expect(await caught(tula.mfa.regenerateBackupCodes())).toMatchObject({
      code: 'response.invalid',
    })
  })

  test('the secret, the URI and the backup codes are kept nowhere: not on the client, not in its state, not in storage', async () => {
    const { api, tula, storage } = await enrolling()
    const set = spyOn(storage, 'set')
    api.on(TOTP, () => json(200, { secret: TOTP_SECRET, uri: TOTP_URI }))
    api.on(CONFIRM, () => json(200, { codes: CODES }))
    api.on(BACKUP, () => json(200, { codes: NEW_CODES }))
    await tula.mfa.startTotp()
    await tula.mfa.confirmTotp({ code: '123456' })
    await tula.mfa.regenerateBackupCodes()

    const visible =
      JSON.stringify(tula) +
      JSON.stringify(tula.state) +
      Bun.inspect(tula, { depth: 10 }) +
      JSON.stringify(set.mock.calls) +
      JSON.stringify(await storage.get(`tula.refresh.${TEST_BASE_URL}|${TEST_KEY}`))
    for (const secret of [TOTP_SECRET, TOTP_URI, ...CODES, ...NEW_CODES, '123456']) {
      expect(visible).not.toContain(secret)
    }
    // The one write is the refresh token of the refresh that follows the confirm.
    expect(set.mock.calls.map((call) => call[1])).toEqual(['rt_next_1'])
  })

  test.each([
    ['startTotp', TOTP, (tula: Core.TulaClient) => tula.mfa.startTotp()],
    ['disableTotp', DISABLE, (tula: Core.TulaClient) => tula.mfa.disableTotp()],
    ['regenerateBackupCodes', BACKUP, (tula: Core.TulaClient) => tula.mfa.regenerateBackupCodes()],
    [
      'user.changePassword',
      'POST /v1/client/me/password',
      (tula: Core.TulaClient) =>
        tula.user.changePassword({ currentPassword: 'old', newPassword: 'new' }),
    ],
  ])(
    '%s answered auth.step_up_required: the error says what to prove, and nothing is prompted, refreshed or retried',
    async (_name, route, call) => {
      const { api, tula } = await signedIn()
      api.on(route, () =>
        failure(403, 'auth.step_up_required', { params: { methods: 'totp,backup_code' } })
      )
      const error = await caught(call(tula))
      expect(error).toMatchObject({ code: 'auth.step_up_required', status: 403 })
      expect(Core.isStepUpRequired(error)).toBe(true)
      expect(Core.stepUpMethods(error)).toEqual(['totp', 'backup_code'])
      expect(api.calls(route)).toHaveLength(1)
      expect(api.calls(REFRESH)).toHaveLength(1)
      expect(api.calls('POST /v1/client/sessions/step-up')).toHaveLength(0)
      expect(tula.state.status).toBe('signed-in')
    }
  )

  test('step up, then repeat: the repeated call carries the token the step-up returned', async () => {
    const { api, tula } = await signedIn()
    api.on(BACKUP, (request) =>
      request.headers.get('authorization') === bearer('proven')
        ? json(200, { codes: NEW_CODES })
        : failure(403, 'auth.step_up_required', { params: { methods: 'password' } })
    )
    api.on('POST /v1/client/sessions/step-up', () => json(200, sessionTokens('proven')))
    const error = await caught(tula.mfa.regenerateBackupCodes())
    expect(Core.stepUpMethods(error)).toEqual(['password'])
    await tula.session.stepUp({ method: 'password', password: 'pw' })
    expect(await tula.mfa.regenerateBackupCodes()).toEqual({ codes: NEW_CODES })
    expect(api.calls(REFRESH)).toHaveLength(1)
  })
})

describe('session.prepareStepUp: a step-up code by email', () => {
  const SEND = 'POST /v1/client/sessions/step-up/email-code'
  const STEP_UP = 'POST /v1/client/sessions/step-up'
  const REFRESH = 'POST /v1/client/sessions/refresh'
  const RECEIPT = {
    method: 'email_code',
    destination: 'm***@northline.app',
    expiresAt: '2026-01-01T00:10:00.000Z',
  } as const

  test('asks the API to email the code and returns the receipt; stepUp then presents the code', async () => {
    const { api, tula } = await signedIn()
    api.on(SEND, () => json(200, RECEIPT))
    api.on(STEP_UP, () => json(200, sessionTokens('proven')))
    expect(await tula.session.prepareStepUp({ method: 'email_code' })).toEqual(RECEIPT)
    const sent = api.calls(SEND)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.headers.get('authorization')).toMatch(/^Bearer /)
    // Asking changes nothing about the session.
    expect(api.calls(REFRESH)).toHaveLength(1)

    await tula.session.stepUp({ method: 'email_code', code: '123456' })
    expect(api.calls(STEP_UP)[0]?.body).toEqual({ method: 'email_code', code: '123456' })
    expect(await tula.session.getToken()).toBe(sessionTokens('proven').accessToken)
  })

  test('a refusal is passed on as it is: the cooldown with its retry time, and a user who must use a second factor', async () => {
    const { api, tula } = await signedIn()
    api.on(SEND, () => failure(429, 'rate_limited', {}, { 'retry-after': '42' }))
    const limited = await caught(tula.session.prepareStepUp({ method: 'email_code' }))
    expect(limited).toMatchObject({ code: 'rate_limited', status: 429, retryAfterMs: 42_000 })
    api.on(SEND, () =>
      failure(403, 'auth.step_up_required', { params: { methods: 'totp,backup_code' } })
    )
    const refused = await caught(tula.session.prepareStepUp({ method: 'email_code' }))
    expect(Core.stepUpMethods(refused)).toEqual(['totp', 'backup_code'])
    expect(tula.state.status).toBe('signed-in')
  })

  test('an answer that is not a receipt is response.invalid, and one that holds more is trimmed to the receipt', async () => {
    const { api, tula } = await signedIn()
    for (const body of [{}, { method: 'email_code' }, { ...RECEIPT, destination: 7 }, 'ok', null]) {
      api.on(SEND, () => json(200, body))
      expect(await caught(tula.session.prepareStepUp({ method: 'email_code' }))).toMatchObject({
        code: 'response.invalid',
      })
    }
    api.on(SEND, () => json(200, { ...RECEIPT, code: '123456' }))
    expect(await tula.session.prepareStepUp({ method: 'email_code' })).toEqual(RECEIPT)
  })

  test('signed out, nothing is sent', async () => {
    const { api, tula } = setup()
    api.on(REFRESH, () => failure(401, 'session.revoked'))
    expect(await caught(tula.session.prepareStepUp({ method: 'email_code' }))).toMatchObject({
      code: 'auth.unauthenticated',
    })
    expect(api.calls(SEND)).toHaveLength(0)
  })
})

describe('config.mfa', () => {
  test('the policy is passed through; an API that does not say leaves it out', async () => {
    const { api, tula } = setup()
    api.on('GET /v1/client/config', () => json(200, { ...CONFIG, mfa: { policy: 'required' } }))
    expect((await tula.config.get()).mfa?.policy).toBe('required')
    api.on('GET /v1/client/config', () => json(200, CONFIG))
    expect((await tula.config.get({ force: true })).mfa?.policy ?? 'off').toBe('off')
  })
})

describe('the public surface', () => {
  test('exports exactly these values', () => {
    expect(Object.keys(Core).sort()).toEqual([
      'ACCESS_TOKEN_EXPIRY_SKEW_MS',
      'DEFAULT_TIMEOUT_MS',
      'EMAIL_LINK_POLL_INTERVAL_MS',
      'EMAIL_LINK_SESSION_WAIT_MS',
      'EN_MESSAGES',
      'MAX_REFRESH_BACKOFF_MS',
      'REFRESH_RETRY_WINDOW_MS',
      'REFRESH_TIMEOUT_MS',
      'TulaError',
      'createTulaClient',
      'createTulaClientWithEnvironment',
      'evaluatePassword',
      'formatMessage',
      'generateSoftwareDeviceKey',
      'isRetryableOAuthError',
      'isStepUpRequired',
      'isTulaError',
      'memoryStorage',
      'runtimeEnvironment',
      'stepUpMethods',
    ])
    expect(DEFAULT_TIMEOUT_MS).toBe(15_000)
    expect(Core.ACCESS_TOKEN_EXPIRY_SKEW_MS).toBe(10_000)
  })
})

describe('a texted code as the second step', () => {
  const START = 'POST /v1/client/me/factors/sms'
  const CONFIRM = 'POST /v1/client/me/factors/sms/confirm'
  const REMOVE = 'DELETE /v1/client/me/factors/sms'
  const SEND = 'POST /v1/client/sessions/step-up/sms-code'
  const STEP_UP = 'POST /v1/client/sessions/step-up'
  const REFRESH = 'POST /v1/client/sessions/refresh'
  const RECEIPT = {
    method: 'sms_code',
    destination: '***42',
    expiresAt: '2026-01-01T00:10:00.000Z',
  } as const
  const FACTORS = {
    totp: { enabled: false, confirmedAt: null },
    backupCodes: { remaining: 0 },
    sms: { enabled: true, enabledAt: '2026-01-01T00:00:00.000Z', inUse: true, available: false },
  }

  test('startSms asks for the text and returns the receipt and nothing else', async () => {
    const { api, tula } = await signedIn()
    api.on(START, () => json(200, { ...RECEIPT, code: '123456', phoneNumber: '+14155550142' }))
    expect(await tula.mfa.startSms()).toEqual(RECEIPT)
    expect(api.calls(START)[0]?.headers.get('authorization')).toMatch(/^Bearer /)
    expect(api.calls(START)[0]?.body).toBeUndefined()
  })

  test.each<[string, unknown]>([
    ['nothing', {}],
    ['an emailed code’s receipt', { ...RECEIPT, method: 'email_code' }],
    ['a destination that is not text', { ...RECEIPT, destination: 7 }],
    ['no expiry', { method: 'sms_code', destination: '***42' }],
    ['text', 'ok'],
  ])('startSms answered with %s is response.invalid', async (_name, body) => {
    const { api, tula } = await signedIn()
    api.on(START, () => json(200, body))
    expect(await caught(tula.mfa.startSms())).toMatchObject({ code: 'response.invalid' })
  })

  test.each([
    ['mfa.not_available', 403],
    ['mfa.phone_number_required', 409],
    ['mfa.sms_not_allowed', 409],
    ['mfa.already_enabled', 409],
    ['sms.unavailable', 503],
  ])('startSms refused with %s is that error', async (code, status) => {
    const { api, tula } = await signedIn()
    api.on(START, () => failure(status, code))
    expect(await caught(tula.mfa.startSms())).toMatchObject({ code, status })
  })

  test('confirmSms returns what is enrolled and refreshes the session once, so the next token carries the proof', async () => {
    const { api, tula } = await signedIn()
    api.on(CONFIRM, () => json(200, FACTORS))
    const before = api.calls(REFRESH).length
    expect(await tula.mfa.confirmSms({ code: '123456' })).toEqual(FACTORS)
    expect(api.calls(CONFIRM)[0]?.body).toEqual({ code: '123456' })
    expect(api.calls(REFRESH)).toHaveLength(before + 1)
  })

  test('confirmSms refused is that error, and no refresh is made', async () => {
    const { api, tula } = await signedIn()
    api.on(CONFIRM, () => failure(422, 'mfa.invalid_code'))
    const before = api.calls(REFRESH).length
    expect(await caught(tula.mfa.confirmSms({ code: '000000' }))).toMatchObject({
      code: 'mfa.invalid_code',
      status: 422,
    })
    expect(api.calls(REFRESH)).toHaveLength(before)
    api.on(CONFIRM, () => json(200, { ok: true }))
    expect(await caught(tula.mfa.confirmSms({ code: '123456' }))).toMatchObject({
      code: 'response.invalid',
    })
    expect(api.calls(REFRESH)).toHaveLength(before)
  })

  test('if that refresh cannot be made the answer is returned all the same', async () => {
    const { api, tula } = await signedIn()
    api.on(CONFIRM, () => json(200, FACTORS))
    api.on(REFRESH, () => failure(503, 'service.unavailable'))
    expect(await tula.mfa.confirmSms({ code: '123456' })).toEqual(FACTORS)
    expect(tula.state.status).toBe('signed-in')
  })

  test('disableSms removes it, and a refusal is passed on', async () => {
    const { api, tula } = await signedIn()
    api.on(REMOVE, () => new Response(null, { status: 204 }))
    await tula.mfa.disableSms()
    expect(api.calls(REMOVE)).toHaveLength(1)
    api.on(REMOVE, () => failure(403, 'mfa.required_by_policy'))
    expect(await caught(tula.mfa.disableSms())).toMatchObject({ code: 'mfa.required_by_policy' })
  })

  test('prepareStepUp with sms_code asks for a text, never an email, and stepUp presents the code', async () => {
    const { api, tula } = await signedIn()
    api.on(SEND, () => json(200, { ...RECEIPT, code: '123456' }))
    api.on(STEP_UP, () => json(200, sessionTokens('proven')))
    expect(await tula.session.prepareStepUp({ method: 'sms_code' })).toEqual(RECEIPT)
    expect(api.calls(SEND)).toHaveLength(1)
    expect(api.calls('POST /v1/client/sessions/step-up/email-code')).toHaveLength(0)
    await tula.session.stepUp({ method: 'sms_code', code: '123456' })
    expect(api.calls(STEP_UP)[0]?.body).toEqual({ method: 'sms_code', code: '123456' })
  })

  test('a receipt for the other method is response.invalid, both ways', async () => {
    const { api, tula } = await signedIn()
    api.on(SEND, () => json(200, { ...RECEIPT, method: 'email_code' }))
    expect(await caught(tula.session.prepareStepUp({ method: 'sms_code' }))).toMatchObject({
      code: 'response.invalid',
    })
    api.on('POST /v1/client/sessions/step-up/email-code', () => json(200, RECEIPT))
    expect(await caught(tula.session.prepareStepUp({ method: 'email_code' }))).toMatchObject({
      code: 'response.invalid',
    })
  })

  test('signed out, nothing is asked for', async () => {
    const { api, tula } = setup()
    api.on(REFRESH, () => failure(401, 'session.revoked'))
    for (const call of [
      () => tula.mfa.startSms(),
      () => tula.mfa.confirmSms({ code: '123456' }),
      () => tula.mfa.disableSms(),
      () => tula.session.prepareStepUp({ method: 'sms_code' }),
    ]) {
      expect(await caught(call())).toMatchObject({ code: 'auth.unauthenticated' })
    }
    expect(api.calls(START).length + api.calls(CONFIRM).length + api.calls(SEND).length).toBe(0)
  })
})
