import { afterEach, describe, expect, jest, spyOn, test } from 'bun:test'
import { DEFAULT_WEB_SESSION_PROFILE, durationToMs, MIN_REUSE_GRACE_PERIOD } from '@tula/contract'
import { createClient, type TulaClient, type TulaClientOptions } from './client'
import type { LockManagerLike } from './environment'
import { isTulaError, type TulaError } from './errors'
import {
  ACCESS_TOKEN_EXPIRY_SKEW_MS,
  createSessionManager,
  MAX_REFRESH_BACKOFF_MS,
  REFRESH_RETRY_WINDOW_MS,
  REFRESH_TIMEOUT_MS,
  refreshBudgetMs,
} from './session'
import { memoryStorage, type TokenStorage } from './storage'
import {
  accessToken,
  deferred,
  type FakeApi,
  type FakeChannelHub,
  failure,
  fakeApi,
  fakeChannelHub,
  fakeEnvironment,
  fakeLocks,
  json,
  type ManualClock,
  manualClock,
  sessionTokens,
  TEST_BASE_URL,
  TEST_KEY,
  TEST_USER,
} from './testing/fakes'
import { createTransport } from './transport'
import type { AuthState, ClientKind } from './types'

const REFRESH = 'POST /v1/client/sessions/refresh'
const SIGN_OUT = 'POST /v1/client/sessions/sign-out'
const ME = 'GET /v1/client/me'
const SESSIONS = 'GET /v1/client/sessions'
const STORAGE_KEY = `tula.refresh.${TEST_BASE_URL}|${TEST_KEY}`

interface Tab {
  tula: TulaClient
  states: AuthState[]
  storage: TokenStorage
}

interface World {
  api: FakeApi
  clock: ManualClock
  /** Refresh requests answered so far. */
  refreshes(): number
}

/**
 * A fake API whose refresh endpoint rotates: the n-th refresh returns `access_n` (and, for a
 * client that sent a refresh token, `rt_n`).
 */
function world(): World {
  const api = fakeApi()
  let count = 0
  api.on(REFRESH, (request) => {
    count += 1
    const presented = (request.body as { refreshToken?: string }).refreshToken
    return json(
      200,
      sessionTokens(`access_${count}`, presented ? { refreshToken: `rt_${count}` } : {})
    )
  })
  api.on(ME, () => json(200, TEST_USER))
  api.on(SIGN_OUT, () => new Response(null, { status: 204 }))
  return { api, clock: manualClock(), refreshes: () => api.calls(REFRESH).length }
}

function tab(
  { api, clock }: World,
  kind: ClientKind,
  parts: { locks?: LockManagerLike; hub?: FakeChannelHub; storage?: TokenStorage } = {},
  options: Partial<TulaClientOptions> = {}
): Tab {
  const states: AuthState[] = []
  const storage = parts.storage ?? memoryStorage()
  const tula = createClient(
    {
      publishableKey: TEST_KEY,
      baseUrl: TEST_BASE_URL,
      client: kind,
      fetch: api.fetch,
      onSessionChange: (state) => states.push(state),
      ...(kind === 'web' ? {} : { storage }),
      ...options,
    },
    fakeEnvironment(clock, parts)
  )
  return { tula, states, storage }
}

/** A `server` client that has restored a session from a stored refresh token. */
async function signedIn(
  w: World,
  parts: { storage?: TokenStorage; timeoutMs?: number } = {}
): Promise<Tab> {
  const storage = parts.storage ?? memoryStorage()
  await storage.set(STORAGE_KEY, 'rt_0')
  const t = tab(w, 'server', { storage }, parts.timeoutMs ? { timeoutMs: parts.timeoutMs } : {})
  await t.tula.load()
  return t
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

const bearer = (w: World, route: string) =>
  w.api.calls(route).map((request) => request.headers.get('authorization'))

describe('getToken and the expiry skew', () => {
  test('a signed-out client answers null without a request', async () => {
    const w = world()
    const { tula, states } = tab(w, 'server')
    expect(tula.state).toEqual({ status: 'loading' })
    expect(await tula.session.getToken()).toBeNull()
    expect(tula.state).toEqual({ status: 'signed-out' })
    expect(await tula.session.getToken()).toBeNull()
    expect(w.api.requests).toHaveLength(0)
    expect(states).toEqual([{ status: 'signed-out' }])
  })

  test('a fresh token is returned without a request', async () => {
    const w = world()
    const { tula } = await signedIn(w)
    expect(await tula.session.getToken()).toBe(accessToken('access_1'))
    expect(await tula.session.getToken()).toBe(accessToken('access_1'))
    expect(w.refreshes()).toBe(1)
  })

  test('a 60-second token is used until 10 seconds before it expires, then refreshed', async () => {
    const w = world()
    const { tula } = await signedIn(w)
    w.clock.advance(60_000 - ACCESS_TOKEN_EXPIRY_SKEW_MS - 1)
    expect(await tula.session.getToken()).toBe(accessToken('access_1'))
    expect(w.refreshes()).toBe(1)
    w.clock.advance(1)
    expect(await tula.session.getToken()).toBe(accessToken('access_2'))
    expect(w.refreshes()).toBe(2)
  })

  test('for a short-lived token the skew is half its lifetime', async () => {
    const w = world()
    w.api.on(REFRESH, () =>
      json(200, {
        ...sessionTokens('short'),
        accessToken: accessToken('short', 8),
        refreshToken: 'rt',
      })
    )
    const { tula } = await signedIn(w)
    w.clock.advance(3_999)
    await tula.session.getToken()
    expect(w.refreshes()).toBe(1)
    w.clock.advance(1)
    await tula.session.getToken()
    expect(w.refreshes()).toBe(2)
  })

  test('the lifetime comes from the token, not from comparing the server date with this clock', async () => {
    const w = world()
    // The fake tokens' `accessTokenExpiresAt` (2030) is years away from the manual clock (2001):
    // a client that compared the two would treat the token as valid for decades.
    const { tula } = await signedIn(w)
    w.clock.advance(55_000)
    await tula.session.getToken()
    expect(w.refreshes()).toBe(2)
  })

  test('a token that is not a readable JWT falls back to the expiry sent with it', async () => {
    const w = world()
    const expiresAt = new Date(w.clock.now() + 30_000).toISOString()
    w.api.on(REFRESH, () =>
      json(200, {
        sessionId: 'session_1',
        accessToken: 'opaque',
        accessTokenExpiresAt: expiresAt,
        refreshToken: 'rt',
      })
    )
    const { tula } = await signedIn(w)
    w.clock.advance(19_999)
    expect(await tula.session.getToken()).toBe('opaque')
    expect(w.refreshes()).toBe(1)
    w.clock.advance(1)
    await tula.session.getToken()
    expect(w.refreshes()).toBe(2)
  })

  test.each([
    ['no JWT and a past expiry', '2000-01-01T00:00:00.000Z', 'opaque'],
    ['a payload without iat and exp', '2000-01-01T00:00:00.000Z', `x.${btoa('{"sub":"u"}')}.y`],
    ['a payload that is not an object', '2000-01-01T00:00:00.000Z', `x.${btoa('7')}.y`],
  ] as [string, string, string][])(
    'a token with %s is never trusted to be fresh',
    async (_name, accessTokenExpiresAt, token) => {
      const w = world()
      w.api.on(REFRESH, () =>
        json(200, {
          sessionId: 'session_1',
          accessToken: token,
          accessTokenExpiresAt,
          refreshToken: 'rt',
        })
      )
      const { tula } = await signedIn(w)
      expect(await tula.session.getToken()).toBe(token)
      expect(w.refreshes()).toBe(2)
    }
  )
})

describe('single-flight refresh', () => {
  test('25 concurrent getToken calls share one request and one result', async () => {
    const w = world()
    const { tula, states } = await signedIn(w)
    w.clock.advance(60_000)
    const tokens = await Promise.all(Array.from({ length: 25 }, () => tula.session.getToken()))
    expect(new Set(tokens)).toEqual(new Set([accessToken('access_2')]))
    expect(w.refreshes()).toBe(2)
    // A refresh is not a change of state: listeners heard of the sign-in only.
    expect(states).toHaveLength(1)
  })

  test('getToken and an explicit refresh share the same request', async () => {
    const w = world()
    const { tula } = await signedIn(w)
    w.clock.advance(60_000)
    const [fromGet, fromRefresh] = await Promise.all([
      tula.session.getToken(),
      tula.session.refresh(),
    ])
    expect(fromGet).toBe(fromRefresh)
    expect(w.refreshes()).toBe(2)
  })

  test('an explicit refresh always asks, even with a fresh token', async () => {
    const w = world()
    const { tula } = await signedIn(w)
    expect(await tula.session.refresh()).toBe(accessToken('access_2'))
    expect(w.refreshes()).toBe(2)
  })

  test('a failed refresh rejects every waiter with the same error, once, and keeps the session', async () => {
    const w = world()
    const { tula, states } = await signedIn(w)
    w.clock.advance(61_000)
    w.api.on(REFRESH, () => failure(500, 'internal'))
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => tula.session.getToken())
    )
    const reasons = results.map((result) => (result.status === 'rejected' ? result.reason : null))
    expect(new Set(reasons).size).toBe(1)
    expect(reasons[0]).toMatchObject({ code: 'internal', status: 500 })
    expect(w.refreshes()).toBe(2)
    expect(tula.state.status).toBe('signed-in')
    expect(states).toHaveLength(1)
    // Nothing is retried on its own: the next call is the next attempt.
    await caught(tula.session.getToken())
    expect(w.refreshes()).toBe(3)
  })

  test.each([
    'session.expired',
    'session.revoked',
    'session.invalid_token',
    'session.reuse_detected',
    'auth.unauthenticated',
  ])('a refresh refused with %s ends the session once, for every waiter', async (code) => {
    const w = world()
    const { tula, states, storage } = await signedIn(w)
    w.clock.advance(60_000)
    w.api.on(REFRESH, () => failure(401, code))
    const tokens = await Promise.all(Array.from({ length: 10 }, () => tula.session.getToken()))
    expect(tokens).toEqual(Array.from({ length: 10 }, () => null))
    expect(w.refreshes()).toBe(2)
    expect(states.slice(1)).toEqual([{ status: 'signed-out' }])
    expect(await storage.get(STORAGE_KEY)).toBeNull()
    // No retry loop: signed out is final until someone signs in.
    expect(await tula.session.getToken()).toBeNull()
    expect(await tula.session.refresh()).toBeNull()
    expect(w.refreshes()).toBe(2)
  })

  test('a banned user (403) is signed out by the refresh', async () => {
    const w = world()
    const { tula } = await signedIn(w)
    w.api.on(REFRESH, () => failure(403, 'auth.user_banned'))
    expect(await tula.session.refresh()).toBeNull()
    expect(tula.state).toEqual({ status: 'signed-out' })
  })

  test('a wrong publishable key (401) is a configuration error, not the end of the session', async () => {
    const w = world()
    const { tula } = await signedIn(w)
    w.api.on(REFRESH, () => failure(401, 'auth.invalid_key'))
    expect(await caught(tula.session.refresh())).toMatchObject({ code: 'auth.invalid_key' })
    expect(tula.state.status).toBe('signed-in')
  })

  test.each([
    [429, 'rate_limited'],
    [503, 'service.unavailable'],
  ] as [number, string][])(
    'a %i with Retry-After is a typed error, and nothing is asked again until then',
    async (status, code) => {
      const w = world()
      const { tula } = await signedIn(w)
      w.clock.advance(61_000)
      w.api.on(REFRESH, () => failure(status, code, {}, { 'retry-after': '7' }))
      const first = await caught(tula.session.getToken())
      expect(first).toMatchObject({ code, status, retryAfterMs: 7_000 })
      w.clock.advance(6_999)
      expect(await caught(tula.session.getToken())).toBe(first)
      expect(await caught(tula.session.getToken())).toBe(first)
      expect(w.refreshes()).toBe(2)
      w.clock.advance(1)
      await caught(tula.session.getToken())
      expect(w.refreshes()).toBe(3)
    }
  )

  test('the wait is forgotten once a refresh succeeds or the user signs out', async () => {
    const w = world()
    const { tula } = await signedIn(w)
    w.api.on(REFRESH, () => failure(429, 'rate_limited', {}, { 'retry-after': '60' }))
    await caught(tula.session.refresh())
    await tula.session.signOut()
    expect(await tula.session.refresh()).toBeNull()
  })

  test('if the refresh cannot be made, a token inside its skew is still handed out', async () => {
    const w = world()
    const { tula } = await signedIn(w)
    w.clock.advance(55_000)
    w.api.on(REFRESH, () => Promise.reject(new TypeError('offline')))
    expect(await tula.session.getToken()).toBe(accessToken('access_1'))
    w.clock.advance(5_000)
    expect(await caught(tula.session.getToken())).toMatchObject({
      code: 'network.failed',
      status: 0,
    })
    expect(tula.state.status).toBe('signed-in')
  })
})

