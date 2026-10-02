import { isIP } from 'node:net'
import {
  ACCESS_TOKEN_ALGORITHM,
  ACCESS_TOKEN_VERSION,
  DEFAULT_WEB_SESSION_PROFILE,
  durationToMs,
  environmentIssuer,
  REFRESH_TOKEN_PREFIX,
  type Session,
  type SessionClient,
  type SessionProfile,
  type SessionTokens,
} from '@tula/contract'
import { SignJWT } from 'jose'
import type { Deps, Tenant } from '~/dependencies'
import { AuthError, InternalError, NotFoundError } from '~/exceptions'
import { sha256Hex } from '~/lib/crypto'
import * as logger from '~/lib/logger'
import * as Jwks from '~/modules/jwks/service'
import {
  isActive,
  type RefreshTokenRecord,
  type SessionRecord,
  type SessionRevokeReason,
} from '~/ports/session-store'

/** Keyed-hash purpose for deriving refresh tokens. */
export const KEYED_HASH_PURPOSE = 'refresh-tokens'
/** Name stored on sessions issued with {@link profile}. */
export const PROFILE_NAME = 'web'
/**
 * Refreshes per minute from one IP. A client refreshes about once a minute per tab; this leaves
 * room for offices behind one address while bounding unauthenticated database lookups.
 */
export const REFRESH_RATE_LIMIT = 300
/** Longest user agent stored with a session; longer values are cut, not rejected. */
export const MAX_USER_AGENT_LENGTH = 512

type Scope = Pick<Tenant, 'projectId' | 'environmentId'>
type TokenDeps = Pick<
  Deps,
  'clock' | 'ids' | 'config' | 'signingKeys' | 'environments' | 'secretBox'
>
type SessionDeps = TokenDeps & Pick<Deps, 'sessions' | 'revokedSessions' | 'keyedHash'>

/**
 * The session profile in force.
 *
 * Phase 0 issues one profile (hybrid: 60s access tokens, rotating refresh tokens, 7 days idle,
 * 30 days absolute). Named per-project profiles arrive with the dashboard.
 *
 * @returns The profile.
 */
export function profile(): SessionProfile {
  return DEFAULT_WEB_SESSION_PROFILE
}

/**
 * The refresh token for a row, derived rather than stored: `HMAC(key, parent id)`, or
 * `HMAC(key, session id)` for a session's first token. Because it can be recomputed from the
 * parent, a retry inside the reuse grace window gets the same child back without the database
 * ever holding recoverable token material.
 */
async function deriveToken(
  deps: Pick<Deps, 'keyedHash'>,
  source: { parentId: string } | { sessionId: string }
): Promise<string> {
  const message = 'parentId' in source ? `parent:${source.parentId}` : `session:${source.sessionId}`
  return `${REFRESH_TOKEN_PREFIX}${await deps.keyedHash.hmac(KEYED_HASH_PURPOSE, message)}`
}

