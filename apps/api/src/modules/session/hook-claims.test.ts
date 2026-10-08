import { afterAll, afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from 'bun:test'
import {
  type AccessTokenClaims,
  DEFAULT_ENVIRONMENT_SETTINGS,
  EnvironmentSettingsSchema,
  HOOK_QUESTION_SCHEMAS,
  MAX_CUSTOM_CLAIMS_BYTES,
} from '@tula/contract'
import { decodeJwt } from 'jose'
import type { Tenant } from '~/dependencies'
import { RateLimitError, ServiceException } from '~/exceptions'
import * as logger from '~/lib/logger'
import * as Audit from '~/modules/audit/service'
import * as Hooks from '~/modules/hook/service'
import * as Sessions from '~/modules/session/service'
import { createTestDeps, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'

// The `before_token` hook as the session service asks it (ADR 0035, "Hooks before a session
// and before a token"): when a session is created and when its user proves a factor again,
// and at no other time. The receiver is a listener in this process, reached through the real
// outbound guard. What an answer may be is `modules/hook/points.test.ts`.

const tenant: Tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}
const otherTenant: Tenant = { ...tenant, environmentId: TEST_TENANT.productionEnvironmentId }
const USER = '00000000-0000-7000-8000-0000000000a1'
const CANARY = 'canary-7c1d-claims'

let received: { path: string; body: string }[] = []
let respond: (req: Request) => Response | Promise<Response> = () => Response.json({ claims: {} })
const listener = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    received.push({ path: new URL(req.url).pathname, body: await req.text() })
    return respond(req)
  },
})
afterAll(() => listener.stop(true))

const claims = (value: Record<string, unknown>) => () => Response.json({ claims: value })
const raw = (text: string) => () =>
  new Response(text, { headers: { 'content-type': 'application/json' } })
const hang = () => new Promise<Response>(() => undefined)

let deps: TestDeps
let revision = 0
let spies: Mock<(...args: never[]) => unknown>[] = []

beforeEach(async () => {
  received = []
  revision = 0
  respond = claims({ plan: 'pro', seats: 5 })
  deps = createTestDeps()
  for (const [id, kind] of [
    [TEST_TENANT.environmentId, 'development'],
    [TEST_TENANT.productionEnvironmentId, 'production'],
  ] as const) {
    deps.environments.add({
      id,
      projectId: TEST_TENANT.projectId,
      kind,
      createdAt: deps.clock.now(),
    })
  }
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    spies.push(spyOn(logger, level).mockImplementation(() => undefined))
  }
  await deps.users.create(
    {
      id: USER,
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      email: 'maya@northline.app',
      emailNormalized: 'maya@northline.app',
      emailVerifiedAt: deps.clock.now(),
      firstName: null,
      lastName: null,
      createdAt: deps.clock.now(),
      identityId: deps.ids.next(),
      credentialId: deps.ids.next(),
      passwordHash: 'hash',
    },
    Audit.none('fixture')
  )
})

afterEach(() => {
  for (const spy of spies) {
    spy.mockRestore()
  }
  spies = []
})

const logged = () => JSON.stringify(spies.flatMap((spy) => spy.mock.calls))

function configure(sessions: unknown, target: Tenant = tenant): void {
  const settings = EnvironmentSettingsSchema.parse({ ...DEFAULT_ENVIRONMENT_SETTINGS, sessions })
  revision += 1
  deps.environmentSettings.seed(target.environmentId, { revision, settings })
}

function register(input: Partial<Parameters<typeof Hooks.create>[2]> = {}, scope = tenant) {
  return Hooks.create(
    deps,
    scope,
    {
      point: 'before_token',
      url: `http://127.0.0.1:${listener.port}/tula/before-token`,
      enabled: true,
      deadlineMs: 100,
      failureMode: 'deny',
      ...input,
    },
    TEST_ACTOR
  )
}

const create = (input: Partial<Sessions.CreateInput> = {}, scope = tenant) =>
  Sessions.create(deps, scope, { userId: USER, client: 'web', authMethods: ['pwd'], ...input })

function decoded(tokens: { accessToken?: string }): AccessTokenClaims {
  if (!tokens.accessToken) {
    throw new Error('expected an access token')
  }
  return decodeJwt<AccessTokenClaims>(tokens.accessToken)
}

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