describe('refresh tokens in storage (non-web clients)', () => {
  test('each refresh presents the stored token and stores the next one', async () => {
    const w = world()
    const { tula, storage } = await signedIn(w)
    expect(await storage.get(STORAGE_KEY)).toBe('rt_1')
    await tula.session.refresh()
    expect(w.api.calls(REFRESH).map((request) => request.body)).toEqual([
      { refreshToken: 'rt_0' },
      { refreshToken: 'rt_1' },
    ])
    expect(await storage.get(STORAGE_KEY)).toBe('rt_2')
  })

  test('a store that cannot be read is a storage error, and the state stays loading', async () => {
    const w = world()
    const storage = memoryStorage()
    const get = spyOn(storage, 'get').mockRejectedValueOnce(new Error('keychain locked'))
    const { tula } = tab(w, 'ios', { storage })
    expect(await caught(tula.load())).toMatchObject({ code: 'storage.failed', status: 0 })
    expect(tula.state).toEqual({ status: 'loading' })
    expect(w.api.requests).toHaveLength(0)
    get.mockRestore()
    expect((await tula.load()).status).toBe('signed-out')
  })

  test('a store that cannot be written reports it once and keeps the session in memory', async () => {
    const w = world()
    const storage = memoryStorage()
    await storage.set(STORAGE_KEY, 'rt_0')
    const set = spyOn(storage, 'set').mockRejectedValueOnce(new Error('disk full'))
    const { tula } = tab(w, 'android', { storage })
    const error = await caught(tula.load())
    expect(error).toMatchObject({ code: 'storage.failed' })
    expect((error.cause as Error).message).toBe('disk full')
    expect(tula.state).toMatchObject({ status: 'signed-in', user: TEST_USER })
    expect(await tula.session.getToken()).toBe(accessToken('access_1'))
    // The rotated token is still presented next time, from memory.
    await tula.session.refresh()
    expect(w.api.calls(REFRESH)[1]?.body).toEqual({ refreshToken: 'rt_1' })
    set.mockRestore()
  })

  test('a web client never touches storage and sends its cookie instead of a token', async () => {
    const w = world()
    const { tula } = tab(w, 'web')
    expect((await tula.load()).status).toBe('signed-in')
    expect(w.api.calls(REFRESH)[0]?.body).toEqual({})
  })

  test('a web client ignores a refresh token a misconfigured server puts in the body', async () => {
    const w = world()
    w.api.on(REFRESH, () => json(200, sessionTokens('a', { refreshToken: 'leaked' })))
    const { tula } = tab(w, 'web')
    await tula.load()
    await tula.session.signOut()
    expect(w.api.calls(SIGN_OUT)[0]?.body).toEqual({})
  })
})

describe('sign-out', () => {
  test('clears memory and storage, notifies once, and revokes the newest refresh token', async () => {
    const w = world()
    const { tula, states, storage } = await signedIn(w)
    await tula.session.signOut()
    expect(tula.state).toEqual({ status: 'signed-out' })
    expect(states.slice(1)).toEqual([{ status: 'signed-out' }])
    expect(await storage.get(STORAGE_KEY)).toBeNull()
    expect(w.api.calls(SIGN_OUT).map((request) => request.body)).toEqual([{ refreshToken: 'rt_1' }])
    expect(await tula.session.getToken()).toBeNull()
  })

  test('still signs out locally when the server cannot be reached, and says so', async () => {
    const w = world()
    const { tula, storage } = await signedIn(w)
    w.api.on(SIGN_OUT, () => Promise.reject(new TypeError('offline')))
    expect(await caught(tula.session.signOut())).toMatchObject({ code: 'network.failed' })
    expect(tula.state).toEqual({ status: 'signed-out' })
    expect(await storage.get(STORAGE_KEY)).toBeNull()
  })

  test('a store that cannot be cleared is reported, after the server was told', async () => {
    const w = world()
    const { tula, storage } = await signedIn(w)
    const remove = spyOn(storage, 'remove').mockRejectedValueOnce(new Error('locked'))
    expect(await caught(tula.session.signOut())).toMatchObject({ code: 'storage.failed' })
    expect(tula.state).toEqual({ status: 'signed-out' })
    expect(w.api.calls(SIGN_OUT)).toHaveLength(1)
    remove.mockRestore()
  })

  test('before the store was ever read, sign-out reads it to revoke the stored session', async () => {
    const w = world()
    const storage = memoryStorage()
    await storage.set(STORAGE_KEY, 'rt_stored')
    const { tula } = tab(w, 'server', { storage })
    await tula.session.signOut()
    expect(w.api.calls(SIGN_OUT)[0]?.body).toEqual({ refreshToken: 'rt_stored' })
    expect(await storage.get(STORAGE_KEY)).toBeNull()
    expect(w.refreshes()).toBe(0)
  })

  test('with nothing stored there is nothing to revoke and no request', async () => {
    const w = world()
    const { tula } = tab(w, 'server')
    await tula.session.signOut()
    expect(w.api.requests).toHaveLength(0)
    expect(tula.state).toEqual({ status: 'signed-out' })
  })

  test('a refresh that finishes after sign-out is discarded, and its token is the one revoked', async () => {
    const w = world()
    const { tula, states, storage } = await signedIn(w)
    const held = deferred<Response>()
    w.api.on(REFRESH, () => held.promise)
    const refreshing = tula.session.refresh()
    await Promise.resolve()
    const signingOut = tula.session.signOut()
    // Signed out at once, before any network answer.
    expect(tula.state).toEqual({ status: 'signed-out' })
    held.resolve(json(200, sessionTokens('late', { refreshToken: 'rt_late' })))
    expect(await refreshing).toBeNull()
    await signingOut
    expect(tula.state).toEqual({ status: 'signed-out' })
    expect(states.slice(1)).toEqual([{ status: 'signed-out' }])
    expect(await tula.session.getToken()).toBeNull()
    expect(await storage.get(STORAGE_KEY)).toBeNull()
    // The rotated token would otherwise have outlived the sign-out.
    expect(w.api.calls(SIGN_OUT).map((request) => request.body)).toEqual([
      { refreshToken: 'rt_late' },
    ])
  })

  test('a refresh that fails after sign-out changes nothing; the known token is revoked', async () => {
    const w = world()
    const { tula, states } = await signedIn(w)
    const held = deferred<Response>()
    w.api.on(REFRESH, () => held.promise)
    const refreshing = tula.session.refresh()
    await Promise.resolve()
    const signingOut = tula.session.signOut()
    held.resolve(failure(401, 'session.revoked'))
    expect(await refreshing).toBeNull()
    await signingOut
    expect(states.slice(1)).toEqual([{ status: 'signed-out' }])
    expect(w.api.calls(SIGN_OUT)[0]?.body).toEqual({ refreshToken: 'rt_1' })
  })

  test('a sign-in that completes while the store is being read keeps its stored token', async () => {
    const w = world()
    const storage = memoryStorage()
    await storage.set(STORAGE_KEY, 'rt_old')
    const reading = deferred<string | null>()
    const get = spyOn(storage, 'get').mockReturnValueOnce(reading.promise)
    const transport = createTransport({
      baseUrl: TEST_BASE_URL,
      publishableKey: TEST_KEY,
      client: 'server',
      fetch: w.api.fetch,
      timeoutMs: 1_000,
      messages: () => ({}),
    })
    const session = createSessionManager({
      client: 'server',
      transport,
      storage,
      environment: fakeEnvironment(w.clock),
      lockWaitMs: 1_000,
      refreshTimeoutMs: 1_000,
      scope: `${TEST_BASE_URL}|${TEST_KEY}`,
      messages: () => ({}),
    })
    const signingOut = session.signOut()
    await session.adopt(sessionTokens('new', { refreshToken: 'rt_new' }))
    reading.resolve('rt_old')
    await signingOut
    expect(await storage.get(STORAGE_KEY)).toBe('rt_new')
    expect(session.state().status).toBe('signed-in')
    expect(w.api.calls(SIGN_OUT)[0]?.body).toEqual({ refreshToken: 'rt_old' })
    get.mockRestore()
  })
})

