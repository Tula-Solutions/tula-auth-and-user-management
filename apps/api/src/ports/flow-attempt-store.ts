import type { FlowKind, FlowStatus } from '@tula/contract'

/** An in-progress sign-in or sign-up and the step it is waiting on. */
export interface FlowAttemptRecord {
  id: string
  projectId: string
  environmentId: string
  kind: FlowKind
  /** The step the attempt is waiting on. */
  status: FlowStatus
  /** Set once the attempt is tied to a user. Never exposed before the flow completes. */
  userId: string | null
  /** Normalized identifier (email) the attempt started with. */
  identifier: string
  /** Step-specific server state. Never sent to clients. */
  state: Record<string, unknown>
  expiresAt: Date
  completedAt: Date | null
  createdAt: Date
}

/** An attempt to store. */
export type NewFlowAttempt = Omit<FlowAttemptRecord, 'completedAt'>

/** What a transition changes. Omitted fields keep their value. */
export interface FlowAttemptChange {
  status: FlowStatus
  userId?: string
  state?: Record<string, unknown>
  /** Set when the new status is `complete`. */
  completedAt?: Date
}

/** Flow attempts, always read and written inside one environment. */
export interface FlowAttemptStore {
  /** @param attempt - The attempt to store. */
  create(attempt: NewFlowAttempt): Promise<void>

  /**
   * @param environmentId - The environment to look in.
   * @param id - Attempt id.
   * @returns The attempt (whatever its state), or `null`.
   */
  findById(environmentId: string, id: string): Promise<FlowAttemptRecord | null>

  /**
   * Move an attempt to its next step, as a compare-and-set: it only happens if the attempt is
   * still waiting on `from`, is not completed and has not expired. Of two concurrent
   * transitions from the same step exactly one succeeds.
   *
   * @param environmentId - The attempt's environment.
   * @param id - Attempt id.
   * @param from - The step the caller believes the attempt is on.
   * @param change - The new step and fields.
   * @param at - Current time.
   * @returns `false` when the guard failed (nothing was written).
   */
  transition(
    environmentId: string,
    id: string,
    from: FlowStatus,
    change: FlowAttemptChange,
    at: Date
  ): Promise<boolean>

  /**
   * Remove one attempt (and, by cascade, its verification tokens). A no-op if it is not there.
   *
   * @param environmentId - The attempt's environment.
   * @param id - Attempt id.
   */
  delete(environmentId: string, id: string): Promise<void>

  /**
   * Remove attempts in an environment whose lifetime is over, completed or not (and, by
   * cascade, their verification tokens). Abandoned sign-ups hold a pending password hash, so
   * they must not be kept. At most `limit` go per call, so no call holds locks for long; the
   * caller repeats while a full batch comes back.
   *
   * @param environmentId - The environment to purge.
   * @param now - Current time; attempts with `expiresAt <= now` go.
   * @param limit - The most attempts to remove in this call.
   * @returns How many attempts were removed.
   */
  deleteExpired(environmentId: string, now: Date, limit: number): Promise<number>
}