const row = async (sessionId: string) => {
  const found = await deps.sessions.findById(tenant.environmentId, sessionId)
  if (!found) {
    throw new Error('the session is gone')
  }
  return found
}
const questions = () => received.map((request) => JSON.parse(request.body))
const stepUp = (sessionId: string, methods: readonly ('otp' | 'mfa' | 'pwd')[] = ['otp', 'mfa']) =>
  Sessions.recordAuthentication(deps, tenant, { userId: USER, sessionId }, methods, TEST_ACTOR)
const created = () => deps.activityLog.ofType('session.created')
const steppedUp = () => deps.activityLog.ofType('session.stepped_up')

describe('when a session is created', () => {
  test('the hook is asked once, about the session that is about to exist, and its claims are issued', async () => {
    await register()
    const tokens = await create({ ipAddress: '203.0.113.7', userAgent: `Mozilla ${CANARY}` })
    expect(received).toHaveLength(1)
    const [question] = questions()
    expect(HOOK_QUESTION_SCHEMAS.before_token.safeParse(question).success).toBe(true)
    expect(question.type).toBe('hook.before_token')
    expect(question.data).toEqual({
      userId: USER,
      sessionId: tokens.sessionId,
      client: 'web',
      profile: 'web',
      amr: ['pwd'],
    })
    expect(received[0]?.body).not.toContain(CANARY)
    expect(received[0]?.body).not.toContain('203.0.113.7')
    expect(received[0]?.body).not.toContain('northline')
    expect(decoded(tokens).ext).toEqual({ plan: 'pro', seats: 5 })
    expect((await row(tokens.sessionId)).hookClaims).toEqual({ plan: 'pro', seats: 5 })
    expect(created()[0]?.data).toEqual({ userId: USER, client: 'web' })
  })

  test('without a hook nothing is asked, nothing is stored and the token is what it always was', async () => {
    const tokens = await create()
    expect(received).toEqual([])
    expect(decoded(tokens)).not.toHaveProperty('ext')
    expect((await row(tokens.sessionId)).hookClaims).toBeNull()
  })

  test.each([
    ['a hook that is off', () => register({ enabled: false })],
    ['another environment’s hook', () => register({}, otherTenant)],
    ['a hook of another point', () => register({ point: 'before_session' }).then(() => undefined)],
  ])('%s is not asked for claims', async (_name, arrange) => {
    await arrange()
    respond = () => Response.json({ decision: 'allow', claims: { plan: 'pro' } })
    const tokens = await create()
    expect(received).toEqual([])
    expect(decoded(tokens)).not.toHaveProperty('ext')
  })

  test('an answer with no claims is a session without them, and not a failure', async () => {
    const hook = await register()
    respond = claims({})
    const tokens = await create()
    expect(decoded(tokens)).not.toHaveProperty('ext')
    expect((await row(tokens.sessionId)).hookClaims).toBeNull()
    expect((await deps.hooks.find(tenant.environmentId, hook.id))?.lastFailedAt).toBeNull()
    expect(created()[0]?.data).toEqual({ userId: USER, client: 'web' })
  })

  test('its claims are merged with the template’s, and the hook’s win a key both set', async () => {
    configure({
      jwtTemplates: {
        app: { claims: { role: { value: 'member' }, client: { from: 'session.client' } } },
      },
      profiles: { web: { jwtTemplate: 'app' } },
    })
    await register()
    respond = claims({ role: 'owner', plan: 'pro' })
    const tokens = await create()
    expect(decoded(tokens).ext).toEqual({ role: 'owner', client: 'web', plan: 'pro' })
    // Only the hook's own claims are stored: the template's are read at every issue.
    expect((await row(tokens.sessionId)).hookClaims).toEqual({ role: 'owner', plan: 'pro' })
  })

  test('the profile in the question is the one the session got', async () => {
    configure({ profiles: { kiosk: { clientSelectable: true, idleTimeout: '1h' } } })
    await register()
    await create({ profile: 'kiosk' })
    await create({ profile: 'nope', client: 'ios' })
    expect(questions().map((question) => question.data.profile)).toEqual(['kiosk', 'mobile'])
  })
})

