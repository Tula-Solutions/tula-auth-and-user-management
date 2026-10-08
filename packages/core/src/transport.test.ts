import { afterEach, describe, expect, test } from 'bun:test'
import { isTulaError, type Messages, type TulaError } from './errors'
import { failure, fakeApi, json, TEST_BASE_URL, TEST_KEY } from './testing/fakes'
import { createTransport, type TransportOptions } from './transport'
import type { FetchLike } from './types'

function transport(fetch: FetchLike, options: Partial<TransportOptions> = {}) {
  return createTransport({
    baseUrl: TEST_BASE_URL,
    publishableKey: TEST_KEY,
    client: 'server',
    fetch,
    timeoutMs: 1_000,
    messages: () => ({}),
    ...options,
  })
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

const RealRequest = globalThis.Request

afterEach(() => {
  globalThis.Request = RealRequest
})

/** Records the init each `Request` is built with: Bun does not report `credentials` back. */
function recordRequestInits(): (RequestInit | undefined)[] {
  const inits: (RequestInit | undefined)[] = []
  globalThis.Request = class extends RealRequest {
    constructor(...args: ConstructorParameters<typeof Request>) {
      inits.push(args[1])
      super(...args)
    }
  } as typeof Request
  return inits
}

describe('requests', () => {
  test('carry the publishable key, the client kind and JSON headers', async () => {
    const api = fakeApi()
    api.on('POST /v1/client/sign-ins', () => json(200, { ok: true }))
    await transport(api.fetch, { client: 'ios' }).call('startSignIn', {
      body: { identifier: 'maya@northline.app' },
    })
    const [request] = api.requests
    expect(request?.body).toEqual({ identifier: 'maya@northline.app' })
    expect(Object.fromEntries(request?.headers ?? [])).toMatchObject({
      accept: 'application/json',
      'content-type': 'application/json',
      'x-tula-publishable-key': TEST_KEY,
      'x-tula-client': 'ios',
    })
    expect(request?.headers.has('authorization')).toBe(false)
    expect(request?.headers.has('x-tula-attempt')).toBe(false)
  })

  test('put path parameters in the path (escaped), the access token and the attempt secret in headers', async () => {
    const api = fakeApi()
    api.on('POST /v1/client/sign-ins/a%2Fb/password', () => json(200, {}))
    api.on('DELETE /v1/client/sessions/s%201', () => new Response(null, { status: 204 }))
    const t = transport(api.fetch)
    await t.call('submitSignInPassword', {
      params: { attemptId: 'a/b' },
      body: { password: 'pw' },
      attemptSecret: 'tula_at_secret',
    })
    expect(api.requests[0]?.headers.get('x-tula-attempt')).toBe('tula_at_secret')
    expect(
      await t.call('revokeSession', { params: { sessionId: 's 1' }, accessToken: 'token' })
    ).toBeUndefined()
    expect(api.requests[1]?.headers.get('authorization')).toBe('Bearer token')
    expect(api.requests[1]?.headers.has('content-type')).toBe(false)
    expect(api.requests[1]?.body).toBeUndefined()
  })

  test('a web client sends cookies; every other kind leaves the option out', async () => {
    const api = fakeApi()
    api.on('GET /v1/client/config', () => json(200, {}))
    const inits = recordRequestInits()
    await transport(api.fetch, { client: 'web' }).call('getClientConfig', {})
    await transport(api.fetch, { client: 'server' }).call('getClientConfig', {})
    await transport(api.fetch, { client: 'android' }).call('getClientConfig', {})
    expect(inits[0]?.credentials).toBe('include')
    expect(inits[1] && 'credentials' in inits[1]).toBe(false)
    expect(inits[2] && 'credentials' in inits[2]).toBe(false)
  })
})

describe('errors', () => {
  test('an error envelope becomes a TulaError with code, status, params and localised field errors', async () => {
    const api = fakeApi()
    api.on('POST /v1/client/sign-ups', () =>
      failure(422, 'validation.failed', {
        params: { fields: 2, nested: { dropped: true } },
        errors: [
          {
            field: 'password',
            code: 'password.too_short',
            message: 'Password is too short.',
            params: { min: 10 },
          },
          { field: 'email', code: 'email.invalid', message: 'Enter a valid email address.' },
          {
            field: 'email',
            code: 'validation.failed',
            message: 'Too big: expected string to have <=320 characters',
          },
          { field: 7, code: 'broken' },
          'not an object',
        ],
      })
    )
    const messages: Messages = { 'password.too_short': 'Usa al menos {min} caracteres.' }
    const error = await caught(
      transport(api.fetch, { messages: () => messages }).call('startSignUp', {
        body: { email: 'x', password: 'y' },
      })
    )
    expect(error).toMatchObject({
      code: 'validation.failed',
      status: 422,
      message: 'Some fields are invalid.',
      params: { fields: 2 },
      retryAfterMs: undefined,
    })
    expect(error.errors).toEqual([
      {
        field: 'password',
        code: 'password.too_short',
        message: 'Usa al menos 10 caracteres.',
        params: { min: 10 },
      },
      {
        field: 'email',
        code: 'email.invalid',
        message: 'Enter a valid email address.',
        params: {},
      },
      {
        field: 'email',
        code: 'validation.failed',
        message: 'Too big: expected string to have <=320 characters',
        params: {},
      },
    ])
  })

  test('a field error without a message gets the code’s English one', async () => {
    const api = fakeApi()
    api.on('POST /v1/client/sign-ups', () =>
      failure(422, 'validation.failed', {
        errors: [{ field: 'password', code: 'password.common' }],
      })
    )
    const error = await caught(
      transport(api.fetch).call('startSignUp', { body: { email: 'x', password: 'y' } })
    )
    expect(error.errors[0]?.message).toBe('This password is too common.')
  })

  test('a code this version does not know keeps the server’s detail as its message', async () => {
    const api = fakeApi()
    api.on('GET /v1/client/config', () =>
      json(418, { status: 418, code: 'future.code', detail: 'From the future.' })
    )
    api.on('GET /v1/client/password-policy', () => json(418, { status: 418, code: 'future.code' }))
    const t = transport(api.fetch)
    expect(await caught(t.call('getClientConfig', {}))).toMatchObject({
      code: 'future.code',
      status: 418,
      message: 'From the future.',
    })
    expect((await caught(t.call('getPasswordPolicy', {}))).message).toBe(
      'Something went wrong on our side.'
    )
  })

  test.each([
    ['seconds in the header', { 'retry-after': '12' }, {}, 12_000],
    ['seconds with spaces', { 'retry-after': ' 3 ' }, {}, 3_000],
    ['the header over the param', { 'retry-after': '2' }, { retryAfter: 9 }, 2_000],
    ['the param when the header is hidden', {}, { retryAfter: 9 }, 9_000],
    ['a date in the past', { 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' }, {}, 0],
    ['nothing', {}, {}, undefined],
    ['garbage', { 'retry-after': 'soon' }, { retryAfter: 'later' }, undefined],
  ] as [string, Record<string, string>, Record<string, unknown>, number | undefined][])(
    'retryAfterMs comes from %s',
    async (_name, headers, params, expected) => {
      const api = fakeApi()
      api.on('GET /v1/client/config', () => failure(429, 'rate_limited', { params }, headers))
      const error = await caught(transport(api.fetch).call('getClientConfig', {}))
      expect(error.retryAfterMs).toBe(expected)
      expect(error.code).toBe('rate_limited')
    }
  )

  test('a Retry-After date in the future is the time until then', async () => {
    const api = fakeApi()
    const date = new Date(Date.now() + 60_000).toUTCString()
    api.on('GET /v1/client/config', () =>
      failure(503, 'service.unavailable', {}, { 'retry-after': date })
    )
    const error = await caught(transport(api.fetch).call('getClientConfig', {}))
    expect(error.retryAfterMs).toBeGreaterThan(55_000)
    expect(error.retryAfterMs).toBeLessThanOrEqual(60_000)
  })

  test.each([
    [
      'an HTML error page',
      new Response('<html>Bad gateway</html>', { status: 502, headers: { 'retry-after': '5' } }),
      502,
      5_000,
    ],
    ['JSON that is not the envelope', json(500, { message: 'oops' }), 500, undefined],
    ['a JSON array', json(400, ['no']), 400, undefined],
    ['a success that is not JSON', new Response('ok', { status: 200 }), 200, undefined],
  ] as [string, Response, number, number | undefined][])(
    '%s is response.invalid, with the status',
    async (_name, response, status, retryAfterMs) => {
      const error = await caught(transport(async () => response).call('getClientConfig', {}))
      expect(error).toMatchObject({ code: 'response.invalid', status, retryAfterMs })
      expect(error.message).toBe('The server sent a response this app could not read.')
    }
  )

  test('a fetch that throws is network.failed, with the cause', async () => {
    const cause = new TypeError('fetch failed')
    const error = await caught(
      transport(() => Promise.reject(cause), {
        messages: () => ({ 'network.failed': 'Sin conexión.' }),
      }).call('getClientConfig', {})
    )
    expect(error).toMatchObject({ code: 'network.failed', status: 0, message: 'Sin conexión.' })
    expect(error.cause).toBe(cause)
  })

  test('a request that outlasts the timeout is aborted and is network.timeout', async () => {
    let aborted = false
    const never: FetchLike = (request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          aborted = true
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    const error = await caught(transport(never, { timeoutMs: 15 }).call('getClientConfig', {}))
    expect(error).toMatchObject({ code: 'network.timeout', status: 0 })
    expect(aborted).toBe(true)
  })

  test('a body that stalls is covered by the same timeout', async () => {
    const stalled: FetchLike = async (request) =>
      new Response(
        new ReadableStream({
          start(controller) {
            request.signal.addEventListener('abort', () => controller.error(new Error('aborted')))
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    const error = await caught(transport(stalled, { timeoutMs: 15 }).call('getClientConfig', {}))
    expect(error.code).toBe('network.timeout')
  })

  test('no error ever contains the access token or the attempt secret', async () => {
    const api = fakeApi()
    api.on('POST /v1/client/sign-ins/a/password', () => failure(401, 'auth.invalid_credentials'))
    const error = await caught(
      transport(api.fetch).call('submitSignInPassword', {
        params: { attemptId: 'a' },
        body: { password: 'hunter2-password' },
        accessToken: 'access-token-value',
        attemptSecret: 'tula_at_secret_value',
      })
    )
    const everything =
      JSON.stringify(error) + error.message + String(error.stack) + String(error.cause)
    for (const secret of ['access-token-value', 'tula_at_secret_value', 'hunter2-password']) {
      expect(everything).not.toContain(secret)
    }
  })
})

describe('codes that name inherited object properties (review F3)', () => {
  test.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'an error answer with code %p is a TulaError carrying the server’s detail',
    async (code) => {
      const api = fakeApi()
      api.on('GET /v1/client/config', () =>
        json(400, {
          status: 400,
          code,
          detail: 'x',
          params: { constructor: 1, toString: 'y' },
          errors: [
            { field: 'f', code, message: 'm' },
            { field: 'g', code },
          ],
        })
      )
      const error = await caught(transport(api.fetch).call('getClientConfig', {}))
      expect(error).toMatchObject({ code, status: 400, message: 'x' })
      expect(error.errors.map((problem) => problem.message)).toEqual([
        'm',
        'Something went wrong on our side.',
      ])
    }
  )

  test('a per-call timeout overrides the transport’s', async () => {
    const never: FetchLike = (request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError'))
        )
      })
    const started = Date.now()
    const error = await caught(
      transport(never, { timeoutMs: 5_000 }).call('refreshSession', { body: {}, timeoutMs: 15 })
    )
    expect(error.code).toBe('network.timeout')
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

describe('a bodiless answer (204) is a finished request', () => {
  test('the request is never aborted after it succeeded, even once the timeout has passed', async () => {
    let signal: AbortSignal | undefined
    const t = transport(
      async (request) => {
        signal = request.signal
        return new Response(null, { status: 204 })
      },
      { timeoutMs: 20 }
    )
    expect(await t.call('signOut', { body: {} })).toBeUndefined()
    expect(signal?.aborted).toBe(false)
    // The timer was cleared with the answer: it does not fire later either.
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(signal?.aborted).toBe(false)
  })

  test('its (empty) body is read to the end, so a browser records the request as finished, not cancelled', async () => {
    // Chromium reports a fetch whose body was never consumed as `net::ERR_ABORTED` in the
    // network panel when the response is collected, with or without an AbortSignal.
    let answered: Response | undefined
    const t = transport(async () => {
      answered = new Response(new ReadableStream({ start: (controller) => controller.close() }), {
        status: 204,
      })
      return answered
    })
    await t.call('signOut', { body: {} })
    expect(answered?.bodyUsed).toBe(true)
  })

  test('a 204 whose body stalls is still a timeout', async () => {
    const t = transport(
      async (request) =>
        new Response(
          new ReadableStream({
            start(controller) {
              request.signal.addEventListener('abort', () => controller.error(new Error('aborted')))
            },
          }),
          { status: 204 }
        ),
      { timeoutMs: 20 }
    )
    expect((await caught(t.call('signOut', { body: {} }))).code).toBe('network.timeout')
  })

  test('a 204 whose body cannot be read is still a success', async () => {
    const t = transport(
      async () =>
        new Response(
          new ReadableStream({ start: (controller) => controller.error(new Error('x')) }),
          {
            status: 204,
          }
        )
    )
    expect(await t.call('signOut', { body: {} })).toBeUndefined()
  })
})
