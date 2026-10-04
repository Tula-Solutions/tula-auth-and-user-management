import { createVersionedCache, type SharedInvalidation } from '~/adapters/cache/versioned'
import type { Clock } from '~/ports/clock'
import type {
  EnvironmentSettingsStore,
  StoredEnvironmentSettings,
} from '~/ports/environment-settings-store'

/** Marker id for the union of every environment's allowed origins. Never an environment id. */
export const ALL_ORIGINS = 'all'

/**
 * Cache environment settings per process, so the password policy and the CORS allow-list are
 * not a database read on every request.
 *
 * - "No settings saved" is cached like any document: most environments have none.
 * - A replace through this store drops this instance's entries **before it returns**, whether
 *   or not it took effect (a lost compare-and-set means the cached copy is out of date). The
 *   instance that writes therefore sees its own write at once.
 * - Other instances: with `shared`, a replace also changes the environment's marker and the
 *   {@link ALL_ORIGINS} marker, and every instance compares each cached entry with its marker
 *   at most once per `shared.checkEveryMs`. So another instance applies a change within
 *   `checkEveryMs` of the write. Without `shared`, or while the shared store is down, the bound
 *   is `ttlMs`.
 * - `get(id, true)` reloads from the store (and caches what it finds).
 * - Cached values are shared between requests: callers must not mutate what they are given.
 *
 * @param store - The underlying store (Postgres in production).
 * @param clock - Time source for expiry.
 * @param ttlMs - How long a fetched document is reused.
 * @param shared - The cross-instance marker and how often to check it; omit for one instance.
 * @returns A store with the same interface.
 */
export function cacheEnvironmentSettings(
  store: EnvironmentSettingsStore,
  clock: Clock,
  ttlMs: number,
  shared?: SharedInvalidation
): EnvironmentSettingsStore {
  const documents = createVersionedCache<StoredEnvironmentSettings | null>({
    clock,
    ttlMs,
    shared,
    subject: 'environment settings',
  })
  const origins = createVersionedCache<string[]>({
    clock,
    ttlMs,
    shared,
    subject: 'allowed origins',
  })

  return {
    get(environmentId, fresh) {
      if (fresh) {
        documents.drop(environmentId)
      }
      return documents.get(environmentId, () => store.get(environmentId))
    },
    async replace(environmentId, expectedRevision, settings, at, activity, manager) {
      let replaced: StoredEnvironmentSettings | null = null
      try {
        replaced = await store.replace(
          environmentId,
          expectedRevision,
          settings,
          at,
          activity,
          manager
        )
      } finally {
        // Also after a failure: the write may have been committed before the error surfaced.
        documents.drop(environmentId)
        origins.drop(ALL_ORIGINS)
      }
      if (replaced) {
        await Promise.all([documents.announce(environmentId), origins.announce(ALL_ORIGINS)])
      }
      return replaced
    },
    allowedOrigins: () => origins.get(ALL_ORIGINS, () => store.allowedOrigins()),
  }
}
