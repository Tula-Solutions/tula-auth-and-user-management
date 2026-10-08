import { afterAll, afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from 'bun:test'
import {
  HOOK_QUESTION_SCHEMAS,
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
import * as Audit from '~/modules/audit/service'
import * as Hooks from '~/modules/hook/service'
import { WEBHOOK_SECRET_PURPOSE } from '~/modules/webhook/service'
import type { HookRecord } from '~/ports/hook-store'
import { createTestDeps, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'

// The hook's receiver is a listener in this process, reached through the real outbound guard.
// The clock is the test's; a deadline is real time, so every hook here has the shortest one.

const tenant: Tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}
const otherTenant: Tenant = { ...tenant, environmentId: TEST_TENANT.productionEnvironmentId }

interface Received {
  method: string
  headers: Record<string, string>
  body: string
}

const CANARY = 'canary-7f3a9c1e-answer'
let received: Received[] = []
let respond: (req: Request) => Response | Promise<Response> = () => Response.json({})
const listener = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    received.push({
      method: req.method,
      headers: Object.fromEntries(req.headers),
      body: await req.text(),
    })
    return respond(req)
  },
})
afterAll(() => listener.stop(true))

const receiverUrl = (host = '127.0.0.1') => `http://${host}:${listener.port}/tula/before-sign-up`
const answers =
  (body: unknown, status = 200) =>
  () =>
    Response.json(body, { status })
const allow = answers({ decision: 'allow' })

let deps: TestDeps
let spies: Mock<(...args: never[]) => unknown>[] = []

beforeEach(() => {
  received = []
  respond = allow
  deps = createTestDeps()
  deps.outbound.point('hooks.second.test', '127.0.0.1')
})

afterEach(() => {
  for (const spy of spies) {
    spy.mockRestore()
  }
  spies = []
})

function quietLogs(): void {
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    spies.push(spyOn(logger, level).mockImplementation(() => undefined))
  }
}

/** Everything the logger was given while the spies were on, as one text. */
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

function register(scope: Tenant = tenant, input: Partial<Parameters<typeof Hooks.create>[2]> = {}) {
  return Hooks.create(
    deps,
    scope,
    {
      point: 'before_sign_up',
      url: receiverUrl(),
      enabled: true,
      // The shortest there is: a test that lets one run out waits this long.
      deadlineMs: 100,
      failureMode: 'deny',
      ...input,
    },
    TEST_ACTOR
  )
}

const question: Hooks.SignUpQuestion = {
  email: 'maya@northline.app',
  method: 'password',
  client: 'web',
  ipAddress: '203.0.113.7',
}

const ask = (scope: Tenant = tenant, input: Partial<Hooks.SignUpQuestion> = {}) =>
  Hooks.beforeSignUp(deps, scope, { ...question, ...input })

/** The audit entries of `tenant`, oldest first, as type and data. */
const recorded = () =>
  deps.activityLog.entries
    .filter((entry) => entry.environmentId === tenant.environmentId)
    .map((entry) => ({ type: entry.type, data: entry.data }))

const stored = async (id: string): Promise<HookRecord> => {
  const record = await deps.hooks.find(tenant.environmentId, id)
  if (!record) {
    throw new Error('the hook is gone')
  }
  return record
}

