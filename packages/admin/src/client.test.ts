import { describe, expect, spyOn, test } from 'bun:test'
import { PUBLISHABLE_KEY_PREFIX, SECRET_KEY_PREFIX } from '@tula/contract'
import {
  type AdminFetch,
  createAdminClient,
  etagRevision,
  ifMatch,
  isTulaAdminError,
  type TulaAdminError,
} from './index'

const SECRET_KEY = 'tula_sk_dev_unit0000000000000000000000000000000'

interface Seen {
  url: string
  method: string
  headers: Headers
  body: string | null
}

function fakeFetch(answer: (seen: Seen) => Response | Promise<Response>): {
  fetch: AdminFetch
  seen: Seen[]
} {
  const seen: Seen[] = []
  const fetch: AdminFetch = async (url, init) => {
    const request: Seen = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    }
    seen.push(request)
    return answer(request)
  }
  return { fetch, seen }
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  })
}

async function failure(promise: Promise<unknown>): Promise<TulaAdminError> {
  try {
    await promise
  } catch (error) {
    if (isTulaAdminError(error)) {
      return error
    }
    throw error
  }
  throw new Error('expected the call to fail')
}

function refusal(build: () => unknown): TulaAdminError {
  try {
    build()
  } catch (error) {
    if (isTulaAdminError(error)) {
      return error
    }
    throw error
  }
  throw new Error('expected the client to be refused')
}

describe('createAdminClient', () => {
  test('the key prefixes are the contract’s', () => {
    expect(SECRET_KEY.startsWith(SECRET_KEY_PREFIX)).toBe(true)
    expect(refusal(() => client(`${PUBLISHABLE_KEY_PREFIX}dev_abc`)).code).toBe(
      'client.publishable_key'
    )
  })

  function client(secretKey: string) {
    return createAdminClient({ baseUrl: 'https://auth.example.com', secretKey })
  }

  test.each([
    ['a publishable key', 'tula_pk_dev_abcdefghijklmnop', 'client.publishable_key'],
    ['an empty key', '', 'client.invalid_key'],
    ['something that is not a key', 'hunter2-not-a-key', 'client.invalid_key'],
    ['a key with a line break', 'tula_sk_dev_abc\r\nx-evil: 1', 'client.invalid_key'],
  ])('refuses %s without echoing it', (_name, key, code) => {
    const error = refusal(() => client(key))
    expect(error.code).toBe(code)
    expect(error.status).toBe(0)
    if (key !== '') {
      expect(error.message).not.toContain(key)
      expect(JSON.stringify(error)).not.toContain(key)
    }
  })

  test.each([
    ['not a URL', 'auth.example.com'],
    ['another scheme', 'ftp://auth.example.com'],
    ['credentials in the URL', 'https://user:pass@auth.example.com'],
  ])('refuses a base URL that is %s', (_name, baseUrl) => {
    expect(refusal(() => createAdminClient({ baseUrl, secretKey: SECRET_KEY })).code).toBe(
      'client.invalid_url'
    )
  })

  test.each([
    ['a public host', 'http://auth.example.com'],
    ['a private address', 'http://10.0.0.5:3003'],
    ['a host that only starts like localhost', 'http://localhost.example.com'],
    ['a host that only ends like localhost', 'http://notlocalhost'],
    ['an address that only starts like loopback', 'http://127.0.0.1.example.com'],
  ])('refuses plain http to %s, and sends nothing', async (_name, baseUrl) => {
    const { fetch, seen } = fakeFetch(() => json({}))
    const error = refusal(() => createAdminClient({ baseUrl, secretKey: SECRET_KEY, fetch }))
    expect(error.code).toBe('client.invalid_url')
    expect(error.status).toBe(0)
    expect(seen).toEqual([])
  })

  test.each([
    ['localhost', 'http://localhost:3003'],
    ['a name under .localhost', 'http://api.tula.localhost:3003'],
    ['127.0.0.1', 'http://127.0.0.1:3003'],
    ['[::1]', 'http://[::1]:3003'],
    ['LOCALHOST in capitals', 'http://LOCALHOST:3003'],
  ])('allows plain http to %s', async (_name, baseUrl) => {
    const { fetch, seen } = fakeFetch(() => json({ data: [] }))
    await createAdminClient({ baseUrl, secretKey: SECRET_KEY, fetch }).call('listOAuthProviders')
    expect(seen).toHaveLength(1)
  })

  test('allowInsecureHttp is the explicit way to use plain http on a private network', async () => {
    const { fetch, seen } = fakeFetch(() => json({ data: [] }))
    const admin = createAdminClient({
      baseUrl: 'http://tula.internal:3003',
      secretKey: SECRET_KEY,
      fetch,
      allowInsecureHttp: true,
    })
    await admin.call('listOAuthProviders')
    expect(seen[0]?.url).toBe('http://tula.internal:3003/v1/admin/oauth-providers')
    // It widens http only: another scheme and credentials stay refused.
    for (const baseUrl of ['ftp://tula.internal', 'http://user:pass@tula.internal']) {
      expect(
        refusal(() =>
          createAdminClient({ baseUrl, secretKey: SECRET_KEY, allowInsecureHttp: true })
        ).code
      ).toBe('client.invalid_url')
    }
  })

  test('refuses to be created in a browser', () => {
    const globals = globalThis as { window?: unknown; document?: unknown }
    globals.window = {}
    globals.document = {}
    try {
      expect(refusal(() => client(SECRET_KEY)).code).toBe('client.browser')
    } finally {
      delete globals.window
      delete globals.document
    }
  })

  test('the client never shows its key', () => {
    const admin = client(SECRET_KEY)
    expect(JSON.stringify(admin)).not.toContain(SECRET_KEY)
    expect(Bun.inspect(admin)).not.toContain(SECRET_KEY)
    expect(Object.values(admin).some((value) => value === SECRET_KEY)).toBe(false)
  })
})

