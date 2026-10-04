import { PASSWORD_POLICY_PRESETS } from '@tula/contract'
import { createDatabase } from '@tula/db'
import { HibpBreachChecker } from '~/adapters/breach/hibp'
import { offlineBreachChecker } from '~/adapters/breach/offline'
import { cacheEnvironmentSettings } from '~/adapters/cache/environment-settings'
import { cacheSigningKeys } from '~/adapters/cache/signing-keys'
import { SmtpMailer } from '~/adapters/mail/smtp'
import { MemoryLockout } from '~/adapters/memory/lockout'
import { MemoryRateLimiter } from '~/adapters/memory/rate-limiter'
import { MemoryRevokedSessions } from '~/adapters/memory/revoked-sessions'
import { PostgresActivityLog } from '~/adapters/postgres/activity'
import { PostgresApiKeyRepository } from '~/adapters/postgres/api-keys'
import { PostgresEnvironmentSettingsStore } from '~/adapters/postgres/environment-settings'
import { PostgresEnvironmentRepository } from '~/adapters/postgres/environments'
import { PostgresFactorStore } from '~/adapters/postgres/factors'
import { PostgresFlowAttemptStore } from '~/adapters/postgres/flow-attempts'
import { databaseProbe } from '~/adapters/postgres/health'
import { PostgresJobLock } from '~/adapters/postgres/job-lock'
import { PostgresSessionStore } from '~/adapters/postgres/sessions'
import { PostgresSigningKeyStore } from '~/adapters/postgres/signing-keys'
import { PostgresUserRepository } from '~/adapters/postgres/users'
import { PostgresVerificationTokenStore } from '~/adapters/postgres/verification-tokens'
import { connectRedis, redisProbe } from '~/adapters/redis/connection'
import { RedisLockout } from '~/adapters/redis/lockout'
import { RedisRateLimiter } from '~/adapters/redis/rate-limiter'
import { RedisRevokedSessions } from '~/adapters/redis/revoked-sessions'
import { RedisSigningKeyVersions } from '~/adapters/redis/signing-key-versions'
import { RedisVersions } from '~/adapters/redis/versions'
import { systemClock } from '~/adapters/system/clock'
import { uuidV7Ids } from '~/adapters/system/ids'
import type { Deps } from '~/dependencies'
import type { Env } from '~/env'
import { createKeyedHash } from '~/lib/keyed-hash'
import { createSecretBox } from '~/lib/secret-box'

/** How long verification keys are cached per instance. See the rotation invariant. */
export const SIGNING_KEY_CACHE_TTL_MS = 60_000

/**
 * With Redis, how often an instance checks whether another one changed an environment's signing
 * keys: the longest it keeps serving keys that predate a rotation (see `cacheSigningKeys`).
 */
export const SIGNING_KEY_VERSION_CHECK_MS = 5_000

/**
 * How long an environment's settings (and the union of allowed origins) are cached per
 * instance: the longest another instance keeps applying settings that were since replaced when
 * there is no Redis, or while Redis is down (see `cacheEnvironmentSettings`).
 */
export const ENVIRONMENT_SETTINGS_CACHE_TTL_MS = 30_000

/**
 * With Redis, how often an instance checks whether another one replaced an environment's
 * settings: the longest it keeps applying the previous ones.
 */
export const ENVIRONMENT_SETTINGS_VERSION_CHECK_MS = 5_000

/** Second key segment of the settings change markers in Redis: `tula:es:<environment id>`. */
export const ENVIRONMENT_SETTINGS_VERSION_SEGMENT = 'es'

/** Production dependencies plus the function that releases their resources. */
export interface Container {
  deps: Deps
  close: () => Promise<void>
}

/**
 * The composition root: the only place that picks adapters.
 *
 * Connections are lazy, so building the container does not touch the network.
 *
 * @param env - Validated environment.
 * @returns The dependencies and a `close` for graceful shutdown.
 */
export function createContainer(env: Env): Container {
  const database = createDatabase(env.DATABASE_URL)
  const clock = systemClock
  const mailer = new SmtpMailer({ url: env.SMTP_URL, from: env.MAIL_FROM })
  const keyedHash = createKeyedHash(env.TULA_MASTER_KEY)
  // State that API instances must agree on lives in Redis when it is configured. Without it
  // (allowed in `local` and `dev` only, see `env.ts`) it is held in this process's memory.
  const redis = env.REDIS_URL ? connectRedis(env.REDIS_URL, clock) : null
  const signingKeys = new PostgresSigningKeyStore(database.db)
  const environmentSettings = new PostgresEnvironmentSettingsStore(database.db)
  const deps: Deps = {
    config: {
      tier: env.ENVIRONMENT,
      publicUrl: env.PUBLIC_URL,
      corsOrigins: env.CORS_ORIGINS,
      trustProxy: env.TRUST_PROXY,
      passwordPolicy: PASSWORD_POLICY_PRESETS[env.PASSWORD_POLICY],
    },
    clock,
    ids: uuidV7Ids,
    apiKeys: new PostgresApiKeyRepository(database.db),
    environments: new PostgresEnvironmentRepository(database.db),
    environmentSettings: redis
      ? cacheEnvironmentSettings(environmentSettings, clock, ENVIRONMENT_SETTINGS_CACHE_TTL_MS, {
          versions: new RedisVersions(redis, ENVIRONMENT_SETTINGS_VERSION_SEGMENT),
          checkEveryMs: ENVIRONMENT_SETTINGS_VERSION_CHECK_MS,
        })
      : cacheEnvironmentSettings(environmentSettings, clock, ENVIRONMENT_SETTINGS_CACHE_TTL_MS),
    signingKeys: redis
      ? cacheSigningKeys(signingKeys, clock, SIGNING_KEY_CACHE_TTL_MS, {
          versions: new RedisSigningKeyVersions(redis),
          checkEveryMs: SIGNING_KEY_VERSION_CHECK_MS,
        })
      : cacheSigningKeys(signingKeys, clock, SIGNING_KEY_CACHE_TTL_MS),
    rateLimiter: redis
      ? new RedisRateLimiter(redis, clock, keyedHash)
      : new MemoryRateLimiter(clock),
    lockout: redis ? new RedisLockout(redis) : new MemoryLockout(clock),
    breachChecker: env.BREACH_CHECK === 'hibp' ? new HibpBreachChecker() : offlineBreachChecker,
    verificationTokens: new PostgresVerificationTokenStore(database.db),
    sessions: new PostgresSessionStore(database.db),
    users: new PostgresUserRepository(database.db),
    factors: new PostgresFactorStore(database.db),
    flowAttempts: new PostgresFlowAttemptStore(database.db),
    activityLog: new PostgresActivityLog(database.db),
    revokedSessions: redis
      ? new RedisRevokedSessions(redis, clock)
      : new MemoryRevokedSessions(clock),
    mailer,
    secretBox: createSecretBox(env.TULA_MASTER_KEY),
    keyedHash,
    // On Postgres even when Redis is configured: the jobs it guards are database work.
    jobLock: new PostgresJobLock(database.withAdvisoryLock),
    probes: redis ? [databaseProbe(database.db), redisProbe(redis)] : [databaseProbe(database.db)],
  }
  return {
    deps,
    close: async () => {
      mailer.close()
      redis?.close()
      await database.close()
    },
  }
}
