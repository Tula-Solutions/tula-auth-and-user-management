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
  // Two-step verification: turned on (a confirmed authenticator), turned off (`method` says by
  // the user or by an admin reset), a new set of backup codes, and a backup code used to get in.
  'user.mfa_enabled',
  'user.mfa_disabled',
  'user.backup_codes_regenerated',
  'user.backup_code_used',
  // A provider account (Google, GitHub, Apple) connected to or disconnected from a user;
  // `provider` says which, `method` how (`auto`, `profile`).
  'user.identity_linked',
  'user.identity_unlinked',
  'user.passkey_added',
  'user.passkey_renamed',
  'user.passkey_removed',
  'user.passkey_counter_regressed',
  'session.created',
  'session.revoked',
  'session.reuse_detected',
  // A signed-in user proved a factor again for a session (a step-up); `methods` says which.
  'session.stepped_up',
  'api_key.created',
  'api_key.revoked',
  'signing_key.rotated',
  'environment.settings_updated',
  // An OAuth provider's credentials set, changed or removed. `changed` lists keys, never values.
  'oauth_provider.updated',
  'oauth_provider.deleted',
] as const

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
