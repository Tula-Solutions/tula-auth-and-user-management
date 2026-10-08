import { afterAll, afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from 'bun:test'
import {
  HOOK_QUESTION_SCHEMAS,
  RESERVED_CLAIM_NAMES,
  signWebhook,
  TulaEventSchema,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  webhookSecretBytes,
} from '@tula/contract'
import type { Tenant } from '~/dependencies'
import { RateLimitError, ServiceException } from '~/exceptions'
import * as logger from '~/lib/logger'
import * as Outbound from '~/lib/outbound'
import * as Hooks from '~/modules/hook/service'
import type { HookRecord } from '~/ports/hook-store'
import { createTestDeps, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'

// The two later points (ADR 0035, "Hooks before a session and before a token"), asked directly:
// what is sent, what an answer may be, and what a failure does. Where the flow and the session
// service ask them is `session.test.ts`. The receiver is a listener in this process, reached
// through the real outbound guard; every hook has the shortest deadline there is.

const tenant: Tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}
const otherTenant: Tenant = { ...tenant, environmentId: TEST_TENANT.productionEnvironmentId }

const USER = '0199c2f4-7a10-7c3e-9b1a-5d2e8f4a6c01'
const SESSION = '0199c2f4-7a12-7d4f-8c2b-6e3f9a5b7d02'
const CANARY = 'canary-52b1e0c9-answer'

interface Received {
  path: string
  headers: Record<string, string>
  body: string
}

let received: Received[] = []
let respond: (req: Request) => Response | Promise<Response> = () => Response.json({})
const listener = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    received.push({
      path: new URL(req.url).pathname,
      headers: Object.fromEntries(req.headers),
      body: await req.text(),
    })
    return respond(req)
  },
})
afterAll(() => listener.stop(true))

const answers =
  (body: unknown, status = 200) =>
  () =>
    Response.json(body, { status })
/** A body exactly as written: for what `Response.json` would not produce. */
const raw =
  (text: string, status = 200) =>
  () =>
    new Response(text, { status, headers: { 'content-type': 'application/json' } })
const hang = () => new Promise<Response>(() => undefined)

let deps: TestDeps
let spies: Mock<(...args: never[]) => unknown>[] = []

beforeEach(() => {
  received = []
  deps = createTestDeps()
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    spies.push(spyOn(logger, level).mockImplementation(() => undefined))
  }
})

afterEach(() => {
  for (const spy of spies) {
    spy.mockRestore()
  }
  spies = []
})

const logged = () => JSON.stringify(spies.flatMap((spy) => spy.mock.calls))

async function failure(work: Promise<unknown>): Promise<ServiceException> {
  const error = await work.then(
    () => null,
    (caught: unknown) => caught
  )
  if (!(error instanceof ServiceException)) {
    throw new Error(`expected a ServiceException, got ${String(error)}`)
  }
  return error
}

type Point = 'before_sign_up' | 'before_session' | 'before_token'

function register(
  point: Point,
  input: Partial<Parameters<typeof Hooks.create>[2]> = {},
  scope: Tenant = tenant
) {
  return Hooks.create(
    deps,
    scope,
    {
      point,
      url: `http://127.0.0.1:${listener.port}/tula/${point}`,
      enabled: true,
      deadlineMs: 100,
      failureMode: 'deny',
      ...input,
    },
    TEST_ACTOR
  )
}

const stored = async (id: string): Promise<HookRecord> => {
  const record = await deps.hooks.find(tenant.environmentId, id)
  if (!record) {
    throw new Error('the hook is gone')
  }
  return record
}

const sessionQuestion: Hooks.SessionQuestion = {
  userId: USER,
  client: 'web',
  profile: 'web',
  amr: ['pwd', 'otp', 'mfa'],
  signUp: false,
  ipAddress: '203.0.113.7',
}

const tokenQuestion: Hooks.TokenQuestion = {
  userId: USER,
  sessionId: SESSION,
  client: 'ios',
  profile: 'mobile',
  amr: ['pwd'],
}

const askSession = (scope: Tenant = tenant, input: Partial<Hooks.SessionQuestion> = {}) =>
  Hooks.beforeSession(deps, scope, { ...sessionQuestion, ...input })

