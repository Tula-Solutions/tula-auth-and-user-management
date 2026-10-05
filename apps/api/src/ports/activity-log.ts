import type { ActivityType, AuditActorType, AuditTargetType } from '@tula/contract'

/**
 * Something that happened and must be on record: an auth event or an admin action.
 *
 * Stores take an activity alongside the write it describes and persist both in **one
 * transaction**: the change and its record either both happen or neither does. Each activity
 * becomes an outbox event (for webhooks) and an audit log entry, sharing `id`.
 *
 * Never put a password, token, code, key or email address in `data`.
 */
export interface Activity {
  id: string
  projectId: string
  environmentId: string
  type: ActivityType
  actor: { type: AuditActorType; id: string | null }
  target: { type: AuditTargetType; id: string }
  /** A valid IP address or `null`; the audit column rejects anything else. */
  ipAddress: string | null
  userAgent: string | null
  /** Details of the action. Goes to the event payload and the audit entry's metadata. */
  data: Record<string, unknown>
  occurredAt: Date
}

/**
 * Why a write is deliberately left out of the audit log. A closed list: a new reason is a
 * decision, made here and in ADR 0012, not at a call site.
 *
 * - `fixture`: the row stands for something that happened elsewhere (a test's or a
 *   development fixture's seed data). Never passed by the server's own code: a test
 *   (`ports/activity-log.test.ts`) refuses every way of reaching `Audit.none` or
 *   {@link unrecordedFor} under `apps/api/src` outside tests and test support.
 */
export type UnrecordedReason = 'fixture'

/**
 * The key of an {@link Unrecorded}. **Not exported, on purpose**: a value keyed by it can only
 * be made in this module, so no object literal anywhere else is an `Unrecorded`, to the
 * compiler or at run time. It is not `Symbol.for`: the registry would hand it to anyone.
 */
const UNRECORDED: unique symbol = Symbol('unrecorded')

/**
 * The value a caller passes **instead of** an {@link Activity} to say, visibly, that a write
 * is not recorded. Built only by `Audit.none(reason)`, through {@link unrecordedFor}; told
 * apart only with {@link isUnrecorded}. It has no field a caller can write or read.
 */
export interface Unrecorded {
  readonly [UNRECORDED]: UnrecordedReason
}

/**
 * Build an {@link Unrecorded}. The key lives here, so the value has to be made here; **the
 * one caller is `Audit.none`** (`~/modules/audit/service`), which is what everything else
 * uses. `ports/activity-log.test.ts` fails if any other file of the server names this.
 *
 * @param reason - Why the write is not recorded.
 * @returns The value to pass in place of an activity.
 */
export function unrecordedFor(reason: UnrecordedReason): Unrecorded {
  return Object.freeze({ [UNRECORDED]: reason })
}

/**
 * Whether a store was told, explicitly, to record nothing.
 *
 * Asks for the key itself, as an own property. Anything else (a cast object, a look-alike
 * with a string key, another symbol of the same description) is not one, and a store then
 * treats it as the activity it claims to be: nothing is skipped silently.
 *
 * @param recorded - What the caller passed.
 * @returns `true` for a value {@link unrecordedFor} built.
 */
export function isUnrecorded(recorded: Recorded): recorded is Unrecorded {
  return Object.hasOwn(recorded, UNRECORDED)
}

/**
 * What every store method that changes who can do what takes with its write: the
 * {@link Activity} that records it, or an explicit {@link Unrecorded}. It is never optional, so
 * a call that forgets the audit entry does not compile.
 *
 * The writes ADR 0012 lists as never recorded take neither: they are methods of their own
 * (`upgradePasswordHash`, the signing-key store's `insert`).
 */
export type Recorded = Activity | Unrecorded

/**
 * The activity a store has to write for a call, if any.
 *
 * @param recorded - What the caller passed.
 * @returns The activity, or `undefined` for an explicit {@link Unrecorded}.
 */
export function activityOf(recorded: Recorded): Activity | undefined {
  return isUnrecorded(recorded) ? undefined : recorded
}

/**
 * The activities a store has to write for several changes of one call.
 *
 * @param recorded - What the caller passed for each change.
 * @returns The activities among them, in order.
 */
export function recordedOf(recorded: readonly Recorded[]): Activity[] {
  return recorded.flatMap((one) => activityOf(one) ?? [])
}

/**
 * An audit log entry as read back. Looser than {@link Activity}: the log may hold actions and
 * targets recorded by another version of the server.
 */
export interface AuditEntry extends Omit<Activity, 'type' | 'target'> {
  type: string
  target: { type: string; id: string } | null
}

/** Which audit entries to list. */
export interface AuditCriteria {
  /** Only this action. */
  action?: ActivityType
  /** Only actions performed by this user or API key. */
  actorId?: string
  /** Only actions on this user, session or key. */
  targetId?: string
  /** Only entries by this kind of actor, e.g. `instance_admin` for what the dashboard did. */
  actorType?: AuditActorType
  /** Entries at or after this instant. */
  from?: Date
  /** Entries before this instant. */
  to?: Date
  /** 1-based page. */
  page: number
  /** Page size. */
  size: number
}

/**
 * Reads the audit log. Writing has no method here on purpose: activity is only ever written by
 * a store, inside the transaction of the change it records.
 */
export interface ActivityLog {
  /**
   * @param environmentId - The environment to list.
   * @param criteria - Filters and paging.
   * @returns One page of entries, newest first, and the total number that match.
   */
  listAudit(
    environmentId: string,
    criteria: AuditCriteria
  ): Promise<{ entries: AuditEntry[]; totalCount: number }>
}