async function signAccessToken(
  deps: TokenDeps,
  scope: Scope,
  session: { id: string; userId: string },
  now: Date
): Promise<{ accessToken: string; accessTokenExpiresAt: string }> {
  const { kid, privateKey } = await Jwks.activeSigningKey(deps, scope.environmentId)
  const issuedAt = Math.floor(now.getTime() / 1000)
  const expiresAt = issuedAt + durationToMs(profile().accessTokenTtl) / 1000
  const accessToken = await new SignJWT({
    sid: session.id,
    pid: scope.projectId,
    eid: scope.environmentId,
    v: ACCESS_TOKEN_VERSION,
  })
    .setProtectedHeader({ alg: ACCESS_TOKEN_ALGORITHM, kid, typ: 'JWT' })
    .setIssuer(environmentIssuer(deps.config.publicUrl, scope.environmentId))
    .setSubject(session.userId)
    .setAudience(scope.environmentId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(privateKey)
  return { accessToken, accessTokenExpiresAt: new Date(expiresAt * 1000).toISOString() }
}

/** `now + idle timeout`, never past the session's absolute limit. */
function idleExpiry(now: Date, absoluteExpiresAt: Date | null): Date {
  const idle = now.getTime() + durationToMs(profile().idleTimeout)
  return new Date(absoluteExpiresAt ? Math.min(idle, absoluteExpiresAt.getTime()) : idle)
}

/**
 * Keep a revoked session's still-unexpired access tokens from being accepted.
 *
 * Every revocation calls this **before** the store update, and whether or not the session was
 * already revoked. If the two steps were the other way round, a failure between them would
 * leave a revoked session whose access token still works, and a retry (which finds nothing left
 * to revoke) would never repair it. Adding an entry twice is harmless.
 */
async function denylist(
  deps: Pick<Deps, 'revokedSessions'>,
  sessionIds: readonly string[],
  now: Date
): Promise<void> {
  const until = new Date(now.getTime() + durationToMs(profile().accessTokenTtl))
  await Promise.all(sessionIds.map((id) => deps.revokedSessions.add(id, until)))
}

/** Who is signing in, and from what. */
export interface CreateInput {
  userId: string
  client: SessionClient
  userAgent?: string | null
  /** Client IP; anything that is not a valid address is stored as `null`. */
  ipAddress?: string | null
}

/**
 * Start a session for a user who has just proven who they are, and issue its first tokens.
 *
 * The refresh token is always returned; the router decides whether a client receives it in the
 * body (native) or as an httpOnly cookie (browser).
 *
 * @param deps - Session store, keyed hash, signing keys, clock and ids.
 * @param scope - The project and environment.
 * @param input - The user and device.
 * @returns The session id, access token and refresh token.
 */
export async function create(
  deps: SessionDeps,
  scope: Scope,
  input: CreateInput
): Promise<SessionTokens> {
  const now = deps.clock.now()
  const absoluteTimeout = profile().absoluteTimeout
  const absoluteExpiresAt = absoluteTimeout
    ? new Date(now.getTime() + durationToMs(absoluteTimeout))
    : null
  const idleExpiresAt = idleExpiry(now, absoluteExpiresAt)
  const sessionId = deps.ids.next()
  const refreshToken = await deriveToken(deps, { sessionId })

  await deps.sessions.create(
    {
      id: sessionId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      userId: input.userId,
      profile: PROFILE_NAME,
      client: input.client,
      userAgent: input.userAgent?.slice(0, MAX_USER_AGENT_LENGTH) ?? null,
      ipAddress: input.ipAddress && isIP(input.ipAddress) ? input.ipAddress : null,
      lastActiveAt: now,
      idleExpiresAt,
      absoluteExpiresAt,
      createdAt: now,
    },
    {
      id: deps.ids.next(),
      sessionId,
      tokenHash: sha256Hex(refreshToken),
      parentId: null,
      expiresAt: idleExpiresAt,
      createdAt: now,
    }
  )
  const access = await signAccessToken(deps, scope, { id: sessionId, userId: input.userId }, now)
  return { sessionId, ...access, refreshToken }
}

/**
 * Refuse a session that has ended, with the error the client should see.
 *
 * A session revoked for reuse keeps answering `session.reuse_detected`, so the legitimate
 * holder of the newest token learns why they were signed out.
 */
function rejectEnded(session: SessionRecord, now: Date): void {
  if (session.revokedAt !== null) {
    throw new AuthError(
      session.revokeReason === 'reuse_detected' ? 'session.reuse_detected' : 'session.revoked'
    )
  }
  if (!isActive(session, now)) {
    throw new AuthError('session.expired')
  }
}

/**
 * Exchange a refresh token for a new access token and the next refresh token.
 *
 * Refresh tokens are single-use. Presenting one that was already rotated revokes the whole
 * session (`session.reuse_detected`): either the token was stolen or the client is broken, and
 * we cannot tell which. The **only** exception is the profile's `reuseGracePeriod`: inside it,
 * and only while the child has not itself been rotated, the caller gets the *same* child token
 * again (re-derived, never newly minted) with a fresh access token. That makes racing tabs and
 * retried requests idempotent.
 *
 * Rotation is one guarded transaction, so of several concurrent refreshes exactly one rotates
 * and the others take the grace path.
 *
 * @param deps - Session store, keyed hash, signing keys, clock and ids.
 * @param scope - The environment the request resolved to.
 * @param refreshToken - The token the client presented.
 * @returns The session id, a new access token and the current refresh token.
 * @throws AuthError `session.invalid_token`, `session.revoked`, `session.expired` or
 *   `session.reuse_detected`.
 */
export async function refresh(
  deps: SessionDeps,
  scope: Scope,
  refreshToken: string
): Promise<SessionTokens> {
  const tokenHash = sha256Hex(refreshToken)
  // A second pass only happens when a concurrent request won the rotation between our read and
  // our write; the re-read then sees the token as used and takes the grace path.
  for (let pass = 0; pass < 2; pass++) {
    const now = deps.clock.now()
    const found = await deps.sessions.findToken(scope.environmentId, tokenHash)
    if (!found) {
      throw new AuthError('session.invalid_token')
    }
    const { token, session } = found
    rejectEnded(session, now)

    // Reuse is judged before the token's own expiry: a rotated token replayed on a live session
    // is theft however old it is, and must not be waved through as merely "expired".
    if (token.usedAt !== null) {
      return replayOrRevoke(deps, scope, session, token, token.usedAt, now)
    }
    if (token.expiresAt.getTime() <= now.getTime()) {
      throw new AuthError('session.expired')
    }

    const idleExpiresAt = idleExpiry(now, session.absoluteExpiresAt)
    const child = await deriveToken(deps, { parentId: token.id })
    const rotated = await deps.sessions.rotate(scope.environmentId, {
      parentId: token.id,
      child: {
        id: deps.ids.next(),
        sessionId: session.id,
        tokenHash: sha256Hex(child),
        parentId: token.id,
        expiresAt: idleExpiresAt,
        createdAt: now,
      },
      at: now,
      idleExpiresAt,
    })
    if (rotated) {
      const access = await signAccessToken(deps, scope, session, now)
      return { sessionId: session.id, ...access, refreshToken: child }
    }
  }
  throw new InternalError({ internalMessage: 'refresh rotation lost the race twice' })
}

async function replayOrRevoke(
  deps: SessionDeps,
  scope: Scope,
  session: SessionRecord,
  token: RefreshTokenRecord,
  usedAt: Date,
  now: Date
): Promise<SessionTokens> {
  const withinGrace =
    now.getTime() - usedAt.getTime() < durationToMs(profile().refresh.reuseGracePeriod)
  const child =
    withinGrace && token.replacedById
      ? await deps.sessions.findTokenById(scope.environmentId, token.replacedById)
      : null
  if (child && child.usedAt === null) {
    const access = await signAccessToken(deps, scope, session, now)
    return {
      sessionId: session.id,
      ...access,
      refreshToken: await deriveToken(deps, { parentId: token.id }),
    }
  }
  await denylist(deps, [session.id], now)
  await deps.sessions.revoke(scope.environmentId, session.id, 'reuse_detected', now)
  logger.warn('refresh token reuse detected; session revoked', {
    environmentId: scope.environmentId,
    sessionId: session.id,
    userId: session.userId,
  })
  throw new AuthError('session.reuse_detected')
}

function toSession(record: SessionRecord, currentSessionId: string): Session {
  return {
    id: record.id,
    client: record.client,
    userAgent: record.userAgent,
    ipAddress: record.ipAddress,
    createdAt: record.createdAt.toISOString(),
    lastActiveAt: record.lastActiveAt.toISOString(),
    expiresAt: record.idleExpiresAt.toISOString(),
    current: record.id === currentSessionId,
  }
}

/**
 * The signed-in user's active sessions (their device list).
 *
 * @param deps - Session store and clock.
 * @param scope - The environment.
 * @param input - The user and the session making the request.
 * @returns Active sessions, most recently active first. No token material.
 */
export async function list(
  deps: Pick<Deps, 'sessions' | 'clock'>,
  scope: Pick<Tenant, 'environmentId'>,
  input: { userId: string; currentSessionId: string }
): Promise<Session[]> {
  const records = await deps.sessions.listActiveByUser(
    scope.environmentId,
    input.userId,
    deps.clock.now()
  )
  return records.map((record) => toSession(record, input.currentSessionId))
}

/** Which session to revoke, and for whom. */
export interface RevokeInput {
  /** The user asking; the session must be theirs. */
  userId: string
  sessionId: string
  /** Defaults to `revoked_by_user`. */
  reason?: SessionRevokeReason
}

/**
 * End one of a user's sessions. Idempotent: revoking an already-revoked session is a no-op.
 *
 * @param deps - Session store, denylist and clock.
 * @param scope - The environment.
 * @param input - The user, the session and the reason.
 * @throws NotFoundError when the session does not exist or belongs to someone else (the two are
 *   indistinguishable, so session ids can't be probed).
 */
export async function revoke(
  deps: Pick<Deps, 'sessions' | 'revokedSessions' | 'clock'>,
  scope: Pick<Tenant, 'environmentId'>,
  input: RevokeInput
): Promise<void> {
  const session = await deps.sessions.findById(scope.environmentId, input.sessionId)
  if (!session || session.userId !== input.userId) {
    throw new NotFoundError()
  }
  const now = deps.clock.now()
  await denylist(deps, [session.id], now)
  await deps.sessions.revoke(
    scope.environmentId,
    session.id,
    input.reason ?? 'revoked_by_user',
    now
  )
}

/**
 * Sign the user out everywhere except the device they are using.
 *
 * @param deps - Session store, denylist and clock.
 * @param scope - The environment.
 * @param input - The user and the session to keep.
 * @returns How many sessions were revoked.
 */
export async function revokeOthers(
  deps: Pick<Deps, 'sessions' | 'revokedSessions' | 'clock'>,
  scope: Pick<Tenant, 'environmentId'>,
  input: { userId: string; currentSessionId: string }
): Promise<number> {
  return revokeForUser(deps, scope, input.userId, 'revoked_by_user', input.currentSessionId)
}

async function revokeForUser(
  deps: Pick<Deps, 'sessions' | 'revokedSessions' | 'clock'>,
  scope: Pick<Tenant, 'environmentId'>,
  userId: string,
  reason: SessionRevokeReason,
  exceptSessionId?: string
): Promise<number> {
  const now = deps.clock.now()
  // Only active sessions can have unexpired access tokens, so those are denylisted up front.
  const active = await deps.sessions.listActiveByUser(scope.environmentId, userId, now)
  await denylist(
    deps,
    active.map((session) => session.id).filter((id) => id !== exceptSessionId),
    now
  )
  const revoked = await deps.sessions.revokeByUser(
    scope.environmentId,
    userId,
    reason,
    now,
    exceptSessionId
  )
  // Covers a session created between the list and the update.
  await denylist(deps, revoked, now)
  return revoked.length
}

/**
 * End every session of a user, e.g. after a password change, reset or ban.
 *
 * @param deps - Session store, denylist and clock.
 * @param scope - The environment.
 * @param userId - The user.
 * @param reason - Why the sessions end.
 * @returns How many sessions were revoked.
 */
export async function revokeAllForUser(
  deps: Pick<Deps, 'sessions' | 'revokedSessions' | 'clock'>,
  scope: Pick<Tenant, 'environmentId'>,
  userId: string,
  reason: SessionRevokeReason
): Promise<number> {
  return revokeForUser(deps, scope, userId, reason)
}

/**
 * Sign out the session a refresh token belongs to.
 *
 * Never fails: a missing, unknown or foreign token is a no-op, so sign-out always succeeds from
 * the client's point of view and reveals nothing about which tokens exist. Any token of the
 * chain works, including an already-rotated one.
 *
 * @param deps - Session store, denylist and clock.
 * @param scope - The environment.
 * @param refreshToken - The presented token, if any.
 */
export async function signOut(
  deps: Pick<Deps, 'sessions' | 'revokedSessions' | 'clock'>,
  scope: Pick<Tenant, 'environmentId'>,
  refreshToken: string | undefined
): Promise<void> {
  if (!refreshToken) {
    return
  }
  const found = await deps.sessions.findToken(scope.environmentId, sha256Hex(refreshToken))
  if (!found) {
    return
  }
  const now = deps.clock.now()
  await denylist(deps, [found.session.id], now)
  await deps.sessions.revoke(scope.environmentId, found.session.id, 'sign_out', now)
}
