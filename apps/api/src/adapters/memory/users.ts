import type { OAuthProvider } from '@tula/contract'
import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { type Activity, activityOf, type Recorded } from '~/ports/activity-log'
import type {
  IdentityRecord,
  LinkGuard,
  LinkOutcome,
  NewIdentity,
  NewUser,
  PasswordOutcome,
  SignInMeans,
  UnlinkOutcome,
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
  readonly #identities: Map<string, IdentityRecord & { environmentId: string }>
  readonly #activityLog: MemoryActivityLog
  #passkeyCount: (environmentId: string, userId: string) => number

  /** @param activityLog - Where activity is recorded; shared with the other memory stores. */
  constructor(activityLog: MemoryActivityLog = new MemoryActivityLog()) {
    // Assigned here rather than as field initializers: Bun's per-file coverage counts
    // initializers as an uncalled function.
    this.#users = new Map()
    this.#passwords = new Map()
    this.#identities = new Map()
    this.#activityLog = activityLog
    this.#passkeyCount = () => 0
  }

  /**
   * Tell this repository where a user's passkeys are counted. In Postgres one transaction reads
   * both tables; in memory the passkey store registers itself here.
   *
   * @param count - How many passkeys a user has.
   */
  countPasskeysWith(count: (environmentId: string, userId: string) => number): void {
    this.#passkeyCount = count
  }

  /**
   * What a user can sign in with, as the passkey store needs it for its own removal rule.
   *
   * @param environmentId - The environment.
   * @param userId - The user.
   * @returns The user's means, or `null` when there is no such user.
   */
  signInMeans(environmentId: string, userId: string): SignInMeans | null {
    const user = this.#user(environmentId, userId)
    if (!user) {
      return null
    }
    return {
      hasPassword: this.#passwords.has(userId),
      emailVerified: user.emailVerifiedAt !== null,
      providers: this.#identitiesOf(environmentId, userId).map((identity) => identity.provider),
      passkeys: this.#passkeyCount(environmentId, userId),
    }
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
  async create(user: NewUser, recorded: Recorded): Promise<boolean> {
    const activity = activityOf(recorded)
    // Checked and written without an `await` in between, so concurrent creations behave like
    // the database's unique constraint: exactly one wins.
    const { oauthIdentity } = user
    if (
      this.#byEmail(user.environmentId, user.emailNormalized) ||
      (oauthIdentity &&
        this.#identity(user.environmentId, oauthIdentity.provider, oauthIdentity.subject))
    ) {
      return false
    }
    const {
      identityId: _identityId,
      credentialId: _credentialId,
      oauthIdentity: _oauthIdentity,
      passwordHash,
      ...record
    } = user
    this.#users.set(user.id, { ...record, bannedAt: null, lastSignInAt: null })
    if (oauthIdentity) {
      this.#identities.set(oauthIdentity.id, {
        ...oauthIdentity,
        userId: user.id,
        environmentId: user.environmentId,
        createdAt: user.createdAt,
      })
    }
    if (passwordHash !== null) {
      this.#passwords.set(user.id, passwordHash)
    }
    this.#activityLog.record(activity ? [activity] : [])
    return true
  }

  /** @inheritdoc */
  async findByIdentity(
    environmentId: string,
    provider: OAuthProvider,
    subject: string
  ): Promise<UserRecord | null> {
    const identity = this.#identity(environmentId, provider, subject)
    return identity ? this.findById(environmentId, identity.userId) : null
  }

  async listIdentities(environmentId: string, userId: string): Promise<IdentityRecord[]> {
    return this.#identitiesOf(environmentId, userId).map(
      ({ environmentId: _environmentId, ...identity }) => ({ ...identity })
    )
  }

  async linkIdentity(
    identity: NewIdentity,
    recorded: Recorded,
    guard?: LinkGuard
  ): Promise<LinkOutcome> {
    const activity = activityOf(recorded)
    // Checked and written without an `await` in between, like the database's unique keys.
    const user = this.#user(identity.environmentId, identity.userId)
    if (
      !user ||
      (guard && (user.emailNormalized !== guard.emailNormalized || user.emailVerifiedAt === null))
    ) {
      return 'user_changed'
    }
    if (this.#identity(identity.environmentId, identity.provider, identity.subject)) {
      return 'identity_in_use'
    }
    if (
      this.#identitiesOf(identity.environmentId, identity.userId).some(
        (other) => other.provider === identity.provider
      )
    ) {
      return 'provider_linked'
    }
    const { projectId: _projectId, ...record } = identity
    this.#identities.set(identity.id, record)
    this.#activityLog.record(activity ? [activity] : [])
    return 'linked'
  }

  async unlinkIdentity(
    environmentId: string,
    userId: string,
    identityId: string,
    allowed: (remaining: SignInMeans) => boolean,
    recorded: Recorded
  ): Promise<UnlinkOutcome> {
    const activity = activityOf(recorded)
    const user = this.#user(environmentId, userId)
    const identities = this.#identitiesOf(environmentId, userId)
    if (!user || !identities.some((identity) => identity.id === identityId)) {
      return 'not_found'
    }
    const remaining: SignInMeans = {
      hasPassword: this.#passwords.has(userId),
      emailVerified: user.emailVerifiedAt !== null,
      providers: identities
        .filter((identity) => identity.id !== identityId)
        .map((identity) => identity.provider),
      passkeys: this.#passkeyCount(environmentId, userId),
    }
    if (!allowed(remaining)) {
      return 'last_method'
    }
    this.#identities.delete(identityId)
    this.#activityLog.record(activity ? [activity] : [])
    return 'unlinked'
  }

  async setPasswordHash(
    environmentId: string,
    userId: string,
    passwordHash: string,
    _at: Date,
    recorded: Recorded
  ): Promise<PasswordOutcome | null> {
    const activity = activityOf(recorded)
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
    recorded: Recorded,
    removePassword?: { activity: Recorded }
  ): Promise<{ passwordRemoved: boolean }> {
    const activity = activityOf(recorded)
    const removal = removePassword && activityOf(removePassword.activity)
    const user = this.#user(environmentId, userId)
    if (!user || user.emailVerifiedAt !== null) {
      return { passwordRemoved: false }
    }
    // Checked and written without an `await` in between, like the database's one transaction.
    user.emailVerifiedAt = at
    const passwordRemoved = removePassword !== undefined && this.#passwords.delete(userId)
    this.#activityLog.record([
      ...(activity ? [activity] : []),
      ...(passwordRemoved && removal ? [removal] : []),
    ])
    return { passwordRemoved }
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
    recorded: Recorded
  ): Promise<UserRecord | null> {
    const activity = activityOf(recorded)
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
  async delete(environmentId: string, userId: string, recorded: Recorded): Promise<boolean> {
    const activity = activityOf(recorded)
    if (!this.#user(environmentId, userId)) {
      return false
    }
    this.#passwords.delete(userId)
    for (const identity of this.#identitiesOf(environmentId, userId)) {
      this.#identities.delete(identity.id)
    }
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

  #identity(
    environmentId: string,
    provider: OAuthProvider,
    subject: string
  ): (IdentityRecord & { environmentId: string }) | undefined {
    for (const identity of this.#identities.values()) {
      if (
        identity.environmentId === environmentId &&
        identity.provider === provider &&
        identity.subject === subject
      ) {
        return identity
      }
    }
    return undefined
  }

  #identitiesOf(
    environmentId: string,
    userId: string
  ): (IdentityRecord & { environmentId: string })[] {
    return [...this.#identities.values()]
      .filter((identity) => identity.environmentId === environmentId && identity.userId === userId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
  }

  #user(environmentId: string, id: string): UserRecord | undefined {
    const user = this.#users.get(id)
    return user?.environmentId === environmentId ? user : undefined
  }
}
