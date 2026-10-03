import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from 'bun:test'
import type { FlowAttempt, SessionTokens } from '@tula/contract'
import { cacheSigningKeys } from '~/adapters/cache/signing-keys'
import { redisProbe } from '~/adapters/redis/connection'
import { FakeRedis } from '~/adapters/redis/fake'
import { RedisLockout } from '~/adapters/redis/lockout'
import { RedisRateLimiter } from '~/adapters/redis/rate-limiter'
import { RedisRevokedSessions } from '~/adapters/redis/revoked-sessions'
import { RedisSigningKeyVersions } from '~/adapters/redis/signing-key-versions'
import type { Deps } from '~/dependencies'
import { createApp } from '~/index'
import * as logger from '~/lib/logger'
import { CREDENTIAL_RATE_LIMIT } from '~/modules/flow/router'
import * as Sessions from '~/modules/session/service'
import { CREDENTIAL_LOCKOUT } from '~/ports/lockout'
import { createTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'

const PK = 'tula_pk_dev_publishable0000000000000000000'
const SK = 'tula_sk_dev_admin000000000000000000000000000000'
const EMAIL = 'maya@northline.app'
const PASSWORD = 'correct horse battery staple'
const USER = '00000000-0000-7000-8000-0000000000a1'
const tenant = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }
const UNAVAILABLE = {
  status: 503,
  code: 'service.unavailable',
  detail: 'The service is temporarily unavailable. Try again shortly.',
}

type App = ReturnType<typeof createApp>

/** The stores both instances share, as they share one Postgres. */
let shared: TestDeps
/** The Redis both instances share. */
let redis: FakeRedis
let a: App
let b: App
let depsA: Deps
let error: Mock<typeof logger.error>
let warn: Mock<typeof logger.warn>

/** One API instance: its own adapters and key cache over the shared stores and Redis. */
function instance(overrides: Partial<Deps> = {}): Deps {
  return {
    ...shared,
    rateLimiter: new RedisRateLimiter(redis, shared.clock, shared.keyedHash),
    lockout: new RedisLockout(redis),
    revokedSessions: new RedisRevokedSessions(redis, shared.clock),
    signingKeys: cacheSigningKeys(shared.signingKeys, shared.clock, 60_000, {
      versions: new RedisSigningKeyVersions(redis),
      checkEveryMs: 5_000,
    }),
    probes: [redisProbe(redis)],
    ...overrides,
  }
}

beforeEach(async () => {
  shared = createTestDeps()
  shared.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: shared.clock.now(),
  })
  await seedApiKey(shared, PK)
  await seedApiKey(shared, SK)
  redis = new FakeRedis(shared.clock)
  depsA = instance()
  a = createApp(depsA)
  b = createApp(instance())
  error = spyOn(logger, 'error').mockImplementation(() => {})
  warn = spyOn(logger, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  error.mockRestore()
  warn.mockRestore()
})

interface Options {
  body?: unknown
  accessToken?: string
  secret?: boolean
}

