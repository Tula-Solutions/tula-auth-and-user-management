import type { Clock } from '~/ports/clock'
import type { RateLimitDecision, RateLimiter } from '~/ports/rate-limiter'

interface Window {
  startedAt: number
  count: number
}

/** Expired windows are swept after this many new buckets, bounding memory under key churn. */
const SWEEP_EVERY = 1_000

/**
 * Fixed-window counter held in process memory.
 *
 * Correct for a single instance only: behind a load balancer each instance counts separately,
 * which multiplies the effective limit. Phase 1 adds a Redis adapter for that.
 */
export class MemoryRateLimiter implements RateLimiter {
  readonly #windows = new Map<string, Window & { windowMs: number }>()
  #created = 0

  /** @param clock - Time source for window boundaries. */
  constructor(private readonly clock: Clock) {}

  /** @inheritdoc */
  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitDecision> {
    const now = this.clock.now().getTime()
    let window = this.#windows.get(key)
    if (!window || now - window.startedAt >= window.windowMs) {
      window = { startedAt: now, count: 0, windowMs }
      this.#windows.set(key, window)
      this.#created += 1
      if (this.#created % SWEEP_EVERY === 0) {
        this.#sweep(now)
      }
    }
    window.count += 1
    const retryAfterMs = window.startedAt + window.windowMs - now
    const allowed = window.count <= limit
    return { allowed, remaining: allowed ? limit - window.count : 0, retryAfterMs }
  }

  /** Number of live buckets; exposed for tests of the sweep. */
  get size(): number {
    return this.#windows.size
  }

  #sweep(now: number): void {
    for (const [key, window] of this.#windows) {
      if (now - window.startedAt >= window.windowMs) {
        this.#windows.delete(key)
      }
    }
  }
}