describe('call', () => {
  test('sends the method, path, query, headers and body of the operation', async () => {
    const { fetch, seen } = fakeFetch(() =>
      json({ revision: 4, settings: {} }, { headers: { etag: '"4"' } })
    )
    const admin = createAdminClient({
      baseUrl: 'https://auth.example.com/',
      secretKey: SECRET_KEY,
      fetch,
      userAgent: 'unit/1',
    })
    const answer = await admin.call('replaceEnvironmentSettings', {
      headers: { 'If-Match': ifMatch(3) },
      body: { app: { name: 'Northline' } },
    })
    expect(answer.status).toBe(200)
    expect(answer.etag).toBe('"4"')
    expect(answer.data.revision).toBe(4)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('https://auth.example.com/v1/admin/settings')
    expect(seen[0]?.method).toBe('PUT')
    expect(seen[0]?.headers.get('authorization')).toBe(`Bearer ${SECRET_KEY}`)
    expect(seen[0]?.headers.get('if-match')).toBe('"3"')
    expect(seen[0]?.headers.get('content-type')).toBe('application/json')
    expect(seen[0]?.headers.get('user-agent')).toBe('unit/1')
    expect(seen[0]?.body).toBe('{"app":{"name":"Northline"}}')
  })

  test('fills path parameters (encoded) and query parameters (undefined left out)', async () => {
    const { fetch, seen } = fakeFetch(() => json({ data: [], page: 1, size: 20, total: 0 }))
    const admin = createAdminClient({
      baseUrl: 'http://localhost:3003',
      secretKey: SECRET_KEY,
      fetch,
    })
    await admin.call('listUsers', { query: { q: 'a b&c', page: 2, size: undefined } })
    expect(seen[0]?.url).toBe('http://localhost:3003/v1/admin/users?q=a+b%26c&page=2')
    expect(seen[0]?.body).toBeNull()
    expect(seen[0]?.headers.has('content-type')).toBe(false)

    await admin.call('getUser', { params: { userId: 'a b?c#d%2e' } })
    expect(seen[1]?.url).toBe('http://localhost:3003/v1/admin/users/a%20b%3Fc%23d%252e')
  })

  test.each([
    ['..', '..'],
    ['.', '.'],
    ['empty', ''],
    ['a value with a slash', '../settings'],
    ['a value with a backslash', '..\\settings'],
    ['a value with a control character', 'abc\u0000def'],
    ['a value with a line break', 'abc\ndef'],
  ])(
    'a path parameter that is %s is refused before any request, naming the parameter only',
    async (_name, userId) => {
      const { fetch, seen } = fakeFetch(() => json({}))
      const admin = createAdminClient({
        baseUrl: 'https://auth.example.com',
        secretKey: SECRET_KEY,
        fetch,
      })
      const error = await failure(admin.call('banUser', { params: { userId } }))
      expect(error.code).toBe('client.invalid_param')
      expect(error.status).toBe(0)
      expect(error.operation).toBe('banUser')
      expect(error.params).toEqual({ param: 'userId' })
      expect(error.message).toContain('userId')
      if (userId.length > 2) {
        expect(JSON.stringify(error)).not.toContain(JSON.stringify(userId).slice(1, -1))
      }
      expect(seen).toEqual([])
    }
  )

  test('a path parameter that is missing is refused the same way', async () => {
    const { fetch, seen } = fakeFetch(() => json({}))
    const admin = createAdminClient({
      baseUrl: 'https://auth.example.com',
      secretKey: SECRET_KEY,
      fetch,
    })
    const error = await failure(admin.call('banUser', { params: {} } as never))
    expect(error.code).toBe('client.invalid_param')
    expect(seen).toEqual([])
  })

  test('an ordinary id fills its place in the path', async () => {
    const { fetch, seen } = fakeFetch(() => json({}))
    const admin = createAdminClient({
      baseUrl: 'https://auth.example.com',
      secretKey: SECRET_KEY,
      fetch,
    })
    const userId = '0198c2de-7b1a-7c3e-9f00-5a1b2c3d4e5f'
    await admin.call('banUser', { params: { userId } })
    expect(seen.map((request) => request.url)).toEqual([
      `https://auth.example.com/v1/admin/users/${userId}/ban`,
    ])
  })

  test('an operation with no input takes none, and a 204 answers undefined', async () => {
    const { fetch } = fakeFetch(() => new Response(null, { status: 204 }))
    const admin = createAdminClient({
      baseUrl: 'http://localhost:3003',
      secretKey: SECRET_KEY,
      fetch,
    })
    const answer = await admin.call('deleteOAuthProvider', { params: { provider: 'google' } })
    expect(answer.data).toBeUndefined()
    expect(answer.status).toBe(204)
    expect(answer.etag).toBeNull()
  })

  test('a caller’s header can never replace the key', async () => {
    const { fetch, seen } = fakeFetch(() => json({ revision: 1, settings: {} }))
    const admin = createAdminClient({
      baseUrl: 'http://localhost:3003',
      secretKey: SECRET_KEY,
      fetch,
    })
    await admin.call('replaceEnvironmentSettings', {
      headers: { 'If-Match': '"0"', Authorization: 'Bearer other' } as { 'If-Match': string },
      body: {},
    })
    expect(seen[0]?.headers.get('authorization')).toBe(`Bearer ${SECRET_KEY}`)
  })

  test('an error answer becomes one error with the envelope’s code, fields and params', async () => {
    const { fetch } = fakeFetch(() =>
      json(
        {
          status: 422,
          code: 'validation.failed',
          detail: 'The request is not valid.',
          params: { max: 3, nested: { dropped: true } },
          errors: [
            {
              field: 'password.minLength',
              code: 'validation.failed',
              message: 'must be at least 8',
            },
            { field: 'x', code: 'password.too_short', params: { min: 10 } },
            'not an entry',
          ],
        },
        { status: 422 }
      )
    )
    const admin = createAdminClient({
      baseUrl: 'http://localhost:3003',
      secretKey: SECRET_KEY,
      fetch,
    })
    const error = await failure(admin.call('getEnvironmentSettings'))
    expect(error.name).toBe('TulaAdminError')
    expect(error.code).toBe('validation.failed')
    expect(error.status).toBe(422)
    expect(error.message).toBe('The request is not valid.')
    expect(error.operation).toBe('getEnvironmentSettings')
    expect(error.params).toEqual({ max: 3 })
    expect(error.errors).toEqual([
      {
        field: 'password.minLength',
        code: 'validation.failed',
        message: 'must be at least 8',
        params: {},
      },
      {
        field: 'x',
        code: 'password.too_short',
        message: 'Password is too short.',
        params: { min: 10 },
      },
    ])
  })

  test.each([
    ['seconds', { 'retry-after': '7' }, {}, 7000],
    ['the error’s param when the header is missing', {}, { retryAfter: 3 }, 3000],
    ['nothing', {}, {}, undefined],
  ])('Retry-After is read from %s', async (_name, headers, params, expected) => {
    const { fetch } = fakeFetch(() =>
      json(
        { status: 429, code: 'rate_limited', detail: 'Slow down.', params },
        { status: 429, headers }
      )
    )
    const admin = createAdminClient({
      baseUrl: 'http://localhost:3003',
      secretKey: SECRET_KEY,
      fetch,
    })
    const error = await failure(admin.call('getEnvironmentSettings'))
    expect(error.code).toBe('rate_limited')
    expect(error.retryAfterMs).toBe(expected)
  })

  test('Retry-After as a date is read against the clock', async () => {
    const at = new Date(Date.now() + 60_000).toUTCString()
    const { fetch } = fakeFetch(() =>
      json(
        { status: 503, code: 'service.unavailable', detail: 'Later.' },
        {
          status: 503,
          headers: { 'retry-after': at },
        }
      )
    )
    const admin = createAdminClient({
      baseUrl: 'http://localhost:3003',
      secretKey: SECRET_KEY,
      fetch,
    })
    const error = await failure(admin.call('getEnvironmentSettings'))
    expect(error.retryAfterMs).toBeGreaterThan(50_000)
    expect(error.retryAfterMs).toBeLessThanOrEqual(60_000)
  })

  test.each([
    [
      'an error that is not the envelope',
      () => new Response('<html>502</html>', { status: 502 }),
      502,
    ],
    ['an error envelope without a code', () => json({ detail: 'x' }, { status: 500 }), 500],
    ['a success that is not JSON', () => new Response('nope', { status: 200 }), 200],
  ])('%s is response.invalid', async (_name, answer, status) => {
    const { fetch } = fakeFetch(answer)
    const admin = createAdminClient({
      baseUrl: 'http://localhost:3003',
      secretKey: SECRET_KEY,
      fetch,
    })
    const error = await failure(admin.call('getEnvironmentSettings'))
    expect(error.code).toBe('response.invalid')
    expect(error.status).toBe(status)
  })

  test('no answer is network.failed, and the cause never carries the key', async () => {
    const { fetch } = fakeFetch(() => {
      throw new TypeError(`connect failed with Bearer ${SECRET_KEY}`)
    })
    const admin = createAdminClient({
      baseUrl: 'http://localhost:3003',
      secretKey: SECRET_KEY,
      fetch,
    })
    const error = await failure(admin.call('getEnvironmentSettings'))
    expect(error.code).toBe('network.failed')
    expect(error.status).toBe(0)
    expect(error.message).not.toContain(SECRET_KEY)
    expect(JSON.stringify(error)).not.toContain(SECRET_KEY)
    expect(Bun.inspect(error)).not.toContain(SECRET_KEY)
  })

  test('a request that takes too long is network.timeout', async () => {
    const fetch: AdminFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError'))
        )
      })
    const admin = createAdminClient({
      baseUrl: 'http://localhost:3003',
      secretKey: SECRET_KEY,
      fetch,
      timeoutMs: 5,
    })
    const error = await failure(admin.call('getEnvironmentSettings'))
    expect(error.code).toBe('network.timeout')
  })

  test('a caller’s abort is network.aborted, also when already aborted', async () => {
    const fetch: AdminFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException('aborted', 'AbortError'))
        }
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError'))
        )
      })
    const admin = createAdminClient({
      baseUrl: 'http://localhost:3003',
      secretKey: SECRET_KEY,
      fetch,
    })
    const controller = new AbortController()
    const pending = failure(admin.call('getEnvironmentSettings', { signal: controller.signal }))
    controller.abort()
    expect((await pending).code).toBe('network.aborted')
    expect(
      (await failure(admin.call('getEnvironmentSettings', { signal: controller.signal }))).code
    ).toBe('network.aborted')
  })

  test('a redirect is never followed: the key goes to the configured origin only', async () => {
    const { fetch, seen } = fakeFetch((request) => {
      expect(request.url.startsWith('http://localhost:3003/')).toBe(true)
      return new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })
    })
    const admin = createAdminClient({
      baseUrl: 'http://localhost:3003',
      secretKey: SECRET_KEY,
      fetch,
    })
    const error = await failure(admin.call('getEnvironmentSettings'))
    expect(error.code).toBe('response.invalid')
    expect(seen).toHaveLength(1)
  })
})

