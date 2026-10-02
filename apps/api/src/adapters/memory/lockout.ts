import type { Clock } from '~/ports/clock'
import {
  type Lockout,
  type LockoutDecision,
  type LockoutPolicy,
  lockoutDelayMs,
} from '~/ports/lockout'

interface Entry {
  failures: number
  lockedUntil: number
  /** When the failures stop counting. */
  forgetAt: number
}

/** Forgotten entries are swept after this many new keys, bounding memory under key churn. */
const SWEEP_EVERY = 1_000

/**
 * Lockout state held in process memory.
 *
 * Correct for a single instance only: behind a load balancer each instance counts separately,
 * which multiplies the guesses an attacker gets. Phase 1 adds a Redis adapter for that.
 */
export class MemoryLockout implements Lockout {
  readonly #entries: Map<string, Entry>
  #created: number

  /** @param clock - Time source for sweeping forgotten keys. */
  constructor(private readonly clock: Clock) {
    // Assigned here rather than as field initializers: Bun's per-file coverage counts
    // initializers as an uncalled function.
    this.#entries = new Map()
    this.#created = 0
  }

  /** @inheritdoc */
  async attempt(key: string, policy: LockoutPolicy, now: Date): Promise<LockoutDecision> {
    const time = now.getTime()
    let entry = this.#entries.get(key)
    if (entry && time < entry.lockedUntil) {
      return { allowed: false, retryAfterMs: entry.lockedUntil - time }
    }
    if (!entry || time >= entry.forgetAt) {
      this.#created += 1
      // Sweep before inserting: the new entry has no `forgetAt` yet and would sweep itself.
      if (this.#created % SWEEP_EVERY === 0) {
        this.#sweep()
      }
      entry = { failures: 0, lockedUntil: 0, forgetAt: 0 }
      this.#entries.set(key, entry)
    }
    // No `await` between the check above and these writes, so concurrent attempts are counted
    // one at a time.
    entry.failures += 1
    entry.lockedUntil = time + lockoutDelayMs(policy, entry.failures)
    entry.forgetAt = Math.max(entry.lockedUntil, time) + policy.forgetAfterMs
    return { allowed: true, retryAfterMs: 0 }
  }

  /** @inheritdoc */
  async clear(key: string): Promise<void> {
    this.#entries.delete(key)
  }

  /** Number of keys held, including forgotten ones not yet swept (for tests). */
  get size(): number {
    return this.#entries.size
  }

  #sweep(): void {
    const time = this.clock.now().getTime()
    for (const [key, entry] of this.#entries) {
      if (time >= entry.forgetAt) {
        this.#entries.delete(key)
      }
    }
  }
}
