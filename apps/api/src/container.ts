import { createDatabase } from '@tula/db'
import { cacheSigningKeys } from '~/adapters/cache/signing-keys'
import { MemoryRateLimiter } from '~/adapters/memory/rate-limiter'
import { PostgresApiKeyRepository } from '~/adapters/postgres/api-keys'
import { databaseProbe } from '~/adapters/postgres/health'
import { PostgresSigningKeyStore } from '~/adapters/postgres/signing-keys'
import { systemClock } from '~/adapters/system/clock'
import { uuidV7Ids } from '~/adapters/system/ids'
import type { Deps } from '~/dependencies'
import type { Env } from '~/env'

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
  const deps: Deps = {
    config: {
      tier: env.ENVIRONMENT,
      publicUrl: env.PUBLIC_URL,
      corsOrigins: env.CORS_ORIGINS,
      trustProxy: env.TRUST_PROXY,
    },
    clock,
    ids: uuidV7Ids,
    apiKeys: new PostgresApiKeyRepository(database.db),
    signingKeys: cacheSigningKeys(
      new PostgresSigningKeyStore(database.db),
      clock,
      SIGNING_KEY_CACHE_TTL_MS
    ),
    rateLimiter: new MemoryRateLimiter(clock),
    probes: [databaseProbe(database.db)],
  }
  return { deps, close: database.close }
}
