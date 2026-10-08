import type { ActivityType } from '@tula/contract'
import { type EventPayload, eventPayload } from '~/lib/event-payload'
import type { Activity, ActivityLog, AuditCriteria, AuditEntry } from '~/ports/activity-log'

/** One row of the memory outbox: what the Postgres stores write to `tula.events`. */
export interface OutboxRow {
  id: string
  projectId: string
  environmentId: string
  type: string
  /** Loosely typed, as the column is: a test may seed a row of an older shape. */
  payload: Record<string, unknown>
  occurredAt: Date
  /** `null` until the webhook worker has settled the event. */
  deliveredAt: Date | null
}

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
   * port: tests read it here.
   */
  readonly events: EventPayload[]
  /**
   * The outbox as rows, with what the `events` table adds to a payload: the environment and
   * whether the event was delivered. The memory webhook delivery store reads and marks these.
   */
  readonly outbox: OutboxRow[]

  constructor() {
    // Assigned here rather than as a field initializer: Bun's per-file coverage counts
    // initializers as an uncalled function.
    this.entries = []
    this.events = []
    this.outbox = []
  }

  /**
   * Append activity. Called by the memory stores only when their write took effect.
   *
   * @param activities - What to record.
   */
  record(activities: readonly Activity[]): void {
    this.entries.push(...activities.map((activity) => structuredClone(activity)))
    for (const activity of activities) {
      const payload = eventPayload(activity)
      this.events.push(payload)
      this.outbox.push({
        id: activity.id,
        projectId: activity.projectId,
        environmentId: activity.environmentId,
        type: activity.type,
        payload: structuredClone(payload),
        occurredAt: new Date(activity.occurredAt),
        deliveredAt: null,
      })
    }
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

  /**
   * @inheritdoc
   *
   * Removes from {@link MemoryActivityLog.entries} (the audit log) only. The outbox
   * ({@link MemoryActivityLog.events}, {@link MemoryActivityLog.outbox}) is left as it is, as
   * in Postgres: an event has its own end of life.
   */
  async deleteAuditBefore(environmentId: string, before: Date, limit: number): Promise<number> {
    const doomed = new Set(
      this.entries
        .filter(
          (entry) =>
            entry.environmentId === environmentId && entry.occurredAt.getTime() < before.getTime()
        )
        .sort((x, y) => x.occurredAt.getTime() - y.occurredAt.getTime() || x.id.localeCompare(y.id))
        .slice(0, limit)
        .map((entry) => entry.id)
    )
    // In place: the stores and the tests hold this very array.
    for (let index = this.entries.length - 1; index >= 0; index--) {
      if (doomed.has((this.entries[index] as Activity).id)) {
        this.entries.splice(index, 1)
      }
    }
    return doomed.size
  }
}
