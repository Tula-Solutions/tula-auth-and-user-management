import type { BreachChecker, BreachStatus } from '~/ports/breach-checker'

/** Breach checker backed by an in-memory list, for tests. */
export class MemoryBreachChecker implements BreachChecker {
  readonly #breached: Set<string>
  /** Simulates the breach source being down (`check` returns `unknown`). */
  unavailable: boolean
  /** How many lookups were made, so tests can assert when the check is skipped. */
  checks: number

  /** @param breached - Passwords to report as breached. */
  constructor(breached: Iterable<string> = []) {
    // Assigned here rather than as field initializers: Bun's per-file coverage counts
    // initializers as an uncalled function.
    this.#breached = new Set(breached)
    this.unavailable = false
    this.checks = 0
  }

  /** @inheritdoc */
  async check(password: string): Promise<BreachStatus> {
    this.checks++
    if (this.unavailable) {
      return 'unknown'
    }
    return this.#breached.has(password) ? 'breached' : 'clean'
  }
}
