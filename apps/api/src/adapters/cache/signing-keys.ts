import type { Jwk } from '@tula/contract'
import type { Clock } from '~/ports/clock'
import type { SigningKeyStore } from '~/ports/signing-key-store'

interface Entry {
  fetchedAt: number
  keys: Promise<Jwk[]>
}

/**
 * Cache an environment's verification keys so `sessionAuth` verifies JWTs without a database hit.
 *
 * - Safe only under the rotation invariant documented on {@link SigningKeyStore}: new keys are
 *   published at least `ttlMs` before they sign anything.
 * - A key retired upstream may stay accepted for up to `ttlMs` longer; tokens it signed still
 *   expire on their own `exp`.
 * - Concurrent misses share one fetch. Failed fetches and empty key sets are not cached: an empty
 *   set only exists before an environment is bootstrapped, and caching it would reject the first
 *   tokens for up to `ttlMs` on every other instance.
 * - Unknown `kid`s never force a refetch, so forged tokens cannot be used to hammer the database.
 * - Entries are keyed by environment id, which is resolved from a valid API key first, so callers
 *   cannot grow the map with arbitrary ids.
 * - Writes pass through and drop this instance's entry for the environment. Other instances
 *   catch up within `ttlMs`, which the rotation invariant already allows for.
 *
 * @param store - The underlying store (Postgres in production).
 * @param clock - Time source for expiry.
 * @param ttlMs - How long a fetched key set is reused.
 * @returns A store with the same interface.
 */
export function cacheSigningKeys(
  store: SigningKeyStore,
  clock: Clock,
  ttlMs: number
): SigningKeyStore {
  const entries = new Map<string, Entry>()
  return {
    verificationKeys(environmentId, now) {
      const at = clock.now().getTime()
      const cached = entries.get(environmentId)
      if (cached && at - cached.fetchedAt < ttlMs) {
        return cached.keys
      }
      const keys = store.verificationKeys(environmentId, now)
      entries.set(environmentId, { fetchedAt: at, keys })
      const evict = () => {
        if (entries.get(environmentId)?.keys === keys) {
          entries.delete(environmentId)
        }
      }
      keys.then((found) => {
        if (found.length === 0) {
          evict()
        }
      }, evict)
      return keys
    },
    list: (environmentId) => store.list(environmentId),
    async insert(environmentId, keys) {
      const inserted = await store.insert(environmentId, keys)
      entries.delete(environmentId)
      return inserted
    },
    async rotate(environmentId, plan, at, activity) {
      const rotated = await store.rotate(environmentId, plan, at, activity)
      entries.delete(environmentId)
      return rotated
    },
  }
}
