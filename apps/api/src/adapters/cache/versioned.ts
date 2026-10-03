import * as logger from '~/lib/logger'
import type { Clock } from '~/ports/clock'

/**
 * A marker per id, shared by every API instance, that changes whenever the thing cached under
 * that id does. Redis holds it in production (`RedisVersions`).
 */
export interface Versions {
  /**
   * @param id - What the marker is for, e.g. an environment id.
   * @returns The current marker, or `null` when nothing changed since it was last lost.
   * @throws When the shared store cannot be read.
   */
  current(id: string): Promise<string | null>

  /**
   * Replace the marker after a change.
   *
   * @param id - What changed.
   * @throws When the shared store cannot be written.
   */
  bump(id: string): Promise<void>
}

/** How instances tell each other that a cached value changed. */
export interface SharedInvalidation {
  versions: Versions
  /** How often a cached value is compared with the shared marker, in milliseconds. */
  checkEveryMs: number
}

/** Settings of a {@link createVersionedCache}. */
export interface VersionedCacheOptions<T> {
  clock: Clock
  /** How long a loaded value is reused. */
  ttlMs: number
  /** The cross-instance marker and how often to check it; omit for one instance. */
  shared?: SharedInvalidation
  /** What is cached, for the log line when a change cannot be announced, e.g. `signing keys`. */
  subject: string
  /** Return `false` for a loaded value that must not be cached. Every value is kept by default. */
  keep?: (value: T) => boolean
}

/** A per-process cache whose entries other instances can invalidate. */
export interface VersionedCache<T> {
  /**
   * @param id - The entry.
   * @param load - Fetches the value when it is missing, expired or changed elsewhere.
   * @returns The cached or freshly loaded value.
   */
  get(id: string, load: () => Promise<T>): Promise<T>

  /**
   * Forget this instance's entry, so its next read loads.
   *
   * @param id - The entry.
   */
  drop(id: string): void

  /**
   * Tell the other instances that the entry changed. Never throws: when the shared store is
   * down they catch up at cache expiry, and the write that was just made must not fail for it.
   *
   * @param id - The entry.
   */
  announce(id: string): Promise<void>
}

interface Entry<T> {
  fetchedAt: number
  /** When the marker was last compared (or the value loaded). */
  checkedAt: number
  /** The marker read just before the value; resolves to `undefined` when it could not be read. */
  marker: Promise<string | null | undefined> | undefined
  value: Promise<T>
}

function unreadable(): undefined {
  return undefined
}

/**
 * A per-process cache with a time limit and, optionally, a marker shared between instances.
 *
 * - A value is reused for `ttlMs`. Concurrent misses share one load. Failed loads, and values
 *   `keep` turns down, are not cached.
 * - With `shared`, {@link VersionedCache.announce} replaces the id's marker and every instance
 *   compares its entry with the marker at most once per `checkEveryMs`, reloading when it
 *   differs. So another instance serves a value that predates a change for at most
 *   `checkEveryMs` after the change was announced.
 * - When the marker cannot be written or read (the shared store is down), or without `shared`,
 *   the bound is `ttlMs`: the marker is a way to converge sooner, never something correctness
 *   may depend on.
 *
 * @param options - Clock, lifetimes and the shared marker.
 * @returns The cache.
 */
export function createVersionedCache<T>(options: VersionedCacheOptions<T>): VersionedCache<T> {
  const { clock, ttlMs, shared } = options
  const entries = new Map<string, Entry<T>>()

  function fill(id: string, load: () => Promise<T>, at: number): Promise<T> {
    // The marker is read before the value: a change that lands between the two reads then
    // shows as a changed marker at the next check instead of being missed.
    const marker = shared?.versions.current(id).catch(unreadable)
    const value = marker ? marker.then(load) : load()
    entries.set(id, { fetchedAt: at, checkedAt: at, marker, value })
    const evict = () => {
      if (entries.get(id)?.value === value) {
        entries.delete(id)
      }
    }
    value.then((found) => {
      if (options.keep && !options.keep(found)) {
        evict()
      }
    }, evict)
    return value
  }

  async function changed(versions: Versions, id: string, entry: Entry<T>): Promise<boolean> {
    try {
      const [seen, current] = await Promise.all([entry.marker, versions.current(id)])
      return seen !== current
    } catch {
      // The marker cannot be read: keep the cached value. The TTL still bounds how stale it gets.
      return false
    }
  }

  return {
    get(id, load) {
      const at = clock.now().getTime()
      const cached = entries.get(id)
      if (!cached || at - cached.fetchedAt >= ttlMs) {
        return fill(id, load, at)
      }
      if (!shared || at - cached.checkedAt < shared.checkEveryMs) {
        return cached.value
      }
      // Set before the read, so requests arriving meanwhile use the cache instead of all checking.
      cached.checkedAt = at
      return changed(shared.versions, id, cached).then((stale) => {
        if (!stale) {
          return cached.value
        }
        const latest = entries.get(id)
        return latest && latest !== cached ? latest.value : fill(id, load, at)
      })
    },
    drop(id) {
      entries.delete(id)
    },
    async announce(id) {
      try {
        await shared?.versions.bump(id)
      } catch (error) {
        logger.warn(
          `could not announce new ${options.subject}; other instances catch up at cache expiry`,
          { environmentId: id, reason: error instanceof Error ? error.name : 'NonError' }
        )
      }
    },
  }
}