describe('a call the API refuses with 401', () => {
  test('triggers one refresh and one retry with the new token', async () => {
    const w = world()
    const { tula } = await signedIn(w)
    let calls = 0
    w.api.on(SESSIONS, () => {
      calls += 1
      return calls === 1 ? failure(401, 'session.expired') : json(200, { data: [] })
    })
    expect(await tula.session.list()).toEqual([])
    expect(w.refreshes()).toBe(2)
    expect(bearer(w, SESSIONS)).toEqual([
      `Bearer ${accessToken('access_1')}`,
      `Bearer ${accessToken('access_2')}`,
    ])
  })

  test('a second 401 goes to the caller: no further refresh, no loop', async () => {
    const w = world()
    const { tula } = await signedIn(w)
    w.api.on(SESSIONS, () => failure(401, 'session.invalid_token'))
    expect(await caught(tula.session.list())).toMatchObject({
      code: 'session.invalid_token',
      status: 401,
    })
    expect(w.api.calls(SESSIONS)).toHaveLength(2)
    expect(w.refreshes()).toBe(2)
    expect(tula.state.status).toBe('signed-in')
  })

  test('when the refresh says the session is over, the caller gets the 401 and the state is signed-out', async () => {
    const w = world()
    const { tula, states } = await signedIn(w)
    w.api.on(SESSIONS, () => failure(401, 'session.revoked'))
    w.api.on(REFRESH, () => failure(401, 'session.revoked'))
    expect(await caught(tula.session.list())).toMatchObject({ code: 'session.revoked' })
    expect(w.api.calls(SESSIONS)).toHaveLength(1)
    expect(states.slice(1)).toEqual([{ status: 'signed-out' }])
  })

  test('a 401 that is not about the token (a wrong current password) triggers no refresh', async () => {
    const w = world()
    const { tula } = await signedIn(w)
    w.api.on('POST /v1/client/me/password', () => failure(401, 'auth.invalid_credentials'))
    const error = await caught(
      tula.user.changePassword({ currentPassword: 'wrong', newPassword: 'new password 1' })
    )
    expect(error.code).toBe('auth.invalid_credentials')
    expect(w.refreshes()).toBe(1)
    expect(tula.state.status).toBe('signed-in')
  })

  test('nobody signed in: the call fails locally, without a request', async () => {
    const w = world()
    const { tula } = tab(w, 'server')
    expect(await caught(tula.session.list())).toMatchObject({
      code: 'auth.unauthenticated',
      status: 401,
      message: 'You need to sign in to do that.',
    })
    expect(w.api.requests).toHaveLength(0)
  })

  test('if the token was replaced while the call was in flight, the retry uses it without another refresh', async () => {
    const w = world()
    const { tula } = await signedIn(w)
    const held = deferred<Response>()
    let calls = 0
    w.api.on(SESSIONS, () => {
      calls += 1
      return calls === 1 ? held.promise : json(200, { data: [] })
    })
    const listing = tula.session.list()
    await Promise.resolve()
    await tula.session.refresh()
    held.resolve(failure(401, 'session.expired'))
    await listing
    expect(w.refreshes()).toBe(2)
    expect(bearer(w, SESSIONS)[1]).toBe(`Bearer ${accessToken('access_2')}`)
  })

  test('a refresh that cannot be made surfaces its own error', async () => {
    const w = world()
    const { tula } = await signedIn(w)
    w.api.on(SESSIONS, () => failure(401, 'session.expired'))
    w.api.on(REFRESH, () => failure(503, 'service.unavailable'))
    expect(await caught(tula.session.list())).toMatchObject({ code: 'service.unavailable' })
  })
})

