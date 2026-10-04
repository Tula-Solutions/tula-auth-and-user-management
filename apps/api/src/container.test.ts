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
    })
    expect(deps.breachChecker).toBeInstanceOf(HibpBreachChecker)
    expect(deps.mailer).toBeInstanceOf(SmtpMailer)
    expect(deps.verificationTokens).toBeInstanceOf(PostgresVerificationTokenStore)
    expect(await deps.keyedHash.hmac('test', 'x')).toMatch(/^[0-9a-f]{64}$/)
    expect(deps.probes.map((probe) => probe.name)).toEqual(['database'])
    expect(deps.ids.next()).toMatch(/^[0-9a-f-]{36}$/)
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
