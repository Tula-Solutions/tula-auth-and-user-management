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

/**
 * Whether a session had already ended at `at`: revoked by then, or past its idle or absolute
 * expiry. The opposite of {@link isActive} for an unrevoked session; for a revoked one it asks
 * when the revocation happened, which `isActive` does not.
 *
 * Shared by every adapter so they agree on which sessions retention may delete.
 *
 * @param session - Revocation and expiry fields.
 * @param at - The moment to judge by.
 * @returns `true` when the session could not be used at `at` or any time after.
 */
export function endedBy(
  session: Pick<SessionRecord, 'revokedAt' | 'idleExpiresAt' | 'absoluteExpiresAt'>,
  at: Date
): boolean {
  const time = at.getTime()
  return (
    (session.revokedAt !== null && session.revokedAt.getTime() <= time) ||
    session.idleExpiresAt.getTime() <= time ||
    (session.absoluteExpiresAt !== null && session.absoluteExpiresAt.getTime() <= time)
  )
}

/** What a session was created from: the client kind and the user agent it sent. */
export type SessionDevice = Pick<SessionRecord, 'client' | 'userAgent'>

/**
 * Whether session `x` began before session `y`: by creation time, then by id, so that of two
 * sessions created in the same instant exactly one is the earlier.
 *
 * Shared by every adapter so they agree on which sessions {@link SessionStore.listDevicesBefore}
 * looks at.
 *
 * @param x - A session.
 * @param y - Another session.
 * @returns `true` when `x` comes first.
 */
export function beganBefore(
  x: Pick<SessionRecord, 'id' | 'createdAt'>,
  y: Pick<SessionRecord, 'id' | 'createdAt'>
): boolean {
  const [xAt, yAt] = [x.createdAt.getTime(), y.createdAt.getTime()]
  return xAt < yAt || (xAt === yAt && x.id < y.id)
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
   * The devices a user's earlier sessions were created from: every session of the user still in
   * the table, **active or ended**, that began before `session` (see {@link beganBefore}).
   * Used to tell whether a sign-in comes from a device the account has been seen on (ADR 0023).
   *
   * Each distinct pair of client kind and user agent is returned once. When there are more than
   * `limit`, the ones used by the most recent sessions are kept.
   *
   * @param environmentId - The user's environment.
   * @param userId - The user.
   * @param session - The session to look back from; it is never part of the result.
   * @param limit - The most devices to return.
   * @returns The devices, the most recently used first. Empty when the user has no earlier
   *   session.
   */
  listDevicesBefore(
    environmentId: string,
    userId: string,
    session: Pick<SessionRecord, 'id' | 'createdAt'>,
    limit: number
  ): Promise<SessionDevice[]>

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

  /**
   * Remove sessions in an environment that had ended by `before` (see {@link endedBy}), each
   * with its whole refresh-token chain. A session that can still be refreshed is never touched.
   * Nothing is recorded: the session's end is already in the audit log, and the audit entries
   * stay. At most `limit` sessions go per call, so no call holds locks for long; the caller
   * repeats while a full batch comes back.
   *
   * @param environmentId - The environment to purge.
   * @param before - Sessions revoked or expired at or before this moment go.
   * @param limit - The most sessions to remove in this call.
   * @returns How many sessions were removed.
   */
  deleteEnded(environmentId: string, before: Date, limit: number): Promise<number>
}
