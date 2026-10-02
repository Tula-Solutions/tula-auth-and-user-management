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
