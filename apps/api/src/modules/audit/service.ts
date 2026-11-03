import {
  type ActivityType,
  type AuditActorType,
  type AuditExportFormat,
  type AuditLog,
  type AuditLogList,
  DEFAULT_PAGE_SIZE,
  type EventData,
  type EventTargetType,
  MAX_AUDIT_EXPORT_ROWS,
  parseAuditExportCursor,
} from '@tula-tech/contract'
import type { Deps, Tenant } from '~/dependencies'
import { type Actor, cleanOrigin } from '~/lib/actor'
import {
  type Activity,
  type AuditEntry,
  type Unrecorded,
  type UnrecordedReason,
  unrecordedFor,
} from '~/ports/activity-log'

/**
 * The details of one action: the `data` the type's event schema in `@tula-tech/contract` names.
 * Optional where every field of it is (or it has none), required otherwise.
 */
type EntryData<T extends ActivityType> =
  Record<string, never> extends EventData<T> ? { data?: EventData<T> } : { data: EventData<T> }

/**
 * What happened, to build an {@link Activity} from: a union discriminated by `type`.
 *
 * Each type fixes what the action is about (`target.type`) and which details it carries
 * (`data`), both taken from the event contract (`EVENT_TARGET_TYPES`, `EVENT_DATA_SCHEMAS`).
 * A call site that records a detail the contract does not name does not compile: a field
 * reaches a webhook payload by a decision in the contract, never by being passed along.
 * Never a password, token, code, key or email address.
 */
export type EntryInput = {
  [T in ActivityType]: {
    type: T
    actor: Actor
    target: { type: EventTargetType<T>; id: string }
  } & EntryData<T>
}[ActivityType]

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

/** What an export is asked for: the list's filters, an organization, a format and a cursor. */
export interface ExportInput extends Omit<ListInput, 'page' | 'size'> {
  /** Only entries about this organization. */
  organizationId?: string
  format: AuditExportFormat
  /** A cursor from an earlier export: write the entries after it. */
  after?: string
}

/** The entries read from the store at a time while an export streams. */
const EXPORT_PAGE = 1000

/** The columns of a CSV export: the list's fields, with `actor`, `target` and `metadata` flattened. */
export const EXPORT_CSV_COLUMNS = [
  'id',
  'occurredAt',
  'action',
  'actorType',
  'actorId',
  'targetType',
  'targetId',
  'ipAddress',
  'userAgent',
  'metadata',
] as const

/**
 * One CSV cell.
 *
 * A cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with `'`:
 * a spreadsheet would run it as a formula, and the user agent and the metadata are text a
 * stranger chose (OWASP "CSV injection"). Quoting follows RFC 4180.
 *
 * @param value - The cell's text, or `null` for an empty one.
 * @returns The cell as written to the file.
 */
export function csvCell(value: string | null): string {
  if (value === null || value === '') {
    return ''
  }
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}

function csvRow(log: AuditLog): string {
  return `${[
    log.id,
    log.occurredAt,
    log.action,
    log.actor.type,
    log.actor.id,
    log.target?.type ?? null,
    log.target?.id ?? null,
    log.ipAddress,
    log.userAgent,
    JSON.stringify(log.metadata),
  ]
    .map(csvCell)
    .join(',')}\r\n`
}

/**
 * Stream an environment's audit log, oldest first, as NDJSON or CSV, and record the export.
 *
 * Keyset-paged on `(occurredAt, id)`, so memory stays at one page whatever the length and a
 * resume with the last entry's cursor (`auditExportCursor`) continues with no gap and no
 * duplicate. One request writes at most `MAX_AUDIT_EXPORT_ROWS` entries. The `audit.exported`
 * entry is written when the stream ends, **also when the reader stops early**, with the
 * number of rows actually written: the log shows what left the system.
 *
 * @param deps - Activity log, ids and clock.
 * @param scope - The project and environment.
 * @param actor - Who asked.
 * @param input - Filters, format and optional cursor.
 * @returns Chunks of text to write to the response, in order.
 */
export async function* exportEntries(
  deps: Pick<Deps, 'activityLog' | 'ids' | 'clock'>,
  scope: Pick<Tenant, 'projectId' | 'environmentId'>,
  actor: Actor,
  input: ExportInput
): AsyncGenerator<string> {
  const cursor = input.after ? parseAuditExportCursor(input.after) : null
  let after = cursor ? { occurredAt: new Date(cursor.occurredAt), id: cursor.id } : null
  const criteria = {
    action: input.action,
    actorId: input.actorId,
    targetId: input.targetId,
    actorType: input.actorType,
    organizationId: input.organizationId,
    from: input.from ? new Date(input.from) : undefined,
    to: input.to ? new Date(input.to) : undefined,
  }
  let rows = 0
  try {
    if (input.format === 'csv') {
      yield `${EXPORT_CSV_COLUMNS.join(',')}\r\n`
    }
    while (rows < MAX_AUDIT_EXPORT_ROWS) {
      const want = Math.min(EXPORT_PAGE, MAX_AUDIT_EXPORT_ROWS - rows)
      const page = await deps.activityLog.listAuditAfter(scope.environmentId, criteria, after, want)
      for (const record of page) {
        const log = toAuditLog(record)
        rows += 1
        yield input.format === 'csv' ? csvRow(log) : `${JSON.stringify(log)}\n`
      }
      const last = page.at(-1)
      if (!last || page.length < want) {
        break
      }
      after = { occurredAt: last.occurredAt, id: last.id }
    }
  } finally {
    await deps.activityLog.append(
      entry(deps, scope, {
        type: 'audit.exported',
        actor,
        target: { type: 'environment', id: scope.environmentId },
        data: {
          format: input.format,
          rowCount: rows,
          resumed: cursor !== null,
          ...(input.action && { action: input.action }),
          ...(input.actorId && { actorId: input.actorId }),
          ...(input.actorType && { actorType: input.actorType }),
          ...(input.targetId && { targetId: input.targetId }),
          ...(input.organizationId && { organizationId: input.organizationId }),
          ...(input.from && { from: input.from }),
          ...(input.to && { to: input.to }),
        },
      })
    )
  }
}