function call(app: App, method: string, path: string, options: Options = {}) {
  const headers: Record<string, string> = options.secret
    ? { authorization: `Bearer ${SK}` }
    : { 'x-tula-publishable-key': PK, 'x-tula-client': 'ios' }
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
  }
  if (options.accessToken) {
    headers.authorization = `Bearer ${options.accessToken}`
  }
  return app.request(`/v1${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
}

const post = (app: App, path: string, body: unknown = {}) =>
  call(app, 'POST', `/client${path}`, { body })
const json = async <T>(res: Response) => (await res.json()) as T
const code = async (res: Response) => (await json<{ code: string }>(res)).code
const sentCode = () => /\b(\d{6})\b/.exec(shared.mailer.last().text)?.[1] ?? ''
const signIn = () =>
  Sessions.create(depsA, tenant, { userId: USER, client: 'ios', userAgent: null, ipAddress: null })
const sessions = (app: App, tokens: SessionTokens) =>
  call(app, 'GET', '/client/sessions', { accessToken: tokens.accessToken })

async function register(): Promise<void> {
  const started = await json<FlowAttempt>(
    await post(a, '/sign-ups', { email: EMAIL, password: PASSWORD })
  )
  const verified = await post(a, `/sign-ups/${started.id}/verify-email`, { code: sentCode() })
  expect(verified.status).toBe(200)
}

async function guess(app: App, password: string): Promise<Response> {
  const attempt = await json<FlowAttempt>(await post(app, '/sign-ins', { identifier: EMAIL }))
  return post(app, `/sign-ins/${attempt.id}/password`, { password })
}

async function expectUnavailable(res: Response): Promise<void> {
  expect(res.status).toBe(503)
  const text = await res.text()
  // The contract envelope and nothing else: no stack, no hint of what is behind the API.
  expect(JSON.parse(text)).toEqual(UNAVAILABLE)
  expect(text).not.toMatch(/redis|stack|EVAL/i)
}

describe('two instances sharing one Redis', () => {
  test('password guesses are counted once each, whichever instance receives them', async () => {
    await register()
    const statuses: number[] = []
    for (let i = 0; i < CREDENTIAL_LOCKOUT.freeAttempts + 2; i++) {
      statuses.push((await guess(i % 2 === 0 ? a : b, 'not the password')).status)
    }
    // Five free tries and the one that starts the wait, across both instances together: counted
    // per instance there would be twice as many.
    expect(statuses).toEqual([401, 401, 401, 401, 401, 401, 429])
    // Locked on both, even for the right password.
    expect((await guess(a, PASSWORD)).status).toBe(429)
    expect((await guess(b, PASSWORD)).status).toBe(429)
    shared.clock.advance('30s')
    expect((await guess(b, PASSWORD)).status).toBe(200)
  })

  test('a successful sign-in on one instance clears the failures counted by the other', async () => {
    await register()
    for (let i = 0; i < CREDENTIAL_LOCKOUT.freeAttempts - 1; i++) {
      expect((await guess(a, 'not the password')).status).toBe(401)
    }
    expect((await guess(b, PASSWORD)).status).toBe(200)
    for (let i = 0; i < CREDENTIAL_LOCKOUT.freeAttempts; i++) {
      expect((await guess(a, 'not the password')).status).toBe(401)
    }
  })

  test('a per-IP limit is one budget for both instances', async () => {
    const statuses: number[] = []
    for (let i = 0; i < CREDENTIAL_RATE_LIMIT + 2; i++) {
      const res = await post(i % 2 === 0 ? a : b, '/sign-ins', { identifier: `u${i}@example.com` })
      statuses.push(res.status)
    }
    expect(statuses.filter((status) => status === 200)).toHaveLength(CREDENTIAL_RATE_LIMIT)
    expect(statuses.slice(-2)).toEqual([429, 429])
  })

  test('a session signed out on one instance is refused by the other at once', async () => {
    const tokens = await signIn()
    expect((await sessions(b, tokens)).status).toBe(200)
    const signedOut = await post(a, '/sessions/sign-out', { refreshToken: tokens.refreshToken })
    expect(signedOut.status).toBe(204)
    const refused = await sessions(b, tokens)
    expect(refused.status).toBe(401)
    expect(await code(refused)).toBe('session.revoked')
  })

  test('readiness reports Redis', async () => {
    const res = await a.request('/v1/ready')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ready', checks: { redis: 'ok' } })
  })

  test('nothing personal is written to Redis by a sign-up, sign-in and sign-out', async () => {
    await register()
    await guess(a, 'not the password')
    const tokens = await signIn()
    await post(b, '/sessions/sign-out', { refreshToken: tokens.refreshToken })
    const keys = redis.keys().join('\n')
    expect(redis.keys().length).toBeGreaterThan(3)
    expect(keys).not.toContain('maya')
    expect(keys).not.toContain('northline')
    expect(keys).not.toContain('127.0.0.1')
    expect(keys).not.toContain('unknown')
    for (const key of redis.keys()) {
      expect(key).toMatch(/^tula:(rl|lo|rs|sk):/)
    }
  })
})

describe('when Redis is down', () => {
  test('credential routes answer the 503 envelope, not a 500', async () => {
    await register()
    const attempt = await json<FlowAttempt>(await post(a, '/sign-ins', { identifier: EMAIL }))
    redis.fail()
    await expectUnavailable(await post(a, '/sign-ins', { identifier: EMAIL }))
    await expectUnavailable(
      await post(a, '/sign-ups', { email: 'new@example.com', password: PASSWORD })
    )
    await expectUnavailable(await post(a, '/password-resets', { email: EMAIL }))
    // Not even the right password is checked while attempts cannot be counted.
    const refused = await post(a, `/sign-ins/${attempt.id}/password`, { password: PASSWORD })
    expect(refused.headers.get('set-cookie')).toBeNull()
    await expectUnavailable(refused)

    redis.recover()
    expect((await post(a, `/sign-ins/${attempt.id}/password`, { password: PASSWORD })).status).toBe(
      200
    )
  })

  test('the failure is logged with the error name and code, never a connection string', async () => {
    redis.fail(
      Object.assign(new Error('connect redis://:hunter2@cache.internal:6379 refused'), {
        name: 'RedisError',
        code: 'ERR_REDIS_CONNECTION_CLOSED',
      })
    )
    await post(a, '/sign-ins', { identifier: EMAIL })
    expect(error).toHaveBeenCalledTimes(1)
    const [message, context] = error.mock.calls[0] ?? []
    expect(message).toBe('request failed')
    expect(context).toMatchObject({
      code: 'service.unavailable',
      internalMessage: 'redis EVAL failed: RedisError ERR_REDIS_CONNECTION_CLOSED',
    })
    expect(JSON.stringify(context)).not.toContain('hunter2')
    expect(JSON.stringify(context)).not.toContain('cache.internal')
  })

  test('the lockout alone being unreachable also refuses the password step', async () => {
    await register()
    const lockoutRedis = new FakeRedis(shared.clock)
    const app = createApp(
      instance({ rateLimiter: shared.rateLimiter, lockout: new RedisLockout(lockoutRedis) })
    )
    const attempt = await json<FlowAttempt>(await post(app, '/sign-ins', { identifier: EMAIL }))
    lockoutRedis.fail()
    await expectUnavailable(
      await post(app, `/sign-ins/${attempt.id}/password`, { password: PASSWORD })
    )
  })

  test('an access token is not accepted while revocation cannot be checked', async () => {
    const tokens = await signIn()
    redis.fail()
    await expectUnavailable(await sessions(a, tokens))
    await expectUnavailable(await sessions(b, tokens))
    redis.recover()
    expect((await sessions(b, tokens)).status).toBe(200)
  })

  test('refresh keeps working: it needs only the database', async () => {
    const tokens = await signIn()
    redis.fail()
    const res = await post(b, '/sessions/refresh', { refreshToken: tokens.refreshToken })
    expect(res.status).toBe(200)
    const next = await json<SessionTokens>(res)
    expect(next.sessionId).toBe(tokens.sessionId)
    expect(next.refreshToken).not.toBe(tokens.refreshToken)
    expect(warn.mock.calls.map(([message, context]) => [message, context?.rule])).toEqual([
      ['rate limiter unavailable; request allowed uncounted', 'client'],
      ['rate limiter unavailable; request allowed uncounted', 'session_refresh'],
    ])
  })

  test('a reused refresh token is still refused', async () => {
    const tokens = await signIn()
    await post(a, '/sessions/refresh', { refreshToken: tokens.refreshToken })
    shared.clock.advance('1m')
    redis.fail()
    // Revoking the family needs the denylist, so the request is refused rather than answered
    // with tokens; the family is revoked the next time the token is presented.
    await expectUnavailable(
      await post(b, '/sessions/refresh', { refreshToken: tokens.refreshToken })
    )
    redis.recover()
    const res = await post(b, '/sessions/refresh', { refreshToken: tokens.refreshToken })
    expect(await code(res)).toBe('session.reuse_detected')
  })

  test('sign-out is refused rather than half done, and works once Redis is back', async () => {
    const tokens = await signIn()
    redis.fail()
    await expectUnavailable(
      await post(a, '/sessions/sign-out', { refreshToken: tokens.refreshToken })
    )
    const stored = await shared.sessions.findById(tenant.environmentId, tokens.sessionId)
    expect(stored?.revokedAt).toBeNull()
    redis.recover()
    expect(
      (await post(a, '/sessions/sign-out', { refreshToken: tokens.refreshToken })).status
    ).toBe(204)
    expect(await code(await sessions(b, tokens))).toBe('session.revoked')
  })

  test('admin routes are refused', async () => {
    expect((await call(a, 'GET', '/admin/users', { secret: true })).status).toBe(200)
    redis.fail()
    await expectUnavailable(await call(a, 'GET', '/admin/users', { secret: true }))
  })

  test('readiness says which dependency failed, and the public keys are still served', async () => {
    await signIn()
    redis.fail()
    const ready = await a.request('/v1/ready')
    expect(ready.status).toBe(503)
    expect(await ready.json()).toEqual({ status: 'not_ready', checks: { redis: 'fail' } })
    const jwks = await a.request(
      `/v1/environments/${TEST_TENANT.environmentId}/.well-known/jwks.json`
    )
    expect(jwks.status).toBe(200)
    expect((await json<{ keys: unknown[] }>(jwks)).keys.length).toBeGreaterThan(0)
    expect((await a.request('/v1/status')).status).toBe(200)
  })

  test('requests refused during the outage were not counted against anyone', async () => {
    await register()
    redis.fail()
    for (let i = 0; i < 20; i++) {
      expect((await guess(a, 'not the password')).status).toBe(503)
    }
    redis.recover()
    expect((await guess(a, PASSWORD)).status).toBe(200)
  })
})