describe('a claims hook is not an authority', () => {
  const baseline = async () => {
    // The token of a session made with no hook at all, to compare with.
    const plain = decoded(await create())
    await Sessions.revokeAllForUser(deps, tenant, USER, 'revoked_by_user', TEST_ACTOR)
    return plain
  }

  test.each([
    [
      'a reserved claim',
      '{"claims":{"sub":"00000000-0000-7000-8000-0000000000ff"}}',
      'claims_invalid',
    ],
    ['the methods', '{"claims":{"amr":"mfa"}}', 'claims_invalid'],
    ['the methods as a list', '{"claims":{"plan":"pro","amr":["mfa"]}}', 'claims_invalid'],
    ['a prototype key', '{"claims":{"__proto__":{"admin":true},"plan":"pro"}}', 'claims_invalid'],
    ['a nested value', '{"claims":{"plan":{"tier":"pro"}}}', 'claims_invalid'],
    ['a null value', '{"claims":{"plan":null}}', 'claims_invalid'],
    ['a malformed key', '{"claims":{"my-plan":"pro"}}', 'claims_invalid'],
    [
      'a verified address beside the claims',
      '{"claims":{"plan":"pro"},"emailVerified":true}',
      'answer_invalid',
    ],
    ['a user beside the claims', '{"claims":{"plan":"pro"},"userId":"x"}', 'answer_invalid'],
    [
      'a decision beside the claims',
      '{"claims":{"plan":"pro"},"decision":"allow"}',
      'answer_invalid',
    ],
    ['a decision instead of claims', '{"decision":"allow"}', 'answer_invalid'],
    [
      'claims over the cap',
      `{"claims":{"big":"${'x'.repeat(MAX_CUSTOM_CLAIMS_BYTES)}"}}`,
      'claims_too_large',
    ],
  ])(
    '%s fails the call: refused by default, and nothing of the answer kept when let through',
    async (_name, body, reason) => {
      const plain = await baseline()
      const hook = await register()
      respond = raw(body)

      const refused = await failure(create())
      expect(refused.code).toBe('hook.unavailable')
      expect(refused.status).toBe(503)
      expect(
        await deps.sessions.listActiveByUser(tenant.environmentId, USER, deps.clock.now())
      ).toEqual([])
      expect(created()).toHaveLength(1)
      const noted = await deps.hooks.find(tenant.environmentId, hook.id)
      expect(String(noted?.lastFailureReason)).toBe(reason)

      await Hooks.update(deps, tenant, hook.id, { failureMode: 'allow' }, TEST_ACTOR)
      const tokens = await create()
      const { sid: _sid, ...through } = decoded(tokens)
      const { sid: _plain, ...expected } = plain
      // Not one claim of a bad answer, also not its good ones: the token is the one a session
      // without a hook gets.
      expect(through).toEqual(expected)
      const session = await row(tokens.sessionId)
      expect(session.hookClaims).toBeNull()
      expect(session.userId).toBe(USER)
      expect(session.authMethods).toEqual(['pwd'])
      expect(created()[1]?.data).toEqual({ userId: USER, client: 'web', claimsHookBypassed: true })
      expect((await deps.users.findById(tenant.environmentId, USER))?.emailVerifiedAt).toEqual(
        deps.clock.now()
      )
    }
  )

  test('claims that fit alone and not beside the template’s are a failure, never cut to fit', async () => {
    configure({
      jwtTemplates: { app: { claims: { note: { value: 'n'.repeat(200) } } } },
      profiles: { web: { jwtTemplate: 'app' } },
    })
    const hook = await register()
    respond = claims({ big: 'x'.repeat(MAX_CUSTOM_CLAIMS_BYTES - 100) })
    expect((await failure(create())).code).toBe('hook.unavailable')
    expect((await deps.hooks.find(tenant.environmentId, hook.id))?.lastFailureReason).toBe(
      'claims_too_large'
    )
    expect(created()).toEqual([])

    await Hooks.update(deps, tenant, hook.id, { failureMode: 'allow' }, TEST_ACTOR)
    const tokens = await create()
    // The template's claims stay: only the hook's are left out.
    expect(decoded(tokens).ext).toEqual({ note: 'n'.repeat(200) })
    expect((await row(tokens.sessionId)).hookClaims).toBeNull()
  })

  test('nothing of a bad answer reaches a log line or the hook’s row', async () => {
    const hook = await register()
    respond = raw(`{"claims":{"sub":"${CANARY}"},"${CANARY}":1}`)
    await failure(create())
    expect(logged()).not.toContain(CANARY)
    expect(JSON.stringify(await deps.hooks.find(tenant.environmentId, hook.id))).not.toContain(
      CANARY
    )
    expect(JSON.stringify(deps.activityLog.entries)).not.toContain(CANARY)
  })
})

