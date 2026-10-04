import { describe, expect, test } from 'bun:test'
import { SESSION_PROFILE_HEADER } from '@tula/contract/headers'
import { createClient, type TulaClient } from './client'
import { isTulaError, type TulaError } from './errors'
import { memoryStorage } from './storage'
import {
  type FakeApi,
  type FakeChannelHub,
  failure,
  fakeApi,
  fakeChannelHub,
  fakeEnvironment,
  json,
  type ManualClock,
  manualClock,
  sessionTokens,
  TEST_BASE_URL,
  TEST_KEY,
  TEST_USER,
} from './testing/fakes'
import type { AuthState, ClientKind } from './types'

const REFRESH = 'POST /v1/client/sessions/refresh'
const SIGN_OUT = 'POST /v1/client/sessions/sign-out'
const STEP_UP = 'POST /v1/client/sessions/step-up'
const ME = 'GET /v1/client/me'
const SESSIONS = 'GET /v1/client/sessions'
const SIGN_INS = 'POST /v1/client/sign-ins'
const SESSION_ID = 'session_1'

interface World {
  api: FakeApi
  clock: ManualClock
  /** Whether the browser's session cookie is still good, as the server sees it. */
  live: boolean
}

/**
 * A fake API on a `stateful` profile: the session lives in a cookie the client never sees, so
 * the "refresh" route only says whether it is still there, and nothing carries a token.
 */
function world(live = true): World {
  const w: World = { api: fakeApi(), clock: manualClock(), live }
  const gate = (answer: () => Response) => () =>
    w.live ? answer() : failure(401, 'session.revoked')
  w.api.on(
    REFRESH,
    gate(() => json(200, { sessionId: SESSION_ID }))
  )
  w.api.on(
    ME,
    gate(() => json(200, TEST_USER))
  )
  w.api.on(
    SESSIONS,
    gate(() => json(200, { data: [] }))
  )
  w.api.on(
    STEP_UP,
    gate(() => json(200, { sessionId: SESSION_ID }))
  )
  w.api.on(SIGN_OUT, () => {
    w.live = false
    return new Response(null, { status: 204 })
  })
  return w
}

interface Tab {
  tula: TulaClient
  states: AuthState[]
}

