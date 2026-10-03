import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { loadScenarios } from '@tula/conformance'
import {
  type AuthState,
  type ClientKind,
  createTulaClient,
  evaluatePassword,
  isTulaError,
  memoryStorage,
  type TokenStorage,
  type TulaClient,
  type TulaError,
} from '@tula/core'
import { createApp } from '~/index'
import { createTestDeps, seedApiKey, TEST_CONFIG, TEST_TENANT, type TestDeps } from '~/testing'

// The SDK, driven through its public API against the real server in process: memory adapters,
// a clock the tests advance, and `fetch` handed straight to the app. Every conformance
// scenario is either covered here by a journey or listed as server-only with the reason; the
// guard at the bottom fails when a new scenario is added without deciding which.

const PUBLISHABLE_KEY = 'tula_pk_dev_sdkjourneys000000000000000000000'
const SECRET_KEY = 'tula_sk_dev_sdkjourneys000000000000000000000'
const PASSWORD = 'sturdy-Otter-plays-42-chess'
const NEW_PASSWORD = 'quiet-Heron-wades-17-rivers'
/** An origin the `local` tier allows (any loopback origin). */
const APP_ORIGIN = 'http://localhost:5173'

/** Scenario name → the journeys that cover it through the SDK. Filled in by `journey()`. */
const covered = new Map<string, string[]>()

/**
 * Scenarios with no SDK journey, and why. A scenario belongs here only when what it shows
 * cannot be reached through a client SDK at all.
 */
const SERVER_ONLY: Record<string, string> = {
  'two instances':
    'a property of the deployment (two API processes sharing Postgres and Redis). A client talks ' +
    'to one base URL and cannot tell instances apart; `multi-instance.test.ts` and the self-host ' +
    'CI job cover it.',
}

/** Register a test as the SDK's coverage of one or more conformance scenarios. */
function journey(scenarios: string | string[], title: string, run: () => Promise<void>): void {
  for (const scenario of [scenarios].flat()) {
    covered.set(scenario, [...(covered.get(scenario) ?? []), title])
  }
  test(title, run)
}

interface Recorded {
  method: string
  path: string
  headers: Headers
  requestBody: string
  status: number
  responseBody: string
  setCookie: string | null
}

interface Server {
  deps: TestDeps
  /** Every exchange any client of this server made, in order. */
  exchanges: Recorded[]
  /** A new client. A `web` client gets a browser-like cookie jar and an `Origin` header. */
  client(
    kind: ClientKind,
    options?: {
      storage?: TokenStorage
      origin?: string
      tamper?: (request: Request) => Request
      /** Share another client's cookie jar: two tabs of one browser. */
      cookies?: Map<string, string>
      /**
       * Lose the response of a request the server has already handled: the client sees a
       * network failure and the browser never applies the response's `Set-Cookie`.
       */
      loseResponse?: (request: Request) => boolean
    }
  ): { tula: TulaClient; states: AuthState[]; cookies: Map<string, string> }
  code(email: string): string
  /** Move the server's clock and this process's clock together. */
  advance(ms: number): void
  admin(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>
  ): Promise<Response>
}

afterEach(() => {
  // `advance` moves this process's clock; every test starts from the real time again.
  setSystemTime()
})