describe('a claims hook that fails', () => {
  test('one that hangs fails the sign-in within its deadline and is noted on the hook', async () => {
    const hook = await register()
    respond = hang
    const started = performance.now()
    const refused = await failure(create())
    expect(performance.now() - started).toBeLessThan(1500)
    expect(refused.code).toBe('hook.unavailable')
    expect(created()).toEqual([])
    expect(
      await deps.sessions.listActiveByUser(tenant.environmentId, USER, deps.clock.now())
    ).toEqual([])
    const noted = await deps.hooks.find(tenant.environmentId, hook.id)
    expect(noted?.lastFailureReason).toBe('timeout')
    expect(noted?.lastFailedAt).toEqual(deps.clock.now())
  })

  test('under “allow” the session is made without its claims and says so', async () => {
    await register({ failureMode: 'allow' })
    respond = () => new Response('down', { status: 500 })
    const tokens = await create()
    expect(decoded(tokens)).not.toHaveProperty('ext')
    expect(created()[0]?.data).toEqual({ userId: USER, client: 'web', claimsHookBypassed: true })
  })

  test('over the environment’s ceiling nothing is asked and no session is made, whatever the failure mode', async () => {
    await register({ failureMode: 'allow' })
    for (let used = 0; used < Hooks.HOOK_SESSION_CALLS_PER_MINUTE; used++) {
      await deps.rateLimiter.hit(Hooks.hookCallsKey(tenant, 'before_token'), 1e9, 60_000)
    }
    await expect(create()).rejects.toBeInstanceOf(RateLimitError)
    expect(received).toEqual([])
    expect(created()).toEqual([])
  })

  test('what the sign-in passed about the session hook is recorded beside it', async () => {
    const tokens = await create({ hookBypassed: true })
    expect(created()[0]?.data).toEqual({ userId: USER, client: 'web', hookBypassed: true })
    expect(decoded(tokens)).not.toHaveProperty('hookBypassed')
  })
})

describe('a refresh', () => {
  test('issues the stored claims and asks nothing, also when the hook would now say otherwise', async () => {
    await register()
    const first = await create()
    respond = claims({ plan: 'free' })
    deps.clock.advance('2m')
    const second = await Sessions.refresh(deps, tenant, first.refreshToken ?? '')
    expect(decoded(second).ext).toEqual({ plan: 'pro', seats: 5 })
    deps.clock.advance('2m')
    const third = await Sessions.refresh(deps, tenant, second.refreshToken ?? '')
    expect(decoded(third).ext).toEqual({ plan: 'pro', seats: 5 })
    expect(received).toHaveLength(1)
  })

  test('replayed inside the grace window asks nothing either', async () => {
    await register()
    const first = await create()
    await Sessions.refresh(deps, tenant, first.refreshToken ?? '')
    deps.clock.advance('2s')
    const replayed = await Sessions.refresh(deps, tenant, first.refreshToken ?? '')
    expect(decoded(replayed).ext).toEqual({ plan: 'pro', seats: 5 })
    expect(received).toHaveLength(1)
  })

  test('never reads the hooks at all', async () => {
    await register()
    const first = await create()
    const find = spyOn(deps.hooks, 'findByPoint')
    await Sessions.refresh(deps, tenant, first.refreshToken ?? '')
    await Sessions.refresh(deps, tenant, first.refreshToken ?? '')
    expect(find).not.toHaveBeenCalled()
    find.mockRestore()
  })

  test('a hook that is down, off or removed does not fail it, and the session keeps its claims', async () => {
    const hook = await register()
    const first = await create()
    respond = hang
    const second = await Sessions.refresh(deps, tenant, first.refreshToken ?? '')
    expect(decoded(second).ext).toEqual({ plan: 'pro', seats: 5 })
    await Hooks.remove(deps, tenant, hook.id, TEST_ACTOR)
    deps.clock.advance('2m')
    const third = await Sessions.refresh(deps, tenant, second.refreshToken ?? '')
    expect(decoded(third).ext).toEqual({ plan: 'pro', seats: 5 })
    expect(received).toHaveLength(1)
  })

  test('reads the template as it is now beside the stored claims', async () => {
    await register()
    const first = await create()
    configure({
      jwtTemplates: { app: { claims: { role: { value: 'member' }, plan: { value: 'free' } } } },
      profiles: { web: { jwtTemplate: 'app' } },
    })
    const second = await Sessions.refresh(deps, tenant, first.refreshToken ?? '')
    expect(decoded(second).ext).toEqual({ role: 'member', plan: 'pro', seats: 5 })
  })
})

