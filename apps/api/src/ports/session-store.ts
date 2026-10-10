import { AUTHENTICATION_METHODS, type SessionClient } from '@tula/contract'
import type { Activity, Recorded } from '~/ports/activity-log'

/** Why a session ended early. */
export type SessionRevokeReason =
  | 'sign_out'
  | 'revoked_by_user'
  | 'revoked_by_admin'
  | 'password_changed'
  | 'reuse_detected'
  | 'user_banned'
  | 'mfa_changed'
  | 'session_limit'

/** How a session is held: access and refresh tokens, or one cookie checked on every request. */
export type SessionKind = 'hybrid' | 'stateful'

/** A signed-in device. A session is also the refresh-token family. */
export interface SessionRecord {
  id: string
  projectId: string
  environmentId: string
  userId: string
  /** Session profile name, e.g. `web`. */
  profile: string
  /**
   * How the session is held, fixed at creation. A `stateful` session has exactly one token row,
   * never rotated: the hash of its cookie.
   */
  type: SessionKind
  client: SessionClient
  userAgent: string | null
  ipAddress: string | null
  lastActiveAt: Date
  /** When the session ends if not refreshed (never later than `absoluteExpiresAt`). */
  idleExpiresAt: Date
  absoluteExpiresAt: Date | null
  /**
   * When the user last actively proved a factor for this session: its sign-in, or the last
   * step-up. `null` only for a session stored before this was recorded; read it through
   * {@link authenticatedAt}.
   */
  factorVerifiedAt: Date | null
  /** Every method proven for this session so far (the access token's `amr`). */
  authMethods: string[]
  /**
   * What the environment's `before_token` hook last answered for this session (ADR 0035), or
   * `null` for none. Asked when the session is created and at each authentication after it,
   * and issued from here in between: a refresh asks nobody.
   *
   * **Untrusted when read**: `unknown` values on purpose. The service checked them when it
   * wrote them and checks them again before it issues them (`CustomClaims.stored`), because a
   * row is not only what this version of the service wrote.
   */
  hookClaims: Record<string, unknown> | null
  /**
   * The key the session is bound to (ADR 0043): the RFC 7638 thumbprint of the public key its
   * client presented when the sign-in started, or `null` for a session that is not bound. A
   * refresh of a bound session needs a proof signed by that key. **Fixed at creation**: no
   * method of the store changes it, and the database refuses a statement that would.
   */
  deviceThumbprint: string | null
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

/**
 * A session to store. Without `factorVerifiedAt` and `authMethods` it has proven nothing;
 * without a `type` it is `hybrid`; without `hookClaims` it has none; without a
 * `deviceThumbprint` it is not bound to a key.
 */
export type NewSession = Omit<
  SessionRecord,
  | 'revokedAt'
  | 'revokeReason'
  | 'factorVerifiedAt'
  | 'authMethods'
  | 'type'
  | 'hookClaims'
  | 'deviceThumbprint'
> &
  Partial<
    Pick<
      SessionRecord,
      'factorVerifiedAt' | 'authMethods' | 'type' | 'hookClaims' | 'deviceThumbprint'
    >
  >

/**
 * The concurrent-session rule a new session is created under (ADR 0028).
 *
 * The caller names the sessions to end to make room (`end`); the store ends them, checks the
 * limit and inserts in **one** step that sign-ins of the same user take in turn. It never picks
 * a session to end by itself: the caller has already put those ids on the revoked-session
 * list, and a session must not be revoked in the database without being on it.
 */
export interface SessionLimit {
  /** The most sessions the user may have once the new one exists. */
  max: number
  /**
   * Sessions of the same user to end first (reason `session_limit`). Ids of another user or
   * environment, and sessions already revoked, are ignored.
   */
  end: readonly string[]
  /** The moment "live" is judged at, and the revocation time of the ended sessions. */
  at: Date
  /** Builds the activity for each ended session; recorded in the same transaction. */
  activity: (sessionId: string) => Recorded
}

/** What {@link SessionStore.create} did. */
export type SessionCreation =
  /** The session exists; `ended` are the sessions of `limit.end` that were live and ended. */
  | { created: true; ended: string[] }
  /** The user would have had more than `limit.max` live sessions: nothing was written. */
  | { created: false }

/** A factor proven again for a session: a step-up, or a factor confirmed while signed in. */
export interface Authentication {
  /** When it was proven: the session's new `factorVerifiedAt`. */
  at: Date
  /** What was proven; added to the session's `authMethods` (no duplicates, order kept). */
  methods: readonly string[]
  /**
   * The session's hook claims from now on. **Required**: an authentication always replaces
   * what was stored (the claims were answered for what the session had proven before), so
   * every caller says what with, even when that is nothing.
   */
  hookClaims: HookClaimsWrite
}

/** What an authentication stores as the session's hook claims. */
export interface HookClaimsWrite {
  /** The claims the hook answered just now; `null` for none. */
  claims: Record<string, unknown> | null
  /**
   * The methods the session had proven when the hook was asked (before this authentication's
   * are added). When given, **nothing at all is written** unless the session's methods are
   * still exactly these, as a set: another authentication got in between, and the claims
   * would be for a session that no longer is what the hook was told. Left out when no hook
   * was asked: "none" is right whatever the session has proven.
   */
  ifAuthMethods?: readonly string[]
}

/**
 * Whether two lists of methods are the same set. Shared by every adapter so they agree on
 * when {@link HookClaimsWrite.ifAuthMethods} holds.
 *
 * @param x - One list.
 * @param y - The other.
 * @returns `true` when each holds exactly the other's members, in any order.
 */
export function sameMethods(x: readonly string[], y: readonly string[]): boolean {
  const [left, right] = [new Set(x), new Set(y)]
  return left.size === right.size && [...left].every((method) => right.has(method))
}

/**
 * When the user last proved a factor for a session: the recorded time, or the session's
 * creation for one stored before it was recorded (a session is created by a sign-in).
 *
 * @param session - The session.
 * @returns The moment the access token's `auth_time` is taken from.
 */
export function authenticatedAt(
  session: Pick<SessionRecord, 'factorVerifiedAt' | 'createdAt'>
): Date {
  return session.factorVerifiedAt ?? session.createdAt
}

/**
 * A session's methods with newly proven ones added: no duplicates, in **one canonical order**
 * whatever order they were proven in: the order of `AUTHENTICATION_METHODS` in the contract
 * (`pwd`, `email`, `otp`, `backup_code`, `mfa`), then any other value alphabetically. `amr` is
 * a set; the fixed order only keeps tokens and stored rows stable. Shared by every adapter so
 * they agree.
 *
 * @param current - The session's methods so far.
 * @param added - What was just proven.
 * @returns The combined list.
 */
export function mergeAuthMethods(current: readonly string[], added: readonly string[]): string[] {
  const known: readonly string[] = AUTHENTICATION_METHODS
  const rank = (method: string) => (known.includes(method) ? known.indexOf(method) : known.length)
  return [...new Set([...current, ...added])].sort(
    (x, y) => rank(x) - rank(y) || (x < y ? -1 : x > y ? 1 : 0)
  )
}

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
  activity: (sessionId: string) => Recorded
}