describe('browser tabs', () => {
  function browser(mode: 'immediate' | 'manual' = 'immediate') {
    const w = world()
    const locks = fakeLocks()
    const hub = fakeChannelHub(mode)
    return { w, locks, hub }
  }

  /** Counts how many refresh requests were in flight at once. */
  function trackConcurrency(w: World): { max(): number } {
    let active = 0
    let max = 0
    let count = 0
    w.api.on(REFRESH, async () => {
      active += 1
      max = Math.max(max, active)
      count += 1
      const label = `access_${count}`
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return json(200, sessionTokens(label))
    })
    return { max: () => max }
  }

  test('with locks and a channel, two tabs that need a token make one refresh between them', async () => {
    const { w, locks, hub } = browser()
    const a = tab(w, 'web', { locks, hub })
    const b = tab(w, 'web', { locks, hub })
    const [fromA, fromB] = await Promise.all([a.tula.session.getToken(), b.tula.session.getToken()])
    expect(w.refreshes()).toBe(1)
    expect(fromA).toBe(accessToken('access_1'))
    expect(fromB).toBe(accessToken('access_1'))
    expect(a.tula.state).toMatchObject({ status: 'signed-in', user: TEST_USER })
    expect(b.tula.state).toMatchObject({ status: 'signed-in', user: TEST_USER })
    expect(locks.requested).toEqual([
      `tula:${TEST_BASE_URL}|${TEST_KEY}`,
      `tula:${TEST_BASE_URL}|${TEST_KEY}`,
    ])
    // What tabs share is the access token and its expiry: never a refresh token.
    expect(JSON.stringify(hub.posted)).not.toContain('refreshToken')
  })

  test('with locks but no channel, the tabs refresh one after the other, never at once', async () => {
    const { w, locks } = browser()
    const concurrency = trackConcurrency(w)
    const a = tab(w, 'web', { locks })
    const b = tab(w, 'web', { locks })
    const tokens = await Promise.all([a.tula.session.getToken(), b.tula.session.getToken()])
    expect(w.refreshes()).toBe(2)
    expect(concurrency.max()).toBe(1)
    expect(tokens).toEqual([accessToken('access_1'), accessToken('access_2')])
  })

  test('with neither, both tabs refresh at once and each gets a working token (the server grace period covers the race)', async () => {
    const { w } = browser()
    const concurrency = trackConcurrency(w)
    const a = tab(w, 'web')
    const b = tab(w, 'web')
    const tokens = await Promise.all([a.tula.session.getToken(), b.tula.session.getToken()])
    expect(concurrency.max()).toBe(2)
    expect(tokens.every((token) => token?.startsWith('ey'))).toBe(true)
    expect(a.tula.state.status).toBe('signed-in')
    expect(b.tula.state.status).toBe('signed-in')
  })

  test('a tab that gets the lock before the other tab’s message arrives refreshes for itself', async () => {
    const { w, locks, hub } = browser('manual')
    const a = tab(w, 'web', { locks, hub })
    const b = tab(w, 'web', { locks, hub })
    const tokens = await Promise.all([a.tula.session.getToken(), b.tula.session.getToken()])
    expect(w.refreshes()).toBe(2)
    expect(tokens).toEqual([accessToken('access_1'), accessToken('access_2')])
    // The messages arrive late: each tab ends up on the newest token it has heard of.
    hub.flush()
    expect(await a.tula.session.getToken()).toBe(accessToken('access_2'))
  })

  test('signing out in one tab signs the other out at once, with one notification and no request', async () => {
    const { w, locks, hub } = browser()
    const a = tab(w, 'web', { locks, hub })
    const b = tab(w, 'web', { locks, hub })
    await a.tula.load()
    await b.tula.load()
    const before = w.api.requests.length
    await a.tula.session.signOut()
    expect(b.tula.state).toEqual({ status: 'signed-out' })
    expect(b.states.filter((state) => state.status === 'signed-out')).toHaveLength(1)
    expect(await b.tula.session.getToken()).toBeNull()
    expect(w.api.requests.slice(before).map((request) => request.path)).toEqual([
      '/v1/client/sessions/sign-out',
    ])
    expect(w.api.calls(SIGN_OUT)[0]?.body).toEqual({})
  })

  test('a sign-in in one tab signs the other in, and it fetches the user itself', async () => {
    const { w, locks, hub } = browser()
    w.api.on(REFRESH, () => failure(401, 'auth.unauthenticated'))
    const a = tab(w, 'web', { locks, hub })
    const b = tab(w, 'web', { locks, hub })
    await a.tula.load()
    await b.tula.load()
    expect(b.tula.state).toEqual({ status: 'signed-out' })

    w.api.on('POST /v1/client/sign-ins', () =>
      json(200, {
        id: 'attempt_1',
        kind: 'sign_in',
        expiresAt: '2030-01-01T00:10:00.000Z',
        step: { status: 'complete', userId: 'user_1', sessionId: 'session_9' },
        attemptSecret: 'tula_at_secret',
        session: sessionTokens('signed_in', { sessionId: 'session_9' }),
      })
    )
    await a.tula.signIn.start({ identifier: 'maya@northline.app' })
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(b.tula.state).toEqual({ status: 'signed-in', sessionId: 'session_9', user: TEST_USER })
    expect(await b.tula.session.getToken()).toBe(accessToken('signed_in'))
    expect(w.refreshes()).toBe(2)
  })

  test('a tab that is still loading takes a session another tab announces', async () => {
    const { w, locks, hub } = browser()
    const a = tab(w, 'web', { locks, hub })
    const b = tab(w, 'web', { locks, hub })
    // B has opened its channel (it asked for its config) but has not loaded its session.
    w.api.on(SIGN_OUT, () => new Response(null, { status: 204 }))
    await b.tula.session.signOut()
    await a.tula.load()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(b.tula.state.status).toBe('signed-in')
  })

  test('a refresh refused in one tab is not announced: it must not sign out a tab that is signing in', async () => {
    const { w, locks, hub } = browser()
    const a = tab(w, 'web', { locks, hub })
    const b = tab(w, 'web', { locks, hub })
    await a.tula.load()
    w.api.on(REFRESH, () => failure(401, 'auth.unauthenticated'))
    expect(await b.tula.session.refresh()).toBeNull()
    expect(b.tula.state).toEqual({ status: 'signed-out' })
    expect(a.tula.state.status).toBe('signed-in')
  })

  test('messages that are malformed or of another version are ignored', async () => {
    const { w, locks, hub } = browser()
    const a = tab(w, 'web', { locks, hub })
    await a.tula.load()
    const outsider = hub.createChannel(`tula:${TEST_BASE_URL}|${TEST_KEY}`)
    for (const message of [
      null,
      'signed-out',
      { type: 'signed-out' },
      { v: 2, type: 'signed-out' },
      { v: 1, type: 'session', accessToken: 7 },
      { v: 1, type: 'session', accessToken: 'x', sessionId: 's', expiresAt: 'soon', refreshAt: 1 },
      { v: 1, type: 'unknown' },
    ]) {
      outsider.postMessage(message)
    }
    expect(a.tula.state.status).toBe('signed-in')
    expect(await a.tula.session.getToken()).toBe(accessToken('access_1'))
    // A second sign-out message changes nothing.
    outsider.postMessage({ v: 1, type: 'signed-out' })
    outsider.postMessage({ v: 1, type: 'signed-out' })
    expect(a.states.filter((state) => state.status === 'signed-out')).toHaveLength(1)
  })

  test('a channel on another scope (another environment on the same origin) is not heard', async () => {
    const { w, locks, hub } = browser()
    const a = tab(w, 'web', { locks, hub })
    const other = tab(w, 'web', { locks, hub }, { publishableKey: 'tula_pk_dev_other' })
    await a.tula.load()
    await other.tula.session.signOut()
    expect(a.tula.state.status).toBe('signed-in')
  })

  test('a refresh that fails while holding the lock fails once: it is not run again without the lock', async () => {
    const { w, locks, hub } = browser()
    const a = tab(w, 'web', { locks, hub })
    await a.tula.load()
    w.api.on(REFRESH, () => failure(500, 'internal'))
    expect(await caught(a.tula.session.refresh())).toMatchObject({ code: 'internal' })
    expect(w.refreshes()).toBe(2)
  })

  test('a lock manager that refuses outright does not stop the refresh', async () => {
    const { w, hub } = browser()
    const locks: LockManagerLike = {
      request: () => Promise.reject(new DOMException('insecure context', 'SecurityError')),
    }
    const a = tab(w, 'web', { locks, hub })
    expect((await a.tula.load()).status).toBe('signed-in')
    expect(w.refreshes()).toBe(1)
  })

  test('a channel that cannot be opened, or that throws on post, does not stop anything', async () => {
    const w = world()
    const { tula } = createTab(w, () => {
      throw new DOMException('sandboxed', 'SecurityError')
    })
    expect((await tula.load()).status).toBe('signed-in')

    const closed = createTab(w, () => ({
      onmessage: null,
      postMessage() {
        throw new DOMException('channel is closed', 'InvalidStateError')
      },
    }))
    expect((await closed.tula.load()).status).toBe('signed-in')
    await closed.tula.session.signOut()
    expect(closed.tula.state).toEqual({ status: 'signed-out' })
  })

  function createTab(
    w: World,
    createChannel: NonNullable<ReturnType<typeof fakeEnvironment>['createChannel']>
  ) {
    const tula = createClient(
      { publishableKey: TEST_KEY, baseUrl: TEST_BASE_URL, client: 'web', fetch: w.api.fetch },
      { ...fakeEnvironment(w.clock), createChannel }
    )
    return { tula }
  }

  test('a tab that cannot get the lock in time goes on without it', async () => {
    const w = world()
    const stuck = deferred<void>()
    const locks = fakeLocks()
    // Another tab holds the lock and never lets go.
    void locks.request(`tula:${TEST_BASE_URL}|${TEST_KEY}`, {}, () => stuck.promise)
    const session = createSessionManager({
      client: 'web',
      transport: createTransport({
        baseUrl: TEST_BASE_URL,
        publishableKey: TEST_KEY,
        client: 'web',
        fetch: w.api.fetch,
        timeoutMs: 1_000,
        messages: () => ({}),
      }),
      storage: memoryStorage(),
      environment: fakeEnvironment(w.clock, { locks }),
      lockWaitMs: 20,
      refreshTimeoutMs: 1_000,
      scope: `${TEST_BASE_URL}|${TEST_KEY}`,
      messages: () => ({}),
    })
    expect(await session.getToken()).toBe(accessToken('access_1'))
    expect(locks.waiting()).toBe(0)
    stuck.resolve()
  })

  test('non-web clients never take the lock or open a channel, even where both exist', async () => {
    const { w, locks, hub } = browser()
    const storage = memoryStorage()
    await storage.set(STORAGE_KEY, 'rt_0')
    const { tula } = tab(w, 'ios', { locks, hub, storage })
    await tula.load()
    await tula.session.signOut()
    expect(locks.requested).toEqual([])
    expect(hub.posted).toEqual([])
  })
})

describe('state and listeners', () => {
  afterEach(() => {
    spyOn(globalThis, 'reportError').mockRestore()
  })

  test('load restores the session and the user; the state object is stable between changes', async () => {
    const w = world()
    const { tula, states } = tab(w, 'web')
    const loaded = await tula.load()
    expect(loaded).toEqual({ status: 'signed-in', sessionId: 'session_1', user: TEST_USER })
    expect(tula.state).toBe(loaded)
    expect(Object.isFrozen(loaded)).toBe(true)
    await tula.session.refresh()
    expect(tula.state).toBe(loaded)
    expect(states).toEqual([loaded])
    // Loading again asks nothing.
    const requests = w.api.requests.length
    expect(await tula.load()).toBe(loaded)
    expect(w.api.requests).toHaveLength(requests)
  })

  test('concurrent loads share one refresh', async () => {
    const w = world()
    const { tula } = tab(w, 'web')
    await Promise.all([tula.load(), tula.load(), tula.session.getToken()])
    expect(w.refreshes()).toBe(1)
    expect(w.api.calls(ME)).toHaveLength(1)
  })

  test('a load that cannot reach the API rejects and stays loading; the next one works', async () => {
    const w = world()
    const { tula, states } = tab(w, 'web')
    w.api.on(REFRESH, () => Promise.reject(new TypeError('offline')))
    expect(await caught(tula.load())).toMatchObject({ code: 'network.failed' })
    expect(tula.state).toEqual({ status: 'loading' })
    expect(states).toEqual([])
    w.api.on(REFRESH, () => json(200, sessionTokens('later')))
    expect((await tula.load()).status).toBe('signed-in')
  })

  test('an unsubscribed listener hears nothing more', async () => {
    const w = world()
    const { tula } = tab(w, 'web')
    const heard: AuthState[] = []
    const unsubscribe = tula.onChange((state) => heard.push(state))
    await tula.load()
    unsubscribe()
    await tula.session.signOut()
    expect(heard.map((state) => state.status)).toEqual(['signed-in'])
  })

  test('a listener that throws is reported and does not break the client or other listeners', async () => {
    const w = world()
    const report = spyOn(globalThis, 'reportError').mockImplementation(() => undefined)
    const { tula, states } = tab(w, 'web')
    const bug = new Error('listener bug')
    tula.onChange(() => {
      throw bug
    })
    const heard: string[] = []
    tula.onChange((state) => heard.push(state.status))
    expect((await tula.load()).status).toBe('signed-in')
    expect(heard).toEqual(['signed-in'])
    expect(states).toHaveLength(1)
    expect(report).toHaveBeenCalledWith(bug)
  })

  test('if the user cannot be fetched the session still stands; user.get() fills it in later', async () => {
    const w = world()
    const { tula, states } = tab(w, 'web')
    w.api.on(ME, () => failure(500, 'internal'))
    expect(await tula.load()).toEqual({ status: 'signed-in', sessionId: 'session_1', user: null })
    w.api.on(ME, () => json(200, TEST_USER))
    expect(await tula.user.get()).toEqual(TEST_USER)
    expect(tula.state).toEqual({ status: 'signed-in', sessionId: 'session_1', user: TEST_USER })
    expect(states).toHaveLength(2)
  })

  test('a refresh retries a user that could not be fetched before', async () => {
    const w = world()
    const { tula } = tab(w, 'web')
    w.api.on(ME, () => failure(500, 'internal'))
    await tula.load()
    w.api.on(ME, () => json(200, TEST_USER))
    await tula.session.refresh()
    expect(tula.state).toMatchObject({ user: TEST_USER })
  })

  test('user.get() while signed out fails without touching the state', async () => {
    const w = world()
    const { tula, states } = tab(w, 'server')
    await caught(tula.user.get())
    expect(states).toEqual([{ status: 'signed-out' }])
  })

  test('when a refresh comes back for another session, the user is fetched again', async () => {
    const w = world()
    const { tula, states } = tab(w, 'web')
    await tula.load()
    const other = { ...TEST_USER, id: 'user_2', email: 'omar@northline.app' }
    // Another tab signed in as someone else: the shared cookie now belongs to that session.
    w.api.on(REFRESH, () => json(200, sessionTokens('other', { sessionId: 'session_2' })))
    w.api.on(ME, () => json(200, other))
    await tula.session.refresh()
    expect(tula.state).toEqual({ status: 'signed-in', sessionId: 'session_2', user: other })
    expect(states).toHaveLength(2)
  })

  test('revoking the current session signs this client out; revoking another does not', async () => {
    const w = world()
    const { tula, storage } = await signedIn(w)
    w.api.on('DELETE /v1/client/sessions/session_7', () => new Response(null, { status: 204 }))
    w.api.on('DELETE /v1/client/sessions/session_1', () => new Response(null, { status: 204 }))
    await tula.session.revoke('session_7')
    expect(tula.state.status).toBe('signed-in')
    await tula.session.revoke('session_1')
    expect(tula.state).toEqual({ status: 'signed-out' })
    expect(await storage.get(STORAGE_KEY)).toBeNull()
  })

  test('a sign-in that completes while a refresh is in flight wins: the late refresh is discarded', async () => {
    const w = world()
    const storage = memoryStorage()
    await storage.set(STORAGE_KEY, 'rt_0')
    const session = createSessionManager({
      client: 'server',
      transport: createTransport({
        baseUrl: TEST_BASE_URL,
        publishableKey: TEST_KEY,
        client: 'server',
        fetch: w.api.fetch,
        timeoutMs: 1_000,
        messages: () => ({}),
      }),
      storage,
      environment: fakeEnvironment(w.clock),
      lockWaitMs: 1_000,
      refreshTimeoutMs: 1_000,
      scope: `${TEST_BASE_URL}|${TEST_KEY}`,
      messages: () => ({}),
    })
    const held = deferred<Response>()
    w.api.on(REFRESH, () => held.promise)
    const refreshing = session.refresh()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await session.adopt(sessionTokens('new', { sessionId: 'session_2', refreshToken: 'rt_new' }))
    held.resolve(json(200, sessionTokens('stale', { refreshToken: 'rt_stale' })))
    // The waiter gets whatever is current, which is the new sign-in's token.
    expect(await refreshing).toBe(accessToken('new'))
    expect(session.state()).toMatchObject({ status: 'signed-in', sessionId: 'session_2' })
    expect(await storage.get(STORAGE_KEY)).toBe('rt_new')
    await session.idle()
  })

  test('a session that changes while the store is being read is what the refresh answers with', async () => {
    const w = world()
    const storage = memoryStorage()
    const reading = deferred<string | null>()
    const get = spyOn(storage, 'get').mockReturnValueOnce(reading.promise)
    const session = createSessionManager({
      client: 'server',
      transport: createTransport({
        baseUrl: TEST_BASE_URL,
        publishableKey: TEST_KEY,
        client: 'server',
        fetch: w.api.fetch,
        timeoutMs: 1_000,
        messages: () => ({}),
      }),
      storage,
      environment: fakeEnvironment(w.clock),
      lockWaitMs: 1_000,
      refreshTimeoutMs: 1_000,
      scope: `${TEST_BASE_URL}|${TEST_KEY}`,
      messages: () => ({}),
    })
    const refreshing = session.refresh()
    await session.adopt(sessionTokens('new', { refreshToken: 'rt_new' }))
    reading.resolve('rt_old')
    expect(await refreshing).toBe(accessToken('new'))
    expect(w.refreshes()).toBe(0)
    // The newer token was not overwritten by the late read.
    await session.refresh()
    expect(w.api.calls(REFRESH)[0]?.body).toEqual({ refreshToken: 'rt_new' })
    get.mockRestore()
  })
})

