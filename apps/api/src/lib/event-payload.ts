import {
  type ActivityType,
  type AuditActorType,
  type AuditTargetType,
  EVENT_DATA_SCHEMAS,
  EVENT_SCHEMA_VERSION,
} from '@tula/contract'
import type { z } from 'zod'
import * as logger from '~/lib/logger'
import type { Activity } from '~/ports/activity-log'

/**
 * What the outbox stores for one activity (`events.payload`) and a webhook will deliver: the
 * `Event` of `@tula/contract`, built by {@link eventPayload}.
 *
 * `data` is typed loosely because it is built by filtering, not by parsing: a field the
 * type's schema requires is missing here if the activity did not carry it.
 */
export type EventPayload = {
  id: string
  type: ActivityType
  schemaVersion: typeof EVENT_SCHEMA_VERSION
  /** ISO 8601, UTC. */
  occurredAt: string
  actor: { type: AuditActorType; id: string | null }
  target: { type: AuditTargetType; id: string }
  data: Record<string, unknown>
}

/** The fields of `data` the type's schema allows, each with its own schema. */
function allowedFields(type: ActivityType): Record<string, z.ZodType> {
  // `hasOwn`: a type this version does not know (a cast, a row of another version) allows
  // nothing, rather than reading a schema off the prototype.
  return Object.hasOwn(EVENT_DATA_SCHEMAS, type) ? EVENT_DATA_SCHEMAS[type].shape : {}
}

/**
 * Build the event payload of an activity: the one place a recorded action becomes something a
 * third party will be sent. Both the memory and the Postgres stores call it.
 *
 * **An allow-list, applied field by field.** A payload keeps a key of `activity.data` only if
 * the type's schema in `@tula/contract` names it **and** the value is one that field's schema
 * accepts: so a key added at a call site without a decision in the contract goes nowhere, and
 * a named field cannot carry a string where an enum, an id or a list of key names belongs.
 * The IP address and the user agent are never copied (ADR 0012).
 *
 * **It never throws.** The payload is written in the transaction of the change it records; a
 * failure here would undo that change. What is refused is dropped, and the keys (never the
 * values) are logged.
 *
 * @param activity - The recorded action.
 * @returns The payload to store and deliver.
 *
 * @example
 * ```ts
 * await tx.insert(events).values({ id: activity.id, payload: eventPayload(activity), … })
 * ```
 */
export function eventPayload(activity: Activity): EventPayload {
  const fields = allowedFields(activity.type)
  const data: Record<string, unknown> = {}
  const dropped: string[] = []
  for (const [key, value] of Object.entries(activity.data)) {
    if (value === undefined) {
      continue
    }
    const parsed = Object.hasOwn(fields, key) ? fields[key]?.safeParse(value) : undefined
    if (parsed?.success && parsed.data !== undefined) {
      // The parsed value, not the one passed in: a copy, with nothing a nested schema strips.
      data[key] = parsed.data
    } else {
      dropped.push(key)
    }
  }
  if (dropped.length > 0) {
    // A programming error, not an attack: a call site records something the contract has no
    // field for. The names are the code's own; the values are never logged.
    logger.warn('event payload: dropped fields its schema does not allow', {
      type: activity.type,
      keys: dropped.sort(),
    })
  }
  return {
    id: activity.id,
    type: activity.type,
    schemaVersion: EVENT_SCHEMA_VERSION,
    occurredAt: activity.occurredAt.toISOString(),
    actor: { type: activity.actor.type, id: activity.actor.id },
    target: { type: activity.target.type, id: activity.target.id },
    data,
  }
}
