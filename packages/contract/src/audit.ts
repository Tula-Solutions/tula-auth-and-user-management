import { z } from 'zod'
import { ACTIVITY_TYPES } from './event-types'
import { PaginationMetaSchema } from './user'

// The list of types lives in the Zod-free `./event-types`; re-exported so that this module
// stays the one place to import everything about the audit log from.
export { ACTIVITY_TYPES, type ActivityType } from './event-types'

/** One of {@link ACTIVITY_TYPES}. */
export const ActivityTypeSchema = z.enum(ACTIVITY_TYPES).meta({ ref: 'ActivityType' })

/**
 * Who can perform a recorded action: a signed-in `user`, an `admin` (a secret key; the id is the
 * key's), the `system` itself, an AI `agent` acting through the MCP server, or the
 * `instance_admin`: the operator of the deployment, through the dashboard (the id is the
 * dashboard session's) or with the instance admin token itself (no id).
 */
export const AUDIT_ACTOR_TYPES = ['user', 'admin', 'system', 'agent', 'instance_admin'] as const

/**
 * What the instance audit log records: what the operator of a deployment did outside any one
 * environment (ADR 0032). Signing in to the dashboard (and failing to), signing out, and every
 * change to workspaces, projects and environments.
 */
export const INSTANCE_ACTIVITY_TYPES = [
  'instance.signed_in',
  'instance.sign_in_failed',
  'instance.signed_out',
  'workspace.created',
  'project.created',
  'project.renamed',
  'environment.created',
] as const

/** One of {@link INSTANCE_ACTIVITY_TYPES}. */
export const InstanceActivityTypeSchema = z
  .enum(INSTANCE_ACTIVITY_TYPES)
  .meta({ ref: 'InstanceActivityType' })

/** What an instance audit entry can be about. */
export const INSTANCE_AUDIT_TARGET_TYPES = ['workspace', 'project', 'environment'] as const

/** What a recorded action can be about. */
export const AUDIT_TARGET_TYPES = [
  'user',
  'session',
  'api_key',
  'signing_key',
  'environment',
] as const

/**
 * One audit log entry.
 *
 * `action`, `actor.type` and `target.type` are plain strings, not enums, so a client built against this
 * version keeps working when a later server records new kinds of action.
 */
export const AuditLogSchema = z
  .object({
    id: z.string(),
    /** What happened, e.g. `user.banned`. See {@link ACTIVITY_TYPES}. */
    action: z.string(),
    actor: z.object({
      /** One of {@link AUDIT_ACTOR_TYPES} today. */
      type: z.string(),
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

/** A recorded instance action type. */
export type InstanceActivityType = z.infer<typeof InstanceActivityTypeSchema>
/** What an instance action was about. */
export type InstanceAuditTargetType = (typeof INSTANCE_AUDIT_TARGET_TYPES)[number]
/** Who performed an action. */
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number]
/** What an action was about. */
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number]
/** An audit log entry. */
export type AuditLog = z.infer<typeof AuditLogSchema>
/** A page of audit log entries. */
export type AuditLogList = z.infer<typeof AuditLogListSchema>
