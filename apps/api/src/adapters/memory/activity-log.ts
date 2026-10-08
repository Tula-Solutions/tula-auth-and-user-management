import type { ActivityType } from '@tula/contract'
import { type EventPayload, eventPayload } from '~/lib/event-payload'
import type { Activity, ActivityLog, AuditCriteria, AuditEntry } from '~/ports/activity-log'

/**
 * Recorded activity held in memory, for tests.
 *
 * The memory stores share one instance and append to it as part of the write an activity
 * describes, mirroring the single transaction of the Postgres stores.
 */
export class MemoryActivityLog implements ActivityLog {
  /** Everything recorded so far, oldest first. */
  readonly entries: Activity[]
  /**
   * The outbox: the event payload of everything recorded so far, oldest first. What the
   * Postgres stores write to `events.payload`, built by the same function. Not part of the
   * port (nothing reads the outbox yet): tests read it here.
   */
  readonly events: EventPayload[]

  constructor() {
    // Assigned here rather than as a field initializer: Bun's per-file coverage counts
    // initializers as an uncalled function.
    this.entries = []
    this.events = []
  }

  /**
   * Append activity. Called by the memory stores only when their write took effect.
   *
   * @param activities - What to record.
   */
  record(activities: readonly Activity[]): void {
    this.entries.push(...activities.map((activity) => structuredClone(activity)))
    this.events.push(...activities.map(eventPayload))
  }

  /**
   * @param type - An activity type.
   * @returns Every recorded activity of that type, oldest first.
   */
  ofType(type: ActivityType): Activity[] {
    return this.entries.filter((entry) => entry.type === type)
  }

  /** @inheritdoc */
  async listAudit(
    environmentId: string,
    criteria: AuditCriteria
  ): Promise<{ entries: AuditEntry[]; totalCount: number }> {
    const matches = this.entries
      .filter(
        (entry) =>
          entry.environmentId === environmentId &&
          (!criteria.action || entry.type === criteria.action) &&
          (!criteria.actorId || entry.actor.id === criteria.actorId) &&
          (!criteria.targetId || entry.target.id === criteria.targetId) &&
          (!criteria.actorType || entry.actor.type === criteria.actorType) &&
          (!criteria.from || entry.occurredAt.getTime() >= criteria.from.getTime()) &&
          (!criteria.to || entry.occurredAt.getTime() < criteria.to.getTime())
      )
      .sort(
        (x, y) =>
          y.occurredAt.getTime() - x.occurredAt.getTime() ||
          (y.id > x.id ? 1 : y.id < x.id ? -1 : 0)
      )
    const start = (criteria.page - 1) * criteria.size
    return {
      entries: matches.slice(start, start + criteria.size).map((entry) => structuredClone(entry)),
      totalCount: matches.length,
    }
  }
}
