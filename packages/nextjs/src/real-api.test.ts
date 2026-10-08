import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { createTulaClient, isTulaError, type TulaClient } from '@tula/core'
import { NextRequest } from 'next/server'
import { FixedClock } from '../../../apps/api/src/adapters/memory/clock'
import { createApp } from '../../../apps/api/src/index'
import {
  createTestDeps,
  seedApiKey,
  TEST_CONFIG,
  TEST_TENANT,
  type TestDeps,
} from '../../../apps/api/src/testing'
import { DEFAULT_ENVIRONMENT_SETTINGS, EnvironmentSettingsSchema } from '../../contract/src/index'
import type { TulaServerOptions } from './config'
import { createTulaHandlers } from './handlers'
import { authenticate, fetchCurrentUser } from './helpers'
import { tulaMiddleware } from './middleware'

// The package against the REAL API, in process: `createApp` on memory adapters, `@tula/core`
// as the browser's client, a cookie jar standing in for the browser. What the unit tests take
// from a fake (the API's answers, its cookies, its keys) comes from the server itself here.

const PUBLISHABLE_KEY = 'tula_pk_dev_nextjs00000000000000000000000000'
const SECRET_KEY = 'tula_sk_dev_nextjs00000000000000000000000000'
const PASSWORD = 'sturdy-Otter-plays-42-chess'
const APP = 'http://localhost:3000'
const CODE_SUBJECT = /^(\d{6})\b/

afterEach(() => {
  setSystemTime()
})

interface World {
  deps: TestDeps
  /** Server options for one Next.js instance; each call is a separate instance. */
  instance(extra?: TulaServerOptions): TulaServerOptions
  /** A browser: a cookie jar, a `@tula/core` client talking to the route handler. */
  browser(): Browser
  advance(ms: number): void
  code(email: string): string
  admin(method: string, path: string): Promise<Response>
  apiCalls: string[]
}

interface Browser {
  jar: Map<string, string>
  tula: TulaClient
  /** Open a page: run the middleware as Next.js would, applying the cookies it sets. */
  visit(path: string, options?: TulaServerOptions): Promise<Response>
  cookieHeader(): string
}

async function world(prepare?: (deps: TestDeps) => Partial<TestDeps> | undefined): Promise<World> {
  // Tokens are verified against this process's clock, so the server's starts at "now".
  let deps = createTestDeps({ clock: new FixedClock(new Date()) })
  deps = { ...deps, ...prepare?.(deps) }
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  await seedApiKey(deps, PUBLISHABLE_KEY)
  await seedApiKey(deps, SECRET_KEY)
  const app = createApp(deps)
  const apiCalls: string[] = []

  const instance = (extra: TulaServerOptions = {}): TulaServerOptions => ({
    apiUrl: TEST_CONFIG.publicUrl,
    publishableKey: PUBLISHABLE_KEY,
    environmentId: TEST_TENANT.environmentId,
    // A function of its own: everything cached per `fetch` is per instance.
    fetch: async (request) => {
      apiCalls.push(`${request.method} ${new URL(request.url).pathname}`)
      return app.request(request)
    },
    ...extra,
  })
  const shared = instance({ secretKey: SECRET_KEY })
  const handlers = createTulaHandlers(shared)

  function apply(jar: Map<string, string>, response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const [pair = ''] = line.split(';')
      const at = pair.indexOf('=')
      const name = pair.slice(0, at)
      const value = pair.slice(at + 1)
      // What a browser checks: these cookies are for the whole origin and unreadable by script.
      expect(line).toContain('Path=/;')
      expect(line).toContain('HttpOnly')
      expect(line).toContain('SameSite=Lax')
      expect(line).not.toMatch(/Domain=/i)
      if (value === '' || /Max-Age=0/.test(line)) {
        jar.delete(name)
      } else {
        jar.set(name, value)
      }
    }
  }

  return {
    deps,
    instance,
    apiCalls,
    advance(ms) {
      deps.clock.advance(ms)
      setSystemTime(new Date(Date.now() + ms))
    },
    code(email) {
      const message = deps.mailer.outbox.findLast(
        (sent) => sent.to === email && CODE_SUBJECT.test(sent.subject)
      )
      const code = CODE_SUBJECT.exec(message?.subject ?? '')?.[1]
      if (!code) {
        throw new Error(`no email with a code was sent to ${email}`)
      }
      return code
    },
    admin: async (method, path) =>
      app.request(path, { method, headers: { authorization: `Bearer ${SECRET_KEY}` } }),
    browser() {
      const jar = new Map<string, string>()
      const cookieHeader = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
      const tula = createTulaClient({
        publishableKey: PUBLISHABLE_KEY,
        baseUrl: `${APP}/api/tula`,
        client: 'web',
        fetch: async (request) => {
          const headers = new Headers(request.headers)
          headers.set('origin', APP)
          if (jar.size > 0) {
            headers.set('cookie', cookieHeader())
          }
          const method = request.method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
          const response = await handlers[method](new Request(request, { headers }))
          apply(jar, response)
          return response
        },
      })
      return {
        jar,
        tula,
        cookieHeader,
        async visit(path, options = shared) {
          const response = await tulaMiddleware({ ...options, publicRoutes: ['/'] })(
            new NextRequest(`${APP}${path}`, {
              headers: jar.size > 0 ? { cookie: cookieHeader() } : {},
            })
          )
          apply(jar, response)
          return response
        },
      }
    },
  }
}

