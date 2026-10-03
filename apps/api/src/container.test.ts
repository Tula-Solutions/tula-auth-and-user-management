import { describe, expect, test } from 'bun:test'
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

const base = {
  ENVIRONMENT: 'dev',
  // Nothing listens here: building the container must not open a connection.
  DATABASE_URL: 'postgres://tula_api:tula_api@127.0.0.1:1/tula',
  TULA_MASTER_KEY: 'a'.repeat(64),
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
