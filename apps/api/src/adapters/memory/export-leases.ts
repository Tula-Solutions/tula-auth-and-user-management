import type { Clock } from '~/ports/clock'
import type { ExportLeases } from '~/ports/export-leases'

/**
 * Export leases held in process memory.
 *
 * Correct for a single instance only: each instance would count its own exports, so the cap is
 * per process. `RedisExportLeases` is the adapter for several instances; this one is used when
 * `REDIS_URL` is unset and by unit tests.
 */
export class MemoryExportLeases implements ExportLeases {
  /** Environment id to lease id to expiry (epoch milliseconds). */
  readonly #held: Map<string, Map<string, number>>

  /** @param clock - Time source for expiry. */
  constructor(private readonly clock: Clock) {
    // Assigned here rather than as a field initializer: Bun's per-file coverage counts
    // initializers as an uncalled function.
    this.#held = new Map()
  }

  /** The environment's live leases, expired ones dropped. */
  #live(environmentId: string): Map<string, number> {
    const now = this.clock.now().getTime()
    const leases = this.#held.get(environmentId) ?? new Map<string, number>()
    for (const [id, expiry] of leases) {
      if (expiry <= now) {
        leases.delete(id)
      }
    }
    if (leases.size === 0) {
      this.#held.delete(environmentId)
    } else {
      this.#held.set(environmentId, leases)
    }
    return leases
  }

  /** @inheritdoc */
  async acquire(environmentId: string, limit: number, ttlMs: number): Promise<string | null> {
    // No await between the count and the write: one turn of the event loop, which is what
    // makes the step atomic here.
    const leases = this.#live(environmentId)
    if (leases.size >= limit) {
      return null
    }
    const id = crypto.randomUUID()
    leases.set(id, this.clock.now().getTime() + ttlMs)
    this.#held.set(environmentId, leases)
    return id
  }

  /** @inheritdoc */
  async renew(environmentId: string, leaseId: string, ttlMs: number): Promise<boolean> {
    const leases = this.#live(environmentId)
    if (!leases.has(leaseId)) {
      return false
    }
    leases.set(leaseId, this.clock.now().getTime() + ttlMs)
    return true
  }

  /** @inheritdoc */
  async release(environmentId: string, leaseId: string): Promise<void> {
    this.#held.get(environmentId)?.delete(leaseId)
    // Drops the environment's entry once it holds nothing, so the map does not grow.
    this.#live(environmentId)
  }
}