let addresses = 0
async function signUp(w: World, browser = w.browser()) {
  addresses += 1
  const email = `next-user-${addresses}@example.com`
  const flow = await browser.tula.signUp.start({ email, password: PASSWORD, firstName: 'Maya' })
  await flow.verifyEmail({ code: w.code(email) })
  return { browser, email }
}

/** The request the rest of Next.js sees after the middleware let it through. */
function passedOn(response: Response): Request {
  const headers = new Headers()
  for (const name of (response.headers.get('x-middleware-override-headers') ?? '').split(',')) {
    const value = response.headers.get(`x-middleware-request-${name}`)
    if (name && value !== null) {
      headers.set(name, value)
    }
  }
  return new Request(`${APP}/x`, { headers })
}

const isNext = (response: Response) => response.headers.get('x-middleware-next') === '1'

describe('a hybrid session behind the route handler', () => {
  test('signing up sets first-party cookies the server side can verify offline', async () => {
    const w = await world()
    const { browser, email } = await signUp(w)
    expect([...browser.jar.keys()].sort()).toEqual(['tula_at', 'tula_rt'])
    expect(browser.tula.state.status).toBe('signed-in')

    w.apiCalls.length = 0
    const response = await browser.visit('/dashboard')
    expect(isNext(response)).toBe(true)
    // Keys only: no call that looks anything up.
    expect(w.apiCalls.filter((call) => !call.endsWith('/jwks.json'))).toEqual([])

    const auth = await authenticate(passedOn(response), w.instance())
    expect(auth.isSignedIn).toBe(true)
    const state = browser.tula.state
    expect(auth.sessionId).toBe(state.status === 'signed-in' ? state.sessionId : '')
    const user = await fetchCurrentUser(passedOn(response), w.instance())
    expect(user?.email).toBe(email)
    expect(user?.id).toBe(auth.userId as string)
  })

  test('an expired access token is refreshed by the middleware, and the cookies rotate', async () => {
    const w = await world()
    const { browser } = await signUp(w)
    const before = new Map(browser.jar)
    w.advance(70_000)
    expect(
      (
        await authenticate(
          new Request(`${APP}/x`, { headers: { cookie: browser.cookieHeader() } }),
          w.instance()
        )
      ).isSignedIn
    ).toBe(false)

    const response = await browser.visit('/dashboard')
    expect(isNext(response)).toBe(true)
    expect(browser.jar.get('tula_rt')).not.toBe(before.get('tula_rt'))
    expect(browser.jar.get('tula_at')).not.toBe(before.get('tula_at'))
    expect((await authenticate(passedOn(response), w.instance())).isSignedIn).toBe(true)
    // The browser's own client carries on with the rotated cookie.
    expect(await browser.tula.session.refresh()).toBeDefined()
    expect(browser.tula.state.status).toBe('signed-in')
  })

  test('two instances refreshing at once with one refresh token both succeed: no reuse is detected', async () => {
    const w = await world()
    const { browser } = await signUp(w)
    w.advance(70_000)
    const cookie = browser.cookieHeader()
    const visit = (options: TulaServerOptions) =>
      tulaMiddleware({ ...options, publicRoutes: ['/'] })(
        new NextRequest(`${APP}/dashboard`, { headers: { cookie } })
      )
    w.apiCalls.length = 0
    // Separate instances share nothing in memory: each makes its own call to the API.
    const [first, second] = await Promise.all([visit(w.instance()), visit(w.instance())])
    expect(w.apiCalls.filter((call) => call === 'POST /v1/client/sessions/refresh')).toHaveLength(2)
    expect(isNext(first)).toBe(true)
    expect(isNext(second)).toBe(true)

    const rotated = (response: Response) =>
      response.headers
        .getSetCookie()
        .find((line) => line.startsWith('tula_rt='))
        ?.split(';')[0]
    // The grace window hands both the same next token, so whichever response the browser
    // applies last, its cookie is the live one.
    expect(rotated(first)).toBeDefined()
    expect(rotated(first)).toBe(rotated(second) as string)

    const next = new Map([['tula_rt', (rotated(first) as string).slice('tula_rt='.length)]])
    w.advance(70_000)
    const later = await tulaMiddleware({ ...w.instance(), publicRoutes: ['/'] })(
      new NextRequest(`${APP}/dashboard`, { headers: { cookie: `tula_rt=${next.get('tula_rt')}` } })
    )
    expect(isNext(later)).toBe(true)
  })

  test('the bound: a request still carrying the old cookie after the grace window ends the session', async () => {
    const w = await world()
    const { browser } = await signUp(w)
    w.advance(70_000)
    const stale = browser.cookieHeader()
    expect(isNext(await browser.visit('/dashboard'))).toBe(true)

    // Past the default 10-second reuse grace period.
    w.advance(11_000)
    const late = await tulaMiddleware({ ...w.instance(), publicRoutes: ['/'] })(
      new NextRequest(`${APP}/dashboard`, { headers: { cookie: stale } })
    )
    expect(late.status).toBe(307)
    expect(late.headers.getSetCookie().some((line) => line.startsWith('tula_rt=; '))).toBe(true)

    // Reuse revoked the whole family: the browser's newer cookie is refused at its next refresh.
    w.advance(70_000)
    expect((await browser.visit('/dashboard')).status).toBe(307)
    expect(browser.jar.size).toBe(0)
  })

  test('a session revoked by an admin is signed out at the next refresh, and its cookies go', async () => {
    const w = await world()
    const { browser } = await signUp(w)
    const auth = await authenticate(
      new Request(`${APP}/x`, { headers: { cookie: browser.cookieHeader() } }),
      w.instance()
    )
    const revoked = await w.admin('DELETE', `/v1/admin/users/${auth.userId}/sessions`)
    expect(revoked.status).toBeLessThan(300)

    // Offline verification cannot see the revocation: the token works until it expires.
    expect(isNext(await browser.visit('/dashboard'))).toBe(true)
    // The API can: `currentUser()` asks it.
    expect(
      await fetchCurrentUser(
        new Request(`${APP}/x`, { headers: { cookie: browser.cookieHeader() } }),
        w.instance()
      )
    ).toBeNull()

    w.advance(70_000)
    const response = await browser.visit('/dashboard')
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(`${APP}/sign-in?redirect_url=%2Fdashboard`)
    expect(browser.jar.size).toBe(0)
  })

  test('a banned user is signed out at the next refresh, and the cookies go', async () => {
    const w = await world()
    const { browser } = await signUp(w)
    const auth = await authenticate(
      new Request(`${APP}/x`, { headers: { cookie: browser.cookieHeader() } }),
      w.instance()
    )
    expect((await w.admin('POST', `/v1/admin/users/${auth.userId}/ban`)).status).toBeLessThan(300)
    // Unbanned again: the refresh below must be refused for the ban, not for a revoked session.
    w.advance(70_000)
    const response = await browser.visit('/dashboard')
    expect(response.status).toBe(307)
    expect(browser.jar.size).toBe(0)
  })

  test('a refresh the API refuses for the app’s origin signs nobody out: the cookies stay', async () => {
    const w = await world()
    const { browser } = await signUp(w)
    const before = new Map(browser.jar)
    w.advance(70_000)

    // The same API, but outside the `local` tier: a loopback origin is no longer allowed, as
    // for an app whose origin the environment does not list (or whose TULA_APP_URL is wrong).
    const strict = createApp({ ...w.deps, config: { ...w.deps.config, tier: 'prod' } })
    const warnings: string[] = []
    const misconfigured = w.instance({
      fetch: async (request) => strict.request(request),
      onWarning: (message) => warnings.push(message),
    })
    const response = await browser.visit('/dashboard', misconfigured)
    expect(response.status).toBe(307)
    expect(response.headers.getSetCookie()).toEqual([])
    expect(new Map(browser.jar)).toEqual(before)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(APP)
    expect(warnings[0]).not.toContain(before.get('tula_rt') as string)

    // Once the configuration is right again, the very same cookies still work.
    expect(isNext(await browser.visit('/dashboard'))).toBe(true)
  })

  test('a refresh refused for a wrong publishable key signs nobody out: the cookies stay', async () => {
    const w = await world()
    const { browser } = await signUp(w)
    const before = new Map(browser.jar)
    w.advance(70_000)
    const warnings: string[] = []
    const response = await browser.visit(
      '/dashboard',
      w.instance({
        publishableKey: 'tula_pk_dev_not_this_environments_key_000000',
        onWarning: (message) => warnings.push(message),
      })
    )
    expect(response.status).toBe(307)
    expect(new Map(browser.jar)).toEqual(before)
    expect(warnings).toHaveLength(1)
    expect(isNext(await browser.visit('/dashboard'))).toBe(true)
  })

  test('signing out through the handler leaves no cookie behind', async () => {
    const w = await world()
    const { browser } = await signUp(w)
    await browser.tula.session.signOut()
    expect(browser.jar.size).toBe(0)
    expect((await browser.visit('/dashboard')).status).toBe(307)
  })

  test('the API’s own origin rule still decides: the browser’s Origin reaches it unchanged', async () => {
    // Outside the `local` tier a loopback origin is not allowed unless the environment lists it.
    const w = await world((deps) => ({ config: { ...deps.config, tier: 'prod' } }))
    const browser = w.browser()
    const error = await browser.tula.signIn.start({ identifier: 'someone@example.com' }).then(
      () => null,
      (thrown: unknown) => thrown
    )
    expect(isTulaError(error) && error.code).toBe('request.origin_not_allowed')
    expect(w.apiCalls).toContain('POST /v1/client/sign-ins')
  })
})

