import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import type { MemoryOrganizationStore } from '~/adapters/memory/organizations'
import { activityOf, type Recorded } from '~/ports/activity-log'
import type { SetupLinkRecord, SetupLinkStore } from '~/ports/setup-link-store'

/** In-memory setup links for tests. */
export class MemorySetupLinkStore implements SetupLinkStore {
  readonly #links: Map<string, SetupLinkRecord>
  readonly #activityLog: MemoryActivityLog

  // Assigned in the constructor for Bun coverage; see MemoryApiKeyRepository.
  constructor(
    activityLog: MemoryActivityLog = new MemoryActivityLog(),
    organizations: MemoryOrganizationStore | null = null
  ) {
    this.#links = new Map()
    this.#activityLog = activityLog
    // The foreign key cascades an organization's setup links.
    organizations?.onDelete((environmentId, organizationId) => {
      for (const [key, one] of this.#links) {
        if (one.environmentId === environmentId && one.organizationId === organizationId) {
          this.#links.delete(key)
        }
      }
    })
  }

  #record(recorded: Recorded): void {
    const activity = activityOf(recorded)
    this.#activityLog.record(activity ? [activity] : [])
  }

  /** @inheritdoc */
  async insert(record: SetupLinkRecord, recorded: Recorded): Promise<void> {
    this.#links.set(record.id, structuredClone(record))
    this.#record(recorded)
  }

  /** @inheritdoc */
  async list(environmentId: string, organizationId: string): Promise<SetupLinkRecord[]> {
    return [...this.#links.values()]
      .filter((one) => one.environmentId === environmentId && one.organizationId === organizationId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
      .map((one) => structuredClone(one))
  }

  /** @inheritdoc */
  async findByHash(environmentId: string, tokenHash: string): Promise<SetupLinkRecord | null> {
    const found = [...this.#links.values()].find(
      (one) => one.environmentId === environmentId && one.tokenHash === tokenHash
    )
    return found ? structuredClone(found) : null
  }

  /** @inheritdoc */
  async revoke(
    environmentId: string,
    organizationId: string,
    id: string,
    at: Date,
    recorded: Recorded
  ): Promise<SetupLinkRecord | null> {
    const link = this.#links.get(id)
    if (
      !link ||
      link.environmentId !== environmentId ||
      link.organizationId !== organizationId ||
      link.revokedAt !== null
    ) {
      return null
    }
    link.revokedAt = at
    link.updatedAt = at
    this.#record(recorded)
    return structuredClone(link)
  }

  /** @inheritdoc */
  async touch(environmentId: string, id: string, at: Date): Promise<void> {
    const link = this.#links.get(id)
    if (link && link.environmentId === environmentId) {
      link.lastUsedAt = at
    }
  }

  /** @inheritdoc */
  async deleteExpiredBefore(environmentId: string, cutoff: Date, limit: number): Promise<number> {
    let deleted = 0
    for (const [id, link] of this.#links) {
      if (deleted >= limit) {
        break
      }
      if (link.environmentId === environmentId && link.expiresAt.getTime() < cutoff.getTime()) {
        this.#links.delete(id)
        deleted += 1
      }
    }
    return deleted
  }
}