describe('revisions', () => {
  test('ifMatch quotes a revision', () => {
    expect(ifMatch(0)).toBe('"0"')
    expect(ifMatch(12)).toBe('"12"')
  })

  test.each([
    ['"3"', 3],
    ['W/"3"', 3],
    ['"abc"', null],
    ['3', null],
    [null, null],
  ])('etagRevision(%p) is %p', (etag, revision) => {
    expect(etagRevision(etag)).toBe(revision)
  })
})

describe('defaults', () => {
  test('without a fetch of its own the client uses the platform’s', async () => {
    const platform = spyOn(globalThis, 'fetch').mockImplementation((async () =>
      json({ data: [] })) as unknown as typeof fetch)
    try {
      const admin = createAdminClient({ baseUrl: 'http://localhost:3003', secretKey: SECRET_KEY })
      expect((await admin.call('listOAuthProviders')).data).toEqual({ data: [] })
      expect(platform).toHaveBeenCalledTimes(1)
    } finally {
      platform.mockRestore()
    }
  })

  test('the browser entry refuses to load', async () => {
    await expect(import('./browser')).rejects.toThrow('must not be bundled for a browser')
  })

  test('the published manifest sends a browser bundle to the entry that refuses', async () => {
    const manifest = (await Bun.file(`${import.meta.dir}/../package.json`).json()) as {
      publishConfig: { exports: Record<string, Record<string, unknown>> }
    }
    const entry = manifest.publishConfig.exports['.'] ?? {}
    // Order is resolution order: the server runtimes that also set `browser` come first.
    expect(Object.keys(entry)).toEqual(['edge-light', 'workerd', 'browser', 'types', 'default'])
    expect(entry.browser).toEqual({ types: './dist/index.d.ts', default: './dist/browser.js' })
    expect(entry['edge-light']).toEqual({ types: './dist/index.d.ts', default: './dist/index.js' })
    expect(entry.default).toBe('./dist/index.js')
  })
})
