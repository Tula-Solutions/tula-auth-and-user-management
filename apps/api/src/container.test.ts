import { describe, expect, spyOn, test } from 'bun:test'
import { PASSWORD_POLICY_PRESETS } from '@tula/contract'
import { HibpBreachChecker } from '~/adapters/breach/hibp'
import { offlineBreachChecker } from '~/adapters/breach/offline'
import { SmtpMailer } from '~/adapters/mail/smtp'
import { MemoryLockout } from '~/adapters/memory/lockout'
import { MemoryRateLimiter } from '~/adapters/memory/rate-limiter'
import { MemoryRevokedSessions } from '~/adapters/memory/revoked-sessions'
import { PostgresVerificationTokenStore } from '~/adapters/postgres/verification-tokens'
import { RedisLockout } from '~/adapters/redis/lockout'
import { RedisRateLimiter } from '~/adapters/redis/rate-limiter'
import { RedisRevokedSessions } from '~/adapters/redis/revoked-sessions'
import { createContainer } from '~/container'
import { parseEnv } from '~/env'
import * as logger from '~/lib/logger'

const base = {
  ENVIRONMENT: 'dev',
  // Nothing listens here: building the container must not open a connection.
  DATABASE_URL: 'postgres://tula_api:tula_api@127.0.0.1:1/tula',
  TULA_MASTER_KEY: 'a'.repeat(64),
  // No dashboard here, whether or not this checkout has built one.
  DASHBOARD_DIR: '/nonexistent/tula-dashboard',
}

describe('createContainer', () => {
  test('wires production adapters from env without connecting', async () => {
    const env = parseEnv({
      ...base,
      CORS_ORIGINS: 'https://app.test',
      TRUST_PROXY: 'true',
      PASSWORD_POLICY: 'strict',
      BREACH_CHECK: 'hibp',
    })
    const { deps, close } = createContainer(env)
    expect(deps.config).toEqual({
      tier: 'dev',
      publicUrl: 'http://localhost:3003',
      corsOrigins: ['https://app.test'],
      trustProxy: true,
      passwordPolicy: PASSWORD_POLICY_PRESETS.strict,
      oauthMock: false,
      instanceAdminTokenHash: null,
      dashboardDir: null,
      apiDocs: true,
      instanceAuditRetentionDays: 365,
      deliversWebhooks: true,
    })
    expect(deps.breachChecker).toBeInstanceOf(HibpBreachChecker)
    expect(deps.mailer).toBeInstanceOf(SmtpMailer)
    expect(deps.verificationTokens).toBeInstanceOf(PostgresVerificationTokenStore)
    expect(await deps.keyedHash.hmac('test', 'x')).toMatch(/^[0-9a-f]{64}$/)
    expect(deps.probes.map((probe) => probe.name)).toEqual(['database'])
    expect(deps.ids.next()).toMatch(/^[0-9a-f-]{36}$/)
    await close()
  })

  test.each(['local', 'dev', 'staging', 'prod'] as const)(
    'the outbound guard is given the %s tier and nothing else: no resolver, no extra certificate',
    async (tier) => {
      const { deps, close } = createContainer(
        parseEnv({
          ...base,
          ENVIRONMENT: tier,
          // What the live tiers insist on; nothing here is ever connected to.
          REDIS_URL: 'redis://127.0.0.1:1',
          SMTP_URL: 'smtps://relay.example.com:465',
          MAIL_FROM: 'Tula <auth@example.com>',
          BREACH_CHECK: 'hibp',
          PUBLIC_URL: 'https://auth.example.com',
        })
      )
      // Exactly this: the system resolver and the system's certificate authorities.
      expect(deps.outbound).toEqual({ tier })
      await close()
    }
  )

  test('the jitter of webhook retries is a number from 0 up to, never including, 1, and not a fixed one', async () => {
    const { deps, close } = createContainer(parseEnv(base))
    const drawn = Array.from({ length: 200 }, () => deps.jitter())
    expect(drawn.every((value) => value >= 0 && value < 1)).toBe(true)
    // 32 random bits each: two hundred equal draws would mean it is not random at all.
    expect(new Set(drawn).size).toBeGreaterThan(100)
    await close()
  })

  test('defaults to the recommended policy and the offline breach list', async () => {
    const { deps, close } = createContainer(parseEnv(base))
    expect(deps.config.passwordPolicy).toEqual(PASSWORD_POLICY_PRESETS.recommended)
    expect(deps.breachChecker).toBe(offlineBreachChecker)
    await close()
  })

  test('without REDIS_URL the shared state is held in process memory', async () => {
    const { deps, close } = createContainer(parseEnv(base))
    expect(deps.rateLimiter).toBeInstanceOf(MemoryRateLimiter)
    expect(deps.lockout).toBeInstanceOf(MemoryLockout)
    expect(deps.revokedSessions).toBeInstanceOf(MemoryRevokedSessions)
    expect(deps.probes.map((probe) => probe.name)).toEqual(['database'])
    await close()
  })

  test('with REDIS_URL the shared state is in Redis and readiness checks it, without connecting', async () => {
    // Nothing listens here either: building the container must not open a connection.
    const env = parseEnv({ ...base, REDIS_URL: 'redis://127.0.0.1:1' })
    const { deps, close } = createContainer(env)
    expect(deps.rateLimiter).toBeInstanceOf(RedisRateLimiter)
    expect(deps.lockout).toBeInstanceOf(RedisLockout)
    expect(deps.revokedSessions).toBeInstanceOf(RedisRevokedSessions)
    expect(deps.probes.map((probe) => probe.name)).toEqual(['database', 'redis'])
    await close()
  })
})

