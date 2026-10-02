import {
  type NewVerificationToken,
  subjectOf,
  type VerificationPurpose,
  type VerificationSubject,
  type VerificationTokenRecord,
  type VerificationTokenStore,
} from '~/ports/verification-token-store'

function matches(token: VerificationTokenRecord, subject: VerificationSubject): boolean {
  return 'flowAttemptId' in subject
    ? token.flowAttemptId === subject.flowAttemptId
    : token.userId === subject.userId
}

/** Verification tokens held in memory, for tests. */
export class MemoryVerificationTokenStore implements VerificationTokenStore {
  readonly #tokens: VerificationTokenRecord[]

  constructor() {
    // Assigned here rather than as a field initializer: Bun's per-file coverage counts
    // initializers as an uncalled function.
    this.#tokens = []
  }

  /** @inheritdoc */
  async replace(token: NewVerificationToken, at: Date): Promise<void> {
    const subject = subjectOf(token)
    for (const existing of this.#tokens) {
      if (
        existing.environmentId === token.environmentId &&
        existing.purpose === token.purpose &&
        existing.consumedAt === null &&
        matches(existing, subject)
      ) {
        existing.consumedAt = at
      }
    }
    this.#tokens.push({ ...token, attempts: 0, consumedAt: null })
  }

  /** @inheritdoc */
  async findLatest(
    environmentId: string,
    purpose: VerificationPurpose,
    subject: VerificationSubject
  ): Promise<VerificationTokenRecord | null> {
    const found = this.#tokens.findLast(
      (token) =>
        token.environmentId === environmentId &&
        token.purpose === purpose &&
        matches(token, subject)
    )
    return found ? { ...found } : null
  }

  /** @inheritdoc */
  async findByLinkHash(
    environmentId: string,
    linkTokenHash: string
  ): Promise<VerificationTokenRecord | null> {
    const found = this.#tokens.find(
      (token) => token.environmentId === environmentId && token.linkTokenHash === linkTokenHash
    )
    return found ? { ...found } : null
  }

  /** @inheritdoc */
  async recordAttempt(
    environmentId: string,
    id: string,
    now: Date
  ): Promise<VerificationTokenRecord | null> {
    const token = this.#usable(environmentId, id, now)
    if (!token || token.attempts >= token.maxAttempts) {
      return null
    }
    token.attempts += 1
    return { ...token }
  }

  /** @inheritdoc */
  async consume(environmentId: string, id: string, now: Date): Promise<boolean> {
    const token = this.#usable(environmentId, id, now)
    if (!token) {
      return false
    }
    token.consumedAt = now
    return true
  }

  #usable(environmentId: string, id: string, now: Date): VerificationTokenRecord | undefined {
    return this.#tokens.find(
      (token) =>
        token.id === id &&
        token.environmentId === environmentId &&
        token.consumedAt === null &&
        token.expiresAt.getTime() > now.getTime()
    )
  }
}
