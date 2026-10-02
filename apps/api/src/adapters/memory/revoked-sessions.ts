import type { Clock } from '~/ports/clock'
import type { RevokedSessions } from '~/ports/revoked-sessions'

/** Expired entries are swept after this many additions, bounding memory. */
const SWEEP_EVERY = 500

/**
 * Revoked-session denylist held in process memory.
 *
 * Correct for a single instance only: another instance keeps honouring a revoked session's
 * access token until it expires (at most the access-token TTL). Phase 1 adds a Redis adapter.
 */
export class MemoryRevokedSessions implements RevokedSessions {
  readonly #until: Map<string, number>
  #added: number

  /** @param clock - Time source for sweeping expired entries. */
  constructor(private readonly clock: Clock) {
    // Assigned here rather than as field initializers: Bun's per-file coverage counts
    // initializers as an uncalled function.
    this.#until = new Map()
    this.#added = 0
  }

  /** @inheritdoc */
  async add(sessionId: string, until: Date): Promise<void> {
    this.#until.set(sessionId, Math.max(until.getTime(), this.#until.get(sessionId) ?? 0))
    this.#added += 1
    if (this.#added % SWEEP_EVERY === 0) {
      const now = this.clock.now().getTime()
      for (const [id, expiry] of this.#until) {
        if (expiry <= now) {
          this.#until.delete(id)
        }
      }
    }
  }

  /** @inheritdoc */
  async has(sessionId: string, now: Date): Promise<boolean> {
    const until = this.#until.get(sessionId)
    return until !== undefined && until > now.getTime()
  }

  /** How many entries are held, including expired ones not yet swept (for tests). */
  get size(): number {
    return this.#until.size
  }
}