function tab(w: World, kind: ClientKind = 'web', hub?: FakeChannelHub, options = {}): Tab {
  const states: AuthState[] = []
  const tula = createClient(
    {
      publishableKey: TEST_KEY,
      baseUrl: TEST_BASE_URL,
      client: kind,
      fetch: w.api.fetch,
      onSessionChange: (state) => states.push(state),
      ...(kind === 'web' ? {} : { storage: memoryStorage() }),
      ...options,
    },
    fakeEnvironment(w.clock, hub ? { hub } : {})
  )
  return { tula, states }
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

describe('a browser on a stateful profile', () => {
  test('restores its session from the cookie alone: signed in, with the user, and no token', async () => {
    const w = world()
    const { tula } = tab(w)
    const state = await tula.load()
    expect(state).toEqual({ status: 'signed-in', sessionId: SESSION_ID, user: TEST_USER })
    expect(await tula.session.getToken()).toBeNull()
    // One check and one read of the user; neither carried a token.
    expect(w.api.calls(REFRESH)).toHaveLength(1)
    expect(w.api.calls(ME)[0]?.headers.get('authorization')).toBeNull()
  })

  test('getToken never asks the server: there is no token to fetch', async () => {
    const w = world()
    const { tula } = tab(w)
    await tula.load()
    w.clock.advance(3_600_000)
    for (let i = 0; i < 3; i++) {
      expect(await tula.session.getToken()).toBeNull()
    }
    expect(w.api.calls(REFRESH)).toHaveLength(1)
  })

  test('authenticated calls go out without Authorization, relying on the cookie', async () => {
    const w = world()
    const { tula } = tab(w)
    await tula.load()
    await tula.session.list()
    const [request] = w.api.calls(SESSIONS)
    expect(request?.headers.get('authorization')).toBeNull()
    expect(w.api.calls(REFRESH)).toHaveLength(1)
  })

  test('with no cookie it is signed out', async () => {
    const w = world(false)
    const { tula } = tab(w)
    expect((await tula.load()).status).toBe('signed-out')
    expect(await tula.session.getToken()).toBeNull()
  })

  test('a session ended on the server signs the client out on its very next call', async () => {
    const w = world()
    const { tula, states } = tab(w)
    await tula.load()
    w.live = false
    const error = await caught(tula.session.list())
    expect(error.code).toBe('session.revoked')
    expect(tula.state.status).toBe('signed-out')
    expect(states.at(-1)?.status).toBe('signed-out')
    // It did not try to "refresh" its way back in.
    expect(w.api.calls(REFRESH)).toHaveLength(1)
  })

  test('an error that is not about the session leaves it signed in', async () => {
    const w = world()
    const { tula } = tab(w)
    await tula.load()
    w.api.on(SESSIONS, () => failure(429, 'rate_limited'))
    expect((await caught(tula.session.list())).code).toBe('rate_limited')
    expect(tula.state.status).toBe('signed-in')
  })

  test('signing out tells the server (the cookie is its to clear) and the other tabs', async () => {
    const w = world()
    const hub = fakeChannelHub()
    const [one, two] = [tab(w, 'web', hub), tab(w, 'web', hub)]
    await one.tula.load()
    await two.tula.load()
    await one.tula.session.signOut()
    expect(w.api.calls(SIGN_OUT)).toHaveLength(1)
    expect(one.tula.state.status).toBe('signed-out')
    expect(two.tula.state.status).toBe('signed-out')
  })

  test('a sign-in in one tab signs the other tabs in, with no token crossing between them', async () => {
    const w = world(false)
    const hub = fakeChannelHub()
    const [one, two] = [tab(w, 'web', hub), tab(w, 'web', hub)]
    await one.tula.load()
    await two.tula.load()
    expect(two.tula.state.status).toBe('signed-out')

    w.api.on(SIGN_INS, () => {
      w.live = true
      return json(200, {
        id: 'attempt_1',
        kind: 'sign_in',
        expiresAt: new Date(w.clock.now() + 600_000).toISOString(),
        step: { status: 'complete', userId: TEST_USER.id, sessionId: SESSION_ID },
        session: { sessionId: SESSION_ID },
      })
    })
    await one.tula.signIn.start({ identifier: 'maya@northline.app' })
    expect(one.tula.state).toMatchObject({ status: 'signed-in', sessionId: SESSION_ID })
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(two.tula.state).toMatchObject({ status: 'signed-in', sessionId: SESSION_ID })
    expect(JSON.stringify(hub.posted)).not.toContain('tula_st_')
  })

  test('a step-up answers with no token and the session carries on', async () => {
    const w = world()
    const { tula } = tab(w)
    await tula.load()
    await tula.session.stepUp({ method: 'password', password: 'correct horse battery staple 42' })
    expect(tula.state).toMatchObject({ status: 'signed-in', sessionId: SESSION_ID })
    expect(w.api.calls(STEP_UP)[0]?.headers.get('authorization')).toBeNull()
    expect(await tula.session.getToken()).toBeNull()
  })

  test('an explicit refresh checks the session again and still returns no token', async () => {
    const w = world()
    const { tula } = tab(w)
    await tula.load()
    expect(await tula.session.refresh()).toBeNull()
    expect(tula.state.status).toBe('signed-in')
    w.live = false
    expect(await tula.session.refresh()).toBeNull()
    expect(tula.state.status).toBe('signed-out')
  })
})

describe('a token-less session is only ever a browser’s', () => {
  test('a native client refuses an answer without an access token', async () => {
    const w = world()
    const { tula } = tab(w, 'ios')
    w.api.on(SIGN_INS, () =>
      json(200, {
        id: 'attempt_1',
        kind: 'sign_in',
        expiresAt: new Date(w.clock.now() + 600_000).toISOString(),
        step: { status: 'complete', userId: TEST_USER.id, sessionId: SESSION_ID },
        session: { sessionId: SESSION_ID },
      })
    )
    const error = await caught(tula.signIn.start({ identifier: 'maya@northline.app' }))
    expect(error.code).toBe('response.invalid')
    expect(tula.state.status).not.toBe('signed-in')
  })

  test('a browser on a hybrid profile still gets and uses its access token', async () => {
    const w = world()
    w.api.on(REFRESH, () => json(200, sessionTokens('access_1')))
    const { tula } = tab(w)
    await tula.load()
    expect(await tula.session.getToken()).toBeString()
    await tula.session.list()
    expect(w.api.calls(SESSIONS)[0]?.headers.get('authorization')).toStartWith('Bearer ')
  })
})

describe('asking for a session profile', () => {
  test('sessionProfile is sent on the calls that start an attempt', async () => {
    const w = world(false)
    const { tula } = tab(w, 'web', undefined, { sessionProfile: 'admin' })
    w.api.on(SIGN_INS, () =>
      json(200, {
        id: 'attempt_1',
        kind: 'sign_in',
        expiresAt: new Date(w.clock.now() + 600_000).toISOString(),
        step: { status: 'needs_password' },
        attemptSecret: 'secret',
      })
    )
    await tula.signIn.start({ identifier: 'maya@northline.app' })
    expect(w.api.calls(SIGN_INS)[0]?.headers.get(SESSION_PROFILE_HEADER)).toBe('admin')
  })

  test('without the option no such header is sent', async () => {
    const w = world(false)
    const { tula } = tab(w)
    await tula.load()
    expect(w.api.calls(REFRESH)[0]?.headers.has(SESSION_PROFILE_HEADER)).toBe(false)
  })

  test.each(['Not A Name', '', 'x'.repeat(40)])(
    'a malformed profile name (%p) is refused when the client is created',
    (name) => {
      const w = world(false)
      expect(() => tab(w, 'web', undefined, { sessionProfile: name })).toThrow()
    }
  )
})