describe('a stateful session behind the route handler', () => {
  async function statefulWorld(): Promise<World> {
    const w = await world()
    w.deps.environmentSettings.seed(TEST_TENANT.environmentId, {
      revision: 1,
      settings: EnvironmentSettingsSchema.parse({
        ...DEFAULT_ENVIRONMENT_SETTINGS,
        sessions: { profiles: { web: { type: 'stateful' } } },
      }),
    })
    return w
  }

  test('the session cookie is first-party, and with a secret key the server side knows the user', async () => {
    const w = await statefulWorld()
    const { browser, email } = await signUp(w)
    expect([...browser.jar.keys()]).toEqual(['tula_session'])
    expect(await browser.tula.session.getToken()).toBeNull()

    w.apiCalls.length = 0
    const response = await browser.visit('/dashboard')
    expect(isNext(response)).toBe(true)
    expect(w.apiCalls).toEqual(['POST /v1/admin/sessions/verify'])

    const request = passedOn(response)
    const options = w.instance({ secretKey: SECRET_KEY })
    const auth = await authenticate(request, options)
    expect(auth.isSignedIn).toBe(true)
    expect(await auth.getToken()).toBeNull()
    // The middleware's sealed claims were enough: the API was not asked again.
    expect(w.apiCalls).toEqual(['POST /v1/admin/sessions/verify'])
    expect((await fetchCurrentUser(request, options))?.email).toBe(email)
  })

  test('without a secret key the server side treats it as signed out and keeps the cookie', async () => {
    const w = await statefulWorld()
    const { browser } = await signUp(w)
    const response = await browser.visit('/dashboard', w.instance())
    expect(response.status).toBe(307)
    expect([...browser.jar.keys()]).toEqual(['tula_session'])
  })

  test('signing in as someone else on a stateful profile: the server sees the new user, not the old token', async () => {
    // User A on the default (hybrid) profile: access and refresh cookies.
    const w = await world()
    const first = await signUp(w)
    const { browser } = first
    expect([...browser.jar.keys()].sort()).toEqual(['tula_at', 'tula_rt'])

    // The environment moves to a stateful profile, and B signs in from the same browser.
    w.deps.environmentSettings.seed(TEST_TENANT.environmentId, {
      revision: 2,
      settings: EnvironmentSettingsSchema.parse({
        ...DEFAULT_ENVIRONMENT_SETTINGS,
        sessions: { profiles: { web: { type: 'stateful' } } },
      }),
    })
    // Past every settings cache, and still inside A's access token.
    w.advance(31_000)
    const second = await signUp(w, browser)
    expect(second.email).not.toBe(first.email)
    expect([...browser.jar.keys()]).toEqual(['tula_session'])

    const options = w.instance({ secretKey: SECRET_KEY })
    const response = await browser.visit('/dashboard')
    expect(isNext(response)).toBe(true)
    // The middleware's view and the helper's, with and without the middleware's header.
    expect((await fetchCurrentUser(passedOn(response), options))?.email).toBe(second.email)
    const direct = new Request(`${APP}/x`, { headers: { cookie: browser.cookieHeader() } })
    expect((await fetchCurrentUser(direct, options))?.email).toBe(second.email)
    const auth = await authenticate(direct, options)
    expect(auth.isSignedIn).toBe(true)
    expect(await auth.getToken()).toBeNull()
  })

  test('sign-out ends it on the API and clears the cookie', async () => {
    const w = await statefulWorld()
    const { browser } = await signUp(w)
    const cookie = browser.cookieHeader()
    await browser.tula.session.signOut()
    expect(browser.jar.size).toBe(0)
    const replay = await tulaMiddleware({
      ...w.instance({ secretKey: SECRET_KEY }),
      publicRoutes: ['/'],
    })(new NextRequest(`${APP}/dashboard`, { headers: { cookie } }))
    expect(replay.status).toBe(307)
  })
})