describe('registering a hook', () => {
  test('the server makes the secret, returns it once, and stores it sealed', async () => {
    const created = await register()
    expect(created.secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/)
    expect(created).toMatchObject({
      point: 'before_sign_up',
      url: receiverUrl(),
      enabled: true,
      deadlineMs: 100,
      failureMode: 'deny',
      lastFailedAt: null,
      lastFailureReason: null,
    })
    const record = await stored(created.id)
    expect(record.secret).not.toContain(created.secret)
    expect(record.secret).not.toContain(created.secret.slice('whsec_'.length))
    expect(JSON.stringify(await Hooks.get(deps, tenant, created.id))).not.toContain('whsec_')
    expect(JSON.stringify(await Hooks.list(deps, tenant))).not.toContain('whsec_')
    expect(Object.keys(await Hooks.get(deps, tenant, created.id))).not.toContain('secret')
  })

  test('the secret is sealed for its hook, its environment and for hooks only', async () => {
    const created = await register()
    const record = await stored(created.id)
    const open = (purpose: string, binding: string) =>
      deps.secretBox.open(purpose, record.secret, binding).then(
        (bytes) => new TextDecoder().decode(bytes),
        () => null
      )
    const { environmentId } = tenant
    expect(await open(Hooks.HOOK_SECRET_PURPOSE, `${environmentId}:${created.id}`)).toBe(
      created.secret
    )
    expect(
      await open(Hooks.HOOK_SECRET_PURPOSE, `${otherTenant.environmentId}:${created.id}`)
    ).toBeNull()
    expect(await open(Hooks.HOOK_SECRET_PURPOSE, `${environmentId}:${deps.ids.next()}`)).toBeNull()
    // The same ids under the webhooks' purpose: a hook's secret is no webhook endpoint's.
    expect(await open(WEBHOOK_SECRET_PURPOSE, `${environmentId}:${created.id}`)).toBeNull()
  })

  test('is recorded with the point and the mode, and never the address or the secret', async () => {
    const created = await register()
    expect(recorded()).toEqual([
      {
        type: 'hook.created',
        data: { point: 'before_sign_up', enabled: true, failureMode: 'deny' },
      },
    ])
    const entry = JSON.stringify(deps.activityLog.entries) + JSON.stringify(deps.activityLog.outbox)
    expect(entry).not.toContain(String(listener.port))
    expect(entry).not.toContain('before-sign-up')
    expect(entry).not.toContain(created.secret)
    expect(entry).not.toContain(created.secret.slice('whsec_'.length))
  })

  test('one that lets sign-ups through on failure is recorded as a weakening', async () => {
    await register(tenant, { failureMode: 'allow' })
    expect(recorded()).toEqual([
      {
        type: 'hook.created',
        data: { point: 'before_sign_up', enabled: true, failureMode: 'allow', weakened: true },
      },
    ])
  })

  test('an environment has one hook per point; another environment has its own', async () => {
    const first = await register()
    const error = await failure(register(tenant, { url: receiverUrl('hooks.second.test') }))
    expect(error.code).toBe('resource.conflict')
    expect(await Hooks.list(deps, tenant)).toHaveLength(1)
    expect((await Hooks.list(deps, tenant))[0]?.id).toBe(first.id)
    expect(recorded()).toHaveLength(1)
    await register(otherTenant)
    expect(await Hooks.list(deps, otherTenant)).toHaveLength(1)
  })

  test.each([
    [
      'a plain http address outside the local tier',
      'http://hooks.example.com/x',
      'prod',
      'scheme_not_allowed',
    ],
    ['credentials in the address', 'https://user:pw@hooks.example.com/x', 'prod', 'invalid_url'],
    ['a name that does not resolve', 'https://nowhere.example.com/x', 'prod', 'resolve_failed'],
    ['a private address', 'https://10.0.0.8/x', 'prod', 'address_not_allowed'],
    ['the metadata address', 'https://169.254.169.254/x', 'local', 'address_not_allowed'],
  ] as const)(
    '%s is refused by the outbound guard and nothing is stored',
    async (_name, url, tier, reason) => {
      deps.outbound.tier = tier
      const error = await failure(register(tenant, { url }))
      expect(error.code).toBe('hook.url_not_allowed')
      expect(error.params).toEqual({ reason })
      expect(JSON.stringify(error.params)).not.toContain('example.com')
      expect(await Hooks.list(deps, tenant)).toEqual([])
      expect(recorded()).toEqual([])
    }
  )
})

