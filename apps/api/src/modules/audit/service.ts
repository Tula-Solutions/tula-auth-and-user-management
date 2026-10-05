import {
  type ActivityType,
  type AuditActorType,
  type AuditLog,
  type AuditLogList,
  type AuditTargetType,
  DEFAULT_PAGE_SIZE,
} from '@tula/contract'
import type { Deps, Tenant } from '~/dependencies'
import { type Actor, cleanOrigin } from '~/lib/actor'
import {
  type Activity,
  type AuditEntry,
  type Unrecorded,
  type UnrecordedReason,
  unrecordedFor,
} from '~/ports/activity-log'

/** What happened, to build an {@link Activity} from. */
export interface EntryInput {
  type: ActivityType
  actor: Actor
  target: { type: AuditTargetType; id: string }
  /** Details of the action. Never a password, token, code, key or email address. */
  data?: Record<string, unknown>
}

/**
 * Build the record of an action, ready to hand to the store method that performs it.
 *
 * The store writes it in the same transaction as the change, so this only builds the value. The
 * actor's origin is cleaned again here: an invalid IP would fail the audit insert and take the
 * change down with it.
 *
 * @param deps - Id generator and clock.
 * @param scope - The project and environment the action happens in.
 * @param input - Type, actor, target and details.
 * @returns The activity.
 *
 * @example
 * ```ts
 * await deps.users.delete(environmentId, userId, Audit.entry(deps, scope, {
 *   type: 'user.deleted', actor, target: { type: 'user', id: userId },
 * }))
 * ```
 */
export function entry(
  deps: Pick<Deps, 'ids' | 'clock'>,
  scope: Pick<Tenant, 'projectId' | 'environmentId'>,
  input: EntryInput
): Activity {
  return {
    id: deps.ids.next(),
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    type: input.type,
    actor: { type: input.actor.type, id: input.actor.id },
    target: input.target,
    ...cleanOrigin(input.actor),
    data: input.data ?? {},
    occurredAt: deps.clock.now(),
  }
}

/**
 * Say, where a store method wants an activity, that this write is deliberately not recorded.
 *
 * Every store method that changes who can do what requires an activity; this is the one way
 * to pass none, and it shows at the call site with its reason. The reasons are a closed list
 * (`UnrecordedReason`, ADR 0012), and the server's own code has none: a test
 * (`ports/activity-log.test.ts`) fails if a file outside tests and test support reaches this
 * function by any import form. The value is branded with a key only the port's module holds,
 * so it cannot be written as a literal instead.
 *
 * @param reason - Why the write is not recorded.
 * @returns The value to pass in place of the activity.
 *
 * @example
 * ```ts
 * await deps.users.create(user, Audit.none('fixture'))
 * ```
 */
export function none(reason: UnrecordedReason): Unrecorded {
  return unrecordedFor(reason)
}

function toAuditLog(record: AuditEntry): AuditLog {
  return {
    id: record.id,
    action: record.type,
    actor: record.actor,
    target: record.target,
    ipAddress: record.ipAddress,
    userAgent: record.userAgent,
    metadata: record.data,
    occurredAt: record.occurredAt.toISOString(),
  }
}

/** Which audit entries to list. Every field is optional. */
export interface ListInput {
  action?: ActivityType
  actorId?: string
  targetId?: string
  /** Only entries by this kind of actor. */
  actorType?: AuditActorType
  /** ISO 8601: entries at or after this instant. */
  from?: string
  /** ISO 8601: entries before this instant. */
  to?: string
  page?: number
  size?: number
}

/**
 * List an environment's audit log, newest first, one page at a time.
 *
 * @param deps - Activity log.
 * @param scope - The environment.
 * @param input - Filters and paging (defaults: page 1, 20 per page).
 * @returns The page and its paging details.
 */
export async function list(
  deps: Pick<Deps, 'activityLog'>,
  scope: Pick<Tenant, 'environmentId'>,
  input: ListInput
): Promise<AuditLogList> {
  const page = input.page ?? 1
  const perPage = input.size ?? DEFAULT_PAGE_SIZE
  const { entries, totalCount } = await deps.activityLog.listAudit(scope.environmentId, {
    action: input.action,
    actorId: input.actorId,
    targetId: input.targetId,
    actorType: input.actorType,
    from: input.from ? new Date(input.from) : undefined,
    to: input.to ? new Date(input.to) : undefined,
    page,
    size: perPage,
  })
  return {
    meta: { totalCount, totalPages: Math.ceil(totalCount / perPage), page, perPage },
    data: entries.map(toAuditLog),
  }
}
