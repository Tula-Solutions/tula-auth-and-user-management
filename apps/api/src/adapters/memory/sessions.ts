import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import type { Activity } from '~/ports/activity-log'
import {
  beganBefore,
  endedBy,
  isActive,
  type NewRefreshToken,
  type NewSession,
  type RefreshTokenRecord,
  type RevokeByUserOptions,
  type Rotation,
  type SessionDevice,
  type SessionRecord,
  type SessionRevokeReason,
  type SessionStore,
} from '~/ports/session-store'

/** Sessions and refresh tokens held in memory, for tests. */
export class MemorySessionStore implements SessionStore {
  readonly #sessions: Map<string, SessionRecord>
  readonly #tokens: Map<string, RefreshTokenRecord>
  readonly #activityLog: MemoryActivityLog

  /** @param activityLog - Where activity is recorded; shared with the other memory stores. */
  constructor(activityLog: MemoryActivityLog = new MemoryActivityLog()) {
    // Assigned here rather than as field initializers: Bun's per-file coverage counts
    // initializers as an uncalled function.
    this.#sessions = new Map()
    this.#tokens = new Map()
    this.#activityLog = activityLog
  }

  /** @inheritdoc */
  async create(session: NewSession, token: NewRefreshToken, activity?: Activity): Promise<void> {
    this.#sessions.set(session.id, { ...session, revokedAt: null, revokeReason: null })
    this.#tokens.set(token.id, { ...token, replacedById: null, usedAt: null })
    this.#activityLog.record(activity ? [activity] : [])
  }

  /** @inheritdoc */
  async findById(environmentId: string, id: string): Promise<SessionRecord | null> {
    const session = this.#session(environmentId, id)
    return session ? { ...session } : null
  }

  /** @inheritdoc */
  async findToken(
    environmentId: string,
    tokenHash: string
  ): Promise<{ token: RefreshTokenRecord; session: SessionRecord } | null> {
    for (const token of this.#tokens.values()) {
      const session = this.#session(environmentId, token.sessionId)
      if (token.tokenHash === tokenHash && session) {
        return { token: { ...token }, session: { ...session } }
      }
    }
    return null
  }

  /** @inheritdoc */
  async findTokenById(environmentId: string, id: string): Promise<RefreshTokenRecord | null> {
    const token = this.#tokens.get(id)
    return token && this.#session(environmentId, token.sessionId) ? { ...token } : null
  }

  /** @inheritdoc */
  async rotate(environmentId: string, rotation: Rotation): Promise<boolean> {
    const parent = this.#tokens.get(rotation.parentId)
    const session = parent && this.#session(environmentId, parent.sessionId)
    if (!parent || !session || parent.usedAt !== null || session.revokedAt !== null) {
      return false
    }
    parent.usedAt = rotation.at
    parent.replacedById = rotation.child.id
    this.#tokens.set(rotation.child.id, { ...rotation.child, replacedById: null, usedAt: null })
    session.lastActiveAt = rotation.at
    session.idleExpiresAt = rotation.idleExpiresAt
    return true
  }

  /** @inheritdoc */
  async listActiveByUser(
    environmentId: string,
    userId: string,
    now: Date
  ): Promise<SessionRecord[]> {
    return [...this.#sessions.values()]
      .filter(
        (session) =>
          session.environmentId === environmentId &&
          session.userId === userId &&
          isActive(session, now)
      )
      .sort(
        (x, y) =>
          y.lastActiveAt.getTime() - x.lastActiveAt.getTime() ||
          (y.id > x.id ? 1 : y.id < x.id ? -1 : 0)
      )
      .map((session) => ({ ...session }))
  }

  /** @inheritdoc */
  async listDevicesBefore(
    environmentId: string,
    userId: string,
    session: Pick<SessionRecord, 'id' | 'createdAt'>,
    limit: number
  ): Promise<SessionDevice[]> {
    const devices = new Map<string, SessionDevice>()
    const earlier = [...this.#sessions.values()]
      .filter(
        (candidate) =>
          candidate.environmentId === environmentId &&
          candidate.userId === userId &&
          beganBefore(candidate, session)
      )
      .sort((x, y) => (beganBefore(x, y) ? 1 : -1))
    for (const { client, userAgent } of earlier) {
      const key = JSON.stringify([client, userAgent])
      if (!devices.has(key)) {
        devices.set(key, { client, userAgent })
      }
    }
    return [...devices.values()].slice(0, limit)
  }

  /** @inheritdoc */
  async revoke(
    environmentId: string,
    id: string,
    reason: SessionRevokeReason,
    at: Date,
    activity?: Activity
  ): Promise<boolean> {
    const session = this.#session(environmentId, id)
    if (!session || session.revokedAt !== null) {
      return false
    }
    session.revokedAt = at
    session.revokeReason = reason
    this.#activityLog.record(activity ? [activity] : [])
    return true
  }

  /** @inheritdoc */
  async revokeByUser(
    environmentId: string,
    userId: string,
    reason: SessionRevokeReason,
    at: Date,
    options: RevokeByUserOptions = {}
  ): Promise<string[]> {
    const { exceptSessionId, activity } = options
    const revoked: string[] = []
    for (const session of this.#sessions.values()) {
      if (
        session.environmentId === environmentId &&
        session.userId === userId &&
        session.revokedAt === null &&
        session.id !== exceptSessionId
      ) {
        session.revokedAt = at
        session.revokeReason = reason
        revoked.push(session.id)
      }
    }
    this.#activityLog.record(activity ? revoked.map(activity) : [])
    return revoked
  }

  /** @inheritdoc */
  async deleteEnded(environmentId: string, before: Date, limit: number): Promise<number> {
    const ended = [...this.#sessions.values()]
      .filter((session) => session.environmentId === environmentId && endedBy(session, before))
      .slice(0, limit)
    for (const session of ended) {
      this.#sessions.delete(session.id)
      // As the database cascade does: the whole chain goes with its session.
      for (const [id, token] of this.#tokens) {
        if (token.sessionId === session.id) {
          this.#tokens.delete(id)
        }
      }
    }
    return ended.length
  }

  #session(environmentId: string, id: string): SessionRecord | undefined {
    const session = this.#sessions.get(id)
    return session?.environmentId === environmentId ? session : undefined
  }
}
