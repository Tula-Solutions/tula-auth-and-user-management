import { PASSWORD_POLICY_PRESETS } from '@tula/contract'
import { createDatabase } from '@tula/db'
import { HibpBreachChecker } from '~/adapters/breach/hibp'
import { offlineBreachChecker } from '~/adapters/breach/offline'
import { cacheSigningKeys } from '~/adapters/cache/signing-keys'
import { SmtpMailer } from '~/adapters/mail/smtp'
import { MemoryRateLimiter } from '~/adapters/memory/rate-limiter'
import { MemoryRevokedSessions } from '~/adapters/memory/revoked-sessions'
import { PostgresApiKeyRepository } from '~/adapters/postgres/api-keys'
import { PostgresEnvironmentRepository } from '~/adapters/postgres/environments'
import { databaseProbe } from '~/adapters/postgres/health'
import { PostgresSessionStore } from '~/adapters/postgres/sessions'
import { PostgresSigningKeyStore } from '~/adapters/postgres/signing-keys'
import { PostgresVerificationTokenStore } from '~/adapters/postgres/verification-tokens'
import { systemClock } from '~/adapters/system/clock'
import { uuidV7Ids } from '~/adapters/system/ids'
import type { Deps } from '~/dependencies'
import type { Env } from '~/env'
import { createKeyedHash } from '~/lib/keyed-hash'
import { createSecretBox } from '~/lib/secret-box'

/** How long verification keys are cached per instance. See the rotation invariant. */
export const SIGNING_KEY_CACHE_TTL_MS = 60_000

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
    signingKeys: cacheSigningKeys(
      new PostgresSigningKeyStore(database.db),
      clock,
      SIGNING_KEY_CACHE_TTL_MS
    ),
    rateLimiter: new MemoryRateLimiter(clock),
    breachChecker: env.BREACH_CHECK === 'hibp' ? new HibpBreachChecker() : offlineBreachChecker,
    verificationTokens: new PostgresVerificationTokenStore(database.db),
    sessions: new PostgresSessionStore(database.db),
    revokedSessions: new MemoryRevokedSessions(clock),
    mailer,
    secretBox: createSecretBox(env.TULA_MASTER_KEY),
    keyedHash: createKeyedHash(env.TULA_MASTER_KEY),
    probes: [databaseProbe(database.db)],
  }
  return {
    deps,
    close: async () => {
      mailer.close()
      await database.close()
    },
  }
}
