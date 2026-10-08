import type { IdGenerator } from '~/ports/id-generator'

/** Deterministic, valid UUIDs (`…-000000000001`, `…-000000000002`, …) for readable assertions. */
export class SequentialIds implements IdGenerator {
  #counter: number

  // Assigned in the constructor, not as a field initializer: Bun's coverage counts a class with
  // initializers but no constructor as having an uncalled function, failing the per-file threshold.
  constructor() {
    this.#counter = 0
  }

  /** @returns The next id in sequence. */
  next(): string {
    this.#counter += 1
    return `00000000-0000-7000-8000-${this.#counter.toString(16).padStart(12, '0')}`
  }
}
