import type { FlowStatus } from '@tula/contract'
import type {
  FlowAttemptChange,
  FlowAttemptRecord,
  FlowAttemptStore,
  NewFlowAttempt,
  StateGuard,
} from '~/ports/flow-attempt-store'

/** Flow attempts held in memory, for tests. */
export class MemoryFlowAttemptStore implements FlowAttemptStore {
  readonly #attempts: Map<string, FlowAttemptRecord>

  constructor() {
    // Assigned here rather than as a field initializer: Bun's per-file coverage counts
    // initializers as an uncalled function.
    this.#attempts = new Map()
  }

  /** @inheritdoc */
  async create(attempt: NewFlowAttempt): Promise<void> {
    this.#attempts.set(attempt.id, structuredClone({ ...attempt, completedAt: null }))
  }

  /** @inheritdoc */
  async findById(environmentId: string, id: string): Promise<FlowAttemptRecord | null> {
    const attempt = this.#attempts.get(id)
    return attempt?.environmentId === environmentId ? structuredClone(attempt) : null
  }

  /** @inheritdoc */
  async transition(
    environmentId: string,
    id: string,
    from: FlowStatus,
    change: FlowAttemptChange,
    at: Date,
    guard?: StateGuard
  ): Promise<boolean> {
    const attempt = this.#attempts.get(id)
    if (
      !attempt ||
      (guard && attempt.state[guard.key] !== guard.value) ||
      attempt.environmentId !== environmentId ||
      attempt.status !== from ||
      attempt.completedAt !== null ||
      attempt.expiresAt.getTime() <= at.getTime()
    ) {
      return false
    }
    attempt.status = change.status
    attempt.userId = change.userId ?? attempt.userId
    attempt.identifier = change.identifier ?? attempt.identifier
    attempt.state = change.state ? structuredClone(change.state) : attempt.state
    attempt.completedAt = change.completedAt ?? null
    attempt.secretHash = change.secretHash ?? attempt.secretHash
    return true
  }

  /** @inheritdoc */
  async delete(environmentId: string, id: string): Promise<void> {
    if (this.#attempts.get(id)?.environmentId === environmentId) {
      this.#attempts.delete(id)
    }
  }

  /** @inheritdoc */
  async deleteExpired(environmentId: string, now: Date, limit: number): Promise<number> {
    let removed = 0
    for (const [id, attempt] of this.#attempts) {
      if (removed >= limit) {
        break
      }
      if (attempt.environmentId === environmentId && attempt.expiresAt.getTime() <= now.getTime()) {
        this.#attempts.delete(id)
        removed += 1
      }
    }
    return removed
  }
}
