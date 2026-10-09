import {
  SMS_PREFIX_PATTERN,
  type SmsPrefixCount,
  type SmsUsageScope,
  type SmsUsageStore,
  type SmsUsageSummary,
} from '~/ports/sms-usage-store'

interface Row extends SmsPrefixCount {
  environmentId: string
  day: string
}

/** In-memory counts of texted codes, for tests. */
export class MemorySmsUsageStore implements SmsUsageStore {
  readonly #rows: Map<string, Row>

  // Assigned in the constructor for Bun coverage; see MemoryApiKeyRepository.
  constructor() {
    this.#rows = new Map()
  }

  #key(environmentId: string, day: string, prefix: string): string {
    return `${environmentId}:${day}:${prefix}`
  }

  /** @inheritdoc */
  async recordSent(scope: SmsUsageScope, day: string, prefix: string, _at: Date): Promise<void> {
    if (!SMS_PREFIX_PATTERN.test(prefix)) {
      // As the table's own check refuses it.
      throw new Error('not a destination prefix')
    }
    const key = this.#key(scope.environmentId, day, prefix)
    const row = this.#rows.get(key) ?? {
      environmentId: scope.environmentId,
      day,
      prefix,
      sent: 0,
      used: 0,
    }
    row.sent += 1
    this.#rows.set(key, row)
  }

  /** @inheritdoc */
  async recordNotSent(
    environmentId: string,
    day: string,
    prefix: string,
    _at: Date
  ): Promise<void> {
    const row = this.#rows.get(this.#key(environmentId, day, prefix))
    if (row && row.sent > row.used) {
      row.sent -= 1
    }
  }

  /** @inheritdoc */
  async sentOn(environmentId: string, day: string): Promise<number> {
    let sent = 0
    for (const row of this.#rows.values()) {
      if (row.environmentId === environmentId && row.day === day) {
        sent += row.sent
      }
    }
    return sent
  }

  /** @inheritdoc */
  async recordUsed(environmentId: string, day: string, prefix: string, _at: Date): Promise<void> {
    const row = this.#rows.get(this.#key(environmentId, day, prefix))
    if (row && row.used < row.sent) {
      row.used += 1
    }
  }

  /** @inheritdoc */
  async summary(environmentId: string, since: string, limit: number): Promise<SmsUsageSummary> {
    const byPrefix = new Map<string, SmsPrefixCount>()
    for (const row of this.#rows.values()) {
      // Days are `YYYY-MM-DD`: they order as text.
      if (row.environmentId !== environmentId || row.day < since) {
        continue
      }
      const count = byPrefix.get(row.prefix) ?? { prefix: row.prefix, sent: 0, used: 0 }
      count.sent += row.sent
      count.used += row.used
      byPrefix.set(row.prefix, count)
    }
    const all = [...byPrefix.values()].sort(
      (a, b) =>
        b.sent - b.used - (a.sent - a.used) || b.sent - a.sent || (a.prefix < b.prefix ? -1 : 1)
    )
    return {
      sent: all.reduce((sum, count) => sum + count.sent, 0),
      used: all.reduce((sum, count) => sum + count.used, 0),
      prefixes: all.slice(0, limit),
      truncated: all.length > limit,
    }
  }

  /** @inheritdoc */
  async deleteBefore(environmentId: string, day: string, limit: number): Promise<number> {
    let deleted = 0
    for (const [key, row] of this.#rows) {
      if (deleted >= limit) {
        break
      }
      if (row.environmentId === environmentId && row.day < day) {
        this.#rows.delete(key)
        deleted += 1
      }
    }
    return deleted
  }
}
