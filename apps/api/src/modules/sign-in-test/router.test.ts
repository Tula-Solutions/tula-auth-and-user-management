import { afterAll, afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from 'bun:test'
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  type EnvironmentSettings,
  HOOK_MAX_DEADLINE_MS,
  isTestAddress,
  SIGN_IN_TEST_STEPS,
  type SignInTestReport,
  SignInTestReportSchema,
} from '@tula/contract'
import { cacheEnvironmentSettings } from '~/adapters/cache/environment-settings'
import type { Tenant } from '~/dependencies'
import { ServiceUnavailableError } from '~/exceptions'
import { createApp } from '~/index'
import * as logger from '~/lib/logger'
import * as Flows from '~/modules/flow/service'
import * as Hooks from '~/modules/hook/service'
import * as Notices from '~/modules/notice/service'
import * as Retention from '~/modules/retention/service'
import * as Settings from '~/modules/settings/service'
import * as SignInTests from '~/modules/sign-in-test/service'
import {
  createInstanceTestDeps,
  dashboardHeaders,
  dashboardSignIn,
  seedApiKey,
  TEST_ACTOR,
  TEST_ADMIN_TOKEN,
  TEST_TENANT,
  type TestDeps,
} from '~/testing'

// The route that runs a sign-in test (ADR 0058): who may call it, where it is allowed, what
// it leaves behind when a step fails, and what never leaves the server.

const SK = 'tula_sk_dev_admin000000000000000000000000000000'
const AK = 'tula_ak_dev_agent000000000000000000000000000000'
const SECOND_AK = 'tula_ak_dev_second00000000000000000000000000000'
const PROD_AK = 'tula_ak_prod_agent00000000000000000000000000000'
const PK = 'tula_pk_dev_publishable0000000000000000000'
const PATH = '/v1/agent/sign-in-tests'
const ADMIN_PATH = '/v1/admin/sign-in-tests'
const DEV: string = TEST_TENANT.environmentId
const PROD: string = TEST_TENANT.productionEnvironmentId
const HOOK_CANARY = 'Canary-hook-answer-7c1d'
const APP_CANARY = 'Canary-app-name-55ab'

type Point = 'before_sign_up' | 'before_session' | 'before_token'
const allow = () => Response.json({ decision: 'allow' }, { headers: { 'x-canary': HOOK_CANARY } })
const deny = () => Response.json({ decision: 'deny', code: 'not_on_the_list' })
let respond: Record<Point, () => Response | Promise<Response>>
let asked: { point: Point; raw: string }[] = []
const listener = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const point = new URL(req.url).pathname.slice(1) as Point
    asked.push({ point, raw: await req.text() })
    return respond[point]()
  },
})
afterAll(() => listener.stop(true))

let deps: TestDeps
let app: ReturnType<typeof createApp>
let agentKeyId: string
let secretKeyId: string
let spies: Mock<(...args: never[]) => unknown>[] = []
let revision = 0

const tenantOf = (environmentId: string, apiKeyId: string): Tenant => ({
  projectId: TEST_TENANT.projectId,
  environmentId,
  apiKeyId,
})

function configure(environmentId: string, settings: Partial<EnvironmentSettings>) {
  revision += 1
  deps.environmentSettings.seed(environmentId, {
    revision,
    settings: { ...DEFAULT_ENVIRONMENT_SETTINGS, ...settings },
  })
}

beforeEach(async () => {
  asked = []
  revision = 0
  respond = { before_sign_up: allow, before_session: allow, before_token: allow }
  deps = createInstanceTestDeps()
  const now = deps.clock.now()
  deps.environments.add({
    id: DEV,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: now,
  })
  deps.environments.add({
    id: PROD,
    projectId: TEST_TENANT.projectId,
    kind: 'production',
    createdAt: now,
  })
  secretKeyId = (await seedApiKey(deps, SK)).id
  agentKeyId = (await seedApiKey(deps, AK)).id
  await seedApiKey(deps, SECOND_AK)
  await seedApiKey(deps, PK)
  await seedApiKey(deps, PROD_AK, { environmentId: PROD })
  app = createApp(deps)
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    spies.push(spyOn(logger, level).mockImplementation(() => undefined))
  }
})

afterEach(async () => {
  // A step a test left at its limit: let it end before the next test's stores replace these.
  await SignInTests.settled()
  await Notices.settled()
  for (const spy of spies) {
    spy.mockRestore()
  }
  spies = []
})

const logged = () => JSON.stringify(spies.flatMap((spy) => spy.mock.calls))

function call(key: string | null, init: RequestInit = {}) {
  // A secret key's door is the admin route; everything else knocks on the agent's.
  return app.request(key?.startsWith('tula_sk_') ? ADMIN_PATH : PATH, {
    method: 'POST',
    ...init,
    headers: { ...(key && { authorization: `Bearer ${key}` }), ...init.headers },
  })
}

async function report(res: Response): Promise<SignInTestReport> {
  expect(res.status).toBe(200)
  return SignInTestReportSchema.parse(await res.json())
}

const outcomes = (result: SignInTestReport): Record<string, string> =>
  Object.fromEntries(
    result.steps.map((step) => [step.step, step.code ?? step.reason ?? step.outcome])
  )

const ALL_PASSED: Record<string, string> = Object.fromEntries(
  SIGN_IN_TEST_STEPS.map((step) => [step, 'passed'])
)