const askToken = (
  scope: Tenant = tenant,
  input: Partial<Hooks.TokenQuestion> = {},
  fits?: Parameters<typeof Hooks.beforeToken>[3]
) => Hooks.beforeToken(deps, scope, { ...tokenQuestion, ...input }, fits)

/** What a request to the receiver must be, whatever the point: one signed POST of JSON. */
async function expectSigned(request: Received, secret: string): Promise<Record<string, unknown>> {
  expect(request.headers['content-type']).toBe('application/json')
  const parsed = JSON.parse(request.body) as Record<string, unknown>
  expect(parsed.id).toBe(request.headers[WEBHOOK_ID_HEADER])
  const timestamp = Number(request.headers[WEBHOOK_TIMESTAMP_HEADER])
  expect(timestamp).toBe(Math.floor(deps.clock.now().getTime() / 1000))
  const key = webhookSecretBytes(secret) as Uint8Array<ArrayBuffer>
  expect(request.headers[WEBHOOK_SIGNATURE_HEADER]).toBe(
    await signWebhook(key, String(parsed.id), timestamp, request.body)
  )
  expect(TulaEventSchema.safeParse(parsed).success).toBe(false)
  return parsed
}

describe('asking before a session', () => {
  test('with no hook the sign-in is clear and nothing is called', async () => {
    expect(await askSession()).toBe('clear')
    expect(received).toEqual([])
  })

  test('a hook that is off, another point’s hook and another environment’s are not asked', async () => {
    respond = answers({ decision: 'deny' })
    await register('before_session', { enabled: false })
    await register('before_sign_up')
    await register('before_token')
    await register('before_session', {}, otherTenant)
    expect(await askSession()).toBe('clear')
    expect(received).toEqual([])
  })

  test('the question is a signed POST whose body is the allow-list and nothing else', async () => {
    respond = answers({ decision: 'allow' })
    const created = await register('before_session')
    // A caller's object with more on it sends no more: the fields are named one by one.
    const more = {
      ...sessionQuestion,
      email: 'maya@northline.app',
      userAgent: 'Mozilla/5.0 Canary-UA',
      attemptId: 'attempt-1',
      password: 'correct horse battery staple',
    }
    expect(await Hooks.beforeSession(deps, tenant, more)).toBe('clear')
    expect(received).toHaveLength(1)
    const [request] = received as [Received]
    expect(request.path).toBe('/tula/before_session')
    const parsed = await expectSigned(request, created.secret)
    expect(parsed).toEqual({
      id: request.headers[WEBHOOK_ID_HEADER],
      type: 'hook.before_session',
      schemaVersion: 1,
      occurredAt: deps.clock.now().toISOString(),
      data: {
        userId: USER,
        client: 'web',
        profile: 'web',
        amr: ['pwd', 'otp', 'mfa'],
        signUp: false,
        ipAddress: '203.0.113.7',
      },
    })
    expect(HOOK_QUESTION_SCHEMAS.before_session.safeParse(parsed).success).toBe(true)
    expect(request.body).not.toContain('northline')
    expect(request.body).not.toContain('Canary-UA')
  })

  test('a sign-up’s session says so, and an unknown address is null', async () => {
    respond = answers({ decision: 'allow' })
    await register('before_session')
    await askSession(tenant, { signUp: true, ipAddress: null })
    expect((JSON.parse(received[0]?.body ?? '{}') as { data: unknown }).data).toEqual({
      ...sessionQuestion,
      signUp: true,
      ipAddress: null,
    })
  })

  test('a denial carries the operator’s code and nothing else of the answer', async () => {
    await register('before_session')
    respond = answers({ decision: 'deny', code: 'country_blocked' })
    const error = await failure(askSession())
    expect(error.code).toBe('hook.denied')
    expect(error.status).toBe(403)
    expect(error.params).toEqual({ code: 'country_blocked' })
    respond = answers({ decision: 'deny' })
    expect((await failure(askSession())).params).toBeUndefined()
  })

  test('a denial is not a failure: nothing is noted against the hook, whatever its mode', async () => {
    const { id } = await register('before_session', { failureMode: 'allow' })
    respond = answers({ decision: 'deny', code: 'nope' })
    expect((await failure(askSession())).code).toBe('hook.denied')
    expect(await stored(id)).toMatchObject({ lastFailedAt: null, lastFailureReason: null })
  })

  const bad: [name: string, respond: () => Response | Promise<Response>, reason: string][] = [
    ['a 500', answers({ decision: 'allow' }, 500), 'status_not_ok'],
    ['a 403 that says deny', answers({ decision: 'deny' }, 403), 'status_not_ok'],
    ['a body that is not JSON', raw('allow'), 'answer_invalid'],
    ['an empty object', answers({}), 'answer_invalid'],
    ['an allow with claims', answers({ decision: 'allow', claims: { a: 1 } }), 'answer_invalid'],
    [
      'a claims answer: this point decides, it adds nothing',
      answers({ claims: {} }),
      'answer_invalid',
    ],
    [
      'an allow that skips the second factor',
      answers({ decision: 'allow', amr: ['mfa'] }),
      'answer_invalid',
    ],
    [
      'an allow that names another user',
      answers({ decision: 'allow', userId: USER }),
      'answer_invalid',
    ],
    ['an endpoint that never answers', hang, 'timeout'],
  ]

  describe.each(bad)('%s', (_name, responder, reason) => {
    test('refuses the sign-in by default, as unavailable and not as denied', async () => {
      const { id } = await register('before_session')
      respond = responder
      const error = await failure(askSession())
      expect(error.code).toBe('hook.unavailable')
      expect(error.status).toBe(503)
      expect(error.params).toBeUndefined()
      expect(received).toHaveLength(1)
      const record = await stored(id)
      expect(record.lastFailureReason).toBe(reason as HookRecord['lastFailureReason'])
      expect(record.lastFailedAt).toEqual(deps.clock.now())
    })

    test('lets it through, and says so, when the hook allows on failure', async () => {
      const { id } = await register('before_session', { failureMode: 'allow' })
      respond = responder
      expect(await askSession()).toBe('bypassed')
      expect((await stored(id)).lastFailureReason).toBe(reason as HookRecord['lastFailureReason'])
    })
  })

  test('a hook that hangs refuses in bounded time', async () => {
    await register('before_session')
    respond = hang
    const started = performance.now()
    expect((await failure(askSession())).code).toBe('hook.unavailable')
    // A deadline of 100 ms: well inside a second and a half even on a slow runner.
    expect(performance.now() - started).toBeLessThan(1500)
  })

  test('calls are counted in the point’s own bucket, and one over the cap is refused without a call', async () => {
    respond = answers({ decision: 'allow' })
    await register('before_session')
    const hit = spyOn(deps.rateLimiter, 'hit')
    spies.push(hit)
    await askSession()
    expect(hit.mock.calls).toEqual([[Hooks.hookCallsKey(tenant, 'before_session'), 3000, 60_000]])
    expect(Hooks.HOOK_SESSION_CALLS_PER_MINUTE).toBe(3000)
    const keys = [
      Hooks.hookCallsKey(tenant),
      Hooks.hookCallsKey(tenant, 'before_sign_up'),
      Hooks.hookCallsKey(tenant, 'before_session'),
      Hooks.hookCallsKey(tenant, 'before_token'),
      Hooks.hookCallsKey(otherTenant, 'before_session'),
    ]
    // A sign-up's key is what it always was; every other point and environment has its own.
    expect(keys[0]).toBe(keys[1] as string)
    expect(new Set(keys).size).toBe(4)
    hit.mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterMs: 30_000 })
    const refused = await askSession().then(
      () => null,
      (error: unknown) => error
    )
    expect(refused).toBeInstanceOf(RateLimitError)
    expect(received).toHaveLength(1)
  })

  test('the cap is not counted where there is no hook to call', async () => {
    const hit = spyOn(deps.rateLimiter, 'hit')
    spies.push(hit)
    await askSession()
    await register('before_session', { enabled: false })
    await askSession()
    expect(hit).not.toHaveBeenCalled()
  })

  test('no log line holds the IP address, the secret or the hook’s address', async () => {
    const created = await register('before_session')
    for (const body of [{ decision: 'allow' }, { decision: 'deny', code: 'x' }, 'broken']) {
      respond = answers(body)
      await askSession().catch(() => undefined)
    }
    const lines = logged()
    expect(lines).toContain(created.id)
    expect(lines).not.toContain('203.0.113.7')
    expect(lines).not.toContain(created.secret)
    expect(lines).not.toContain('/tula/before_session')
  })
})

