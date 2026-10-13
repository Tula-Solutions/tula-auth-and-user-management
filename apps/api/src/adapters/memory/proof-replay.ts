import type { Clock } from '~/ports/clock'
import type { ProofReplayGuard } from '~/ports/proof-replay'

/** Expired entries are swept after this many additions, bounding memory. */
const SWEEP_EVERY = 500

/**
 * The ids of accepted proofs, held in process memory.
 *
 * Correct for a single instance only: a proof replayed against another instance within its
 * nonce's life is accepted there once (ADR 0043). `RedisProofReplayGuard` is the adapter for
 * several instances; this one is used when `REDIS_URL` is unset and by unit tests.
 */
export class MemoryProofReplayGuard implements ProofReplayGuard {
  readonly #until: Map<string, number>
  #added: number

  /** @param clock - Time source for forgetting entries. */
  constructor(private readonly clock: Clock) {
    // Assigned here rather than as field initializers: Bun's per-file coverage counts
    // initializers as an uncalled function.
    this.#until = new Map()
    this.#added = 0
  }

  /** @inheritdoc */
  async remember(id: string, until: Date): Promise<boolean> {
    // No await between the look and the write: one turn of the event loop, which is what makes
    // the step atomic here.
    const now = this.clock.now().getTime()
    const known = this.#until.get(id)
    if (known !== undefined && known > now) {
      return false
    }
    this.#until.set(id, until.getTime())
    this.#added += 1
    if (this.#added % SWEEP_EVERY === 0) {
      for (const [entry, expiry] of this.#until) {
        if (expiry <= now) {
          this.#until.delete(entry)
        }
      }
    }
    return true
  }

  /** How many entries are held, including expired ones not yet swept (for tests). */
  get size(): number {
    return this.#until.size
  }
}
