import type { EnvironmentLock, EnvironmentLockScope } from '~/ports/environment-lock'

/**
 * An environment lock held in memory, for tests and for nothing else: it only serialises
 * callers that share this object. Two test "instances" share one to stand in for two processes
 * sharing a database.
 */
export class MemoryEnvironmentLock implements EnvironmentLock {
  /** The end of each key's queue: the promise the next caller waits for. */
  readonly #tails: Map<string, Promise<void>>

  constructor() {
    // Assigned here rather than as a field initializer: Bun's per-file coverage counts
    // initializers as an uncalled function.
    this.#tails = new Map()
  }

  /** @inheritdoc */
  async runExclusive<T>(
    environmentId: string,
    scope: EnvironmentLockScope,
    fn: () => Promise<T>
  ): Promise<T> {
    const key = `${scope}:${environmentId}`
    const before = this.#tails.get(key) ?? Promise.resolve()
    let release: () => void = () => undefined
    const mine = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = before.then(() => mine)
    this.#tails.set(key, tail)
    await before
    try {
      return await fn()
    } finally {
      release()
      if (this.#tails.get(key) === tail) {
        this.#tails.delete(key)
      }
    }
  }
}
