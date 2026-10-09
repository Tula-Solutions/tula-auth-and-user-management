import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { loadScenarios, smsCodeIn, VirtualAuthenticator } from '@tula/conformance'
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  type EnvironmentSettings,
  EnvironmentSettingsSchema,
  readCustomClaims,
} from '@tula/contract'
import {
  type AuthState,
  type ClientKind,
  createTulaClient,
  evaluatePassword,
  type FlowStep,
  isStepUpRequired,
  isTulaError,
  memoryStorage,
  stepUpMethods,
  type TokenStorage,
  type TulaClient,
  type TulaError,
} from '@tula/core'
import { decodeJwt } from 'jose'
import { mockOAuthProviders } from '~/adapters/oauth/mock'
import { createApp } from '~/index'
import { base32Decode, totp } from '~/lib/totp'
import * as Hooks from '~/modules/hook/service'
import * as Sms from '~/modules/sms/service'
import {
  createTestDeps,
  seedApiKey,
  TEST_ACTOR,
  TEST_CONFIG,
  TEST_TENANT,
  type TestDeps,
} from '~/testing'

// The SDK, driven through its public API against the real server in process: memory adapters,
// a clock the tests advance, and `fetch` handed straight to the app. Every conformance
// scenario is either covered here by a journey or listed as server-only with the reason; the
// guard at the bottom fails when a new scenario is added without deciding which.

const PUBLISHABLE_KEY = 'tula_pk_dev_sdkjourneys000000000000000000000'
const SECRET_KEY = 'tula_sk_dev_sdkjourneys000000000000000000000'
/** A subject that leads with a 6-digit code, as every code email's does. */
const CODE_SUBJECT = /^(\d{6})\b/
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
  'admin user authentication':
    'how a user signs in is read on the admin API with a secret key or a dashboard session, ' +
    'neither of which a client SDK holds; a signed-in user sees their own methods through ' +
    '`/v1/client/me/factors`, `/me/passkeys` and `/me/identities`, whose journeys cover them.',
  'admin user sessions':
    'listing and ending a user’s sessions is done on the admin API with a secret key or a ' +
    'dashboard session, neither of which a client SDK holds; what the client observes when an ' +
    'admin ends its sessions (the access token refused at once, the client signed out) is the ' +
    '"admin second factor reset" journey below.',
  'dashboard credential rules':
    'the rules of the dashboard’s cookie on the admin API (`x-tula-dashboard`, the environment ' +
    'header, the origin checks) concern the operator’s browser and a server’s secret key; ' +
    '`@tula/core` talks to `/v1/client/*` only and sends neither header.',
  'native app identity':
    'an environment’s native apps are registered on the admin API with a secret key or a ' +
    'dashboard session, and the two association files are fetched by Apple and Android from ' +
    'the app’s own domain, not by an SDK: no client SDK calls either. What a native client ' +
    'does with a registered identity (a passkey, an app link) arrives with those features.',
  'settings managed by a config file':
    'the marker is set and read on the admin API with a secret key, which a client SDK never ' +
    'holds; `@tula/admin` and the `tula` CLI are driven against it in their packages’ ' +
    '`real-api.test.ts`.',
  'webhook delivered and signed':
    'webhook endpoints are registered on the admin API with a secret key, and a delivery goes ' +
    'from the server to an operator’s backend: a client SDK is on neither side of it. The ' +
    'receiving side is `@tula/admin`’s `verifyWebhook`, which `packages/admin/src/' +
    'webhook-real-api.test.ts` hands a delivery the real worker made.',
  'webhook endpoint on a refused address':
    'the outbound guard judges an address an operator registers with a secret key, which a ' +
    'client SDK never holds; `@tula/admin` is driven against the refusal in ' +
    '`packages/admin/src/webhook-real-api.test.ts`.',
  'webhook retried after a 500':
    'retries, the delivery log, test events and sending a delivery again all happen between the ' +
    'server, an operator’s backend and the admin API with a secret key: a client SDK is on no ' +
    'side of them. `@tula/admin` is driven through the same operations against the real API ' +
    'and worker in `packages/admin/src/webhook-real-api.test.ts`.',
  'webhook secret rotated with an overlap':
    'a signing secret is rotated on the admin API with a secret key, and the two signatures of ' +
    'the overlap travel from the server to an operator’s backend: a client SDK holds neither ' +
    'the key nor a signing secret, and must never. The receiving side is `@tula/admin`’s ' +
    '`verifyWebhook` with one secret or both, which `packages/admin/src/' +
    'webhook-real-api.test.ts` hands deliveries the real worker made before, during and after ' +
    'an overlap.',
  'two instances':
    'a property of the deployment (two API processes sharing Postgres and Redis). A client talks ' +
    'to one base URL and cannot tell instances apart; `multi-instance.test.ts` and the self-host ' +
    'CI job cover it.',
  'passkey assertion replay':
    'the SDK asks the authenticator for a fresh assertion on every call and never holds one to ' +
    'present twice; replaying a response, or presenting one for another attempt’s challenge, ' +
    'takes a client that sends hand-made requests.',
  'passkey origin and relying party':
    'the origin inside a WebAuthn response is written by the browser, and the `Origin` header by ' +
    'the browser too; the SDK can set neither, so a response made on another site cannot be ' +
    'produced through it.',
  'passkey signature counter':
    'the signature counter is the authenticator’s; the SDK passes its response on untouched and ' +
    'has no way to make one report a lower counter.',
  'passkeys switched off mid-attempt':
    '`signIn.withPasskey()` starts and submits in one call, so no settings change can be placed ' +
    'between the two through the SDK; the journey below covers the method being off at the start.',
  'the admin reset removes passkeys and says whether the user can still sign in':
    'the outcome is a response header of an admin route, read with the secret key by a server or ' +
    'the dashboard; a client SDK never calls it. What a client sees of a reset (the session ' +
    'ending at once) is the "admin second factor reset" journey below.',
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
      /** The session profile the client asks for (`createTulaClient({ sessionProfile })`). */
      sessionProfile?: string
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
  /** A request no SDK makes: a browser navigating (to a provider's page, to the callback). */
  navigate(path: string, init?: RequestInit): Promise<Response>
}

afterEach(() => {
  // `advance` moves this process's clock; every test starts from the real time again.
  setSystemTime()
})

