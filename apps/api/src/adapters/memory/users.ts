import type { NewUserWithPassword, UserRecord, UserRepository } from '~/ports/user-repository'

/** Users held in memory, for tests. */
export class MemoryUserRepository implements UserRepository {
  readonly #users: Map<string, UserRecord>
  readonly #passwords: Map<string, string>

  constructor() {
    // Assigned here rather than as field initializers: Bun's per-file coverage counts
    // initializers as an uncalled function.
    this.#users = new Map()
    this.#passwords = new Map()
  }

  /** @inheritdoc */
  async findById(environmentId: string, id: string): Promise<UserRecord | null> {
    const user = this.#users.get(id)
    return user?.environmentId === environmentId ? { ...user } : null
  }

  /** @inheritdoc */
  async findByEmail(environmentId: string, emailNormalized: string): Promise<UserRecord | null> {
    const user = this.#byEmail(environmentId, emailNormalized)
    return user ? { ...user } : null
  }

  /** @inheritdoc */
  async findByEmailWithPassword(
    environmentId: string,
    emailNormalized: string
  ): Promise<{ user: UserRecord; passwordHash: string | null } | null> {
    const user = await this.findByEmail(environmentId, emailNormalized)
    return user ? { user, passwordHash: this.#passwords.get(user.id) ?? null } : null
  }

  /** @inheritdoc */
  async createWithPassword(user: NewUserWithPassword): Promise<boolean> {
    // Checked and written without an `await` in between, so concurrent creations behave like
    // the database's unique constraint: exactly one wins.
    if (this.#byEmail(user.environmentId, user.emailNormalized)) {
      return false
    }
    const { identityId: _identityId, credentialId: _credentialId, passwordHash, ...record } = user
    this.#users.set(user.id, { ...record, bannedAt: null, lastSignInAt: null })
    this.#passwords.set(user.id, passwordHash)
    return true
  }

  /** @inheritdoc */
  async setPasswordHash(
    environmentId: string,
    userId: string,
    passwordHash: string,
    _at: Date
  ): Promise<void> {
    if (this.#user(environmentId, userId)) {
      this.#passwords.set(userId, passwordHash)
    }
  }

  /** @inheritdoc */
  async markEmailVerified(environmentId: string, userId: string, at: Date): Promise<void> {
    const user = this.#user(environmentId, userId)
    if (user && user.emailVerifiedAt === null) {
      user.emailVerifiedAt = at
    }
  }

  /** @inheritdoc */
  async recordSignIn(environmentId: string, userId: string, at: Date): Promise<void> {
    const user = this.#user(environmentId, userId)
    if (user) {
      user.lastSignInAt = at
    }
  }

  /**
   * Ban or unban a user directly (tests only; the admin user module arrives in Step 5.7).
   *
   * @param userId - The user.
   * @param at - Ban time, or `null` to unban.
   */
  setBanned(userId: string, at: Date | null): void {
    const user = this.#users.get(userId)
    if (user) {
      user.bannedAt = at
    }
  }

  #byEmail(environmentId: string, emailNormalized: string): UserRecord | undefined {
    for (const user of this.#users.values()) {
      if (user.environmentId === environmentId && user.emailNormalized === emailNormalized) {
        return user
      }
    }
    return undefined
  }

  #user(environmentId: string, id: string): UserRecord | undefined {
    const user = this.#users.get(id)
    return user?.environmentId === environmentId ? user : undefined
  }
}
