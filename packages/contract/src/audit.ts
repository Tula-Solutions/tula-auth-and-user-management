import { z } from 'zod'
import { PaginationMetaSchema } from './user'

/**
 * Everything the API records. Each entry is written to the event outbox (for webhooks) and to
 * the audit log, in the same database transaction as the change it describes.
 *
 * A session ends with exactly one of `session.revoked` (its `reason` says why) or
 * `session.reuse_detected` (a rotated refresh token was replayed, so the session was revoked as
 * possibly stolen).
 */
export const ACTIVITY_TYPES = [
  'user.created',
  'user.email_verified',
  'user.banned',
  'user.unbanned',
  'user.deleted',
  'user.password_changed',
  'session.created',
  'session.revoked',
  'session.reuse_detected',
  'api_key.created',
  'api_key.revoked',
  'signing_key.rotated',
] as const

/** One of {@link ACTIVITY_TYPES}. */
export const ActivityTypeSchema = z.enum(ACTIVITY_TYPES).meta({ ref: 'ActivityType' })

/**
 * Who can perform a recorded action: a signed-in `user`, an `admin` (a secret key; the id is the
 * key's), the `system` itself, or an AI `agent` acting through the MCP server.
 */
export const AUDIT_ACTOR_TYPES = ['user', 'admin', 'system', 'agent'] as const

/** What a recorded action can be about. */
export const AUDIT_TARGET_TYPES = ['user', 'session', 'api_key', 'signing_key'] as const

/**
 * One audit log entry.
 *
 * `action` and `target.type` are plain strings, not enums, so a client built against this
 * version keeps working when a later server records new kinds of action.
 */
export const AuditLogSchema = z
  .object({
    id: z.string(),
    /** What happened, e.g. `user.banned`. See {@link ACTIVITY_TYPES}. */
    action: z.string(),
    actor: z.object({
      type: z.enum(AUDIT_ACTOR_TYPES),
      /** User id or API key id; `null` for the system. */
      id: z.string().nullable(),
    }),
    target: z.object({ type: z.string(), id: z.string() }).nullable(),
    ipAddress: z.string().nullable(),
    userAgent: z.string().nullable(),
    /** Details of the action, e.g. `{ "reason": "reuse_detected" }`. Never secrets or emails. */
    metadata: z.record(z.string(), z.unknown()),
    occurredAt: z.iso.datetime(),
  })
  .meta({ ref: 'AuditLog' })

/** One page of audit log entries, newest first. */
export const AuditLogListSchema = z
  .object({ meta: PaginationMetaSchema, data: z.array(AuditLogSchema) })
  .meta({ ref: 'AuditLogList' })

/** A recorded action type. */
export type ActivityType = z.infer<typeof ActivityTypeSchema>
/** Who performed an action. */
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number]
/** What an action was about. */
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number]
/** An audit log entry. */
export type AuditLog = z.infer<typeof AuditLogSchema>
/** A page of audit log entries. */
export type AuditLogList = z.infer<typeof AuditLogListSchema>