/** Every user of an environment that holds a marked address. */
const markedUsers = async (environmentId = DEV) =>
  (await deps.users.list(environmentId, { page: 1, size: 100, sort: '-createdAt' })).users.filter(
    (user) => user.email !== null && isTestAddress(user.email)
  )

const typesOf = (environmentId = DEV) =>
  deps.activityLog.entries
    .filter((entry) => entry.environmentId === environmentId)
    .map((entry) => entry.type)

function hook(point: Point, environmentId = DEV) {
  return Hooks.create(
    deps,
    tenantOf(environmentId, secretKeyId),
    {
      point,
      url: `http://127.0.0.1:${listener.port}/${point}`,
      enabled: true,
      deadlineMs: 500,
      failureMode: 'deny',
    },
    TEST_ACTOR
  )
}

describe('a run in an environment that allows it', () => {
  test('signs a throwaway user up and in, deletes it and reports every step', async () => {
    const result = await report(await call(AK))
    expect(outcomes(result)).toEqual(ALL_PASSED)
    expect(result).toMatchObject({ outcome: 'passed', cleanup: 'deleted' })
    expect(result.steps.map((step) => step.step)).toEqual([...SIGN_IN_TEST_STEPS])
    expect(result.userId).toMatch(/^[0-9a-f-]{36}$/)
    // Nobody is left, and nothing was handed to the deployment's mailer.
    expect(await markedUsers()).toEqual([])
    expect(await deps.users.findById(DEV, result.userId as string)).toBeNull()
    expect(deps.mailer.outbox).toEqual([])
  })

  test('the answer is not cached', async () => {
    expect((await call(AK)).headers.get('cache-control')).toBe('no-store')
  })

  test('the run, the creation and the deletion are recorded, with the agent as the actor', async () => {
    const result = await report(await call(AK))
    const entries = deps.activityLog.entries
    const of = (type: string) => entries.filter((entry) => entry.type === type)
    expect(of('sign_in_test.started')).toMatchObject([
      { actor: { type: 'agent', id: agentKeyId }, target: { type: 'environment', id: DEV } },
    ])
    expect(of('sign_in_test.finished')).toMatchObject([
      {
        actor: { type: 'agent', id: agentKeyId },
        target: { type: 'environment', id: DEV },
        data: { outcome: 'passed', cleanup: 'deleted', userId: result.userId },
      },
    ])
    expect(of('user.created')).toMatchObject([
      { target: { type: 'user', id: result.userId }, data: { test: true } },
    ])
    expect(of('user.deleted')).toMatchObject([
      { actor: { type: 'agent', id: agentKeyId }, target: { type: 'user', id: result.userId } },
    ])
    // The second session was ended by the agent, the first by the user's own sign-out.
    expect(of('session.revoked').map((entry) => entry.actor.type)).toEqual(['user', 'agent'])
    expect(typesOf().at(0)).toBe('sign_in_test.started')
    expect(typesOf().at(-1)).toBe('sign_in_test.finished')
  })

  test('a secret key runs it too, recorded as an administrator', async () => {
    const result = await report(await call(SK))
    expect(result.outcome).toBe('passed')
    const finished = deps.activityLog.ofType('sign_in_test.finished')
    expect(finished).toMatchObject([{ actor: { type: 'admin', id: secretKeyId } }])
    expect(deps.activityLog.ofType('user.deleted')).toMatchObject([
      { actor: { type: 'admin', id: secretKeyId } },
    ])
  })

  test('the event of the account says it is a test, and a person’s does not', async () => {
    await report(await call(AK))
    const created = deps.activityLog.events.filter((event) => event.type === 'user.created')
    expect(created.map((event) => event.data)).toMatchObject([{ test: true }])
    const person = await app.request('/v1/admin/users', {
      method: 'POST',
      headers: { authorization: `Bearer ${SK}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'maya@northline.app',
        password: 'correct horse battery staple',
      }),
    })
    expect(person.status).toBe(201)
    const all = deps.activityLog.events.filter((event) => event.type === 'user.created')
    expect('test' in (all.at(-1)?.data ?? {})).toBe(false)
  })

  test('of a run’s events only `user.created` says it is a test', async () => {
    await report(await call(AK))
    // Changing a row is a decision (ADR 0058, "What a receiver sees"): delivery order is not
    // guaranteed, so a receiver cannot count on the marked event arriving first, and one
    // that acts on the others correlates them by the user's id.
    const marked: Record<string, boolean> = {}
    for (const event of deps.activityLog.events) {
      marked[event.type] ||= 'test' in (event.data ?? {})
    }
    expect(marked).toEqual({
      'sign_in_test.started': false,
      'user.created': true,
      'session.created': false,
      'session.revoked': false,
      'user.deleted': false,
      'sign_in_test.finished': false,
    })
  })

  test('the hooks are asked, as for any sign-up', async () => {
    await hook('before_sign_up')
    await hook('before_session')
    const result = await report(await call(AK))
    expect(outcomes(result)).toEqual(ALL_PASSED)
    expect(asked.map((question) => question.point)).toEqual([
      'before_sign_up',
      'before_session',
      'before_session',
    ])
    const { data } = JSON.parse(asked[0]?.raw ?? '{}') as { data: { email: string } }
    expect(isTestAddress(data.email)).toBe(true)
  })
})

describe('where the run is allowed', () => {
  test('a production environment refuses by default, before anything is counted or made', async () => {
    const hit = spyOn(deps.rateLimiter, 'hit')
    // The route's own general limit counts; none of the run's does.
    const res = await call(PROD_AK)
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      code: 'auth.forbidden',
      params: { reason: 'test_sign_in_disabled' },
    })
    expect(hit.mock.calls.filter(([key]) => String(key).startsWith('sign_in_test'))).toEqual([])
    expect(typesOf(PROD)).toEqual([])
    expect(await markedUsers(PROD)).toEqual([])
    hit.mockRestore()
  })

  test('a production environment that switched it on runs it', async () => {
    configure(PROD, { agents: { testSignIn: true } })
    expect((await report(await call(PROD_AK))).outcome).toBe('passed')
  })

  test('a development environment that switched it off refuses', async () => {
    configure(DEV, { agents: { testSignIn: false } })
    for (const key of [AK, SK]) {
      const res = await call(key)
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ params: { reason: 'test_sign_in_disabled' } })
    }
    expect(typesOf()).toEqual([])
  })

  test('switched off through one instance, the next run on another is refused, whatever that instance has cached', async () => {
    // Two instances over one store, each with its own copy of the settings (30 seconds
    // without Redis: ADR 0018).
    const instance = () => {
      const own = {
        ...deps,
        environmentSettings: cacheEnvironmentSettings(deps.environmentSettings, deps.clock, 30_000),
      }
      return { deps: own, app: createApp(own) }
    }
    const [first, second] = [instance(), instance()]
    const admin = { authorization: `Bearer ${SK}`, 'content-type': 'application/json' }
    const read = await first.app.request('/v1/admin/settings', { headers: admin })
    const { revision: at, settings } = (await read.json()) as {
      revision: number
      settings: EnvironmentSettings
    }
    // The second instance has the settings as they were: a run is allowed there.
    expect((await Settings.current(second.deps, { environmentId: DEV })).agents.testSignIn).toBe(
      null
    )
    const saved = await first.app.request('/v1/admin/settings', {
      method: 'PUT',
      headers: { ...admin, 'if-match': `"${at}"` },
      body: JSON.stringify({ ...settings, agents: { testSignIn: false } }),
    })
    expect(saved.status).toBe(200)
    // Its copy has not moved, which is what the gate must not be decided from.
    expect((await Settings.current(second.deps, { environmentId: DEV })).agents.testSignIn).toBe(
      null
    )
    const res = await second.app.request(PATH, {
      method: 'POST',
      headers: { authorization: `Bearer ${AK}` },
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ params: { reason: 'test_sign_in_disabled' } })
    expect(typesOf().filter((type) => type.startsWith('sign_in_test'))).toEqual([])
    expect(await markedUsers()).toEqual([])
  })

  test('the kind is the environment’s own row, not the deployment’s tier', async () => {
    // `TEST_CONFIG.tier` is `local` for both: only the row differs.
    expect(deps.config.tier).toBe('local')
    expect(await SignInTests.allowed(deps, { environmentId: DEV })).toBe(true)
    expect(await SignInTests.allowed(deps, { environmentId: PROD })).toBe(false)
    // An environment nobody can find is treated as production.
    expect(
      await SignInTests.allowed(deps, { environmentId: '00000000-0000-7000-8000-00000000dead' })
    ).toBe(false)
  })
})

describe('who may call it', () => {
  test('no key, a publishable key, the instance token and a made-up key are the same 401, on both routes', async () => {
    for (const path of [PATH, ADMIN_PATH]) {
      for (const key of [
        null,
        PK,
        TEST_ADMIN_TOKEN,
        'tula_ak_dev_nobody0000000000000000000000000000',
        'tula_sk_dev_nobody0000000000000000000000000000',
      ]) {
        const res = await app.request(path, {
          method: 'POST',
          headers: { ...(key && { authorization: `Bearer ${key}` }) },
        })
        expect(res.status).toBe(401)
        expect(await res.json()).toMatchObject({ code: 'auth.invalid_key' })
      }
    }
    expect(typesOf()).toEqual([])
  })

  test('each key has its own door: an agent key is no administrator, a secret key no agent', async () => {
    const knock = (path: string, key: string) =>
      app.request(path, { method: 'POST', headers: { authorization: `Bearer ${key}` } })
    for (const res of [await knock(ADMIN_PATH, AK), await knock(PATH, SK)]) {
      expect(res.status).toBe(401)
      expect(await res.json()).toMatchObject({ code: 'auth.invalid_key' })
    }
    expect(typesOf()).toEqual([])
  })

  test('a dashboard session opens the administrator’s route and not the agent’s', async () => {
    const cookie = await dashboardSignIn(app)
    const headers = { ...dashboardHeaders(cookie, DEV), origin: deps.config.publicUrl }
    const refused = await app.request(PATH, { method: 'POST', headers })
    expect(refused.status).toBe(401)
    expect(typesOf()).toEqual([])
    const result = await report(await app.request(ADMIN_PATH, { method: 'POST', headers }))
    expect(result.outcome).toBe('passed')
    expect(deps.activityLog.ofType('sign_in_test.finished')).toMatchObject([
      { actor: { type: 'instance_admin' } },
    ])
  })

  test('a revoked agent key is refused', async () => {
    await deps.apiKeys.revoke(DEV, agentKeyId, deps.clock.now(), {
      id: deps.ids.next(),
      projectId: TEST_TENANT.projectId,
      environmentId: DEV,
      type: 'api_key.revoked',
      actor: { type: 'admin', id: secretKeyId },
      target: { type: 'api_key', id: agentKeyId },
      ipAddress: null,
      userAgent: null,
      data: {},
      occurredAt: deps.clock.now(),
    })
    expect((await call(AK)).status).toBe(401)
  })

  test('the agent key opens no other write: the proposal route still refuses a secret key', async () => {
    const proposal = await app.request('/v1/agent/proposals', {
      method: 'POST',
      headers: { authorization: `Bearer ${SK}`, 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'user.ban', targetId: deps.ids.next() }),
    })
    expect(proposal.status).toBe(401)
    for (const [method, path] of [
      ['POST', '/v1/admin/users'],
      ['PUT', '/v1/admin/settings'],
      ['DELETE', `/v1/admin/users/${deps.ids.next()}`],
    ] as const) {
      const res = await app.request(path, {
        method,
        headers: { authorization: `Bearer ${AK}`, 'content-type': 'application/json' },
        body: method === 'DELETE' ? undefined : '{}',
      })
      expect(res.status).toBe(401)
    }
  })
})

describe('limits', () => {
  test('a second run in the same minute is refused, and nothing is made for it', async () => {
    await report(await call(AK))
    const before = typesOf().length
    const res = await call(SECOND_AK)
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ code: 'rate_limited' })
    expect(typesOf().length).toBe(before)
    deps.clock.advance('61s')
    expect((await report(await call(SECOND_AK))).outcome).toBe('passed')
  })

  test('two requests at once: one runs', async () => {
    const [first, second] = await Promise.all([call(AK), call(SECOND_AK)])
    expect([first.status, second.status].sort()).toEqual([200, 429])
    expect(deps.activityLog.ofType('sign_in_test.started')).toHaveLength(1)
    expect(await markedUsers()).toEqual([])
  })

  test('a key has four runs an hour', async () => {
    for (let run = 0; run < SignInTests.SIGN_IN_TESTS_PER_KEY_PER_HOUR; run += 1) {
      expect((await call(AK)).status).toBe(200)
      deps.clock.advance('61s')
    }
    expect((await call(AK)).status).toBe(429)
    // Another key of the environment still has its own.
    expect((await call(SECOND_AK)).status).toBe(200)
  })

  test('an environment has eight runs an hour, whichever keys ask', async () => {
    for (let run = 0; run < SignInTests.SIGN_IN_TESTS_PER_ENVIRONMENT_PER_HOUR; run += 1) {
      expect((await call(run % 2 === 0 ? AK : SECOND_AK)).status).toBe(200)
      deps.clock.advance('61s')
    }
    expect((await call(SK)).status).toBe(429)
    expect(deps.activityLog.ofType('sign_in_test.started')).toHaveLength(
      SignInTests.SIGN_IN_TESTS_PER_ENVIRONMENT_PER_HOUR
    )
  })

  test('a limiter that cannot count refuses, and nothing is made', async () => {
    const real = deps.rateLimiter.hit.bind(deps.rateLimiter)
    const hit = spyOn(deps.rateLimiter, 'hit').mockImplementation((key, limit, windowMs) => {
      if (key.startsWith('sign_in_test:run')) {
        return Promise.reject(new ServiceUnavailableError())
      }
      return real(key, limit, windowMs)
    })
    const res = await call(AK)
    expect(res.status).toBe(503)
    expect(typesOf()).toEqual([])
    expect(await markedUsers()).toEqual([])
    hit.mockRestore()
  })
})

describe('a step that fails', () => {
  test('a hook that refuses the sign-up: reported with its code, no user to delete', async () => {
    await hook('before_sign_up')
    respond.before_sign_up = deny
    const result = await report(await call(AK))
    expect(outcomes(result)).toEqual({
      sign_up: 'passed',
      verify_email: 'hook.denied',
      sign_out: 'earlier_step',
      sign_in: 'earlier_step',
      first_factor: 'earlier_step',
      revoke_session: 'earlier_step',
      delete_user: 'earlier_step',
    })
    expect(result).toMatchObject({ outcome: 'failed', cleanup: 'none', userId: null })
    expect(await markedUsers()).toEqual([])
    expect(deps.activityLog.ofType('sign_in_test.finished')).toMatchObject([
      { data: { outcome: 'failed', cleanup: 'none' } },
    ])
  })

  test('a hook that refuses the session: the account was made, and is deleted', async () => {
    await hook('before_session')
    respond.before_session = deny
    const result = await report(await call(AK))
    expect(outcomes(result)).toMatchObject({
      sign_up: 'passed',
      verify_email: 'hook.denied',
      sign_out: 'earlier_step',
      delete_user: 'passed',
    })
    expect(result).toMatchObject({ outcome: 'failed', cleanup: 'deleted' })
    expect(result.userId).not.toBeNull()
    expect(await markedUsers()).toEqual([])
    expect(deps.activityLog.ofType('user.deleted')).toHaveLength(1)
  })

  test('a step that throws: the user is still deleted, and the error’s text goes nowhere', async () => {
    const signIn = spyOn(Flows, 'signIn').mockRejectedValue(new Error('Canary-thrown-text'))
    const res = await call(AK)
    const body = await res.clone().text()
    const result = await report(res)
    signIn.mockRestore()
    expect(outcomes(result)).toEqual({
      sign_up: 'passed',
      verify_email: 'passed',
      sign_out: 'passed',
      sign_in: 'internal',
      first_factor: 'earlier_step',
      revoke_session: 'earlier_step',
      delete_user: 'passed',
    })
    expect(result).toMatchObject({ outcome: 'failed', cleanup: 'deleted' })
    expect(await markedUsers()).toEqual([])
    expect(body).not.toContain('Canary-thrown-text')
    expect(logged()).not.toContain('Canary-thrown-text')
  })

  test('a deletion that fails is reported with the user’s id, logged, and purged later', async () => {
    const remove = spyOn(deps.users, 'delete').mockRejectedValue(new Error('Canary-store-text'))
    const result = await report(await call(AK))
    remove.mockRestore()
    expect(outcomes(result)).toMatchObject({ revoke_session: 'passed', delete_user: 'internal' })
    expect(result).toMatchObject({ outcome: 'failed', cleanup: 'failed' })
    const [left] = await markedUsers()
    expect(left?.id).toBe(result.userId as string)
    expect(deps.activityLog.ofType('sign_in_test.finished')).toMatchObject([
      { data: { outcome: 'failed', cleanup: 'failed', userId: result.userId } },
    ])
    const lines = logged()
    expect(lines).toContain('the throwaway user was not deleted')
    expect(lines).toContain(result.userId as string)
    expect(lines).not.toContain('Canary-store-text')
    expect(lines).not.toContain(left?.email as string)

    // The retention job: not while a run could still be using it, then for good.
    deps.clock.advance('14m')
    expect((await Retention.purge(deps)).testUsers).toBe(0)
    deps.clock.advance('2m')
    expect((await Retention.purge(deps)).testUsers).toBe(1)
    expect(await markedUsers()).toEqual([])
    expect(deps.activityLog.ofType('user.deleted')).toMatchObject([
      { actor: { type: 'system', id: null }, target: { type: 'user', id: result.userId } },
    ])
  })

  test('an entry that cannot be written at the end does not fail the answer', async () => {
    const real = deps.users.reportSignInTest.bind(deps.users)
    const reportEntry = spyOn(deps.users, 'reportSignInTest').mockImplementation(
      (environmentId, activity) =>
        activity.type === 'sign_in_test.finished'
          ? Promise.reject(new Error('Canary-store-text'))
          : real(environmentId, activity)
    )
    const result = await report(await call(AK))
    reportEntry.mockRestore()
    expect(result).toMatchObject({ outcome: 'passed', cleanup: 'deleted' })
    expect(logged()).toContain('its end could not be recorded')
    expect(logged()).not.toContain('Canary-store-text')
  })

  test('a start that cannot be recorded makes nothing', async () => {
    const reportEntry = spyOn(deps.users, 'reportSignInTest').mockRejectedValue(new Error('down'))
    const signUp = spyOn(Flows, 'signUp')
    expect((await call(AK)).status).toBe(500)
    expect(signUp).not.toHaveBeenCalled()
    reportEntry.mockRestore()
    signUp.mockRestore()
  })
})

describe('time and cancellation', () => {
  const actor = { ...TEST_ACTOR, type: 'agent' as const }
  const run = (options: SignInTests.RunOptions) =>
    SignInTests.run(deps, tenantOf(DEV, agentKeyId), actor, options)

  test('a sign-up left at its limit: `timeout`, the rest not run, and no user to clean up, because that step makes none', async () => {
    let land: () => void = () => undefined
    const held = new Promise<never>((_, reject) => {
      land = () => reject(new Error('let go'))
    })
    const signUp = spyOn(Flows, 'signUp').mockImplementation(() => held)
    const result = await run({ limits: { stepMs: 20, cleanupMs: 20 } })
    expect(outcomes(result)).toEqual({
      sign_up: 'timeout',
      verify_email: 'earlier_step',
      sign_out: 'earlier_step',
      sign_in: 'earlier_step',
      first_factor: 'earlier_step',
      revoke_session: 'earlier_step',
      // The start of a sign-up creates no account, so one that never ended left none and
      // never will: nothing to delete, and nothing the report has to warn of.
      delete_user: 'earlier_step',
    })
    expect(result.steps[0]).toMatchObject({ outcome: 'failed', reason: 'timeout' })
    expect(result.steps.at(-1)?.outcome).toBe('not_run')
    expect(result).toMatchObject({ outcome: 'failed', cleanup: 'none', userId: null })
    expect(deps.activityLog.ofType('sign_in_test.finished')).toMatchObject([
      { data: { outcome: 'failed', cleanup: 'none' } },
    ])
    expect(logged()).not.toContain('the throwaway user was not deleted')
    land()
    signUp.mockRestore()
  })

  test('only the verification of the sign-up can create the user', () => {
    // Changing this is a decision: it is what lets a run say that no user will be made.
    expect([...SignInTests.SIGN_IN_TEST_STEPS_THAT_CREATE]).toEqual(['verify_email'])
  })

  test.each(['sign_in', 'first_factor'] as const)(
    'a %s left at its limit after the account was made: the account is deleted, and nothing is said to remain',
    async (name) => {
      let land: () => void = () => undefined
      const held = new Promise<never>((_, reject) => {
        land = () => reject(new Error('let go'))
      })
      const stuck = spyOn(
        Flows,
        name === 'sign_in' ? 'signIn' : 'submitPassword'
      ).mockImplementation(() => held)
      const result = await run({ limits: { stepMs: 500, hookMs: 0, cleanupMs: 50 } })
      expect(outcomes(result)).toMatchObject({ [name]: 'timeout', delete_user: 'passed' })
      expect(result).toMatchObject({ outcome: 'failed', cleanup: 'deleted' })
      expect(await markedUsers()).toEqual([])
      land()
      stuck.mockRestore()
    }
  )

  test('a step left at its limit that makes the account afterwards: the account is still deleted', async () => {
    const real = Flows.verifyEmail
    const verify = spyOn(Flows, 'verifyEmail').mockImplementation(async (...args) => {
      await Bun.sleep(700)
      return real(...args)
    })
    // Longer than a sign-up's own work (one password hash), shorter than the delay.
    const result = await run({ limits: { stepMs: 500, hookMs: 0, cleanupMs: 4_000 } })
    verify.mockRestore()
    expect(outcomes(result)).toMatchObject({ verify_email: 'timeout', delete_user: 'passed' })
    expect(result).toMatchObject({ outcome: 'failed', cleanup: 'deleted' })
    expect(await markedUsers()).toEqual([])
  })

  test('a step still at work when the clean-up stops waiting: the report does not say no user was made', async () => {
    const real = Flows.verifyEmail
    let late: Promise<unknown> = Promise.resolve()
    const verify = spyOn(Flows, 'verifyEmail').mockImplementation((...args) => {
      const work = Bun.sleep(700).then(() => real(...args))
      late = work.catch(() => undefined)
      return work
    })
    // The step is left at 300 ms and the clean-up waits 200 more: the account is made after
    // the clean-up has looked for it.
    const result = await run({ limits: { stepMs: 300, hookMs: 0, cleanupMs: 200 } })
    expect(await markedUsers()).toEqual([])
    expect(outcomes(result)).toMatchObject({ verify_email: 'timeout', delete_user: 'timeout' })
    expect(result.steps.at(-1)?.outcome).toBe('failed')
    expect(result).toMatchObject({ outcome: 'failed', cleanup: 'failed', userId: null })
    expect(deps.activityLog.ofType('sign_in_test.finished')).toMatchObject([
      { data: { outcome: 'failed', cleanup: 'failed' } },
    ])
    await late
    verify.mockRestore()
    // What the report warned of: the user the late step made, left for the retention job.
    expect(await markedUsers()).toHaveLength(1)
  })

  test('three hooks that each answer just under their deadline: the run passes', async () => {
    // Scaled down: a hook's deadline is 1 s here and its allowance in a step the same. What
    // is tested is the rule, a step's own time and then a hook's longest wait for every hook
    // it asks; the constants are held by the next test.
    const slow = (answer: () => Response) => async () => {
      await Bun.sleep(800)
      return answer()
    }
    respond = {
      before_sign_up: slow(allow),
      before_session: slow(allow),
      before_token: slow(() => Response.json({ claims: {} })),
    }
    for (const point of ['before_sign_up', 'before_session', 'before_token'] as const) {
      const made = await hook(point)
      await Hooks.update(
        deps,
        tenantOf(DEV, secretKeyId),
        made.id,
        { deadlineMs: 1_000 },
        TEST_ACTOR
      )
    }
    const result = await run({ limits: { stepMs: 800, hookMs: 1_000 } })
    expect(outcomes(result)).toEqual(ALL_PASSED)
    expect(result).toMatchObject({ outcome: 'passed', cleanup: 'deleted' })
    // Which step asked how many: what `SIGN_IN_TEST_HOOKS_ASKED` says.
    expect(asked.map((question) => question.point)).toEqual([
      'before_sign_up',
      'before_session',
      'before_token',
      'before_session',
      'before_token',
    ])
    expect(SignInTests.SIGN_IN_TEST_HOOKS_ASKED).toEqual({ verify_email: 3, first_factor: 2 })
  })

  test('the limits add up: every step covers its hooks with headroom, and a run answers inside the minute', () => {
    const { SIGN_IN_TEST_HOOKS_ASKED: hooks, stepLimitMs } = SignInTests
    expect(SignInTests.SIGN_IN_TEST_HOOK_MS).toBe(HOOK_MAX_DEADLINE_MS)
    let worstCase = 0
    for (const step of SIGN_IN_TEST_STEPS) {
      const waiting = (hooks[step] ?? 0) * HOOK_MAX_DEADLINE_MS
      worstCase += waiting
      // Five seconds over the hooks' worst case at least; there was one.
      expect(stepLimitMs(step) - waiting).toBeGreaterThanOrEqual(5_000)
    }
    expect(stepLimitMs('verify_email')).toBe(31_000)
    expect(stepLimitMs('first_factor')).toBe(26_000)
    // Every hook of a run at its slowest still leaves the run ten seconds.
    expect(SignInTests.SIGN_IN_TEST_DEADLINE_MS - worstCase).toBeGreaterThanOrEqual(10_000)
    const answersWithin =
      SignInTests.SIGN_IN_TEST_DEADLINE_MS + 2 * SignInTests.SIGN_IN_TEST_CLEANUP_MS
    expect(answersWithin).toBe(56_000)
    expect(answersWithin).toBeLessThan(SignInTests.SIGN_IN_TEST_RUN_WINDOW_MS)
    // `SIGN_IN_TEST_TIMEOUT_MS` of `@tula/mcp`, which a test there holds above this sum.
    expect(answersWithin).toBeLessThan(60_000)
  })

  test('a run whose time is spent runs no further step', async () => {
    const signUp = spyOn(Flows, 'signUp')
    const result = await run({ limits: { deadlineMs: 0 } })
    expect(signUp).not.toHaveBeenCalled()
    signUp.mockRestore()
    expect(outcomes(result)).toMatchObject({ sign_up: 'timeout', verify_email: 'earlier_step' })
    expect(result.steps[0]?.outcome).toBe('not_run')
    expect(result).toMatchObject({ outcome: 'incomplete', cleanup: 'none' })
  })

  test('the deadline is the run’s, not each step’s: time spent by one step is gone for the next', async () => {
    const real = Flows.signUp
    const signUp = spyOn(Flows, 'signUp').mockImplementation(async (...args) => {
      const result = await real(...args)
      deps.clock.advance('41s')
      return result
    })
    const result = await run({})
    signUp.mockRestore()
    expect(outcomes(result)).toMatchObject({ sign_up: 'passed', verify_email: 'timeout' })
    expect(result.steps[1]?.outcome).toBe('not_run')
  })

  test('a caller that went away: the steps left are not run, the deletion is', async () => {
    const gone = new AbortController()
    const real = Flows.verifyEmail
    const verify = spyOn(Flows, 'verifyEmail').mockImplementation(async (...args) => {
      const result = await real(...args)
      gone.abort()
      return result
    })
    const result = await run({ signal: gone.signal })
    verify.mockRestore()
    expect(outcomes(result)).toEqual({
      sign_up: 'passed',
      verify_email: 'passed',
      sign_out: 'cancelled',
      sign_in: 'cancelled',
      first_factor: 'earlier_step',
      revoke_session: 'earlier_step',
      delete_user: 'passed',
    })
    expect(result).toMatchObject({ outcome: 'incomplete', cleanup: 'deleted' })
    expect(await markedUsers()).toEqual([])
  })
})

describe('what an environment’s settings make of the run', () => {
  type Method = keyof EnvironmentSettings['signIn']['methods']
  const methods = (...on: Method[]): EnvironmentSettings['signIn'] => ({
    ...DEFAULT_ENVIRONMENT_SETTINGS.signIn,
    methods: {
      password: { enabled: on.includes('password') },
      emailCode: { enabled: on.includes('emailCode') },
      emailLink: { enabled: on.includes('emailLink') },
      passkey: { enabled: on.includes('passkey') },
      smsCode: { enabled: on.includes('smsCode') },
    },
  })

  test('emailed codes only: the sign-in’s code cannot be asked for so soon, and is not faked', async () => {
    configure(DEV, {
      signIn: methods('emailCode'),
      signUp: { ...DEFAULT_ENVIRONMENT_SETTINGS.signUp, password: 'optional' },
    })
    const prepare = spyOn(Flows, 'prepareFirstFactor')
    const result = await report(await call(AK))
    expect(outcomes(result)).toEqual({
      sign_up: 'passed',
      verify_email: 'passed',
      sign_out: 'passed',
      sign_in: 'passed',
      first_factor: 'email_cooldown',
      revoke_session: 'email_cooldown',
      delete_user: 'passed',
    })
    expect(result).toMatchObject({ outcome: 'incomplete', cleanup: 'deleted' })
    // Not asked for: a refused request would only have been counted.
    expect(prepare).not.toHaveBeenCalled()
    prepare.mockRestore()
    expect(deps.mailer.outbox).toEqual([])
    expect(await markedUsers()).toEqual([])
  })

  test('password and emailed code: the sign-in is by password', async () => {
    configure(DEV, { signIn: methods('password', 'emailCode') })
    const prepare = spyOn(Flows, 'prepareFirstFactor')
    expect(outcomes(await report(await call(AK)))).toEqual(ALL_PASSED)
    expect(prepare).not.toHaveBeenCalled()
    prepare.mockRestore()
  })

  test('nothing the run can prove alone: the first factor is not run, and not passed', async () => {
    // What a sign-in offers once the password method went between the two halves of a run.
    const real = Flows.signIn
    const signIn = spyOn(Flows, 'signIn').mockImplementation(async (...args) => {
      const started = await real(...args)
      return {
        ...started,
        attempt: {
          ...started.attempt,
          step: { status: 'needs_first_factor', strategies: ['passkey', 'email_link'] },
        },
      }
    })
    const result = await report(await call(AK))
    signIn.mockRestore()
    expect(outcomes(result)).toEqual({
      sign_up: 'passed',
      verify_email: 'passed',
      sign_out: 'passed',
      sign_in: 'passed',
      first_factor: 'no_provable_method',
      revoke_session: 'no_provable_method',
      delete_user: 'passed',
    })
    expect(result).toMatchObject({ outcome: 'incomplete', cleanup: 'deleted' })
  })

  test('a sign-up the environment does not take: the failure it is', async () => {
    // No password method, and a sign-up needs a password.
    configure(DEV, { signIn: methods('emailCode') })
    const result = await report(await call(AK))
    expect(result.steps[0]).toMatchObject({ step: 'sign_up', outcome: 'failed' })
    expect(result).toMatchObject({ outcome: 'failed', cleanup: 'none', userId: null })
  })

  test('two-step verification required: the factor is accepted, no session is made, nothing is faked', async () => {
    configure(DEV, { mfa: { ...DEFAULT_ENVIRONMENT_SETTINGS.mfa, policy: 'required' } })
    const result = await report(await call(AK))
    expect(outcomes(result)).toEqual({
      sign_up: 'passed',
      verify_email: 'passed',
      sign_out: 'second_factor_required',
      sign_in: 'passed',
      first_factor: 'passed',
      revoke_session: 'second_factor_required',
      delete_user: 'passed',
    })
    expect(result).toMatchObject({ outcome: 'incomplete', cleanup: 'deleted' })
    expect(deps.activityLog.ofType('session.created')).toEqual([])
    expect(await markedUsers()).toEqual([])
  })
})

describe('what never leaves the server', () => {
  test('no code, attempt secret, password, token, address, hook answer or app name is in the answer, a log line, an audit entry or an event', async () => {
    configure(DEV, {
      app: { ...DEFAULT_ENVIRONMENT_SETTINGS.app, name: APP_CANARY },
    })
    await hook('before_sign_up')
    await hook('before_session')
    await hook('before_token')
    respond.before_token = () =>
      Response.json({ claims: { plan: HOOK_CANARY } }, { headers: { 'x-canary': HOOK_CANARY } })

    const secrets = new Set<string>([HOOK_CANARY, APP_CANARY])
    const keep = (value: unknown) => {
      if (typeof value === 'string' && value.length >= 6) {
        secrets.add(value)
      }
    }
    const tap = (result: Flows.FlowResult) => {
      keep(result.attempt.attemptSecret)
      keep(result.tokens?.accessToken)
      keep(result.tokens?.refreshToken)
      keep(result.tokens?.sessionToken)
      return result
    }
    const real = {
      signUp: Flows.signUp,
      verifyEmail: Flows.verifyEmail,
      signIn: Flows.signIn,
      submitPassword: Flows.submitPassword,
    }
    const taps = [
      spyOn(Flows, 'signUp').mockImplementation(async (d, t, input, context) => {
        keep(input.email)
        keep(input.password)
        return tap(await real.signUp(d, t, input, context))
      }),
      spyOn(Flows, 'verifyEmail').mockImplementation(async (d, t, kind, ref, code, context) => {
        keep(code)
        return tap(await real.verifyEmail(d, t, kind, ref, code, context))
      }),
      spyOn(Flows, 'signIn').mockImplementation(async (d, t, input, context) =>
        tap(await real.signIn(d, t, input, context))
      ),
      spyOn(Flows, 'submitPassword').mockImplementation(async (d, t, ref, password, context) => {
        keep(password)
        return tap(await real.submitPassword(d, t, ref, password, context))
      }),
    ]
    const res = await call(AK, { headers: { 'user-agent': 'Canary-agent-UA' } })
    const body = await res.clone().text()
    const result = await report(res)
    for (const spy of taps) {
      spy.mockRestore()
    }
    await Notices.settled()
    expect(outcomes(result)).toEqual(ALL_PASSED)
    // The address, the password, the code, two attempt secrets and the tokens of two sessions.
    expect(secrets.size).toBeGreaterThanOrEqual(9)

    const places = {
      answer: body,
      headers: JSON.stringify([...res.headers]),
      log: logged(),
      audit: JSON.stringify(deps.activityLog.entries),
      events: JSON.stringify(deps.activityLog.events),
      mail: JSON.stringify(deps.mailer.outbox),
    }
    for (const [place, text] of Object.entries(places)) {
      for (const secret of secrets) {
        // The app's name is the operator's own value: it is kept out of the answer, and may
        // be in none of the others either, since no email was rendered.
        expect({ place, found: text.includes(secret) }).toEqual({ place, found: false })
      }
      expect({ place, found: /@test\.tula\.invalid/.test(text) }).toEqual({ place, found: false })
    }
    // The flow's own entries hold nothing of the agent's request.
    const flowEntries = deps.activityLog.entries.filter((entry) => entry.actor.type === 'user')
    expect(flowEntries.length).toBeGreaterThan(0)
    expect(JSON.stringify(flowEntries)).not.toContain('Canary-agent-UA')
    expect(flowEntries.every((entry) => entry.ipAddress === null)).toBe(true)
  })

  test('the report’s schema has no room for anything else', () => {
    const steps = SIGN_IN_TEST_STEPS.map((step) => ({ step, outcome: 'passed', durationMs: 0 }))
    const good = { outcome: 'passed', steps, userId: null, cleanup: 'none' }
    expect(SignInTestReportSchema.safeParse(good).success).toBe(true)
    for (const extra of ['email', 'accessToken', 'attemptSecret', 'code', 'password']) {
      expect(SignInTestReportSchema.safeParse({ ...good, [extra]: 'x' }).success).toBe(false)
    }
  })
})