describe('changes of session while something is in flight', () => {
  test('signing out while the user is being fetched leaves the client signed out', async () => {
    const w = world()
    const { tula, states } = tab(w, 'web')
    const held = deferred<Response>()
    w.api.on(ME, () => held.promise)
    const loading = tula.load()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const signingOut = tula.session.signOut()
    held.resolve(json(200, TEST_USER))
    await Promise.all([loading, signingOut])
    expect(tula.state).toEqual({ status: 'signed-out' })
    expect(states).toEqual([{ status: 'signed-out' }])
  })

  test('signing out while a rotated token is being stored leaves nothing in the store', async () => {
    const w = world()
    const { tula, storage, states } = await signedIn(w)
    const writing = deferred<void>()
    const set = spyOn(storage, 'set').mockImplementationOnce(async () => {
      await writing.promise
    })
    const refreshing = tula.session.refresh()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const signingOut = tula.session.signOut()
    writing.resolve()
    await Promise.all([refreshing, signingOut])
    set.mockRestore()
    expect(await storage.get(STORAGE_KEY)).toBeNull()
    expect(states.slice(1)).toEqual([{ status: 'signed-out' }])
    // The token the refresh had just received is the one that was revoked.
    expect(w.api.calls(SIGN_OUT)[0]?.body).toEqual({ refreshToken: 'rt_2' })
  })
})

