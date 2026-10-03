import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import type { Activity } from '~/ports/activity-log'
import type {
  NewUser,
  PasswordOutcome,
  UserListCriteria,
  UserRecord,
  UserRepository,
} from '~/ports/user-repository'

/** The activity as recorded: a first password is marked `created: true`. */
function withOutcome(activity: Activity, outcome: PasswordOutcome): Activity {
  return outcome === 'created'
    ? { ...activity, data: { ...activity.data, created: true } }
    : activity
}

/** Users held in memory, for tests. */
export class MemoryUserRepository implements UserRepository {
  readonly #users: Map<string, UserRecord>
  readonly #passwords: Map<string, string>
  readonly #activityLog: MemoryActivityLog

  /** @param activityLog - Where activity is recorded; shared with the other memory stores. */
  constructor(activityLog: MemoryActivityLog = new MemoryActivityLog()) {
    // Assigned here rather than as field initializers: Bun's per-file coverage counts
    // initializers as an uncalled function.
    this.#users = new Map()
    this.#passwords = new Map()
    this.#activityLog = activityLog
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
  async create(user: NewUser, activity?: Activity): Promise<boolean> {
    // Checked and written without an `await` in between, so concurrent creations behave like
    // the database's unique constraint: exactly one wins.
    if (this.#byEmail(user.environmentId, user.emailNormalized)) {
      return false
    }
    const { identityId: _identityId, credentialId: _credentialId, passwordHash, ...record } = user
    this.#users.set(user.id, { ...record, bannedAt: null, lastSignInAt: null })
    if (passwordHash !== null) {
      this.#passwords.set(user.id, passwordHash)
    }
    this.#activityLog.record(activity ? [activity] : [])
    return true
  }

  /** @inheritdoc */
  async setPasswordHash(
    environmentId: string,
    userId: string,
    passwordHash: string,
    _at: Date,
    activity?: Activity
  ): Promise<PasswordOutcome | null> {
    if (!this.#user(environmentId, userId)) {
      return null
    }
    // Checked and written without an `await` in between, like the database's single upsert.
    const outcome: PasswordOutcome = this.#passwords.has(userId) ? 'replaced' : 'created'
    this.#passwords.set(userId, passwordHash)
    this.#activityLog.record(activity ? [withOutcome(activity, outcome)] : [])
    return outcome
  }

  /** @inheritdoc */
  async upgradePasswordHash(
    environmentId: string,
    userId: string,
    currentHash: string,
    passwordHash: string,
    _at: Date
  ): Promise<boolean> {
    if (!this.#user(environmentId, userId) || this.#passwords.get(userId) !== currentHash) {
      return false
    }
    this.#passwords.set(userId, passwordHash)
    return true
  }

  /** @inheritdoc */
  async markEmailVerified(
    environmentId: string,
    userId: string,
    at: Date,
    activity?: Activity
  ): Promise<void> {
    const user = this.#user(environmentId, userId)
    if (user && user.emailVerifiedAt === null) {
      user.emailVerifiedAt = at
      this.#activityLog.record(activity ? [activity] : [])
    }
  }

  /** @inheritdoc */
  async recordSignIn(environmentId: string, userId: string, at: Date): Promise<void> {
    const user = this.#user(environmentId, userId)
    if (user) {
      user.lastSignInAt = at
    }
  }

  /** @inheritdoc */
  async list(
    environmentId: string,
    criteria: UserListCriteria
  ): Promise<{ users: UserRecord[]; totalCount: number }> {
    const q = criteria.q?.trim().toLowerCase()
    const descending = criteria.sort.startsWith('-')
    const field = criteria.sort.replace('-', '') as 'createdAt' | 'email' | 'lastSignInAt'
    const key = (user: UserRecord): string | number | null =>
      field === 'email' ? user.emailNormalized : (user[field]?.getTime() ?? null)
    const matches = [...this.#users.values()]
      .filter(
        (user) =>
          user.environmentId === environmentId &&
          (!q ||
            [user.emailNormalized, user.firstName, user.lastName].some((value) =>
              value?.toLowerCase().includes(q)
            ))
      )
      .sort((x, y) => {
        const [a, b] = [key(x), key(y)]
        // Like Postgres with NULLS LAST: users without a value sort after the rest, whatever
        // the direction. Ties (including two missing values) fall back to the id.
        if (a !== b && (a === null || b === null)) {
          return a === null ? 1 : -1
        }
        const byId = x.id < y.id ? -1 : 1
        const order = a === null || b === null || a === b ? byId : a < b ? -1 : 1
        return descending ? -order : order
      })
    const start = (criteria.page - 1) * criteria.size
    return {
      users: matches.slice(start, start + criteria.size).map((user) => ({ ...user })),
      totalCount: matches.length,
    }
  }

  /** @inheritdoc */
  async setBanned(
    environmentId: string,
    userId: string,
    bannedAt: Date | null,
    _at: Date,
    activity?: Activity
  ): Promise<UserRecord | null> {
    const user = this.#user(environmentId, userId)
    if (!user) {
      return null
    }
    // Only a real change writes: a repeated ban keeps the original time and records nothing.
    if ((user.bannedAt === null) !== (bannedAt === null)) {
      user.bannedAt = bannedAt
      this.#activityLog.record(activity ? [activity] : [])
    }
    return { ...user }
  }

  /** @inheritdoc */
  async delete(environmentId: string, userId: string, activity?: Activity): Promise<boolean> {
    if (!this.#user(environmentId, userId)) {
      return false
    }
    this.#passwords.delete(userId)
    this.#users.delete(userId)
    this.#activityLog.record(activity ? [activity] : [])
    return true
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