describe('claims as they are stored', () => {
  test.each([
    ['a reserved key', { sub: 'someone-else', plan: 'pro' }],
    ['a nested value', { plan: { tier: 'pro' } }],
    ['a malformed key', { 'my-plan': 'pro' }],
    ['more than the cap', { big: 'x'.repeat(MAX_CUSTOM_CLAIMS_BYTES) }],
  ])(
    '%s in the row is dropped whole when read, and the refresh still answers',
    async (_name, bad) => {
      configure({
        jwtTemplates: { app: { claims: { role: { value: 'member' } } } },
        profiles: { web: { jwtTemplate: 'app' } },
      })
      const first = await create()
      // Written past the service, as a row from a restored backup or another version would be.
      await deps.sessions.recordAuthentication(
        tenant.environmentId,
        first.sessionId,
        { at: deps.clock.now(), methods: [], hookClaims: { claims: bad } },
        Audit.none('fixture')
      )
      const second = await Sessions.refresh(deps, tenant, first.refreshToken ?? '')
      expect(decoded(second).ext).toEqual({ role: 'member' })
      expect(decoded(second).sub).toBe(USER)
      const warned = logged()
      expect(warned).toContain(first.sessionId)
      expect(warned).not.toContain('someone-else')
    }
  )

  test('a stateful session’s check drops them too', async () => {
    configure({ profiles: { web: { type: 'stateful' } } })
    const first = await create()
    await deps.sessions.recordAuthentication(
      tenant.environmentId,
      first.sessionId,
      { at: deps.clock.now(), methods: [], hookClaims: { claims: { amr: 'mfa', plan: 'pro' } } },
      Audit.none('fixture')
    )
    const answer = await Sessions.authenticate(deps, tenant, first.sessionToken ?? '')
    expect(answer).not.toHaveProperty('ext')
    expect(answer.amr).toEqual(['pwd'])
  })
})

describe('a stateful session', () => {
  beforeEach(() => configure({ profiles: { web: { type: 'stateful' } } }))

  test('is asked for at creation and answers every check with the stored claims, asking nothing', async () => {
    await register()
    const tokens = await create()
    expect(tokens.accessToken).toBeUndefined()
    expect(received).toHaveLength(1)
    respond = claims({ plan: 'free' })
    const first = await Sessions.authenticate(deps, tenant, tokens.sessionToken ?? '')
    deps.clock.advance('5m')
    const second = await Sessions.authenticate(deps, tenant, tokens.sessionToken ?? '')
    expect(first.ext).toEqual({ plan: 'pro', seats: 5 })
    expect(second.ext).toEqual({ plan: 'pro', seats: 5 })
    expect(received).toHaveLength(1)
  })

  test('a failing hook refuses it like any other session', async () => {
    await register()
    respond = hang
    expect((await failure(create())).code).toBe('hook.unavailable')
    expect(created()).toEqual([])
  })

  test('a step-up replaces its claims for the next check', async () => {
    await register()
    const tokens = await create()
    respond = claims({ plan: 'pro', elevated: true })
    await stepUp(tokens.sessionId)
    const answer = await Sessions.authenticate(deps, tenant, tokens.sessionToken ?? '')
    expect(answer.ext).toEqual({ plan: 'pro', elevated: true })
    expect(received).toHaveLength(2)
  })
})

