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

describe('the public surface', () => {
  test('exports exactly these values', () => {
    expect(Object.keys(Core).sort()).toEqual([
      'ACCESS_TOKEN_EXPIRY_SKEW_MS',
      'DEFAULT_TIMEOUT_MS',
      'EN_MESSAGES',
      'MAX_REFRESH_BACKOFF_MS',
      'REFRESH_RETRY_WINDOW_MS',
      'REFRESH_TIMEOUT_MS',
      'TulaError',
      'createTulaClient',
      'evaluatePassword',
      'formatMessage',
      'isTulaError',
      'memoryStorage',
    ])
    expect(DEFAULT_TIMEOUT_MS).toBe(15_000)
    expect(Core.ACCESS_TOKEN_EXPIRY_SKEW_MS).toBe(10_000)
  })
})
