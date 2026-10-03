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
import { type Actor, cleanOrigin, type Origin, systemActor } from '~/lib/actor'
import { sha256Hex } from '~/lib/crypto'
import * as logger from '~/lib/logger'
import * as Audit from '~/modules/audit/service'
import * as Jwks from '~/modules/jwks/service'
import {
  authenticatedAt,
  isActive,
  mergeAuthMethods,
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

type Scope = Pick<Tenant, 'projectId' | 'environmentId'>
type TokenDeps = Pick<
  Deps,
  'clock' | 'ids' | 'config' | 'signingKeys' | 'environments' | 'secretBox'
>
type SessionDeps = TokenDeps & Pick<Deps, 'sessions' | 'revokedSessions' | 'keyedHash' | 'users'>

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

type SigningKey = Awaited<ReturnType<typeof Jwks.activeSigningKey>>

/**
 * Sign an access token with a key the caller has already loaded.
 *
 * The key is loaded **before** a session is stored or a refresh token rotated: loading it reads
 * the key store and decrypts with the master key, and if that failed after the write, the client
 * would be left without the token the database says it has (and its retry would look like reuse).
 */
async function signAccessToken(
  deps: Pick<Deps, 'config'>,
  scope: Scope,
  session: Pick<SessionRecord, 'id' | 'userId' | 'factorVerifiedAt' | 'authMethods' | 'createdAt'>,
  now: Date,
  { kid, privateKey }: SigningKey
): Promise<{ accessToken: string; accessTokenExpiresAt: string }> {
  const issuedAt = Math.floor(now.getTime() / 1000)
  const expiresAt = issuedAt + durationToMs(profile().accessTokenTtl) / 1000
  const accessToken = await new SignJWT({
    sid: session.id,
    pid: scope.projectId,
    eid: scope.environmentId,
    v: ACCESS_TOKEN_VERSION,
    // From the session row, never from "now": a refresh must not make an old sign-in look
    // recent (ADR 0025).
    auth_time: Math.floor(authenticatedAt(session).getTime() / 1000),
    amr: session.authMethods,
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

/**
 * The record of one session ending: who ended it, and why. A replayed refresh token gets its
 * own type, `session.reuse_detected`, so it can be alerted on; every other ending is
 * `session.revoked`.
 */
function revoked(
  deps: Pick<Deps, 'ids' | 'clock'>,
  scope: Scope,
  session: { id: string; userId: string },
  reason: SessionRevokeReason,
  actor: Actor
) {
  return Audit.entry(deps, scope, {
    type: reason === 'reuse_detected' ? 'session.reuse_detected' : 'session.revoked',
    actor,
    target: { type: 'session', id: session.id },
    data: { userId: session.userId, reason },
  })
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
  /**
   * What the user proved to get this session (the access token's `amr`), e.g. `['pwd']` or
   * `['pwd', 'otp', 'mfa']`. Defaults to none.
   */
  authMethods?: readonly string[]
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
  const origin = cleanOrigin(input)
  const signingKey = await Jwks.activeSigningKey(deps, scope.environmentId)
  const authMethods = mergeAuthMethods([], input.authMethods ?? [])

  await deps.sessions.create(
    {
      id: sessionId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      userId: input.userId,
      profile: PROFILE_NAME,
      client: input.client,
      ...origin,
      lastActiveAt: now,
      idleExpiresAt,
      absoluteExpiresAt,
      // A session begins with a sign-in: that is its first proof.
      factorVerifiedAt: now,
      authMethods,
      createdAt: now,
    },
    {
      id: deps.ids.next(),
      sessionId,
      tokenHash: sha256Hex(refreshToken),
      parentId: null,
      expiresAt: idleExpiresAt,
      createdAt: now,
    },
    Audit.entry(deps, scope, {
      type: 'session.created',
      actor: { type: 'user', id: input.userId, ...origin },
      target: { type: 'session', id: sessionId },
      data: { userId: input.userId, client: input.client },
    })
  )
  const access = await signAccessToken(
    deps,
    scope,
    { id: sessionId, userId: input.userId, factorVerifiedAt: now, authMethods, createdAt: now },
    now,
    signingKey
  )
  return { sessionId, ...access, refreshToken }
}

/**
 * Record that a signed-in user proved a factor again for their session, and issue an access
 * token that says so.
 *
 * The session's `factorVerifiedAt` moves to now and `methods` are added to what it has proven;
 * the returned access token carries them as `auth_time` and `amr`. The refresh token is
 * untouched: a step-up is not a rotation. This function **does not check any proof**: the
 * caller (`Mfa.stepUp`, or the confirmation of a new factor) has done that.
 *
 * @param deps - Session store, signing keys, clock and ids.
 * @param scope - The project and environment.
 * @param self - The signed-in user and their session, from the access token.
 * @param methods - What was just proven, e.g. `['otp', 'mfa']`.
 * @param actor - The user, for the audit log.
 * @returns The session id and a fresh access token. No refresh token.
 * @throws AuthError `session.revoked` when the session has ended or is not this user's.
 */
export async function recordAuthentication(
  deps: TokenDeps & Pick<Deps, 'sessions'>,
  scope: Scope,
  self: { userId: string; sessionId: string },
  methods: readonly string[],
  actor: Actor
): Promise<SessionTokens> {
  const now = deps.clock.now()
  const signingKey = await Jwks.activeSigningKey(deps, scope.environmentId)
  const current = await deps.sessions.findById(scope.environmentId, self.sessionId)
  const session =
    current && current.userId === self.userId
      ? await deps.sessions.recordAuthentication(
          scope.environmentId,
          self.sessionId,
          { at: now, methods },
          Audit.entry(deps, scope, {
            type: 'session.stepped_up',
            actor,
            target: { type: 'session', id: self.sessionId },
            data: { userId: self.userId, methods: [...methods] },
          })
        )
      : null
  if (!session) {
    throw new AuthError('session.revoked')
  }
  const access = await signAccessToken(deps, scope, session, now, signingKey)
  return { sessionId: session.id, ...access }
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
 * End the session of a user who has been banned since it was issued.
 *
 * Banning already revokes a user's sessions; this also catches a session created in the instant
 * between the ban and that revocation, so a banned user can never keep one alive.
 */
async function rejectBanned(
  deps: Pick<Deps, 'users' | 'sessions' | 'revokedSessions' | 'ids' | 'clock'>,
  scope: Scope,
  session: SessionRecord,
  now: Date,
  origin: Partial<Origin>
): Promise<void> {
  const user = await deps.users.findById(scope.environmentId, session.userId)
  if (user?.bannedAt) {
    await denylist(deps, [session.id], now)
    await deps.sessions.revoke(
      scope.environmentId,
      session.id,
      'user_banned',
      now,
      revoked(deps, scope, session, 'user_banned', systemActor(origin))
    )
    throw new AuthError('auth.user_banned')
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
 * @param origin - Where the request came from, recorded if the session has to be revoked.
 * @returns The session id, a new access token and the current refresh token.
 * @throws AuthError `session.invalid_token`, `session.revoked`, `session.expired`,
 *   `session.reuse_detected` or `auth.user_banned`.
 */
export async function refresh(
  deps: SessionDeps,
  scope: Scope,
  refreshToken: string,
  origin: Partial<Origin> = {}
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
    await rejectBanned(deps, scope, session, now, origin)

    // Reuse is judged before the token's own expiry: a rotated token replayed on a live session
    // is theft however old it is, and must not be waved through as merely "expired".
    if (token.usedAt !== null) {
      return replayOrRevoke(deps, scope, session, token, token.usedAt, now, origin)
    }
    if (token.expiresAt.getTime() <= now.getTime()) {
      throw new AuthError('session.expired')
    }

    const idleExpiresAt = idleExpiry(now, session.absoluteExpiresAt)
    const child = await deriveToken(deps, { parentId: token.id })
    const signingKey = await Jwks.activeSigningKey(deps, scope.environmentId)
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
      const access = await signAccessToken(deps, scope, session, now, signingKey)
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
  now: Date,
  origin: Partial<Origin>
): Promise<SessionTokens> {
  const withinGrace =
    now.getTime() - usedAt.getTime() < durationToMs(profile().refresh.reuseGracePeriod)
  const child =
    withinGrace && token.replacedById
      ? await deps.sessions.findTokenById(scope.environmentId, token.replacedById)
      : null
  if (child && child.usedAt === null) {
    const signingKey = await Jwks.activeSigningKey(deps, scope.environmentId)
    const access = await signAccessToken(deps, scope, session, now, signingKey)
    return {
      sessionId: session.id,
      ...access,
      refreshToken: await deriveToken(deps, { parentId: token.id }),
    }
  }
  await denylist(deps, [session.id], now)
  // The actor is the system: whoever replayed the token is unknown, and it was the server that
  // decided to end the session. The replay's origin is kept, as it may be the thief's.
  await deps.sessions.revoke(
    scope.environmentId,
    session.id,
    'reuse_detected',
    now,
    revoked(deps, scope, session, 'reuse_detected', systemActor(origin))
  )
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

type RevokeDeps = Pick<Deps, 'sessions' | 'revokedSessions' | 'clock' | 'ids'>

/** Which session to revoke, and for whom. */
export interface RevokeInput {
  /** The user asking; the session must be theirs. */
  userId: string
  sessionId: string
  /** Defaults to `revoked_by_user`. */
  reason?: SessionRevokeReason
  /** Who is ending the session, for the audit log. */
  actor: Actor
}

/**
 * End one of a user's sessions. Idempotent: revoking an already-revoked session is a no-op.
 *
 * @param deps - Session store, denylist, ids and clock.
 * @param scope - The project and environment.
 * @param input - The user, the session, the reason and who is asking.
 * @throws NotFoundError when the session does not exist or belongs to someone else (the two are
 *   indistinguishable, so session ids can't be probed).
 */
export async function revoke(deps: RevokeDeps, scope: Scope, input: RevokeInput): Promise<void> {
  const session = await deps.sessions.findById(scope.environmentId, input.sessionId)
  if (!session || session.userId !== input.userId) {
    throw new NotFoundError()
  }
  const now = deps.clock.now()
  const reason = input.reason ?? 'revoked_by_user'
  await denylist(deps, [session.id], now)
  await deps.sessions.revoke(
    scope.environmentId,
    session.id,
    reason,
    now,
    revoked(deps, scope, session, reason, input.actor)
  )
}

/**
 * Sign the user out everywhere except the device they are using.
 *
 * @param deps - Session store, denylist, ids and clock.
 * @param scope - The project and environment.
 * @param input - The user, the session to keep, the reason (default `revoked_by_user`) and
 *   who is asking.
 * @returns How many sessions were revoked.
 */
export async function revokeOthers(
  deps: RevokeDeps,
  scope: Scope,
  input: { userId: string; currentSessionId: string; reason?: SessionRevokeReason; actor: Actor }
): Promise<number> {
  return revokeForUser(
    deps,
    scope,
    input.userId,
    input.reason ?? 'revoked_by_user',
    input.actor,
    input.currentSessionId
  )
}

async function revokeForUser(
  deps: RevokeDeps,
  scope: Scope,
  userId: string,
  reason: SessionRevokeReason,
  actor: Actor,
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
  const ended = await deps.sessions.revokeByUser(scope.environmentId, userId, reason, now, {
    exceptSessionId,
    activity: (sessionId) => revoked(deps, scope, { id: sessionId, userId }, reason, actor),
  })
  // Covers a session created between the list and the update.
  await denylist(deps, ended, now)
  return ended.length
}

/**
 * End every session of a user, e.g. after a password change, reset or ban.
 *
 * @param deps - Session store, denylist, ids and clock.
 * @param scope - The project and environment.
 * @param userId - The user.
 * @param reason - Why the sessions end.
 * @param actor - Who is ending them, for the audit log.
 * @returns How many sessions were revoked.
 */
export async function revokeAllForUser(
  deps: RevokeDeps,
  scope: Scope,
  userId: string,
  reason: SessionRevokeReason,
  actor: Actor
): Promise<number> {
  return revokeForUser(deps, scope, userId, reason, actor)
}

/**
 * Sign out the session a refresh token belongs to.
 *
 * Never fails: a missing, unknown or foreign token is a no-op, so sign-out always succeeds from
 * the client's point of view and reveals nothing about which tokens exist. Any token of the
 * chain works, including an already-rotated one.
 *
 * @param deps - Session store, denylist, ids and clock.
 * @param scope - The project and environment.
 * @param refreshToken - The presented token, if any.
 * @param origin - Where the request came from, for the audit log.
 */
export async function signOut(
  deps: RevokeDeps,
  scope: Scope,
  refreshToken: string | undefined,
  origin: Partial<Origin> = {}
): Promise<void> {
  if (!refreshToken) {
    return
  }
  const found = await deps.sessions.findToken(scope.environmentId, sha256Hex(refreshToken))
  if (!found) {
    return
  }
  const now = deps.clock.now()
  const { session } = found
  await denylist(deps, [session.id], now)
  await deps.sessions.revoke(
    scope.environmentId,
    session.id,
    'sign_out',
    now,
    // Holding the refresh token is what proves this is the session's user.
    revoked(deps, scope, session, 'sign_out', {
      type: 'user',
      id: session.userId,
      ...cleanOrigin(origin),
    })
  )
}