describe('a signed-out client stays signed out (review F1)', () => {
  test('a 401 that arrives after sign-out does not refresh: the caller gets the 401 and the client stays signed out', async () => {
    const w = world()
    const { tula, states } = tab(w, 'web')
    await tula.load()
    const held = deferred<Response>()
    w.api.on(SESSIONS, () => held.promise)
    const listing = tula.session.list()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await tula.session.signOut()
    const refreshesAtSignOut = w.refreshes()
    held.resolve(failure(401, 'session.revoked'))
    expect(await caught(listing)).toMatchObject({ code: 'session.revoked', status: 401 })
    expect(tula.state).toEqual({ status: 'signed-out' })
    expect(w.refreshes()).toBe(refreshesAtSignOut)
    expect(states.map((state) => state.status)).toEqual(['signed-in', 'signed-out'])
  })

  test('a session message another tab posted before this tab signed that session out cannot sign it back in', async () => {
    const w = world()
    const locks = fakeLocks()
    const hub = fakeChannelHub('manual')
    const a = tab(w, 'web', { locks, hub })
    const b = tab(w, 'web', { locks, hub })
    await a.tula.load()
    await b.tula.load()
    hub.flush()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(b.tula.state.status).toBe('signed-in')

    // B refreshes session_1 and posts the result; before it is delivered, A signs out.
    await b.tula.session.refresh()
    await a.tula.session.signOut()
    hub.flush()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(a.tula.state).toEqual({ status: 'signed-out' })
    expect(b.tula.state).toEqual({ status: 'signed-out' })
    expect(a.states.map((state) => state.status)).toEqual(['signed-in', 'signed-out'])
    expect(await a.tula.session.getToken()).toBeNull()

    // A genuinely new sign-in elsewhere (another session id) still reaches this tab.
    const outsider = hub.createChannel(`tula:${TEST_BASE_URL}|${TEST_KEY}`)
    outsider.postMessage({
      v: 1,
      type: 'session',
      accessToken: accessToken('fresh'),
      sessionId: 'session_2',
      expiresAt: w.clock.now() + 60_000,
      refreshAt: w.clock.now() + 50_000,
    })
    hub.flush()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(a.tula.state).toMatchObject({ status: 'signed-in', sessionId: 'session_2' })
  })

  test('while a sign-out is still being sent, no session message is taken, whatever its session', async () => {
    const w = world()
    const hub = fakeChannelHub()
    const a = tab(w, 'web', { hub })
    const held = deferred<Response>()
    w.api.on(SIGN_OUT, () => held.promise)
    // A never loaded, so it does not know which session its cookie belongs to.
    const signingOut = a.tula.session.signOut()
    const outsider = hub.createChannel(`tula:${TEST_BASE_URL}|${TEST_KEY}`)
    outsider.postMessage({
      v: 1,
      type: 'session',
      accessToken: accessToken('stale'),
      sessionId: 'session_1',
      expiresAt: w.clock.now() + 60_000,
      refreshAt: w.clock.now() + 50_000,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(a.tula.state).toEqual({ status: 'signed-out' })
    held.resolve(new Response(null, { status: 204 }))
    await signingOut
    expect(a.tula.state).toEqual({ status: 'signed-out' })
  })

  test('a refresh in flight in a tab that is told of a sign-out is discarded when it lands', async () => {
    const w = world()
    const hub = fakeChannelHub()
    const a = tab(w, 'web', { hub })
    const b = tab(w, 'web', { hub })
    await a.tula.load()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const held = deferred<Response>()
    w.api.on(REFRESH, () => held.promise)
    const refreshing = b.tula.session.refresh()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await a.tula.session.signOut()
    expect(b.tula.state).toEqual({ status: 'signed-out' })
    const posted = hub.posted.length
    held.resolve(json(200, sessionTokens('late')))
    expect(await refreshing).toBeNull()
    expect(b.tula.state).toEqual({ status: 'signed-out' })
    expect(a.tula.state).toEqual({ status: 'signed-out' })
    // The discarded result was not announced either.
    expect(hub.posted).toHaveLength(posted)
  })

  test('a signed-out session can still be restored by this tab’s own refresh (the sign-out never reached the server)', async () => {
    const w = world()
    const hub = fakeChannelHub()
    const a = tab(w, 'web', { hub })
    await a.tula.load()
    w.api.on(SIGN_OUT, () => Promise.reject(new TypeError('offline')))
    await caught(a.tula.session.signOut())
    expect(await a.tula.session.refresh()).toBe(accessToken('access_2'))
    expect(a.tula.state.status).toBe('signed-in')
  })
})

describe('the refresh request has its own, shorter timeout (review F2)', () => {
  test('a refresh is given REFRESH_TIMEOUT_MS, below the server’s 10-second reuse grace period, not the 15-second default', async () => {
    const w = world()
    const { tula } = tab(w, 'web')
    const timers = spyOn(globalThis, 'setTimeout')
    await tula.session.refresh()
    const refreshTimers = timers.mock.calls.map((call) => call[1]).slice(0, 1)
    timers.mockRestore()
    expect(REFRESH_TIMEOUT_MS).toBe(8_000)
    // Below the smallest grace window a profile may set (other than none at all), so that no
    // configurable profile turns one slow refresh and its retry into `session.reuse_detected`.
    expect(REFRESH_TIMEOUT_MS).toBeLessThan(durationToMs(MIN_REUSE_GRACE_PERIOD))
    expect(DEFAULT_WEB_SESSION_PROFILE.refresh.reuseGracePeriod).toBe(MIN_REUSE_GRACE_PERIOD)
    expect(refreshTimers).toEqual([REFRESH_TIMEOUT_MS])
  })

  test('an app that sets a smaller timeoutMs gets that for refreshes too; other calls keep timeoutMs', async () => {
    const w = world()
    const { tula } = tab(w, 'web', {}, { timeoutMs: 3_000 })
    const timers = spyOn(globalThis, 'setTimeout')
    await tula.session.refresh()
    const seen = timers.mock.calls.map((call) => call[1])
    timers.mockRestore()
    expect(seen[0]).toBe(3_000)

    const slow = tab(w, 'web', {}, { timeoutMs: 20_000 })
    const again = spyOn(globalThis, 'setTimeout')
    await slow.tula.session.refresh()
    const all = again.mock.calls.map((call) => call[1])
    again.mockRestore()
    // The refresh, then the user fetch that follows it.
    expect(all).toEqual([REFRESH_TIMEOUT_MS, 20_000])
  })
})

describe('successful answers are checked before they are installed (review F4)', () => {
  test.each([
    ['an empty object', {}],
    [
      'no session id',
      { accessToken: accessToken('x'), accessTokenExpiresAt: '2030-01-01T00:00:00.000Z' },
    ],
    ['an access token that is not a string', { ...sessionTokens('x'), accessToken: 7 }],
    ['an empty access token', { ...sessionTokens('x'), accessToken: '' }],
    [
      'no readable expiry',
      { sessionId: 's', accessToken: 'opaque', accessTokenExpiresAt: 'not a date' },
    ],
    ['a refresh token that is not a string', { ...sessionTokens('x'), refreshToken: 7 }],
  ] as [string, unknown][])(
    'a 200 refresh answer with %s is response.invalid and changes nothing',
    async (_name, body) => {
      const w = world()
      const hub = fakeChannelHub()
      const { tula, states, storage } = await signedIn(w)
      const other = tab(w, 'web', { hub })
      await other.tula.load()
      const posted = hub.posted.length
      const before = tula.state
      w.api.on(REFRESH, () => json(200, body))
      expect(await caught(tula.session.refresh())).toMatchObject({ code: 'response.invalid' })
      expect(await caught(other.tula.session.refresh())).toMatchObject({ code: 'response.invalid' })
      expect(tula.state).toBe(before)
      expect(states).toHaveLength(1)
      expect(await storage.get(STORAGE_KEY)).toBe('rt_1')
      expect(hub.posted).toHaveLength(posted)
      expect(await tula.session.getToken()).toBe(accessToken('access_1'))
    }
  )

  test('a first load answered with a page that is not the API stays loading', async () => {
    const w = world()
    const { tula } = tab(w, 'web')
    w.api.on(REFRESH, () => json(200, { html: '<p>welcome</p>' }))
    expect(await caught(tula.load())).toMatchObject({ code: 'response.invalid' })
    expect(tula.state).toEqual({ status: 'loading' })
  })
})

describe('Retry-After is capped, and an explicit refresh asks anyway (review F5)', () => {
  test('a day-long Retry-After stops getToken for five minutes, not a day', async () => {
    const w = world()
    const { tula } = await signedIn(w)
    w.clock.advance(61_000)
    w.api.on(REFRESH, () => failure(503, 'service.unavailable', {}, { 'retry-after': '86400' }))
    const first = await caught(tula.session.getToken())
    expect(first.retryAfterMs).toBe(86_400_000)
    w.clock.advance(MAX_REFRESH_BACKOFF_MS - 1)
    expect(await caught(tula.session.getToken())).toBe(first)
    expect(w.refreshes()).toBe(2)
    w.clock.advance(1)
    await caught(tula.session.getToken())
    expect(w.refreshes()).toBe(3)
    expect(MAX_REFRESH_BACKOFF_MS).toBe(300_000)
  })

  test('an explicit refresh() ignores the stored wait and surfaces the fresh answer', async () => {
    const w = world()
    const { tula } = await signedIn(w)
    w.clock.advance(61_000)
    w.api.on(REFRESH, () => failure(429, 'rate_limited', {}, { 'retry-after': '120' }))
    const first = await caught(tula.session.getToken())
    const second = await caught(tula.session.refresh())
    expect(second).not.toBe(first)
    expect(second).toMatchObject({ code: 'rate_limited', retryAfterMs: 120_000 })
    expect(w.refreshes()).toBe(3)
    // getToken still fails fast.
    await caught(tula.session.getToken())
    expect(w.refreshes()).toBe(3)
    w.api.on(REFRESH, () => json(200, sessionTokens('back', { refreshToken: 'rt_back' })))
    expect(await tula.session.refresh()).toBe(accessToken('back'))
    expect(await tula.session.getToken()).toBe(accessToken('back'))
  })
})

describe('a refresh that gets no answer is tried once more, at once (the one automatic retry)', () => {
  /** A fetch answer that only ends when the request is aborted by its timeout. */
  const untilAborted = (raw: Request) =>
    new Promise<Response>((_resolve, reject) => {
      raw.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })

  test('the first try times out, the second succeeds: two requests, every waiter gets the token, the state never changes', async () => {
    const w = world()
    const { tula, states } = await signedIn(w, { timeoutMs: 20 })
    w.clock.advance(61_000)
    let tries = 0
    w.api.on(REFRESH, (_request, raw) => {
      tries += 1
      return tries === 1
        ? untilAborted(raw)
        : json(200, sessionTokens('second_try', { refreshToken: 'rt_next' }))
    })
    const tokens = await Promise.all(Array.from({ length: 10 }, () => tula.session.getToken()))
    expect(new Set(tokens)).toEqual(new Set([accessToken('second_try')]))
    expect(tries).toBe(2)
    // The retry presents the same token: that is what the server's grace period forgives.
    expect(
      w.api
        .calls(REFRESH)
        .slice(-2)
        .map((request) => request.body)
    ).toEqual([{ refreshToken: 'rt_1' }, { refreshToken: 'rt_1' }])
    expect(tula.state.status).toBe('signed-in')
    expect(states).toHaveLength(1)
  })

  test('a fetch that fails outright is retried the same way', async () => {
    const w = world()
    const { tula } = await signedIn(w)
    let tries = 0
    w.api.on(REFRESH, () => {
      tries += 1
      return tries === 1
        ? Promise.reject(new TypeError('connection reset'))
        : json(200, sessionTokens('second_try', { refreshToken: 'rt_next' }))
    })
    expect(await tula.session.refresh()).toBe(accessToken('second_try'))
    expect(tries).toBe(2)
  })

  test('both tries time out: one error for every waiter, the session is kept, and there is no third request', async () => {
    const w = world()
    const { tula, states, storage } = await signedIn(w, { timeoutMs: 20 })
    w.clock.advance(61_000)
    let tries = 0
    w.api.on(REFRESH, (_request, raw) => {
      tries += 1
      return untilAborted(raw)
    })
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => tula.session.getToken())
    )
    const reasons = results.map((result) => (result.status === 'rejected' ? result.reason : null))
    expect(new Set(reasons).size).toBe(1)
    expect(reasons[0]).toMatchObject({ code: 'network.timeout', status: 0 })
    expect(tries).toBe(2)
    expect(tula.state.status).toBe('signed-in')
    expect(states).toHaveLength(1)
    expect(await storage.get(STORAGE_KEY)).toBe('rt_1')
  })

  test.each([
    [503, 'service.unavailable'],
    [429, 'rate_limited'],
    [500, 'internal'],
    [401, 'session.expired'],
    [403, 'auth.user_banned'],
  ] as [number, string][])('an HTTP %i answer is never retried', async (status, code) => {
    const w = world()
    const { tula } = await signedIn(w)
    let tries = 0
    w.api.on(REFRESH, () => {
      tries += 1
      return failure(status, code)
    })
    await tula.session.refresh().catch(() => null)
    expect(tries).toBe(1)
  })

  test('an unreadable 200 is not retried either', async () => {
    const w = world()
    const { tula } = await signedIn(w)
    let tries = 0
    w.api.on(REFRESH, () => {
      tries += 1
      return new Response('<html>', { status: 200 })
    })
    expect(await caught(tula.session.refresh())).toMatchObject({ code: 'response.invalid' })
    expect(tries).toBe(1)
  })

  test.each([
    ['at once', 0, REFRESH_TIMEOUT_MS],
    ['after 8 seconds', 8_000, 2_000],
    ['after the whole window', 9_900, 1_000],
    ['later still', 30_000, 1_000],
  ] as [string, number, number][])(
    'a first try that failed %s leaves the retry what remains of the 10-second window',
    async (_name, elapsed, expected) => {
      const w = world()
      const { tula } = await signedIn(w)
      w.api.on(REFRESH, () => {
        w.clock.advance(elapsed)
        return Promise.reject(new TypeError('offline'))
      })
      const timers = spyOn(globalThis, 'setTimeout')
      await caught(tula.session.refresh())
      const seen = timers.mock.calls.map((call) => call[1])
      timers.mockRestore()
      expect(seen).toEqual([REFRESH_TIMEOUT_MS, expected])
      expect(REFRESH_RETRY_WINDOW_MS).toBe(durationToMs(MIN_REUSE_GRACE_PERIOD))
    }
  )

  test('a sign-out while the first try is failing stops the retry', async () => {
    const w = world()
    const { tula } = await signedIn(w)
    const held = deferred<Response>()
    let tries = 0
    w.api.on(REFRESH, () => {
      tries += 1
      return held.promise
    })
    const refreshing = tula.session.refresh()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const signingOut = tula.session.signOut()
    held.reject(new TypeError('offline'))
    expect(await refreshing).toBeNull()
    await signingOut
    expect(tries).toBe(1)
    expect(tula.state).toEqual({ status: 'signed-out' })
  })
})

