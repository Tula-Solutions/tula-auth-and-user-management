import type { SessionClient } from '@tula/contract'
import type { Activity } from '~/ports/activity-log'

/** Why a session ended early. */
export type SessionRevokeReason =
  | 'sign_out'
  | 'revoked_by_user'
  | 'revoked_by_admin'
  | 'password_changed'
  | 'reuse_detected'
  | 'user_banned'

/** A signed-in device. A session is also the refresh-token family. */
export interface SessionRecord {
  id: string
  projectId: string
  environmentId: string
  userId: string
  /** Session profile name, e.g. `web`. */
  profile: string
  client: SessionClient
  userAgent: string | null
  ipAddress: string | null
  lastActiveAt: Date
  /** When the session ends if not refreshed (never later than `absoluteExpiresAt`). */
  idleExpiresAt: Date
  absoluteExpiresAt: Date | null
  revokedAt: Date | null
  revokeReason: SessionRevokeReason | null
  createdAt: Date
}

/** One refresh token in a session's chain. Only its SHA-256 is stored. */
export interface RefreshTokenRecord {
  id: string
  sessionId: string
  tokenHash: string
  parentId: string | null
  /** The child issued when this token was rotated. */
  replacedById: string | null
  usedAt: Date | null
  expiresAt: Date
  createdAt: Date
}

/** A session to store. */
export type NewSession = Omit<SessionRecord, 'revokedAt' | 'revokeReason'>

/** A refresh token to store. */
export type NewRefreshToken = Omit<RefreshTokenRecord, 'replacedById' | 'usedAt'>

/** One rotation: mark `parentId` used and replaced by `child`, and extend the session. */
export interface Rotation {
  parentId: string
  child: NewRefreshToken
  /** Rotation time: the parent's `usedAt` and the session's `lastActiveAt`. */
  at: Date
  /** The session's new idle expiry. */
  idleExpiresAt: Date
}

/**
 * Whether a session can still be used at `now`.
 *
 * Shared by every adapter and the service so they agree on expiry boundaries.
 *
 * @param session - Revocation and expiry fields.
 * @param now - The current time.
 * @returns `false` once it is revoked or has reached its idle or absolute expiry.
 */
export function isActive(
  session: Pick<SessionRecord, 'revokedAt' | 'idleExpiresAt' | 'absoluteExpiresAt'>,
  now: Date
): boolean {
  const time = now.getTime()
  return (
    session.revokedAt === null &&
    session.idleExpiresAt.getTime() > time &&
    (session.absoluteExpiresAt === null || session.absoluteExpiresAt.getTime() > time)
  )
}

/** Options of {@link SessionStore.revokeByUser}. */
export interface RevokeByUserOptions {
  /** A session to leave signed in. */
  exceptSessionId?: string
  /** Builds the activity for each revoked session; recorded in the same transaction. */
  activity?: (sessionId: string) => Activity
}

/** Sessions and their refresh tokens, always read and written inside one environment. */
export interface SessionStore {
  /**
   * Store a new session and its first refresh token atomically.
   *
   * @param session - The session.
   * @param token - Its root refresh token (`parentId: null`).
   * @param activity - Recorded in the same transaction.
   */
  create(session: NewSession, token: NewRefreshToken, activity?: Activity): Promise<void>

  /**
   * @param environmentId - The environment to look in.
   * @param id - Session id.
   * @returns The session, or `null`.
   */
  findById(environmentId: string, id: string): Promise<SessionRecord | null>

  /**
   * @param environmentId - The environment to look in.
   * @param tokenHash - SHA-256 of the presented refresh token.
   * @returns The token and its session, or `null`.
   */
  findToken(
    environmentId: string,
    tokenHash: string
  ): Promise<{ token: RefreshTokenRecord; session: SessionRecord } | null>

  /**
   * @param environmentId - The environment to look in.
   * @param id - Refresh token id.
   * @returns The token, or `null`.
   */
  findTokenById(environmentId: string, id: string): Promise<RefreshTokenRecord | null>

  /**
   * Rotate a refresh token in one transaction: insert the child, mark the parent used, and
   * extend the session. Guarded so it only happens if the parent is still unused and the
   * session is not revoked; of two concurrent rotations exactly one succeeds.
   *
   * @param environmentId - The session's environment.
   * @param rotation - Parent, child and new expiry.
   * @returns `false` when the guard failed (nothing was written).
   */
  rotate(environmentId: string, rotation: Rotation): Promise<boolean>

  /**
   * @param environmentId - The environment to look in.
   * @param userId - The user.
   * @param now - Current time.
   * @returns The user's active sessions, most recently active first.
   */
  listActiveByUser(environmentId: string, userId: string, now: Date): Promise<SessionRecord[]>

  /**
   * Revoke one session. Revoking the session invalidates its whole refresh-token chain.
   *
   * @param environmentId - The session's environment.
   * @param id - Session id.
   * @param reason - Why it ended.
   * @param at - Revocation time.
   * @param activity - Recorded in the same transaction, only if the session was revoked.
   * @returns `false` when it does not exist or was already revoked.
   */
  revoke(
    environmentId: string,
    id: string,
    reason: SessionRevokeReason,
    at: Date,
    activity?: Activity
  ): Promise<boolean>

  /**
   * Revoke every unrevoked session of a user, optionally keeping one.
   *
   * @param environmentId - The user's environment.
   * @param userId - The user.
   * @param reason - Why they ended.
   * @param at - Revocation time.
   * @param options - A session to leave signed in, and the activity to record.
   * @returns The ids that were revoked.
   */
  revokeByUser(
    environmentId: string,
    userId: string,
    reason: SessionRevokeReason,
    at: Date,
    options?: RevokeByUserOptions
  ): Promise<string[]>
}
