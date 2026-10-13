import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import type { MemoryUserRepository } from '~/adapters/memory/users'
import { type Activity, activityOf, type Recorded } from '~/ports/activity-log'
import type {
  PasskeyChallengePurpose,
  PasskeyChallengeRecord,
  PasskeyCreateOutcome,
  PasskeyRecord,
  PasskeyRemoveOutcome,
  PasskeyStore,
  PasskeyUse,
} from '~/ports/passkey-store'
import type { SignInMeans } from '~/ports/user-repository'

function copy(passkey: PasskeyRecord): PasskeyRecord {
  return {
    ...passkey,
    publicKey: new Uint8Array(passkey.publicKey),
    transports: [...passkey.transports],
  }
}

/** Passkeys and session challenges held in memory, for tests. */
export class MemoryPasskeyStore implements PasskeyStore {
  readonly #passkeys: Map<string, PasskeyRecord>
  readonly #challenges: Map<string, PasskeyChallengeRecord>
  readonly #activityLog: MemoryActivityLog
  readonly #users: MemoryUserRepository | null

  /**
   * @param activityLog - Where activity is recorded; shared with the other memory stores.
   * @param users - The users the passkeys belong to, for the "last way to sign in" rule. The
   *   store registers itself there, so removing an identity counts passkeys too. Without one,
   *   a removal sees a user with nothing but passkeys.
   */
  constructor(
    activityLog: MemoryActivityLog = new MemoryActivityLog(),
    users: MemoryUserRepository | null = null
  ) {
    this.#passkeys = new Map()
    this.#challenges = new Map()
    this.#activityLog = activityLog
    this.#users = users
    users?.countPasskeysWith((environmentId, userId) => this.#of(environmentId, userId).length)
  }

  /**
   * Whether this store reports to a given user repository.
   *
   * @param users - The repository.
   * @returns `true` when it is the one this store was built on.
   */
  belongsTo(users: MemoryUserRepository): boolean {
    return this.#users === users
  }

  #of(environmentId: string, userId: string): PasskeyRecord[] {
    return [...this.#passkeys.values()]
      .filter((passkey) => passkey.environmentId === environmentId && passkey.userId === userId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
  }

  async create(
    passkey: PasskeyRecord,
    limit: number,
    recorded: Recorded
  ): Promise<PasskeyCreateOutcome> {
    const activity = activityOf(recorded)
    if (this.#of(passkey.environmentId, passkey.userId).length >= limit) {
      return 'limit'
    }
    for (const existing of this.#passkeys.values()) {
      if (
        existing.environmentId === passkey.environmentId &&
        existing.credentialId === passkey.credentialId
      ) {
        return 'duplicate'
      }
    }
    this.#passkeys.set(passkey.id, copy(passkey))
    this.#activityLog.record(activity ? [activity] : [])
    return 'created'
  }

  async listForUser(environmentId: string, userId: string): Promise<PasskeyRecord[]> {
    return this.#of(environmentId, userId).map(copy)
  }

  async findByCredentialId(
    environmentId: string,
    credentialId: string
  ): Promise<PasskeyRecord | null> {
    for (const passkey of this.#passkeys.values()) {
      if (passkey.environmentId === environmentId && passkey.credentialId === credentialId) {
        return copy(passkey)
      }
    }
    return null
  }

  async recordUse(environmentId: string, id: string, use: PasskeyUse): Promise<boolean> {
    const passkey = this.#passkeys.get(id)
    if (
      !passkey ||
      passkey.environmentId !== environmentId ||
      passkey.signCount !== use.expectedSignCount
    ) {
      return false
    }
    passkey.signCount = use.signCount
    passkey.backupEligible = use.backupEligible
    passkey.backedUp = use.backedUp
    passkey.lastUsedAt = use.at
    return true
  }

  async reportRegression(environmentId: string, id: string, activity: Activity): Promise<void> {
    if (this.#passkeys.get(id)?.environmentId === environmentId) {
      this.#activityLog.record([activity])
    }
  }

  async rename(
    environmentId: string,
    userId: string,
    id: string,
    name: string,
    _at: Date,
    recorded: Recorded
  ): Promise<boolean> {
    const activity = activityOf(recorded)
    const passkey = this.#passkeys.get(id)
    if (!passkey || passkey.environmentId !== environmentId || passkey.userId !== userId) {
      return false
    }
    passkey.name = name
    this.#activityLog.record(activity ? [activity] : [])
    return true
  }

  async remove(
    environmentId: string,
    userId: string,
    id: string,
    allowed: (remaining: SignInMeans) => boolean,
    recorded: Recorded
  ): Promise<PasskeyRemoveOutcome> {
    const activity = activityOf(recorded)
    const owned = this.#of(environmentId, userId)
    if (!owned.some((passkey) => passkey.id === id)) {
      return 'not_found'
    }
    const means = this.#users?.signInMeans(environmentId, userId) ?? {
      hasPassword: false,
      emailVerified: false,
      providers: [],
    }
    if (!allowed({ ...means, passkeys: owned.length - 1 })) {
      return 'last_method'
    }
    this.#passkeys.delete(id)
    this.#activityLog.record(activity ? [activity] : [])
    return 'removed'
  }

  async removeForUser(environmentId: string, userId: string, recorded: Recorded): Promise<number> {
    const activity = activityOf(recorded)
    const owned = this.#of(environmentId, userId)
    for (const passkey of owned) {
      this.#passkeys.delete(passkey.id)
    }
    for (const [key, challenge] of this.#challenges) {
      if (challenge.environmentId === environmentId && challenge.userId === userId) {
        this.#challenges.delete(key)
      }
    }
    this.#activityLog.record(activity && owned.length > 0 ? [activity] : [])
    return owned.length
  }

  async putChallenge(challenge: PasskeyChallengeRecord): Promise<void> {
    this.#challenges.set(`${challenge.sessionId}:${challenge.purpose}`, { ...challenge })
  }

  async takeChallenge(
    environmentId: string,
    sessionId: string,
    purpose: PasskeyChallengePurpose,
    now: Date
  ): Promise<Pick<PasskeyChallengeRecord, 'challenge' | 'userId'> | null> {
    const key = `${sessionId}:${purpose}`
    const stored = this.#challenges.get(key)
    if (!stored || stored.environmentId !== environmentId) {
      return null
    }
    this.#challenges.delete(key)
    return stored.expiresAt.getTime() > now.getTime()
      ? { challenge: stored.challenge, userId: stored.userId }
      : null
  }

  async deleteExpiredChallenges(
    environmentId: string,
    before: Date,
    limit: number
  ): Promise<number> {
    let removed = 0
    for (const [key, challenge] of this.#challenges) {
      if (removed >= limit) {
        break
      }
      if (
        challenge.environmentId === environmentId &&
        challenge.expiresAt.getTime() <= before.getTime()
      ) {
        this.#challenges.delete(key)
        removed += 1
      }
    }
    return removed
  }
}
