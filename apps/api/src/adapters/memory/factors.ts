import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import type { MemoryUserRepository } from '~/adapters/memory/users'
import { timingSafeEqual } from '~/lib/crypto'
import { activityOf, type Recorded, recordedOf } from '~/ports/activity-log'
import type {
  FactorConfirmation,
  FactorRecord,
  FactorStore,
  NewBackupCode,
  NewFactor,
} from '~/ports/factor-store'

interface StoredBackupCode {
  id: string
  environmentId: string
  userId: string
  codeHash: string
  usedAt: Date | null
}

/** Second factors and backup codes held in memory, for tests. */
export class MemoryFactorStore implements FactorStore {
  readonly #factors: FactorRecord[]
  readonly #codes: StoredBackupCode[]
  readonly #activityLog: MemoryActivityLog

  /**
   * @param activityLog - Where activity is recorded; shared with the other memory stores.
   * @param users - The users the factors belong to. The store registers itself there, so
   *   that turning a texted second factor on sees a confirmed authenticator app (in
   *   Postgres one transaction reads both tables). Without one, that write sees none.
   */
  constructor(
    activityLog: MemoryActivityLog = new MemoryActivityLog(),
    users: MemoryUserRepository | null = null
  ) {
    // Assigned here rather than as field initializers: Bun's per-file coverage counts
    // initializers as an uncalled function.
    this.#factors = []
    this.#codes = []
    this.#activityLog = activityLog
    users?.confirmedTotpWith(
      (environmentId, userId) => this.#factor(environmentId, userId)?.confirmedAt != null
    )
  }

  /** @inheritdoc */
  async findTotp(environmentId: string, userId: string): Promise<FactorRecord | null> {
    const factor = this.#factor(environmentId, userId)
    return factor ? { ...factor } : null
  }

  /** @inheritdoc */
  async startTotp(factor: NewFactor): Promise<boolean> {
    const existing = this.#factor(factor.environmentId, factor.userId)
    if (existing?.confirmedAt) {
      return false
    }
    if (existing) {
      this.#factors.splice(this.#factors.indexOf(existing), 1)
    }
    this.#factors.push({ ...factor, confirmedAt: null, lastUsedStep: null })
    return true
  }

  /** @inheritdoc */
  async confirmTotp(
    environmentId: string,
    id: string,
    confirmation: FactorConfirmation
  ): Promise<boolean> {
    const factor = this.#factors.find(
      (candidate) => candidate.id === id && candidate.environmentId === environmentId
    )
    if (
      !factor ||
      factor.confirmedAt !== null ||
      factor.expiresAt === null ||
      factor.expiresAt.getTime() <= confirmation.at.getTime()
    ) {
      return false
    }
    factor.confirmedAt = confirmation.at
    factor.expiresAt = null
    factor.lastUsedStep = confirmation.step
    this.#setCodes(environmentId, factor.userId, confirmation.backupCodes)
    this.#activityLog.record(recordedOf([confirmation.activity]))
    return true
  }

  /** @inheritdoc */
  async useTotpStep(environmentId: string, id: string, step: number, _at: Date): Promise<boolean> {
    const factor = this.#factors.find(
      (candidate) => candidate.id === id && candidate.environmentId === environmentId
    )
    if (
      !factor ||
      factor.confirmedAt === null ||
      (factor.lastUsedStep !== null && factor.lastUsedStep >= step)
    ) {
      return false
    }
    factor.lastUsedStep = step
    return true
  }

  /** @inheritdoc */
  async removeForUser(
    environmentId: string,
    userId: string,
    recorded: Recorded,
    onlyFactorId?: string
  ): Promise<boolean> {
    const activity = activityOf(recorded)
    const factor = this.#factor(environmentId, userId)
    if (onlyFactorId !== undefined && factor?.id !== onlyFactorId) {
      return false
    }
    if (factor) {
      this.#factors.splice(this.#factors.indexOf(factor), 1)
    }
    this.#setCodes(environmentId, userId, [])
    const removed = factor !== undefined && factor.confirmedAt !== null
    this.#activityLog.record(removed && activity ? [activity] : [])
    return removed
  }

  /** @inheritdoc */
  async replaceBackupCodes(
    environmentId: string,
    userId: string,
    _scope: { projectId: string },
    codes: readonly NewBackupCode[],
    _at: Date,
    recorded: Recorded
  ): Promise<boolean> {
    const activity = activityOf(recorded)
    if (!this.#factor(environmentId, userId)?.confirmedAt) {
      return false
    }
    this.#setCodes(environmentId, userId, codes)
    this.#activityLog.record(activity ? [activity] : [])
    return true
  }

  /** @inheritdoc */
  async consumeBackupCode(
    environmentId: string,
    userId: string,
    codeHash: string,
    at: Date,
    recorded: Recorded
  ): Promise<number | null> {
    const activity = activityOf(recorded)
    const code = this.#codes.find(
      (candidate) =>
        candidate.environmentId === environmentId &&
        candidate.userId === userId &&
        candidate.usedAt === null &&
        timingSafeEqual(candidate.codeHash, codeHash)
    )
    if (!code) {
      return null
    }
    code.usedAt = at
    this.#activityLog.record(activity ? [activity] : [])
    return this.countBackupCodes(environmentId, userId)
  }

  /** @inheritdoc */
  async countBackupCodes(environmentId: string, userId: string): Promise<number> {
    return this.#codes.filter(
      (code) =>
        code.environmentId === environmentId && code.userId === userId && code.usedAt === null
    ).length
  }

  /** @inheritdoc */
  async deleteExpiredPending(environmentId: string, before: Date, limit: number): Promise<number> {
    let removed = 0
    for (let index = this.#factors.length - 1; index >= 0 && removed < limit; index--) {
      const factor = this.#factors[index]
      if (
        factor?.environmentId === environmentId &&
        factor.confirmedAt === null &&
        factor.expiresAt !== null &&
        factor.expiresAt.getTime() <= before.getTime()
      ) {
        this.#factors.splice(index, 1)
        removed += 1
      }
    }
    return removed
  }

  #factor(environmentId: string, userId: string): FactorRecord | undefined {
    return this.#factors.find(
      (factor) => factor.environmentId === environmentId && factor.userId === userId
    )
  }

  #setCodes(environmentId: string, userId: string, codes: readonly NewBackupCode[]): void {
    for (let index = this.#codes.length - 1; index >= 0; index--) {
      const code = this.#codes[index]
      if (code?.environmentId === environmentId && code.userId === userId) {
        this.#codes.splice(index, 1)
      }
    }
    this.#codes.push(...codes.map((code) => ({ ...code, environmentId, userId, usedAt: null })))
  }
}