describe('asking before a token', () => {
  const NONE = { claims: null, asked: false, bypassed: false }

  test('with no hook there are no claims and nothing is called', async () => {
    expect(await askToken()).toEqual(NONE)
    expect(received).toEqual([])
  })

  test('a hook that is off, another point’s hook and another environment’s are not asked', async () => {
    respond = answers({ claims: { role: 'admin' } })
    await register('before_token', { enabled: false })
    await register('before_sign_up')
    await register('before_session')
    await register('before_token', {}, otherTenant)
    expect(await askToken()).toEqual(NONE)
    expect(received).toEqual([])
  })

  test('the question is a signed POST whose body is the allow-list and nothing else', async () => {
    respond = answers({ claims: {} })
    const created = await register('before_token')
    const more = {
      ...tokenQuestion,
      email: 'maya@northline.app',
      ipAddress: '203.0.113.7',
      userAgent: 'Mozilla/5.0 Canary-UA',
      refreshToken: 'tula_rt_secret',
    }
    await Hooks.beforeToken(deps, tenant, more)
    expect(received).toHaveLength(1)
    const [request] = received as [Received]
    expect(request.path).toBe('/tula/before_token')
    const parsed = await expectSigned(request, created.secret)
    expect(parsed).toEqual({
      id: request.headers[WEBHOOK_ID_HEADER],
      type: 'hook.before_token',
      schemaVersion: 1,
      occurredAt: deps.clock.now().toISOString(),
      data: { userId: USER, sessionId: SESSION, client: 'ios', profile: 'mobile', amr: ['pwd'] },
    })
    expect(HOOK_QUESTION_SCHEMAS.before_token.safeParse(parsed).success).toBe(true)
    for (const never of ['northline', '203.0.113.7', 'Canary-UA', 'tula_rt_']) {
      expect(request.body).not.toContain(never)
    }
  })

  test('the claims of an answer are what is returned: a copy, with own keys only', async () => {
    await register('before_token')
    respond = answers({ claims: { role: 'admin', seats: 3, staff: false } })
    const answered = await askToken()
    expect(answered).toEqual({
      claims: { role: 'admin', seats: 3, staff: false },
      asked: true,
      bypassed: false,
    })
    expect(Object.getPrototypeOf(answered.claims)).toBe(Object.prototype)
  })

  test('an answer with no claims is an answer: none, and not a failure', async () => {
    const { id } = await register('before_token')
    respond = answers({ claims: {} })
    expect(await askToken()).toEqual({ claims: null, asked: true, bypassed: false })
    expect(await stored(id)).toMatchObject({ lastFailedAt: null, lastFailureReason: null })
  })

  test('an answer may be longer than a decision’s: claims at the cap, written with spaces', async () => {
    await register('before_token')
    const claims = { a: 'x'.repeat(1016) }
    const pretty = JSON.stringify({ claims }, null, 8)
    expect(pretty.length).toBeGreaterThan(Hooks.HOOK_MAX_RESPONSE_BYTES)
    expect(pretty.length).toBeLessThan(Hooks.HOOK_MAX_CLAIMS_RESPONSE_BYTES)
    respond = raw(pretty)
    expect((await askToken()).claims).toEqual(claims)
  })

  const overCap = { claims: { a: 'x'.repeat(1017) } }
  const tooBig = JSON.stringify({ claims: { a: 1 }, pad: 'x'.repeat(4096) })
  const bad: [name: string, respond: () => Response | Promise<Response>, reason: string][] = [
    ['a 500', answers({ claims: { role: 'admin' } }, 500), 'status_not_ok'],
    [
      'a redirect',
      () => new Response(null, { status: 302, headers: { location: '/x' } }),
      'status_not_ok',
    ],
    ['a body that is not JSON', raw('role=admin'), 'answer_invalid'],
    ['a 204 with no body', () => new Response(null, { status: 204 }), 'answer_invalid'],
    ['an empty object', answers({}), 'answer_invalid'],
    [
      'a decision: this point cannot allow or deny',
      answers({ decision: 'allow' }),
      'answer_invalid',
    ],
    ['a denial', answers({ decision: 'deny', code: 'no' }), 'answer_invalid'],
    [
      'claims beside a decision',
      answers({ decision: 'allow', claims: { a: 1 } }),
      'answer_invalid',
    ],
    ['a subject beside the claims', answers({ claims: { a: 1 }, sub: USER }), 'answer_invalid'],
    ['methods beside the claims', answers({ claims: { a: 1 }, amr: ['mfa'] }), 'answer_invalid'],
    [
      'a verified address beside the claims',
      answers({ claims: {}, emailVerified: true }),
      'answer_invalid',
    ],
    ['a user beside the claims', answers({ claims: {}, userId: USER }), 'answer_invalid'],
    [
      'a `__proto__` key beside the claims',
      raw('{"claims":{"a":1},"__proto__":{"b":2}}'),
      'answer_invalid',
    ],
    ['claims that are a list', answers({ claims: ['admin'] }), 'answer_invalid'],
    ['claims that are null', answers({ claims: null }), 'answer_invalid'],
    ['a nested claim', answers({ claims: { role: { name: 'admin' } } }), 'claims_invalid'],
    ['a list claim', answers({ claims: { roles: ['admin'] } }), 'claims_invalid'],
    ['a null claim', answers({ claims: { role: null } }), 'claims_invalid'],
    ['a key outside the grammar', answers({ claims: { 'my-claim': 1 } }), 'claims_invalid'],
    [
      'a `__proto__` claim',
      raw('{"claims":{"role":"admin","__proto__":{"admin":true}}}'),
      'claims_invalid',
    ],
    ['a `constructor` claim', raw('{"claims":{"constructor":"x"}}'), 'claims_invalid'],
    [
      'one bad claim beside good ones',
      answers({ claims: { role: 'admin', sub: USER } }),
      'claims_invalid',
    ],
    ...RESERVED_CLAIM_NAMES.map(
      (name) =>
        [`the reserved name ${name}`, answers({ claims: { [name]: 'x' } }), 'claims_invalid'] as [
          string,
          () => Response,
          string,
        ]
    ),
    ['claims one byte over the cap', answers(overCap), 'claims_too_large'],
    ['an answer over the size cap of an answer', raw(tooBig), 'response_too_large'],
    ['an endpoint that never answers', hang, 'timeout'],
  ]

  describe.each(bad)('%s', (_name, responder, reason) => {
    test('fails the call by default: unavailable, and no claim of it is returned', async () => {
      const { id } = await register('before_token')
      respond = responder
      const error = await failure(askToken())
      expect(error.code).toBe('hook.unavailable')
      expect(error.status).toBe(503)
      expect(error.params).toBeUndefined()
      expect(received).toHaveLength(1)
      const record = await stored(id)
      expect(record.lastFailureReason).toBe(reason as HookRecord['lastFailureReason'])
      expect(record.lastFailedAt).toEqual(deps.clock.now())
    })

    test('gives no claims at all, and says so, when the hook allows on failure', async () => {
      const { id } = await register('before_token', { failureMode: 'allow' })
      respond = responder
      expect(await askToken()).toEqual({ claims: null, asked: true, bypassed: true })
      expect((await stored(id)).lastFailureReason).toBe(reason as HookRecord['lastFailureReason'])
    })
  })

  test('claims that do not fit beside the template’s fail the call: too large', async () => {
    const { id } = await register('before_token')
    respond = answers({ claims: { role: 'admin' } })
    const seen: unknown[] = []
    const error = await failure(
      askToken(tenant, {}, (claims) => {
        seen.push(claims)
        return false
      })
    )
    expect(error.code).toBe('hook.unavailable')
    expect(seen).toEqual([{ role: 'admin' }])
    expect((await stored(id)).lastFailureReason).toBe('claims_too_large')
    // And where they fit, they are the answer.
    expect((await askToken(tenant, {}, () => true)).claims).toEqual({ role: 'admin' })
  })

  test('claims that do not fit are given up whole under allow, never cut down', async () => {
    await register('before_token', { failureMode: 'allow' })
    respond = answers({ claims: { role: 'admin', plan: 'team' } })
    expect(await askToken(tenant, {}, () => false)).toEqual({
      claims: null,
      asked: true,
      bypassed: true,
    })
  })

  test('a hook that hangs fails in bounded time', async () => {
    await register('before_token')
    respond = hang
    const started = performance.now()
    expect((await failure(askToken())).code).toBe('hook.unavailable')
    expect(performance.now() - started).toBeLessThan(1500)
  })

  test('the deadline is the hook’s, never more than five seconds, and the answer’s cap is the claims’', async () => {
    respond = answers({ claims: {} })
    const { id } = await register('before_token', { deadlineMs: 4321 })
    const request = spyOn(Outbound, 'request')
    spies.push(request)
    await askToken()
    expect(request.mock.calls[0]?.[2]).toMatchObject({
      timeoutMs: 4321,
      maxResponseBytes: 4096,
      method: 'POST',
    })
    expect(Hooks.HOOK_MAX_CLAIMS_RESPONSE_BYTES).toBe(4096)
    const record = await stored(id)
    spies.push(
      spyOn(deps.hooks, 'findByPoint').mockResolvedValue({ ...record, deadlineMs: 60_000 })
    )
    await askToken()
    expect(request.mock.calls[1]?.[2]).toMatchObject({ timeoutMs: 5000 })
  })

  test('a secret that cannot be opened sends nothing', async () => {
    const { id } = await register('before_token')
    const record = await stored(id)
    spies.push(
      spyOn(deps.hooks, 'findByPoint').mockResolvedValue({ ...record, secret: 'not-a-ciphertext' })
    )
    expect((await failure(askToken())).code).toBe('hook.unavailable')
    expect(received).toEqual([])
    expect((await stored(id)).lastFailureReason).toBe('secret_unreadable')
  })

  test('nothing of an answer reaches a log line or the hook’s row: not a claim, not a header', async () => {
    const { id } = await register('before_token')
    for (const body of [
      { claims: { note: CANARY } },
      { claims: { sub: CANARY } },
      { claims: { note: CANARY }, extra: CANARY },
    ]) {
      respond = () => Response.json(body, { headers: { 'x-canary': CANARY } })
      await askToken().catch(() => undefined)
    }
    expect(logged()).toContain(id)
    expect(logged()).not.toContain(CANARY)
    expect(JSON.stringify(await stored(id))).not.toContain(CANARY)
    expect(JSON.stringify(deps.activityLog.entries)).not.toContain(CANARY)
    expect(JSON.stringify(deps.activityLog.outbox)).not.toContain(CANARY)
    expect(JSON.stringify(await Hooks.get(deps, tenant, id))).not.toContain(CANARY)
  })

  test('calls are counted in the point’s own bucket, and one over the cap is refused without a call', async () => {
    respond = answers({ claims: {} })
    await register('before_token')
    const hit = spyOn(deps.rateLimiter, 'hit')
    spies.push(hit)
    await askToken()
    expect(hit.mock.calls).toEqual([[Hooks.hookCallsKey(tenant, 'before_token'), 3000, 60_000]])
    hit.mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterMs: 30_000 })
    const refused = await askToken().then(
      () => null,
      (error: unknown) => error
    )
    expect(refused).toBeInstanceOf(RateLimitError)
    expect(received).toHaveLength(1)
  })
})

describe('a hook for one of the later points', () => {
  test.each([['before_session'], ['before_token']] as const)(
    '%s is registered, recorded by its point, and weakened like any other',
    async (point) => {
      const created = await register(point, { failureMode: 'allow' })
      expect(created.point).toBe(point)
      expect(created.secret).toMatch(/^whsec_/)
      const [entry] = deps.activityLog.entries
      expect(entry?.type).toBe('hook.created')
      expect(entry?.data).toEqual({ point, enabled: true, failureMode: 'allow', weakened: true })
      await Hooks.update(deps, tenant, created.id, { enabled: false }, TEST_ACTOR)
      expect(deps.activityLog.entries[1]?.data).toEqual({
        point,
        changed: ['enabled'],
        weakened: true,
      })
      // One hook per point: a second for the same point is refused.
      expect((await failure(register(point))).status).toBe(409)
    }
  )
})