/** Sessions and their refresh tokens, always read and written inside one environment. */
export interface SessionStore {
  /**
   * Store a new session and its first refresh token atomically.
   *
   * @param session - The session.
   * With a `limit`, the write is conditional and serialised per user: the sessions named in
   * `limit.end` are ended, the user's live sessions at `limit.at` are counted, and the new
   * session is stored only if that leaves fewer than `limit.max`. Otherwise nothing at all is
   * written, not even the ending of `limit.end`. Of several simultaneous calls for one user
   * at most as many succeed as there is room for.
   *
   * @param session - The session.
   * @param token - Its root refresh token (`parentId: null`).
   * @param activity - Recorded in the same transaction.
   * @param limit - The concurrent-session rule, when the environment has one.
   * @returns Whether the session was stored, and which sessions were ended for it.
   */
  create(
    session: NewSession,
    token: NewRefreshToken,
    activity: Recorded,
    limit?: SessionLimit
  ): Promise<SessionCreation>

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
    activity: Recorded
  ): Promise<boolean>

  /**
   * Record that the user proved a factor again for a session: move `factorVerifiedAt` to
   * `authentication.at`, add its methods ({@link mergeAuthMethods}) and replace the session's
   * hook claims, all in one write. Guarded: only a session that is still active at that
   * moment is changed, and, when `authentication.hookClaims.ifAuthMethods` is given, only one
   * whose methods are still those ({@link sameMethods}).
   *
   * @param environmentId - The session's environment.
   * @param id - Session id.
   * @param authentication - When, what was proven, and the hook claims from now on.
   * @param activity - Recorded in the same transaction, only if the session was changed.
   * @returns The updated session, or `null` when nothing was written: it does not exist, has
   *   ended, or has proven something else than `ifAuthMethods` says.
   */
  recordAuthentication(
    environmentId: string,
    id: string,
    authentication: Authentication,
    activity: Recorded
  ): Promise<SessionRecord | null>

  /**
   * Put on record that a refresh of a device-bound session was refused for its proof
   * (ADR 0043). **Nothing about the session changes**: it is not ended, not touched and no
   * token of it is marked. The caller decides how often this is called (at most once a minute
   * per session); the store writes what it is given.
   *
   * @param environmentId - The session's environment.
   * @param id - Session id.
   * @param activity - Recorded only if the session exists in that environment.
   */
  reportRefusedProof(environmentId: string, id: string, activity: Activity): Promise<void>

  /**
   * Record activity on a session that is checked on every request (a `stateful` one): move
   * `lastActiveAt` to `at` and its idle expiry to `idleExpiresAt`. Guarded: only a session that
   * is unrevoked and has not reached its stored idle or absolute expiry at `at` is changed, so
   * a touch can never bring an ended session back.
   *
   * @param environmentId - The session's environment.
   * @param id - Session id.
   * @param at - The moment of the activity.
   * @param idleExpiresAt - The session's new idle expiry.
   * @returns `false` when the session does not exist or has ended.
   */
  touch(environmentId: string, id: string, at: Date, idleExpiresAt: Date): Promise<boolean>

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
    options: RevokeByUserOptions
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
