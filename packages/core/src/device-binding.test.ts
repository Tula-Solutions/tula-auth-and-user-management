import { describe, expect, test } from 'bun:test'
import type { DeviceKey } from '@tula/contract/device-binding'
import { createClient, createTulaClient } from './client'
import { isTulaError, type TulaError } from './errors'
import * as Core from './index'
import { memoryStorage } from './storage'
import {
  deferred,
  failure,
  fakeApi,
  fakeEnvironment,
  json,
  manualClock,
  type RecordedRequest,
  sessionTokens,
  TEST_BASE_URL,
  TEST_KEY,
  TEST_USER,
} from './testing/fakes'
import { createTransport, type TransportOptions } from './transport'
import type { FetchLike } from './types'

// Device binding (ADR 0043): the proofs a client with a device key sends, the server's nonce
// and what a refused proof does to the session (nothing).

const REFRESH = 'POST /v1/client/sessions/refresh'
const STORAGE_KEY = `tula.refresh.${TEST_BASE_URL}|${TEST_KEY}`

function transport(fetch: FetchLike, options: Partial<TransportOptions> = {}) {
  return createTransport({
    baseUrl: TEST_BASE_URL,
    publishableKey: TEST_KEY,
    client: 'ios',
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

function decode(segment: string): Record<string, unknown> {
  return JSON.parse(atob(segment.replace(/-/g, '+').replace(/_/g, '/')))
}

function bytes(segment: string): Uint8Array<ArrayBuffer> {
  const binary = atob(segment.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

/** The proof a request carried, read and checked the way a server would. */
async function proofOf(request: RecordedRequest | undefined) {
  const proof = request?.headers.get('dpop') ?? ''
  const [header = '', payload = '', signature = ''] = proof.split('.')
  const head = decode(header)
  const verified = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    await crypto.subtle.importKey(
      'jwk',
      head.jwk as Record<string, string>,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    ),
    bytes(signature),
    new TextEncoder().encode(`${header}.${payload}`)
  )
  return { proof, header: head, payload: decode(payload), verified }
}

const challenge = (nonce: string) =>
  failure(400, 'device.nonce_required', {}, { 'DPoP-Nonce': nonce })

describe('a client with a device key', () => {
  test('sends a proof with every start: a signed dpop+jwt for the method and the API’s address', async () => {
    const key = await Core.generateSoftwareDeviceKey()
    const api = fakeApi()
    api.on('POST /v1/client/sign-ins', () => json(200, { ok: true }))
    const before = Math.floor(Date.now() / 1000)
    await transport(api.fetch, { deviceKey: key }).call('startSignIn', {
      body: { identifier: 'maya@northline.app' },
    })
    const sent = await proofOf(api.requests[0])
    expect(sent.header).toEqual({ typ: 'dpop+jwt', alg: 'ES256', jwk: key.publicJwk })
    expect(Object.keys(key.publicJwk).sort()).toEqual(['crv', 'kty', 'x', 'y'])
    expect(sent.payload).toMatchObject({
      htm: 'POST',
      htu: `${TEST_BASE_URL}/v1/client/sign-ins`,
    })
    expect(sent.payload.iat).toBeGreaterThanOrEqual(before)
    expect(sent.payload.jti).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(sent.payload).not.toHaveProperty('nonce')
    expect(sent.verified).toBe(true)
  })

  test.each([
    ['startSignUp', 'POST /v1/client/sign-ups'],
    ['startSignIn', 'POST /v1/client/sign-ins'],
    ['startPasswordReset', 'POST /v1/client/password-resets'],
    ['startPasskeySignIn', 'POST /v1/client/sign-ins/passkey'],
    ['startOAuthSignIn', 'POST /v1/client/sign-ins/oauth'],
    ['startIdTokenSignIn', 'POST /v1/client/sign-ins/id-token'],
    ['refreshSession', REFRESH],
  ] as const)('%s carries a proof that names its own route', async (id, route) => {
    const key = await Core.generateSoftwareDeviceKey()
    const api = fakeApi()
    api.on(route, () => json(200, {}))
    await transport(api.fetch, { deviceKey: key }).call(id, { body: {} } as never)
    const sent = await proofOf(api.requests[0])
    expect(sent.payload.htu).toBe(`${TEST_BASE_URL}${route.split(' ')[1]}`)
    expect(sent.verified).toBe(true)
  })

  test('no other request carries one: a later step, a signed-in call, a sign-out', async () => {
    const key = await Core.generateSoftwareDeviceKey()
    const api = fakeApi()
    api.on('POST /v1/client/sign-ins/a1/password', () => json(200, {}))
    api.on('GET /v1/client/me', () => json(200, TEST_USER))
    api.on('POST /v1/client/sessions/sign-out', () => new Response(null, { status: 204 }))
    const calls = transport(api.fetch, { deviceKey: key })
    await calls.call('submitSignInPassword', {
      params: { attemptId: 'a1' },
      body: { password: 'x' },
      attemptSecret: 's',
    })
    await calls.call('getMe', { accessToken: 't' })
    await calls.call('signOut', { body: {} })
    expect(api.requests).toHaveLength(3)
    for (const request of api.requests) {
      expect(request.headers.has('dpop')).toBe(false)
    }
  })

  test('a client without a key sends none, and does not repeat a challenge', async () => {
    const api = fakeApi()
    api.on(REFRESH, () => challenge('n1'))
    const error = await caught(transport(api.fetch).call('refreshSession', { body: {} }))
    expect(error.code).toBe('device.nonce_required')
    expect(api.requests).toHaveLength(1)
    expect(api.requests[0]?.headers.has('dpop')).toBe(false)
  })

  test('every proof is new: two calls never share an id or a signature', async () => {
    const key = await Core.generateSoftwareDeviceKey()
    const api = fakeApi()
    api.on(REFRESH, () => json(200, {}))
    const calls = transport(api.fetch, { deviceKey: key })
    await calls.call('refreshSession', { body: {} })
    await calls.call('refreshSession', { body: {} })
    const [a, b] = [await proofOf(api.requests[0]), await proofOf(api.requests[1])]
    expect(a.payload.jti).not.toBe(b.payload.jti)
    expect(a.proof).not.toBe(b.proof)
  })
})

describe('the server’s nonce', () => {
  test('a challenge is answered once, with a new proof that carries the nonce', async () => {
    const key = await Core.generateSoftwareDeviceKey()
    const api = fakeApi()
    api.on(REFRESH, () =>
      api.calls(REFRESH).length === 1 ? challenge('nonce-1') : json(200, { ok: true })
    )
    const result = await transport(api.fetch, { deviceKey: key }).call('refreshSession', {
      body: { refreshToken: 'rt_0' },
    })
    expect(result as unknown).toEqual({ ok: true })
    expect(api.requests).toHaveLength(2)
    const [first, second] = [await proofOf(api.requests[0]), await proofOf(api.requests[1])]
    expect(first.payload).not.toHaveProperty('nonce')
    expect(second.payload.nonce).toBe('nonce-1')
    expect(second.payload.jti).not.toBe(first.payload.jti)
    expect(second.verified).toBe(true)
    // The same request otherwise: the body is sent again unchanged.
    expect(api.requests[1]?.body).toEqual({ refreshToken: 'rt_0' })
  })

  test('a second challenge in a row is an error, after exactly two requests', async () => {
    const key = await Core.generateSoftwareDeviceKey()
    const api = fakeApi()
    api.on(REFRESH, () => challenge(`nonce-${api.calls(REFRESH).length}`))
    const error = await caught(
      transport(api.fetch, { deviceKey: key }).call('refreshSession', { body: {} })
    )
    expect(error.code).toBe('device.nonce_required')
    expect(error.status).toBe(400)
    expect(api.requests).toHaveLength(2)
  })

  test('is kept for the next proof, and replaced by every newer one, from any answer', async () => {
    const key = await Core.generateSoftwareDeviceKey()
    const api = fakeApi()
    api.on('POST /v1/client/sign-ins', () => json(200, {}, { 'DPoP-Nonce': 'from-the-start' }))
    api.on('POST /v1/client/sign-ins/a1/password', () =>
      json(200, {}, { 'DPoP-Nonce': 'from-the-completion' })
    )
    api.on(REFRESH, () =>
      api.calls(REFRESH).length === 2
        ? failure(401, 'device.proof_invalid')
        : json(200, {}, { 'DPoP-Nonce': 'from-the-refresh' })
    )
    const calls = transport(api.fetch, { deviceKey: key })
    await calls.call('startSignIn', { body: { identifier: 'x' } })
    await calls.call('submitSignInPassword', {
      params: { attemptId: 'a1' },
      body: { password: 'x' },
      attemptSecret: 's',
    })
    await calls.call('refreshSession', { body: {} })
    await caught(calls.call('refreshSession', { body: {} }))
    await calls.call('refreshSession', { body: {} })
    const nonces = []
    for (const request of api.calls(REFRESH)) {
      nonces.push((await proofOf(request)).payload.nonce)
    }
    // An answer with no header leaves the nonce the client has.
    expect(nonces).toEqual(['from-the-completion', 'from-the-refresh', 'from-the-refresh'])
  })

  test('the repeat is inside the call’s one deadline', async () => {
    const key = await Core.generateSoftwareDeviceKey()
    let calls = 0
    const fetch: FetchLike = (request) => {
      calls += 1
      if (calls === 1) {
        return Promise.resolve(challenge('n1'))
      }
      return new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }
    const started = Date.now()
    const error = await caught(
      transport(fetch, { deviceKey: key, timeoutMs: 60 }).call('refreshSession', { body: {} })
    )
    expect(error.code).toBe('network.timeout')
    expect(calls).toBe(2)
    // One deadline for both tries, not one each.
    expect(Date.now() - started).toBeLessThan(110)
  })

  test('another 400, and a nonce_required with another status, are not repeated', async () => {
    const key = await Core.generateSoftwareDeviceKey()
    for (const answer of [
      () => failure(400, 'request.malformed', {}, { 'DPoP-Nonce': 'n' }),
      () => failure(401, 'device.nonce_required', {}, { 'DPoP-Nonce': 'n' }),
    ]) {
      const api = fakeApi()
      api.on(REFRESH, answer)
      await caught(transport(api.fetch, { deviceKey: key }).call('refreshSession', { body: {} }))
      expect(api.requests).toHaveLength(1)
    }
  })
})

describe('a key that cannot sign', () => {
  const SECRET = 'the-keystore-said-something-private'
  const broken = async (): Promise<DeviceKey> => ({
    publicJwk: (await Core.generateSoftwareDeviceKey()).publicJwk,
    sign: () => Promise.reject(new Error(SECRET)),
  })

  test('is device.key_failed, with nothing sent and nothing of the failure in the message', async () => {
    const api = fakeApi()
    api.on(REFRESH, () => json(200, {}))
    const error = await caught(
      transport(api.fetch, { deviceKey: await broken() }).call('refreshSession', { body: {} })
    )
    expect(error.code).toBe('device.key_failed')
    expect(error.status).toBe(0)
    expect(error.message).toBe('This device could not sign the request with its key.')
    expect(JSON.stringify(error)).not.toContain(SECRET)
    // The key store's own error is not carried along: an application that logs the error
    // it caught, cause and all, logs nothing of it.
    expect(error.cause).toBeUndefined()
    expect(Bun.inspect(error)).not.toContain(SECRET)
    expect(api.requests).toHaveLength(0)
  })
})

describe('the session of a client with a device key', () => {
  async function signedIn(key: DeviceKey) {
    const api = fakeApi()
    api.on('GET /v1/client/me', () => json(200, TEST_USER))
    api.on(REFRESH, () => json(200, sessionTokens('a', { refreshToken: 'rt_1' })))
    const storage = memoryStorage()
    await storage.set(STORAGE_KEY, 'rt_0')
    const tula = createClient(
      {
        publishableKey: TEST_KEY,
        baseUrl: TEST_BASE_URL,
        client: 'ios',
        fetch: api.fetch,
        storage,
        deviceKey: key,
      },
      fakeEnvironment(manualClock())
    )
    await tula.load()
    return { api, tula, storage }
  }

  test('loads and refreshes with a proof', async () => {
    const key = await Core.generateSoftwareDeviceKey()
    const { api, tula } = await signedIn(key)
    expect(tula.state.status).toBe('signed-in')
    expect((await proofOf(api.calls(REFRESH)[0])).verified).toBe(true)
  })

  test.each([
    ['device.proof_invalid', 401],
    ['device.nonce_required', 400],
    ['device.binding_not_supported', 400],
  ])(
    'a refresh refused with %s does NOT end the session: the token is kept',
    async (code, status) => {
      const key = await Core.generateSoftwareDeviceKey()
      const { api, tula, storage } = await signedIn(key)
      api.on(REFRESH, () => failure(status, code))
      const error = await caught(tula.session.refresh())
      expect(error.code).toBe(code)
      expect(tula.state.status).toBe('signed-in')
      expect(await storage.get(STORAGE_KEY)).toBe('rt_1')
      // And the next refresh, answered, goes on with the same refresh token.
      api.on(REFRESH, () => json(200, sessionTokens('b', { refreshToken: 'rt_2' })))
      await tula.session.refresh()
      expect(api.calls(REFRESH).at(-1)?.body).toEqual({ refreshToken: 'rt_1' })
      expect(await storage.get(STORAGE_KEY)).toBe('rt_2')
    }
  )

  test('a session.* answer still ends it, as before', async () => {
    const key = await Core.generateSoftwareDeviceKey()
    const { api, tula, storage } = await signedIn(key)
    api.on(REFRESH, () => failure(401, 'session.revoked'))
    expect(await tula.session.refresh()).toBeNull()
    expect(tula.state.status).toBe('signed-out')
    expect(await storage.get(STORAGE_KEY)).toBeNull()
  })

  test('a challenge is answered inside the single flight: callers at once share one refresh', async () => {
    const key = await Core.generateSoftwareDeviceKey()
    const { api, tula } = await signedIn(key)
    const before = api.calls(REFRESH).length
    const gate = deferred<void>()
    api.on(REFRESH, async () => {
      if (api.calls(REFRESH).length === before + 1) {
        await gate.promise
        return challenge('n9')
      }
      return json(200, sessionTokens('c', { refreshToken: 'rt_3' }))
    })
    const all = Promise.all([
      tula.session.refresh(),
      tula.session.refresh(),
      tula.session.refresh(),
    ])
    gate.resolve()
    const tokens = await all
    expect(new Set(tokens).size).toBe(1)
    // One refresh, two requests: the challenge and its answer. Both presented the same token.
    const sent = api.calls(REFRESH).slice(before)
    expect(sent.map((request) => request.body)).toEqual([
      { refreshToken: 'rt_1' },
      { refreshToken: 'rt_1' },
    ])
    expect((await proofOf(sent[1])).payload.nonce).toBe('n9')
  })

  test('the key that cannot sign leaves the session as it is', async () => {
    const key = await Core.generateSoftwareDeviceKey()
    const { tula, storage } = await signedIn(key)
    const sign = key.sign
    key.sign = () => Promise.reject(new Error('locked'))
    const error = await caught(tula.session.refresh())
    expect(error.code).toBe('device.key_failed')
    expect(tula.state.status).toBe('signed-in')
    expect(await storage.get(STORAGE_KEY)).toBe('rt_1')
    key.sign = sign
    await tula.session.refresh()
  })
})

describe('createTulaClient', () => {
  test('refuses a device key for a web client', async () => {
    const deviceKey = await Core.generateSoftwareDeviceKey()
    const options = {
      publishableKey: TEST_KEY,
      baseUrl: TEST_BASE_URL,
      client: 'web' as const,
      deviceKey,
    }
    expect(() => createTulaClient(options)).toThrow(TypeError)
    expect(() => createTulaClient(options)).toThrow(/`deviceKey`/)
  })

  test('a software key’s private half cannot be read back', async () => {
    const key = await Core.generateSoftwareDeviceKey()
    expect(JSON.stringify(key)).not.toContain('"d"')
    expect(Object.keys(key).sort()).toEqual(['publicJwk', 'sign'])
    expect((await key.sign(new Uint8Array([1, 2, 3]))).byteLength).toBe(64)
  })
})
