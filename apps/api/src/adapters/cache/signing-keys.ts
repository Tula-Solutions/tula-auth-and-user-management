import type { Jwk } from '@tula/contract'
import * as logger from '~/lib/logger'
import type { Clock } from '~/ports/clock'
import type { SigningKeyStore } from '~/ports/signing-key-store'

/**
 * A marker per environment, shared by every API instance, that changes whenever the
 * environment's signing keys do. Redis holds it in production (`RedisSigningKeyVersions`).
 */
export interface SigningKeyVersions {
  /**
   * @param environmentId - The environment.
   * @returns The current marker, or `null` when the keys have not changed since it was last lost.
   * @throws When the shared store cannot be read.
   */
  current(environmentId: string): Promise<string | null>

  /**
   * Replace the marker after the environment's keys changed.
   *
   * @param environmentId - The environment.
   * @throws When the shared store cannot be written.
   */
  bump(environmentId: string): Promise<void>
}

/** How instances tell each other that an environment's keys changed. */
export interface SharedInvalidation {
  versions: SigningKeyVersions
  /** How often a cached key set is compared with the shared marker, in milliseconds. */
  checkEveryMs: number
}

interface Entry {
  fetchedAt: number
  /** When the marker was last compared (or the keys fetched). */
  checkedAt: number
  /** The marker read just before the keys; resolves to `undefined` when it could not be read. */
  marker: Promise<string | null | undefined> | undefined
  keys: Promise<Jwk[]>
}

function unreadable(): undefined {
  return undefined
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
  const entries = new Map<string, Entry>()

  function load(environmentId: string, now: Date, at: number): Promise<Jwk[]> {
    // The marker is read before the keys: a rotation that lands between the two reads then
    // shows as a changed marker at the next check instead of being missed.
    const marker = shared?.versions.current(environmentId).catch(unreadable)
    const keys = marker
      ? marker.then(() => store.verificationKeys(environmentId, now))
      : store.verificationKeys(environmentId, now)
    entries.set(environmentId, { fetchedAt: at, checkedAt: at, marker, keys })
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
  }

  async function changed(
    versions: SigningKeyVersions,
    environmentId: string,
    entry: Entry
  ): Promise<boolean> {
    try {
      const [seen, current] = await Promise.all([entry.marker, versions.current(environmentId)])
      return seen !== current
    } catch {
      // The marker cannot be read: keep the cached keys. The TTL still bounds how stale they get.
      return false
    }
  }

  async function announce(environmentId: string): Promise<void> {
    try {
      await shared?.versions.bump(environmentId)
    } catch (error) {
      // The write itself succeeded, so it must not fail here; other instances fall back to the TTL.
      logger.warn('could not announce new signing keys; other instances catch up at cache expiry', {
        environmentId,
        reason: error instanceof Error ? error.name : 'NonError',
      })
    }
  }

  return {
    verificationKeys(environmentId, now) {
      const at = clock.now().getTime()
      const cached = entries.get(environmentId)
      if (!cached || at - cached.fetchedAt >= ttlMs) {
        return load(environmentId, now, at)
      }
      if (!shared || at - cached.checkedAt < shared.checkEveryMs) {
        return cached.keys
      }
      // Set before the read, so requests arriving meanwhile use the cache instead of all checking.
      cached.checkedAt = at
      return changed(shared.versions, environmentId, cached).then((stale) => {
        if (!stale) {
          return cached.keys
        }
        const latest = entries.get(environmentId)
        return latest && latest !== cached ? latest.keys : load(environmentId, now, at)
      })
    },
    list: (environmentId) => store.list(environmentId),
    async insert(environmentId, keys) {
      const inserted = await store.insert(environmentId, keys)
      entries.delete(environmentId)
      if (inserted) {
        await announce(environmentId)
      }
      return inserted
    },
    async rotate(environmentId, plan, at, activity) {
      const rotated = await store.rotate(environmentId, plan, at, activity)
      entries.delete(environmentId)
      if (rotated) {
        await announce(environmentId)
      }
      return rotated
    },
  }
}