describe('changing a hook', () => {
  const change = (id: string, input: Parameters<typeof Hooks.update>[3], scope = tenant) =>
    Hooks.update(deps, scope, id, input, TEST_ACTOR)

  test('names the fields that changed, never their values', async () => {
    const { id } = await register()
    deps.clock.advance('1m')
    const updated = await change(id, { url: receiverUrl('hooks.second.test'), deadlineMs: 250 })
    expect(updated).toMatchObject({ url: receiverUrl('hooks.second.test'), deadlineMs: 250 })
    expect(updated.updatedAt).toBe(deps.clock.now().toISOString())
    expect(recorded()[1]).toEqual({
      type: 'hook.updated',
      data: { point: 'before_sign_up', changed: ['url', 'deadlineMs'] },
    })
    expect(JSON.stringify(deps.activityLog.entries)).not.toContain('hooks.second.test')
  })

  test.each([
    ['switching it off', { enabled: false }, ['enabled']],
    ['letting sign-ups through on failure', { failureMode: 'allow' }, ['failureMode']],
    ['both', { enabled: false, failureMode: 'allow' }, ['enabled', 'failureMode']],
  ] as const)('%s is recorded as a weakening', async (_name, input, changed) => {
    const { id } = await register()
    await change(id, input)
    expect(recorded()[1]).toEqual({
      type: 'hook.updated',
      data: { point: 'before_sign_up', changed: [...changed], weakened: true },
    })
  })

  test('making it stricter, or changing what does not weaken it, is not', async () => {
    const { id } = await register(tenant, { enabled: false, failureMode: 'allow' })
    await change(id, { enabled: true })
    await change(id, { failureMode: 'deny' })
    await change(id, { deadlineMs: 5000 })
    expect(recorded().slice(1)).toEqual([
      { type: 'hook.updated', data: { point: 'before_sign_up', changed: ['enabled'] } },
      { type: 'hook.updated', data: { point: 'before_sign_up', changed: ['failureMode'] } },
      { type: 'hook.updated', data: { point: 'before_sign_up', changed: ['deadlineMs'] } },
    ])
  })

  test('a request that changes nothing writes nothing', async () => {
    const created = await register()
    const same = await change(created.id, { enabled: true, deadlineMs: 100, url: receiverUrl() })
    expect(same.updatedAt).toBe(created.updatedAt)
    expect(recorded()).toHaveLength(1)
  })

  test('a new address is judged by the outbound guard before it is stored', async () => {
    const { id } = await register()
    const error = await failure(change(id, { url: 'http://169.254.169.254/latest' }))
    expect(error.code).toBe('hook.url_not_allowed')
    expect(error.params).toEqual({ reason: 'address_not_allowed' })
    expect((await stored(id)).url).toBe(receiverUrl())
    expect(recorded()).toHaveLength(1)
  })

  test('a hook that changed between the read and the write is not written over', async () => {
    const { id } = await register()
    const update = deps.hooks.update.bind(deps.hooks)
    spies.push(
      spyOn(deps.hooks, 'update').mockImplementationOnce(async (...args) => {
        // Someone else switches it off after this request read it as on.
        await update(
          tenant.environmentId,
          id,
          { enabled: true, failureMode: 'deny' },
          { enabled: false },
          deps.clock.now(),
          Audit.none('fixture')
        )
        return update(...args)
      })
    )
    const error = await failure(change(id, { deadlineMs: 300 }))
    expect(error.code).toBe('resource.conflict')
    expect(await stored(id)).toMatchObject({ enabled: false, deadlineMs: 100 })
    expect(recorded()).toHaveLength(1)
  })

  test('another environment’s hook is not found: not read, changed or removed', async () => {
    const { id } = await register()
    for (const work of [
      Hooks.get(deps, otherTenant, id),
      change(id, { enabled: false }, otherTenant),
      Hooks.remove(deps, otherTenant, id, TEST_ACTOR),
      Hooks.get(deps, tenant, deps.ids.next()),
    ]) {
      expect((await failure(work)).code).toBe('resource.not_found')
    }
    expect(await stored(id)).toMatchObject({ enabled: true })
    expect(await Hooks.list(deps, otherTenant)).toEqual([])
  })
})

describe('removing a hook', () => {
  test('one that is on is recorded as a weakening, and it is asked no more', async () => {
    const { id } = await register()
    await Hooks.remove(deps, tenant, id, TEST_ACTOR)
    expect(recorded()[1]).toEqual({
      type: 'hook.deleted',
      data: { point: 'before_sign_up', weakened: true },
    })
    expect(await ask()).toBe('clear')
    expect(received).toEqual([])
  })

  test('one that is off is not a weakening', async () => {
    const { id } = await register(tenant, { enabled: false })
    await Hooks.remove(deps, tenant, id, TEST_ACTOR)
    expect(recorded()[1]).toEqual({ type: 'hook.deleted', data: { point: 'before_sign_up' } })
  })
})

