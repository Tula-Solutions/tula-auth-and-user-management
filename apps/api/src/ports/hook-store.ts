import type { HookFailureMode, HookFailureReason, HookPoint } from '@tula/contract'
import type { Recorded } from '~/ports/activity-log'

/** A hook as stored (ADR 0035). */
export interface HookRecord {
  id: string
  projectId: string
  environmentId: string
  /** When the server asks it. An environment has one hook per point at most. */
  point: HookPoint
  /** Where the question is posted. Judged by the outbound guard when saved and at every call. */
  url: string
  /**
   * The signing secret, sealed (`~/lib/secret-box`, purpose `hook-secrets`, bound to
   * environment and hook id). Never leaves the API after the response that registered the hook.
   */
  secret: string
  /** A hook that is off is not asked. */
  enabled: boolean
  /** How long the server waits for the answer, in milliseconds: 100 to 5000. */
  deadlineMs: number
  /** What a failed call does. */
  failureMode: HookFailureMode
  /** When a call last failed; `null` when none ever has. */
  lastFailedAt: Date | null
  /** Why, in one of the server's fixed words. Set exactly when `lastFailedAt` is. */
  lastFailureReason: HookFailureReason | null
  createdAt: Date
  updatedAt: Date
}

/** The fields of a hook an update may change. The point, the secret and the id are not among them. */
export interface HookChanges {
  url?: string
  enabled?: boolean
  deadlineMs?: number
  failureMode?: HookFailureMode
}

/**
 * What of a hook a change was judged against: whether it was on and what a failure did. A
 * write that records whether it weakened the hook is made only over a row that still says
 * this, so the record is about the change that was actually made.
 */
export interface HookExpectation {
  enabled: boolean
  failureMode: HookFailureMode
}

/** Hooks, always read and written inside one environment. */
export interface HookStore {
  /**
   * @param environmentId - The environment to look in.
   * @returns Its hooks, oldest first.
   */
  list(environmentId: string): Promise<HookRecord[]>

  /**
   * @param environmentId - The environment to look in.
   * @param id - The hook.
   * @returns The hook, or `null` when the environment has none with that id.
   */
  find(environmentId: string, id: string): Promise<HookRecord | null>

  /**
   * The hook the server asks at a point, switched on or not.
   *
   * @param environmentId - The environment to look in. Another environment's hook is never returned.
   * @param point - The point.
   * @returns The hook, or `null` when the environment has registered none for the point.
   */
  findByPoint(environmentId: string, point: HookPoint): Promise<HookRecord | null>

  /**
   * Store a new hook.
   *
   * @param record - The hook, its secret already sealed.
   * @param activity - Recorded in the same transaction, only if the hook was stored.
   * @returns The row as stored, or `null` when the environment already has a hook for the
   *   point: the unique key decides, so of two registrations at once one is stored.
   */
  insert(record: HookRecord, activity: Recorded): Promise<HookRecord | null>

  /**
   * Change a hook, **only if it is still as on and as strict as the caller read it**.
   *
   * @param environmentId - The environment. A hook of another is not touched.
   * @param id - The hook.
   * @param expected - What the caller read and judged the change against.
   * @param changes - The fields to set; one left out keeps its value.
   * @param updatedAt - When the change is made.
   * @param activity - Recorded in the same transaction, only if the row was written.
   * @returns The hook as it is now, or `null` when nothing was written: the hook is gone, or
   *   it is no longer what `expected` says.
   */
  update(
    environmentId: string,
    id: string,
    expected: HookExpectation,
    changes: HookChanges,
    updatedAt: Date,
    activity: Recorded
  ): Promise<HookRecord | null>

  /**
   * Remove a hook, **only if it is still as on and as strict as the caller read it**.
   *
   * @param environmentId - The environment. A hook of another is not touched.
   * @param id - The hook.
   * @param expected - What the caller read and judged the removal against.
   * @param activity - Recorded in the same transaction, only if something was removed.
   * @returns `false` when nothing was removed: the hook is gone, or no longer what was read.
   */
  delete(
    environmentId: string,
    id: string,
    expected: HookExpectation,
    activity: Recorded
  ): Promise<boolean>

  /**
   * Note that a call of the hook failed: when, and why in a fixed word. What an operator is
   * shown of a hook that is failing. The server's own bookkeeping: it changes nothing about
   * who can do what and is **not recorded** (ADR 0012); `updatedAt` does not move, because no
   * administrator changed the hook.
   *
   * @param environmentId - The environment. A hook of another is not touched.
   * @param id - The hook. One that is gone is left alone.
   * @param at - When the call failed.
   * @param reason - Why.
   */
  noteFailure(environmentId: string, id: string, at: Date, reason: HookFailureReason): Promise<void>
}