async function server(prepare?: (deps: TestDeps) => void): Promise<Server> {
  const deps = createTestDeps()
  prepare?.(deps)
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
          // The refresh cookie's path is `/v1/client/sessions`; a stateful session's is `/`.
          const matching = [...cookies].filter(
            ([name]) => name.includes('tula_session_') || path.startsWith('/v1/client/sessions')
          )
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
        for (const cookie of kind === 'web' ? response.headers.getSetCookie() : []) {
          const [pair = ''] = cookie.split(';')
          const [name = '', value = ''] = pair.split('=')
          if (value === '' || /max-age=0/i.test(cookie)) {
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
        ...(options.sessionProfile && { sessionProfile: options.sessionProfile }),
      })
      return { tula, states, cookies }
    },
    code(email) {
      // The newest email that carries a code: a security notice (ADR 0023) can follow it.
      const message = deps.mailer.outbox.findLast(
        (sent) => sent.to === email && CODE_SUBJECT.test(sent.subject)
      )
      const code = CODE_SUBJECT.exec(message?.subject ?? '')?.[1]
      if (!code) {
        throw new Error(`no email with a code was sent to ${email}`)
      }
      return code
    },
    advance(ms) {
      deps.clock.advance(ms)
      setSystemTime(new Date(Date.now() + ms))
    },
    navigate: async (path, init) => app.request(path, init),
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

  /** The operator's endpoint of a hook (a sign-up's unless said): a listener in this process. */
  async function withHook(
    s: Server,
    respond: () => Response | Promise<Response>,
    run: (asked: () => number) => Promise<void>,
    point: 'before_sign_up' | 'before_session' | 'before_token' = 'before_sign_up'
  ): Promise<void> {
    let asked = 0
    const endpoint = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => {
        asked += 1
        return respond()
      },
    })
    try {
      await Hooks.create(
        s.deps,
        { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId },
        {
          point,
          url: `http://127.0.0.1:${endpoint.port}/${point}`,
          enabled: true,
          deadlineMs: 100,
          failureMode: 'deny',
        },
        TEST_ACTOR
      )
      await run(() => asked)
    } finally {
      await endpoint.stop(true)
    }
  }

  journey(
    'sign-up denied by a hook',
    'sign-up denied by a hook: the client gets the operator’s code, stays signed out, and can start again',
    async () => {
      const s = await server()
      const { tula } = s.client('server')
      const email = freshEmail()
      let answer: unknown = { decision: 'deny', code: 'disposable_email' }
      await withHook(
        s,
        () => Response.json(answer),
        async (asked) => {
          const flow = await tula.signUp.start({ email, password: PASSWORD })
          expect(flow.step.status).toBe('needs_email_verification')
          expect(asked()).toBe(0)

          const error = await caught(flow.verifyEmail({ code: s.code(email) }))
          expect(error.code).toBe('hook.denied')
          expect(error.status).toBe(403)
          expect(error.params).toEqual({ code: 'disposable_email' })
          expect(error.message).toBe('This was not allowed.')
          expect(asked()).toBe(1)
          expect(tula.state.status).not.toBe('signed-in')
          expect(await tula.session.getToken()).toBeNull()

          // The attempt has ended on the server: the flow object the client holds is spent.
          expect((await caught(flow.verifyEmail({ code: s.code(email) }))).code).toBe(
            'flow.not_found'
          )
          answer = { decision: 'allow' }
          const other = freshEmail()
          const again = await tula.signUp.start({ email: other, password: PASSWORD })
          expect((await again.verifyEmail({ code: s.code(other) })).status).toBe('complete')
          expect(tula.state.status).toBe('signed-in')
        }
      )
    }
  )

  journey(
    'hook that times out',
    'hook that times out: the client is told to try again later, not that it was refused',
    async () => {
      const s = await server()
      const { tula } = s.client('server')
      const email = freshEmail()
      await withHook(
        s,
        () => new Promise<Response>(() => undefined),
        async (asked) => {
          const flow = await tula.signUp.start({ email, password: PASSWORD })
          const started = performance.now()
          const error = await caught(flow.verifyEmail({ code: s.code(email) }))
          // The hook's deadline is 100 ms: bounded well inside a second.
          expect(performance.now() - started).toBeLessThan(1500)
          expect(error.code).toBe('hook.unavailable')
          expect(error.status).toBe(503)
          // Nothing of an operator's code: this was not a denial.
          expect(error.params?.code).toBeUndefined()
          expect(asked()).toBe(1)
          expect(tula.state.status).not.toBe('signed-in')
          expect(await tula.session.getToken()).toBeNull()
        }
      )
    }
  )

  journey(
    'sign-in denied by a hook',
    'sign-in denied by a hook: the client gets the operator’s code and no session, and a new attempt signs in',
    async () => {
      const s = await server()
      const { email } = await signUp(s)
      let answer: unknown = { decision: 'deny', code: 'account_suspended' }
      await withHook(
        s,
        () => Response.json(answer),
        async (asked) => {
          const { tula } = s.client('server')
          const flow = await tula.signIn.start({ identifier: email })
          expect(asked()).toBe(0)
          const wrong = await caught(flow.submitPassword({ password: 'not-the-password-123' }))
          expect(wrong.code).toBe('auth.invalid_credentials')
          expect(asked()).toBe(0)

          const error = await caught(flow.submitPassword({ password: PASSWORD }))
          expect(error.code).toBe('hook.denied')
          expect(error.status).toBe(403)
          expect(error.params).toEqual({ code: 'account_suspended' })
          expect(error.message).toBe('This was not allowed.')
          expect(asked()).toBe(1)
          expect(tula.state.status).not.toBe('signed-in')
          expect(await tula.session.getToken()).toBeNull()

          // The attempt has ended on the server: the flow object the client holds is spent.
          expect((await caught(flow.submitPassword({ password: PASSWORD }))).code).toBe(
            'flow.not_found'
          )
          answer = { decision: 'allow' }
          const again = await tula.signIn.start({ identifier: email })
          expect((await again.submitPassword({ password: PASSWORD })).status).toBe('complete')
          expect(tula.state.status).toBe('signed-in')
          expect(asked()).toBe(2)
        },
        'before_session'
      )
    }
  )

  journey(
    'claims added by a hook',
    'claims added by a hook: the token @tula/core hands out carries them, and a refresh keeps them without asking again',
    async () => {
      const s = await server()
      let answer: unknown = { claims: { plan: 'pro', seats: 5 } }
      await withHook(
        s,
        () => Response.json(answer),
        async (asked) => {
          const { tula, email } = await signUp(s)
          expect(asked()).toBe(1)
          const first = decodeJwt((await tula.session.getToken()) ?? '')
          expect(readCustomClaims(first)).toEqual({ plan: 'pro', seats: 5 })
          // Under the namespace claim only: nothing of the answer is a claim of its own.
          expect(first).not.toHaveProperty('plan')

          answer = { claims: { plan: 'free' } }
          const refreshed = decodeJwt((await tula.session.refresh()) ?? '')
          expect(readCustomClaims(refreshed)).toEqual({ plan: 'pro', seats: 5 })
          expect(refreshed.sid).toBe(first.sid)
          expect(asked()).toBe(1)

          // A new sign-in is a new session, and is asked about.
          const again = await signIn(s, email)
          expect(readCustomClaims(decodeJwt((await again.tula.session.getToken()) ?? ''))).toEqual({
            plan: 'free',
          })
          expect(asked()).toBe(2)
        },
        'before_token'
      )
    }
  )

  journey(
    'sign-in hook that times out',
    'sign-in hook that times out: the client is told to try again later, in bounded time, and holds no session',
    async () => {
      const s = await server()
      const { email } = await signUp(s)
      await withHook(
        s,
        () => new Promise<Response>(() => undefined),
        async (asked) => {
          const { tula } = s.client('server')
          const flow = await tula.signIn.start({ identifier: email })
          const started = performance.now()
          const error = await caught(flow.submitPassword({ password: PASSWORD }))
          // The hook's deadline is 100 ms: bounded well inside a second.
          expect(performance.now() - started).toBeLessThan(1500)
          expect(error.code).toBe('hook.unavailable')
          expect(error.status).toBe(503)
          expect(error.message).toBe('This is unavailable right now. Try again later.')
          // Nothing of an operator's code: this was not a denial.
          expect(error.params?.code).toBeUndefined()
          expect(asked()).toBe(1)
          expect(tula.state.status).not.toBe('signed-in')
          expect(await tula.session.getToken()).toBeNull()
        },
        'before_session'
      )
    }
  )

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
    'password history',
    'password history: a reused password is `password.reused` on a change and on a reset, with the policy’s number and the message; with no history it is accepted again',
    async () => {
      const s = await server()
      /** Replace the policy's `history` through the admin API, as an operator does. */
      const remember = async (history: number) => {
        const read = await s.admin('GET', '/v1/admin/settings')
        const { settings } = (await read.json()) as { settings: EnvironmentSettings }
        const saved = await s.admin(
          'PUT',
          '/v1/admin/settings',
          { ...settings, password: { ...settings.password, preset: 'custom', history } },
          { 'if-match': read.headers.get('etag') ?? '' }
        )
        expect(saved.status).toBe(200)
      }
      const { tula, email } = await signUp(s)
      await remember(3)
      // What a checklist is drawn from says how many are remembered.
      expect((await tula.config.get({ force: true })).password.history).toBe(3)

      const refused = (error: TulaError) => {
        expect(error.code).toBe('password.reused')
        expect(error.status).toBe(422)
        expect(error.params).toEqual({ history: 3 })
        // The message is the SDK's own, by code; nothing says which password it was.
        expect(error.message).toBe('You have used this password recently. Choose a different one.')
        expect(error.errors).toEqual([
          expect.objectContaining({ code: 'password.reused', params: { history: 3 } }),
        ])
      }

      // The current password is one of the three.
      refused(
        await caught(tula.user.changePassword({ currentPassword: PASSWORD, newPassword: PASSWORD }))
      )
      await tula.user.changePassword({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
      // So is the one before it.
      refused(
        await caught(
          tula.user.changePassword({ currentPassword: NEW_PASSWORD, newPassword: PASSWORD })
        )
      )
      // A refused change changed nothing: the session and the password are as they were.
      expect(tula.state.status).toBe('signed-in')

      // A reset is held to the same rule, and a refusal does not spend its code.
      s.advance(61_000)
      const other = s.client('server')
      const flow = await other.tula.resetPassword.start({ email })
      const code = s.code(email)
      refused(await caught(flow.submit({ code, password: PASSWORD })))
      refused(await caught(flow.submit({ code, password: NEW_PASSWORD })))
      const third = 'amber-Lynx-skates-63-canals'
      expect((await flow.submit({ code, password: third })).status).toBe('complete')

      // With the history back at 0 the first password is accepted again.
      await remember(0)
      await other.tula.user.changePassword({ currentPassword: third, newPassword: PASSWORD })
      expect((await signIn(s, email)).step.status).toBe('complete')
    }
  )

  journey(
    'password expiry',
    'password expiry: a right password that is too old stops at needs_new_password with its reason and no session; submitNewPassword refuses the old one and completes with a new one',
    async () => {
      const s = await server()
      const { email } = await signUp(s)
      const read = await s.admin('GET', '/v1/admin/settings')
      const { settings } = (await read.json()) as { settings: EnvironmentSettings }
      const saved = await s.admin(
        'PUT',
        '/v1/admin/settings',
        { ...settings, password: { ...settings.password, preset: 'custom', expiryDays: 1 } },
        { 'if-match': read.headers.get('etag') ?? '' }
      )
      expect(saved.status).toBe(200)

      // Not a day old yet: the password signs in.
      expect((await signIn(s, email)).step.status).toBe('complete')
      s.advance(86_400_000)

      const { tula } = s.client('server')
      const flow = await tula.signIn.start({ identifier: email })
      // A wrong password is what it always was.
      expect((await caught(flow.submitPassword({ password: 'not-the-password-1' }))).code).toBe(
        'auth.invalid_credentials'
      )
      const step = await flow.submitPassword({ password: PASSWORD })
      expect(step).toEqual({
        status: 'needs_new_password',
        destination: expect.any(String),
        strategies: [],
        reason: 'expired',
      })
      expect(tula.state.status).not.toBe('signed-in')
      expect(await tula.session.getToken()).toBeNull()

      // The expired password is not its own replacement, with no history in the policy too.
      const reused = await caught(flow.submitNewPassword({ password: PASSWORD }))
      expect(reused.code).toBe('password.reused')
      expect(reused.status).toBe(422)
      expect(reused.params).toEqual({ history: 1 })
      expect(reused.message).toBe('You have used this password recently. Choose a different one.')
      // A refusal leaves the flow on its step.
      expect(flow.step.status).toBe('needs_new_password')
      expect(tula.state.status).not.toBe('signed-in')

      expect((await flow.submitNewPassword({ password: NEW_PASSWORD })).status).toBe('complete')
      expect(tula.state.status).toBe('signed-in')
      expect(decodeJwt((await tula.session.getToken()) ?? '').amr).toEqual(['pwd'])

      // The old password is wrong now; the new one signs in and is not asked to be replaced.
      const again = await s.client('server').tula.signIn.start({ identifier: email })
      expect((await caught(again.submitPassword({ password: PASSWORD }))).code).toBe(
        'auth.invalid_credentials'
      )
      expect((await again.submitPassword({ password: NEW_PASSWORD })).status).toBe('complete')
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

describe('SDK journeys: signing in by email', () => {
  const REDIRECT = `${APP_ORIGIN}/auth/link`
  const EMAIL_LINK = /https?:\/\/\S+#\S*tula_link=\S+/

  /** A server whose environment has the email methods switched on. */
  async function emailServer(signUpPassword: 'required' | 'optional' = 'required') {
    const s = await server()
    const saved = await s.admin(
      'PUT',
      '/v1/admin/settings',
      {
        signIn: {
          methods: {
            password: { enabled: true },
            emailCode: { enabled: true },
            emailLink: { enabled: true },
          },
        },
        signUp: { password: signUpPassword },
      },
      { 'if-match': '"0"' }
    )
    expect(saved.status).toBe(200)
    return s
  }

  /** A user an admin created, with no password. */
  async function passwordlessUser(s: Server): Promise<string> {
    const email = freshEmail()
    expect((await s.admin('POST', '/v1/admin/users', { email })).status).toBe(201)
    return email
  }

  /** What a browser gives every tab of one origin: storage they share, and each its address. */
  function browser() {
    const entries = new Map<string, string>()
    const storage = {
      get length() {
        return entries.size
      },
      key: (index: number) => [...entries.keys()][index] ?? null,
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => void entries.set(key, value),
      removeItem: (key: string) => void entries.delete(key),
    }
    return {
      entries,
      /** Open a tab at `url`: the next client created reads these globals. */
      open(url: string) {
        const location = { href: url }
        const history = {
          state: null,
          replaceState(_state: unknown, _unused: string, next: string) {
            location.href = next
          },
        }
        Object.assign(globalThis, { localStorage: storage, location, history })
        return location
      },
    }
  }

  afterEach(() => {
    for (const name of ['localStorage', 'location', 'history']) {
      Reflect.deleteProperty(globalThis, name)
    }
  })

  journey(
    'email code sign-in',
    'email code: the offered strategies, a code by email, a wrong code, the right one signs in',
    async () => {
      const s = await emailServer()
      const email = await passwordlessUser(s)
      const { tula } = s.client('server')
      expect((await tula.config.get()).signIn.methods).toEqual([
        'password',
        'emailCode',
        'emailLink',
      ])

      const flow = await tula.signIn.start({ identifier: email })
      const choice: FlowStep = {
        status: 'needs_first_factor',
        strategies: ['password', 'email_code', 'email_link'],
      }
      expect(flow.step).toEqual(choice)
      // An address with no account is offered, and answered, exactly the same.
      const ghost = await s.client('server').tula.signIn.start({ identifier: 'nobody@example.com' })
      expect(ghost.step).toEqual(choice)
      expect(await ghost.prepareFirstFactor({ strategy: 'email_code' })).toEqual({
        ...choice,
        prepared: { strategy: 'email_code', destination: 'n***@example.com' },
      })

      const prepared = await flow.prepareFirstFactor({ strategy: 'email_code' })
      expect(prepared).toMatchObject({ ...choice, prepared: { strategy: 'email_code' } })
      expect(await caught(flow.prepareFirstFactor({ strategy: 'email_code' }))).toMatchObject({
        code: 'rate_limited',
        retryAfterMs: 60_000,
      })

      const code = s.code(email)
      const wrong = `${code.slice(0, -1)}${(Number(code.at(-1)) + 1) % 10}`
      expect(
        await caught(flow.attemptFirstFactor({ strategy: 'email_code', code: wrong }))
      ).toMatchObject({ code: 'verification.invalid_code', params: { attemptsRemaining: 4 } })
      expect(tula.state.status).toBe('loading')

      const step = await flow.attemptFirstFactor({ strategy: 'email_code', code })
      expect(step.status).toBe('complete')
      expect(tula.state).toMatchObject({ status: 'signed-in', user: { email } })
      // The code proved the address.
      expect((await tula.user.get()).emailVerifiedAt).not.toBeNull()

      // The account has no password: one never works for it.
      const again = await s.client('server').tula.signIn.start({ identifier: email })
      expect((await caught(again.submitPassword({ password: PASSWORD }))).code).toBe(
        'auth.invalid_credentials'
      )
    }
  )

  journey(
    'email link sign-in',
    'email link: refused in another browser, accepted in the asking one, and the starting tab is the one signed in',
    async () => {
      const s = await emailServer()
      const email = await passwordlessUser(s)
      const mine = browser()

      // The tab the user starts in.
      mine.open(`${APP_ORIGIN}/sign-in`)
      const original = s.client('web')
      expect(original.tula.signIn.canUseEmailLink()).toBe(true)
      const flow = await original.tula.signIn.start({ identifier: email })
      // A page on another origin could never read this browser's binding: the SDK says so
      // itself, and nothing is sent. (The server's own refusal of a URL that is not on the
      // allow-list is in the scenario and the API's tests.)
      expect(
        await caught(
          flow.prepareFirstFactor({ strategy: 'email_link', redirectUrl: 'https://evil.test/' })
        )
      ).toMatchObject({ code: 'link.cross_origin', status: 0 })
      expect(s.exchanges.some((exchange) => exchange.path.endsWith('/first-factor/prepare'))).toBe(
        false
      )
      const prepared = await flow.prepareFirstFactor({
        strategy: 'email_link',
        redirectUrl: REDIRECT,
      })
      expect(prepared).toMatchObject({ prepared: { strategy: 'email_link' } })
      // The browser keeps the link's binding, and only that: no token, no attempt secret.
      expect([...mine.entries.keys()]).toEqual([`tula.link.${flow.id}`])
      const kept = [...mine.entries.values()].join()
      expect(kept).toContain('tula_lb_')
      expect(kept).not.toContain('tula_at_')
      const waiting = flow.waitForEmailLink()

      const link = EMAIL_LINK.exec(s.deps.mailer.last().text)?.[0] ?? ''
      expect(link.startsWith(`${REDIRECT}#tula_link=`)).toBe(true)

      // Someone else's browser (or the user's phone): no binding there.
      const theirs = browser()
      const elsewhere = theirs.open(link)
      const stranger = s.client('web')
      expect(await stranger.tula.signIn.handleEmailLink()).toEqual({ status: 'different_browser' })
      expect(stranger.tula.state.status).toBe('loading')
      expect(elsewhere.href).toBe(REDIRECT)
      expect(stranger.cookies.size).toBe(0)

      // A new tab of the browser that asked.
      const address = mine.open(link)
      const landing = s.client('web', { cookies: original.cookies })
      await landing.tula.load()
      expect(landing.tula.state.status).toBe('signed-out')
      const outcome = await landing.tula.signIn.handleEmailLink()
      expect(outcome).toEqual({ status: 'signed_in' })
      // The fragment is gone from the address, and nothing is left in storage.
      expect(address.href).toBe(REDIRECT)
      expect(mine.entries.size).toBe(0)

      expect((await waiting).status).toBe('complete')
      expect(original.tula.state).toMatchObject({ status: 'signed-in', user: { email } })
      expect(landing.tula.state).toMatchObject({ status: 'signed-in' })

      // The link's token only ever travelled in a request body, to one route.
      const token = new URLSearchParams(new URL(link).hash.slice(1)).get('tula_link') ?? 'none'
      const carried = s.exchanges.filter((exchange) => exchange.requestBody.includes(token))
      expect(carried.map((exchange) => exchange.path)).toEqual([
        '/v1/client/sign-ins/link',
        '/v1/client/sign-ins/link',
      ])
      expect(s.exchanges.some((exchange) => exchange.path.includes(token))).toBe(false)
      // Accepting the link set no cookie and returned no tokens: only the completing call did.
      const accepted = carried.at(-1)
      expect(accepted?.setCookie).toBeNull()
      expect(accepted?.responseBody).toBe('{"status":"verified"}')

      // The same link again, in the same browser: dead.
      mine.open(link)
      const replay = s.client('web', { cookies: new Map() })
      expect(await replay.tula.signIn.handleEmailLink()).toEqual({ status: 'expired' })
    }
  )

  journey(
    'passwordless sign-up',
    'passwordless sign-up: an account with no password, which then signs in by emailed code',
    async () => {
      const required = await server()
      const refused = await caught(
        required.client('server').tula.signUp.start({ email: freshEmail() })
      )
      expect(refused).toMatchObject({ code: 'validation.failed', status: 422 })
      expect(refused.errors).toContainEqual(expect.objectContaining({ field: 'password' }))

      const s = await emailServer('optional')
      const { tula } = s.client('server')
      expect((await tula.config.get()).signUp).toEqual({ password: 'optional' })
      const email = freshEmail()
      const signUpFlow = await tula.signUp.start({ email, firstName: 'Ines' })
      expect(signUpFlow.step.status).toBe('needs_email_verification')
      expect((await signUpFlow.verifyEmail({ code: s.code(email) })).status).toBe('complete')
      expect(tula.state).toMatchObject({ status: 'signed-in', user: { email, firstName: 'Ines' } })
      expect(
        (
          await caught(
            tula.user.changePassword({ currentPassword: PASSWORD, newPassword: PASSWORD })
          )
        ).code
      ).toBe('password.not_set')

      s.advance(61_000)
      const next = s.client('server')
      const flow = await next.tula.signIn.start({ identifier: email })
      expect((await caught(flow.submitPassword({ password: PASSWORD }))).code).toBe(
        'auth.invalid_credentials'
      )
      await flow.prepareFirstFactor({ strategy: 'email_code' })
      const step = await flow.attemptFirstFactor({ strategy: 'email_code', code: s.code(email) })
      expect(step.status).toBe('complete')
      expect(next.tula.state.status).toBe('signed-in')
    }
  )
})

describe('SDK journeys: two-step verification and step-up', () => {
  const BACKUP_CODE = /^[2-9a-hjkmnp-z]{5}-[2-9a-hjkmnp-z]{5}$/
  /** One authenticator time step. A code is accepted once, so the next proof needs the next step. */
  const STEP_MS = 30_000

  /** The code an authenticator app holding `secret` shows at the server's time. */
  const authenticator = (s: Server, secret: string) =>
    totp(base32Decode(secret), s.deps.clock.now())

  /** A 6-digit code the authenticator does not show now, nor one step either side. */
  function wrongCode(s: Server, secret: string): string {
    const now = s.deps.clock.now().getTime()
    const valid = [-STEP_MS, 0, STEP_MS].map((offset) =>
      totp(base32Decode(secret), new Date(now + offset))
    )
    return ['000000', '111111', '222222', '333333'].find((code) => !valid.includes(code)) ?? ''
  }

  /** What the access token the client would send says about how the user proved themselves. */
  async function proofs(tula: TulaClient): Promise<string[]> {
    const { amr } = decodeJwt((await tula.session.getToken()) ?? '')
    return Array.isArray(amr) ? amr.map(String) : []
  }

  /**
   * Sign up and turn two-step verification on through the SDK. The clock is left one step
   * later: the code that confirmed the enrolment is spent.
   */
  async function enrolled(s: Server, kind: ClientKind = 'server') {
    const user = await signUp(s, kind)
    const { secret } = await user.tula.mfa.startTotp()
    const { codes } = await user.tula.mfa.confirmTotp({ code: authenticator(s, secret) })
    s.advance(STEP_MS)
    return { ...user, secret, codes }
  }

  /** A sign-in with the password, on a new client, for a user who has a second factor. */
  async function atSecondFactor(s: Server, email: string, password = PASSWORD) {
    const context = await signIn(s, email, 'server', password)
    expect(context.step).toEqual({
      status: 'needs_second_factor',
      options: ['totp', 'backup_code'],
    })
    // No tokens before the second factor: the client is not signed in.
    expect(context.tula.state.status).toBe('loading')
    return context
  }

  journey(
    'two-step enrolment and sign-in',
    'two-step verification: enrol an authenticator, then sign in with the password and its code',
    async () => {
      const s = await server()
      const { tula, email } = await signUp(s)
      expect(await tula.mfa.get()).toEqual({
        totp: { enabled: false, confirmedAt: null },
        backupCodes: { remaining: 0 },
      })

      const { secret, uri } = await tula.mfa.startTotp()
      expect(secret).toMatch(/^[A-Z2-7]{32}$/)
      expect(uri.startsWith('otpauth://totp/')).toBe(true)
      expect(uri).toContain(`secret=${secret}`)
      // Not confirmed: it counts for nothing.
      expect((await tula.mfa.get()).totp.enabled).toBe(false)

      expect(await caught(tula.mfa.confirmTotp({ code: wrongCode(s, secret) }))).toMatchObject({
        code: 'mfa.invalid_code',
        status: 422,
      })
      const before = refreshes(s).length
      const { codes } = await tula.mfa.confirmTotp({ code: authenticator(s, secret) })
      expect(codes).toHaveLength(10)
      for (const code of codes) {
        expect(code).toMatch(BACKUP_CODE)
      }
      // The SDK refreshed the session, so the token in hand says the factor was proven.
      expect(refreshes(s)).toHaveLength(before + 1)
      expect(await proofs(tula)).toContain('mfa')
      expect(tula.state.status).toBe('signed-in')
      expect(await tula.mfa.get()).toMatchObject({
        totp: { enabled: true },
        backupCodes: { remaining: 10 },
      })
      // Nothing the SDK holds shows the secret or a code.
      const visible = JSON.stringify(tula) + JSON.stringify(tula.state)
      for (const hidden of [secret, ...codes]) {
        expect(visible).not.toContain(hidden)
      }

      s.advance(STEP_MS)
      const second = await atSecondFactor(s, email)
      const { step } = await second.flow.submitSecondFactor({
        method: 'totp',
        code: authenticator(s, secret),
      })
      expect(step.status).toBe('complete')
      expect(second.tula.state).toMatchObject({ status: 'signed-in', user: { email } })
      expect(await proofs(second.tula)).toEqual(expect.arrayContaining(['pwd', 'otp', 'mfa']))
      expect((await second.tula.mfa.get()).backupCodes.remaining).toBe(10)
    }
  )

  journey(
    'second factor lockout',
    'second factor lockout: six wrong codes, then every try is rate_limited, for the user and not the attempt',
    async () => {
      const s = await server()
      const { email, secret, codes } = await enrolled(s)
      const first = await atSecondFactor(s, email)
      const wrong = wrongCode(s, secret)
      for (let guess = 0; guess < 6; guess += 1) {
        expect(
          await caught(first.flow.submitSecondFactor({ method: 'totp', code: wrong }))
        ).toMatchObject({ code: 'mfa.invalid_code', status: 422 })
      }
      const locked = await caught(first.flow.submitSecondFactor({ method: 'totp', code: wrong }))
      expect(locked).toMatchObject({ code: 'rate_limited', status: 429 })
      expect(locked.retryAfterMs).toBeGreaterThan(0)
      // One budget for both methods: a correct backup code is locked out too.
      expect(
        await caught(first.flow.submitSecondFactor({ method: 'backup_code', code: codes[0] ?? '' }))
      ).toMatchObject({ code: 'rate_limited', status: 429 })
      expect(first.flow.step.status).toBe('needs_second_factor')

      // The password has a lockout of its own and is still accepted; the second factor is
      // locked for the user, whatever the attempt.
      const again = await atSecondFactor(s, email)
      expect(
        await caught(
          again.flow.submitSecondFactor({ method: 'totp', code: authenticator(s, secret) })
        )
      ).toMatchObject({ code: 'rate_limited', status: 429 })
      expect(again.tula.state.status).toBe('loading')
      expect(first.tula.state.status).toBe('loading')
    }
  )

  journey(
    'authenticator code replay',
    'an authenticator code is accepted once: not after it confirmed the enrolment, and not on a second sign-in',
    async () => {
      const s = await server()
      const { tula, email } = await signUp(s)
      const { secret } = await tula.mfa.startTotp()
      const confirming = authenticator(s, secret)
      await tula.mfa.confirmTotp({ code: confirming })

      const first = await atSecondFactor(s, email)
      expect(
        await caught(first.flow.submitSecondFactor({ method: 'totp', code: confirming }))
      ).toMatchObject({ code: 'mfa.invalid_code', status: 422 })
      expect(first.tula.state.status).toBe('loading')

      s.advance(STEP_MS)
      const next = authenticator(s, secret)
      expect(
        (await first.flow.submitSecondFactor({ method: 'totp', code: next })).step.status
      ).toBe('complete')
      expect(first.tula.state.status).toBe('signed-in')

      const second = await atSecondFactor(s, email)
      expect(
        await caught(second.flow.submitSecondFactor({ method: 'totp', code: next }))
      ).toMatchObject({ code: 'mfa.invalid_code', status: 422 })
      expect(second.tula.state.status).toBe('loading')
    }
  )

  journey(
    'backup codes',
    'backup codes: each works once and says how many are left; a new set replaces the old one',
    async () => {
      const s = await server()
      const { email, codes } = await enrolled(s)
      const [one = '', two = '', three = ''] = codes
      const unknown = codes.includes('zzzzz-zzzzz') ? 'yyyyy-yyyyy' : 'zzzzz-zzzzz'

      const first = await atSecondFactor(s, email)
      expect(
        await caught(first.flow.submitSecondFactor({ method: 'backup_code', code: unknown }))
      ).toMatchObject({ code: 'mfa.invalid_code', status: 422 })
      // However it is typed: here with spaces around it.
      expect(
        await first.flow.submitSecondFactor({ method: 'backup_code', code: `  ${one}  ` })
      ).toMatchObject({ step: { status: 'complete' }, backupCodesRemaining: 9 })
      expect(first.tula.state.status).toBe('signed-in')
      expect((await first.tula.mfa.get()).backupCodes.remaining).toBe(9)
      expect(JSON.stringify(first.flow)).not.toContain(one)

      const second = await atSecondFactor(s, email)
      expect(
        await caught(second.flow.submitSecondFactor({ method: 'backup_code', code: one }))
      ).toMatchObject({ code: 'mfa.invalid_code' })
      expect(
        await second.flow.submitSecondFactor({ method: 'backup_code', code: two })
      ).toMatchObject({ step: { status: 'complete' }, backupCodesRemaining: 8 })

      // This session just proved the second factor: no step-up is asked for.
      const { codes: fresh } = await second.tula.mfa.regenerateBackupCodes()
      expect(fresh).toHaveLength(10)
      expect(fresh.some((code) => codes.includes(code))).toBe(false)
      expect((await second.tula.mfa.get()).backupCodes.remaining).toBe(10)

      const third = await atSecondFactor(s, email)
      expect(
        await caught(third.flow.submitSecondFactor({ method: 'backup_code', code: three }))
      ).toMatchObject({ code: 'mfa.invalid_code' })
      expect(
        await third.flow.submitSecondFactor({ method: 'backup_code', code: fresh[0] ?? '' })
      ).toMatchObject({ step: { status: 'complete' }, backupCodesRemaining: 9 })
    }
  )

  journey(
    'password reset with a second factor',
    'a password reset stops at the second factor: no session until the authenticator’s code',
    async () => {
      const s = await server()
      const before = await enrolled(s)
      const { email, secret } = before
      // Past the one-email-a-minute limit for the address, which the sign-up used.
      s.advance(61_000)
      const { tula } = s.client('server')
      const flow = await tula.resetPassword.start({ email })
      expect(await flow.submit({ code: s.code(email), password: NEW_PASSWORD })).toEqual({
        status: 'needs_second_factor',
        options: ['totp', 'backup_code'],
      })
      expect(tula.state.status).toBe('loading')

      expect(
        await caught(flow.submitSecondFactor({ method: 'totp', code: wrongCode(s, secret) }))
      ).toMatchObject({ code: 'mfa.invalid_code', status: 422 })
      expect(flow.step.status).toBe('needs_second_factor')

      const { step } = await flow.submitSecondFactor({
        method: 'totp',
        code: authenticator(s, secret),
      })
      expect(step.status).toBe('complete')
      expect(tula.state).toMatchObject({ status: 'signed-in', user: { email } })

      // The session from before the reset has ended, and the factor outlives the reset.
      expect(await before.tula.session.refresh()).toBeNull()
      expect(before.tula.state).toEqual({ status: 'signed-out' })
      s.advance(STEP_MS)
      await atSecondFactor(s, email, NEW_PASSWORD)
    }
  )

  journey(
    'step-up',
    'step-up: a sensitive call says what to prove; session.stepUp installs a fresh token for the same session, and the repeated call succeeds',
    async () => {
      const s = await server()
      const { tula, states, cookies } = await signUp(s, 'web')
      const sessionId = tula.state.status === 'signed-in' ? tula.state.sessionId : ''
      const stepUps = () =>
        s.exchanges.filter((exchange) => exchange.path === '/v1/client/sessions/step-up')

      // Without a second factor the password steps up.
      expect(
        await caught(tula.session.stepUp({ method: 'password', password: 'wrong-password-1' }))
      ).toMatchObject({ code: 'auth.invalid_credentials', status: 401 })
      expect(tula.state.status).toBe('signed-in')
      const cookie = JSON.stringify([...cookies])
      const tokenBefore = await tula.session.getToken()
      s.advance(1_000)
      await tula.session.stepUp({ method: 'password', password: PASSWORD })
      // A fresh access token for the same session; the refresh cookie was neither sent nor set.
      expect(await tula.session.getToken()).not.toBe(tokenBefore)
      expect(tula.state).toMatchObject({ status: 'signed-in', sessionId })
      expect(await proofs(tula)).toContain('pwd')
      expect(JSON.stringify([...cookies])).toBe(cookie)
      expect(stepUps().at(-1)).toMatchObject({ status: 200, setCookie: null })
      expect(stepUps().at(-1)?.responseBody).not.toContain('refreshToken')
      expect(refreshes(s)).toHaveLength(0)
      expect(states).toHaveLength(1)

      // A method the user does not have is refused, naming the one to use.
      const noFactor = await caught(tula.session.stepUp({ method: 'totp', code: '123456' }))
      expect(isStepUpRequired(noFactor)).toBe(true)
      expect(stepUpMethods(noFactor)).toEqual(['password', 'email_code'])

      const { secret } = await tula.mfa.startTotp()
      const { codes } = await tula.mfa.confirmTotp({ code: authenticator(s, secret) })
      // Right after the enrolment the SDK's refreshed token carries the proof.
      expect((await tula.mfa.get()).backupCodes.remaining).toBe(10)

      // Eleven minutes on, the proof is too old for a sensitive action.
      s.advance(11 * 60_000)
      for (const sensitive of [
        () => tula.mfa.regenerateBackupCodes(),
        () => tula.mfa.disableTotp(),
        () => tula.user.changePassword({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
      ]) {
        const refused = await caught(sensitive())
        expect(refused).toMatchObject({ code: 'auth.step_up_required', status: 403 })
        expect(isStepUpRequired(refused)).toBe(true)
        expect(stepUpMethods(refused)).toEqual(['totp', 'backup_code'])
      }
      // The SDK asked for nothing by itself.
      const asked = stepUps().length

      // The password alone no longer steps up.
      const passwordOnly = await caught(
        tula.session.stepUp({ method: 'password', password: PASSWORD })
      )
      expect(stepUpMethods(passwordOnly)).toEqual(['totp', 'backup_code'])
      const unknown = codes.includes('zzzzz-zzzzz') ? 'yyyyy-yyyyy' : 'zzzzz-zzzzz'
      expect(
        await caught(tula.session.stepUp({ method: 'backup_code', code: unknown }))
      ).toMatchObject({ code: 'mfa.invalid_code', status: 422 })
      expect(stepUps()).toHaveLength(asked + 2)

      const refreshed = refreshes(s).length
      const jar = JSON.stringify([...cookies])
      await tula.session.stepUp({ method: 'backup_code', code: codes[0] ?? '' })
      expect(refreshes(s)).toHaveLength(refreshed)
      expect(JSON.stringify([...cookies])).toBe(jar)
      expect(await proofs(tula)).toEqual(expect.arrayContaining(['backup_code', 'mfa']))
      expect(tula.state).toMatchObject({ status: 'signed-in', sessionId })

      // The repeated action succeeds with the fresh token.
      expect((await tula.mfa.regenerateBackupCodes()).codes).toHaveLength(10)
      // And the proof survives a refresh: it belongs to the session, not to one token.
      await tula.session.refresh()
      expect(await proofs(tula)).toContain('mfa')
      await tula.user.changePassword({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
      expect(states).toHaveLength(1)
    }
  )

  journey(
    'admin second factor reset',
    'an admin resets a user’s second factor: their sessions end at once, and the next sign-in needs the password alone',
    async () => {
      const s = await server()
      const { tula, email, states } = await enrolled(s)
      const userId = tula.state.status === 'signed-in' ? tula.state.user?.id : undefined
      expect((await s.admin('DELETE', `/v1/admin/users/${userId}/factors`)).status).toBe(204)

      // The access token is refused at once, and so is the refresh the SDK then tries.
      expect((await caught(tula.mfa.get())).status).toBe(401)
      expect(tula.state).toEqual({ status: 'signed-out' })
      expect(states.at(-1)).toEqual({ status: 'signed-out' })
      expect(states.filter((state) => state.status === 'signed-out')).toHaveLength(1)

      const again = await signIn(s, email)
      expect(again.step.status).toBe('complete')
      expect(await again.tula.mfa.get()).toEqual({
        totp: { enabled: false, confirmedAt: null },
        backupCodes: { remaining: 0 },
      })
    }
  )

  journey(
    'required second factor',
    'policy required: sign-in and sign-up stop at needs_factor_enrolment and complete with backup codes; the factor cannot be turned off',
    async () => {
      const s = await server()
      const existing = await signUp(s)
      const { email } = existing
      expect((await existing.tula.config.get()).mfa?.policy).toBe('optional')
      const saved = await s.admin(
        'PUT',
        '/v1/admin/settings',
        { mfa: { policy: 'required' } },
        { 'if-match': '"0"' }
      )
      expect(saved.status).toBe(200)
      expect((await existing.tula.config.get({ force: true })).mfa?.policy).toBe('required')

      // A user without a factor gets no session until they have enrolled one.
      const { tula, flow, step } = await signIn(s, email)
      expect(step).toEqual({ status: 'needs_factor_enrolment', methods: ['totp'] })
      expect(tula.state.status).toBe('loading')
      const { secret, uri } = await flow.startTotpEnrolment()
      expect(secret).toMatch(/^[A-Z2-7]{32}$/)
      expect(uri.startsWith('otpauth://totp/')).toBe(true)
      expect(flow.step.status).toBe('needs_factor_enrolment')
      expect(await caught(flow.confirmTotpEnrolment({ code: wrongCode(s, secret) }))).toMatchObject(
        { code: 'mfa.invalid_code', status: 422 }
      )
      expect(tula.state.status).toBe('loading')

      const result = await flow.confirmTotpEnrolment({ code: authenticator(s, secret) })
      expect(result.step.status).toBe('complete')
      expect(result.failure).toBeUndefined()
      expect(result.backupCodes).toHaveLength(10)
      for (const code of result.backupCodes) {
        expect(code).toMatch(BACKUP_CODE)
      }
      expect(tula.state).toMatchObject({ status: 'signed-in', user: { email } })
      expect(await proofs(tula)).toContain('mfa')
      const visible = JSON.stringify(flow) + JSON.stringify(tula) + JSON.stringify(tula.state)
      for (const hidden of [secret, ...result.backupCodes]) {
        expect(visible).not.toContain(hidden)
      }

      expect(await caught(tula.mfa.disableTotp())).toMatchObject({
        code: 'mfa.required_by_policy',
        status: 403,
      })
      expect(await tula.mfa.get()).toMatchObject({
        totp: { enabled: true },
        backupCodes: { remaining: 10 },
      })

      // A sign-up under the policy enrols before it gets a session.
      const newcomer = s.client('server')
      const newcomerEmail = freshEmail()
      const signUpFlow = await newcomer.tula.signUp.start({
        email: newcomerEmail,
        password: PASSWORD,
      })
      expect(await signUpFlow.verifyEmail({ code: s.code(newcomerEmail) })).toEqual({
        status: 'needs_factor_enrolment',
        methods: ['totp'],
      })
      expect(newcomer.tula.state.status).toBe('loading')
      const enrolment = await signUpFlow.startTotpEnrolment()
      const joined = await signUpFlow.confirmTotpEnrolment({
        code: authenticator(s, enrolment.secret),
      })
      expect(joined.step.status).toBe('complete')
      expect(joined.backupCodes).toHaveLength(10)
      expect(newcomer.tula.state).toMatchObject({
        status: 'signed-in',
        user: { email: newcomerEmail },
      })

      // The first user's next sign-in asks for the factor, not for an enrolment.
      s.advance(STEP_MS)
      const next = await atSecondFactor(s, email)
      expect(
        await next.flow.submitSecondFactor({
          method: 'backup_code',
          code: result.backupCodes[0] ?? '',
        })
      ).toMatchObject({ step: { status: 'complete' }, backupCodesRemaining: 9 })
    }
  )
})

describe('SDK journeys: OAuth', () => {
  const SIGN_IN_PAGE = `${APP_ORIGIN}/sign-in`
  const CALLBACK_PAGE = `${APP_ORIGIN}/oauth/callback`

  /** A server whose providers are the mock provider, with Google configured. */
  async function oauthServer(): Promise<Server> {
    const s = await server((deps) => {
      deps.config = { ...deps.config, oauthMock: true }
      Object.assign(deps, {
        oauth: mockOAuthProviders({
          secretBox: deps.secretBox,
          clock: deps.clock,
          publicUrl: deps.config.publicUrl,
        }),
      })
    })
    const saved = await s.admin('PUT', '/v1/admin/oauth-providers/google', {
      clientId: 'journey-client',
      clientSecret: 'journey-client-secret',
    })
    expect(saved.status).toBe(200)
    return s
  }

  /** The same, with Microsoft configured too, for any Microsoft account. */
  async function microsoftServer(): Promise<Server> {
    const s = await oauthServer()
    const saved = await s.admin('PUT', '/v1/admin/oauth-providers/microsoft', {
      clientId: 'journey-microsoft-client',
      clientSecret: 'journey-microsoft-secret',
      tenant: 'common',
    })
    expect(saved.status).toBe(200)
    return s
  }

  /** One browser tab: `sessionStorage` that survives its navigations, and its address. */
  function tab() {
    const entries = new Map<string, string>()
    const storage = {
      get length() {
        return entries.size
      },
      key: (index: number) => [...entries.keys()][index] ?? null,
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => void entries.set(key, value),
      removeItem: (key: string) => void entries.delete(key),
    }
    const visited: string[] = []
    return {
      entries,
      visited,
      /** Load a page at `url`: the next client created reads these globals. */
      open(url: string) {
        const location = {
          href: url,
          assign(next: string) {
            visited.push(next)
          },
        }
        const history = {
          state: null,
          replaceState(_state: unknown, _unused: string, next: string) {
            location.href = next
          },
        }
        Object.assign(globalThis, { sessionStorage: storage, location, history })
        return location
      },
    }
  }

  afterEach(() => {
    for (const name of ['sessionStorage', 'location', 'history']) {
      Reflect.deleteProperty(globalThis, name)
    }
  })

  const pathOf = (url: string) => url.slice(new URL(url).origin.length)

  /** Play the user at the provider; returns the app URL the API's callback redirects to. */
  async function atProvider(
    s: Server,
    authorizationUrl: string,
    consent: Record<string, string>
  ): Promise<string> {
    const url = new URL(authorizationUrl)
    expect(url.pathname).toBe('/v1/dev/oauth/authorize')
    const consented = await s.navigate(url.pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...Object.fromEntries(url.searchParams), ...consent }),
    })
    expect(consented.status).toBe(302)
    const callback = await s.navigate(pathOf(consented.headers.get('location') ?? ''))
    expect(callback.status).toBe(303)
    expect(callback.headers.get('set-cookie')).toBeNull()
    return callback.headers.get('location') ?? ''
  }

  /** The whole round trip in one tab, up to the outcome on the landing page. */
  async function continueWithGoogle(
    s: Server,
    consent: Record<string, string>,
    options: {
      cookies?: Map<string, string>
      browserTab?: ReturnType<typeof tab>
      provider?: 'google' | 'microsoft' | 'discord' | 'linkedin' | 'x' | 'facebook'
    } = {}
  ) {
    const browserTab = options.browserTab ?? tab()
    browserTab.open(SIGN_IN_PAGE)
    const first = s.client('web', { cookies: options.cookies })
    const { url } = await first.tula.signIn.withOAuth({
      provider: options.provider ?? 'google',
      redirectUrl: CALLBACK_PAGE,
    })
    expect(browserTab.visited.at(-1)).toBe(url)
    const landingUrl = await atProvider(s, url, consent)
    const location = browserTab.open(landingUrl)
    const landing = s.client('web', { cookies: first.cookies })
    const outcome = await landing.tula.signIn.handleOAuthCallback()
    return { outcome, landing, location, browserTab, landingUrl }
  }

  journey(
    'OAuth sign-up and sign-in',
    'OAuth: continue with a provider, come back, and be signed in; nothing token-like is kept or left in the address',
    async () => {
      const s = await oauthServer()
      const email = freshEmail()
      const first = tab()
      first.open(SIGN_IN_PAGE)
      const start = s.client('web')
      expect(start.tula.signIn.canUseOAuth()).toBe(true)
      expect((await start.tula.config.get()).signIn.oauth).toEqual(['google'])
      const { url } = await start.tula.signIn.withOAuth({
        provider: 'google',
        redirectUrl: CALLBACK_PAGE,
      })
      // The tab keeps the binding and nothing else: no attempt secret, no token.
      expect(first.entries.size).toBe(1)
      const kept = [...first.entries.values()].join()
      expect(kept).toContain('tula_ob_')
      expect(kept).not.toContain('tula_at_')
      expect(start.tula.state.status).not.toBe('signed-in')

      const landingUrl = await atProvider(s, url, { email })
      expect(landingUrl).toStartWith(`${CALLBACK_PAGE}#tula_ticket=`)
      const location = first.open(landingUrl)
      const landing = s.client('web', { cookies: start.cookies })
      const outcome = await landing.tula.signIn.handleOAuthCallback()
      expect(outcome.status).toBe('complete')
      expect(landing.tula.state).toMatchObject({ status: 'signed-in', user: { email } })
      expect(location.href).toBe(CALLBACK_PAGE)
      expect(first.entries.size).toBe(0)
      // The refresh token went to the cookie; no response body the SDK saw held one.
      expect(landing.cookies.size).toBe(1)
      const exchange = s.exchanges.find((sent) => sent.path.endsWith('/sign-ins/oauth/exchange'))
      expect(exchange?.responseBody).not.toContain('refreshToken')
      // No request the SDK made carries the ticket, the binding or a code in its URL.
      for (const sent of s.exchanges) {
        expect(sent.path).not.toMatch(/tula_ot_|tula_ob_|code=|state=/)
      }

      // Signing in again finds the same account.
      const userId =
        landing.tula.state.status === 'signed-in' ? (landing.tula.state.user?.id ?? '') : ''
      await landing.tula.session.signOut()
      const again = await continueWithGoogle(s, { email })
      expect(again.outcome.status).toBe('complete')
      expect(again.landing.tula.state).toMatchObject({ status: 'signed-in', user: { id: userId } })
    }
  )

  journey(
    'OAuth sign-up and sign-in',
    'OAuth: a ticket opened in a browser that did not start the sign-in completes nothing; cancelling and an unverified address are outcomes',
    async () => {
      const s = await oauthServer()
      // The attacker's own round trip, stopped before the app's page.
      const attackerTab = tab()
      attackerTab.open(SIGN_IN_PAGE)
      const attacker = s.client('web')
      const { url } = await attacker.tula.signIn.withOAuth({
        provider: 'google',
        redirectUrl: CALLBACK_PAGE,
      })
      const attackerLanding = await atProvider(s, url, { email: freshEmail() })
      // The victim's browser is sent to that URL.
      const victimTab = tab()
      const location = victimTab.open(attackerLanding)
      const victim = s.client('web')
      expect(await victim.tula.signIn.handleOAuthCallback()).toEqual({
        status: 'different_browser',
      })
      expect(victim.tula.state.status).not.toBe('signed-in')
      expect(victim.cookies.size).toBe(0)
      expect(location.href).toBe(CALLBACK_PAGE)

      const cancelled = await continueWithGoogle(s, { action: 'deny' })
      expect(cancelled.outcome).toMatchObject({ status: 'error', code: 'oauth.access_denied' })
      expect(cancelled.browserTab.entries.size).toBe(0)

      const unverified = await continueWithGoogle(s, { email: freshEmail(), unverified: '1' })
      expect(unverified.outcome).toMatchObject({ status: 'error', code: 'oauth.email_unverified' })
      expect(unverified.landing.tula.state.status).not.toBe('signed-in')

      const elsewhere = await caught(
        s.client('web').tula.signIn.withOAuth({
          provider: 'google',
          redirectUrl: 'https://not-allowed.example/oauth/callback',
        })
      )
      expect(elsewhere.code).toBe('link.cross_origin')
    }
  )

  journey(
    'OAuth account linking',
    'OAuth: automatic linking needs a verified address on both sides; a profile links and unlinks, but not the last way in',
    async () => {
      const s = await oauthServer()
      const member = freshEmail()
      const created = await s.admin('POST', '/v1/admin/users', {
        email: member,
        password: PASSWORD,
        emailVerified: true,
      })
      const memberId = ((await created.json()) as { id: string }).id
      const linked = await continueWithGoogle(s, { email: member })
      expect(linked.outcome.status).toBe('complete')
      expect(linked.landing.tula.state).toMatchObject({ user: { id: memberId } })
      const { tula } = linked.landing
      const [identity] = await tula.user.identities.list()
      expect(identity).toMatchObject({ provider: 'google' })
      // The member has a password, so the provider account can go.
      await tula.user.identities.unlink({ identityId: identity?.id ?? '' })
      expect(await tula.user.identities.list()).toEqual([])

      const squatted = freshEmail()
      await s.admin('POST', '/v1/admin/users', { email: squatted, password: PASSWORD })
      const refused = await continueWithGoogle(s, { email: squatted })
      expect(refused.outcome).toMatchObject({ status: 'error', code: 'oauth.account_exists' })
      expect(refused.landing.tula.state.status).not.toBe('signed-in')

      // The member connects an account with another address from their profile.
      const profileTab = tab()
      profileTab.open(`${APP_ORIGIN}/account`)
      const profile = s.client('web', { cookies: linked.landing.cookies })
      await profile.tula.load()
      const { url } = await profile.tula.user.identities.link({
        provider: 'google',
        redirectUrl: CALLBACK_PAGE,
      })
      expect([...profileTab.entries.values()].join()).toContain('"k":"link"')
      const back = await atProvider(s, url, { email: freshEmail(), subject: 'another-account' })
      profileTab.open(back)
      const landing = s.client('web', { cookies: profile.cookies })
      await landing.tula.load()
      const outcome = await landing.tula.signIn.handleOAuthCallback()
      expect(outcome).toMatchObject({ status: 'linked', identity: { provider: 'google' } })
      expect(await landing.tula.user.identities.list()).toHaveLength(1)
      expect(profileTab.entries.size).toBe(0)

      // Someone whose only way in is the provider account cannot remove it.
      const only = await continueWithGoogle(s, { email: freshEmail() })
      const [last] = await only.landing.tula.user.identities.list()
      const error = await caught(
        only.landing.tula.user.identities.unlink({ identityId: last?.id ?? '' })
      )
      expect(error.code).toBe('identity.last_sign_in_method')
      expect(await only.landing.tula.user.identities.list()).toHaveLength(1)
    }
  )

  // Microsoft's token names an account by two ids and proves an address only with the
  // verified-domain claim. The SDK needs to know none of it: it is given outcomes.
  const CONTOSO = 'aaaabbbb-0000-cccc-1111-dddd2222eeee'
  const FABRIKAM = 'bbbbcccc-1111-dddd-2222-eeee3333ffff'
  const guid = () => crypto.randomUUID()
  const withMicrosoft = (s: Server, consent: Record<string, string>) =>
    continueWithGoogle(s, consent, { provider: 'microsoft' })

  journey(
    'Microsoft sign-up and sign-in',
    'Microsoft: the config offers it, a sign-up comes back signed in, and the same account signs in again whatever address is reported',
    async () => {
      const s = await microsoftServer()
      const email = freshEmail()
      const account = { tenant_id: CONTOSO, object_id: guid() }
      expect((await s.client('web').tula.config.get()).signIn.oauth).toEqual([
        'google',
        'microsoft',
      ])
      const first = await withMicrosoft(s, { email, ...account })
      expect(first.outcome.status).toBe('complete')
      expect(first.landing.tula.state).toMatchObject({ status: 'signed-in', user: { email } })
      expect(first.location.href).toBe(CALLBACK_PAGE)
      expect(first.browserTab.entries.size).toBe(0)
      expect(await first.landing.tula.user.identities.list()).toMatchObject([
        { provider: 'microsoft' },
      ])
      const userId =
        first.landing.tula.state.status === 'signed-in'
          ? (first.landing.tula.state.user?.id ?? '')
          : ''
      await first.landing.tula.session.signOut()

      // The same two ids, another address, no verified-domain claim: the same user.
      const again = await withMicrosoft(s, { email: freshEmail(), ...account, unverified: '1' })
      expect(again.outcome.status).toBe('complete')
      expect(again.landing.tula.state).toMatchObject({
        status: 'signed-in',
        user: { id: userId, email },
      })

      // The same object id in another tenant is somebody else.
      const other = await withMicrosoft(s, {
        email: freshEmail(),
        tenant_id: FABRIKAM,
        object_id: account.object_id,
      })
      expect(other.outcome.status).toBe('complete')
      expect(other.landing.tula.state).not.toMatchObject({ user: { id: userId } })

      // A new account whose token has no verified-domain claim is an outcome, not a session.
      const unvouched = await withMicrosoft(s, {
        email: freshEmail(),
        tenant_id: FABRIKAM,
        object_id: guid(),
        unverified: '1',
      })
      expect(unvouched.outcome).toMatchObject({ status: 'error', code: 'oauth.email_unverified' })
      expect(unvouched.landing.tula.state.status).not.toBe('signed-in')
      expect(unvouched.browserTab.entries.size).toBe(0)
    }
  )

  journey(
    'Microsoft sign-up and sign-in',
    'Microsoft: an account of a tenant the environment does not accept comes back as a provider error',
    async () => {
      const s = await oauthServer()
      const saved = await s.admin('PUT', '/v1/admin/oauth-providers/microsoft', {
        clientId: 'journey-microsoft-client',
        clientSecret: 'journey-microsoft-secret',
        tenant: CONTOSO,
      })
      expect(saved.status).toBe(200)
      const email = freshEmail()
      const outsider = await withMicrosoft(s, { email, tenant_id: FABRIKAM, object_id: guid() })
      expect(outsider.outcome).toMatchObject({ status: 'error', code: 'oauth.provider_error' })
      expect(outsider.landing.tula.state.status).not.toBe('signed-in')
      expect(outsider.landing.cookies.size).toBe(0)
      const member = await withMicrosoft(s, { email, tenant_id: CONTOSO, object_id: guid() })
      expect(member.outcome.status).toBe('complete')
    }
  )

  journey(
    'Microsoft account linking',
    'Microsoft: an address without the verified-domain claim links to nobody; with it, and a verified Tula address, it links; a profile links whatever the claim',
    async () => {
      const s = await microsoftServer()
      const member = freshEmail()
      const created = await s.admin('POST', '/v1/admin/users', {
        email: member,
        password: PASSWORD,
        emailVerified: true,
      })
      const memberId = ((await created.json()) as { id: string }).id

      // Another tenant's administrator typed the member's address into an account of theirs.
      const attacker = { tenant_id: FABRIKAM, object_id: guid(), unverified: '1' }
      const taken = await withMicrosoft(s, { email: member, ...attacker })
      expect(taken.outcome).toMatchObject({ status: 'error', code: 'oauth.email_unverified' })
      expect(taken.landing.tula.state.status).not.toBe('signed-in')
      expect(taken.landing.cookies.size).toBe(0)
      // The same outcome for an address nobody has.
      const nobody = await withMicrosoft(s, { email: freshEmail(), ...attacker })
      expect(nobody.outcome).toEqual(taken.outcome)

      // The member's own organization, its domain verified: linked and signed in.
      const linked = await withMicrosoft(s, {
        email: member,
        tenant_id: CONTOSO,
        object_id: guid(),
      })
      expect(linked.outcome.status).toBe('complete')
      expect(linked.landing.tula.state).toMatchObject({ user: { id: memberId } })
      expect(await linked.landing.tula.user.identities.list()).toMatchObject([
        { provider: 'microsoft' },
      ])

      // An account whose Tula address was never verified is not linked into, claim or not.
      const squatted = freshEmail()
      await s.admin('POST', '/v1/admin/users', { email: squatted, password: PASSWORD })
      const refused = await withMicrosoft(s, {
        email: squatted,
        tenant_id: CONTOSO,
        object_id: guid(),
      })
      expect(refused.outcome).toMatchObject({ status: 'error', code: 'oauth.account_exists' })

      // From a profile the session is the proof: no claim, another address, connected.
      const colleagueEmail = freshEmail()
      const colleague = s.client('web')
      await s.admin('POST', '/v1/admin/users', {
        email: colleagueEmail,
        password: PASSWORD,
        emailVerified: true,
      })
      const signIn = await colleague.tula.signIn.start({ identifier: colleagueEmail })
      await signIn.submitPassword({ password: PASSWORD })
      const profileTab = tab()
      profileTab.open(`${APP_ORIGIN}/account`)
      // A client reads its tab when it is created: the profile page's own.
      const profile = s.client('web', { cookies: colleague.cookies })
      await profile.tula.load()
      const { url } = await profile.tula.user.identities.link({
        provider: 'microsoft',
        redirectUrl: CALLBACK_PAGE,
      })
      const second = { tenant_id: CONTOSO, object_id: guid(), unverified: '1' }
      profileTab.open(await atProvider(s, url, { email: freshEmail(), ...second }))
      const landing = s.client('web', { cookies: profile.cookies })
      await landing.tula.load()
      expect(await landing.tula.signIn.handleOAuthCallback()).toMatchObject({
        status: 'linked',
        identity: { provider: 'microsoft' },
      })
      await landing.tula.session.signOut()
      const back = await withMicrosoft(s, { email: freshEmail(), ...second })
      expect(back.outcome.status).toBe('complete')
      expect(back.landing.tula.state).toMatchObject({
        user: { email: colleagueEmail },
      })
    }
  )

  // Discord names an account by its user id (a snowflake) and LinkedIn by the `sub` of its ID
  // token; each proves an address only when it says so itself. The SDK needs to know none of
  // it: it is given outcomes.
  const snowflake = () =>
    String(BigInt(`0x${crypto.randomUUID().replaceAll('-', '').slice(0, 15)}`) + 1n)
  for (const { provider, name, accountId } of [
    { provider: 'discord', name: 'Discord', accountId: snowflake },
    { provider: 'linkedin', name: 'LinkedIn', accountId: () => `li-${crypto.randomUUID()}` },
  ] as const) {
    const providerServer = async (): Promise<Server> => {
      const s = await oauthServer()
      const saved = await s.admin('PUT', `/v1/admin/oauth-providers/${provider}`, {
        clientId: `journey-${provider}-client`,
        clientSecret: `journey-${provider}-secret`,
      })
      expect(saved.status).toBe(200)
      return s
    }
    const withProvider = (s: Server, consent: Record<string, string>) =>
      continueWithGoogle(s, consent, { provider })

    journey(
      `${name} sign-up and sign-in`,
      `${name}: the config offers it, a sign-up comes back signed in, and the same account signs in again whatever address is reported`,
      async () => {
        const s = await providerServer()
        const email = freshEmail()
        const subject = accountId()
        expect((await s.client('web').tula.config.get()).signIn.oauth).toEqual(['google', provider])
        const first = await withProvider(s, { email, subject })
        expect(first.outcome.status).toBe('complete')
        expect(first.landing.tula.state).toMatchObject({ status: 'signed-in', user: { email } })
        expect(first.location.href).toBe(CALLBACK_PAGE)
        expect(first.browserTab.entries.size).toBe(0)
        expect(await first.landing.tula.user.identities.list()).toMatchObject([{ provider }])
        const userId =
          first.landing.tula.state.status === 'signed-in'
            ? (first.landing.tula.state.user?.id ?? '')
            : ''
        await first.landing.tula.session.signOut()

        // The same id, another address the provider does not vouch for: the same user.
        const again = await withProvider(s, { email: freshEmail(), subject, unverified: '1' })
        expect(again.outcome.status).toBe('complete')
        expect(again.landing.tula.state).toMatchObject({
          status: 'signed-in',
          user: { id: userId, email },
        })

        // A new account whose address the provider has not verified is an outcome, not a
        // session.
        const unvouched = await withProvider(s, {
          email: freshEmail(),
          subject: accountId(),
          unverified: '1',
        })
        expect(unvouched.outcome).toMatchObject({
          status: 'error',
          code: 'oauth.email_unverified',
        })
        expect(unvouched.landing.tula.state.status).not.toBe('signed-in')
        expect(unvouched.browserTab.entries.size).toBe(0)
      }
    )

    journey(
      `${name} account linking`,
      `${name}: an unverified address links to nobody; a verified one, and a verified Tula address, links; a profile links whatever the provider says`,
      async () => {
        const s = await providerServer()
        const member = freshEmail()
        const created = await s.admin('POST', '/v1/admin/users', {
          email: member,
          password: PASSWORD,
          emailVerified: true,
        })
        const memberId = ((await created.json()) as { id: string }).id

        // Someone typed the member's address into an account of theirs and never proved it.
        const attacker = { subject: accountId(), unverified: '1' }
        const taken = await withProvider(s, { email: member, ...attacker })
        expect(taken.outcome).toMatchObject({ status: 'error', code: 'oauth.email_unverified' })
        expect(taken.landing.tula.state.status).not.toBe('signed-in')
        expect(taken.landing.cookies.size).toBe(0)
        // The same outcome for an address nobody has.
        const nobody = await withProvider(s, { email: freshEmail(), ...attacker })
        expect(nobody.outcome).toEqual(taken.outcome)

        // The member's own account, its address verified by the provider: linked, signed in.
        const linked = await withProvider(s, { email: member, subject: accountId() })
        expect(linked.outcome.status).toBe('complete')
        expect(linked.landing.tula.state).toMatchObject({ user: { id: memberId } })
        expect(await linked.landing.tula.user.identities.list()).toMatchObject([{ provider }])

        // An account whose Tula address was never verified is not linked into.
        const squatted = freshEmail()
        await s.admin('POST', '/v1/admin/users', { email: squatted, password: PASSWORD })
        const refused = await withProvider(s, { email: squatted, subject: accountId() })
        expect(refused.outcome).toMatchObject({ status: 'error', code: 'oauth.account_exists' })

        // From a profile the session is the proof: unverified, another address, connected.
        const colleagueEmail = freshEmail()
        const colleague = s.client('web')
        await s.admin('POST', '/v1/admin/users', {
          email: colleagueEmail,
          password: PASSWORD,
          emailVerified: true,
        })
        const signIn = await colleague.tula.signIn.start({ identifier: colleagueEmail })
        await signIn.submitPassword({ password: PASSWORD })
        const profileTab = tab()
        profileTab.open(`${APP_ORIGIN}/account`)
        // A client reads its tab when it is created: the profile page's own.
        const profile = s.client('web', { cookies: colleague.cookies })
        await profile.tula.load()
        const { url } = await profile.tula.user.identities.link({
          provider,
          redirectUrl: CALLBACK_PAGE,
        })
        const second = { subject: accountId(), unverified: '1' }
        profileTab.open(await atProvider(s, url, { email: freshEmail(), ...second }))
        const landing = s.client('web', { cookies: profile.cookies })
        await landing.tula.load()
        expect(await landing.tula.signIn.handleOAuthCallback()).toMatchObject({
          status: 'linked',
          identity: { provider },
        })
        await landing.tula.session.signOut()
        const back = await withProvider(s, { email: freshEmail(), ...second })
        expect(back.outcome.status).toBe('complete')
        expect(back.landing.tula.state).toMatchObject({
          user: { email: colleagueEmail },
        })
      }
    )
  }

  // X and Facebook are asked for no email address: an account made through either has none,
  // and nothing they say connects one to an account that has. The SDK is given a user whose
  // `email` is `null`, and outcomes.
  for (const { provider, name } of [
    { provider: 'x', name: 'X' },
    { provider: 'facebook', name: 'Facebook' },
  ] as const) {
    const providerServer = async (): Promise<Server> => {
      const s = await oauthServer()
      const saved = await s.admin('PUT', `/v1/admin/oauth-providers/${provider}`, {
        clientId: `journey-${provider}-client`,
        clientSecret: `journey-${provider}-secret`,
      })
      expect(saved.status).toBe(200)
      return s
    }
    const withProvider = (s: Server, consent: Record<string, string>) =>
      continueWithGoogle(s, consent, { provider })
    const signedInAs = (client: { tula: { state: { status: string; user?: unknown } } }) =>
      client.tula.state.status === 'signed-in'
        ? (client.tula.state.user as { id: string; email: string | null } | null)
        : null

    journey(
      `${name} sign-up and sign-in`,
      `${name}: a sign-up comes back signed in to an account with no email address, the same id signs it in again, and an address on the consent form is never read`,
      async () => {
        const s = await providerServer()
        const subject = snowflake()
        expect((await s.client('web').tula.config.get()).signIn.oauth).toEqual(['google', provider])
        const first = await withProvider(s, { subject })
        expect(first.outcome.status).toBe('complete')
        const user = signedInAs(first.landing)
        expect(user).toMatchObject({ email: null, emailVerifiedAt: null, hasPassword: false })
        expect(first.location.href).toBe(CALLBACK_PAGE)
        expect(first.browserTab.entries.size).toBe(0)
        expect(await first.landing.tula.user.identities.list()).toMatchObject([{ provider }])
        await first.landing.tula.session.signOut()

        const again = await withProvider(s, { subject })
        expect(again.outcome.status).toBe('complete')
        expect(signedInAs(again.landing)).toMatchObject({ id: user?.id, email: null })
        await again.landing.tula.session.signOut()

        // Another person, whose consent form names an address: a second account, and the
        // address in nothing the SDK was sent.
        const reported = freshEmail()
        const other = await withProvider(s, { subject: snowflake(), email: reported })
        expect(other.outcome.status).toBe('complete')
        expect(signedInAs(other.landing)).toMatchObject({ email: null })
        expect(signedInAs(other.landing)?.id).not.toBe(user?.id)
        for (const sent of s.exchanges) {
          expect(sent.responseBody).not.toContain(reported)
        }
      }
    )

    journey(
      `${name} never links by address`,
      `${name}: a consent form that names a member’s address makes a new account and touches nobody’s; its only identity cannot be removed; a profile still connects one`,
      async () => {
        const s = await providerServer()
        const member = freshEmail()
        const created = await s.admin('POST', '/v1/admin/users', {
          email: member,
          password: PASSWORD,
          emailVerified: true,
        })
        const memberId = ((await created.json()) as { id: string }).id

        const stranger = await withProvider(s, { subject: snowflake(), email: member })
        expect(stranger.outcome.status).toBe('complete')
        const made = signedInAs(stranger.landing)
        expect(made).toMatchObject({ email: null })
        expect(made?.id).not.toBe(memberId)
        // Its only way to sign in stays: the refusal is an error with a contract code.
        const [only] = await stranger.landing.tula.user.identities.list()
        expect(only).toMatchObject({ provider })
        await expect(
          stranger.landing.tula.user.identities.unlink({ identityId: only?.id ?? '' })
        ).rejects.toMatchObject({ code: 'identity.last_sign_in_method', status: 409 })
        expect(await stranger.landing.tula.user.identities.list()).toHaveLength(1)

        // From a profile the session is the proof, and that account then signs the member in.
        const browser = s.client('web')
        const signIn = await browser.tula.signIn.start({ identifier: member })
        await signIn.submitPassword({ password: PASSWORD })
        const profileTab = tab()
        profileTab.open(`${APP_ORIGIN}/account`)
        const profile = s.client('web', { cookies: browser.cookies })
        await profile.tula.load()
        expect(await profile.tula.user.identities.list()).toEqual([])
        const { url } = await profile.tula.user.identities.link({
          provider,
          redirectUrl: CALLBACK_PAGE,
        })
        const subject = snowflake()
        profileTab.open(await atProvider(s, url, { subject }))
        const landing = s.client('web', { cookies: profile.cookies })
        await landing.tula.load()
        expect(await landing.tula.signIn.handleOAuthCallback()).toMatchObject({
          status: 'linked',
          identity: { provider },
        })
        await landing.tula.session.signOut()
        const back = await withProvider(s, { subject })
        expect(back.outcome.status).toBe('complete')
        expect(signedInAs(back.landing)).toMatchObject({ id: memberId, email: member })
      }
    )
  }

  journey(
    'OAuth with a second factor',
    'OAuth: a user with an authenticator comes back to a flow on the second factor, and is signed in only after it',
    async () => {
      const s = await oauthServer()
      const email = freshEmail()
      const first = await continueWithGoogle(s, { email })
      expect(first.outcome.status).toBe('complete')
      const { secret } = await first.landing.tula.mfa.startTotp()
      const key = base32Decode(secret)
      await first.landing.tula.mfa.confirmTotp({ code: totp(key, s.deps.clock.now()) })
      s.advance(31_000)

      const second = await continueWithGoogle(s, { email })
      if (second.outcome.status !== 'needs_step') {
        throw new Error(`expected a flow on the second factor, got ${second.outcome.status}`)
      }
      const { flow } = second.outcome
      expect(flow.step).toEqual({ status: 'needs_second_factor', options: ['totp', 'backup_code'] })
      expect(second.landing.tula.state.status).not.toBe('signed-in')
      expect(second.landing.cookies.size).toBe(0)
      const done = await flow.submitSecondFactor({
        method: 'totp',
        code: totp(key, s.deps.clock.now()),
      })
      expect(done.step.status).toBe('complete')
      expect(second.landing.tula.state).toMatchObject({ status: 'signed-in', user: { email } })
      const token = await second.landing.tula.session.getToken()
      expect(new Set(decodeJwt(token ?? '').amr as string[])).toEqual(
        new Set(['fed', 'otp', 'mfa'])
      )
    }
  )

  journey(
    'step-up by emailed code',
    'step-up by email: a user with no password asks for a code, proves it and repeats the sensitive call; with a second factor the code is gone',
    async () => {
      const s = await oauthServer()
      const email = freshEmail()
      const { outcome, landing } = await continueWithGoogle(s, { email })
      expect(outcome.status).toBe('complete')
      const { tula, cookies } = landing
      expect((await tula.user.get()).hasPassword).toBe(false)
      const sessionId = tula.state.status === 'signed-in' ? tula.state.sessionId : ''
      const amr = async () => new Set(decodeJwt((await tula.session.getToken()) ?? '').amr as [])
      const sends = () =>
        s.exchanges.filter((sent) => sent.path === '/v1/client/sessions/step-up/email-code')

      // Eleven minutes on, a sensitive call says what this user can prove: only an emailed code.
      s.advance(11 * 60_000)
      const refused = await caught(tula.mfa.startTotp())
      expect(isStepUpRequired(refused)).toBe(true)
      expect(stepUpMethods(refused)).toEqual(['email_code'])
      // The SDK sent no email by itself.
      expect(sends()).toHaveLength(0)

      const receipt = await tula.session.prepareStepUp({ method: 'email_code' })
      expect(receipt).toEqual({
        method: 'email_code',
        destination: expect.stringMatching(/^.\*\*\*@/),
        expiresAt: expect.any(String),
      })
      const code = s.code(email)
      expect(sends().at(-1)?.responseBody).not.toContain(code)
      expect(await caught(tula.session.prepareStepUp({ method: 'email_code' }))).toMatchObject({
        code: 'rate_limited',
        status: 429,
        retryAfterMs: expect.any(Number),
      })

      expect(
        await caught(
          tula.session.stepUp({
            method: 'email_code',
            code: code === '000000' ? '111111' : '000000',
          })
        )
      ).toMatchObject({ code: 'verification.invalid_code', status: 422 })
      const jar = JSON.stringify([...cookies])
      await tula.session.stepUp({ method: 'email_code', code })
      // The same session, a token that says the mailbox was proven, and the cookie untouched.
      expect(tula.state).toMatchObject({ status: 'signed-in', sessionId })
      expect(await amr()).toEqual(new Set(['fed', 'email']) as never)
      expect(JSON.stringify([...cookies])).toBe(jar)
      expect(await caught(tula.session.stepUp({ method: 'email_code', code }))).toMatchObject({
        code: 'verification.expired',
        status: 410,
      })

      // The repeated call succeeds; once the factor is on, the emailed code is no longer a way.
      const { secret } = await tula.mfa.startTotp()
      await tula.mfa.confirmTotp({ code: totp(base32Decode(secret), s.deps.clock.now()) })
      const gone = await caught(tula.session.prepareStepUp({ method: 'email_code' }))
      expect(stepUpMethods(gone)).toEqual(['totp', 'backup_code'])
      expect(
        stepUpMethods(await caught(tula.session.stepUp({ method: 'email_code', code })))
      ).toEqual(['totp', 'backup_code'])
    }
  )
})

describe('passkeys through the SDK', () => {
  const settings = (overrides: Partial<EnvironmentSettings> = {}): EnvironmentSettings => ({
    ...DEFAULT_ENVIRONMENT_SETTINGS,
    signIn: {
      methods: { ...DEFAULT_ENVIRONMENT_SETTINGS.signIn.methods, passkey: { enabled: true } },
    },
    urls: { allowedOrigins: [APP_ORIGIN], allowedRedirectUrls: [] },
    passkeys: { rpId: 'localhost' },
    ...overrides,
  })
  let revision = 0
  const configure = (s: Server, overrides: Partial<EnvironmentSettings> = {}) => {
    revision += 1
    s.deps.environmentSettings.seed(TEST_TENANT.environmentId, {
      revision,
      settings: settings(overrides),
    })
  }

  type Globals = { navigator: object; PublicKeyCredential?: unknown }
  const globals = globalThis as unknown as Globals

  /** Give this process a browser's WebAuthn, backed by a software authenticator. */
  function plugIn(authenticator: VirtualAuthenticator, behaviour: { cancel?: boolean } = {}) {
    const ceremony = (run: (options: unknown) => Promise<unknown>) => async (input: unknown) => {
      if (behaviour.cancel) {
        throw Object.assign(new Error('dismissed'), { name: 'NotAllowedError' })
      }
      const response = await run((input as { publicKey: unknown }).publicKey)
      return { toJSON: () => response }
    }
    Object.defineProperty(globals.navigator, 'credentials', {
      configurable: true,
      value: {
        create: ceremony((options) => authenticator.create(options, { origin: APP_ORIGIN })),
        get: ceremony((options) => authenticator.get(options, { origin: APP_ORIGIN })),
      },
    })
    // The browser's own JSON helpers: the options reach the authenticator as the API sent them.
    globals.PublicKeyCredential = {
      parseCreationOptionsFromJSON: (options: unknown) => options,
      parseRequestOptionsFromJSON: (options: unknown) => options,
    }
  }

  afterEach(() => {
    Reflect.deleteProperty(globals.navigator, 'credentials')
    Reflect.deleteProperty(globals, 'PublicKeyCredential')
  })

  journey(
    'passkey registration and sign-in',
    'a signed-in user adds a passkey, and another browser signs in with it and nothing else',
    async () => {
      const s = await server()
      configure(s)
      const { tula, email } = await signUp(s, 'web')
      // Before the page has WebAuthn the SDK says so, without a request.
      expect(tula.signIn.canUsePasskey()).toBe(false)
      expect((await caught(tula.user.passkeys.add())).code).toBe('passkey.unsupported')
      const authenticator = new VirtualAuthenticator()
      plugIn(authenticator)
      expect(tula.signIn.canUsePasskey()).toBe(true)
      const passkey = await tula.user.passkeys.add({ name: 'MacBook' })
      expect(passkey).toMatchObject({ name: 'MacBook', synced: false, lastUsedAt: null })
      expect(await tula.user.passkeys.list()).toEqual([passkey])
      const renamed = await tula.user.passkeys.rename({ passkeyId: passkey.id, name: 'Work' })
      expect(renamed.name).toBe('Work')
      // The config a sign-in screen is drawn from lists the method.
      expect((await tula.config.get({ force: true })).signIn.methods).toContain('passkey')

      const visitor = s.client('web')
      const flow = await visitor.tula.signIn.withPasskey()
      expect(flow.step.status).toBe('complete')
      expect(visitor.tula.state).toMatchObject({ status: 'signed-in' })
      expect((await visitor.tula.user.get()).email).toBe(email)
      const claims = decodeJwt((await visitor.tula.session.getToken()) as string)
      expect(new Set(claims.amr as string[])).toEqual(new Set(['hwk', 'user', 'mfa']))
      // A browser client: the refresh token went into the cookie, never the body.
      expect(visitor.cookies.size).toBe(1)
      expect((await visitor.tula.user.passkeys.list())[0]?.lastUsedAt).not.toBeNull()

      // A dismissed dialog signs nobody in and sends nothing to be judged.
      plugIn(authenticator, { cancel: true })
      const dismissed = s.client('web')
      const before = s.exchanges.length
      expect((await caught(dismissed.tula.signIn.withPasskey())).code).toBe('passkey.cancelled')
      expect(dismissed.tula.state.status).not.toBe('signed-in')
      expect(
        s.exchanges.slice(before).filter((exchange) => exchange.path.endsWith('/passkey'))
      ).toHaveLength(1)

      // An authenticator with no passkey of this app: the API's one generic answer.
      const stranger = new VirtualAuthenticator()
      await stranger.create(
        {
          rp: { id: 'localhost' },
          user: { id: 'c3RyYW5nZXI' },
          challenge: 'YQ',
          pubKeyCredParams: [{ alg: -7 }],
        },
        { origin: APP_ORIGIN }
      )
      plugIn(stranger)
      const refused = await caught(s.client('web').tula.signIn.withPasskey())
      expect(refused).toMatchObject({ code: 'auth.invalid_credentials', status: 401 })

      // Switched off: the method answers so at the start.
      configure(s, { signIn: DEFAULT_ENVIRONMENT_SETTINGS.signIn })
      plugIn(authenticator)
      expect((await caught(s.client('web').tula.signIn.withPasskey())).code).toBe(
        'auth.method_disabled'
      )
    }
  )

  journey(
    'a passkey satisfies two-step verification',
    'with an authenticator app enrolled, the passkey signs in on its own and also serves as the second factor',
    async () => {
      const s = await server()
      configure(s)
      const { tula, email } = await signUp(s, 'web')
      const authenticator = new VirtualAuthenticator()
      plugIn(authenticator)
      await tula.user.passkeys.add()
      const { secret } = await tula.mfa.startTotp()
      await tula.mfa.confirmTotp({ code: await totp(base32Decode(secret), s.deps.clock.now()) })

      // The passkey alone: complete, no second step.
      const direct = s.client('web')
      expect((await direct.tula.signIn.withPasskey()).step.status).toBe('complete')

      // The password, then the passkey as the second factor.
      const { flow, step, tula: second } = await signIn(s, email, 'web')
      expect(step).toEqual({
        status: 'needs_second_factor',
        options: ['totp', 'backup_code', 'passkey'],
      })
      expect(second.state.status).not.toBe('signed-in')
      const done = await flow.submitSecondFactorWithPasskey()
      expect(done.step.status).toBe('complete')
      const claims = decodeJwt((await second.session.getToken()) as string)
      expect(new Set(claims.amr as string[])).toEqual(new Set(['pwd', 'hwk', 'user', 'mfa']))

      // Where a second factor is required, the passkey still completes on its own.
      configure(s, { mfa: { policy: 'required' } })
      const required = s.client('web')
      expect((await required.tula.signIn.withPasskey()).step.status).toBe('complete')
    }
  )

  journey(
    ['step-up with a passkey', 'the last way to sign in cannot be removed'],
    'a stale session steps up with its passkey, and the last way in cannot be removed',
    async () => {
      const s = await server()
      configure(s)
      const { tula } = await signUp(s, 'web')
      const authenticator = new VirtualAuthenticator()
      plugIn(authenticator)
      const first = await tula.user.passkeys.add({ name: 'First' })
      const laptop = new VirtualAuthenticator()
      plugIn(laptop)
      const second = await tula.user.passkeys.add({ name: 'Second' })

      s.advance(11 * 60_000)
      const stale = await caught(tula.user.passkeys.rename({ passkeyId: first.id, name: 'x' }))
      expect(isStepUpRequired(stale)).toBe(true)
      expect(stepUpMethods(stale)).toEqual(['passkey', 'password', 'email_code'])
      // A dismissed dialog steps up nothing.
      plugIn(laptop, { cancel: true })
      expect((await caught(tula.session.stepUpWithPasskey())).code).toBe('passkey.cancelled')
      expect(
        isStepUpRequired(
          await caught(tula.user.passkeys.rename({ passkeyId: first.id, name: 'x' }))
        )
      ).toBe(true)
      plugIn(laptop)
      await tula.session.stepUpWithPasskey()
      const claims = decodeJwt((await tula.session.getToken()) as string)
      expect(claims.amr).toEqual(expect.arrayContaining(['hwk', 'user', 'mfa']))

      // Only the passkeys let this user in now.
      configure(s, {
        signIn: {
          methods: {
            password: { enabled: false },
            emailCode: { enabled: false },
            emailLink: { enabled: false },
            passkey: { enabled: true },
            smsCode: { enabled: false },
          },
        },
      })
      await tula.user.passkeys.remove({ passkeyId: first.id })
      const last = await caught(tula.user.passkeys.remove({ passkeyId: second.id }))
      expect(last).toMatchObject({ code: 'passkey.last_sign_in_method', status: 409 })
      expect(await tula.user.passkeys.list()).toHaveLength(1)
      // The removed passkey no longer signs in; the remaining one does.
      plugIn(authenticator)
      expect((await caught(s.client('web').tula.signIn.withPasskey())).code).toBe(
        'auth.invalid_credentials'
      )
      plugIn(laptop)
      expect((await s.client('web').tula.signIn.withPasskey()).step.status).toBe('complete')
    }
  )
})

describe('SDK journeys: session profiles and rules', () => {
  let revision = 0

  /** Save a `sessions` section, validated as the admin API would. */
  function configure(s: Server, sessions: unknown): void {
    revision += 1
    s.deps.environmentSettings.seed(TEST_TENANT.environmentId, {
      revision,
      settings: EnvironmentSettingsSchema.parse({ ...DEFAULT_ENVIRONMENT_SETTINGS, sessions }),
    })
  }

  const profileOf = async (tula: TulaClient) => decodeJwt((await tula.session.getToken()) ?? '').sp

  journey(
    'session profile timeouts',
    'a session past its profile’s limits signs the client out at its next refresh',
    async () => {
      const s = await server()
      const before = await signUp(s)
      configure(s, {
        profiles: { mobile: { accessTokenTtl: '30s', idleTimeout: '1m', absoluteTimeout: '90s' } },
      })
      const active = await signIn(s, before.email)
      expect(await profileOf(active.tula)).toBe('mobile')

      s.advance(50_000)
      expect(await active.tula.session.refresh()).toBeString()
      expect(active.tula.state.status).toBe('signed-in')

      s.advance(45_000)
      // Active 45 seconds ago, but 95 seconds old: the absolute timeout ends it.
      expect(await active.tula.session.refresh()).toBeNull()
      expect(active.tula.state.status).toBe('signed-out')
      // The session from before the profile was tightened ends at its next refresh too.
      expect(await before.tula.session.refresh()).toBeNull()
      expect(before.states.at(-1)?.status).toBe('signed-out')
    }
  )

  journey(
    'session profile selection',
    'sessionProfile gets a profile the environment offers, and is otherwise ignored',
    async () => {
      const s = await server()
      configure(s, {
        profiles: {
          'back-office': { accessTokenTtl: '2m', clientSelectable: true },
          kept: { idleTimeout: '365d', absoluteTimeout: null },
        },
      })
      const { email } = await signUp(s)
      const as = async (sessionProfile?: string) => {
        const { tula } = s.client('server', { sessionProfile })
        await (await tula.signIn.start({ identifier: email })).submitPassword({
          password: PASSWORD,
        })
        return profileOf(tula)
      }
      expect(await as('back-office')).toBe('back-office')
      expect(await as('kept')).toBe('mobile')
      expect(await as('no-such-profile')).toBe('mobile')
      expect(await as()).toBe('mobile')
    }
  )

  journey(
    'jwt template custom claims',
    'the token @tula/core hands out carries the template’s claims, from the next refresh on',
    async () => {
      const s = await server()
      const claims = async (tula: TulaClient) =>
        readCustomClaims(decodeJwt((await tula.session.getToken()) ?? ''))
      // `server` is not a browser: its sessions take the `mobile` profile.
      const { tula, email } = await signUp(s)
      expect(await claims(tula)).toBeNull()

      configure(s, {
        jwtTemplates: {
          app: {
            claims: {
              role: { value: 'member' },
              email: { from: 'user.email' },
              verified: { from: 'user.email_verified' },
              client: { from: 'session.client' },
            },
          },
        },
        profiles: { mobile: { jwtTemplate: 'app' } },
      })
      // The token in hand is unchanged; the one a refresh brings has the claims.
      expect(await claims(tula)).toBeNull()
      const refreshed = await tula.session.refresh()
      expect(readCustomClaims(decodeJwt(refreshed ?? ''))).toEqual({
        role: 'member',
        email,
        verified: true,
        client: 'server',
      })

      const again = await signIn(s, email)
      expect(await claims(again.tula)).toMatchObject({ role: 'member', client: 'server' })

      configure(s, { jwtTemplates: { app: { claims: {} } } })
      expect(readCustomClaims(decodeJwt((await tula.session.refresh()) ?? ''))).toBeNull()
    }
  )

  journey(
    'concurrent session limit',
    'end_oldest signs the oldest client out; refuse_newest fails the sign-in with session.limit_reached',
    async () => {
      const s = await server()
      configure(s, { maxPerUser: 2, onLimit: 'end_oldest' })
      const first = await signUp(s)
      const second = await signIn(s, first.email)
      const third = await signIn(s, first.email)
      expect(third.step.status).toBe('complete')
      // The oldest device finds out on its next call: its token is refused and it cannot refresh.
      expect((await caught(first.tula.session.list())).code).toBe('session.revoked')
      expect(first.tula.state.status).toBe('signed-out')
      expect(await second.tula.session.list()).toHaveLength(2)

      configure(s, { maxPerUser: 2, onLimit: 'refuse_newest' })
      const refused = s.client('server')
      const flow = await refused.tula.signIn.start({ identifier: first.email })
      const error = await caught(flow.submitPassword({ password: PASSWORD }))
      expect(error.code).toBe('session.limit_reached')
      expect(error.status).toBe(403)
      expect(error.message).toContain('too many devices')
      expect(refused.tula.state.status).not.toBe('signed-in')

      await second.tula.session.signOut()
      expect((await signIn(s, first.email)).step.status).toBe('complete')
    }
  )

  journey(
    'stateful session',
    'a browser on a stateful profile holds no token: the cookie signs it in, across a reload, until it is revoked',
    async () => {
      const s = await server()
      configure(s, { profiles: { web: { type: 'stateful' } } })
      const { tula, cookies, email } = await signUp(s, 'web')
      expect(tula.state).toMatchObject({ status: 'signed-in', user: { email } })
      expect(await tula.session.getToken()).toBeNull()
      expect([...cookies.keys()]).toEqual([`tula_session_${TEST_TENANT.environmentId}`])

      // No response body ever held a token, and no request an Authorization header.
      const calls = s.exchanges.filter((exchange) => exchange.path.startsWith('/v1/client'))
      expect(calls.some((call) => /tula_st_|tula_rt_|accessToken/.test(call.responseBody))).toBe(
        false
      )
      expect(calls.some((call) => call.headers.has('authorization'))).toBe(false)

      // Authenticated calls work on the cookie alone.
      expect(await tula.session.list()).toHaveLength(1)
      const user = await tula.user.get()
      expect(user.email).toBe(email)

      // A reload: a new client with the same cookie jar restores the session from it.
      const reloaded = s.client('web', { cookies })
      expect(await reloaded.tula.load()).toMatchObject({ status: 'signed-in', user: { email } })
      expect(await reloaded.tula.session.getToken()).toBeNull()

      // A page on an origin the environment does not allow gets nothing from the cookie.
      // (The `local` tier allows every loopback origin, so the foreign page is not one.)
      const foreign = s.client('web', {
        cookies: new Map(cookies),
        origin: 'https://evil.example',
      })
      expect((await foreign.tula.load()).status).toBe('signed-out')

      // A backend verifies the cookie's value with the secret key.
      const [token] = [...cookies.values()]
      const verified = await s.admin('POST', '/v1/admin/sessions/verify', { token })
      expect(await verified.json()).toMatchObject({ sub: user.id, sp: 'web' })

      // An operator ends the sessions: the very next call signs the client out.
      const ended = await s.admin('DELETE', `/v1/admin/users/${user.id}/sessions`)
      expect(await ended.json()).toEqual({ revoked: 1 })
      expect((await caught(tula.session.list())).code).toBe('session.revoked')
      expect(tula.state.status).toBe('signed-out')
      expect((await s.client('web', { cookies }).tula.load()).status).toBe('signed-out')
    }
  )

  journey(
    'step-up window per profile',
    'a sensitive call past the profile’s window asks for a step-up, and works again after it',
    async () => {
      const s = await server()
      configure(s, { profiles: { mobile: { accessTokenTtl: '5m', stepUpAfter: '1m' } } })
      const { tula } = await signUp(s)
      await tula.mfa.startTotp()
      s.advance(61_000)
      const error = await caught(tula.mfa.startTotp())
      expect(isStepUpRequired(error)).toBe(true)
      expect(stepUpMethods(error)).toContain('password')
      // An ordinary call is not held to the window.
      expect((await tula.user.get()).id).toBeString()
      await tula.session.stepUp({ method: 'password', password: PASSWORD })
      expect((await tula.mfa.startTotp()).secret).toBeString()
    }
  )

  /** Replace the environment's `sms` settings through the admin API, as an operator does. */
  async function setSms(s: Server, sms: EnvironmentSettings['sms']): Promise<void> {
    const read = await s.admin('GET', '/v1/admin/settings')
    const { settings } = (await read.json()) as { settings: EnvironmentSettings }
    const replaced = await s.admin(
      'PUT',
      '/v1/admin/settings',
      { ...settings, sms },
      { 'if-match': read.headers.get('etag') ?? '' }
    )
    expect(replaced.status).toBe(200)
  }

  /** The code in the newest text message to a number, read from the memory sender. */
  function textedCode(s: Server, to: string): string {
    const code = smsCodeIn(s.deps.sms.messages(to).at(-1)?.text ?? '')
    if (!code) {
      throw new Error('no text message with a code was sent to that number')
    }
    return code
  }

  journey(
    'phone number on an account',
    'a signed-in user adds a phone number with a texted code, and removes it; every refusal is a code the app can show',
    async () => {
      const s = await server()
      const NUMBER = '+12025550142'
      const { tula } = await signUp(s)
      const other = await signUp(s)

      // Off by default: the config says so, and asking is refused.
      expect((await tula.config.get()).phone).toEqual({ enabled: false })
      expect((await caught(tula.user.phone.request({ phoneNumber: NUMBER }))).code).toBe(
        'sms.disabled'
      )
      // On with no country allowed is still off.
      await setSms(s, { enabled: true, allowedCountries: [], dailyMessageLimit: 500 })
      expect((await caught(tula.user.phone.request({ phoneNumber: NUMBER }))).code).toBe(
        'sms.disabled'
      )
      expect(s.deps.sms.outbox).toHaveLength(0)

      await setSms(s, { enabled: true, allowedCountries: ['US'], dailyMessageLimit: 500 })
      // A client made after the change reads the config as it is now, and not which countries.
      const config = await s.client('server').tula.config.get()
      expect(config.phone).toEqual({ enabled: true })
      expect(JSON.stringify(config)).not.toContain('allowedCountries')

      expect((await caught(tula.user.phone.request({ phoneNumber: '555-0142' }))).code).toBe(
        'phone.invalid'
      )
      expect((await caught(tula.user.phone.request({ phoneNumber: '+4915112345678' }))).code).toBe(
        'sms.country_not_allowed'
      )
      expect(s.deps.sms.outbox).toHaveLength(0)

      // The number as a person types it; the receipt holds neither the number nor the code.
      const sent = await tula.user.phone.request({ phoneNumber: '+1 (202) 555-0142' })
      expect(sent.destination).toBe('***42')
      expect(new Date(sent.expiresAt).getTime()).toBeGreaterThan(s.deps.clock.now().getTime())
      const code = textedCode(s, NUMBER)
      expect(JSON.stringify(sent)).not.toContain(code)
      expect((await caught(tula.user.phone.request({ phoneNumber: NUMBER }))).code).toBe(
        'rate_limited'
      )
      // Pending is not the account's: nothing has changed yet.
      expect((await tula.user.get()).phoneNumber).toBeNull()

      // Another user's code, a wrong one, the right one, and the right one again.
      expect((await caught(other.tula.user.phone.verify({ code }))).code).toBe(
        'verification.expired'
      )
      const wrong = `${code.slice(0, -1)}${(Number(code.at(-1)) + 1) % 10}`
      expect((await caught(tula.user.phone.verify({ code: wrong }))).code).toBe(
        'verification.invalid_code'
      )
      const user = await tula.user.phone.verify({ code })
      expect(user.phoneNumber).toBe(NUMBER)
      expect(user.phoneNumberVerifiedAt).toBeString()
      // The state shows it without another request.
      expect(tula.state).toMatchObject({ status: 'signed-in', user: { phoneNumber: NUMBER } })
      expect((await caught(tula.user.phone.verify({ code }))).code).toBe('verification.expired')
      expect((await other.tula.user.get()).phoneNumber).toBeNull()

      // A code asked for before the country was removed, or SMS switched off, is not
      // honoured after.
      await other.tula.user.phone.request({ phoneNumber: '+12025550143' })
      const pending = textedCode(s, '+12025550143')
      await setSms(s, { enabled: true, allowedCountries: ['DE'], dailyMessageLimit: 500 })
      expect((await caught(other.tula.user.phone.verify({ code: pending }))).code).toBe(
        'sms.country_not_allowed'
      )
      await setSms(s, { enabled: false, allowedCountries: ['DE'], dailyMessageLimit: 500 })
      expect((await caught(other.tula.user.phone.verify({ code: pending }))).code).toBe(
        'sms.disabled'
      )
      expect((await other.tula.user.get()).phoneNumber).toBeNull()

      // Removing needs no text message, so it works with SMS off, and twice.
      await tula.user.phone.remove()
      expect(tula.state).toMatchObject({ status: 'signed-in', user: { phoneNumber: null } })
      expect((await tula.user.get()).phoneNumber).toBeNull()
      await tula.user.phone.remove()

      // No request of the client carried the number anywhere but the body that asked for it.
      const carrying = s.exchanges.filter(
        (exchange) =>
          exchange.requestBody.includes('5550142') ||
          [...exchange.headers.values()].some((value) => value.includes('5550142'))
      )
      expect(carrying.length).toBeGreaterThan(0)
      expect([
        ...new Set(carrying.map((exchange) => `${exchange.method} ${exchange.path}`)),
      ]).toEqual(['POST /v1/client/me/phone'])
    }
  )

  journey(
    'phone number on an account',
    'a phone number change past the step-up window asks for a step-up, and works after it',
    async () => {
      const s = await server()
      await setSms(s, { enabled: true, allowedCountries: ['US'], dailyMessageLimit: 500 })
      const { tula } = await signUp(s)
      s.advance(11 * 60_000)
      const error = await caught(tula.user.phone.request({ phoneNumber: '+12025550142' }))
      expect(isStepUpRequired(error)).toBe(true)
      expect(stepUpMethods(error)).toContain('password')
      expect(s.deps.sms.outbox).toHaveLength(0)
      expect(isStepUpRequired(await caught(tula.user.phone.remove()))).toBe(true)
      await tula.session.stepUp({ method: 'password', password: PASSWORD })
      expect((await tula.user.phone.request({ phoneNumber: '+12025550142' })).destination).toBe(
        '***42'
      )
    }
  )

  journey(
    'text messages to a blocked destination',
    'a number outside the country list is a code the app can show, however often it is asked, and costs the user nothing',
    async () => {
      const s = await server()
      await setSms(s, { enabled: true, allowedCountries: ['US'], dailyMessageLimit: 500 })
      const { tula } = await signUp(s)
      for (const phoneNumber of [
        '+37120000042',
        '+37120000042',
        '+371 2000 0043',
        '+99912345678',
      ]) {
        const error = await caught(tula.user.phone.request({ phoneNumber }))
        expect(error.code).toBe('sms.country_not_allowed')
        expect(error.status).toBe(422)
      }
      expect(s.deps.sms.outbox).toHaveLength(0)
      // Nothing of the user's own allowance was spent by the refusals.
      expect((await tula.user.phone.request({ phoneNumber: '+12025550142' })).destination).toBe(
        '***42'
      )
      expect(s.deps.sms.outbox.map((message) => message.to)).toEqual(['+12025550142'])
      const user = await tula.user.phone.verify({ code: textedCode(s, '+12025550142') })
      expect(user.phoneNumber).toBe('+12025550142')
    }
  )

  journey(
    'text messages past the daily limit',
    'past the environment’s daily limit a request is rate limited, with a wait that ends with the day',
    async () => {
      const s = await server()
      await setSms(s, { enabled: true, allowedCountries: ['US', 'GB'], dailyMessageLimit: 500 })
      const { tula } = await signUp(s)
      const other = await signUp(s)
      await tula.user.phone.request({ phoneNumber: '+12025550142' })
      const code = textedCode(s, '+12025550142')
      // The day is spent from here on. An hour later the hourly limits are open again, so
      // what refuses is the day's own count.
      await setSms(s, { enabled: true, allowedCountries: ['US', 'GB'], dailyMessageLimit: 1 })
      s.advance(61 * 60_000)
      await other.tula.session.stepUp({ method: 'password', password: PASSWORD })
      const now = s.deps.clock.now().getTime()
      const error = await caught(other.tula.user.phone.request({ phoneNumber: '+447700900142' }))
      expect(error.code).toBe('rate_limited')
      expect(error.status).toBe(429)
      // The wait ends with the UTC day, and the answer names no limit.
      expect(error.retryAfterMs).toBe(Math.ceil((86_400_000 - (now % 86_400_000)) / 1000) * 1000)
      expect(Object.keys(error.params)).toEqual(['retryAfter'])
      expect(s.deps.sms.messages('+447700900142')).toEqual([])
      expect(s.deps.sms.outbox).toHaveLength(1)
      expect((await other.tula.user.get()).phoneNumber).toBeNull()
      // The client is told only whether a number can be added.
      expect((await s.client('server').tula.config.get()).phone).toEqual({ enabled: true })
      // A code is good for ten minutes: the one from before the limit was spent an hour ago
      // has expired, and a new one cannot be had today.
      await tula.session.stepUp({ method: 'password', password: PASSWORD })
      expect((await caught(tula.user.phone.verify({ code }))).code).toBe('verification.expired')
      expect((await caught(tula.user.phone.request({ phoneNumber: '+12025550142' }))).code).toBe(
        'rate_limited'
      )
      expect(s.deps.sms.outbox).toHaveLength(1)
    }
  )

  journey(
    'email wording',
    'email wording: a sign-up completes with the code from an email in the environment’s own words, whose subject does not lead with it',
    async () => {
      const s = await server()
      const saved = await s.admin(
        'PUT',
        '/v1/admin/settings',
        {
          emails: {
            templates: {
              email_verification: {
                subject: 'Welcome to {{appName}}: your code is inside',
                body: 'Welcome aboard.\n\nYour code: {{code}}\n\nGood for {{expiresInMinutes}} minutes.',
              },
            },
          },
        },
        { 'if-match': '"0"' }
      )
      expect(saved.status).toBe(200)
      const { tula } = s.client('server')
      const email = freshEmail()
      const flow = await tula.signUp.start({ email, password: PASSWORD })
      expect(flow.step).toMatchObject({ status: 'needs_email_verification' })

      // Nothing of the product reads a subject: only this file's own `s.code` does, and it
      // finds no code in this one.
      const sent = s.deps.mailer.outbox.findLast((message) => message.to === email)
      expect(sent?.subject).toBe('Welcome to Tula: your code is inside')
      expect(() => s.code(email)).toThrow('no email with a code was sent')
      const code = /^Your code: (\d{6})$/m.exec(sent?.text ?? '')?.[1]
      expect(sent?.text).toStartWith(
        `Welcome aboard.\n\nYour code: ${code}\n\nGood for 10 minutes.`
      )

      expect((await flow.verifyEmail({ code: code as string })).status).toBe('complete')
      expect(tula.state).toMatchObject({ status: 'signed-in', user: { email } })
    }
  )

  /** Switch the texted sign-in code on or off, with the given `sms` settings. */
  async function setSmsSignIn(
    s: Server,
    smsCode: boolean,
    sms: EnvironmentSettings['sms'] = SMS_ON
  ): Promise<void> {
    const read = await s.admin('GET', '/v1/admin/settings')
    const { settings } = (await read.json()) as { settings: EnvironmentSettings }
    const methods = { ...settings.signIn.methods, smsCode: { enabled: smsCode } }
    const replaced = await s.admin(
      'PUT',
      '/v1/admin/settings',
      { ...settings, signIn: { ...settings.signIn, methods }, sms },
      { 'if-match': read.headers.get('etag') ?? '' }
    )
    expect(replaced.status).toBe(200)
  }

  const SMS_ON: EnvironmentSettings['sms'] = {
    enabled: true,
    allowedCountries: ['US'],
    dailyMessageLimit: 500,
  }

  /** A user with a proven phone number, a minute after its code was texted. */
  async function withNumber(s: Server, number: string) {
    const account = await signUp(s)
    await account.tula.user.phone.request({ phoneNumber: number })
    await account.tula.user.phone.verify({ code: textedCode(s, number) })
    // A number is texted at most once a minute, whoever asks.
    s.advance(61_000)
    return account
  }

  const SMS_CHOICE: FlowStep = {
    status: 'needs_first_factor',
    strategies: ['password', 'sms_code'],
  }

  journey(
    'sign in with a texted code',
    'a sign-in started with a phone number is proven with the texted code; the session says `sms`, and is not a recent authentication',
    async () => {
      const s = await server()
      const NUMBER = '+12025550143'
      await setSmsSignIn(s, true)
      expect((await s.client('server').tula.config.get()).signIn.methods).toContain('smsCode')
      const owner = await withNumber(s, NUMBER)
      const ownerId = (await owner.tula.user.get()).id

      const { tula } = s.client('server')
      // The number as a person types it.
      const flow = await tula.signIn.start({ identifier: '+1 (202) 555-0143' })
      expect(flow.step).toEqual(SMS_CHOICE)
      const before = s.deps.sms.outbox.length
      const prepared = await flow.prepareFirstFactor({ strategy: 'sms_code' })
      expect(prepared).toEqual({
        ...SMS_CHOICE,
        prepared: { strategy: 'sms_code', destination: '***43' },
      })
      // The message is sent apart from the answer, so that its sending says nothing.
      await Sms.settled()
      expect(s.deps.sms.outbox).toHaveLength(before + 1)
      const code = textedCode(s, NUMBER)
      expect(JSON.stringify(prepared)).not.toContain(code)
      expect(await caught(flow.prepareFirstFactor({ strategy: 'sms_code' }))).toMatchObject({
        code: 'rate_limited',
        status: 429,
      })

      const wrong = `${code.slice(0, -1)}${(Number(code.at(-1)) + 1) % 10}`
      const refused = await caught(flow.attemptFirstFactor({ strategy: 'sms_code', code: wrong }))
      expect(refused).toMatchObject({ code: 'auth.invalid_credentials', status: 401 })
      expect(Object.keys(refused.params)).toEqual([])
      expect(tula.state.status).not.toBe('signed-in')

      const step = await flow.attemptFirstFactor({ strategy: 'sms_code', code })
      expect(step).toMatchObject({ status: 'complete', userId: ownerId })
      expect(tula.state.status).toBe('signed-in')
      expect(decodeJwt((await tula.session.getToken()) ?? '').amr).toEqual(['sms'])

      // A phone number alone is not a recent authentication, and no way to step up.
      const stepUp = await caught(tula.user.phone.remove())
      expect(stepUp.code).toBe('auth.step_up_required')
      expect(stepUp.params.methods).toBe('password,email_code')
      expect((await tula.user.get()).phoneNumber).toBe(NUMBER)
    }
  )

  journey(
    'a texted sign-in code for an unknown number',
    'asking for a texted code answers the same for a number nobody holds, and sends nothing; every guess is the generic failure',
    async () => {
      const s = await server()
      await setSmsSignIn(s, true, { ...SMS_ON, allowedCountries: ['US', 'FR'] })

      const { tula } = s.client('server')
      const flow = await tula.signIn.start({ identifier: '+33639980142' })
      expect(flow.step).toEqual(SMS_CHOICE)
      expect(await flow.prepareFirstFactor({ strategy: 'sms_code' })).toEqual({
        ...SMS_CHOICE,
        prepared: { strategy: 'sms_code', destination: '***42' },
      })
      expect((await caught(flow.prepareFirstFactor({ strategy: 'sms_code' }))).code).toBe(
        'rate_limited'
      )
      await Sms.settled()
      expect(s.deps.sms.outbox).toHaveLength(0)
      const usage = await s.admin('GET', '/v1/admin/sms/usage?days=1')
      expect(await usage.text()).not.toContain('+33')
      for (const guess of ['000000', '123456']) {
        const refused = await caught(flow.attemptFirstFactor({ strategy: 'sms_code', code: guess }))
        expect(refused).toMatchObject({ code: 'auth.invalid_credentials', status: 401 })
      }

      // An address that asks for a texted code is an unknown number.
      const byEmail = await s.client('server').tula.signIn.start({ identifier: freshEmail() })
      expect(await byEmail.prepareFirstFactor({ strategy: 'sms_code' })).toMatchObject({
        prepared: { strategy: 'sms_code', destination: '***' },
      })
      expect(
        (await caught(byEmail.attemptFirstFactor({ strategy: 'sms_code', code: '000000' }))).code
      ).toBe('auth.invalid_credentials')

      // A country that is not on the list is refused, whoever holds the number.
      const abroad = await s.client('server').tula.signIn.start({ identifier: '+4915112345678' })
      expect((await caught(abroad.prepareFirstFactor({ strategy: 'sms_code' }))).code).toBe(
        'sms.country_not_allowed'
      )
      await Sms.settled()
      expect(s.deps.sms.outbox).toHaveLength(0)
      expect(tula.state.status).not.toBe('signed-in')
    }
  )

  journey(
    'a texted sign-in code after the method is switched off',
    'a code texted while the method was on is refused once the method, text messages or the country is off, and works again when they are back',
    async () => {
      const s = await server()
      const NUMBER = '+12025550144'
      await setSmsSignIn(s, true)
      await withNumber(s, NUMBER)

      const { tula } = s.client('server')
      const flow = await tula.signIn.start({ identifier: NUMBER })
      await flow.prepareFirstFactor({ strategy: 'sms_code' })
      await Sms.settled()
      const code = textedCode(s, NUMBER)
      const sent = s.deps.sms.outbox.length
      const attempt = () => caught(flow.attemptFirstFactor({ strategy: 'sms_code', code }))

      await setSmsSignIn(s, false)
      expect(await attempt()).toMatchObject({ code: 'auth.method_disabled', status: 403 })
      expect((await caught(flow.prepareFirstFactor({ strategy: 'sms_code' }))).code).toBe(
        'auth.method_disabled'
      )
      const later = await s.client('server').tula.signIn.start({ identifier: NUMBER })
      // With the password the only method left, the step is the password's own.
      expect(later.step).toEqual({ status: 'needs_password' })

      await setSmsSignIn(s, true, { ...SMS_ON, enabled: false })
      expect((await attempt()).code).toBe('sms.disabled')
      await setSmsSignIn(s, true, { ...SMS_ON, allowedCountries: ['DE'] })
      expect((await attempt()).code).toBe('sms.country_not_allowed')
      await Sms.settled()
      expect(s.deps.sms.outbox).toHaveLength(sent)
      expect(tula.state.status).not.toBe('signed-in')

      // Nothing was used up by the refusals.
      await setSmsSignIn(s, true)
      const step = await flow.attemptFirstFactor({ strategy: 'sms_code', code })
      expect(step.status).toBe('complete')
      expect(decodeJwt((await tula.session.getToken()) ?? '').amr).toEqual(['sms'])
    }
  )
})

describe('conformance scenarios and the SDK', () => {
  test('every scenario is covered by an SDK journey or listed as server-only with a reason', async () => {
    const names = (await loadScenarios()).map(({ scenario }) => scenario.name)
    expect(names.length).toBeGreaterThanOrEqual(16)
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

  test('a journey a server-only reason points to exists', () => {
    // A reason may say where the client's side of the scenario is covered, by quoting the
    // scenario a journey covers (or the journey's own title) in double quotes. A quoted name
    // that no journey has would send a reader to a test that is not there.
    const titles = new Set([...covered.values()].flat())
    for (const [name, reason] of Object.entries(SERVER_ONLY)) {
      for (const [, quoted] of reason.matchAll(/"([^"]+)"/g)) {
        if (!covered.has(quoted as string) && !titles.has(quoted as string)) {
          throw new Error(
            `the server-only reason of "${name}" names a journey "${quoted}" that does not exist`
          )
        }
      }
    }
  })
})