describe('the cross-tab lock outlasts a refresh that is tried twice (F7)', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  test('with timeoutMs 5000, a tab waiting for the lock sends nothing while the holder retries', async () => {
    jest.useFakeTimers()
    const w = world()
    const locks = fakeLocks()
    let active = 0
    let max = 0
    let tries = 0
    w.api.on(REFRESH, (_request, raw) => {
      tries += 1
      if (tries > 2) {
        return json(200, sessionTokens(`access_${tries}`))
      }
      // The holder's two tries get no answer: each ends only when its timeout aborts it.
      active += 1
      max = Math.max(max, active)
      return new Promise<Response>((_resolve, reject) => {
        raw.signal.addEventListener('abort', () => {
          active -= 1
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    })
    /** Move the timers and the client's clock together, letting promise chains run. */
    const pass = async (ms: number) => {
      for (let done = 0; done < ms; done += 500) {
        jest.advanceTimersByTime(500)
        w.clock.advance(500)
        for (let turn = 0; turn < 50; turn++) {
          await Promise.resolve()
        }
      }
    }
    // No channel: the waiting tab has to refresh for itself once it gets the lock.
    const a = tab(w, 'web', { locks }, { timeoutMs: 5_000 })
    const b = tab(w, 'web', { locks }, { timeoutMs: 5_000 })
    const fromA = caught(a.tula.session.getToken())
    await pass(0)
    const fromB = b.tula.session.getToken()

    // The holder: 5 s for the first try, then a retry with the 5 s left of the window.
    await pass(9_500)
    expect(tries).toBe(2)
    expect(max).toBe(1)

    await pass(1_000)
    expect(await fromA).toMatchObject({ code: 'network.timeout' })
    expect(await fromB).toBe(accessToken('access_3'))
    // The waiting tab's request went out only after the holder's had ended.
    expect(max).toBe(1)
    expect(tries).toBe(3)
  })

  test.each([
    [8_000, 10_000],
    [5_000, 10_000],
    [3_000, 6_000],
    [500, 1_000],
  ] as [number, number][])(
    'a refresh with a %i ms timeout can hold the lock for %i ms',
    (refreshTimeoutMs, budget) => {
      expect(refreshBudgetMs(refreshTimeoutMs)).toBe(budget)
    }
  )
})

describe('step-up: a fresh access token for the same session', () => {
  const STEP_UP = 'POST /v1/client/sessions/step-up'
  const PROOF = { method: 'totp', code: '123456' } as const
  const bearer = (label: string) => `Bearer ${accessToken(label)}`
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
  /** The refresh tokens the refresh requests presented, in order. */
  const presented = (w: World) =>
    w.api.calls(REFRESH).map((request) => (request.body as { refreshToken?: string }).refreshToken)

  /** Holds the answer of the step-up request until the test releases it. */
  function heldStepUp(w: World) {
    const held = deferred<Response>()
    w.api.on(STEP_UP, () => held.promise)
    return held
  }

  test('installs the access token it is answered with: no refresh, no change of state, the refresh token untouched', async () => {
    const w = world()
    const { tula, states, storage } = await signedIn(w)
    // A refresh token in the answer (the API sends none) must not replace the real one.
    w.api.on(STEP_UP, () => json(200, sessionTokens('proven', { refreshToken: 'rt_evil' })))
    const set = spyOn(storage, 'set')
    expect(await tula.session.stepUp(PROOF)).toBeUndefined()
    expect(w.api.calls(STEP_UP)[0]?.body).toEqual(PROOF)
    expect(w.api.calls(STEP_UP)[0]?.headers.get('authorization')).toBe(bearer('access_1'))
    expect(await tula.session.getToken()).toBe(accessToken('proven'))
    expect(w.refreshes()).toBe(1)
    expect(states).toHaveLength(1)
    expect(tula.state).toEqual({ status: 'signed-in', sessionId: 'session_1', user: TEST_USER })
    expect(set).not.toHaveBeenCalled()
    expect(await storage.get(STORAGE_KEY)).toBe('rt_1')
    // The next refresh presents the token the session had before the step-up.
    await tula.session.refresh()
    expect(presented(w)).toEqual(['rt_0', 'rt_1'])
  })

  test('the installed token has its own lifetime: it is refreshed when it nears its expiry', async () => {
    const w = world()
    const { tula } = await signedIn(w)
    w.clock.advance(40_000)
    w.api.on(STEP_UP, () => json(200, sessionTokens('proven')))
    await tula.session.stepUp(PROOF)
    // The token it replaced would be past its skew by now; this one was issued at the step-up.
    w.clock.advance(45_000)
    expect(await tula.session.getToken()).toBe(accessToken('proven'))
    w.clock.advance(10_000)
    expect(await tula.session.getToken()).toBe(accessToken('access_2'))
  })

  test.each([
    ['a wrong password', 401, 'auth.invalid_credentials', { method: 'password', password: 'x' }],
    ['a wrong code', 422, 'mfa.invalid_code', PROOF],
    ['a method this user may not use', 403, 'auth.step_up_required', PROOF],
    ['too many wrong proofs', 429, 'rate_limited', PROOF],
  ] as const)(
    '%s is the server’s error: one request, nothing installed, still signed in',
    async (_name, status, code, proof) => {
      const w = world()
      const { tula, states } = await signedIn(w)
      w.api.on(STEP_UP, () => failure(status, code, { params: { methods: 'totp,backup_code' } }))
      const error = await caught(tula.session.stepUp(proof))
      expect(error).toMatchObject({ code, status })
      // Neither the password nor the code is in the error.
      expect(JSON.stringify(error) + error.stack).not.toContain('123456')
      expect(w.api.calls(STEP_UP)).toHaveLength(1)
      expect(w.refreshes()).toBe(1)
      expect(await tula.session.getToken()).toBe(accessToken('access_1'))
      expect(states).toHaveLength(1)
    }
  )

  test.each([
    ['a page that is not the API', { html: '<html>' }],
    ['no access token', { sessionId: 'session_1', accessTokenExpiresAt: '2030-01-01T00:01:00Z' }],
    ['no session id', { accessToken: accessToken('proven') }],
  ])('a 200 with %s is response.invalid and installs nothing', async (_name, body) => {
    const w = world()
    const { tula } = await signedIn(w)
    w.api.on(STEP_UP, () => json(200, body))
    expect(await caught(tula.session.stepUp(PROOF))).toMatchObject({
      code: 'response.invalid',
      status: 0,
    })
    expect(await tula.session.getToken()).toBe(accessToken('access_1'))
  })

  test('an answer for another session is never installed: a step-up cannot change whose session this is', async () => {
    const w = world()
    const { tula, states } = await signedIn(w)
    w.api.on(STEP_UP, () => json(200, sessionTokens('other', { sessionId: 'session_2' })))
    expect(await caught(tula.session.stepUp(PROOF))).toMatchObject({
      code: 'auth.unauthenticated',
    })
    expect(await tula.session.getToken()).toBe(accessToken('access_1'))
    expect(tula.state).toMatchObject({ sessionId: 'session_1' })
    expect(states).toHaveLength(1)
  })

  test('a 401 on the step-up itself gets one refresh and one retry, and the retry’s answer is installed', async () => {
    const w = world()
    const { tula, storage } = await signedIn(w)
    w.api.on(STEP_UP, (request) =>
      request.headers.get('authorization') === bearer('access_2')
        ? json(200, sessionTokens('proven'))
        : failure(401, 'session.expired')
    )
    await tula.session.stepUp(PROOF)
    expect(w.api.calls(STEP_UP)).toHaveLength(2)
    expect(w.refreshes()).toBe(2)
    expect(await tula.session.getToken()).toBe(accessToken('proven'))
    expect(await storage.get(STORAGE_KEY)).toBe('rt_2')
  })

  test('it waits for a refresh already in flight, and proves with the token that refresh brought', async () => {
    const w = world()
    const { tula } = await signedIn(w)
    const held = deferred<Response>()
    w.api.on(REFRESH, () => held.promise)
    w.api.on(STEP_UP, () => json(200, sessionTokens('proven')))
    const refreshing = tula.session.refresh()
    const proving = tula.session.stepUp(PROOF)
    await tick()
    expect(w.api.calls(STEP_UP)).toHaveLength(0)
    held.resolve(json(200, sessionTokens('access_2', { refreshToken: 'rt_2' })))
    await refreshing
    await proving
    expect(w.api.calls(STEP_UP)[0]?.headers.get('authorization')).toBe(bearer('access_2'))
    expect(await tula.session.getToken()).toBe(accessToken('proven'))
  })

  test('racing a refresh that lands first: the step-up’s token is for an older generation and is not installed; one more refresh fetches a token issued after the proof', async () => {
    const w = world()
    const { tula, states, storage } = await signedIn(w)
    const held = heldStepUp(w)
    const proving = tula.session.stepUp(PROOF)
    await tick()
    // A refresh starts and finishes while the proof is in flight.
    expect(await tula.session.refresh()).toBe(accessToken('access_2'))
    held.resolve(json(200, sessionTokens('proven')))
    await proving
    // Not the step-up's token, and not the refresh that may have been issued before the proof.
    expect(await tula.session.getToken()).toBe(accessToken('access_3'))
    expect(w.refreshes()).toBe(3)
    expect(presented(w)).toEqual(['rt_0', 'rt_1', 'rt_2'])
    expect(await storage.get(STORAGE_KEY)).toBe('rt_3')
    expect(states).toHaveLength(1)
  })

  test('racing a refresh that is still in flight when the proof is accepted: the refresh keeps its rotated token, and one more refresh follows', async () => {
    const w = world()
    const { tula, storage } = await signedIn(w)
    const proof = heldStepUp(w)
    const proving = tula.session.stepUp(PROOF)
    await tick()
    const refresh = deferred<Response>()
    w.api.on(REFRESH, () => refresh.promise)
    const refreshing = tula.session.refresh()
    await tick()
    proof.resolve(json(200, sessionTokens('proven')))
    await tick()
    // The step-up has its answer but must not install it over a refresh that is rotating the
    // refresh token: that refresh would then discard the token it is about to receive, and
    // the next one would present a spent token (reuse: the whole session revoked).
    w.api.on(REFRESH, (request) => {
      const sent = (request.body as { refreshToken?: string }).refreshToken
      return json(200, sessionTokens('after_proof', { refreshToken: `after_${sent}` }))
    })
    refresh.resolve(json(200, sessionTokens('access_2', { refreshToken: 'rt_2' })))
    expect(await refreshing).toBe(accessToken('access_2'))
    await proving
    expect(presented(w)).toEqual(['rt_0', 'rt_1', 'rt_2'])
    expect(await storage.get(STORAGE_KEY)).toBe('after_rt_2')
    expect(await tula.session.getToken()).toBe(accessToken('after_proof'))
  })

  test('if that one more refresh cannot be made, the step-up says so and the session is kept', async () => {
    const w = world()
    const { tula } = await signedIn(w)
    const held = heldStepUp(w)
    const proving = tula.session.stepUp(PROOF)
    await tick()
    await tula.session.refresh()
    w.api.on(REFRESH, () => failure(503, 'service.unavailable'))
    held.resolve(json(200, sessionTokens('proven')))
    expect(await caught(proving)).toMatchObject({ code: 'service.unavailable', status: 503 })
    expect(tula.state.status).toBe('signed-in')
    expect(await tula.session.getToken()).toBe(accessToken('access_2'))
  })

  test('racing a sign-out: the answer that arrives afterwards is discarded, nothing is refreshed, the client stays signed out', async () => {
    const w = world()
    const { tula, states } = await signedIn(w)
    const held = heldStepUp(w)
    const proving = tula.session.stepUp(PROOF)
    await tick()
    await tula.session.signOut()
    held.resolve(json(200, sessionTokens('proven')))
    expect(await caught(proving)).toMatchObject({ code: 'auth.unauthenticated' })
    expect(tula.state).toEqual({ status: 'signed-out' })
    expect(await tula.session.getToken()).toBeNull()
    expect(w.refreshes()).toBe(1)
    expect(states.map((state) => state.status)).toEqual(['signed-in', 'signed-out'])
  })

  test('racing a sign-out and a refresh at once: the wait for the refresh does not end in a refresh of its own', async () => {
    const w = world()
    const { tula } = await signedIn(w)
    const proof = heldStepUp(w)
    const proving = tula.session.stepUp(PROOF)
    await tick()
    const refresh = deferred<Response>()
    w.api.on(REFRESH, () => refresh.promise)
    const refreshing = tula.session.refresh()
    await tick()
    proof.resolve(json(200, sessionTokens('proven')))
    await tick()
    const signingOut = tula.session.signOut()
    refresh.resolve(json(200, sessionTokens('late', { refreshToken: 'rt_late' })))
    expect(await refreshing).toBeNull()
    await signingOut
    expect(await caught(proving)).toMatchObject({ code: 'auth.unauthenticated' })
    expect(tula.state).toEqual({ status: 'signed-out' })
    expect(w.refreshes()).toBe(2)
  })

  test('racing a new sign-in: the step-up of the session that was replaced is not installed over it', async () => {
    const w = world()
    const { tula } = await signedIn(w)
    const held = heldStepUp(w)
    const proving = tula.session.stepUp(PROOF)
    await tick()
    w.api.on('POST /v1/client/sign-ins', () =>
      json(200, {
        id: 'attempt_1',
        kind: 'sign_in',
        expiresAt: '2030-01-01T00:10:00.000Z',
        step: { status: 'needs_password' },
        attemptSecret: 'tula_at_secret',
      })
    )
    w.api.on('POST /v1/client/sign-ins/attempt_1/password', () =>
      json(200, {
        id: 'attempt_1',
        kind: 'sign_in',
        expiresAt: '2030-01-01T00:10:00.000Z',
        step: { status: 'complete', userId: 'user_2', sessionId: 'session_2' },
        session: sessionTokens('second', { sessionId: 'session_2', refreshToken: 'rt_second' }),
      })
    )
    const flow = await tula.signIn.start({ identifier: 'other@northline.app' })
    await flow.submitPassword({ password: 'pw' })
    held.resolve(json(200, sessionTokens('proven')))
    expect(await caught(proving)).toMatchObject({ code: 'auth.unauthenticated' })
    expect(tula.state).toMatchObject({ status: 'signed-in', sessionId: 'session_2' })
    expect(await tula.session.getToken()).toBe(accessToken('second'))
    expect(w.refreshes()).toBe(1)
  })

  describe('in a browser with other tabs', () => {
    async function twoTabs(mode: 'immediate' | 'manual' = 'immediate') {
      const w = world()
      const locks = fakeLocks()
      const hub = fakeChannelHub(mode)
      const a = tab(w, 'web', { locks, hub })
      const b = tab(w, 'web', { locks, hub })
      await a.tula.load()
      hub.flush()
      await b.tula.load()
      hub.flush()
      await tick()
      return { w, hub, a, b }
    }

    test('the stepped-up token is shared: the other tab uses it without a request of its own', async () => {
      const { w, a, b } = await twoTabs()
      const before = w.refreshes()
      w.api.on(STEP_UP, () => json(200, sessionTokens('proven')))
      await a.tula.session.stepUp(PROOF)
      expect(await a.tula.session.getToken()).toBe(accessToken('proven'))
      expect(await b.tula.session.getToken()).toBe(accessToken('proven'))
      expect(w.refreshes()).toBe(before)
      // The message carries the access token only: a web client has no refresh token to leak.
      expect(JSON.stringify(a.states) + JSON.stringify(b.states)).not.toContain('proven')
    })

    test('another tab’s session message arriving mid step-up: the answer is not installed over it; a refresh under the lock follows', async () => {
      const { w, a, b } = await twoTabs()
      const held = heldStepUp(w)
      const proving = a.tula.session.stepUp(PROOF)
      await tick()
      // The other tab refreshes and announces its token while this tab's proof is in flight.
      const theirs = await b.tula.session.refresh()
      expect(await a.tula.session.getToken()).toBe(theirs)
      const before = w.refreshes()
      held.resolve(json(200, sessionTokens('proven')))
      await proving
      expect(w.refreshes()).toBe(before + 1)
      const mine = await a.tula.session.getToken()
      expect(mine).toBe(accessToken(`access_${before + 1}`))
      // And that refresh's token reaches the other tab too.
      expect(await b.tula.session.getToken()).toBe(mine)
      expect(a.states.map((state) => state.status)).toEqual(['signed-in'])
    })

    test('another tab signing out mid step-up: this tab is signed out, the answer is discarded and no refresh brings the session back', async () => {
      const { w, a, b } = await twoTabs()
      const held = heldStepUp(w)
      const proving = a.tula.session.stepUp(PROOF)
      await tick()
      await b.tula.session.signOut()
      expect(a.tula.state).toEqual({ status: 'signed-out' })
      const before = w.refreshes()
      held.resolve(json(200, sessionTokens('proven')))
      expect(await caught(proving)).toMatchObject({ code: 'auth.unauthenticated' })
      expect(a.tula.state).toEqual({ status: 'signed-out' })
      expect(await a.tula.session.getToken()).toBeNull()
      expect(w.refreshes()).toBe(before)
      // The stale answer was not announced either: the other tab stays signed out.
      expect(b.tula.state).toEqual({ status: 'signed-out' })
    })

    test('a browser signed out while the step-up waits for a refresh sends no refresh of its own: its cookie must not sign it back in', async () => {
      const w = world()
      const { tula, states } = tab(w, 'web', { locks: fakeLocks(), hub: fakeChannelHub() })
      await tula.load()
      const proof = heldStepUp(w)
      const proving = tula.session.stepUp(PROOF)
      await tick()
      const refresh = deferred<Response>()
      w.api.on(REFRESH, () => refresh.promise)
      const refreshing = tula.session.refresh()
      await tick()
      proof.resolve(json(200, sessionTokens('proven')))
      await tick()
      const signingOut = tula.session.signOut()
      refresh.resolve(json(200, sessionTokens('late')))
      expect(await refreshing).toBeNull()
      await signingOut
      expect(await caught(proving)).toMatchObject({ code: 'auth.unauthenticated' })
      expect(w.refreshes()).toBe(2)
      expect(tula.state).toEqual({ status: 'signed-out' })
      expect(states.map((state) => state.status)).toEqual(['signed-in', 'signed-out'])
    })

    test('an older token announced late (a refresh from before the proof) does not replace the step-up’s token', async () => {
      const { w, hub, a, b } = await twoTabs('manual')
      w.api.on(STEP_UP, () => json(200, sessionTokens('proven')))
      const stale = await b.tula.session.refresh()
      w.clock.advance(1_000)
      await a.tula.session.stepUp(PROOF)
      expect(await a.tula.session.getToken()).toBe(accessToken('proven'))
      // The other tab's announcement of its earlier refresh arrives only now.
      hub.flush()
      await tick()
      expect(stale).not.toBe(accessToken('proven'))
      expect(await a.tula.session.getToken()).toBe(accessToken('proven'))
      // And the step-up's own announcement, newer, is taken by the other tab.
      expect(await b.tula.session.getToken()).toBe(accessToken('proven'))
      expect(a.tula.state.status).toBe('signed-in')
      expect(b.tula.state.status).toBe('signed-in')
    })
  })
})