describe('asking before a sign-up', () => {
  test('with no hook, the sign-up is clear and nothing is called', async () => {
    expect(await ask()).toBe('clear')
    expect(received).toEqual([])
  })

  test('a hook that is switched off is not asked', async () => {
    await register(tenant, { enabled: false })
    expect(await ask()).toBe('clear')
    expect(received).toEqual([])
  })

  test('another environment’s hook is never asked', async () => {
    respond = answers({ decision: 'deny' })
    await register(otherTenant)
    expect(await ask(tenant)).toBe('clear')
    expect(received).toEqual([])
  })

  test('the question is a signed POST whose body is the allow-list and nothing else', async () => {
    const created = await register()
    expect(await ask()).toBe('clear')
    expect(received).toHaveLength(1)
    const [request] = received as [Received]
    expect(request.method).toBe('POST')
    expect(request.headers['content-type']).toBe('application/json')
    const parsed = JSON.parse(request.body) as Record<string, unknown>
    expect(parsed).toEqual({
      id: request.headers[WEBHOOK_ID_HEADER],
      type: 'hook.before_sign_up',
      schemaVersion: 1,
      occurredAt: deps.clock.now().toISOString(),
      data: {
        email: 'maya@northline.app',
        method: 'password',
        client: 'web',
        ipAddress: '203.0.113.7',
      },
    })
    // Strict: a key the contract does not name would fail here.
    expect(HOOK_QUESTION_SCHEMAS.before_sign_up.safeParse(parsed).success).toBe(true)
    expect(TulaEventSchema.safeParse(parsed).success).toBe(false)
    const timestamp = Number(request.headers[WEBHOOK_TIMESTAMP_HEADER])
    expect(timestamp).toBe(Math.floor(deps.clock.now().getTime() / 1000))
    const key = webhookSecretBytes(created.secret) as Uint8Array<ArrayBuffer>
    expect(request.headers[WEBHOOK_SIGNATURE_HEADER]).toBe(
      await signWebhook(key, String(parsed.id), timestamp, request.body)
    )
  })

  test('every question has an id of its own', async () => {
    await register()
    await ask()
    await ask()
    expect(received[0]?.headers[WEBHOOK_ID_HEADER]).not.toBe(
      received[1]?.headers[WEBHOOK_ID_HEADER]
    )
  })

  test('an address the server does not know is asked about as null', async () => {
    await register()
    await ask(tenant, { ipAddress: null, method: 'oauth_github', client: 'ios' })
    expect((JSON.parse(received[0]?.body ?? '{}') as { data: unknown }).data).toEqual({
      email: 'maya@northline.app',
      method: 'oauth_github',
      client: 'ios',
      ipAddress: null,
    })
  })

  test('a denial carries the operator’s code and nothing else of the answer', async () => {
    quietLogs()
    await register()
    respond = answers({ decision: 'deny', code: 'disposable_email' })
    const error = await failure(ask())
    expect(error.code).toBe('hook.denied')
    expect(error.status).toBe(403)
    expect(error.params).toEqual({ code: 'disposable_email' })
  })

  test('a denial without a code has no params', async () => {
    quietLogs()
    await register()
    respond = answers({ decision: 'deny' })
    const error = await failure(ask())
    expect(error.code).toBe('hook.denied')
    expect(error.params).toBeUndefined()
  })

  test('a denial is not a failure: nothing is noted against the hook, whatever its mode', async () => {
    quietLogs()
    const { id } = await register(tenant, { failureMode: 'allow' })
    respond = answers({ decision: 'deny', code: 'nope' })
    expect((await failure(ask())).code).toBe('hook.denied')
    expect(await stored(id)).toMatchObject({ lastFailedAt: null, lastFailureReason: null })
  })

  const big = JSON.stringify({ decision: 'allow', pad: 'x'.repeat(Hooks.HOOK_MAX_RESPONSE_BYTES) })
  const bad: [name: string, respond: () => Response | Promise<Response>, reason: string][] = [
    ['a 500', answers({ decision: 'allow' }, 500), 'status_not_ok'],
    ['a 404', answers({ decision: 'allow' }, 404), 'status_not_ok'],
    ['a 403 that says deny', answers({ decision: 'deny', code: 'x' }, 403), 'status_not_ok'],
    [
      'a redirect, which is never followed',
      () => new Response(null, { status: 302, headers: { location: receiverUrl() } }),
      'status_not_ok',
    ],
    ['a 204 with no body', () => new Response(null, { status: 204 }), 'answer_invalid'],
    ['a 200 with no body', () => new Response('', { status: 200 }), 'answer_invalid'],
    ['a body that is not JSON', () => new Response('allow'), 'answer_invalid'],
    ['JSON that is cut off', () => new Response('{"decision":"allow"'), 'answer_invalid'],
    [
      'bytes that are not UTF-8',
      () => new Response(new Uint8Array([0xff, 0xfe, 0x7b])),
      'answer_invalid',
    ],
    ['null', answers(null), 'answer_invalid'],
    ['a list', answers([{ decision: 'allow' }]), 'answer_invalid'],
    ['an empty object', answers({}), 'answer_invalid'],
    ['another decision', answers({ decision: 'maybe' }), 'answer_invalid'],
    ['a decision in capitals', answers({ decision: 'ALLOW' }), 'answer_invalid'],
    ['a boolean decision', answers({ decision: true }), 'answer_invalid'],
    ['an allow with a code', answers({ decision: 'allow', code: 'ok' }), 'answer_invalid'],
    [
      'an allow that marks the address verified',
      answers({ decision: 'allow', emailVerified: true }),
      'answer_invalid',
    ],
    [
      'an allow that chooses a user',
      answers({ decision: 'allow', userId: 'u_1' }),
      'answer_invalid',
    ],
    [
      'a denial with a message',
      answers({ decision: 'deny', message: 'Go away' }),
      'answer_invalid',
    ],
    [
      'a denial whose code is a sentence',
      answers({ decision: 'deny', code: 'Not allowed.' }),
      'answer_invalid',
    ],
    [
      'a denial whose code is too long',
      answers({ decision: 'deny', code: 'a'.repeat(65) }),
      'answer_invalid',
    ],
    ['an answer over the size cap', () => new Response(big), 'response_too_large'],
    [
      'an answer over the size cap with a failing status',
      () => new Response(big, { status: 500 }),
      'response_too_large',
    ],
    ['an answer after the deadline', () => Bun.sleep(400).then(allow), 'timeout'],
  ]

  describe.each(bad)('%s', (_name, responder, reason) => {
    test('refuses the sign-up by default, as unavailable and not as denied', async () => {
      quietLogs()
      const { id } = await register()
      respond = responder
      const error = await failure(ask())
      expect(error.code).toBe('hook.unavailable')
      expect(error.status).toBe(503)
      expect(error.params).toBeUndefined()
      expect(received).toHaveLength(1)
      const record = await stored(id)
      expect(record.lastFailureReason).toBe(reason as HookRecord['lastFailureReason'])
      expect(record.lastFailedAt).toEqual(deps.clock.now())
    })

    test('lets it through, and says so, when the hook allows on failure', async () => {
      quietLogs()
      const { id } = await register(tenant, { failureMode: 'allow' })
      respond = responder
      expect(await ask()).toBe('bypassed')
      expect((await stored(id)).lastFailureReason).toBe(reason as HookRecord['lastFailureReason'])
      expect(logged()).toContain(id)
    })
  })

  test('a hook that hangs refuses in bounded time', async () => {
    quietLogs()
    await register()
    respond = () => new Promise<Response>(() => undefined)
    const started = performance.now()
    expect((await failure(ask())).code).toBe('hook.unavailable')
    // A deadline of 100 ms: well inside a second even on a slow runner.
    expect(performance.now() - started).toBeLessThan(1500)
  })

  test('the deadline is the hook’s, and never more than five seconds whatever the row says', async () => {
    const { id } = await register(tenant, { deadlineMs: 4321 })
    const request = spyOn(Outbound, 'request')
    spies.push(request)
    await ask()
    expect(request.mock.calls[0]?.[2]).toMatchObject({
      timeoutMs: 4321,
      maxResponseBytes: Hooks.HOOK_MAX_RESPONSE_BYTES,
      method: 'POST',
    })
    // A row no API wrote (the database refuses it too): the service does not trust it.
    const record = await stored(id)
    spies.push(
      spyOn(deps.hooks, 'findByPoint').mockResolvedValue({ ...record, deadlineMs: 60_000 })
    )
    await ask()
    expect(request.mock.calls[1]?.[2]).toMatchObject({ timeoutMs: 5000 })
  })

  test('an address that passed when saved and is private when called is not called', async () => {
    quietLogs()
    deps.outbound.point('hooks.operator.test', '127.0.0.1')
    const { id } = await register(tenant, { url: receiverUrl('hooks.operator.test') })
    expect(await ask()).toBe('clear')
    expect(received).toHaveLength(1)
    // The name now points inside the operator's network.
    deps.outbound.point('hooks.operator.test', '10.0.0.8')
    expect((await failure(ask())).code).toBe('hook.unavailable')
    expect(received).toHaveLength(1)
    expect((await stored(id)).lastFailureReason).toBe('address_not_allowed')
  })

  test('an endpoint that is not listening fails the call', async () => {
    quietLogs()
    const closed = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() })
    const url = `http://127.0.0.1:${closed.port}/x`
    await closed.stop(true)
    const { id } = await register(tenant, { url })
    expect((await failure(ask())).code).toBe('hook.unavailable')
    expect((await stored(id)).lastFailureReason).toBe('connection_failed')
  })

  describe('a secret that cannot be opened', () => {
    async function broken(failureMode: 'deny' | 'allow') {
      const { id } = await register(tenant, { failureMode })
      const record = await stored(id)
      // Sealed for another hook: what a row copied from elsewhere would hold.
      const foreign = await deps.secretBox.seal(
        Hooks.HOOK_SECRET_PURPOSE,
        new TextEncoder().encode(`whsec_${'A'.repeat(43)}=`),
        `${tenant.environmentId}:${deps.ids.next()}`
      )
      spies.push(spyOn(deps.hooks, 'findByPoint').mockResolvedValue({ ...record, secret: foreign }))
      return id
    }

    test('sends nothing and refuses by default', async () => {
      quietLogs()
      const id = await broken('deny')
      expect((await failure(ask())).code).toBe('hook.unavailable')
      expect(received).toEqual([])
      expect((await stored(id)).lastFailureReason).toBe('secret_unreadable')
    })

    test('sends nothing and lets through when the hook allows on failure', async () => {
      quietLogs()
      await broken('allow')
      expect(await ask()).toBe('bypassed')
      expect(received).toEqual([])
    })
  })

  test('nothing of the answer but the decision and the code is kept, logged or passed on', async () => {
    quietLogs()
    const { id } = await register()
    for (const body of [
      { decision: 'deny', code: 'blocked' },
      { decision: 'allow' },
      { decision: 'allow', note: CANARY },
      CANARY,
    ]) {
      respond = () =>
        new Response(JSON.stringify(body), { headers: { 'x-canary': CANARY, 'retry-after': '7' } })
      const outcome = await ask().then(
        (clearance) => clearance,
        (error: unknown) => error
      )
      const said =
        outcome instanceof ServiceException
          ? JSON.stringify([outcome.code, outcome.params, outcome.message, outcome.internalMessage])
          : String(outcome)
      expect(said).not.toContain(CANARY)
    }
    expect(JSON.stringify(await stored(id))).not.toContain(CANARY)
    expect(JSON.stringify(deps.activityLog.entries)).not.toContain(CANARY)
    expect(JSON.stringify(deps.activityLog.outbox)).not.toContain(CANARY)
    expect(JSON.stringify(await Hooks.get(deps, tenant, id))).not.toContain(CANARY)
    expect(logged()).not.toContain(CANARY)
  })

  test('no log line holds the address that was asked about, the secret or the hook’s address', async () => {
    quietLogs()
    const created = await register()
    for (const body of [{ decision: 'allow' }, { decision: 'deny', code: 'x' }, 'broken']) {
      respond = answers(body)
      await ask().catch(() => undefined)
    }
    const lines = logged()
    expect(lines).toContain(created.id)
    expect(lines).not.toContain('maya@northline.app')
    expect(lines).not.toContain('northline')
    expect(lines).not.toContain('203.0.113.7')
    expect(lines).not.toContain(created.secret)
    expect(lines).not.toContain('before-sign-up')
  })

  test('failing to note a failure changes nothing about the decision', async () => {
    quietLogs()
    await register()
    respond = answers('broken')
    spies.push(spyOn(deps.hooks, 'noteFailure').mockRejectedValue(new Error('database down')))
    expect((await failure(ask())).code).toBe('hook.unavailable')
  })

  test('calls are counted per environment, and one over the cap is refused without a call', async () => {
    await register()
    await register(otherTenant)
    const hit = spyOn(deps.rateLimiter, 'hit')
    spies.push(hit)
    await ask()
    expect(hit.mock.calls).toEqual([
      [Hooks.hookCallsKey(tenant), Hooks.HOOK_CALLS_PER_MINUTE, 60_000],
    ])
    expect(Hooks.HOOK_CALLS_PER_MINUTE).toBe(600)
    expect(Hooks.hookCallsKey(tenant)).not.toBe(Hooks.hookCallsKey(otherTenant))
    hit.mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterMs: 30_000 })
    const refused = await ask().then(
      () => null,
      (error: unknown) => error
    )
    expect(refused).toBeInstanceOf(RateLimitError)
    expect(received).toHaveLength(1)
  })

  test('the cap is not counted where there is no hook to call', async () => {
    const hit = spyOn(deps.rateLimiter, 'hit')
    spies.push(hit)
    await ask()
    await register(tenant, { enabled: false })
    await ask()
    expect(hit).not.toHaveBeenCalled()
  })
})