async function server(): Promise<Server> {
  const deps = createTestDeps()
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  await seedApiKey(deps, PUBLISHABLE_KEY)
  await seedApiKey(deps, SECRET_KEY)
  const app = createApp(deps)
  const exchanges: Recorded[] = []

  return {
    deps,
    exchanges,
    client(kind, options = {}) {
      const cookies = options.cookies ?? new Map<string, string>()
      const states: AuthState[] = []
      const fetch = async (original: Request): Promise<Response> => {
        const request = options.tamper ? options.tamper(original) : original
        const headers = new Headers(request.headers)
        if (kind === 'web') {
          // What a browser adds on its own: the page's origin, and the cookies whose path
          // matches. The SDK cannot see or set either.
          headers.set('origin', options.origin ?? APP_ORIGIN)
          const path = new URL(request.url).pathname
          const matching = [...cookies].filter(() => path.startsWith('/v1/client/sessions'))
          if (matching.length > 0) {
            headers.set('cookie', matching.map(([name, value]) => `${name}=${value}`).join('; '))
          }
        }
        const requestBody = await request.clone().text()
        const response = await app.request(new Request(request, { headers }))
        if (options.loseResponse?.(request)) {
          exchanges.push({
            method: request.method,
            path: new URL(request.url).pathname,
            headers,
            requestBody,
            status: response.status,
            responseBody: await response.clone().text(),
            setCookie: null,
          })
          throw new TypeError('the response was lost on the way back')
        }
        const setCookie = response.headers.get('set-cookie')
        if (kind === 'web' && setCookie) {
          const [pair = ''] = setCookie.split(';')
          const [name = '', value = ''] = pair.split('=')
          if (value === '' || /max-age=0/i.test(setCookie)) {
            cookies.delete(name)
          } else {
            cookies.set(name, value)
          }
        }
        exchanges.push({
          method: request.method,
          path: new URL(request.url).pathname,
          headers,
          requestBody,
          status: response.status,
          responseBody: await response.clone().text(),
          setCookie,
        })
        return response
      }
      const tula = createTulaClient({
        publishableKey: PUBLISHABLE_KEY,
        baseUrl: TEST_CONFIG.publicUrl,
        client: kind,
        fetch,
        onSessionChange: (state) => states.push(state),
        ...(kind === 'web' ? {} : { storage: options.storage ?? memoryStorage() }),
      })
      return { tula, states, cookies }
    },
    code(email) {
      const message = deps.mailer.outbox.findLast((sent) => sent.to === email)
      const code = /^(\d{6})\b/.exec(message?.subject ?? '')?.[1]
      if (!code) {
        throw new Error(`no email with a code was sent to ${email}`)
      }
      return code
    },
    advance(ms) {
      deps.clock.advance(ms)
      setSystemTime(new Date(Date.now() + ms))
    },
    async admin(method, path, body, headers = {}) {
      return app.request(path, {
        method,
        headers: {
          authorization: `Bearer ${SECRET_KEY}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    },
  }
}

let addresses = 0
function freshEmail(): string {
  addresses += 1
  return `sdk-user-${addresses}@example.com`
}

/** Sign up and verify through the SDK; returns the signed-in client. */
async function signUp(s: Server, kind: ClientKind = 'server', email = freshEmail()) {
  const context = s.client(kind)
  const flow = await context.tula.signUp.start({ email, password: PASSWORD, firstName: 'Maya' })
  await flow.verifyEmail({ code: s.code(email) })
  return { ...context, email, flow }
}

async function signIn(s: Server, email: string, kind: ClientKind = 'server', password = PASSWORD) {
  const context = s.client(kind)
  const flow = await context.tula.signIn.start({ identifier: email })
  const step = await flow.submitPassword({ password })
  return { ...context, flow, step }
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
  throw new Error('expected the call to throw a TulaError')
}

const refreshes = (s: Server) =>
  s.exchanges.filter((exchange) => exchange.path === '/v1/client/sessions/refresh')

describe('SDK journeys against the API in process', () => {
  journey('sign-up', 'sign-up: start, verify the emailed code, signed in with a user', async () => {
    const s = await server()
    const { tula, states } = s.client('server')
    const email = freshEmail()
    expect(tula.state).toEqual({ status: 'loading' })

    const flow = await tula.signUp.start({ email, password: PASSWORD, firstName: 'Maya' })
    expect(flow.kind).toBe('sign_up')
    expect(flow.step).toMatchObject({
      status: 'needs_email_verification',
      strategies: ['email_code'],
    })
    expect(tula.state.status).toBe('loading')

    const step = await flow.verifyEmail({ code: s.code(email) })
    expect(step.status).toBe('complete')
    expect(tula.state).toMatchObject({
      status: 'signed-in',
      user: { email, firstName: 'Maya', bannedAt: null },
    })
    expect(states).toHaveLength(1)
    expect((await tula.user.get()).emailVerifiedAt).not.toBeNull()
    expect((await tula.session.getToken())?.split('.')).toHaveLength(3)
  })

  journey(
    'sign-in',
    'sign-in: password completes it; a wrong password is the generic error',
    async () => {
      const s = await server()
      const { email } = await signUp(s)

      const wrong = s.client('server')
      const failing = await wrong.tula.signIn.start({ identifier: email })
      expect(failing.step).toEqual({ status: 'needs_password' })
      const error = await caught(failing.submitPassword({ password: 'not-the-password-123' }))
      expect(error).toMatchObject({
        code: 'auth.invalid_credentials',
        status: 401,
        message: 'The email or password is incorrect.',
      })
      expect(wrong.tula.state.status).toBe('loading')
      // The same attempt can still be completed with the right password.
      expect((await failing.submitPassword({ password: PASSWORD })).status).toBe('complete')
      expect(wrong.tula.state.status).toBe('signed-in')

      // An address with no account gets the same first step and the same error.
      const unknown = s.client('server')
      const ghost = await unknown.tula.signIn.start({ identifier: 'nobody@example.com' })
      expect(ghost.step).toEqual({ status: 'needs_password' })
      expect((await caught(ghost.submitPassword({ password: PASSWORD }))).code).toBe(
        'auth.invalid_credentials'
      )
    }
  )

  journey(
    'refresh rotation and reuse detection',
    'refresh: rotates the stored token; a replay inside the grace period is forgiven, after it the session ends',
    async () => {
      const s = await server()
      const storage = memoryStorage()
      const key = `tula.refresh.${TEST_CONFIG.publicUrl}|${PUBLISHABLE_KEY}`
      const context = s.client('server', { storage })
      const email = freshEmail()
      const flow = await context.tula.signUp.start({ email, password: PASSWORD })
      await flow.verifyEmail({ code: s.code(email) })
      const first = await storage.get(key)
      expect(first).toMatch(/^tula_rt_/)
      const firstAccess = await context.tula.session.getToken()

      // Rotation: a new access token and a new refresh token, stored in place of the old one.
      s.advance(1_000)
      const secondAccess = await context.tula.session.refresh()
      const second = await storage.get(key)
      expect(second).toMatch(/^tula_rt_/)
      expect(second).not.toBe(first)
      expect(secondAccess).not.toBe(firstAccess)

      // A second device restored from a copy of the old token, inside the grace period: it is
      // given the same next token, not a new one, and nobody is signed out.
      const copy = memoryStorage()
      await copy.set(key, first as string)
      const racer = s.client('server', { storage: copy })
      expect((await racer.tula.load()).status).toBe('signed-in')
      expect(await copy.get(key)).toBe(second)
      expect(context.tula.state.status).toBe('signed-in')

      // The same replay after the grace period is reuse: the whole session ends.
      s.advance(11_000)
      const thief = memoryStorage()
      await thief.set(key, first as string)
      const late = s.client('server', { storage: thief })
      expect((await late.tula.load()).status).toBe('signed-out')
      expect(await thief.get(key)).toBeNull()
      expect(refreshes(s).at(-1)).toMatchObject({ status: 401 })
      expect(refreshes(s).at(-1)?.responseBody).toContain('session.reuse_detected')

      // The legitimate client finds out at its next refresh: signed out once, no retry loop.
      const before = refreshes(s).length
      expect(await context.tula.session.refresh()).toBeNull()
      expect(context.tula.state).toEqual({ status: 'signed-out' })
      expect(context.states.filter((state) => state.status === 'signed-out')).toHaveLength(1)
      expect(await context.tula.session.getToken()).toBeNull()
      expect(refreshes(s).length).toBe(before + 1)
      expect(await storage.get(key)).toBeNull()
    }
  )

  journey('sign-out', 'sign-out: ends the session on the server and in the client', async () => {
    const s = await server()
    const storage = memoryStorage()
    const key = `tula.refresh.${TEST_CONFIG.publicUrl}|${PUBLISHABLE_KEY}`
    const context = s.client('server', { storage })
    const email = freshEmail()
    const flow = await context.tula.signUp.start({ email, password: PASSWORD })
    await flow.verifyEmail({ code: s.code(email) })
    const refreshToken = (await storage.get(key)) as string

    await context.tula.session.signOut()
    expect(context.tula.state).toEqual({ status: 'signed-out' })
    expect(await storage.get(key)).toBeNull()
    expect(s.exchanges.at(-1)).toMatchObject({ path: '/v1/client/sessions/sign-out', status: 204 })

    // The refresh token is dead on the server too.
    const replay = memoryStorage()
    await replay.set(key, refreshToken)
    expect((await s.client('server', { storage: replay }).tula.load()).status).toBe('signed-out')
    // Signing out again (nothing to revoke) is not an error.
    await context.tula.session.signOut()
  })

  journey(
    'password policy',
    'password policy: a weak password is refused with one field error per rule, matching the live checklist',
    async () => {
      const s = await server()
      const { tula } = s.client('server')
      const email = freshEmail()
      const config = await tula.config.get()

      const error = await caught(tula.signUp.start({ email, password: 'short' }))
      // The error's own code is the first rule that failed; `errors` lists every one.
      expect(error).toMatchObject({ code: 'password.too_short', status: 422 })
      expect(error.errors).toContainEqual({
        field: 'password',
        code: 'password.too_short',
        message: 'Password is too short.',
        params: { min: config.password.minLength },
      })
      // The checklist a UI draws from the same policy fails the same rules, before any request.
      const failed = evaluatePassword(config.password, 'short', { email })
        .checks.filter((check) => !check.passed)
        .map((check) => check.code)
      expect(failed as string[]).toEqual(error.errors.map((problem) => problem.code))

      const common = await caught(tula.signUp.start({ email, password: 'password123' }))
      expect(common.errors.map((problem) => problem.code)).toContain('password.common')
      expect(evaluatePassword(config.password, 'password123').ok).toBe(false)

      const invalidEmail = await caught(
        tula.signUp.start({ email: 'not-an-email', password: PASSWORD })
      )
      expect(invalidEmail.errors).toMatchObject([{ field: 'email', code: 'email.invalid' }])
      expect(evaluatePassword(config.password, PASSWORD, { email }).ok).toBe(true)
      expect(s.deps.mailer.outbox).toHaveLength(0)
    }
  )

  journey(
    'password lockout',
    'lockout: after repeated wrong passwords every try is rate_limited with a wait, even the right one',
    async () => {
      const s = await server()
      const { email } = await signUp(s)
      const { tula } = s.client('server')
      const flow = await tula.signIn.start({ identifier: email })
      for (let attempt = 0; attempt < 6; attempt++) {
        expect(
          (await caught(flow.submitPassword({ password: `wrong-password-${attempt}` }))).code
        ).toBe('auth.invalid_credentials')
      }
      const locked = await caught(flow.submitPassword({ password: PASSWORD }))
      expect(locked).toMatchObject({ code: 'rate_limited', status: 429 })
      expect(locked.retryAfterMs).toBeGreaterThan(0)
      expect(locked.params.retryAfter).toBe((locked.retryAfterMs ?? 0) / 1000)
      expect(tula.state.status).toBe('loading')

      // Once the wait is over the right password works.
      s.advance((locked.retryAfterMs ?? 0) + 1_000)
      const again = await tula.signIn.start({ identifier: email })
      expect((await again.submitPassword({ password: PASSWORD })).status).toBe('complete')
    }
  )

  journey(
    'admin ban and audit log',
    'a user banned by an admin is signed out at the next refresh, and cannot sign in',
    async () => {
      const s = await server()
      const { tula, email, states } = await signUp(s)
      const userId = tula.state.status === 'signed-in' ? tula.state.user?.id : undefined
      expect((await s.admin('POST', `/v1/admin/users/${userId}/ban`)).status).toBe(200)

      expect(await tula.session.refresh()).toBeNull()
      expect(tula.state).toEqual({ status: 'signed-out' })
      expect(states.at(-1)).toEqual({ status: 'signed-out' })

      const { tula: again } = s.client('server')
      const flow = await again.signIn.start({ identifier: email })
      expect(await caught(flow.submitPassword({ password: PASSWORD }))).toMatchObject({
        code: 'auth.user_banned',
        status: 403,
      })
    }
  )

  journey(
    'sign-up for an existing address',
    'sign-up for an address that already has an account looks the same and creates nothing',
    async () => {
      const s = await server()
      const { email } = await signUp(s)
      // Past the one-email-a-minute limit for the address, which the first sign-up used.
      s.advance(61_000)
      const { tula } = s.client('server')
      const flow = await tula.signUp.start({ email, password: NEW_PASSWORD })
      expect(flow.step).toMatchObject({ status: 'needs_email_verification' })
      // No code was sent to the existing account's address for this attempt, so nothing the
      // newcomer can type completes it.
      expect((await caught(flow.verifyEmail({ code: '000000' }))).code).toMatch(/^verification\./)
      expect(tula.state.status).toBe('loading')
      // The original password still signs in: the account was not changed.
      expect((await signIn(s, email)).step.status).toBe('complete')
    }
  )

  journey(
    'verification code attempts',
    'verification: wrong codes are counted, a resend retires the old code, too many guesses lock the code',
    async () => {
      const s = await server()
      const { tula } = s.client('server')
      const email = freshEmail()
      const flow = await tula.signUp.start({ email, password: PASSWORD })
      const firstCode = s.code(email)
      const wrongCode = firstCode === '000000' ? '111111' : '000000'

      expect(await caught(flow.verifyEmail({ code: wrongCode }))).toMatchObject({
        code: 'verification.invalid_code',
        status: 422,
      })
      // A resend asked for too soon is a typed rate limit with the wait.
      const tooSoon = await caught(flow.resendCode())
      expect(tooSoon).toMatchObject({ code: 'rate_limited', status: 429 })
      expect(tooSoon.retryAfterMs).toBeGreaterThan(0)

      s.advance(61_000)
      expect((await flow.resendCode()).status).toBe('needs_email_verification')
      const secondCode = s.code(email)
      // The first code was retired by the resend.
      if (secondCode !== firstCode) {
        expect((await caught(flow.verifyEmail({ code: firstCode }))).code).toBe(
          'verification.invalid_code'
        )
      }
      for (let guess = 0; guess < 5; guess++) {
        await caught(flow.verifyEmail({ code: wrongCode }))
      }
      expect(await caught(flow.verifyEmail({ code: secondCode }))).toMatchObject({
        code: 'verification.too_many_attempts',
        status: 429,
      })
      expect(tula.state.status).toBe('loading')
    }
  )

  journey(
    'password reset',
    'password reset: code and new password together; other sessions end; the old password stops working',
    async () => {
      const s = await server()
      const other = await signUp(s)
      const { email } = other
      // Past the one-email-a-minute limit for the address, which the sign-up used.
      s.advance(61_000)
      const { tula } = s.client('server')

      const flow = await tula.resetPassword.start({ email })
      expect(flow.kind).toBe('password_reset')
      expect(flow.step).toMatchObject({ status: 'needs_new_password', strategies: ['email_code'] })
      const code = s.code(email)

      const weak = await caught(flow.submit({ code, password: 'short' }))
      expect(weak.code).toBe('password.too_short')
      expect(weak.errors.map((problem) => problem.code)).toContain('password.too_short')

      const step = await flow.submit({ code, password: NEW_PASSWORD })
      expect(step.status).toBe('complete')
      expect(tula.state).toMatchObject({ status: 'signed-in', user: { email } })

      // Every session from before the reset is over.
      expect(await other.tula.session.refresh()).toBeNull()
      expect(other.tula.state).toEqual({ status: 'signed-out' })

      const old = s.client('server')
      const oldFlow = await old.tula.signIn.start({ identifier: email })
      expect((await caught(oldFlow.submitPassword({ password: PASSWORD }))).code).toBe(
        'auth.invalid_credentials'
      )
      expect((await signIn(s, email, 'server', NEW_PASSWORD)).step.status).toBe('complete')

      // An address with no account gets the same first step.
      const ghost = await s
        .client('server')
        .tula.resetPassword.start({ email: 'nobody@example.com' })
      expect(ghost.step.status).toBe('needs_new_password')
    }
  )

  journey(
    'environment settings',
    'config: the client sees the app name, methods and password policy an admin sets',
    async () => {
      const s = await server()
      const { tula } = s.client('server')
      const before = await tula.config.get()
      expect(before).toMatchObject({ app: { name: 'Tula' }, signIn: { methods: ['password'] } })
      expect(before.password.minLength).toBe(10)

      const saved = await s.admin(
        'PUT',
        '/v1/admin/settings',
        {
          app: { name: 'Northline' },
          password: { ...before.password, preset: 'custom', minLength: 14 },
        },
        { 'if-match': '"0"' }
      )
      expect(saved.status).toBe(200)

      // Cached until asked again.
      expect((await tula.config.get()).app.name).toBe('Tula')
      const after = await tula.config.get({ force: true })
      expect(after.app.name).toBe('Northline')
      expect(after.password.minLength).toBe(14)

      // The server enforces what the config says, and the checklist agrees.
      const twelve = 'twelve-chars'
      expect(evaluatePassword(after.password, twelve).ok).toBe(false)
      const error = await caught(tula.signUp.start({ email: freshEmail(), password: twelve }))
      expect(error.errors).toContainEqual(
        expect.objectContaining({ code: 'password.too_short', params: { min: 14 } })
      )
    }
  )

  journey(
    'attempt binding',
    'attempt binding: the SDK sends the attempt’s secret on every step; a tampered or missing one is flow.not_found',
    async () => {
      const s = await server()
      const { email } = await signUp(s)

      const honest = s.client('server')
      const flow = await honest.tula.signIn.start({ identifier: email })
      await flow.submitPassword({ password: PASSWORD })
      expect(
        s.exchanges
          .find((exchange) => exchange.path.endsWith('/password'))
          ?.headers.get('x-tula-attempt')
      ).toMatch(/^tula_at_/)
      expect(honest.tula.state.status).toBe('signed-in')

      for (const tamper of [
        (headers: Headers) => headers.set('x-tula-attempt', 'tula_at_not-the-secret'),
        (headers: Headers) => headers.delete('x-tula-attempt'),
      ]) {
        const tampering = s.client('server', {
          tamper(request) {
            const headers = new Headers(request.headers)
            if (headers.has('x-tula-attempt')) {
              tamper(headers)
            }
            return new Request(request, { headers })
          },
        })
        const bound = await tampering.tula.signIn.start({ identifier: email })
        expect(await caught(bound.submitPassword({ password: PASSWORD }))).toMatchObject({
          code: 'flow.not_found',
          status: 404,
        })
        expect(tampering.tula.state.status).toBe('loading')
      }
      // Nothing was counted against the account by the refused tries.
      expect((await signIn(s, email)).step.status).toBe('complete')
    }
  )
})

describe('SDK journeys: sessions and tokens', () => {
  test('sessions: list devices, revoke another, revoke the others, revoke this one', async () => {
    const s = await server()
    const first = await signUp(s)
    const second = await signIn(s, first.email)
    const third = await signIn(s, first.email)

    const sessions = await first.tula.session.list()
    expect(sessions).toHaveLength(3)
    expect(sessions.filter((session) => session.current)).toHaveLength(1)
    const current = sessions.find((session) => session.current)
    expect(first.tula.state).toMatchObject({ sessionId: current?.id })

    const secondId = second.tula.state.status === 'signed-in' ? second.tula.state.sessionId : ''
    await first.tula.session.revoke(secondId)
    expect(first.tula.state.status).toBe('signed-in')
    expect(await second.tula.session.refresh()).toBeNull()

    expect(await first.tula.session.revokeOthers()).toBe(1)
    expect(await third.tula.session.refresh()).toBeNull()
    expect(await first.tula.session.list()).toHaveLength(1)

    expect(
      await caught(first.tula.session.revoke('00000000-0000-7000-8000-000000000000'))
    ).toMatchObject({
      code: 'resource.not_found',
      status: 404,
    })

    await first.tula.session.revoke(current?.id ?? '')
    expect(first.tula.state).toEqual({ status: 'signed-out' })
  })

  test('change password: needs the current one, applies the policy, and ends the other sessions', async () => {
    const s = await server()
    const first = await signUp(s)
    const other = await signIn(s, first.email)

    expect(
      await caught(
        first.tula.user.changePassword({
          currentPassword: 'wrong-current-1',
          newPassword: NEW_PASSWORD,
        })
      )
    ).toMatchObject({ code: 'auth.invalid_credentials', status: 401 })
    // A wrong current password is not a refused token: no refresh, still signed in.
    expect(first.tula.state.status).toBe('signed-in')
    expect(refreshes(s)).toHaveLength(0)

    const weak = await caught(
      first.tula.user.changePassword({ currentPassword: PASSWORD, newPassword: 'short' })
    )
    expect(weak.errors.map((problem) => problem.code)).toContain('password.too_short')

    await first.tula.user.changePassword({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
    expect(first.tula.state.status).toBe('signed-in')
    expect(await first.tula.session.refresh()).not.toBeNull()
    expect(await other.tula.session.refresh()).toBeNull()
    expect((await signIn(s, first.email, 'server', NEW_PASSWORD)).step.status).toBe('complete')
  })

  test('an expired access token is refreshed before use; 10 concurrent calls share one refresh', async () => {
    const s = await server()
    const { tula } = await signUp(s)
    const first = await tula.session.getToken()

    s.advance(49_000)
    expect(await tula.session.getToken()).toBe(first)
    expect(refreshes(s)).toHaveLength(0)

    s.advance(2_000)
    const tokens = await Promise.all(Array.from({ length: 10 }, () => tula.session.getToken()))
    expect(new Set(tokens).size).toBe(1)
    expect(tokens[0]).not.toBe(first)
    expect(refreshes(s)).toHaveLength(1)

    // A call made with a token the server has just stopped accepting is retried once.
    s.deps.clock.advance(61_000)
    expect(await tula.session.list()).toHaveLength(1)
    expect(refreshes(s)).toHaveLength(2)
    const listing = s.exchanges.filter((exchange) => exchange.path === '/v1/client/sessions')
    expect(listing.map((exchange) => exchange.status)).toEqual([401, 200])
  })

  test('an idle session past its timeout is over: the client signs out, once', async () => {
    const s = await server()
    const { tula, states } = await signUp(s)
    s.advance(8 * 24 * 60 * 60 * 1000)
    expect(await tula.session.getToken()).toBeNull()
    expect(states.map((state) => state.status)).toEqual(['signed-in', 'signed-out'])
    expect(refreshes(s)).toHaveLength(1)
  })
})

describe('SDK journeys: a browser (web kind)', () => {
  test('the refresh token only ever travels in an HttpOnly cookie, never where JavaScript can read it', async () => {
    const s = await server()
    const { tula, cookies, email } = await signUp(s, 'web')
    expect(tula.state.status).toBe('signed-in')

    await tula.session.refresh()
    await tula.session.list()
    const next = await signIn(s, email, 'web')
    expect(next.step.status).toBe('complete')

    const issued = s.exchanges.filter((exchange) => exchange.setCookie)
    expect(issued.length).toBeGreaterThanOrEqual(3)
    for (const exchange of issued) {
      expect(exchange.setCookie).toMatch(/^tula_rt_[0-9a-f-]+=tula_rt_/)
      expect(exchange.setCookie).toMatch(/HttpOnly/i)
      expect(exchange.setCookie).toMatch(/SameSite=Lax/i)
      expect(exchange.setCookie).toMatch(/Path=\/v1\/client\/sessions/i)
    }
    for (const exchange of s.exchanges) {
      expect(exchange.responseBody).not.toContain('tula_rt_')
      expect(exchange.responseBody).not.toContain('refreshToken')
      expect(exchange.requestBody).not.toContain('tula_rt_')
    }
    expect([...cookies.values()].every((value) => value.startsWith('tula_rt_'))).toBe(true)
  })

  test('a page reload restores the session from the cookie; sign-out clears it', async () => {
    const s = await server()
    const first = await signUp(s, 'web')

    // "Reload": a new client with the same browser cookies and nothing in memory.
    const reloaded = s.client('web')
    for (const [name, value] of first.cookies) {
      reloaded.cookies.set(name, value)
    }
    expect(await reloaded.tula.load()).toMatchObject({
      status: 'signed-in',
      user: { email: first.email },
    })

    await reloaded.tula.session.signOut()
    expect(reloaded.cookies.size).toBe(0)
    expect(s.exchanges.at(-1)?.setCookie).toMatch(/Max-Age=0/i)

    const afterSignOut = s.client('web')
    expect((await afterSignOut.tula.load()).status).toBe('signed-out')
  })

  test('a visitor with no cookie is signed-out after one request', async () => {
    const s = await server()
    const { tula, states } = s.client('web')
    expect(await tula.load()).toEqual({ status: 'signed-out' })
    expect(states).toEqual([{ status: 'signed-out' }])
    expect(s.exchanges).toHaveLength(1)
    expect(await tula.session.getToken()).toBeNull()
    expect(s.exchanges).toHaveLength(1)
  })

  test('a page on an origin the environment does not allow cannot start a flow', async () => {
    const s = await server()
    const { tula } = s.client('web', { origin: 'https://evil.example' })
    expect(await caught(tula.signIn.start({ identifier: 'maya@example.com' }))).toMatchObject({
      code: 'request.origin_not_allowed',
      status: 403,
      message: 'This origin is not allowed to sign in to this app.',
    })
  })
})

describe('SDK journeys: a refresh whose response is lost (the reuse grace period)', () => {
  const isRefresh = (request: Request) => request.url.endsWith('/sessions/refresh')

  /** A signed-in browser whose next `count` refresh responses can be lost on the way back. */
  async function signedInBrowser(s: Server) {
    const email = freshEmail()
    let toLose = 0
    const context = s.client('web', {
      loseResponse(request) {
        if (!isRefresh(request) || toLose === 0) {
          return false
        }
        toLose -= 1
        return true
      },
    })
    const flow = await context.tula.signUp.start({ email, password: PASSWORD })
    await flow.verifyEmail({ code: s.code(email) })
    return { ...context, loseNext: (count: number) => (toLose = count) }
  }

  test('one lost response: getToken() alone ends with a working session and the family intact', async () => {
    const s = await server()
    const { tula, states, loseNext } = await signedInBrowser(s)
    s.advance(61_000)

    // The server rotates the cookie's token; the answer never arrives. The SDK asks again at
    // once with the cookie the browser still holds, and is given the same next token.
    loseNext(1)
    const token = await tula.session.getToken()
    expect(token).toBeString()
    expect(refreshes(s).map((exchange) => exchange.status)).toEqual([200, 200])
    expect(refreshes(s)[0]?.headers.get('cookie')).toBe(refreshes(s)[1]?.headers.get('cookie'))
    expect(tula.state.status).toBe('signed-in')
    expect(await tula.session.list()).toHaveLength(1)

    // The family was not revoked: the next rotation works, with one request.
    s.advance(61_000)
    expect(await tula.session.getToken()).toBeString()
    expect(refreshes(s).map((exchange) => exchange.status)).toEqual([200, 200, 200])
    expect(states.map((state) => state.status)).toEqual(['signed-in'])
  })

  test('both tries lost, then asked again inside the grace period: still the same next token, session intact', async () => {
    const s = await server()
    const { tula, states, loseNext } = await signedInBrowser(s)
    s.advance(61_000)

    loseNext(2)
    expect(await caught(tula.session.getToken())).toMatchObject({ code: 'network.failed' })
    // Two tries, no third.
    expect(refreshes(s).map((exchange) => exchange.status)).toEqual([200, 200])
    expect(tula.state.status).toBe('signed-in')

    s.advance(3_000)
    expect(await tula.session.getToken()).toBeString()
    expect(refreshes(s).map((exchange) => exchange.status)).toEqual([200, 200, 200])
    s.advance(61_000)
    expect(await tula.session.getToken()).toBeString()
    expect(states.map((state) => state.status)).toEqual(['signed-in'])
  })

  test('both tries lost, then asked again after the grace period: the server sees reuse, the session is revoked and the client signs out once', async () => {
    const s = await server()
    const { tula, states, loseNext, cookies } = await signedInBrowser(s)
    s.advance(61_000)
    loseNext(2)
    await caught(tula.session.getToken())

    s.advance(11_000)
    expect(await tula.session.getToken()).toBeNull()
    expect(refreshes(s).at(-1)).toMatchObject({ status: 401 })
    expect(refreshes(s).at(-1)?.responseBody).toContain('session.reuse_detected')
    expect(states.map((state) => state.status)).toEqual(['signed-in', 'signed-out'])
    expect(cookies.size).toBe(0)
    // No retry loop.
    expect(await tula.session.getToken()).toBeNull()
    expect(refreshes(s)).toHaveLength(3)
  })
})

describe('SDK journeys: two tabs sharing one cookie jar', () => {
  const globals = globalThis as unknown as {
    BroadcastChannel?: unknown
    navigator: { locks?: unknown }
  }
  const original = {
    channel: Object.getOwnPropertyDescriptor(globals, 'BroadcastChannel'),
    locks: Object.getOwnPropertyDescriptor(globals.navigator, 'locks'),
  }

  /** What `createTulaClient` finds in a browser: Web Locks and BroadcastChannel, or neither. */
  function browser(supported: boolean): void {
    const tails = new Map<string, Promise<unknown>>()
    const channels: { name: string; onmessage: ((event: { data: unknown }) => void) | null }[] = []
    class Channel {
      onmessage: ((event: { data: unknown }) => void) | null = null
      readonly name: string
      constructor(name: string) {
        this.name = name
        channels.push(this)
      }
      postMessage(message: unknown): void {
        for (const other of channels) {
          if (other !== this && other.name === this.name) {
            other.onmessage?.({ data: structuredClone(message) })
          }
        }
      }
    }
    const locks = {
      request<T>(name: string, _options: unknown, callback: () => Promise<T>): Promise<T> {
        const run = (tails.get(name) ?? Promise.resolve()).then(callback)
        tails.set(
          name,
          run.then(
            () => undefined,
            () => undefined
          )
        )
        return run
      },
    }
    Object.defineProperty(globals, 'BroadcastChannel', {
      configurable: true,
      writable: true,
      value: supported ? Channel : undefined,
    })
    Object.defineProperty(globals.navigator, 'locks', {
      configurable: true,
      value: supported ? locks : undefined,
    })
  }

  afterEach(() => {
    if (original.channel) {
      Object.defineProperty(globals, 'BroadcastChannel', original.channel)
    } else {
      delete globals.BroadcastChannel
    }
    if (original.locks) {
      Object.defineProperty(globals.navigator, 'locks', original.locks)
    } else {
      delete globals.navigator.locks
    }
  })

  /** Tab A signs up; tab B is a second tab of the same browser, restored from the cookie. */
  async function twoTabs(s: Server) {
    const email = freshEmail()
    const a = s.client('web')
    const flow = await a.tula.signUp.start({ email, password: PASSWORD })
    await flow.verifyEmail({ code: s.code(email) })
    const b = s.client('web', { cookies: a.cookies })
    expect((await b.tula.load()).status).toBe('signed-in')
    return { a, b }
  }

  const presented = (s: Server) => refreshes(s).map((exchange) => exchange.headers.get('cookie'))

  test('with Web Locks and BroadcastChannel, both tabs need a token at once and one refresh serves both', async () => {
    browser(true)
    const s = await server()
    const { a, b } = await twoTabs(s)
    const before = refreshes(s).length
    s.advance(61_000)

    const [fromA, fromB] = await Promise.all([a.tula.session.getToken(), b.tula.session.getToken()])
    expect(refreshes(s).length).toBe(before + 1)
    expect(fromA).toBeString()
    expect(fromB).toBe(fromA)
    expect(a.tula.state.status).toBe('signed-in')
    expect(b.tula.state.status).toBe('signed-in')

    // Round after round, every refresh presents a cookie no refresh presented before.
    for (let round = 0; round < 3; round++) {
      s.advance(61_000)
      await Promise.all([b.tula.session.getToken(), a.tula.session.getToken()])
    }
    expect(refreshes(s).every((exchange) => exchange.status === 200)).toBe(true)
    expect(new Set(presented(s)).size).toBe(presented(s).length)
    expect(await a.tula.session.list()).toHaveLength(1)

    // Signing out in one tab ends the other at once.
    await b.tula.session.signOut()
    expect(a.tula.state).toEqual({ status: 'signed-out' })
    expect(a.cookies.size).toBe(0)
  })

  test('without either, both tabs present the same cookie at once and the grace period leaves both signed in', async () => {
    browser(false)
    const s = await server()
    const { a, b } = await twoTabs(s)
    const before = refreshes(s).length
    s.advance(61_000)

    const [fromA, fromB] = await Promise.all([a.tula.session.getToken(), b.tula.session.getToken()])
    const racing = refreshes(s).slice(before)
    expect(racing.map((exchange) => exchange.status)).toEqual([200, 200])
    // The race this path cannot prevent: the same cookie, twice.
    expect(racing[0]?.headers.get('cookie')).toBe(racing[1]?.headers.get('cookie'))
    // Both were answered with the same next token, so the jar is right whichever lands last.
    expect(racing[0]?.setCookie).toBe(racing[1]?.setCookie)
    expect(fromA).toBeString()
    expect(fromB).toBeString()
    expect(a.tula.state.status).toBe('signed-in')
    expect(b.tula.state.status).toBe('signed-in')

    // The session family survived: later rotations work from either tab.
    s.advance(61_000)
    expect(await b.tula.session.getToken()).toBeString()
    s.advance(61_000)
    expect(await a.tula.session.getToken()).toBeString()
    expect(refreshes(s).every((exchange) => exchange.status === 200)).toBe(true)
    expect(await a.tula.session.list()).toHaveLength(1)
  })
})

describe('conformance scenarios and the SDK', () => {
  test('every scenario is covered by an SDK journey or listed as server-only with a reason', async () => {
    const names = (await loadScenarios()).map(({ scenario }) => scenario.name)
    expect(names.length).toBeGreaterThanOrEqual(13)
    for (const name of names) {
      const journeys = covered.get(name)
      const reason = SERVER_ONLY[name]
      if (!journeys && !reason) {
        throw new Error(
          `conformance scenario "${name}" has no SDK journey: cover it with journey('${name}', …) ` +
            'in this file, or add it to SERVER_ONLY with the reason a client cannot reach it'
        )
      }
      // One or the other, never both: a server-only entry must not hide a real journey.
      expect(Boolean(journeys) !== Boolean(reason)).toBe(true)
    }
  })

  test('no journey or server-only entry names a scenario that does not exist', async () => {
    const names = new Set((await loadScenarios()).map(({ scenario }) => scenario.name))
    for (const name of [...covered.keys(), ...Object.keys(SERVER_ONLY)]) {
      expect(names.has(name)).toBe(true)
    }
    for (const reason of Object.values(SERVER_ONLY)) {
      expect(reason.length).toBeGreaterThan(40)
    }
  })
})
