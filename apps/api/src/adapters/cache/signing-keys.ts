import type { Jwk } from '@tula/contract'
import {
  createVersionedCache,
  type SharedInvalidation,
  type Versions,
} from '~/adapters/cache/versioned'
import type { Clock } from '~/ports/clock'
import type { SigningKeyStore } from '~/ports/signing-key-store'

/**
 * A marker per environment, shared by every API instance, that changes whenever the
 * environment's signing keys do. Redis holds it in production (`RedisSigningKeyVersions`).
 */
export type SigningKeyVersions = Versions

export type { SharedInvalidation }

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
 * - Writes pass through and drop this instance's entry for the environment.
 *
 * **Other instances.** With `shared`, a write also replaces the environment's shared marker,
 * and every instance compares its cached entry with the marker at most once per
 * `shared.checkEveryMs`, refetching when it differs. So another instance serves keys that
 * predate a rotation for at most `checkEveryMs` after the rotation was announced. When the
 * marker cannot be written or read (the shared store is down), or without `shared`, the bound is
 * `ttlMs`, which the rotation invariant already allows for: this is a way to converge sooner,
 * never something correctness depends on.
 *
 * @param store - The underlying store (Postgres in production).
 * @param clock - Time source for expiry.
 * @param ttlMs - How long a fetched key set is reused.
 * @param shared - The cross-instance marker and how often to check it; omit for one instance.
 * @returns A store with the same interface.
 */
export function cacheSigningKeys(
  store: SigningKeyStore,
  clock: Clock,
  ttlMs: number,
  shared?: SharedInvalidation
): SigningKeyStore {
  const cache = createVersionedCache<Jwk[]>({
    clock,
    ttlMs,
    shared,
    subject: 'signing keys',
    keep: (keys) => keys.length > 0,
  })

  return {
    verificationKeys: (environmentId, now) =>
      cache.get(environmentId, () => store.verificationKeys(environmentId, now)),
    list: (environmentId) => store.list(environmentId),
    async insert(environmentId, keys) {
      const inserted = await store.insert(environmentId, keys)
      cache.drop(environmentId)
      if (inserted) {
        await cache.announce(environmentId)
      }
      return inserted
    },
    async rotate(environmentId, plan, at, activity) {
      const rotated = await store.rotate(environmentId, plan, at, activity)
      cache.drop(environmentId)
      if (rotated) {
        await cache.announce(environmentId)
      }
      return rotated
    },
  }
}