describe('the webhook worker as its own service (WEBHOOK_WORKER)', () => {
  test.each([
    ['api', 'api', true],
    ['api', 'separate', false],
    ['worker', 'separate', true],
  ] as const)(
    'a process started as %s where WEBHOOK_WORKER is %s: deliversWebhooks is %p',
    async (role, mode, expected) => {
      const { deps, close } = createContainer(parseEnv({ ...base, WEBHOOK_WORKER: mode }), role)
      expect(deps.config.deliversWebhooks).toBe(expected)
      await close()
    }
  )

  test('a worker where the API instances deliver is refused before anything is built', () => {
    expect(() => createContainer(parseEnv({ ...base, WEBHOOK_WORKER: 'api' }), 'worker')).toThrow(
      'Set WEBHOOK_WORKER=separate on every container'
    )
  })

  test('the role defaults to the API: every existing caller is an API instance', async () => {
    const { deps, close } = createContainer(parseEnv({ ...base, WEBHOOK_WORKER: 'separate' }))
    expect(deps.config.deliversWebhooks).toBe(false)
    await close()
  })

  test.each(['api', 'worker'] as const)(
    'the outbound guard of a %s process is the tier and nothing else',
    async (role) => {
      const { deps, close } = createContainer(
        parseEnv({ ...base, WEBHOOK_WORKER: 'separate' }),
        role
      )
      expect(deps.outbound).toEqual({ tier: 'dev' })
      await close()
    }
  )

  test('a worker is ready when the database answers: it uses nothing of Redis', async () => {
    const env = parseEnv({
      ...base,
      WEBHOOK_WORKER: 'separate',
      REDIS_URL: 'redis://127.0.0.1:1',
    })
    const worker = createContainer(env, 'worker')
    expect(worker.deps.probes.map((probe) => probe.name)).toEqual(['database'])
    await worker.close()
    // An API instance of the same deployment still checks both.
    const api = createContainer(env, 'api')
    expect(api.deps.probes.map((probe) => probe.name)).toEqual(['database', 'redis'])
    await api.close()
  })
})

describe('the mock OAuth provider', () => {
  // Review finding F5: nobody should be able to run with the mock on and not know.
  test('says loudly at boot that it is on, and says nothing when it is off', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      const local = { ...base, ENVIRONMENT: 'local' }
      const off = createContainer(parseEnv(local))
      expect(off.deps.config.oauthMock).toBe(false)
      expect(warn).not.toHaveBeenCalled()
      await off.close()

      const on = createContainer(parseEnv({ ...local, OAUTH_MOCK_PROVIDER: 'true' }))
      expect(on.deps.config.oauthMock).toBe(true)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toMatch(
        /OAUTH_MOCK_PROVIDER is on.*never.*outside local development/i
      )
      await on.close()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('the instance admin token', () => {
  test('is kept as its SHA-256 only, and the diagnostics probes are wired', async () => {
    const token = 'k3Zr8vQ1nP5xW7bT2mY9cF4hJ6dL0sAg'
    const { deps, close } = createContainer(parseEnv({ ...base, TULA_ADMIN_TOKEN: token }))
    expect(deps.config.instanceAdminTokenHash).toBe(
      new Bun.CryptoHasher('sha256').update(token).digest('hex')
    )
    expect(JSON.stringify(deps.config)).not.toContain(token)
    // No Redis in this environment: nothing to ping.
    expect(deps.diagnostics.redis).toBeNull()
    expect(deps.diagnostics.shippedMigrations.length).toBeGreaterThan(10)
    await close()
  })
})