describe('when a session’s user proves a factor again', () => {
  test('the hook is asked again with what the session has now proven, and its answer replaces the stored one', async () => {
    await register()
    const tokens = await create()
    respond = claims({ elevated: true })
    deps.clock.advance('3m')
    const stepped = await stepUp(tokens.sessionId)
    expect(questions()[1]?.data).toEqual({
      userId: USER,
      sessionId: tokens.sessionId,
      client: 'web',
      profile: 'web',
      amr: ['pwd', 'otp', 'mfa'],
    })
    // Replaced, not merged: `plan` and `seats` were the answer about a session that had
    // proven less.
    expect(decoded(stepped).ext).toEqual({ elevated: true })
    expect((await row(tokens.sessionId)).hookClaims).toEqual({ elevated: true })
    expect(steppedUp()[0]?.data).toEqual({ userId: USER, methods: ['otp', 'mfa'] })
    const refreshed = await Sessions.refresh(deps, tenant, tokens.refreshToken ?? '')
    expect(decoded(refreshed).ext).toEqual({ elevated: true })
    expect(received).toHaveLength(2)
  })

  test('a failure refuses the step-up by default and changes nothing about the session', async () => {
    await register()
    const tokens = await create()
    const before = await row(tokens.sessionId)
    deps.clock.advance('3m')
    respond = hang
    const refused = await failure(stepUp(tokens.sessionId))
    expect(refused.code).toBe('hook.unavailable')
    expect(await row(tokens.sessionId)).toEqual(before)
    expect(steppedUp()).toEqual([])
    const refreshed = await Sessions.refresh(deps, tenant, tokens.refreshToken ?? '')
    expect(decoded(refreshed).amr).toEqual(['pwd'])
    expect(decoded(refreshed).ext).toEqual({ plan: 'pro', seats: 5 })
  })

  test('under “allow” a failure steps up, clears the claims and says so', async () => {
    const hook = await register()
    const tokens = await create()
    await Hooks.update(deps, tenant, hook.id, { failureMode: 'allow' }, TEST_ACTOR)
    respond = raw('{"claims":{"sub":"x"}}')
    const stepped = await stepUp(tokens.sessionId)
    expect(decoded(stepped).amr).toEqual(['pwd', 'otp', 'mfa'])
    // Not kept: they were the answer about a session that had proven less.
    expect(decoded(stepped)).not.toHaveProperty('ext')
    expect((await row(tokens.sessionId)).hookClaims).toBeNull()
    expect(steppedUp()[0]?.data).toEqual({
      userId: USER,
      methods: ['otp', 'mfa'],
      claimsHookBypassed: true,
    })
  })

  test('with the hook gone since the sign-in, the claims it gave go too', async () => {
    const hook = await register()
    const tokens = await create()
    await Hooks.remove(deps, tenant, hook.id, TEST_ACTOR)
    const stepped = await stepUp(tokens.sessionId)
    expect(decoded(stepped)).not.toHaveProperty('ext')
    expect((await row(tokens.sessionId)).hookClaims).toBeNull()
    expect(received).toHaveLength(1)
  })

  test('an ended session, or another user’s, asks nothing', async () => {
    await register()
    const tokens = await create()
    received = []
    const other = Sessions.recordAuthentication(
      deps,
      tenant,
      { userId: '00000000-0000-7000-8000-0000000000b2', sessionId: tokens.sessionId },
      ['otp', 'mfa'],
      TEST_ACTOR
    )
    expect((await failure(other)).code).toBe('session.revoked')
    await Sessions.revoke(deps, tenant, {
      userId: USER,
      sessionId: tokens.sessionId,
      actor: TEST_ACTOR,
    })
    expect((await failure(stepUp(tokens.sessionId))).code).toBe('session.revoked')
    expect(received).toEqual([])
  })

  test('claims asked about methods that moved meanwhile are never stored: the hook is asked again', async () => {
    await register()
    const tokens = await create()
    let calls = 0
    respond = async (req) => {
      void req
      calls += 1
      if (calls === 1) {
        // Another step-up of the same session lands while the hook is thinking.
        await deps.sessions.recordAuthentication(
          tenant.environmentId,
          tokens.sessionId,
          { at: deps.clock.now(), methods: ['email'], hookClaims: { claims: null } },
          Audit.none('fixture')
        )
        return Response.json({ claims: { stale: true } })
      }
      return Response.json({ claims: { fresh: true } })
    }
    const stepped = await stepUp(tokens.sessionId)
    expect(questions().map((question) => question.data.amr)).toEqual([
      ['pwd'],
      ['pwd', 'otp', 'mfa'],
      ['pwd', 'email', 'otp', 'mfa'],
    ])
    expect(decoded(stepped).ext).toEqual({ fresh: true })
    expect((await row(tokens.sessionId)).hookClaims).toEqual({ fresh: true })
    expect(steppedUp()).toHaveLength(1)
  })
})
